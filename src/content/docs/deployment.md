---
title: Deployment and TLS
description: "Run Celeris in production: TLS termination, reverse proxies, health checks, containers, and tuning."
group: Operations
order: 1
---

This page is the production checklist for a Celeris service: how to put it behind
TLS, how to make it trust a reverse proxy so client IP and scheme stay correct,
how to wire Kubernetes probes, and how to run it in a container or under systemd
with the right knobs turned. Everything here is grounded in real, exported APIs —
where a behaviour depends on the underlying OS rather than a Celeris flag, that is
called out explicitly.

The single most important fact: **Celeris speaks cleartext only.** There is no
`StartTLS`, no certificate configuration, and no ALPN on the native engines.
Terminate TLS upstream and forward cleartext HTTP/1.1 or h2c to Celeris.

## TLS: terminate it upstream

Celeris exposes exactly three protocol modes (`celeris/config.go:11-21`), all of
them cleartext:

| `Config.Protocol`  | Wire protocol                                          |
| ------------------ | ----------------------------------------------------- |
| `celeris.HTTP1`    | HTTP/1.1, cleartext                                    |
| `celeris.H2C`      | HTTP/2 cleartext (h2c), no TLS                         |
| `celeris.Auto`     | Detect per connection; upgrade H1 → h2c on demand (default) |

There is **no `celeris.HTTPS`, no TLS config, and no `StartTLS` method** — inspect
`*Server` in `celeris/server.go` and you will find only `Start`,
`StartWithContext`, `StartWithListener`, and `StartWithListenerAndContext`. This is
deliberate: the hot path stays allocation-free, and a battle-tested proxy owns
certificates, OCSP stapling, ALPN, and TLS version policy.

The production topology is always the same — a TLS terminator in front, cleartext
behind:

```
            TLS (443)                     cleartext H1 / h2c
client ───────────────▶  nginx / Caddy / Envoy / cloud LB ───────────────▶ Celeris
                          (certs, ALPN, OCSP)                  :8080
```

Pick the terminator that fits your platform:

- **nginx / Caddy / HAProxy** on a VM or in a sidecar.
- **Envoy** as an ingress or service-mesh data plane.
- **A cloud load balancer** — AWS ALB/NLB, GCP HTTPS LB, Azure Application Gateway,
  Cloudflare — terminating TLS at the edge.
- **Kubernetes Ingress** (ingress-nginx, Traefik, Gateway API), which is one of the
  above under the hood.

### Forwarding h2c to Celeris

If you want end-to-end HTTP/2 (proxy ⇄ Celeris over h2c), run Celeris with
`Protocol: celeris.Auto` (the default) or `celeris.H2C` and point the proxy's
upstream at h2c:

```go
s := celeris.New(celeris.Config{
    Addr:     ":8080",
    Protocol: celeris.Auto, // accepts H1 and h2c; upgrades H1→h2c on demand
})
```

How `Auto` handles the HTTP/1.1 `Upgrade: h2c` handshake is controlled by
`Config.EnableH2Upgrade` (`celeris/config.go:221-232`), a `*bool`:

| `EnableH2Upgrade`  | Effect                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `nil` (default)    | Inferred from `Protocol`: enabled for `Auto`, disabled for `H2C` and `HTTP1` |
| `&true`            | Force the RFC 7540 §3.2 `Upgrade: h2c` handshake on (even on `H2C`) |
| `&false`           | Force it off, even on `Auto` — serve HTTP/1.1 only on that listener |

Most cloud LBs and nginx talk h2c to the upstream by negotiating up front (prior
knowledge), not via the `Upgrade` header, so the default is fine. Set
`EnableH2Upgrade` to `&false` only if a misbehaving proxy sends spurious upgrade
requests you want refused.

> Helper to take a pointer to a bool literal:
>
> ```go
> func boolPtr(b bool) *bool { return &b }
>
> s := celeris.New(celeris.Config{
>     Addr:            ":8080",
>     Protocol:        celeris.Auto,
>     EnableH2Upgrade: boolPtr(false), // refuse h2c upgrade requests
> })
> ```

