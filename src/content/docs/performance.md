---
title: Performance and high load
description: Get the most throughput, keep the hot path allocation-free, choose sync vs async, and survive extreme load.
group: Operations
order: 4
---

Celeris is built so that a well-written handler does almost no work the framework
can avoid: the request `Context` is pooled and recycled, the JSON encoder has a
reflection-free fast path, and the request body and headers are handed to you as
views over engine-owned buffers rather than fresh copies. The performance you get
is mostly a function of two things — **keeping the hot path allocation-free** and
**dispatching blocking work off the I/O worker** — plus a layer of defenses for
when the load is more than you can serve.

This page is the operations playbook: the rules that keep the fast path fast, how
to tune sync vs async dispatch, the engine and worker knobs, connection lifetime,
the middleware that keeps you alive under extreme load, colocating drivers for
I/O-bound throughput, and how to measure all of it.

## The zero-allocation hot path

Every request reuses a pooled `*Context`. The framework hands you views into
engine-owned buffers (the body, the headers) instead of copying them, so a handler
that reads a few values and writes a JSON response can run with **zero heap
allocations of its own**. The catch is that those views are only valid *during the
handler*: the moment you return, the `Context` and its backing buffers are recycled
for the next request. Retain a reference and you'll read another request's data.

### The rules that keep it fast

**Don't retain the `Context` after the handler returns.** `Context` objects are
pooled and recycled between requests. Copy any value you need before returning;
never stash a `*celeris.Context` in a struct, a closure, or a goroutine. From
`celeris/doc.go`:

> Do not retain a `*Context` after the handler returns; use `Context.BodyCopy` to keep body bytes alive.

**`Body()` is a view; `BodyCopy()` is yours.** `c.Body()` returns the raw request
body as a slice over the engine's buffer — fast, zero-copy, but invalid the instant
the handler returns and **must not be modified**. If the bytes have to outlive the
request (you pass them to a goroutine, an async pipeline, or a log sink), take a
copy with `c.BodyCopy()` (`celeris/context_request.go:279-296`):

```go
s.POST("/ingest", func(c *celeris.Context) error {
    raw := c.Body()        // zero-copy view — valid only inside this handler
    process(raw)           // ✅ fine: synchronous, done before return

    safe := c.BodyCopy()   // heap copy — safe to keep
    go archive(safe)       // ✅ fine: copy outlives the handler

    // go archive(raw)     // ❌ BUG: raw is recycled when this handler returns
    return c.NoContent(202)
})
```

`BodyCopy()` returns `nil` (not an empty non-nil slice) when the body is empty, so
it's the only allocation on the request path when you use it — reach for it
deliberately, not by reflex.

