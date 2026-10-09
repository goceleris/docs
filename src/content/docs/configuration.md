---
title: Configuration reference
description: Every Config field, its default, and what it does — timeouts, limits, protocol, engine, and callbacks.
group: Reference
order: 1
---

Everything about a Celeris server is configured through one struct, `celeris.Config`,
passed to `celeris.New`. Every field has a sensible default, so the zero `Config{}`
is a valid, production-shaped server; set only what you need to change.

```go
s := celeris.New(celeris.Config{
    Addr:               ":8080",
    Protocol:           celeris.Auto,     // HTTP1 | H2C | Auto
    Engine:             celeris.Adaptive, // IOUring | Epoll | Adaptive | Std
    Workers:            8,                // I/O workers (default GOMAXPROCS)
    ReadTimeout:        60 * time.Second,
    WriteTimeout:       60 * time.Second,
    IdleTimeout:        600 * time.Second,
    ShutdownTimeout:    30 * time.Second,
    MaxRequestBodySize: 50 << 20,         // 50 MiB (default 100 MiB; -1 = unlimited)
    Logger:             slog.Default(),
})
```

The `Config` struct is defined in `celeris/config.go:72-243`. Defaults are filled in
at `Start` by `celeris/internal/resource/config.go:239` (`WithDefaults`) and validated by
`celeris/internal/resource/config.go:148` (`Validate`).

## The zero / `-1` convention

Read this first — it governs how every timeout and limit field behaves.

For the timeout fields (`ReadTimeout`, `ReadHeaderTimeout`, `WriteTimeout`,
`IdleTimeout`) and the size-limit fields (`MaxRequestBodySize`, `MaxFormSize`):

| Value you set | What Celeris does                                            |
| ------------- | ----------------------------------------------------------- |
| **`0`** (zero)| Apply the **documented default** (e.g. `ReadTimeout` → 60s) |
| **`-1`**      | **Disable** the timeout / limit (no timeout, unlimited)     |
| any `> 0`     | Use your value verbatim                                     |

The consequence that trips people up: **you cannot get "no timeout" by leaving a
field at its zero value.** Leaving `ReadTimeout` unset gives you a 60-second
timeout, not an unbounded one. To truly disable it you must explicitly write `-1`.
This is by design — a latency-focused engine should never silently run with
unbounded read/write windows, because that is exactly the door a slow-loris client
walks through.

```go
celeris.Config{
    ReadTimeout:  0,             // → 60s default (NOT unlimited)
    WriteTimeout: -1,            // → no write timeout (e.g. for SSE/streaming)
    IdleTimeout:  90 * time.Second, // → exactly 90s
}
```

The mapping happens in `WithDefaults` (`celeris/internal/resource/config.go:279-284`, `294-303`, `317-326`):
`0` falls through to the default branch; a negative value is normalised to `0`,
which internally means "off". Validation rejects anything below `-1`
(`celeris/internal/resource/config.go:191-199`), so `-2`, `-5s`, etc. are config errors.

## Network, protocol, and engine

### `Addr`

```go
celeris.Config{Addr: ":8080"}  // listen on all interfaces, port 8080
celeris.Config{Addr: ":0"}     // let the OS choose a free port
celeris.Config{Addr: "127.0.0.1:9000"} // bind to loopback only
```

| Field  | Type     | Default   | Notes                                              |
| ------ | -------- | --------- | -------------------------------------------------- |
| `Addr` | `string` | `":8080"` | TCP address in `host:port` form. Empty → `:8080`.  |

- An empty `Addr` becomes `:8080` (`celeris/internal/resource/config.go:240-242`).
- `:0` binds an OS-assigned ephemeral port — handy for tests and for letting a
  process manager pick the port. Retrieve the chosen address from the server after
  it starts if you need it.
- Validation parses the `host:port` split and requires the port to be `0–65535`;
  a malformed address or out-of-range port is a config error
  (`celeris/internal/resource/config.go:151-161`).

### `Protocol`

Selects which HTTP versions the server speaks over cleartext (no TLS). Celeris
serves **cleartext** HTTP; for HTTPS you terminate TLS at a proxy or load balancer
in front of it — see [Deployment](/docs/deployment).

| Value             | Behaviour                                                  |
| ----------------- | --------------------------------------------------------- |
| `celeris.Auto`    | **Default.** Serve HTTP/1.1 and h2c simultaneously on the same port, upgrading per connection on demand |
| `celeris.HTTP1`   | HTTP/1.1 only                                             |
| `celeris.H2C`     | HTTP/2 cleartext (h2c) only                               |