### "I really need in-process HTTPS"

Celeris has no TLS stack on any engine. If you cannot put a terminator in front,
run a thin TLS terminator process on the same host (Caddy in two lines, or
`stunnel`) and forward to Celeris on `127.0.0.1`. The cleartext hop never leaves
the loopback interface.

## Trusting the proxy

Once TLS terminates upstream, the TCP peer Celeris sees is the **proxy**, not the
end user. Without configuration, `c.ClientIP()` would return the proxy's address
and `c.Scheme()` would always be `"http"` (the cleartext hop), which breaks logging,
rate limiting, audit trails, and any redirect that builds an absolute `https://`
URL. Celeris gives you two complementary tools to fix this.

### `Config.TrustedProxies` — corrects `ClientIP()`

Set `Config.TrustedProxies` to the CIDR ranges (or bare IPs) of your proxies
(`celeris/config.go:212-216`). When set, `c.ClientIP()` walks the
`X-Forwarded-For` chain **right-to-left**, skipping hops inside a trusted network,
and returns the first untrusted address — the real client
(`celeris/context_request.go:416-484`):

```go
s := celeris.New(celeris.Config{
    Addr: ":8080",
    TrustedProxies: []string{
        "10.0.0.0/8",      // internal LB subnet
        "172.16.0.0/12",
    },
})

s.GET("/whoami", func(c *celeris.Context) error {
    return c.String(200, c.ClientIP()) // the end user's IP, not the LB's
})
```

Entries accept CIDR notation (`10.0.0.0/8`) or a bare IP (`10.0.0.1`, expanded to
`/32` or `/128`). An invalid entry is a startup error from `Start` —
`celeris: invalid TrustedProxies entry: …` (`celeris/server.go:576-591`), so a typo
fails loudly rather than silently mis-attributing traffic.

> **Without `TrustedProxies`, `ClientIP()` falls back to legacy behaviour**: it
> returns the *leftmost* `X-Forwarded-For` entry, which is attacker-controlled and
> trivially spoofed. Always set `TrustedProxies` in production
> (`celeris/context_request.go:416-438`).

### The `proxy` middleware — corrects `Scheme()` and `Host()` too

`TrustedProxies` alone fixes the client IP. To also honour `X-Forwarded-Proto`
(so `c.Scheme()` returns `"https"`) and `X-Forwarded-Host`, add the
`middleware/proxy` middleware via `Server.Pre` so the overrides land *before*
routing and before any downstream middleware reads those values
(`celeris/middleware/proxy/doc.go`):

```go
import "github.com/goceleris/celeris/middleware/proxy"

s := celeris.New(celeris.Config{Addr: ":8080"})

s.Pre(proxy.New(proxy.Config{
    TrustedProxies: []string{"10.0.0.0/8", "172.16.0.0/12"},
}))

s.GET("/", func(c *celeris.Context) error {
    // c.ClientIP() → real client, c.Scheme() → "https", c.Host() → public host
    return c.String(200, c.Scheme()+"://"+c.Host())
})
```

The middleware inspects forwarded headers **only when the immediate peer is inside
`Config.TrustedProxies`** (`celeris/middleware/proxy/proxy.go:54-65`). Its
`proxy.Config` options (`celeris/middleware/proxy/config.go`):

| Field                   | Type                  | Default                          | Purpose                                                              |
| ----------------------- | --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `TrustedProxies`        | `[]string`            | empty → middleware is a **no-op** | CIDRs / bare IPs whose forwarded headers are trusted                 |
| `TrustedHeaders`        | `[]string`            | `["x-forwarded-for","x-real-ip"]` | Which client-IP headers to inspect, in order                         |
| `DisableForwardedProto` | `bool`                | `false` (i.e. proto **enabled**)  | Stop honouring `X-Forwarded-Proto` for `Scheme()`                    |
| `DisableForwardedHost`  | `bool`                | `false` (i.e. host **enabled**)   | Stop honouring `X-Forwarded-Host` for `Host()`                       |
| `SkipPaths`             | `[]string`            | none                             | Exact paths to bypass the middleware                                 |
| `Skip`                  | `func(c) bool`        | none                             | Dynamic bypass predicate                                            |