**Prefer `FullPath()` for metric and log labels.** `c.FullPath()` returns the
**matched route pattern** (`/users/:id`), not the concrete request path
(`/users/42`) — see `celeris/context_request.go:38`. Using the raw path as a metric
label explodes cardinality (one time series per id); the pattern keeps it bounded:

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    metrics.Inc("http_requests_total", c.FullPath()) // "/users/:id", bounded
    return c.JSON(200, lookup(c.Param("id")))
})
```

`FullPath()` returns `""` when no route matched (e.g. inside a custom `NotFound`
handler).

**Let the JSON fast path do its job.** `c.JSON` has a reflection-free encoder for
small maps and primitive types that emits byte-identical output to the standard
library while skipping the reflection machinery
(`celeris/context_response.go:84-132`). You don't enable anything — it's automatic.
The practical takeaway is that returning a small `map[string]string` or a flat
struct from a handler is genuinely cheap; you do not need to hand-roll byte buffers
to be fast.

**Lowercase your header keys when you set them.** Programmatic header writes hit an
inline fast path when the key is already lowercase
(`celeris/context_response.go:637`). Writing `c.SetHeader("content-type", …)`
avoids a normalization step that `c.SetHeader("Content-Type", …)` would incur.

### Common pitfalls

- **Capturing `c` in a goroutine.** `go func() { use(c) }()` is a use-after-free
  once the handler returns. Copy the values you need (and `BodyCopy()` the body)
  *before* spawning. The one sanctioned long-lived flow is `Context.Detach`, whose
  returned `done` function **must** be called or the `Context` leaks from the pool
  permanently (`celeris/context_response.go`, the `Detach` method doc).
- **Modifying `Body()` in place.** It aliases an engine buffer; mutating it
  corrupts the read state. Copy first if you need a mutable buffer.
- **Using the raw path for labels.** `c.Path()` is the concrete path and is correct
  for logging a single request, but it is the wrong choice for aggregated metrics —
  use `c.FullPath()` there.

## Sync vs async dispatch tuning

By default every handler runs **inline on the I/O worker** — the lowest-latency
path, with zero handoff. That is exactly what you want for CPU- or cache-bound
work. But a handler that *blocks* (a database round-trip, an upstream HTTP call, a
file read) blocks the worker, and a worker that's blocked can't drive its other
connections. The fix is to dispatch blocking handlers to a per-connection goroutine
so the worker returns to `epoll_wait` / `io_uring_enter` while the handler waits.

### The three levers

The dispatch mode is resolved **route > group > server default**, where the server
default is `Config.AsyncHandlers` (`celeris/config.go:159-198`, `celeris/router.go:205-302`):

| Lever | Where | Effect |
| --- | --- | --- |
| `Config.AsyncHandlers bool` | server | The default for every route. `false` = inline (default); `true` = dispatch to a goroutine. |
| `RouteGroup.Async()` / `.Sync()` | group | Flip the default for all routes added to the group afterward. |
| `Route.Async()` / `.Sync()` / `.UsesDriver()` | route | Most-specific wins; overrides group and server. |

```go
s := celeris.New(celeris.Config{Addr: ":8080"}) // AsyncHandlers false (default)

s.GET("/healthz", healthHandler)              // inline on worker (CPU-cheap)
s.GET("/db", dbHandler).Async()               // blocking I/O → goroutine
s.GET("/users/:id", getUser).UsesDriver()     // celeris driver round-trip → goroutine