Defined in `celeris/config.go:15-22`. The zero value resolves to `Auto`
(`celeris/internal/resource/config.go:252-254`). `Protocol` interacts with `EnableH2Upgrade`
(see [below](#enableh2upgrade)).

### `Engine`

The I/O engine that drives the accept/read/write loop. The native engines are
**Linux-only**; on any other OS they are a hard error at `Start`.

| Value               | Platform      | Notes                                                |
| ------------------- | ------------- | --------------------------------------------------- |
| `celeris.Adaptive`  | Linux only    | **Default on Linux.** Starts on epoll, promotes connections to io_uring under load |
| `celeris.Epoll`     | Linux only    | Edge-triggered epoll                                 |
| `celeris.IOUring`   | Linux 5.10+   | io_uring async I/O                                   |
| `celeris.Std`       | any platform  | **Default off-Linux.** Go `net/http` server         |

Defined in `celeris/config.go:30-39`. The zero value resolves to `Adaptive` on
Linux and `Std` everywhere else (`celeris/internal/resource/config.go:13-19`,
`243-245`).

**Off-Linux hard error.** If you explicitly request `Adaptive`, `Epoll`, or
`IOUring` on macOS, Windows, or any non-Linux OS, `Start` fails validation with an
error like `engine epoll requires Linux` (`celeris/internal/resource/config.go:201-208`).
Leave `Engine` zero and you transparently get `Std` off-Linux, so the same code
runs everywhere — only override `Engine` when you know you are on Linux.

```go
// Portable: zero value → Adaptive on Linux, Std elsewhere. Recommended.
s := celeris.New(celeris.Config{Addr: ":8080"})

// Linux-only: forcing a native engine off-Linux is a Start error.
s := celeris.New(celeris.Config{Engine: celeris.IOUring})
```

See [Engines](/docs/engines) for the full trade-off discussion.

### `WorkloadHint`

An **optional** declaration of expected steady-state concurrency. It affects
*only* the `Adaptive` engine's **start** decision — nothing else, and nothing on
the `Std`/`Epoll`/`IOUring` engines.

| Value                              | Effect on Adaptive's start engine                        |
| ---------------------------------- | -------------------------------------------------------- |
| `celeris.WorkloadUnspecified`      | **Default (zero).** Start on epoll, promote under load   |
| `celeris.WorkloadLowConcurrency`   | Thin/latency-sensitive traffic — start and stay on epoll |
| `celeris.WorkloadHighConcurrency`  | Many H1 keep-alive conns/worker — start on io_uring (when kernel + `RLIMIT_MEMLOCK` allow) |

Defined in `celeris/config.go:44-61` and `celeris/internal/resource/resource.go:1-25`.
Since v1.5.6 established connections **transplant** between epoll and io_uring when
Adaptive switches (both directions), so the *start* engine no longer fixes
keep-alive throughput — but concurrency is unknowable when the server binds (no
connections exist yet), so a good start still avoids an unnecessary early switch.
`WorkloadHighConcurrency` makes `Adaptive` *start* on io_uring; otherwise it ramps
from epoll and switches to io_uring under sustained load, carrying its established
keep-alives across.

```go
celeris.Config{
    Engine:       celeris.Adaptive,
    WorkloadHint: celeris.WorkloadHighConcurrency, // start on io_uring
}
```

### `Workers`

```go
celeris.Config{Workers: 8} // 8 I/O worker goroutines
```

| Field     | Type  | Default      | Constraint            |
| --------- | ----- | ------------ | --------------------- |
| `Workers` | `int` | `GOMAXPROCS` | `>= 2` if set (`MinWorkers`) |

The number of I/O worker goroutines. Zero means `GOMAXPROCS`
(`celeris/internal/resource/preset.go:17-23`, `celeris/internal/resource/resource.go:92-117`). If you set it, it must be `>= 2`;
`Workers: 1` is a config error (`workers must be >= 2 if set`,
`celeris/internal/resource/config.go:179-181`, `celeris/internal/resource/preset.go:7-8`).

## Timeouts

All timeouts follow the [zero / `-1` convention](#the-zero---1-convention).

| Field               | Type            | Default | `-1` means      | Purpose                                              |
| ------------------- | --------------- | ------- | --------------- | --------------------------------------------------- |
| `ReadTimeout`       | `time.Duration` | `60s`   | no read timeout | Max time to read the **entire** request             |
| `ReadHeaderTimeout` | `time.Duration` | `10s`   | no header timeout | Max time to read **just** the request line + headers |
| `WriteTimeout`      | `time.Duration` | `60s`   | no write timeout | Max time to write the response                       |
| `IdleTimeout`       | `time.Duration` | `600s`  | no idle timeout | Max idle time on a keep-alive connection            |
| `ShutdownTimeout`   | `time.Duration` | `30s`   | —               | Drain deadline on graceful shutdown                 |

Sources: `celeris/config.go:81-103`, defaults at `celeris/internal/resource/config.go:288-303`.

### `ReadHeaderTimeout` is your slow-loris defence

`ReadHeaderTimeout` caps the read of the request line and headers *separately* from
the body (which `ReadTimeout` covers). This is the canonical defence against
slow-loris attacks: a client that dribbles one header byte every few hundred
milliseconds gets its connection killed within 10 seconds instead of holding a
worker and a listener-backlog slot for the full `ReadTimeout` window. The default
of 10s defeats slow-loris while still letting legitimate proxies and high-latency
(satellite) clients finish their headers. The std engine wires this to
`http.Server.ReadHeaderTimeout`; the io_uring/epoll engines enforce the same budget
inside their H1 header read loop (`celeris/config.go:94-104`,
`celeris/internal/resource/config.go:45-61`).

### Streaming and SSE need `-1`

A long-lived response — Server-Sent Events, a chunked stream, a slow large
download — will be cut off by `WriteTimeout` (default 60s). Disable it on the
server for streaming workloads:

```go
celeris.Config{
    WriteTimeout: -1, // never time out the write side
}
```

If only *some* of your routes stream, prefer disabling the write timeout server-wide
only when streaming dominates; otherwise keep the 60s default for normal routes and
reach for [Streaming](/docs/streaming) / [SSE](/docs/sse) which manage long-lived
responses at the handler level.

### `ShutdownTimeout` only applies to context-based start

`ShutdownTimeout` is the deadline of the graceful shutdown a cancelled context starts:
one deadline for the drain of in-flight requests and then the `OnShutdown` hooks. It is
consumed by `StartWithContext` and `StartWithListenerAndContext`
(`celeris/server.go` (`listenUntilCancelled`)), which default it to 30s when left zero.
Plain `Start()` blocks until you call `Shutdown(ctx)` yourself, in which case the
deadline comes from the context *you* pass to `Shutdown`, not from this field.

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
defer stop()

s := celeris.New(celeris.Config{
    Addr:            ":8080",
    ShutdownTimeout: 15 * time.Second, // drain deadline on SIGINT
})
// StartWithContext drains using ShutdownTimeout when ctx is cancelled.
if err := s.StartWithContext(ctx); err != nil {
    log.Fatal(err)
}
```

## Body, form, and header limits

| Field                | Type    | Default        | `-1` means | Constraint            |
| -------------------- | ------- | -------------- | ---------- | --------------------- |
| `MaxRequestBodySize` | `int64` | `100 MB` (`100 << 20`) | unlimited  | —                     |
| `MaxFormSize`        | `int64` | `32 MB` (`32 << 20`)   | unlimited  | per-request           |
| `MaxHeaderBytes`     | `int`   | `16 MB` (`16 << 20`)   | —          | `>= 4096` if set      |

### `MaxRequestBodySize`

The maximum request body, enforced uniformly across all protocols (H1, H2, and the
std bridge). Zero applies the 100 MB default; `-1` disables the limit
(`celeris/config.go:109-112`, `celeris/internal/resource/config.go:279-284`).

```go
celeris.Config{MaxRequestBodySize: 10 << 20}  // cap uploads at 10 MiB
celeris.Config{MaxRequestBodySize: -1}        // no limit (use with care)
```

### `MaxFormSize`

The maximum **memory** used for multipart form parsing, **per request** (default
32 MB, the same as `net/http`). Zero applies the default
(`DefaultMaxFormSize`, `celeris/types.go:10-12`); a negative value (`-1`) disables
the limit, parsing with no in-memory ceiling (`celeris/config.go:105-107`,
`celeris/handler.go:58-60`, enforced at `celeris/context_request.go:621-623`). It
bounds the in-memory portion of
`multipart/form-data` parsing — see [Request handling](/docs/request-handling) for
form access (`FormValue`, files) and per-context overrides.

```go
celeris.Config{MaxFormSize: 8 << 20}  // 8 MiB of in-memory form data per request
```

### `MaxHeaderBytes`

The maximum size of a request's header block (default 16 MB). If you set it, it
must be **at least 4096**; a smaller positive value is a config error
(`maxHeaderBytes must be >= 4096 if set`, `celeris/config.go:120-121`,
`celeris/internal/resource/config.go:175-177`, `276-278`).

```go
celeris.Config{MaxHeaderBytes: 64 << 10}  // 64 KiB
```

## HTTP/2 tuning

These apply when HTTP/2 (h2c) is in play — via `Protocol: H2C`, an h2c upgrade, or
`Protocol: Auto`.

| Field                  | Type     | Default            | Constraint                |
| ---------------------- | -------- | ------------------ | ------------------------- |
| `MaxConcurrentStreams` | `uint32` | `100`              | `<= 2147483647`           |
| `MaxFrameSize`         | `uint32` | `1 MiB` (`1 << 20`) | `16384 – 16777215` if set |
| `InitialWindowSize`    | `uint32` | `1 MiB` (`1 << 20`) | `<= 2147483647`           |

Sources: `celeris/config.go:114-119`, defaults at `celeris/internal/resource/config.go:258-275`,
validation at `celeris/internal/resource/config.go:163-173`.

The real defaults for both `MaxFrameSize` and `InitialWindowSize` are **1 MiB**
(`1 << 20`), as set by `WithDefaults` (`celeris/internal/resource/config.go:258-272`).

```go
celeris.Config{
    MaxConcurrentStreams: 250,        // more parallel streams per H2 connection
    MaxFrameSize:         16384,      // smallest legal frame (must be >= 16384)
    InitialWindowSize:    4 << 20,    // 4 MiB flow-control window
}
```

`MaxFrameSize` has a hard floor of `16384` (the H2 spec minimum) — setting, say,
`8192` is a config error. Leaving it `0` uses the 1 MiB default, which is *above*
the floor.

## Connection, socket, and I/O

| Field              | Type   | Default        | Constraint              | Effect                                         |
| ------------------ | ------ | -------------- | ----------------------- | ---------------------------------------------- |
| `DisableKeepAlive` | `bool` | `false`        | —                       | One request per connection when `true`         |
| `BufferSize`       | `int`  | `8192`         | `>= 4096`; clamped to `262144` | Per-connection I/O buffer size in bytes  |
| `SocketRecvBuf`    | `int`  | OS default (0) | —                       | `SO_RCVBUF` for accepted connections           |
| `SocketSendBuf`    | `int`  | OS default (0) | —                       | `SO_SNDBUF` for accepted connections           |
| `MaxConns`         | `int`  | unlimited (0)  | —                       | Max simultaneous connections **per worker**    |

Sources: `celeris/config.go:123-132`, `celeris/internal/resource/resource.go:27-54`,
`celeris/internal/resource/preset.go:11-14`.

- **`DisableKeepAlive`** — when `true`, each request runs on its own connection and
  the connection closes after the response. Leave `false` (the default) for
  performance; keep-alive is what makes the engine fast.
- **`BufferSize`** — the per-connection I/O buffer. Zero uses the engine default
  (8192 bytes, `celeris/internal/resource/preset.go:26`). If you set it, a value below 4096 is
  a config error (`bufferSize must be >= 4096 if set`,
  `celeris/internal/resource/config.go:183-185`), while a value above 262144 is silently
  clamped down to that ceiling (`MaxBufferSize`, `celeris/internal/resource/resource.go:114`).
- **`SocketRecvBuf` / `SocketSendBuf`** — set `SO_RCVBUF` / `SO_SNDBUF` on accepted
  sockets. **Leave them at 0** unless you have a measured reason: 0 lets the kernel's
  TCP auto-tuning own buffer sizing (up to `net.ipv4.tcp_rmem`/`tcp_wmem` maxima),
  which is usually better. Forcing a fixed size can cap the receive window and
  *throttle* large-body POSTs on hosts where `net.core.rmem_max` is small
  (`celeris/internal/resource/preset.go:29-36`).
- **`MaxConns`** — the cap is **per worker**, not server-wide. With `Workers: 8` and
  `MaxConns: 1000`, the server tolerates up to ~8000 connections. Zero means
  unlimited.

```go
celeris.Config{
    Workers:   8,
    MaxConns:  2000,    // ~16000 connections across 8 workers
    BufferSize: 16384,  // 16 KiB per-connection buffer
}
```

## Memory

### `MemoryLimitBytes`

An **optional** soft heap ceiling (in bytes) applied via
`runtime/debug.SetMemoryLimit` at `Start`. It is **opt-in only** and, when set,
clips the peak-RSS balloon that a connection-ramp burst would otherwise produce.

| Field              | Type    | Default     | Effect                                            |
| ------------------ | ------- | ----------- | ------------------------------------------------- |
| `MemoryLimitBytes` | `int64` | `0` (unset) | Soft heap ceiling via `debug.SetMemoryLimit`      |

- **`0` (default)** — Celeris does **not** touch the process GC; the runtime
  default (`GOGC=100`, no limit) stands, and embedders keep full control
  (`celeris/config.go:166-176`, applied at `celeris/server.go:970-971`).
- **`> 0`** — the GC collects *before* the heap balloons during a connection-ramp
  burst, trading a few extra GC cycles during the ramp for a lower high-water
  mark. Steady-state RSS sits far below the limit, so steady throughput is
  unaffected. A negative value is a config error
  (`memoryLimitBytes must be >= 0`, `celeris/internal/resource/config.go:187-189`).

> **`SetMemoryLimit` is process-global.** Set this only when Celeris owns the
> process (e.g. a dedicated server binary), never when Celeris is embedded
> alongside other heap-sensitive code that manages its own GC target.

`celeris.DeriveMemoryLimit(workers)` returns a generous, ready-to-use ceiling —
`max(256 MiB, workers*32 MiB)` (`celeris/config.go:63-70`). It is sized **high**
on purpose: the goal is to clip the ramp balloon, not to run the heap tight (a
too-tight limit GC-thrashes under load). It is never applied implicitly — you
must pass it explicitly.

```go
cfg := celeris.Config{Addr: ":8080", Workers: 8}
cfg.MemoryLimitBytes = celeris.DeriveMemoryLimit(cfg.Workers) // soft heap ceiling
s := celeris.New(cfg)
```

## Behaviour, observability, and callbacks

### `DisableMetrics`

Built-in metrics are **on by default**. Set `DisableMetrics: true` to turn off the
collector — `Server.Collector()` then returns `nil` and per-request recording is
skipped (`celeris/config.go:178-181`, `celeris/server.go:152-154`, `863-868`).

```go
snap := s.Collector().Snapshot() // requests, errors, latency, active conns, CPU
// or, to opt out entirely:
s := celeris.New(celeris.Config{DisableMetrics: true})
```

### `AsyncHandlers`

The **server-level default** for how handlers are dispatched. When `false` (the
default) handlers run inline on the I/O worker — best for CPU/cache-bound work. When
`true`, handlers run on spawned goroutines so blocking I/O (DB drivers, upstream
HTTP, file reads) does not stall the event loop (`celeris/config.go:139-187`).

Individual routes and groups override this with `Route.Async()` / `RouteGroup.Async()`
(most-specific wins: route > group > server default). The common pattern is to keep
this `false` and mark just the I/O routes `.Async()` / `.UsesDriver()`. See
[Routing](/docs/routing) for the per-route controls and [Engines](/docs/engines) for
the full dispatch model. A request no route matches runs the global middleware
too. With `AsyncHandlers: true` it is dispatched like a route that inherits that
default: inline until a timed run of its chain blocks, then async. All unmatched
requests share that one decision, and a run of fast ones (scanner 404s, health
checks) settles it as it settles a route; from then on an unmatched request whose
chain blocks runs inline on the engine worker, unless it is the one re-timed after a
settle re-open (every 5 s). With `AsyncHandlers: false` unmatched requests always run
inline, even when routes are `.Async()`. So a global middleware that can block (a
remote session store, an auth upstream, `pprof`'s profile) can hold an engine worker,
and every connection on it, for an unmatched request; mount it on `.Async()` routes
where that matters.

```go
celeris.Config{AsyncHandlers: false}            // default: inline; mark I/O routes .Async()
celeris.Config{AsyncHandlers: true}             // default async; mark hot CPU routes .Sync()
```

> **Driver fast path keys off the *effective* async state.** Celeris drivers opened
> `WithEngine(srv)` pick their netpoll-park fast path from whether the server is
> *effectively* async — i.e. `AsyncHandlers: true` **or** any route opted in via
> `.Async()` / `.UsesDriver()` (`celeris/config.go:197-205`). The effective state is
> read at driver construction, so if you keep `AsyncHandlers: false` and rely on
> per-route `.Async()` / `.UsesDriver()`, **open the driver *after* registering those
> routes** — or set `AsyncHandlers: true` to be order-independent. See
> [Data stores](/docs/data-stores).

### `OnExpectContinue`

Called when an H1 request carries `Expect: 100-continue`. Return `false` to respond
`417 Expectation Failed` and skip reading the body; return `true` (or leave the
callback `nil`) to send `100 Continue` and read the body
(`celeris/config.go:189-192`).

```go
celeris.Config{
    OnExpectContinue: func(method, path string, headers [][2]string) bool {
        return method == "POST" && path == "/uploads" // only accept uploads here
    },
}
```

### `OnConnect` / `OnDisconnect`

Connection lifecycle callbacks, invoked with the remote peer address when a
connection is accepted and closed (`celeris/config.go:194-199`).

> **These run on the event loop — they must not block.** A slow `OnConnect` /
> `OnDisconnect` stalls the I/O worker and degrades every connection it handles. Do
> only cheap, non-blocking work (e.g. an atomic counter increment). Push any logging
> or I/O to a buffered channel a separate goroutine drains.

```go
var live int64
celeris.Config{
    OnConnect:    func(addr string) { atomic.AddInt64(&live, 1) },
    OnDisconnect: func(addr string) { atomic.AddInt64(&live, -1) },
}
```

### `TrustedProxies`

A list of trusted proxy CIDR ranges (or bare IPs). It controls how `Context.ClientIP()`
interprets `X-Forwarded-For` (`celeris/config.go:256-260`, parsed at
`celeris/server.go:909-924`).

> **Security-critical.** When `TrustedProxies` is **empty**, `ClientIP()` trusts
> proxy headers from *anyone* (legacy behaviour) — a client can spoof its IP by
> sending its own `X-Forwarded-For`. **If you sit behind a proxy or load balancer,
> set this** to the proxy's network(s) so only forwarded headers from trusted hops
> are honoured. See [Deployment](/docs/deployment).

Entries may be CIDR (`10.0.0.0/8`) or a bare IP (`192.168.1.10`, normalised to a
`/32` or `/128`). An unparseable entry is a `Start` error
(`celeris: invalid TrustedProxies entry: …`, `celeris/server.go:909-916`).

```go
celeris.Config{
    TrustedProxies: []string{
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
    },
}
```

### `Logger`

The structured logger for server diagnostics. Defaults to `slog.Default()` when
`nil` (`celeris/config.go:207-208`, `celeris/internal/resource/config.go:285-287`).

```go
celeris.Config{
    Logger: slog.New(slog.NewJSONHandler(os.Stdout, nil)),
}
```

### `EnableH2Upgrade`

A **`*bool`** (three-state) controlling whether the server honours RFC 7540 §3.2
`Upgrade: h2c` requests — promoting an HTTP/1 connection to cleartext HTTP/2. Being
a pointer lets Celeris distinguish "not set" from "explicitly false"
(`celeris/config.go:210-221`, resolved at `celeris/config.go:275-282`):

| Value         | Behaviour                                                             |
| ------------- | -------------------------------------------------------------------- |
| `nil` (default) | **Inferred from `Protocol`:** enabled for `Auto`; disabled for `H2C` (clients already speak H2) and `HTTP1` (no H2 stack) |
| `&true`       | Force enabled — e.g. opt into upgrade on `Protocol: H2C`             |
| `&false`      | Force disabled, even on `Protocol: Auto`                             |

Because it is a pointer, you need an addressable `bool`. A tiny helper reads best:

```go
func boolPtr(b bool) *bool { return &b }

celeris.Config{
    Protocol:        celeris.Auto,
    EnableH2Upgrade: boolPtr(false), // Auto, but explicitly refuse h2c upgrades
}
```

## Validation behaviour

Configuration is validated **at `Start`** (and `StartWithContext` /
`StartWithListener…`), not at `celeris.New`. `New` never fails; the validation runs
inside the one-time prepare step and is reported as the error returned by `Start`
(`celeris/server.go:899-907`). All field errors are collected and joined, so one
`Start` call surfaces every problem at once, prefixed with `config validation:`.

Common errors under the `config validation:` prefix (`celeris/internal/resource/config.go:148-227`):

| Error message (substring)                          | Cause                                            |
| -------------------------------------------------- | ------------------------------------------------ |
| `invalid addr "…"` / `port must be 0-65535`        | Malformed `Addr` or out-of-range port            |
| `engine epoll requires Linux` (or `adaptive`/`iouring`) | A native engine requested off-Linux         |
| `workers must be >= 2 if set`                       | `Workers: 1`                                      |
| `bufferSize must be >= 4096 if set`                 | `BufferSize` below 4096                           |
| `maxHeaderBytes must be >= 4096 if set`             | `MaxHeaderBytes` below 4096                       |
| `maxFrameSize must be 16384-16777215`              | `MaxFrameSize` out of range                       |
| `initialWindowSize must be 0-2147483647`           | `InitialWindowSize` too large                     |
| `maxConcurrentStreams must be <= 2147483647`       | `MaxConcurrentStreams` too large                  |
| `readTimeout must be >= -1` (also write/idle)      | A timeout set below `-1`                          |

`TrustedProxies` is parsed *after* validation passes and surfaces its own error
(not under the `config validation:` prefix): `celeris: invalid TrustedProxies entry: …`
for an unparseable CIDR/IP (`celeris/server.go:909-916`).

```go
s := celeris.New(celeris.Config{Workers: 1, Engine: celeris.IOUring}) // off-Linux
if err := s.Start(); err != nil {
    // err: "config validation: workers must be >= 2 if set, got 1\nengine iouring requires Linux"
    log.Fatal(err)
}
```

## Common pitfalls

- **Zero is the default, not "off".** Leaving `ReadTimeout`/`WriteTimeout`/
  `MaxRequestBodySize` at zero gives you the *default*, not unlimited. Use `-1` to
  disable. (See [the convention](#the-zero---1-convention).)
- **SSE/streaming cut off at 60s.** A long-lived response hits the default
  `WriteTimeout`. Set `WriteTimeout: -1` for streaming workloads.
- **Native engine off-Linux fails at `Start`.** Don't hardcode `Engine: Adaptive`
  in portable code — leave it zero and you get `Std` off-Linux automatically.
- **`MaxConns` is per worker.** Multiply by `Workers` to reason about the total.
- **`OnConnect`/`OnDisconnect` must not block.** They run on the event loop.
- **Empty `TrustedProxies` trusts spoofed `X-Forwarded-For`.** Always set it behind
  a proxy.
- **`WorkloadHint` only affects `Adaptive`'s start engine.** It is a no-op on
  `Std`/`Epoll`/`IOUring`.
- **Errors come from `Start`, not `New`.** `New` always succeeds; check the error
  from `Start`.

## FAQ

**How do I get truly unbounded timeouts/body sizes?**
Set the field to `-1`. Zero gives the default.

**Where do defaults get applied?**
In `WithDefaults` (`celeris/internal/resource/config.go:239`), called by the server's prepare
step at `Start`. You can read the source to see every default value.

**Does `Start()` use `ShutdownTimeout`?**
No. `ShutdownTimeout` is used by `StartWithContext` /
`StartWithListenerAndContext`. Plain `Start()` drains using the context you pass to
`Shutdown(ctx)`.

**Can I change the listening port at runtime?**
No — `Addr` is read once at `Start`. Use `Addr: ":0"` to let the OS pick a port, or
pass your own pre-bound listener via `StartWithListener`.

**Why is `EnableH2Upgrade` a `*bool`?**
So Celeris can tell "unset" (infer from `Protocol`) apart from an explicit
`false`. Use a `*bool` helper to set it.

## See also

- [Engines](/docs/engines) — `Engine`, `WorkloadHint`, `AsyncHandlers`, and the
  dispatch model in depth.
- [Deployment](/docs/deployment) — TLS termination, `TrustedProxies`, and running
  behind a proxy or load balancer.
- [Request handling](/docs/request-handling) — body and form access, where
  `MaxRequestBodySize` / `MaxFormSize` bite.
- [Routing](/docs/routing) — per-route `Async` / `Sync` / `UsesDriver` overrides of
  `AsyncHandlers`.
- [Streaming](/docs/streaming) and [SSE](/docs/sse) — long-lived responses that need
  `WriteTimeout: -1`.
