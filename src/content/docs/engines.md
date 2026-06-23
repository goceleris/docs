---
title: Engines and the I/O model
description: io_uring, epoll, the adaptive controller, the std fallback, and how the engine relates to protocol and async dispatch.
group: Reference
order: 2
---

The **engine** is the part of Celeris that owns the listening socket, accepts
connections, and pumps bytes between the network and your handlers. It is purely
an I/O strategy: every engine speaks the same HTTP, runs the same router, and
hands you the same `*celeris.Context`. What changes between engines is *how* the
kernel is asked to do I/O — and on the right kernel that difference is the
difference between good and exceptional throughput.

You select an engine with one field, `Config.Engine` (`celeris/config.go:69`). The
zero value is the right answer on almost every box: **Adaptive on Linux, Std
everywhere else** (`celeris/resource/config.go:13-19`). This page explains the four
engines, the adaptive controller that picks between them, how the engine relates
to protocol and to async dispatch, and the introspection surface for observing it
all at runtime.

```go
// The default: no Engine field → Adaptive on Linux, Std off Linux.
s := celeris.New(celeris.Config{Addr: ":8080"})

// Or force one explicitly.
s := celeris.New(celeris.Config{Addr: ":8080", Engine: celeris.IOUring})
```

## The four engines

Celeris ships four engine implementations, exposed as the `EngineType` constants
in `celeris/config.go:29-38`.

| Engine                 | Constant            | Where it runs        | What it is                                                                 |
| ---------------------- | ------------------- | -------------------- | ------------------------------------------------------------------------- |
| **Adaptive** (default) | `celeris.Adaptive`  | Linux only           | Runs epoll and io_uring behind one socket; switches based on live load.    |
| **Epoll**              | `celeris.Epoll`     | Linux only           | Edge-triggered epoll, per-core event loops, CPU pinning.                    |
| **IOUring**            | `celeris.IOUring`   | Linux 5.10+          | Completion-based async I/O via io_uring. The lowest-latency path.           |
| **Std**                | `celeris.Std`       | Everywhere           | Wraps Go's `net/http`. The portable fallback.                              |

### Adaptive — the default on Linux