api := s.Group("/api").Async()                // async for everything added next…
api.GET("/products", productHandler)          // async (from group)
api.GET("/cached", cachedHandler).Sync()      // …opt this one back to inline
```

`.UsesDriver()` is exactly `.Async()`, but it documents intent at the call site:
*this route calls a Celeris postgres/redis/memcached driver*
(`celeris/router.go:244-258`). On the `Std` (net/http) engine the per-route flag is
a no-op — net/http already runs a goroutine per request.

> **Safety.** Never call `.Sync()` (or `.Async(false)`) on a handler that hijacks
> or detaches the connection — WebSocket upgrades and SSE streams run async by
> construction and the flag cannot downgrade them (`celeris/router.go:236-242`).

### The ~3–5% async overhead, and when to pay it

Async dispatch costs a goroutine spawn per request (~100 ns) plus scheduler
overhead. On a pure-CPU static-response benchmark that measures as a **~3–5%
regression** (`celeris/config.go:174`). So the rule is simple:

- **CPU-only, latency-critical routes** → keep them inline (`Sync`, the default).
- **Anything that touches a DB, cache, or upstream service** → mark it async, so
  the worker isn't stalled waiting on the network.

When `AsyncHandlers` is `true`, the per-worker serialization ceiling
(`NumWorkers × 1/RTT`) is replaced by goroutine-per-connection parallelism that
matches net/http's concurrency model (`celeris/config.go:159-166`).

### Adaptive auto-promotion (and why fast driver calls need `UsesDriver`)

Setting `Config.AsyncHandlers = true` also turns on an **adaptive safety net**: any
*unmarked* handler that runs slower than **~300 µs** is auto-promoted to the
goroutine path, while routes that stay fast settle back to a zero-cost inline path
after a short learning phase (`celeris/config.go:193-196`,
`celeris/router.go:253-255`).

This is why a **fast localhost driver call needs an explicit `.UsesDriver()` /
`.Async()`**: a colocated Redis or Postgres round-trip on the loopback can complete
in *under* 300 µs, so the adaptive net never promotes it — and it would block a
worker on every request. Mark driver routes explicitly and you guarantee they're
dispatched off the worker regardless of how fast the backend answers
(`celeris/router.go:253-258`).

> **Driver fast path.** Celeris drivers opened `WithEngine(srv)` pick their
> netpoll-park fast path from the server's *effective* async state — true when
> `AsyncHandlers` is set **or** any route is `.Async()`. If you keep
> `AsyncHandlers` false and rely on per-route marks, **open the driver after those
> routes are registered** (the effective state is read at driver construction);
> otherwise set `AsyncHandlers = true` (`celeris/config.go:167-178`). See
> [Stores and database drivers](/docs/data-stores).

### Watching the handoff: `AsyncPromotedConns`

The engine exposes how often the inline → goroutine handoff actually fires.
`EngineMetrics.AsyncPromotedConns` is the cumulative count of connections promoted
to the per-conn dispatch goroutine (`celeris/engine/engine.go:101-108`), and
`EngineMetrics.AsyncRoutes` reports how many routes are registered async
(`celeris/engine/engine.go:94-100`). Read them off the running server:

```go
info := s.EngineInfo()                       // nil before Start
if info != nil {
    log.Printf("async routes=%d  promotions=%d",
        info.Metrics.AsyncRoutes,
        info.Metrics.AsyncPromotedConns)
}
```

If `AsyncPromotedConns` climbs steadily on routes you *thought* were CPU-cheap, the
adaptive net is telling you those handlers are slower than ~300 µs — either mark
them async explicitly or find out why they're slow.

For the full dispatch model see [Engines and the I/O model](/docs/engines) and
[Routing](/docs/routing).

## Engine and worker tuning

On Linux you choose the I/O engine via `Config.Engine`; the default is **Adaptive**
(`Std` on non-Linux). Adaptive starts on epoll — best for ramp-from-zero,
low-concurrency, and latency-sensitive traffic — and promotes individual
connections to io_uring under sustained high load (`celeris/config.go:43-60`).

### Letting Adaptive decide vs forcing an engine

| `Config.Engine` | Use it when… |
| --- | --- |
| `Adaptive` (default) | You don't want to think about it. Starts epoll, promotes to io_uring under load. |
| `Epoll` | You've measured that your workload is steadily low/medium concurrency and want to pin the behavior. |
| `IOUring` | You've measured a sustained high-concurrency keep-alive workload and want io_uring from the first connection (Linux 5.10+; needs `RLIMIT_MEMLOCK`). |
| `Std` | Non-Linux, or you want the plain net/http server for maximum portability. |

Because connections **cannot migrate** between epoll and io_uring once accepted, the
*starting* engine decides keep-alive throughput — and concurrency is unknowable at
bind time. The `Config.WorkloadHint` is the one lever that biases Adaptive's start
choice without hard-pinning the engine (`celeris/config.go:43-78`):

```go
s := celeris.New(celeris.Config{
    Addr:         ":8080",
    Engine:       celeris.Adaptive,             // default
    WorkloadHint: celeris.WorkloadHighConcurrency, // start on io_uring if kernel+memlock allow
})
```

`WorkloadUnspecified` (the default) starts epoll and promotes under load;
`WorkloadLowConcurrency` stays on epoll; `WorkloadHighConcurrency` starts on
io_uring when the kernel and `RLIMIT_MEMLOCK` permit.

### Worker and buffer knobs

These are all in `Config` (`celeris/config.go`):

| Field | Default | What it does |
| --- | --- | --- |
| `Workers int` | `GOMAXPROCS` | Number of I/O worker goroutines / event loops. The adaptive controller divides `ActiveConnections` by this to derive its conns-per-worker load signal. |
| `BufferSize int` | engine default | Per-connection I/O buffer size in bytes. `0` = engine default. |
| `SocketRecvBuf int` | OS default | `SO_RCVBUF` on accepted connections. `0` = OS default. |
| `SocketSendBuf int` | OS default | `SO_SNDBUF` on accepted connections. `0` = OS default. |
| `MaxConns int` | unlimited | Max simultaneous connections **per worker**. `0` = unlimited. |

```go
s := celeris.New(celeris.Config{
    Addr:          ":8080",
    Workers:       8,                // pin to 8 I/O workers
    BufferSize:    16 * 1024,        // 16 KB per-connection buffer
    SocketRecvBuf: 256 * 1024,       // 256 KB SO_RCVBUF
    MaxConns:      10_000,           // cap connections per worker
})
```

A few tuning notes grounded in the engine signals:

- **`Workers` defaults to `GOMAXPROCS`.** That is the right starting point. Override
  it only when you've measured a reason to (e.g. reserving cores for application
  goroutines, or matching a NUMA layout).
- **`MaxConns` is per worker, not per server.** With 8 workers and
  `MaxConns: 10_000` your ceiling is ~80k connections. It's an admission bound, not
  a tuning knob — use it to fail fast rather than thrash when a flood arrives.
- **The bytes-per-request signal.** The engine tracks `BytesRead` and
  `BytesWritten` alongside `RequestCount` (`celeris/engine/engine.go:123-131`).
  Large average payloads (link-bound workloads) make epoll and io_uring tie, so the
  adaptive controller *suppresses* io_uring selection for them — there's nothing for
  you to set, but it explains why a large-response service may stay on epoll under
  load. For such services, the lever that matters is `SocketSendBuf`, not the
  engine.

### Clipping the connection-ramp RSS balloon: `MemoryLimitBytes`

Under the default `GOGC=100`, the dominant contributor to peak RSS is the burst
of allocations while a fresh server ramps from zero to its steady connection
count — the heap balloons before the GC catches up, and the process never gives
that high-water mark back to the OS. `Config.MemoryLimitBytes` is an **optional
soft heap ceiling** (applied via `runtime/debug.SetMemoryLimit` at `Start`) that
makes the GC collect before the heap balloons during that ramp, trading a few
extra ramp-phase GC cycles for a lower peak. Steady RSS sits far below the limit,
so steady-state throughput is unaffected (`celeris/config.go:142-152`):

```go
cfg := celeris.Config{Addr: ":8080", Workers: 8}
cfg.MemoryLimitBytes = celeris.DeriveMemoryLimit(cfg.Workers) // sized soft ceiling
s := celeris.New(cfg)
```

`celeris.DeriveMemoryLimit(workers)` returns `max(256 MiB, workers × 32 MiB)`
(`celeris/config.go:62-69`) — sized **high** on purpose: the goal is to clip the
ramp spike, not run the heap tight. Two caveats: `0` (the default) means celeris
**does not touch** the process GC, so embedders keep full control; and
`SetMemoryLimit` is **process-global**, so only set this when celeris owns the
process (a dedicated server binary). A negative value is rejected at construction.

See [Configuration reference](/docs/configuration) for the full field list and
[Engines and the I/O model](/docs/engines) for the architecture.

## Connection management

Keep-alive is on by default — reusing a TCP connection across requests is the
single biggest throughput win on a benchmark and a real workload alike. The
relevant `Config` fields (`celeris/config.go:80-131`):

| Field | Default | Notes |
| --- | --- | --- |
| `DisableKeepAlive bool` | `false` | `true` gives each request its own connection — almost never what you want at scale. |
| `IdleTimeout time.Duration` | 600 s | How long a keep-alive connection may sit idle before close. `0` = default; `-1` = no timeout. |
| `ReadTimeout time.Duration` | 60 s | Max time to read the entire request (incl. body). `-1` disables. |
| `WriteTimeout time.Duration` | 60 s | Max time to write the response. `-1` disables. |
| `ReadHeaderTimeout time.Duration` | 10 s | Caps the read of just the request line + headers — the slow-loris defense (see below). `-1` disables. |
| `MaxConcurrentStreams uint32` | 100 | Max simultaneous HTTP/2 streams per connection. |

```go
s := celeris.New(celeris.Config{
    Addr:                 ":8080",
    IdleTimeout:          120 * time.Second, // recycle idle conns sooner
    MaxConcurrentStreams: 250,               // allow more concurrent H2 streams
})
```

- **`IdleTimeout`** trades connection-reuse efficiency against per-connection
  resource cost. A long idle timeout maximizes reuse but holds file descriptors;
  shorten it if you're FD-constrained or facing a connection flood.
- **`MaxConcurrentStreams`** is an HTTP/2 knob: it bounds how many requests a single
  client connection can have in flight. Raising it helps a few high-fan-out clients;
  it does not change HTTP/1.1 behavior. Companion H2 knobs (`MaxFrameSize`,
  `InitialWindowSize`, `MaxHeaderBytes`) are in
  [Configuration reference](/docs/configuration).

## Surviving extreme load

When demand exceeds what you can serve, the goal shifts from *throughput* to
*controlled degradation* — shed the right load, fast, instead of collapsing.
Celeris ships a layered set of in-tree middleware that compose into a defense in
depth. Each is independent; install the ones your service needs.

### The layers, outside-in

A typical ordering puts cheap, broad rejections first and per-route protections
last:

```go
import (
    "github.com/goceleris/celeris/middleware/bodylimit"
    "github.com/goceleris/celeris/middleware/ratelimit"
    "github.com/goceleris/celeris/middleware/circuitbreaker"
    "github.com/goceleris/celeris/middleware/timeout"
    "github.com/goceleris/celeris/middleware/overload"
)