`X-Forwarded-For` is walked right-to-left and `X-Real-Ip` is validated;
`X-Forwarded-Proto` only accepts `http`/`https`; `X-Forwarded-Host` is rejected if
it contains `\r`, `\n`, `\x00`, `/`, `\`, `?`, `#`, or `@`, or exceeds 253 bytes —
all to block header injection (`celeris/middleware/proxy/proxy.go:97-117, 215-226`).

Custom single-value IP headers work too — add the provider's header to
`TrustedHeaders`:

```go
// Behind Cloudflare: trust CF-Connecting-IP, scoped to Cloudflare's ranges.
s.Pre(proxy.New(proxy.Config{
    TrustedProxies: []string{"173.245.48.0/20" /* …full Cloudflare list… */},
    TrustedHeaders: []string{"cf-connecting-ip"},
}))
```

> **Security warning — never trust too broadly.** Scope `TrustedProxies` to the
> *actual* IPs of your proxies. There is no `TrustAllProxies` switch by design
> (`celeris/middleware/proxy/doc.go`): trusting everything lets any client forge
> `X-Forwarded-For` and impersonate any IP, defeating rate limiting and audit
> logging. If you genuinely run in a fully isolated network you can pass
> `"0.0.0.0/0"` explicitly — but treat that as a conscious, documented decision,
> not a default.

### Which one do I need?

| Goal                                                   | What to configure                                  |
| ------------------------------------------------------ | -------------------------------------------------- |
| Correct `c.ClientIP()` only                            | `Config.TrustedProxies`                            |
| Correct `c.ClientIP()` **and** `c.Scheme()`/`c.Host()` | `proxy.New(...)` via `s.Pre(...)`                  |
| Provider header (CF-Connecting-IP, True-Client-IP)     | `proxy.New(...)` with `TrustedHeaders`             |

Setting both is fine and common: `Config.TrustedProxies` makes `ClientIP()` correct
even on routes the `Pre` middleware skips, while the `proxy` middleware adds scheme
and host handling on top.

## Health checks

The `middleware/healthcheck` package serves liveness, readiness, and startup probes
without writing handlers (`celeris/middleware/healthcheck/healthcheck.go`). Register
it with `Use`; it intercepts `GET`/`HEAD` on the configured paths and returns a
small pre-serialized JSON body:

```go
import "github.com/goceleris/celeris/middleware/healthcheck"

s := celeris.New(celeris.Config{Addr: ":8080"})

// Defaults: /livez, /readyz, /startupz — all 200 OK.
s.Use(healthcheck.New())
```

A healthy probe returns `200 {"status":"ok"}`; an unhealthy one returns
`503 {"status":"unavailable"}` (`celeris/middleware/healthcheck/healthcheck.go:13-16,
163-174`). For `HEAD` the body is omitted.

### Default paths and configuration

The three probes map to Kubernetes' three probe types. Defaults
(`celeris/middleware/healthcheck/config.go:11-15`):

| Probe       | Default path | `Config` field | Kubernetes probe   | Question it answers                          |
| ----------- | ------------ | -------------- | ------------------ | -------------------------------------------- |
| Liveness    | `/livez`     | `LivePath`     | `livenessProbe`    | Is the process alive? (fail → restart pod)   |
| Readiness   | `/readyz`    | `ReadyPath`    | `readinessProbe`   | Can it take traffic? (fail → remove from LB) |
| Startup     | `/startupz`  | `StartPath`    | `startupProbe`     | Has init finished? (gates the other probes)  |

Each path has a matching `Checker` — a `func(c *celeris.Context) bool`
(`celeris/middleware/healthcheck/config.go:17-19`). The defaults always return
`true`; supply your own to reflect real dependency health:

```go
s.Use(healthcheck.New(healthcheck.Config{
    // Liveness stays trivial — only "is the process running?".
    // Readiness checks the dependencies the service can't serve without.
    ReadyChecker: func(c *celeris.Context) bool {
        return db.PingContext(c.Context()) == nil
    },
    StartChecker: func(_ *celeris.Context) bool {
        return migrationsDone.Load()
    },
    CheckerTimeout: 2 * time.Second, // 503 if a checker exceeds this (default 5s)
}))
```