Adaptive runs **both** the epoll and io_uring sub-engines behind the same listening
socket, scores them on live telemetry, and switches the active engine when the
standby is meaningfully better for the current workload. You get the best engine
for the box and the moment without choosing. See [The adaptive
controller](#the-adaptive-controller) below for the signals it uses.

Because connections cannot migrate between epoll and io_uring once accepted, the
*start* engine matters for long-lived keep-alive throughput. By default Adaptive
**starts on epoll** (best for the ramp-from-zero, low-concurrency, latency case)
and promotes *new* connections to io_uring under sustained high load. The only way
to make it start on io_uring is the `WorkloadHint` (see below).

### Epoll

Edge-triggered `epoll` with per-core event loops and CPU pinning. Available on any
modern Linux (epoll predates all supported kernels) and the safest native choice
when io_uring is unavailable or you want to pin behaviour. Epoll is at throughput
parity with io_uring for most request/response workloads — you are not trading
latency for compatibility by choosing it. Epoll is also the engine that implements
zero-copy `sendfile(2)` for static-file responses (`celeris/engine/engine.go:46-72`,
`celeris/engine/capability.go:38-44`).

### IOUring

Completion-based asynchronous I/O on Linux **5.10+**. Celeris detects the io_uring
feature *tier* at startup and enables only what the running kernel supports
(`celeris/engine/tier.go`):

| Tier         | Kernel    | Features enabled                                                                |
| ------------ | --------- | ------------------------------------------------------------------------------- |
| `Base`       | 5.10+     | LTS-stable baseline: linked SQE chains, single-shot accept/recv                  |
| `High`       | 5.19+     | Multishot accept/recv, provided buffer rings, fixed files, COOP_TASKRUN          |
| `Optional`   | 6.0+      | Adds SQPOLL and zero-copy send (`SEND_ZC`); 6.1+ swaps in DEFER_TASKRUN          |

You do not configure the tier — it is probed and applied automatically. A 5.12
kernel transparently uses the `Base` feature set; a 6.1 kernel lights up the full
`Optional` set. io_uring requires `RLIMIT_MEMLOCK` headroom for its rings and
provided buffers — see [Engine selection in practice](#engine-selection-in-practice).

### Std — the portable fallback

Std wraps Go's `net/http` server. The router, middleware, and `*Context` API are
**identical** to the native engines; what you lose are the native fast paths (CPU
pinning, zero-copy sendfile, engine-integrated WebSocket, the async-detach
machinery). Std is the default and the only engine off Linux (macOS, Windows), and
it is what you run in tests on a dev laptop. On a pre-5.10 Linux kernel you still
get epoll — only io_uring needs 5.10+, and Adaptive falls back to epoll there.

### Native engines are Linux-only — and selecting one off-Linux is an error

io_uring, epoll, and adaptive depend on Linux kernel facilities, so they cannot run
elsewhere. The distinction worth internalising:

- **Leaving `Engine` unset off Linux silently selects Std.** The default resolves
  per-platform (`celeris/resource/config.go:13-19`). This is the intended fallback —
  your code runs unchanged on a Mac.
- **Explicitly setting a native engine off Linux is a validation error.** It is
  *not* silently downgraded. `Config.Validate` returns `engine <name> requires
  Linux` (`celeris/resource/config.go:138-145`), and `Start` surfaces it as a
  `config validation` error before binding the socket (`celeris/server.go:571-573`).

```go
// On macOS: this returns a non-nil error from Start, it does NOT fall back.
s := celeris.New(celeris.Config{Addr: ":8080", Engine: celeris.IOUring})
if err := s.Start(); err != nil {
    // "config validation: engine io_uring requires Linux"
    log.Fatal(err)
}
```

The takeaway: write `Engine: celeris.IOUring` only in a Linux-only deployment, or
guard it behind `runtime.GOOS == "linux"`. For portable code, leave `Engine` unset
and let Adaptive/Std resolve automatically.

### Feature matrix

| Feature                       | io_uring     | epoll | std |
| ----------------------------- | :----------: | :---: | :-: |
| HTTP/1.1                      | Yes          | Yes   | Yes |
| h2c (HTTP/2 cleartext)        | Yes          | Yes   | Yes |
| h2c upgrade (`Upgrade: h2c`)  | Yes          | Yes   | Yes |
| CPU pinning                   | Yes          | Yes   | —   |
| Multishot accept/recv         | Yes (5.19+)  | —     | —   |
| Provided buffer rings         | Yes (5.19+)  | —     | —   |
| Zero-copy `sendfile`          | —            | Yes   | —   |
| Async dispatch (`.Async()`)   | Yes          | Yes   | Yes |
| Async-detach (SSE / WS)       | Yes          | Yes   | —   |
| Accept control (Pause/Resume) | Yes          | Yes   | —   |
| Driver event-loop colocation  | Yes          | Yes   | —   |

Sources: `celeris/engine/capability.go`, `celeris/engine/engine.go:46-72`,
`celeris/server.go:446-539`, `celeris/context_response.go:1357-1380`.

## The adaptive controller

The adaptive engine does not guess from configuration — it watches the live
`EngineMetrics` counters and derives load signals from them. The counters it reads
are documented field-by-field in `celeris/engine/engine.go:85-132`; the signals it
builds from them are:

| Signal                  | Derived from                                  | What it tells the controller                                              |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| **Conns per worker**    | `ActiveConnections / Workers`                 | Keep-alive concurrency pressure — the primary io_uring-vs-epoll signal.   |
| **Accept rate**         | `AcceptCount` over time                        | New-connection arrival rate.                                              |
| **Close rate**          | `CloseCount` over time                          | A high close-vs-accept ratio means short-lived "churn" connections.       |
| **Bytes per request**   | `(BytesRead + BytesWritten) / RequestCount`   | Large-payload / link-bound traffic, where io_uring offers no edge.         |

It uses these to keep the *active* engine matched to the workload, and to decide
which engine *new* connections are promoted onto. Switching is damped against
oscillation — after rapid flips the controller briefly locks the active engine so a
borderline workload does not thrash.

### `WorkloadHint` — picking the start engine

Because a connection cannot migrate between epoll and io_uring, the **start**
engine fixes the keep-alive throughput ceiling for connections opened early — and
the steady-state concurrency is unknowable when the server binds. `WorkloadHint`
(`celeris/config.go:43-60`) is the *only* way to influence that start decision. It
affects **nothing but the Adaptive engine's start choice**; on Epoll, IOUring, and
Std it is ignored.

| Hint                               | Start engine | Use when                                                      |
| ---------------------------------- | ------------ | ------------------------------------------------------------- |
| `WorkloadUnspecified` (default)    | epoll        | You don't know; ramp-from-zero / mixed / latency-sensitive.   |
| `WorkloadLowConcurrency`           | epoll        | Thin, latency-sensitive traffic; stay on epoll.               |
| `WorkloadHighConcurrency`          | io_uring     | Many H1 keep-alive conns per worker from the first second.    |

```go
// A service that knows it serves thousands of long-lived keep-alive conns:
// start Adaptive directly on io_uring instead of ramping up from epoll.
s := celeris.New(celeris.Config{
    Addr:         ":8080",
    Engine:       celeris.Adaptive, // (the default; shown for clarity)
    WorkloadHint: celeris.WorkloadHighConcurrency,
})
```

`WorkloadHighConcurrency` starts on io_uring **only when the kernel and
`RLIMIT_MEMLOCK` allow it** (`celeris/config.go:57-59`). If io_uring is unavailable,
Adaptive falls back to starting on epoll.

### Observing switches with `EngineSwitches`

Every time the adaptive controller changes strategy it increments a counter you can
read from the metrics collector. `Server.Collector().Snapshot()` returns a
`Snapshot` whose `EngineSwitches` field counts the switches since start
(`celeris/observe/collector.go:40-57`).

```go
snap := s.Collector().Snapshot()
log.Printf("adaptive engine has switched %d times", snap.EngineSwitches)
```

A switch count that climbs steadily under steady traffic suggests a workload
sitting right on a decision boundary; a count that settles is the controller having
found a stable engine. (If `Config.DisableMetrics` is true, `Collector()` returns
nil — guard for that.)

## Protocol and engine are independent

A frequent confusion is treating the engine as a protocol selector. It is not. The
engine is an **I/O strategy**; the protocol is set separately with `Config.Protocol`
(`celeris/config.go:14-21`). **All four engines support the same protocol surface:**

- **HTTP/1.1** and **h2c** (HTTP/2 cleartext), with `Protocol: celeris.Auto`
  (the default) auto-detecting between them per connection.
- **`Upgrade: h2c`** promotion of an H1 connection to cleartext H2, controlled by
  `Config.EnableH2Upgrade` (`celeris/config.go:200-211`), independent of engine.

```go
s := celeris.New(celeris.Config{
    Addr:     ":8080",
    Protocol: celeris.Auto,    // H1 + h2c auto-detect — works on every engine
    Engine:   celeris.Adaptive,
})
```

What every engine deliberately does **not** do is terminate TLS. Celeris is
**cleartext only** — there is no ALPN and no TLS handshake in any engine. HTTPS and
HTTP/2-over-TLS (h2) are expected to be terminated upstream (a load balancer,
reverse proxy, or service mesh) that forwards cleartext to Celeris. This is a design
choice, not an engine limitation — see [Deployment & TLS](/docs/deployment).

## How async dispatch interacts with the engine

The engine decides *where your handler runs*, and that is the single most important
thing to understand about performance.

By default a handler runs **inline on the I/O worker** — the same `LockOSThread`'d
goroutine that drives `epoll_wait` / `io_uring_enter`. That is ideal for CPU- or
cache-bound work: zero handoff, maximum locality. But if such a handler makes a
**blocking** call (a database round-trip, an upstream HTTP request, a file read),
it stalls the event loop and every other connection that worker owns.

The fix is **async dispatch**: the handler runs on a spawned per-connection
goroutine while the worker returns immediately to the event loop. This trades the
per-worker serialization ceiling (`Workers × 1/RTT`) for goroutine-per-connection
parallelism, which is exactly `net/http`'s model. The cost is a goroutine spawn
(~100ns) plus scheduler overhead per request — a measured ~3–5% regression on a
pure static-response benchmark (`celeris/config.go:138-177`).

You control this at three levels (most-specific wins): **route > group > server
default**.

```go
// Server-level default off; mark only the routes that block.
s := celeris.New(celeris.Config{Addr: ":8080", AsyncHandlers: false})

s.GET("/healthz", healthHandler)            // inline on the worker (CPU-bound)
s.GET("/db", dbHandler).Async()             // spawned goroutine (blocking I/O)
s.GET("/users/:id", getUser).UsesDriver()   // same as .Async(), signals driver use
```

The per-route knobs (`.Async()`, `.Sync()`, `.UsesDriver()`) live on the `*Route`
handle and are covered in [Routing](/docs/routing#dispatch-mode-async-sync-usesdriver).
`Config.AsyncHandlers` is the server-wide default they override.

### Async-detach: the part that depends on the engine

Inline-vs-goroutine dispatch works on every engine, including Std. **Async-detach
does not.** Detach is what lets a handler *return* while a connection stays alive
and a background goroutine keeps writing to it — the foundation of Server-Sent
Events, WebSocket, and long-lived chunked streams. The native engines (epoll,
io_uring) have the machinery to keep a detached connection open and flush writes
from another goroutine; the **std engine does not** — `net/http` treats the
response as finished the moment the handler returns and may close the connection
underneath a still-running goroutine.

Celeris exposes this difference so streaming middleware can adapt rather than break.
`Context.EngineSupportsAsyncDetach()` reports whether the active engine can keep the
connection alive after the handler returns
(`celeris/context_response.go:1357-1380`):

```go
func streamHandler(c *celeris.Context) error {
    sw := c.StreamWriter()
    if sw == nil {
        return celeris.NewHTTPError(500, "streaming not supported")
    }
    _ = sw.WriteHeader(200, [][2]string{{"Content-Type", "text/event-stream"}})

    if c.EngineSupportsAsyncDetach() {
        // Native engine: detach, drive the stream from a goroutine, return now.
        done := c.Detach()
        go func() {
            defer done()       // MUST be called or the Context leaks from the pool
            driveStream(sw)    // write + Flush() over the lifetime of the stream
        }()
        return nil
    }

    // Std engine: the goroutine must finish before the handler returns.
    driveStream(sw)
    return nil
}
```

The `StreamWriter` API (`WriteHeader`, `Write`, `Flush`, `Close`, `BytesWritten`)
and the `Detach`/`done()` lifecycle are documented in full on
[Streaming responses](/docs/streaming). The built-in
[SSE](/docs/sse) and [WebSocket](/docs/websocket) middleware already consult
`EngineSupportsAsyncDetach` for you — you only touch this directly when you write
your own streaming transport.

> WebSocket has a deeper engine integration than SSE: native engines provide an
> *engine-integrated* upgrade path (`UpgradeWebSocket`, `WSReadPauser`,
> `WSRawWriteFn`) with TCP-level backpressure; on Std these return false/nil and the
> middleware falls back to `Context.Hijack` (`celeris/context_response.go:1252-1344`).
> The middleware handles this fallback transparently.

## Engine selection in practice

For nearly all deployments, **leave `Engine` unset.** Adaptive picks the right
native engine on Linux and Std is selected automatically off Linux. Reach for an
explicit choice only when you have a specific reason:

| You want…                                                         | Set                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| The best engine, auto-selected (recommended)                      | *(leave `Engine` unset)*                               |
| Deterministic behaviour / no runtime switching                    | `Engine: celeris.Epoll`                                |
| Lowest latency on a known-good 5.10+ kernel, willing to tune memlock | `Engine: celeris.IOUring`                           |
| Adaptive, but start hot on io_uring under known high concurrency  | `Engine: celeris.Adaptive` + `WorkloadHint: …HighConcurrency` |
| Portability / dev laptop / off Linux                              | `Engine: celeris.Std` *(or just leave unset off Linux)* |
| Pre-5.10 Linux kernel (no io_uring, but epoll works)              | *(leave `Engine` unset → Adaptive falls back to epoll)*, or `Engine: celeris.Epoll` |

A few practical notes:

- **Force `Epoll`** when you want a single, predictable engine and io_uring's
  kernel/memlock requirements are awkward (containers with tight `RLIMIT_MEMLOCK`,
  conservative security policies). Epoll is at throughput parity for most
  request/response traffic and is the engine with zero-copy `sendfile`.
- **Force `IOUring`** when you have validated the kernel (≥5.10, ideally ≥5.19 or
  ≥6.0 for the full feature tier) and the latency win matters. io_uring allocates
  locked memory for its rings and provided-buffer pools, so raise the process
  `RLIMIT_MEMLOCK` (e.g. `LimitMEMLOCK=infinity` in a systemd unit, or
  `--ulimit memlock=-1:-1` for a container). If memlock is too low, io_uring setup
  fails — under Adaptive this means it never starts on / promotes to io_uring.
- **Tune workers and buffers** with `Config.Workers` (default `GOMAXPROCS`),
  `Config.BufferSize` (per-connection I/O buffer; `0` = engine default), and the
  socket options `Config.SocketRecvBuf` / `Config.SocketSendBuf` (`SO_RCVBUF` /
  `SO_SNDBUF`; `0` = OS default). `Config.MaxConns` caps simultaneous connections
  per worker. All are in `celeris/config.go:71-131`. The full config reference is on
  [Configuration](/docs/configuration).

```go
// A latency-tuned io_uring deployment on a validated 6.x kernel.
s := celeris.New(celeris.Config{
    Addr:          ":8080",
    Engine:        celeris.IOUring,
    Workers:       12,        // match physical cores; default is GOMAXPROCS
    BufferSize:    16 * 1024, // per-conn I/O buffer
    SocketSendBuf: 256 * 1024,
})
// Remember: raise RLIMIT_MEMLOCK for the process (systemd LimitMEMLOCK / --ulimit).
```

## Introspection

The running engine exposes a read-only surface for observability and control.

### `EngineInfo` and `EngineType`

`Server.EngineInfo()` returns the active engine's type and a metrics snapshot, or
`nil` before `Start` (`celeris/server.go:499-509`). On Adaptive, `Type` reflects the
engine that is *currently active*, so you can see which sub-engine the controller
has selected.

```go
if info := s.EngineInfo(); info != nil {
    log.Printf("active engine: %s", info.Type)        // e.g. "io_uring" / "epoll"
    log.Printf("active conns:  %d", info.Metrics.ActiveConnections)
}
```

`EngineInfo` is a struct with two fields (`celeris/config.go:217-223`):

| Field     | Type            | Description                                       |
| --------- | --------------- | ------------------------------------------------- |
| `Type`    | `EngineType`    | The active engine (`Adaptive`, `Epoll`, …).       |
| `Metrics` | `EngineMetrics` | A point-in-time snapshot of the counters below.    |

`EngineType` has a `String()` method that returns `"io_uring"`, `"epoll"`,
`"adaptive"`, or `"std"` (`celeris/engine/enginetype.go:20-33`).

### `EngineMetrics` fields

`EngineMetrics` (`celeris/engine/engine.go:85-132`) is a snapshot of the engine's
own atomic counters, fetched fresh on each `Metrics()` / `EngineInfo()` call:

| Field                | Type      | Meaning                                                                       |
| -------------------- | --------- | ----------------------------------------------------------------------------- |
| `RequestCount`       | `uint64`  | Cumulative requests handled by this engine.                                    |
| `ActiveConnections`  | `int64`   | Currently open connections.                                                    |
| `ErrorCount`         | `uint64`  | Cumulative connection-level or protocol errors.                                |
| `Throughput`         | `float64` | Recent requests-per-second rate.                                               |
| `Workers`            | `int`     | I/O workers (io_uring) or event loops (epoll). Static after `Start`.            |
| `AsyncRoutes`        | `int`     | Count of routes registered `.Async(true)`. Static after `Start`; diagnostics.  |
| `AsyncPromotedConns` | `uint64`  | Cumulative inline→goroutine promotions via per-handler async.                   |
| `AcceptCount`        | `uint64`  | Cumulative connections accepted since start.                                    |
| `CloseCount`         | `uint64`  | Cumulative connections closed since start. `Accept − Close` = live count.       |
| `BytesRead`          | `uint64`  | Cumulative payload bytes received across all connections.                       |
| `BytesWritten`       | `uint64`  | Cumulative payload bytes sent across all connections.                           |

These are the same counters the adaptive controller reads to derive its load
signals (see [The adaptive controller](#the-adaptive-controller)). They are also
re-exported on the metrics `Snapshot` as `EngineMetrics`, alongside `RequestsTotal`,
`ErrorsTotal`, `ActiveConns`, `EngineSwitches`, latency buckets, and CPU
utilisation (`celeris/observe/collector.go:40-57`).

```go
m := s.EngineInfo().Metrics
if m.RequestCount > 0 {
    avgBytes := float64(m.BytesRead+m.BytesWritten) / float64(m.RequestCount)
    log.Printf("rps=%.0f conns=%d avg-bytes/req=%.0f promotions=%d",
        m.Throughput, m.ActiveConnections, avgBytes, m.AsyncPromotedConns)
}
```

### `PauseAccept` / `ResumeAccept`

To stop accepting new connections while continuing to serve existing ones — useful
for graceful load shedding or coordinated draining — call `Server.PauseAccept()`
and later `Server.ResumeAccept()` (`celeris/server.go:511-539`). These work on the
native engines. The **std engine does not support accept control**: both return
`celeris.ErrAcceptControlNotSupported` (`celeris/errors.go:29-31`), as does calling
them before `Start`.

```go
if err := s.PauseAccept(); err != nil {
    if errors.Is(err, celeris.ErrAcceptControlNotSupported) {
        // std engine (or not started) — fall back to your own shedding strategy
    }
}
// ... drain / shed ...
_ = s.ResumeAccept()
```

### `EventLoopProvider` — driver colocation

`Server.EventLoopProvider()` returns the engine's per-worker event-loop provider,
or `nil` if the engine does not expose one — which is the case for the **std**
fallback (`celeris/server.go:441-455`). This is the integration point that lets
Celeris database and cache drivers register their own sockets on the *same* worker
event loops as the HTTP path, so a DB round-trip is driven by the very thread that
owns the request's connection — no cross-thread handoff, NUMA-local buffers.

The provider exposes `NumWorkers()` and `WorkerLoop(n)`; the per-worker
`WorkerLoop` surface (`RegisterConn`, `UnregisterConn`, `Write`, `CPUID`) is
documented in `celeris/engine/provider.go:32-84`. You normally don't call this
yourself — a Celeris driver opened `WithEngine(srv)` consumes it for you. When the
provider is `nil` (std engine), drivers fall back to a standalone mini event loop.

```go
if p := s.EventLoopProvider(); p != nil {
    log.Printf("engine exposes %d worker loops for driver colocation", p.NumWorkers())
} else {
    log.Print("std engine: drivers use the standalone fallback loop")
}
```

> For drivers to pick their fast netpoll-park path, the server's *effective* async
> state must be on (server `AsyncHandlers: true`, or routes marked `.Async()` /
> `.UsesDriver()` registered **before** the driver is opened). `Server.AsyncHandlers()`
> reports the effective state (`celeris/server.go:457-497`). See
> [Routing](/docs/routing#dispatch-mode-async-sync-usesdriver) for the ordering rule.

## Common pitfalls

- **Setting a native engine off Linux is a hard error, not a fallback.** `Engine:
  celeris.IOUring` on macOS makes `Start` return `config validation: engine io_uring
  requires Linux`. Leave `Engine` unset for portable code, or guard it with
  `runtime.GOOS`.
- **Expecting `WorkloadHint` to do something on a non-adaptive engine.** It *only*
  influences Adaptive's start choice. On Epoll/IOUring/Std it is inert.
- **Treating the engine as a protocol switch.** Protocol (`Config.Protocol`) and
  engine (`Config.Engine`) are orthogonal — every engine speaks H1 + h2c.
- **Streaming on the std engine without finishing before return.** On Std,
  `EngineSupportsAsyncDetach()` is false; a goroutine you spawn must complete before
  the handler returns, or `net/http` closes the connection out from under it.
- **`PauseAccept`/`ResumeAccept` on std.** They return
  `ErrAcceptControlNotSupported` — always check the error with `errors.Is`.
- **Forgetting `RLIMIT_MEMLOCK` for io_uring.** Too-low memlock prevents io_uring
  setup; under Adaptive this silently keeps you on epoll, under a forced `IOUring`
  it fails to start.
- **Forgetting to call `done()` after `Detach`.** The returned function *must* run
  (typically `defer done()` in the streaming goroutine) or the `*Context` leaks from
  its pool permanently (`celeris/context_response.go:1382-1431`).

## FAQ

**Which engine do I get if I don't set one?**
Adaptive on Linux, Std on every other platform. That's the right default for almost
everyone.

**Does forcing `Epoll` cost me throughput versus io_uring?**
For typical request/response workloads, no — they are at parity. io_uring's edge is
in latency and under very high keep-alive concurrency. Epoll additionally has the
zero-copy `sendfile` path for static files.

**Can I see which sub-engine Adaptive is currently using?**
Yes — `EngineInfo().Type` reflects the *active* engine, and
`Collector().Snapshot().EngineSwitches` counts how many times it has switched.

**Will my code change between engines?**
No. The router, middleware, `*Context`, and handler signature are identical on all
four. The only engine-visible behavioural differences are the native-only features
(async-detach, accept control, driver colocation, sendfile) — and Celeris exposes
runtime predicates (`EngineSupportsAsyncDetach`, the `ErrAcceptControlNotSupported`
sentinel, a `nil` `EventLoopProvider`) so portable code can adapt cleanly.

**Is there TLS in any engine?**
No. Celeris is cleartext-only by design; terminate TLS upstream. See
[Deployment & TLS](/docs/deployment).

## See also

- [Configuration](/docs/configuration) — every `Config` field, including `Engine`,
  `WorkloadHint`, `Workers`, `BufferSize`, and the socket options.
- [Routing](/docs/routing#dispatch-mode-async-sync-usesdriver) — the `.Async()` /
  `.Sync()` / `.UsesDriver()` dispatch knobs and the driver-ordering rule.
- [Streaming responses](/docs/streaming) — `StreamWriter`, `Detach`/`done()`, and
  hijacking, the consumers of async-detach.
- [Server-Sent Events](/docs/sse) and [WebSocket](/docs/websocket) — middleware
  built on the engine's async-detach and engine-integrated upgrade paths.
- [Deployment & TLS](/docs/deployment) — terminating TLS upstream and running
  Celeris behind a proxy.