s.Use(bodylimit.New(bodylimit.Config{Limit: "1MB"})) // reject huge bodies (413)
s.Use(ratelimit.New())                               // per-client token bucket (429)
s.Use(overload.New(overload.Config{                  // adaptive load shedding (503)
    CollectorProvider: s.Collector,
}))
s.Use(circuitbreaker.New())                          // stop hammering a sick upstream (503)
s.Use(timeout.New())                                 // bound per-request latency (503)
```

| Middleware | Defends against | Rejects with |
| --- | --- | --- |
| `bodylimit` | Oversized request bodies | 413 (or 411 if `ContentLengthRequired`) |
| `ratelimit` | Per-client request floods | 429 + `Retry-After` |
| `overload` | Server-wide CPU / queue-depth / latency overload | 503 + `Retry-After` |
| `circuitbreaker` | A failing downstream dragging you down | 503 + `Retry-After` |
| `timeout` | Individual slow requests | 503 |

#### `bodylimit` — cap the body before you parse it

```go
s.Use(bodylimit.New(bodylimit.Config{Limit: "10MB"}))   // human-readable units
comments := s.Group("/comments")
comments.Use(bodylimit.New(bodylimit.Config{Limit: "64KB"})) // tighter per-route cap
```

`Limit` accepts SI/IEC units (`KB`, `MB`, `MiB`, …) and takes precedence over
`MaxBytes` (`celeris/middleware/bodylimit/doc.go`). **Crucial layering note**: this
middleware runs *after* the engine has already buffered the body, so it is a
**per-route refinement**, not the DoS ceiling. The real ceiling is
`Config.MaxRequestBodySize` (default 100 MB), enforced at the engine read layer
*before* any buffering — set it to your true maximum at construction:

```go
s := celeris.New(celeris.Config{
    Addr:               ":8080",
    MaxRequestBodySize: 8 << 20, // 8 MB hard ceiling; -1 disables, 0 = 100 MB default
})
```

(`celeris/config.go:108-111`, `celeris/middleware/bodylimit/doc.go`.) Enable
`ContentLengthRequired` to reject bodies that don't declare their size up-front
(411 Length Required).

#### `ratelimit` — sharded token bucket per client

Defaults are 10 RPS, burst 20, keyed by `c.ClientIP()`
(`celeris/middleware/ratelimit/doc.go`):

```go
s.Use(ratelimit.New(ratelimit.Config{
    Rate: "1000-H",                       // 1000 per hour (S/M/H/D units)
    KeyFunc: func(c *celeris.Context) string {
        return c.Header("x-api-key")      // rate-limit by API key, not IP
    },
}))
```

It sets `X-RateLimit-Limit`, `-Remaining`, `-Reset` on allowed responses and
`Retry-After` on the 429. Behind a proxy, install the proxy middleware via
`Server.Pre()` first so limits apply to real client IPs — otherwise every client
behind the proxy shares one bucket. A `Config.Store` lets you back the limiter with
Redis or memcached for cross-instance limits.

#### `overload` — adaptive load shedding (the centerpiece)

This is the middleware that keeps you alive when the *server itself* is saturated.
It runs a 5-stage degradation ladder driven by three signals — **CPU utilization,
in-flight request depth, and tail-latency EMA** — and sheds load according to
application-defined priorities (`celeris/middleware/overload/overload.go`,
`config.go`). A background goroutine polls the signals; the hot path is a single
atomic load, so the Normal stage costs only a few nanoseconds.

The stages (`celeris/middleware/overload/config.go:17-24`):

| Stage | Action |
| --- | --- |
| `Normal` | Pass through unchanged. |
| `Expand` | Signal best-effort worker widening; pass through. |
| `Reap` | Opt-in `runtime.GC()` (only if `EnableReap`); pass through. |
| `Reorder` | Low-priority requests get 503; others pass. |
| `Backpressure` | Low-priority requests sleep `BackpressureDelay`; non-delayable get 503; exempt pass. |
| `Reject` | All non-exempt requests get 503 + `Retry-After`. |

The middleware **requires** a `CollectorProvider`. The server's own collector is the
natural source — and the CPU monitor is wired automatically when the server starts,
so `Snapshot().CPUUtilization` is populated out of the box:

```go
s := celeris.New(celeris.Config{Addr: ":8080"}) // metrics on by default