`CheckerTimeout` bounds each checker; on timeout the probe returns 503
(`celeris/middleware/healthcheck/config.go:54-66`). For trivial checkers that
cannot block, set `CheckerTimeout: healthcheck.FastPathTimeout` to skip the
goroutine/channel machinery entirely (`config.go:69-75`). The default checkers are
already optimised this way automatically.

`Config` knobs (`celeris/middleware/healthcheck/config.go:21-67`):

| Field            | Type             | Default       | Notes                                                       |
| ---------------- | ---------------- | ------------- | ---------------------------------------------------------- |
| `LivePath`       | `string`         | `/livez`      | Empty string **disables** the liveness probe               |
| `ReadyPath`      | `string`         | `/readyz`     | Empty string disables                                      |
| `StartPath`      | `string`         | `/startupz`   | Empty string disables                                      |
| `LiveChecker`    | `Checker`        | always `true` | Process-alive predicate                                    |
| `ReadyChecker`   | `Checker`        | always `true` | Dependency-ready predicate                                 |
| `StartChecker`   | `Checker`        | always `true` | Startup-complete predicate                                 |
| `CheckerTimeout` | `time.Duration`  | `5s`          | `0`→default, `FastPathTimeout`→inline                      |
| `SkipPaths`      | `[]string`       | none          | Exact paths to bypass                                      |
| `Skip`           | `func(c) bool`   | none          | Dynamic bypass                                            |

The constants `healthcheck.DefaultLivePath`, `DefaultReadyPath`, and
`DefaultStartPath` (`config.go:10-15`) let you reference the defaults from your
Kubernetes manifest generators without hard-coding strings.

> **Validation panics at startup**, not at request time: two probes sharing a path,
> or a path not starting with `/`, panics in `healthcheck.New`
> (`celeris/middleware/healthcheck/config.go:111-137`). Catch it in CI, not in prod.

### Wiring to Kubernetes

```yaml
# Probe ports/paths must match how your container exposes Celeris (:8080 here).
startupProbe:    # gates the others until init completes
  httpGet: { path: /startupz, port: 8080 }
  failureThreshold: 30
  periodSeconds: 2
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 10
readinessProbe:  # pulled from the Service endpoints when it fails
  httpGet: { path: /readyz, port: 8080 }
  periodSeconds: 5
```

