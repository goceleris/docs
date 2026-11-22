---
title: Runtime notes
description: "Reference notes moved from the celeris README. Feature details, the engine feature matrix, async handlers, driver event-loop use, tuning variables, busy polling, shutdown behaviour and engine selection."
group: Reference
order: 4
---

These notes were moved from the celeris README so that the README can stay a front page. Nothing was rewritten in the move. Where the same topic has its own page ([Engines](/docs/engines), [Graceful shutdown](/docs/graceful-shutdown), [Configuration](/docs/configuration)), that page is the primary reference and this one adds what it lacks.


## Features in detail

- **Tiered io_uring** — probes the kernel at start and uses the feature set it supports (multishot accept from 5.19 and zero-copy send from 6.0; no tier enables SQPOLL); multishot receive with provided buffers is opt-in (see the tuning variables).
- **Edge-triggered epoll** — per-core event loops with CPU pinning.
- **Adaptive meta-engine** — by default starts on epoll and moves to io_uring under sustained load, based on telemetry (`CELERIS_ADAPTIVE_START` picks the starting engine).
- **First-party database drivers** — native [`driver/postgres`](https://github.com/goceleris/celeris/tree/main/driver/postgres), [`driver/redis`](https://github.com/goceleris/celeris/tree/main/driver/redis), and [`driver/memcached`](https://github.com/goceleris/celeris/tree/main/driver/memcached) run on the celeris event loop (see [Database drivers](/docs/runtime-notes#database-drivers-and-event-loops)).
- **Zero-copy HTTP/1.1 parser** — the parser returns header and body slices that alias the bytes it parses instead of copying them. On epoll and io_uring, a request that arrives whole in one read, with no body or a `Content-Length` body, and runs inline is parsed in place in the engine's read buffer; a request that spans reads, has a chunked body, or runs on an async handler is served from a per-connection buffer instead.
- **HTTP/2 cleartext (h2c)** — full stream multiplexing, flow control, HPACK, inline handler execution, a HEADERS fast path for simple frames.
- **Auto-detect** — protocol negotiation from the first bytes on the wire.
- **Error-returning handlers** — `HandlerFunc` returns `error`; structured `*HTTPError` carries status codes.
- **Pre-routing middleware** — `Server.Pre()` runs middleware before route matching (method override, URL rewrite).
- **Serialization** — JSON and XML response methods; `Bind` auto-detects request format from `Content-Type`.
- **net/http compatibility** — wrap an existing `http.Handler` via `celeris.Adapt()` / `celeris.AdaptFunc()`.
- **Streaming responses** — `StreamWriter()` for chunked incremental writes on any engine; `Detach()` for keep-alive-after-return streaming on native engines (see [Streaming](/docs/streaming)).
- **Connection hijacking** — `Hijack()` for custom protocol upgrades (HTTP/1.1 only).
- **Engine-integrated WebSocket** — `UpgradeWebSocket()` hands the conn to the worker loop with backpressure, permessage-deflate, and a `Hub` for fan-out broadcast.
- **Response buffering** — `BufferResponse` / `FlushResponse` for transform middleware (compress, ETag, cache).
- **File serving** — `File()` from the OS, `FileFromFS()` from `embed.FS` / `fs.FS`.
- **Content negotiation** — `Negotiate`, `Respond`, `AcceptsEncodings`, `AcceptsLanguages`.
- **Configurable body limits** — `MaxRequestBodySize` enforced on HTTP/1.1 and h2c (default 4 MiB; the net/http bridge has two fixed 100 MB caps: `ToHandler` on the request body, `Adapt` on the adapted handler's buffered response).
- **100-continue control** — `OnExpectContinue` callback validates uploads before the body transfers.
- **Accept control** — `PauseAccept()` / `ResumeAccept()` for graceful load shedding. A pause carries clients that have connected but not yet sent their request: it keeps the listen sockets open for about 1.5 s with `TCP_DEFER_ACCEPT` cleared before closing them, and blocks for that long; set `DisableDeferAccept` for a pause that closes at once ([#662](https://github.com/goceleris/celeris/issues/662), [#675](https://github.com/goceleris/celeris/issues/675)).
- **Zero-downtime restart** — `InheritListener` + `StartWithListener` for socket inheritance.
- **Built-in metrics** — atomic counters, CPU-utilization sampling, on by default via `Server.Collector().Snapshot()` (opt out with `Config.DisableMetrics`).
- **Opt-in GC target** — `Config.GCPercent` sets the process GC target when the server starts (default off); it exists for large-message WebSocket p99 (see [Garbage collector target](/docs/websocket#large-messages-and-the-garbage-collector)).
- **Per-route async dispatch** — `Route.Async()` / `Route.Sync()` choose inline-on-worker vs. per-conn dispatch goroutine per route; h2 chooses per stream.

**TLS:** celeris is cleartext by design: TLS is terminated at the edge. The io_uring and epoll engines speak HTTP/1.1 and h2c only, and there is no `ListenTLS`. Terminate TLS upstream (Caddy, Nginx, Envoy, a cloud load balancer). If you need HTTPS in-process, run the std engine and pass a TLS listener: `Engine: celeris.Std` with `StartWithListener(tls.NewListener(ln, cfg))` serves HTTPS over HTTP/1.1, at the std engine's performance. The database drivers are cleartext too (see [Database drivers](/docs/runtime-notes#database-drivers-and-event-loops)). First-class TLS is tracked in [#446](https://github.com/goceleris/celeris/issues/446).

## Engine feature matrix (README version)

| Feature | io_uring | epoll | std |
|---------|----------|-------|-----|
| HTTP/1.1 | yes | yes | yes |
| h2c | yes | yes | yes |
| Auto-detect | yes | yes | yes |
| CPU pinning | yes | yes | no |
| Provided buffers | opt-in, with multishot recv (5.19+) | no | no |
| Multishot accept | yes (5.19+) | no | no |
| Multishot recv | opt-in (5.19+, `CELERIS_IOURING_MULTISHOT_RECV=1`) | no | no |
| Provided-buffer ring size | 1024 entries per worker (`CELERIS_IOURING_PBUF_COUNT=N` to override) | n/a | n/a |
| HEADERS fast path | yes | yes | no |
| Inline h2 handlers | yes | yes | no |
| Inline WS / SSE broadcast egress | yes | yes | n/a (net/http) |
| `StreamWriter` (sync incremental) | yes | yes | yes |
| `Detach` (async keep-alive) | yes | yes | no |
| Connection hijack | yes | yes | yes |

CPU pinning has [its own page](/docs/cpu-pinning).

## Async handlers (per route)

Celeris runs every handler **inline on the I/O worker** by default — no goroutine hand-off. For handlers that block on I/O (database, RPC, filesystem), opt **per route** into the per-connection dispatch goroutine so the worker stays free to drive other connections:

```go
// CPU-only / cache-only — runs inline (default).
s.GET("/healthz", healthHandler)

// Blocking I/O — async, runs on a per-conn goroutine.
s.GET("/db", dbHandler).Async()

// Or flip the default at the group level:
api := s.Group("/api").Async()
api.GET("/products", productHandler)     // async (inherited)
api.GET("/cached", cachedHandler).Sync() // opt back to sync
```

Precedence is **route > group > server default** (`Config.AsyncHandlers`). It works identically across io_uring, epoll, and adaptive — both sub-engines honor the per-route flag, and async promotions survive sub-engine swaps: a conn is promoted **once** via the `ErrAsyncDispatch` sentinel (sticky — subsequent requests skip the inline check entirely). h2 routes the choice **per stream** between inline-on-event-loop and the shared h2 worker pool. The `Async` / `Sync` distinction is a no-op on the std engine, where net/http already does goroutine-per-request.

**An inline handler must not call `runtime.Goexit`.** `t.FailNow`, `t.Fatal` and `t.SkipNow` in a test's handler call it, and so do some libraries. A panic is caught (the router answers 500), but a Goexit cannot be: on epoll, io_uring and adaptive an inline handler runs on the event-loop goroutine, so a Goexit ends that loop for good. Every connection the loop owns goes unserved and its `SO_REUSEPORT` listener stops accepting. The engine logs an Error (`... ended without returning`, with the engine, the loop or worker id and the connection count) and cannot recover. A `.Async()` route's handler does not run on the loop, so the loop survives a Goexit there, but the cost depends on the protocol: on HTTP/1.1 the native engines close that connection and log an Error; on HTTP/2 the stream gets no response and no RST_STREAM, nothing is logged, and the connection stays open (the client waits for its own timeout). On HTTP/2 a stream of a sync route runs inline whether or not its request has a body, so a Goexit there ends the loop and is logged; the one exception is a connection that already holds 4 MiB of response data it could not send for the peer's window, where the stream runs on the h2 worker pool and ends silently, as an `.Async()` route's does. A request that matches no route runs its global middleware and its `NotFound` or `MethodNotAllowed` handler inline whatever the routes are marked (with `Config.AsyncHandlers` set, until a blocking run promotes them), and the `OnConnect` and `OnDisconnect` callbacks run on the loop too, as does `OnExpectContinue` unless its connection was promoted to async dispatch: none of them may call `runtime.Goexit`. The std engine runs each request on its own goroutine, so a Goexit there ends only that request's goroutine (net/http closes an HTTP/1.1 connection whose handler Goexits), not a loop.

Observe how often the inline → goroutine handoff fires via `Server.EngineInfo().Metrics.AsyncRoutes` (static count of `.Async()` routes) and `.AsyncPromotedConns` (cumulative promotions).

## Database drivers and event loops

Celeris ships first-party database drivers built on the event-loop machinery of the engines — no CGo. Which of their connections run on the server's worker loops depends on how you open them (see the table under [Busy polling](/docs/runtime-notes#busy-polling-opt-in)). They back the driver-isolation benchmarks and probatorium's driver-backed workloads.

- **[`driver/postgres`](https://github.com/goceleris/celeris/tree/main/driver/postgres)** — speaks the PostgreSQL v3 wire protocol directly. Register it as a standard `database/sql` driver, or use the lower-level worker-affinity `Pool` to skip `database/sql` overhead.
- **[`driver/redis`](https://github.com/goceleris/celeris/tree/main/driver/redis)** — RESP2 / RESP3 client (negotiates `HELLO 3` with automatic RESP2 fallback), per-worker connection pools, pub/sub, and Redis Cluster + Sentinel failover. Since v1.6.0, with `AsyncHandlers`, a pipeline or transaction whose replies are slow waits in `poll(2)` instead of Go's netpoll by default; `CELERIS_REDIS_DIRECT_WAIT=netpoll` restores the old behaviour (see [Tuning environment variables](/docs/runtime-notes#tuning-environment-variables)).
- **[`driver/memcached`](https://github.com/goceleris/celeris/tree/main/driver/memcached)** — text and binary protocols, pooled single-node clients, and a consistent-hash cluster with failover.

Pass a driver the server with its `WithEngine` option to share its loops where it can: on a started epoll, io_uring or adaptive server, PostgreSQL `Connector` connections register on the server's loops, and so do Redis Pub/Sub connections unless the server runs async handlers (then Pub/Sub uses a standalone loop of its own); the command connections of Redis and memcached and the PostgreSQL `Pool` go through Go's netpoll; before `Start`, or on the std engine, a driver uses its own standalone loop. Correctness is the same either way. See [goceleris.dev](https://goceleris.dev) for driver guides.

The drivers have no TLS stack: connect them over a trusted network (loopback, a VPC, a private link) or through a TLS sidecar. They refuse rather than silently downgrade when TLS is mandatory:
- Postgres returns `ErrSSLNotSupported` for `sslmode=require`, `verify-ca` and `verify-full`. `prefer` and `allow` connect in plaintext and print a warning.
- Redis rejects `rediss://` addresses.
- Memcached has no TLS option.

Driver-side TLS is part of [#446](https://github.com/goceleris/celeris/issues/446).

### Platform support

The drivers (and the middleware stores built on them: CSRF, JWT cache, rate limit and session stores over Redis, Postgres and memcached) run on the celeris event loop on **Linux**, which is the supported production path and the one the benchmarks measure. On macOS and the other unix hosts they run on a goroutine-per-connection fallback for development and testing.

On **Windows** the drivers and every store compile (`GOOS=windows go build ./...` and `go vet ./...` pass over the whole module), and work through the same kind of portable fallback: each connection is a `net.Conn` read by its own goroutine, with no `WithEngine` colocation, no write queue and no tuning. CI cross-compiles for windows/amd64 and windows/arm64 and runs the fallback's tests and the drivers' fake-server tests on `windows-latest` (the integration suites against real Redis, Postgres and memcached run on Linux only). Windows is not benchmarked and not a production target: deploy on Linux.

## Engine selection notes

| Engine | Platform | Use case |
|--------|----------|----------|
| `IOUring` | Linux 5.19+ | Completion-based I/O; one of the two native engines |
| `Epoll` | Linux 5.10+ | Readiness-based I/O; broadest kernel support |
| `Adaptive` | Linux 5.10+ | Starts on epoll and moves connections to io_uring on telemetry; it uses io_uring only where that is viable (kernel 6.1 or later with the fast-tier probes passing, or 6.10 or later, and enough `RLIMIT_MEMLOCK`) and stays on epoll elsewhere |
| `Std` | Any OS | Development, compatibility, non-Linux deploys |

The default is **Adaptive** on Linux and **Std** elsewhere. Prefer Adaptive unless you have a specific reason to pin an engine; on non-Linux platforms only Std is available (the native engines return an error). Neither native engine is the faster one everywhere: in the published v1.5.8 run the median io_uring-to-epoll throughput ratio was 0.99 on amd64 and 1.00 on arm64, but on the plaintext 1024-connection row io_uring led on amd64 (about 1.39 against 1.21 to 1.22 million requests per second) and the two were level on arm64 (430,146 for epoll, 421,265 for io_uring; see [Performance](/docs/results)).

io_uring needs Linux 5.19 or later: every cancel the engine submits uses the `IORING_ASYNC_CANCEL` flags that release added, and an older kernel fails each one with `-EINVAL` ([#682](https://github.com/goceleris/celeris/issues/682)). The engine checks it at startup: a kernel version before 5.19 is refused outright (a partial vendor backport can pass a single probe cancel while its other cancel forms still fail), and from 5.19 a probe cancel that the kernel answers decides. Where the kernel version is below 5.19 or the kernel rejects the flags, `IOUring` fails to start with an error that names the requirement, and `Adaptive` runs on epoll (`CELERIS_ADAPTIVE_START=iouring` included).

## Tuning environment variables

The engines read these at startup; the Redis driver reads `CELERIS_REDIS_DIRECT_WAIT` on its first pipeline or transaction. None is needed for normal operation; to run a single engine with no switching, set `Config.Engine` instead. The Stability column is the level [GOVERNANCE.md](https://github.com/goceleris/celeris/blob/main/GOVERNANCE.md#compatibility) defines: a **supported** variable keeps its name, values and effect within v1; an **experimental** one may change in a minor release, with a release note; an **unsupported** one may change or go away in any release.

| Variable | Engine | Stability | Values (default in bold) | Effect |
|----------|--------|-----------|--------------------------|--------|
| `CELERIS_ADAPTIVE_START` | Adaptive | supported | `epoll`, `iouring`, **`auto`** | Chooses the engine Adaptive **starts** on. It does not turn off runtime switching. Unrecognized values mean `auto`. `iouring` is a request: where the io_uring engine cannot be built (`CELERIS_MAX_IOURING_TIER=none`, say), Adaptive logs a `WARN` and starts on epoll. |
| `CELERIS_MAX_IOURING_TIER` | io_uring | supported | `optional`, `high`, `base`, `none` (**unset: detected tier**) | Caps the io_uring feature tier below what the kernel supports; for exercising fallback paths. Any other non-empty value, typos included, counts as `none` (an empty value is the same as unset). At `none` the io_uring engine reports io_uring as unavailable, and Adaptive's automatic choice neither starts on io_uring nor switches to it. An explicit `CELERIS_ADAPTIVE_START=iouring` still tries io_uring first: the engine refuses, Adaptive logs one `WARN` (`io_uring start engine unavailable, falling back to epoll start`) and starts on epoll, and the switch to io_uring stays off. The detected kernel version is not capped. |
| `CELERIS_IOURING_SEND_ZC` | io_uring | supported | `on`/`1`/`true`, `off`/`0`/`false`, **`auto`** | Zero-copy send. `auto` enables it where the startup probe finds SEND_ZC working; `on` cannot enable it where the probe failed. Unrecognized values mean `auto`; one is logged as a warning only where the probe finds SEND_ZC working (elsewhere the variable has no effect). |
| `CELERIS_IOURING_MULTISHOT_RECV` | io_uring | experimental | `1` (**unset: off**) | Multishot receive into a provided-buffer ring (high tier, 5.19+). Any value other than `1` leaves it off. |
| `CELERIS_IOURING_PBUF_COUNT` | io_uring | experimental | positive integer (**1024**) | Provided-buffer-ring entries per worker; used only with multishot receive. Rounded up to a power of two and clamped to 1024–32768. `0`, a negative value or a non-integer keeps the default. |
| `CELERIS_IOURING_FIXED_FILES` | io_uring | unsupported | **do not set** | Development only. Fixed-file support is incomplete ([#541](https://github.com/goceleris/celeris/issues/541)); enabling it makes connections read from unrelated descriptors. |
| `CELERIS_REDIS_DIRECT_WAIT` | Redis driver | experimental | `netpoll`, `auto`, `block` (**unset: `auto` on Linux for the pool of a server with `AsyncHandlers` and the default or a positive `PoolSize`; `netpoll` for every other pool and off Linux**) | How a Redis `Pipeline` or `Tx` `Exec` on a direct-mode connection waits for its reply. `auto` waits in `poll(2)` on the caller's thread while a connection's first-reply wait stays above 300 us and returns to Go's netpoll below 150 us; `block` always uses `poll(2)`; `netpoll` is the behaviour before v1.6.0 and the opt-out. A slow `Exec` in `poll(2)` holds one OS thread for up to 20 ms per wait. An unknown value means `netpoll`. Read on the first such `Exec`. |

Variables named `CELERIS_DEBUG_*` and `CELERIS_ADAPTIVE_DEBUG` turn on diagnostic logging and measurement probes. They are for investigating a specific problem and are unsupported: not a stable interface.

## Busy polling (opt-in)

`Config.SocketBusyPoll` sets `SO_BUSY_POLL` (the Linux per-socket NAPI busy poll) on the connections the epoll, io_uring and adaptive engines accept. It is **off by default** (`0`). Before v1.6.0 the engines set it to 50 microseconds on every accepted socket with no way to turn it off; `SocketBusyPoll: 50 * time.Microsecond` restores that. With it on, a read that finds a socket empty first runs one pass of the device's receive polling on its CPU; the engines' sockets are non-blocking, so the value only switches that on (any positive value behaves alike; a fraction of a microsecond is dropped, and a value under 1 us or a negative one fails the start). The std engine, non-Linux platforms and the unsupported io_uring fixed-files mode ignore it. The drivers follow it. `driver/redis`, `driver/postgres` and `driver/memcached` used to set 50 microseconds on the connections they register on an event loop and no longer do. Which connections those are: redis Pub/Sub connections and postgres `Connector` connections always; the command connections (redis and memcached) and the postgres `Pool` only when the driver runs on its own event loop, as this table says (a set connection is one that was on a loop in v1.5 and got 50 microseconds; the others go through Go's netpoll and were never set, and still are not). An application that used only the netpoll ones was not affected.

| Driver opened | redis commands | memcached | postgres `Pool` |
|---|---|---|---|
| no engine | loop (was set) | netpoll | netpoll |
| `WithEngine` of a server that does not run async handlers and has not started yet, or is on the std engine | loop (was set) | loop (was set) | loop (was set) |
| `WithEngine` of a started epoll, io_uring or adaptive server (the default is adaptive) | netpoll | netpoll | netpoll |
| `WithEngine` of a server that runs async handlers, started or not | netpoll | netpoll | netpoll |

Opened with `WithEngine(srv)`, the connections that are on a loop take the server's `SocketBusyPoll` (`srv.SocketBusyPoll()`), so off for the server is off for them. With no engine they are off unless `redis.WithSocketBusyPoll` or `postgres.Connector.WithSocketBusyPoll` says otherwise; memcached has no option of its own. When it is on the engine also asks for `SO_PREFER_BUSY_POLL` (only a process with `CAP_NET_ADMIN` is given it; never measured), and if the kernel refuses `SO_BUSY_POLL` it logs a Warn once.

Why it is off: it was slower on both hosts measured (one cell, 512 connections, GET, io_uring; "off" is a build of the same source with the option removed). On an arm64 big.LITTLE host with a single-queue NIC (32 runs per arm), ksoftirqd took over a loop CPU's receive processing in 5 runs with busy polling on and 0 with it off (p = 0.026), requests of 1 to 7 s occurred in 4 runs and 0 (p = 0.057, indicative), and throughput was 3.0% higher with it off; we infer, but did not observe, that the busy-polling loop captured the NIC's receive NAPI on a CPU already saturated by receive softirq. On an amd64 host with a 16-queue NIC (8 runs per arm) throughput was 1.11% higher with it off (90% CI 0.94% to 1.42%) and nothing stalled either way. See the `SocketBusyPoll` documentation for the numbers and their limits.

## Graceful shutdown: what a connection gets

What a connection gets depends on what it has sent when the shutdown begins: an idle keep-alive connection is closed at once (on io_uring, while a worker still has a response going out, at 250 ms); a request in progress is answered with `Connection: close`. A connection that has sent nothing is not answered by std, or by epoll and an io_uring worker with nothing to send, and a request it sends later is dropped there; an io_uring worker that has a response going out answers a first request that arrives in the first 250 ms. A request head that has reached the kernel but that the server has not read yet is answered on epoll, io_uring and adaptive, and dropped on std (net/http). A connection that has begun a request head and not finished it (a fragment, or a bare CRLF) counts as a request in progress on epoll and io_uring: `Shutdown` waits for it until the head completes, until `ReadHeaderTimeout` (10 s by default, from the head's first byte, or for a new connection from its accept) or `WriteTimeout` cuts it, or until the context passed to `Shutdown` is done, so a client can hold a graceful shutdown for that long and the caller's bound is the context's deadline; std closes a keep-alive connection in that state with the idle ones, and waits for a new connection's first head as for a silent one. The exact per-engine contract, with what was measured, is in the [`Server.Shutdown`](https://pkg.go.dev/github.com/goceleris/celeris#Server.Shutdown) godoc.

## Project structure

```
api/            Golden files of the exported API, checked in CI
celeristest/    Test helpers (NewContext, NewContextT, ResponseRecorder, With* options)
cmd/celeris/    CLI launcher — validation / diagnostics entrypoint (see below)
driver/         First-party event-loop database drivers (postgres, redis, memcached)
internal/       Importable only under github.com/goceleris/celeris/:
  adaptive/       Adaptive meta-engine (Linux)
  driver/         Wire codecs of the drivers (redis RESP, postgres, memcached)
  engine/         Engine interface + implementations (iouring, epoll, std)
  probe/          System capability detection (kernel version, io_uring feature probe)
  protocol/       Protocol parsers (h1, h2, detect)
  resource/       Configuration, presets, defaults
  ...             Shared internals (conn, cpumon, ctxkit, negotiate, platform, sockopts, testhooks)
magefiles/      Mage targets (build, test and release tasks)
middleware/     In-tree middleware ecosystem (46 importable packages)
observe/        Collector, CPUMonitor, Snapshot, EngineMetrics
test/           Conformance, spec compliance, integration, benchmarks (drivercmp, benchcmp_ws, benchcmp_sse)
validation/     Runtime invariant assertions + validation hooks (debug builds)
```

`cmd/celeris` is a minimal launcher around `celeris.New`, intended primarily as the entry point for validation soak runs; under the `validation` build tag it also streams assertion counters over a unix socket. Production deployments should embed `celeris.New` directly rather than depend on this binary.

## Middleware catalog (README version)

All middleware is in-tree under [`middleware/`](middleware/) — 46 importable packages: the root `middleware` package, the 36 below, and 9 store and cache sub-packages:

| Package | Description |
|---------|-------------|
| [`adapters`](https://github.com/goceleris/celeris/tree/main/middleware/adapters) | Bidirectional stdlib ↔ celeris middleware/handler conversion |
| [`basicauth`](https://github.com/goceleris/celeris/tree/main/middleware/basicauth) | HTTP Basic authentication with hashed password support |
| [`bodylimit`](https://github.com/goceleris/celeris/tree/main/middleware/bodylimit) | Request body size enforcement |
| [`cache`](https://github.com/goceleris/celeris/tree/main/middleware/cache) | HTTP response cache with singleflight + Cache-Control honoring |
| [`circuitbreaker`](https://github.com/goceleris/celeris/tree/main/middleware/circuitbreaker) | Circuit breaker (3-state, sliding-window error rate, 503 + Retry-After) |
| [`compress`](https://github.com/goceleris/celeris/tree/main/middleware/compress) | Response compression (zstd, brotli, gzip, deflate; separate go.mod) |
| [`cors`](https://github.com/goceleris/celeris/tree/main/middleware/cors) | Cross-Origin Resource Sharing (precomputed headers) |
| [`csrf`](https://github.com/goceleris/celeris/tree/main/middleware/csrf) | CSRF protection (double-submit cookie + origin validation) |
| [`debug`](https://github.com/goceleris/celeris/tree/main/middleware/debug) | Debug / introspection endpoints (loopback-only by default) |
| [`etag`](https://github.com/goceleris/celeris/tree/main/middleware/etag) | Automatic ETag generation and conditional 304 responses |
| [`healthcheck`](https://github.com/goceleris/celeris/tree/main/middleware/healthcheck) | Kubernetes-style liveness / readiness / startup probes |
| [`idempotency`](https://github.com/goceleris/celeris/tree/main/middleware/idempotency) | Idempotency-Key replay protection (in-flight 409 + cached replay) |
| [`jwt`](https://github.com/goceleris/celeris/tree/main/middleware/jwt) | JWT authentication (HMAC / RSA / ECDSA / EdDSA, JWKS auto-refresh) |
| [`keyauth`](https://github.com/goceleris/celeris/tree/main/middleware/keyauth) | API-key authentication with constant-time comparison |
| [`logger`](https://github.com/goceleris/celeris/tree/main/middleware/logger) | Structured request logging (slog, pooled-buffer FastHandler) |
| [`methodoverride`](https://github.com/goceleris/celeris/tree/main/middleware/methodoverride) | HTTP method override via header or form field |
| [`metrics`](https://github.com/goceleris/celeris/tree/main/middleware/metrics) | Prometheus metrics (separate go.mod) |
| [`otel`](https://github.com/goceleris/celeris/tree/main/middleware/otel) | OpenTelemetry tracing + metrics (separate go.mod) |
| [`overload`](https://github.com/goceleris/celeris/tree/main/middleware/overload) | 5-stage CPU + queue-depth + tail-latency-EMA overload control (503 + Retry-After) |
| [`pprof`](https://github.com/goceleris/celeris/tree/main/middleware/pprof) | Go profiling endpoints (loopback-only by default). `profile` and `trace` record for `?seconds=N` on the I/O worker that reads the connection, which serves nothing else meanwhile: mount it as an `.Async()` route (see the package documentation) |
| [`protobuf`](https://github.com/goceleris/celeris/tree/main/middleware/protobuf) | Protobuf serialization with content negotiation (separate go.mod) |
| [`proxy`](https://github.com/goceleris/celeris/tree/main/middleware/proxy) | Trusted-proxy header extraction (X-Forwarded-For, X-Real-IP) |
| [`ratelimit`](https://github.com/goceleris/celeris/tree/main/middleware/ratelimit) | Sharded token-bucket / sliding-window rate limiter (Redis / memcached store adapters) |
| [`recovery`](https://github.com/goceleris/celeris/tree/main/middleware/recovery) | Panic recovery with broken-pipe detection |
| [`redirect`](https://github.com/goceleris/celeris/tree/main/middleware/redirect) | URL redirect / rewrite (HTTPS, www, trailing slash) |
| [`requestid`](https://github.com/goceleris/celeris/tree/main/middleware/requestid) | Request-ID generation (buffered UUID v4) |
| [`rewrite`](https://github.com/goceleris/celeris/tree/main/middleware/rewrite) | Regex-based URL rewriting with capture-group support |
| [`secure`](https://github.com/goceleris/celeris/tree/main/middleware/secure) | Security headers (HSTS, CSP, COOP/CORP/COEP, OWASP defaults) |
| [`session`](https://github.com/goceleris/celeris/tree/main/middleware/session) | Cookie-based sessions on the unified [`store.KV`](https://github.com/goceleris/celeris/tree/main/middleware/store) (memory / Redis / Postgres / memcached adapters) |
| [`singleflight`](https://github.com/goceleris/celeris/tree/main/middleware/singleflight) | Request coalescing (collapse identical in-flight requests) |
| [`sse`](https://github.com/goceleris/celeris/tree/main/middleware/sse) | Server-Sent Events: heartbeat, Last-Event-ID replay, per-client slow-client policy, and a `Broker` for fan-out (see [Streaming](/docs/streaming)) |
| [`static`](https://github.com/goceleris/celeris/tree/main/middleware/static) | Static file serving with directory browse, ETag / Last-Modified caching |
| [`store`](https://github.com/goceleris/celeris/tree/main/middleware/store) | Unified in-memory `KV` (sharded, TTL eviction) shared by session / csrf / ratelimit / cache / idempotency; Redis / Postgres / memcached adapters live under the respective `session/*store` and `ratelimit/*store` subpackages |
| [`swagger`](https://github.com/goceleris/celeris/tree/main/middleware/swagger) | OpenAPI spec + Swagger UI (embedded) / Scalar / ReDoc (pinned CDN, opt-in) |
| [`timeout`](https://github.com/goceleris/celeris/tree/main/middleware/timeout) | Request timeout with cooperative and preemptive modes |
| [`websocket`](https://github.com/goceleris/celeris/tree/main/middleware/websocket) | RFC 6455 WebSocket: permessage-deflate, engine-integrated backpressure, and a `Hub` for fan-out (see [Streaming](/docs/streaming)) |

```go
import (
	"github.com/goceleris/celeris/middleware/cors"
	"github.com/goceleris/celeris/middleware/logger"
	"github.com/goceleris/celeris/middleware/recovery"
)

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(recovery.New())
s.Use(logger.New())
s.Use(cors.New())
```

Middleware with external dependencies lives in its own module — import it separately:

```go
import "github.com/goceleris/celeris/middleware/metrics" // requires prometheus
import "github.com/goceleris/celeris/middleware/otel"    // requires opentelemetry
```

## What's new in v1.6.0 (README version)

The release notes carry the same list; this is the text the README held before it was shortened.

A correctness and hardening release: most of it comes from what the [probatorium](https://github.com/goceleris/probatorium) matrix and the audits behind it found. It does not claim the open performance items listed under [Status and stability](#status-and-stability) as fixed.

**Breaking** (the [pull request of the move](https://github.com/goceleris/celeris/pull/938) lists the migrations):

- The minimum Go version is **1.27.3**.
- The engine, protocol and driver codec packages moved under `internal/` and can no longer be imported; select an engine with `Config.Engine` and read counters as `celeris.EngineMetrics` or `observe.EngineMetrics`. Every deprecated public API was removed, `basicauth.HashPassword` included.
- `Context.Stream` and the `bool` form of `Route.Async` / `RouteGroup.Async` were removed (use `StreamWriter`, `.Async()` and `.Sync()`), and `recovery`'s `ErrorHandler` now receives the recovered value as an `error`.
- `Config.MaxRequestBodySize` defaults to 4 MiB, not 100 MB.
- A handler that answers the request ends the chain, so a route that also matches a request a `Use`-mounted middleware answered no longer runs after it. `cache` and `swagger` options that defaulted to true are inverted (`DisableSingleflight`, `IgnoreCacheControl`, `DisablePKCE`). `otel` no longer records `server.address` as a metric attribute unless `MetricServerAddress` is set, and `Context.Scheme` returns only `"https"` or `"http"`. `Start*Context` returns only after the shutdown a cancel triggers.
- The global middleware (`Use`) now also runs for a request no route matches, before its 404 or 405, so a `Use`-mounted `pprof`, `debug`, `metrics` or `static` that answered 404 now serves: check its `AuthFunc`.
- `Context.File`, `FileFromDir`, `Static` and the `static` middleware answer an unsatisfiable range with 416 (it was a full 200) and honour `If-Range`.
- `swagger` serves Swagger UI from embedded assets (about 2 MB added to a binary), `RendererScalar` and `RendererReDoc` need `CDN: true` or `AssetsPath` or `New` panics, and requests under `{BasePath}/assets/` must reach the middleware.
- A failed `StartWithListener` closes the caller's listener, as `net/http`'s `Serve` does; on the adaptive engine, beside a same-user `SO_REUSEPORT` socket, `":PORT"` binds the dual-stack `[::]:PORT` where it bound IPv4 `0.0.0.0:PORT`.
- This list is the headline items; the v1.6.0 release notes list every pull request labelled `breaking`.

**Changed:** the native engines no longer set `SO_BUSY_POLL` (50 us) on the sockets they accept, and the drivers no longer set it on the connections they register on an event loop; it is opt-in through `Config.SocketBusyPoll` (`SocketBusyPoll: 50 * time.Microsecond` restores v1.5; see [Busy polling](/docs/runtime-notes#busy-polling-opt-in)). With `AsyncHandlers` and the default or a positive `PoolSize`, the Redis driver now waits for slow pipeline and transaction replies in `poll(2)` by default on Linux (opt out with `CELERIS_REDIS_DIRECT_WAIT=netpoll`; one OS thread per slow `Exec`, up to 20 ms per wait). It was measured on arm64 only (one benchmark run per wait mode, on one host: +14% to +19% requests per second against Go's netpoll, [#1275](https://github.com/goceleris/celeris/pull/1275)); no amd64 benefit is claimed, and [#854](https://github.com/goceleris/celeris/issues/854) stays open until the release build is re-verified.

**New:** an opt-in `Config.GCPercent` (see [Garbage collector target](#garbage-collector-target-opt-in)); `HEAD` is answered by the `GET` route and `OPTIONS` with an `Allow` list (`Config.DisableAutoHEAD` and `Config.DisableAutoOPTIONS` turn each off); the drivers and their stores build and run on Windows through a portable `net.Conn` fallback; `api/` golden files make every API change visible in review; on big.LITTLE arm64 hosts the engines pin one loop per non-little CPU (see [CPU pinning](/docs/cpu-pinning)).

**Fixed:** the io_uring teardown, transplant and driver paths and the epoll shutdown and park paths were audited and corrected; the native HTTP/2 connection bounds refusals, PRIORITY placeholders, header-block fragments and frame sizes; a detached connection whose peer takes none of its bytes is closed after `WriteTimeout`; the std engine no longer cuts an SSE stream at its timeouts, and `EnableH2Upgrade` means the same on every engine; `basicauth` hashes passwords with a salted PBKDF2.

## Streaming and detach on the std engine

`StreamWriter()` performs synchronous incremental writes on every engine. Async `Detach()` — keeping the connection alive after the handler returns — is native-engines-only (`EngineSupportsAsyncDetach()` is false on std, which closes the conn when the handler returns).