mw, ctrl := overload.NewWithController(overload.Config{
    CollectorProvider: s.Collector,             // method value: func() *observe.Collector

    // Priority: shed low-value traffic first.
    PriorityFunc: func(c *celeris.Context) int {
        if c.Header("x-internal") == "1" {
            return 10                            // protect internal traffic
        }
        return 0
    },
    PriorityThreshold: 1,                        // priority < 1 is "low"

    // Depth is the most reliable signal when handlers block on upstream I/O:
    // CPU stays low while requests queue. Scale with worker count.
    DepthThresholds: overload.DepthThresholds{
        Reorder:      16,                        // ~2× NumWorkers
        Backpressure: 32,                        // ~4× NumWorkers
        Reject:       64,                        // ~8× NumWorkers
    },

    // Latency is the SLO-aware signal: a latency jump at fixed load means an
    // upstream slowed down — apply backpressure early.
    LatencyThresholds: overload.LatencyThresholds{
        Backpressure: 200 * time.Millisecond,
        Reject:       500 * time.Millisecond,
    },

    ExemptPaths: []string{"/healthz"},           // never degrade health checks
})
s.Use(mw)
defer ctrl.Stop()                                // stop the poll goroutine on shutdown
```

How the signals compose: the poll goroutine takes the **higher** of the CPU-derived
stage and the latency-derived stage, then the hot path folds in **depth**, which can
only escalate *above* (never below) the polled stage
(`celeris/middleware/overload/overload.go:159-258`). CPU thresholds default to
Expand 0.70 / Reap 0.80 / Reorder 0.85 / Backpressure 0.90 / Reject 0.95 with 0.05
hysteresis on downward transitions (`config.go:48-55`). Depth and latency thresholds
are **off by default** — a zero-valued field disables that signal for that stage, so
you only pay for the signals you opt into.

The `Controller` returned by `NewWithController` exposes `Stage()`, `InFlight()`,
`LatencyEMA()`, and `CPUSample()` for dashboards and alerting, plus `Stop()` to halt
the background goroutine.

> **Priority is the point.** Without a `PriorityFunc`, `Reorder` passes everything
> and `Backpressure` delays everything uniformly. Define one to make degradation
> *selective* — shed anonymous/low-value traffic at `Reorder` while paying
> customers and health checks sail through until `Reject`.

#### `circuitbreaker` — stop hammering a sick upstream

A three-state breaker (Closed → Open → HalfOpen) over a sliding error-rate window.
Defaults trip at a 50% failure ratio over a 10 s window once 10 requests have been
observed (`celeris/middleware/circuitbreaker/doc.go`):

```go
payments := s.Group("/api/payments")
payments.Use(circuitbreaker.New(circuitbreaker.Config{
    Threshold:      0.3,           // trip at 30% failures
    MinRequests:    20,
    CooldownPeriod: time.Minute,
}))
```

Use **per-group breakers** so a failing payments upstream doesn't open the breaker
for unrelated routes. Recommended ordering from the docs: rate limiting → circuit
breaker → timeout, so rate-limited requests never reach the breaker and timed-out
requests are correctly classified as failures
(see [middleware-traffic](/docs/middleware-traffic)). `NewWithBreaker` returns a
`*Breaker` for `State()` inspection in health checks.

#### `timeout` — bound per-request latency

Default 5 s cooperative timeout (`celeris/middleware/timeout/doc.go`):

```go
s.Use(timeout.New(timeout.Config{Timeout: 3 * time.Second}))
```

Cooperative mode (default) sets a context deadline with no extra goroutine; your
handler must check `c.Context().Done()` to honor it. `Preemptive: true` runs the
handler in a separate goroutine and returns the timeout error immediately on
deadline — but a handler that ignores cancellation in preemptive mode ties up the
connection and leaks the `Context`, so handlers **must** return promptly on
`c.Context().Done()`.

### Slow-loris defense: `ReadHeaderTimeout`

A slow-loris attacker dribbles request headers one byte at a time to pin a worker
and a listener-backlog slot for the *entire* `ReadTimeout` window.
`Config.ReadHeaderTimeout` caps the read of **just the request line + headers**
separately from the body, killing such clients in seconds. It defaults to **10 s**;
`-1` disables it (`celeris/config.go:83-93`):

```go
s := celeris.New(celeris.Config{
    Addr:              ":8080",
    ReadHeaderTimeout: 5 * time.Second, // tighter slow-loris budget
})
```

On the `Std` engine this wires to `http.Server.ReadHeaderTimeout`; the
iouring/epoll engines enforce the same budget in their H1 header-read loop. This is
the canonical slow-loris defense and is on by default — you only need to touch it to
make the budget tighter.

### How they compose

These middleware are orthogonal and stack cleanly: `bodylimit` and `ratelimit`
reject cheaply at the edge before work begins; `overload` sheds load when the box is
hot or the queue is deep; `circuitbreaker` protects you from a failing dependency;
`timeout` bounds the tail. Install them outside-in (broadest/cheapest first) and let
each return its own status so clients can react — `Retry-After` on the 429/503s lets
well-behaved clients back off instead of retrying into the storm.

See [Rate limiting and resilience](/docs/middleware-traffic) for the full option
reference, and [Middleware](/docs/middleware) for ordering rules.

## Colocated drivers for I/O-bound throughput

For I/O-bound services — anything that spends its time talking to a database or
cache — the throughput ceiling is usually the *backend round-trip*, not your CPU.
Celeris ships drivers (`driver/postgres`, `driver/redis`, `driver/memcached`) that,
when opened `WithEngine(srv)`, register their sockets on the **same event loop** as
your HTTP connections. Combined with async dispatch, a handler that blocks on such a
driver parks its goroutine on netpoll instead of stalling an I/O worker:

```go
import "github.com/goceleris/celeris/driver/redis"