Keep **liveness trivial** (just "is the process up?") so a slow dependency doesn't
trigger a restart loop. Put dependency checks in **readiness** so an unhealthy pod
is removed from the load balancer but not killed. To stop the LB sending new traffic
while in-flight requests drain, wire your `ReadyChecker` to start failing on
shutdown — Celeris does not do this for you (see
[graceful shutdown](#graceful-shutdown-during-deploys)).

## Containers and systemd

### Listen address

Inside a container, bind all interfaces so the orchestrator's port mapping can reach
the process:

```go
s := celeris.New(celeris.Config{Addr: ":8080"}) // 0.0.0.0:8080, not 127.0.0.1
```

`Addr` follows Go's `net.Listen` syntax. `:0` binds an OS-assigned port — read it
back with `s.Addr()` after `Start` (`celeris/server.go:431-439`), handy in tests.

### Workers and GOMAXPROCS

`Config.Workers` sets the number of I/O worker goroutines and **defaults to
`GOMAXPROCS`** (`celeris/config.go:80-81`). In a container, `GOMAXPROCS` defaults to
the *node's* CPU count unless you constrain it, which over-subscribes a pod with a
CPU limit. On Go 1.25+ the runtime reads the cgroup CPU quota automatically;
otherwise set `GOMAXPROCS` to match the pod's CPU limit (or pin `Workers`
explicitly):

```dockerfile
# Match the runtime's parallelism to the pod's CPU limit (e.g. limits.cpu: "4").
ENV GOMAXPROCS=4
```

```go
// Or set Workers directly — overrides the GOMAXPROCS default.
s := celeris.New(celeris.Config{Addr: ":8080", Workers: 4})
```

Leave `Workers` at its default unless you have a measured reason to change it. The
worker count is **fixed at startup** — Celeris does not auto-scale workers at
runtime — so size it once to the CPUs the pod actually has.

> One Linux-specific exception: when the adaptive engine starts on io_uring, it may
> reduce the io_uring worker count at startup if `RLIMIT_MEMLOCK` cannot fund the
> requested rings (`celeris/adaptive`). That is a one-time memlock cap at start, not
> a runtime scaler — raise `memlock` (below) to fund the full count.

### Memory limits and peak RSS

By default Celeris does **not** touch the process GC — the Go runtime's defaults
apply. The peak-RSS high-water mark of a server is usually set during the initial
*connection ramp*, when a burst of new connections allocates faster than the GC
reclaims; steady-state RSS sits well below that spike.

If Celeris owns the process (a dedicated server binary, not a library embedded in a
larger app), set `Config.MemoryLimitBytes` to apply a **soft heap ceiling** via
`runtime/debug.SetMemoryLimit` at `Start` (`celeris/config.go`). When set, the GC
collects before the heap balloons during the ramp, trading a few extra ramp-phase
GC cycles for a lower peak RSS. `0` (the default) leaves the runtime untouched.

```go
// Clip the connection-ramp RSS balloon. Size it generously — it is a ceiling,
// not a steady-state target. DeriveMemoryLimit returns max(256 MiB, workers*32 MiB).
workers := 4
s := celeris.New(celeris.Config{
    Addr:             ":8080",
    Workers:          workers,
    MemoryLimitBytes: celeris.DeriveMemoryLimit(workers),
})
```

> `SetMemoryLimit` is **process-global**, which is why this is opt-in: do not set it
> from a library that shares a process with code you don't control. Set it to a
> generous value — the goal is to clip the ramp spike, not to run the heap tight.

### Running io_uring in a container

io_uring is frequently **disabled by the platform** in containers — not by Celeris.
There are **two independent gates**, and *both* must pass or Celeris transparently
falls back to epoll. This is an optimisation, not a fix-or-fail: epoll is at
throughput parity, so a container that can't use io_uring still runs at full speed.
When io_uring setup is denied, Celeris does **not** crash — the probe's
`io_uring_setup` call returns an error, the io_uring tier is left unselected, and the
adaptive engine runs on epoll (`celeris/probe/probe.go:118-154`). Confirm which
engine you actually got at runtime with `Server.EngineInfo()` (see
[Engines](/docs/engines)).

#### Gate 1 — allow the io_uring syscalls in seccomp

io_uring needs three syscalls: `io_uring_setup` (425), `io_uring_enter` (426), and
`io_uring_register` (427). **Docker blocks all three by default.** Since Docker
**25.0.0** (the change merged in moby in November 2023 —
[moby#46762](https://github.com/moby/moby/pull/46762)), the default seccomp profile
*denies* the io_uring syscalls outright, because io_uring has been a repeated source
of container-escape exploits — the same reasoning that led Google to turn it off
across ChromeOS, Android, and its production fleet, and containerd to block it
earlier. So on any modern Docker/Kubernetes setup io_uring is **off unless you
opt back in**. A blocked `io_uring_setup` surfaces as `EPERM`, and Celeris drops to
epoll.

The blunt, **dev-only** way is to disable seccomp filtering entirely:

```bash
# Dev only — turns OFF all syscall filtering. Never use in production.
docker run --security-opt seccomp=unconfined myimage
```

For production, copy Docker's [default seccomp profile](https://github.com/moby/moby/blob/master/profiles/seccomp/default.json),
add the three syscalls to an allow rule, and point the container at the result:

```jsonc
// celeris-seccomp.json — Docker's default profile, plus io_uring
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["io_uring_setup", "io_uring_enter", "io_uring_register"],
      "action": "SCMP_ACT_ALLOW"
    }
    // …keep all of Docker's default allow rules below
  ]
}
```

```bash
docker run --security-opt seccomp=celeris-seccomp.json myimage
```

In Kubernetes, install that profile on the node and reference it from the Pod (do
**not** ship `Unconfined` to production):

```yaml
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: profiles/celeris-seccomp.json
```

> **gVisor (`runsc`) and some hardened PaaS** (e.g. GKE Autopilot, Cloud Run) do not
> expose io_uring at all — no seccomp profile re-enables it, and Celeris will use
> epoll. That's expected.

#### Gate 2 — raise locked memory (`RLIMIT_MEMLOCK`)

Even with the syscalls allowed, io_uring rings are accounted against the process's
**locked-memory limit** on some kernels, and containers often ship a low default
(a denied setup shows up as `ENOMEM`). Raise it:

```yaml
# docker-compose / Kubernetes securityContext / Pod spec
ulimits:
  memlock: -1   # unlimited (or a generous byte value)
```

Other io_uring prerequisites (verified by `celeris/probe`):

- **Kernel 5.10+** — Celeris's LTS-stable io_uring floor; older kernels fall through
  to epoll (`celeris/probe/probe.go:118`).
- **`CAP_SYS_NICE`** is consulted for SQPoll on some kernels
  (`celeris/probe/probe_linux.go:99-116`); not required for the basic io_uring path.

You do not need to do anything special for epoll; it works on Linux 3.10+ out of the
box. On macOS and Windows the engine is `std` (Go `net/http`).

### SO_REUSEPORT and multiple workers

The native io_uring and epoll engines bind **one `SO_REUSEPORT` socket per worker**
behind the same `(host, port)`, so the kernel load-balances accepted connections
across workers — no userspace accept lock. This is internal and automatic; you do
not configure it. The one place it surfaces is zero-downtime restarts (below): when
you hand a listener to `StartWithListener`, the native engines extract the address
and rebind their own `SO_REUSEPORT` sockets to it, and **you must not `Accept` on or
close the passed listener afterward** (`celeris/server.go:681-699`).

### systemd unit

```ini
[Unit]
Description=My Celeris service
After=network.target

[Service]
ExecStart=/usr/local/bin/myservice
# Raise locked memory for io_uring (otherwise the engine falls back to epoll).
LimitMEMLOCK=infinity
# Plenty of file descriptors for high connection counts.
LimitNOFILE=1048576
# Match Go's parallelism to the CPUs you allotted.
Environment=GOMAXPROCS=8
Restart=on-failure
# Forward SIGTERM for graceful shutdown (the default signal).
KillSignal=SIGTERM
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` should exceed your `Config.ShutdownTimeout` so systemd lets the
drain finish before sending `SIGKILL`.

### Graceful shutdown during deploys

Use `StartWithContext` with a signal-cancelled context so a rolling deploy drains
in-flight requests instead of dropping them
(`celeris/server.go:753-784`). `Config.ShutdownTimeout` bounds the drain (default
30s):

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()

s := celeris.New(celeris.Config{Addr: ":8080", ShutdownTimeout: 15 * time.Second})

if err := s.StartWithContext(ctx); err != nil {
    log.Fatal(err)
}
```

#### Making readiness fail on shutdown

Neither `Shutdown` nor `PauseAccept` touches the readiness probe — the
`healthcheck` middleware only ever returns what your `ReadyChecker` returns
(`celeris/middleware/healthcheck/healthcheck.go:83`). To stop the LB sending new
traffic during a drain you have to flip readiness yourself. The idiomatic wiring is
an `atomic.Bool`, set `true` at startup, flipped to `false` from an
[`OnShutdown`](#graceful-shutdown-during-deploys) hook (fired during `Shutdown`,
`celeris/server.go:218-225`), and read by the `ReadyChecker`:

```go
var ready atomic.Bool
ready.Store(true) // serving as soon as we're up

s := celeris.New(celeris.Config{Addr: ":8080", ShutdownTimeout: 15 * time.Second})

// Flip readiness to 503 the moment a drain begins, before in-flight requests finish.
s.OnShutdown(func(_ context.Context) {
    ready.Store(false)
})

s.Use(healthcheck.New(healthcheck.Config{
    ReadyChecker: func(_ *celeris.Context) bool { return ready.Load() },
}))

ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()

if err := s.StartWithContext(ctx); err != nil {
    log.Fatal(err)
}
```

Flipping it in an `OnShutdown` hook (rather than your signal handler) keeps the
readiness change ordered with the rest of the drain. If you prefer, set
`ready.Store(false)` in your own `SIGTERM` handler *before* calling `Shutdown` —
either way the flip is yours to make. (`atomic.Bool` is in the standard library's
`sync/atomic`.)

For true zero-downtime restarts on the same host, inherit the listening socket
across the exec with `InheritListener` + `StartWithListener`
(`celeris/server.go:693-751`):

```go
ln, err := celeris.InheritListener("CELERIS_LISTENER_FD")
if err != nil {
    log.Fatal(err)
}
if ln != nil {
    log.Fatal(s.StartWithListener(ln)) // adopt the inherited socket
}
log.Fatal(s.Start()) // first launch: bind normally
```

The full handoff protocol — passing the listener FD to the replacement process, the
drain ordering, and the native engines' `SO_REUSEPORT` rebind — is covered in
[Graceful shutdown and zero-downtime restarts](/docs/graceful-shutdown).

In Kubernetes, the rolling-update pattern is: container receives `SIGTERM` →
your readiness flip fires (the `OnShutdown` hook above) so `/readyz` returns 503 →
LB stops new traffic → in-flight requests drain within `ShutdownTimeout` → process
exits. Set `terminationGracePeriodSeconds` greater than `ShutdownTimeout`.

## Capacity and timeout tuning

The timeout and limit fields most relevant in production (full list in
[Configuration](/docs/configuration)):

| Field                | Default | Why it matters in prod                                            |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `ReadHeaderTimeout`  | `10s`   | Slow-loris defence — drip-fed headers get killed fast (`config.go:92-102`) |
| `ReadTimeout`        | `60s`   | Caps total request read time (`config.go:89-91`)                  |
| `WriteTimeout`       | `60s`   | Caps response write time (`config.go:103-105`)                      |
| `IdleTimeout`        | `600s`  | Keep-alive idle cap; set below the LB's idle timeout (`config.go:106-108`) |
| `ShutdownTimeout`    | `30s`   | Drain budget on graceful shutdown (`config.go:109-111`)           |
| `MaxRequestBodySize` | `100MB` | Reject oversized bodies; `-1` disables (`config.go:117-120`)      |
| `MaxConns`           | `0`     | Per-worker connection cap; `0` = unlimited (`config.go:139-140`)  |

Set `IdleTimeout` *below* your load balancer's upstream idle timeout so Celeris
closes idle keep-alives first, avoiding the race where the LB reuses a connection
the server just closed. Keep `ReadHeaderTimeout` short — it is the canonical
slow-loris defence and matters most when traffic can reach the server directly.

`AsyncHandlers` (and the per-route `.Async()` / `.UsesDriver()` overrides) is the
big throughput lever for handlers that do blocking I/O. See [Engines](/docs/engines)
for the dispatch model and [Routing](/docs/routing) for per-route control. For
engine selection and the feature matrix, see [Engines](/docs/engines).

## Logging and observability in production

Pass a structured `*slog.Logger` via `Config.Logger` (defaults to `slog.Default()`,
`celeris/config.go:218-219`); use a JSON handler so your log pipeline can parse it:

```go
logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))
s := celeris.New(celeris.Config{Addr: ":8080", Logger: logger})
```

Built-in metrics are on by default; read a snapshot from the collector for a
`/metrics`-style endpoint, or disable with `Config.DisableMetrics`
(`celeris/config.go:154-157`):

```go
snap := s.Collector().Snapshot() // requests, errors, latency, active conns, CPU
```

Use `c.FullPath()` (the route *pattern*, e.g. `/users/:id`) — not the raw request
path — for low-cardinality metric labels and log fields. For request IDs,
Prometheus/OpenTelemetry export, and the full collector snapshot surface, see
[Observability](/docs/observability); [Routing](/docs/routing) covers `FullPath`.

## Common pitfalls

- **Expecting Celeris to do TLS.** It never does. There is no `StartTLS` and no cert
  config — terminate TLS upstream and forward cleartext.
- **Leaving `TrustedProxies` empty behind a proxy.** `c.ClientIP()` then returns the
  leftmost (spoofable) `X-Forwarded-For` entry. Always scope it to your proxies.
- **Trusting `0.0.0.0/0` "to be safe."** That is the *least* safe option — any
  client can forge its IP. Scope to real proxy ranges.
- **Forgetting the `proxy` middleware when you need `c.Scheme()`.**
  `Config.TrustedProxies` fixes `ClientIP()` but not the scheme; absolute `https://`
  redirects need `proxy.New(...)` to honour `X-Forwarded-Proto`.
- **Dependency checks in the liveness probe.** A flaky dependency then restarts the
  pod in a loop. Keep liveness trivial; put dependency checks in readiness.
- **io_uring silently downgraded to epoll in a container.** Almost always one of the
  two gates above: the seccomp profile blocks `io_uring_setup` (→ `EPERM`) or
  `RLIMIT_MEMLOCK` is too low (→ `ENOMEM`). See
  [Running io_uring in a container](#running-io_uring-in-a-container); throughput on
  epoll is at parity regardless.
- **`GOMAXPROCS` reading the node's CPU count, not the pod's limit.** Over-subscribes
  the scheduler. Set `GOMAXPROCS` to the CPU limit (or rely on Go 1.25+ cgroup
  awareness).
- **`Config.ShutdownTimeout` longer than the orchestrator's grace period.** The
  process gets `SIGKILL`'d mid-drain. Make `terminationGracePeriodSeconds` /
  `TimeoutStopSec` larger than `ShutdownTimeout`.

## FAQ

**Does Celeris support HTTPS or HTTP/3?**
No HTTPS in-process and no HTTP/3. Celeris serves cleartext HTTP/1.1 and h2c; put
TLS (and HTTP/3 at the edge, if you want it) on the upstream terminator.

**Can the proxy talk HTTP/2 to Celeris?**
Yes — over **h2c** (cleartext HTTP/2). Run `Protocol: celeris.Auto` or
`celeris.H2C` and configure the proxy upstream for h2c.

**Where does the client's real IP come from?**
From the `X-Forwarded-For` chain, walked right-to-left and filtered against
`Config.TrustedProxies` (and optionally provider headers via the `proxy`
middleware). It is only trustworthy when `TrustedProxies` is set.

**Why is my server using epoll when I asked for io_uring?**
The kernel is below 5.10, `RLIMIT_MEMLOCK` is too low, or the `io_uring_setup`
syscall is blocked by a sandbox. Celeris probes capabilities and falls back to epoll
(at throughput parity). See [Engines](/docs/engines).

**What status do the probes return?**
`200 {"status":"ok"}` when the checker passes, `503 {"status":"unavailable"}` when
it fails or times out. Only `GET` and `HEAD` are intercepted.

**Do I need both `Config.TrustedProxies` and the `proxy` middleware?**
Not strictly. `Config.TrustedProxies` is enough for a correct `ClientIP()`. Add the
`proxy` middleware when you also need a correct `Scheme()`/`Host()` or a provider
IP header.

## See also

- [Configuration](/docs/configuration) — every `Config` field, timeouts, limits, and
  the metrics collector.
- [Engines](/docs/engines) — io_uring / epoll / adaptive / std, the feature matrix,
  and the async dispatch model.
- [Graceful shutdown and zero-downtime restarts](/docs/graceful-shutdown) — the full
  drain protocol and listener-FD handoff.
- [Observability](/docs/observability) — logging, request IDs, the metrics collector,
  and Prometheus/OpenTelemetry export.
- [Security middleware](/docs/middleware-security) — headers, CORS, and request
  hardening to pair with TLS termination.
- [Routing](/docs/routing) — `FullPath` for metric labels and per-route `.Async()`
  dispatch control.