s := celeris.New(celeris.Config{Addr: ":8080"})

s.GET("/cache/:key", func(c *celeris.Context) error {
    return c.String(200, lookup(c.Param("key")))
}).UsesDriver()                                  // dispatch off the worker

rdb, err := redis.NewClient("localhost:6379", redis.WithEngine(s)) // open AFTER the route
if err != nil {
    log.Fatal(err)
}
_ = rdb
```

Two rules from the dispatch section apply directly here: mark driver routes
`.UsesDriver()` (a sub-300 µs localhost call won't trip the adaptive net), and open
the driver **after** the routes are registered (or set `AsyncHandlers = true`) so it
reads the right effective async state. Full setup, pooling, and TLS details are in
[Stores and database drivers](/docs/data-stores).

## Measuring

You can't tune what you don't measure. The server's `Collector` records per-request
metrics with lock-free, per-worker-sharded counters; `Snapshot()` returns a
point-in-time copy (`celeris/observe/collector.go`):

```go
snap := s.Collector().Snapshot()
fmt.Printf("requests=%d errors=%d active=%d cpu=%.2f\n",
    snap.RequestsTotal, snap.ErrorsTotal, snap.ActiveConns, snap.CPUUtilization)
```

`Snapshot` fields you'll watch most (`celeris/observe/collector.go:40-57`):

| Field | Meaning |
| --- | --- |
| `RequestsTotal` | Cumulative handled requests. |
| `ErrorsTotal` | Cumulative responses with status ≥ 500. |
| `ActiveConns` | Currently open connections. |
| `LatencyBuckets` / `BucketBounds` | Request-count histogram and its upper bounds (seconds). |
| `CPUUtilization` | System CPU as a fraction `[0,1]`; `-1` if no monitor (the server wires one automatically when started). |
| `EngineMetrics` | The engine's own counters — see below. |
| `EngineSwitches` | How many times the adaptive engine changed strategy. |

The latency buckets use fixed bounds of 1 ms, 5 ms, 10 ms, 25 ms, 50 ms, 100 ms,
250 ms, 500 ms, 1 s, 5 s (`celeris/observe/collector.go:13-15`). Track the fraction
of requests in the high buckets to watch your tail without a full histogram backend.

`snap.EngineMetrics` carries the engine-level counters that drive tuning decisions
(`celeris/engine/engine.go:85-132`): `Throughput` (recent RPS), `ActiveConnections`,
`AcceptCount` / `CloseCount` (a high close-to-accept ratio means short-lived churn
connections), `BytesRead` / `BytesWritten` (the bytes-per-request signal), `Workers`,
and the `AsyncRoutes` / `AsyncPromotedConns` dispatch counters from earlier.

```go
m := s.Collector().Snapshot().EngineMetrics
log.Printf("rps=%.0f conns=%d accepts=%d closes=%d async_promotions=%d",
    m.Throughput, m.ActiveConnections, m.AcceptCount, m.CloseCount, m.AsyncPromotedConns)
```

If you'd rather not poll, the built-in collector stays on by default
(`DisableMetrics: false`) and you can pair it with the in-tree `middleware/metrics`
(Prometheus) and `middleware/debug` packages — see
[Observability](/docs/observability) for the full metrics-export story. Disabling
metrics (`DisableMetrics: true`) skips per-request recording entirely and makes
`Collector()` return `nil` (`celeris/server.go:99-100`, `celeris/server.go:543-545`)
— only do this if you've measured the recording cost and have an external metrics
path.

## FAQ

**Should I just set `AsyncHandlers = true` everywhere?**
No. Pay the ~3–5% async cost only on routes that block on I/O. The common shape is
`AsyncHandlers: false` with the few DB/cache routes marked `.Async()` /
`.UsesDriver()`. If most routes block, flip the default to `true` and mark the hot
CPU routes `.Sync()`.

**Why is my fast Redis route still blocking a worker?**
Because a sub-300 µs localhost driver call is below the adaptive auto-promotion
threshold. Mark the route `.UsesDriver()` (or `.Async()`) explicitly — the adaptive
net only promotes handlers slower than ~300 µs (`celeris/router.go:253-258`).

**Does `bodylimit` protect me from a DoS?**
Not on its own — it runs *after* the body is buffered. The hard ceiling is
`Config.MaxRequestBodySize` at the engine read layer. Set that to your true maximum;
use `bodylimit` for *tighter per-route* caps below it
(`celeris/middleware/bodylimit/doc.go`).

**Which overload signal should I use — CPU, depth, or latency?**
CPU catches compute-bound saturation; **depth** is the most reliable when handlers
block on upstream I/O (CPU stays low while the queue grows); **latency** is the
SLO-aware signal for when an upstream slows down. They compose — the highest stage
wins — so enabling all three is reasonable; just leave the thresholds you don't want
at zero (`celeris/middleware/overload/config.go`).

**Do I need to enable the CPU monitor for `overload`?**
No — the server wires a platform CPU monitor automatically when it starts, so
`Snapshot().CPUUtilization` is populated and `overload`'s `CollectorProvider:
s.Collector` works out of the box (`celeris/server.go:647-653`).

## See also

- [Configuration reference](/docs/configuration) — every `Config` field, including
  the H2 and timeout knobs referenced here.
- [Engines and the I/O model](/docs/engines) — Adaptive/Epoll/IOUring/Std and the
  full async dispatch model.
- [Rate limiting and resilience](/docs/middleware-traffic) — the complete option
  reference for `ratelimit`, `circuitbreaker`, `timeout`, `bodylimit`, and
  `overload`.
- [Stores and database drivers](/docs/data-stores) — colocated drivers and
  `WithEngine`.
- [Routing](/docs/routing) — per-route `Async` / `Sync` / `UsesDriver`.
- [Middleware](/docs/middleware) — middleware ordering and registration rules.
- [Observability](/docs/observability) — the built-in `Collector`, Prometheus, and
  the `/debug/celeris` endpoint that surface the counters measured here.
