---
title: Rate limiting and resilience
description: Protect services under load with rate limiting, circuit breakers, timeouts, adaptive overload shedding, body limits, and request coalescing.
group: Middleware
order: 4
---

When a service is healthy, every request gets served. When it's *unhealthy* — a
hot client hammering one endpoint, a slow upstream dragging latency up, a CPU
pegged at 100% — the difference between a brief blip and a full outage is how
gracefully you shed the excess. Celeris ships six in-tree middleware packages for
exactly this, each a standalone `celeris.HandlerFunc` you install with `Use`,
`Pre`, `Group`, or per-route:

| Package | What it does | Default reject status |
| ------- | ------------ | --------------------- |
| `middleware/ratelimit` | Per-key token bucket / sliding window | `429 Too Many Requests` |
| `middleware/circuitbreaker` | Stop calling a failing dependency | `503 Service Unavailable` |
| `middleware/timeout` | Bound per-request latency | `503 Service Unavailable` |
| `middleware/overload` | Adaptive CPU/depth/latency load shedding | `503 Service Unavailable` |
| `middleware/bodylimit` | Cap request body size | `413` / `411` |
| `middleware/singleflight` & `middleware/idempotency` | Coalesce duplicate work; make retries safe | `409` on conflict |

Every package follows the same shape: a `New(config ...Config) celeris.HandlerFunc`
constructor, a `Config` struct with sensible zero-value defaults, and a sentinel
error you can match with `errors.Is`. You can install them with no config at all
and get a reasonable default, then tune from there.

```go
import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/ratelimit"
)

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(ratelimit.New()) // 10 RPS, burst 20, per client IP
```

> **Ordering matters.** Middleware runs outside-in. Put cheap, broad rejections
> first so an overloaded server spends as little as possible on requests it's
> about to drop: `bodylimit` → `ratelimit` → `overload` → `circuitbreaker` →
> `timeout` → your handlers is a sane default. See [Middleware](/docs/middleware)
> for the full ordering model and where `Pre` (pre-routing) fits.

## Rate limiting

`ratelimit.New` installs a per-key limiter. By default it's a **token bucket**:
each key gets a bucket that refills at `RPS` tokens per second up to a ceiling of
`Burst` tokens; each request spends one token, and a request with no tokens left
is rejected with `429`. This lets short bursts through (up to `Burst`) while
holding the long-run average at `RPS`.
Source: `celeris/middleware/ratelimit/ratelimit.go:36`.

```go
import "github.com/goceleris/celeris/middleware/ratelimit"

// 100 requests/second sustained, bursts up to 200, per client IP.
s.Use(ratelimit.New(ratelimit.Config{
    RPS:   100,
    Burst: 200,
}))
```

### Rate as a human string

Instead of `RPS` + `Burst` you can write a `Rate` string in `<count>-<unit>`
form, where the unit is `S` (second), `M` (minute), `H` (hour), or `D` (day).
`Rate` takes precedence over `RPS`, and sets `Burst` equal to the count **unless
you set `Burst` explicitly**. Source: `celeris/middleware/ratelimit/config.go:208`.

```go
s.Use(ratelimit.New(ratelimit.Config{Rate: "100-M"})) // 100/min, burst 100
s.Use(ratelimit.New(ratelimit.Config{Rate: "1000-H"})) // 1000/hour
s.Use(ratelimit.New(ratelimit.Config{Rate: "5-S", Burst: 20})) // 5/s sustained, burst 20
```

| `Rate` | Meaning | Resulting `RPS` | Default `Burst` |
| ------ | ------- | --------------- | --------------- |
| `"5-S"`   | 5 per second | `5`       | `5`    |
| `"100-M"` | 100 per minute | `1.6667` | `100`  |
| `"1000-H"`| 1000 per hour | `0.2778` | `1000` |
| `"10000-D"`| 10000 per day | `0.1157`| `10000`|

You can parse and validate a rate string yourself before constructing the
middleware — handy when the value comes from config or an untrusted source:

```go
rps, burst, err := ratelimit.ParseRate("100-M") // 1.6667, 100, nil
if err != nil { /* invalid format */ }

// Validate a whole Config without panicking (New panics on a bad Rate).
if err := ratelimit.ValidateConfig(cfg); err != nil {
    log.Fatalf("bad ratelimit config: %v", err)
}
```

`ValidateConfig` is the safe pre-flight check; `New` itself **panics** on an
invalid `Rate`. Source: `celeris/middleware/ratelimit/config.go:179`.

### The key: `KeyFunc` and the proxy caveat

A limiter is only as good as its key. By default the key is the **client IP**
(`c.ClientIP()`, falling back to `c.RemoteAddr()`).
Source: `celeris/middleware/ratelimit/config.go:155`.

> **Read this before you ship.** `c.ClientIP()` only returns the real client
> address when the [proxy middleware](/docs/middleware) is installed
> (`s.Pre(proxy.New(...))`) and configured with your load balancer's address in
> `TrustedProxies`. **Without it**, `ClientIP()` returns the *immediate peer* —
> i.e. your load balancer — so every real client shares one bucket and a single
> noisy client triggers a global 429 for everyone behind that hop. With a
> *misconfigured* `TrustedProxies` range, attackers can spoof `X-Forwarded-For`
> and escape their bucket. Verify the chain before relying on the default.
> Source: the `KeyFunc` doc comment, `celeris/middleware/ratelimit/config.go:62`.

For anything other than raw IP, supply your own `KeyFunc`:

```go
// Rate-limit per API key (read from a header set by your auth middleware).
s.Use(ratelimit.New(ratelimit.Config{
    Rate: "1000-M",
    KeyFunc: func(c *celeris.Context) string {
        if k := c.Header("x-api-key"); k != "" {
            return "key:" + k
        }
        return "ip:" + c.ClientIP() // fall back for anonymous traffic
    },
}))
```

### X-RateLimit headers

Unless you set `DisableHeaders: true`, every response carries the standard
limit headers, and rejected requests also get `Retry-After`:

| Header | Meaning |
| ------ | ------- |
| `X-RateLimit-Limit` | The bucket capacity (`Burst`) |
| `X-RateLimit-Remaining` | Tokens left in this key's bucket |
| `X-RateLimit-Reset` | Seconds until the bucket refills |
| `Retry-After` | (on 429 only) Seconds the client should wait |

Source: `celeris/middleware/ratelimit/ratelimit.go:198-207`.

### Sliding window

Token bucket can let a burst land right at a window edge. Set
`SlidingWindow: true` to use a sliding-window counter instead — it weights the
previous and current window by the elapsed fraction of the current window,
smoothing the rate near boundaries. Source: `celeris/middleware/ratelimit/config.go:91`.

```go
s.Use(ratelimit.New(ratelimit.Config{Rate: "100-M", SlidingWindow: true}))
```

### Dynamic per-request limits with `RateFunc`

When different callers deserve different limits (free vs. paid tiers, say), set
`RateFunc`. It runs per request and returns a `Rate` string; an empty string
falls back to the static `Rate`/`RPS`/`Burst`. Each distinct rate string gets its
own limiter, cached up to `MaxDynamicLimiters` (default 1024); beyond that, new
rate strings are rejected. Source: `celeris/middleware/ratelimit/config.go:56`,
`celeris/middleware/ratelimit/ratelimit.go:176-188`.

```go
s.Use(ratelimit.New(ratelimit.Config{
    Rate: "100-M", // default tier
    RateFunc: func(c *celeris.Context) (string, error) {
        switch tier(c) {
        case "enterprise":
            return "10000-M", nil
        case "pro":
            return "1000-M", nil
        default:
            return "", nil // use the static default
        }
    },
}))
```

### Distributed limiting with a `Store`

The built-in limiter is in-process: each instance counts independently, so N
replicas means N× the effective limit. To enforce a *global* limit across a
fleet, plug in a `Store`. When `Store` is set, it owns the rate/burst logic and
`RPS`, `Burst`, `Shards`, and `CleanupInterval` are ignored.
Source: `celeris/middleware/ratelimit/config.go:38`.

Celeris ships a Redis-backed store at
`github.com/goceleris/celeris/middleware/ratelimit/redisstore`:

```go
import (
    "github.com/goceleris/celeris/middleware/ratelimit"
    "github.com/goceleris/celeris/middleware/ratelimit/redisstore"
    "github.com/redis/go-redis/v9"
)

rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})

store, err := redisstore.New(ctx, rdb, redisstore.Options{
    RPS:   100, // tokens/second — required
    Burst: 200, // bucket capacity — required
})
if err != nil {
    log.Fatal(err)
}

s.Use(ratelimit.New(ratelimit.Config{Store: store}))
```

The Redis store uses an atomic Lua token-bucket script (loaded via `SCRIPT LOAD`
at `New` time, then run with `EVALSHA` on the hot path), so the limit holds even
under concurrent requests across replicas. Source:
`celeris/middleware/ratelimit/redisstore/redisstore.go:61-70` (the script),
`redisstore.go:114-116` (`New`). A memcached store ships alongside it at
`github.com/goceleris/celeris/middleware/ratelimit/memcachedstore`.

### Refunding tokens

Sometimes you don't want a request to *cost* a token if it failed (or
succeeded). `SkipFailedRequests` refunds the token when the handler returns a
status `>= 400`; `SkipSuccessfulRequests` refunds it for status `< 400`. For a
`Store`, refunds require the store to implement `StoreUndo` (the Redis store
does). Source: `celeris/middleware/ratelimit/config.go:98-106`.

```go
// Only count requests that actually hit your backend (4xx don't burn quota).
s.Use(ratelimit.New(ratelimit.Config{Rate: "100-M", SkipFailedRequests: true}))
```

### Other `ratelimit.Config` fields

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `RPS` | `float64` | `10` | Refill rate, requests/sec per key |
| `Burst` | `int` | `20` | Bucket capacity (max tokens) |
| `Rate` | `string` | — | Human rate string; overrides `RPS` |
| `RateFunc` | `func(*Context) (string, error)` | — | Per-request rate string |
| `KeyFunc` | `func(*Context) string` | client IP | Extract the limit key |
| `Store` | `Store` | — | External backend; ignores RPS/Burst/Shards |
| `SlidingWindow` | `bool` | `false` | Sliding window instead of token bucket |
| `Shards` | `int` | `NumCPU` | Lock shards (rounded up to power of 2) |
| `CleanupInterval` | `time.Duration` | `1m` | How often expired buckets are reaped |
| `CleanupContext` | `context.Context` | — | Cancel to stop the cleanup goroutine |
| `DisableHeaders` | `bool` | `false` | Suppress `X-RateLimit-*` headers |
| `SkipFailedRequests` | `bool` | `false` | Refund token on `>= 400` |
| `SkipSuccessfulRequests` | `bool` | `false` | Refund token on `< 400` |
| `MaxDynamicLimiters` | `int` | `1024` | Cap on cached `RateFunc` rate strings |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |
| `ErrorHandler` | `func(*Context, error) error` | 429 | Custom rejection response |

`ErrorHandler` receives the sentinel `ratelimit.ErrTooManyRequests` (a `429`
`*celeris.HTTPError`) so you can distinguish the cause:

```go
s.Use(ratelimit.New(ratelimit.Config{
    Rate: "100-M",
    ErrorHandler: func(c *celeris.Context, err error) error {
        return c.JSON(429, map[string]string{"error": "slow down"})
    },
}))
```

> `LimitReached func(c *celeris.Context) error` is the deprecated predecessor of
> `ErrorHandler`; if both are set, `ErrorHandler` wins. Prefer `ErrorHandler` for
> consistency with the rest of the middleware family.
> Source: `celeris/middleware/ratelimit/config.go:108-122`.

## Circuit breakers

A rate limiter protects *you* from your callers. A circuit breaker protects you
from a failing *dependency* — when a downstream is throwing errors, the breaker
"opens" and fails fast for a cooldown instead of piling more doomed requests onto
a service that's already down.

The breaker is a three-state machine:

- **Closed** — normal. All requests pass; the breaker watches the error rate.
- **Open** — tripped. Every request is rejected immediately with `503`, no call
  to the handler, until the cooldown elapses.
- **Half-open** — probing. After the cooldown, a few probe requests are let
  through. If they succeed the breaker closes; if any fails it re-opens.

Source: `celeris/middleware/circuitbreaker/config.go:9-19`.

```go
import "github.com/goceleris/celeris/middleware/circuitbreaker"

// Wrap only the routes that call the flaky upstream.
api := s.Group("/api")
api.Use(circuitbreaker.New(circuitbreaker.Config{
    Threshold:      0.5,              // trip at 50% failure rate
    MinRequests:    20,              // …but only after 20 requests in the window
    WindowSize:     10 * time.Second, // sliding observation window
    CooldownPeriod: 30 * time.Second, // stay open this long before probing
    HalfOpenMax:    3,               // allow 3 probes in half-open
}))
```

### When does it trip?

The breaker trips (Closed → Open) when, within the current `WindowSize`, the
total request count is at least `MinRequests` **and** `failures/total >=
Threshold`. `MinRequests` stops a tiny sample (2 of 3 requests failing) from
tripping prematurely. Source: `celeris/middleware/circuitbreaker/circuitbreaker.go:180`.

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `Threshold` | `float64` | `0.5` | Failure ratio that trips the breaker; must be in `(0, 1]` |
| `MinRequests` | `int` | `10` | Min requests in the window before it can trip |
| `WindowSize` | `time.Duration` | `10s` | Sliding observation window (must be `>= 10ms`) |
| `CooldownPeriod` | `time.Duration` | `30s` | Time Open before transitioning to Half-open |
| `HalfOpenMax` | `int` | `1` | Probe requests allowed in Half-open |
| `IsError` | `func(err error, status int) bool` | `status >= 500` | What counts as a failure |
| `OnStateChange` | `func(from, to State)` | — | Observe transitions (called under a mutex — keep it fast) |
| `ErrorHandler` | `func(*Context, error) error` | 503 | Response when the breaker is open |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |

> Out-of-range values **panic** at construction: `Threshold` must be in `(0, 1]`,
> `WindowSize >= 10ms`, `CooldownPeriod > 0`, `HalfOpenMax >= 1`, `MinRequests
> >= 1`. Source: `celeris/middleware/circuitbreaker/config.go:120`.

### What counts as a failure: `IsError`

By default any response with status `>= 500` (or a non-`HTTPError` returned by
the handler) is a failure. A `429` or `404` is *not* — those are the client's
fault, not the dependency's. Override `IsError` to refine this:

```go
api.Use(circuitbreaker.New(circuitbreaker.Config{
    IsError: func(err error, status int) bool {
        // Treat upstream timeouts (504) and any 5xx as failures.
        return status >= 500
    },
}))
```

### Observing and controlling the breaker

`New` returns just the handler. Use `NewWithBreaker` when you want a handle on the
`*Breaker` for metrics, health checks, or a manual reset:

```go
mw, brk := circuitbreaker.NewWithBreaker(circuitbreaker.Config{
    OnStateChange: func(from, to circuitbreaker.State) {
        log.Printf("breaker: %s -> %s", from, to) // e.g. "closed -> open"
    },
})
api.Use(mw)

// Elsewhere — expose the state on a health endpoint:
s.GET("/internal/breaker", func(c *celeris.Context) error {
    total, failures := brk.Counts()
    return c.JSON(200, map[string]any{
        "state":    brk.State().String(), // "closed" | "open" | "half-open"
        "total":    total,
        "failures": failures,
    })
})

// brk.Reset() forces the breaker back to Closed and clears the window.
```

`Breaker` exposes `State() State`, `Counts() (total, failures int64)`, and
`Reset()`. Source: `celeris/middleware/circuitbreaker/circuitbreaker.go:54-74`.

The sentinel for the open state is `circuitbreaker.ErrServiceUnavailable`, which
aliases `celeris.ErrServiceUnavailable` (`503`) — the **same** sentinel `timeout`
uses, so `errors.Is(err, celeris.ErrServiceUnavailable)` matches both. (The
`overload` middleware also returns `503`, but it does so via
`c.AbortWithStatus(503)` rather than this sentinel, and `ratelimit` returns its
own `429` sentinel `ratelimit.ErrTooManyRequests`.)
Source: `celeris/middleware/circuitbreaker/config.go:78-81`,
`celeris/errors.go:50`.

## Timeouts

A handler that hangs forever ties up a worker forever. `timeout.New` bounds how
long a request may take. There are two modes.

### Non-preemptive (the default)

The middleware wraps the request context with a deadline and lets the handler
run. Your handler **cooperatively** observes the deadline by selecting on
`c.Context().Done()` (or passing `c.Context()` to an `http.Client`, DB driver,
etc.). If the handler overruns the deadline, the middleware returns the timeout
response. Source: `celeris/middleware/timeout/timeout.go:36`.

```go
import "github.com/goceleris/celeris/middleware/timeout"

s.Use(timeout.New(timeout.Config{Timeout: 3 * time.Second}))

s.GET("/slow", func(c *celeris.Context) error {
    // Honour cancellation — pass the request context to downstream calls.
    row := db.QueryRowContext(c.Context(), "SELECT ...")
    // …
    return c.JSON(200, result)
}).Async() // blocking I/O → run off the event loop (see /docs/routing)
```

This mode is cheap: it uses a single lazy-deadline context and allocates no
goroutine. Its limitation is that a CPU-bound or blocking handler that *never*
checks `Done()` won't actually be interrupted — the deadline is reported once it
returns, but it can still run long.

### Preemptive

Set `Preemptive: true` to run the handler in a goroutine with a buffered
response. If it doesn't finish within the timeout, the middleware discards the
buffered output and returns the error handler's response — bounding the *client's*
wait even when the handler ignores cancellation.

```go
s.Use(timeout.New(timeout.Config{
    Timeout:    2 * time.Second,
    Preemptive: true,
}))
```

> **Preemptive mode has two hard constraints:**
> 1. **Handlers must still honour `c.Context().Done()`.** Preemptive mode bounds
>    the client wait, but a handler that never returns keeps leaking a goroutine.
>    Always select on cancellation. Source: `celeris/middleware/timeout/config.go:38`.
> 2. **It is incompatible with streaming.** Buffered mode captures the whole
>    response in memory, defeating `StreamWriter` and risking OOM on large
>    payloads. Use the non-preemptive default for SSE/streaming endpoints. See
>    [Streaming, SSE & WebSocket](/docs/streaming).
>
> Preemptive mode allocates a goroutine and a `context.WithTimeout` per request —
> a measurable ~1–3% throughput cost at very high RPS. Reach for it only when you
> genuinely need to interrupt uncooperative handlers.

### Per-request timeouts and treating upstream errors as timeouts

`TimeoutFunc` computes a per-request deadline (falling back to `Timeout` when it
returns zero). `TimeoutErrors` lists errors that should be *treated* as a timeout
even before the deadline — e.g. a DB driver's own query-timeout error — so they
flow through your `ErrorHandler` as a 503 instead of a raw 500.

```go
s.Use(timeout.New(timeout.Config{
    Timeout: 5 * time.Second,
    TimeoutFunc: func(c *celeris.Context) time.Duration {
        if c.Path() == "/report" {
            return 30 * time.Second // reports get longer
        }
        return 0 // use the static Timeout
    },
    TimeoutErrors: []error{context.DeadlineExceeded, sql.ErrConnDone},
    ErrorHandler: func(c *celeris.Context, err error) error {
        return c.JSON(503, map[string]string{"error": "request timed out"})
    },
}))
```

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `Timeout` | `time.Duration` | `5s` | Static deadline; fallback for `TimeoutFunc` |
| `TimeoutFunc` | `func(*Context) time.Duration` | — | Per-request deadline |
| `Preemptive` | `bool` | `false` | Run handler in a goroutine; bound client wait |
| `TimeoutErrors` | `[]error` | — | Errors treated as a timeout via `errors.Is` |
| `ErrorHandler` | `func(*Context, error) error` | 503 | Timeout response |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |

> `New` **panics** if `Timeout <= 0` and `TimeoutFunc` is nil — you must give it
> *some* deadline. Source: `celeris/middleware/timeout/config.go:80`. The
> `ErrorHandler` receives `context.DeadlineExceeded` for a deadline timeout, the
> matched `TimeoutErrors` entry for a semantic timeout, or a panic-wrapped error
> for a recovered panic. Source: `celeris/middleware/timeout/config.go:27`.

## Adaptive overload shedding

Rate limits and circuit breakers are *static* rules. The `overload` middleware is
*adaptive*: a background goroutine samples real server pressure — CPU
utilization, in-flight request depth, and tail latency — and walks a five-stage
ladder, degrading more aggressively as pressure rises and recovering (with
hysteresis) as it falls. Source: `celeris/middleware/overload/overload.go:1-23`.

| Stage | CPU default | Behaviour |
| ----- | ----------- | --------- |
| **Normal** | < 0.70 | Pass through unchanged |
| **Expand** | ≥ 0.70 | Signal best-effort worker widening; pass through |
| **Reap** | ≥ 0.80 | Opt-in `runtime.GC()`, then pass through |
| **Reorder** | ≥ 0.85 | Low-priority requests get `503`; others pass |
| **Backpressure** | ≥ 0.90 | Low-priority requests sleep `BackpressureDelay`; non-delayable get `503`; exempt pass |
| **Reject** | ≥ 0.95 | All non-exempt requests get `503` + `Retry-After` |

Source: `celeris/middleware/overload/config.go:16-24` and `config.go:177`.

### `CollectorProvider` is required

The middleware reads CPU from an `observe.Collector`, and the collector must have
a CPU monitor attached. `New` **panics** if `CollectorProvider` is nil. The
provider is a *function* (not a value) because the server only creates its
collector at `Start`, so you pass a closure that fetches it lazily.
Source: `celeris/middleware/overload/overload.go:103-105`.

```go
import (
    "github.com/goceleris/celeris/middleware/overload"
    "github.com/goceleris/celeris/observe"
)

// Attach a CPU monitor to the server's collector before installing the mw.
if col := s.Collector(); col != nil {
    if mon, err := observe.NewCPUMonitor(); err == nil {
        col.SetCPUMonitor(mon)
    }
}

s.Use(overload.New(overload.Config{
    CollectorProvider: s.Collector, // method value — resolved per poll tick
}))
```

`s.Collector()` returns nil until the server has started and only when
`Config.DisableMetrics` is false. Source: `celeris/server.go:543`.
`observe.NewCPUMonitor()` returns a platform-appropriate monitor (Linux reads
`/proc/stat`; others use `runtime/metrics`) and a non-nil `error`, so check it
before calling `SetCPUMonitor`. Source: `celeris/observe/cpumon_linux.go:10`,
`cpumon_other.go:9`, `celeris/observe/collector.go:130` (`SetCPUMonitor`),
`collector.go:77` (`CPUMonitor`). For the full metrics surface see
[Configuration](/docs/configuration).

### Depth and latency signals

CPU alone misses the most common production overload: handlers blocked on a slow
upstream. CPU stays low while requests queue up. Add `DepthThresholds`
(absolute in-flight counts) and/or `LatencyThresholds` (EMA tail-latency targets)
— whichever signal produces the *highest* stage wins. A depth/latency threshold
can escalate the stage **beyond** the CPU-driven one, never below it.
Source: `celeris/middleware/overload/overload.go:159-177`, `overload.go:253-257`.

```go
workers := 12
s.Use(overload.New(overload.Config{
    CollectorProvider: s.Collector,
    DepthThresholds: overload.DepthThresholds{
        Reorder:      int32(2 * workers), // queue building → shed low priority
        Backpressure: int32(4 * workers),
        Reject:       int32(8 * workers), // queue out of control → shed all
    },
    LatencyThresholds: overload.LatencyThresholds{
        Backpressure: 500 * time.Millisecond, // SLO-aware: latency spiked
        Reject:       2 * time.Second,
    },
}))
```

Zero-valued threshold fields disable that signal for that stage, so you opt into
exactly the signals you want. `DepthThresholds` guidance from the source: try
`Reorder = 2×workers`, `Backpressure = 4×workers`, `Reject = 8×workers`.
Source: `celeris/middleware/overload/config.go:62-66`.

### Priority: deciding *who* to shed

At Reorder and Backpressure, the middleware needs to know which requests are
expendable. `PriorityFunc` classifies each request (higher = more important);
requests scoring **below** `PriorityThreshold` (default `0`) are the ones
rejected at Reorder and delayed/rejected at Backpressure. Without a `PriorityFunc`
all requests share priority 0, so Reorder passes everything and Backpressure
delays everything. Source: `celeris/middleware/overload/config.go:128-137`.

```go
s.Use(overload.New(overload.Config{
    CollectorProvider: s.Collector,
    PriorityFunc: func(c *celeris.Context) int {
        switch {
        case c.Path() == "/checkout":
            return 10 // protect revenue paths first
        case strings.HasPrefix(c.Path(), "/api/"):
            return 1
        default:
            return -1 // background/scrapers shed first
        }
    },
    PriorityThreshold: 0,                       // priority < 0 is "low"
    BackpressureDelay: 100 * time.Millisecond, // throttle, don't drop, mid-priority
    RetryAfter:        10 * time.Second,        // Retry-After on the 503s
}))
```

`ExemptPaths` and `ExemptFunc` mark requests that never get degraded — use them
for health checks and other endpoints that must always answer:

```go
overload.Config{
    CollectorProvider: s.Collector,
    ExemptPaths:       []string{"/healthz", "/readyz"},
}
```

### Key `overload.Config` fields

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `CollectorProvider` | `func() *observe.Collector` | — (**required**) | Source of CPU samples |
| `Thresholds` | `Thresholds` | 0.70/0.80/0.85/0.90/0.95 | Per-stage CPU fractions; `Hysteresis` 0.05 |
| `DepthThresholds` | `DepthThresholds` | all 0 (off) | Per-stage in-flight counts |
| `LatencyThresholds` | `LatencyThresholds` | all 0 (off) | Per-stage EMA latency targets |
| `LatencyEMAAlpha` | `float64` | `0.1` | EMA smoothing factor |
| `PollInterval` | `time.Duration` | `1s` | How often CPU is sampled |
| `PriorityFunc` | `func(*Context) int` | — | Classify request priority |
| `PriorityThreshold` | `int` | `0` | Cutoff below which requests are "low" |
| `BackpressureDelay` | `time.Duration` | `50ms` | Added latency at Backpressure |
| `BackpressureStatus` | `int` | `503` | Status for non-delayable at Backpressure |
| `RejectStatus` | `int` | `503` | Status at Reject |
| `RetryAfter` | `time.Duration` | `5s` | `Retry-After` header on 503s |
| `ExemptPaths` / `ExemptFunc` | `[]string` / `func` | — | Never-degraded requests |
| `EnableReap` | `bool` | `false` | Allow `runtime.GC()` at Reap |
| `StopContext` | `context.Context` | `Background` | Cancel to stop the sampler |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |

### Inspecting the controller

`NewWithController` returns the handler **and** a `*Controller` you can poll for
the live stage, in-flight count, latency EMA, and last CPU sample — ideal for a
debug endpoint or your metrics exporter:

```go
mw, ctrl := overload.NewWithController(overload.Config{CollectorProvider: s.Collector})
s.Use(mw)

s.GET("/internal/overload", func(c *celeris.Context) error {
    return c.JSON(200, map[string]any{
        "stage":    ctrl.Stage().String(), // "normal" … "reject"
        "inflight": ctrl.InFlight(),
        "latency":  ctrl.LatencyEMA().String(),
        "cpu":      ctrl.CPUSample(), // -1 until first sample
    })
})
// ctrl.Stop() halts the sampler (the stage then freezes at its last value).
```

Source: `celeris/middleware/overload/overload.go:48-85`.

## Body limits

`bodylimit.New` rejects oversized request bodies before your handler runs. Set a
size in bytes with `MaxBytes`, or with a human-readable `Limit` string (which
takes precedence). Source: `celeris/middleware/bodylimit/config.go:11`.

```go
import "github.com/goceleris/celeris/middleware/bodylimit"

s.Use(bodylimit.New(bodylimit.Config{Limit: "10MB"})) // 413 if larger
```

`Limit` accepts decimal (`KB`/`MB`/`GB`/`TB`/`PB`/`EB`) and binary
(`KiB`/`MiB`/…) suffixes, with optional fractions: `"1.5GB"`, `"512KiB"`. An
invalid `Limit` string **panics** at construction.
Source: `celeris/middleware/bodylimit/config.go:83`.

The middleware checks in two phases: first the `Content-Length` header (fast
reject), then the actual buffered body length (catches a lying or absent
`Content-Length`). Bodyless methods (`GET`, `HEAD`, `DELETE`, `OPTIONS`, `TRACE`,
`CONNECT`) are auto-skipped. Source: `celeris/middleware/bodylimit/bodylimit.go:53-82`.

### `ContentLengthRequired`

> **Important architectural note.** Celeris buffers the full request body
> *before* middleware runs, so `bodylimit` cannot stop an oversized payload from
> entering memory when `Content-Length` is absent or dishonest — the framework's
> own `maxRequestBodySize` (100 MB) is the hard ceiling. To force clients to
> declare body size up front, set `ContentLengthRequired: true`; requests without
> a `Content-Length` header are then rejected with `411 Length Required` before
> the body check. Source: `celeris/middleware/bodylimit/bodylimit.go:12-23`,
> `config.go:31`.

```go
s.Use(bodylimit.New(bodylimit.Config{
    Limit:                 "5MB",
    ContentLengthRequired: true, // 411 if no Content-Length
    ErrorHandler: func(c *celeris.Context, err error) error {
        if errors.Is(err, bodylimit.ErrLengthRequired) {
            return c.JSON(411, map[string]string{"error": "Content-Length required"})
        }
        return c.JSON(413, map[string]string{"error": "body too large"})
    },
}))
```

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `Limit` | `string` | — | Human size string; overrides `MaxBytes` |
| `MaxBytes` | `int64` | `4 MiB` | Max body bytes |
| `ContentLengthRequired` | `bool` | `false` | Reject missing `Content-Length` with `411` |
| `ErrorHandler` | `func(*Context, error) error` | 413/411 | Custom rejection |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |

The sentinels are `bodylimit.ErrBodyTooLarge` (`413`) and
`bodylimit.ErrLengthRequired` (`411`).
Source: `celeris/middleware/bodylimit/bodylimit.go:5-10`.

## Request coalescing & idempotency

These two packages both stop *duplicate* work, but solve different problems.

### `singleflight` — coalesce identical in-flight requests

When many identical requests arrive at once (a cache stampede, a dashboard that
N clients all refresh on the same tick), `singleflight` lets the **first**
request run the handler and serves every concurrent duplicate a *copy* of that
one response. Coalesced responses carry an `X-Singleflight: HIT` header.
Source: `celeris/middleware/singleflight/singleflight.go:59`, `singleflight.go:115`.

```go
import "github.com/goceleris/celeris/middleware/singleflight"

// Coalesce expensive, cacheable GETs.
s.GET("/report/:id", singleflight.New(), buildExpensiveReport)
```

> **The key must include user identity.** The default `KeyFunc` is
> `method + path + sorted-query + Authorization header + Cookie header` —
> the auth and cookie components are what stop one user's response from being
> served to another. **If you supply your own `KeyFunc`, you MUST incorporate
> user identity** for any endpoint that returns user-specific data, or you will
> leak data across users. Source: `celeris/middleware/singleflight/config.go:18-31`.

```go
s.GET("/me/feed", singleflight.New(singleflight.Config{
    KeyFunc: func(c *celeris.Context) string {
        return c.Method() + "\x00" + c.Path() + "\x00" + userID(c) // identity!
    },
}), buildFeed)
```

`singleflight` only deduplicates requests that are *in flight at the same time* —
it is not a cache. Once the leader returns, the next request runs the handler
fresh. It's purely a stampede guard.

### `idempotency` — make retries safe

`idempotency` implements the HTTP `Idempotency-Key` pattern: a client sends a
unique key with a write request, and if it has to retry (network blip, timeout),
the server *replays the original response* instead of performing the operation
twice. By default it applies to `POST`, `PUT`, `PATCH`, `DELETE`; other methods
pass through. Source: `celeris/middleware/idempotency/idempotency.go:1-18`,
`config.go:37-39`.

```go
import "github.com/goceleris/celeris/middleware/idempotency"

s.Use(idempotency.New()) // in-memory store, "Idempotency-Key" header, 24h TTL
```

How it behaves for a given key:

- **First request** — acquires an atomic lock, runs the handler, stores the
  response under the key, releases.
- **Retry after completion** — replays the stored response (same status, headers,
  body). No second execution.
- **Concurrent duplicate while the first is still running** — returns `409
  Conflict` (override via `OnConflict`).
- **Handler crashed mid-flight** — the lock expires after `LockTimeout` (default
  30s) so the next request can retry.

Source: `celeris/middleware/idempotency/idempotency.go:70-200`.

#### The store needs `SetNX`

The store must implement both `store.KV` and `store.SetNXer` (atomic
set-if-not-exists) — `SetNX` is how the lock is acquired race-free. These two
interfaces are combined in the `idempotency.KVStore` type, which is the static
type of `Config.Store`, so a backend that lacks `SetNX` simply **won't compile**
when you assign it. The default in-memory store satisfies `KVStore` out of the
box; a Redis/Postgres store works too as long as it implements both interfaces.
Source: `celeris/middleware/idempotency/config.go:15-26`. When `Store` is left
nil, `New` installs the in-memory store. Source:
`celeris/middleware/idempotency/idempotency.go:47-49`.

```go
s.Use(idempotency.New(idempotency.Config{
    Store:       myRedisKVStore, // must implement store.KV + store.SetNXer
    TTL:         48 * time.Hour,
    LockTimeout: 1 * time.Minute,
    Methods:     []string{"POST", "PATCH"},
}))
```

#### `BodyHash` — catch key reuse with a different payload

A client that reuses an idempotency key with a *different* body is almost always
a bug. Set `BodyHash: true` to store a SHA-256 of the request body alongside the
response; on replay, a body mismatch returns `422 Unprocessable Entity`.
Source: `celeris/middleware/idempotency/config.go:50-53`,
`idempotency.go:104-110`.

```go
s.Use(idempotency.New(idempotency.Config{BodyHash: true}))
```

With `BodyHash` enabled, a request whose body exceeds `MaxBodyBytes` (default
1 MiB) is rejected with `413` before hashing, since the hash can't be computed
over a truncated body. Source: `celeris/middleware/idempotency/idempotency.go:89-95`.
On the leader path, a *response* larger than `MaxBodyBytes` is still served, but
it is not cached — the lock is released and later retries re-run the handler
rather than replaying. Source: `celeris/middleware/idempotency/idempotency.go:160-170`.

| Field | Type | Default | Purpose |
| ----- | ---- | ------- | ------- |
| `Store` | `KVStore` | in-memory | Persists responses + locks; needs `KV` + `SetNXer` |
| `KeyHeader` | `string` | `Idempotency-Key` | Header carrying the key |
| `TTL` | `time.Duration` | `24h` | Lifetime of a stored response |
| `LockTimeout` | `time.Duration` | `30s` | Lock lifetime (recovers crashed handlers) |
| `Methods` | `[]string` | `POST,PUT,PATCH,DELETE` | Methods the mw applies to |
| `OnConflict` | `func(*Context) error` | 409 | Response for an in-flight duplicate |
| `BodyHash` | `bool` | `false` | Reject key reuse with a different body (`422`) |
| `MaxBodyBytes` | `int` | `1 MiB` | Cap on hashed/stored body |
| `MaxKeyLength` | `int` | `255` | Max key header length (over → `400`) |
| `Skip` / `SkipPaths` | `func` / `[]string` | — | Bypass certain requests/paths |

> A missing key header just passes the request through — idempotency is opt-in
> per request. An invalid key (non-printable, or longer than `MaxKeyLength`)
> returns `400`. Source: `celeris/middleware/idempotency/idempotency.go:77-83`.

### When to use which

| Situation | Use |
| --------- | --- |
| Many concurrent **reads** of the same expensive resource | `singleflight` |
| A client may **retry a write** and must not double-charge | `idempotency` |
| Both — a write you also want to dedupe under concurrency | `idempotency` (it holds a lock; `singleflight` does not persist) |

They compose: `singleflight` in front collapses simultaneous duplicates;
`idempotency` behind it makes the surviving request's retries safe.

## Common pitfalls

- **Rate limiting by the wrong key.** Without the proxy middleware,
  `c.ClientIP()` is your load balancer's address, so all clients share one bucket.
  Install `proxy.New` with a correct `TrustedProxies` range, or supply a
  `KeyFunc` that keys on something you control (API key, user ID).
- **Distributed limit that isn't.** The default limiter is per-instance; N
  replicas means N× the limit. Use a `Store` (Redis/memcached) for a global cap.
- **`Rate` panics, `ValidateConfig` doesn't.** Load rate strings from config
  through `ratelimit.ValidateConfig` (or `ParseRate`) before calling `New`, which
  panics on a bad `Rate`.
- **Preemptive timeout on a streaming route.** Buffered mode captures the whole
  response — never combine it with `StreamWriter`/SSE. Use the non-preemptive
  default there.
- **Timeout with handlers that ignore `Done()`.** Non-preemptive mode can only
  *report* a deadline overrun, not interrupt it. Always pass `c.Context()`
  downstream and select on `Done()`.
- **`overload` without a CPU monitor.** `CollectorProvider` is required and the
  collector needs `SetCPUMonitor` — otherwise CPU reads as `-1` and the CPU
  ladder never escalates (depth/latency signals still work). And remember CPU
  alone misses I/O-bound overload; add `DepthThresholds`.
- **`bodylimit` is not a hard memory guard.** The body is already buffered before
  it runs. Pair it with `ContentLengthRequired: true` to reject undeclared bodies
  early.
- **`singleflight` cross-user leak.** A custom `KeyFunc` that omits identity will
  serve one user's data to another. Always include the user in the key.
- **`idempotency` store without `SetNX`.** A store that doesn't implement
  `store.SetNXer` can't be used — `Config.Store` is typed `idempotency.KVStore`
  (`store.KV` + `store.SetNXer`), so an incompatible store is a compile error,
  not a runtime surprise. Leave `Store` nil to get the in-memory default.

## FAQ

**Which status codes do these return?**
`ratelimit` → `429`; `circuitbreaker`, `timeout`, and `overload` → `503`;
`bodylimit` → `413` (too large) or `411` (length required); `idempotency` → `409`
on an in-flight conflict, `422` on a body-hash mismatch, `400` on a bad key, and
(with `BodyHash`) `413` on a request body over `MaxBodyBytes`. Most are
customizable via the relevant `ErrorHandler`/`OnConflict`.

**Can I match all "service unavailable" causes with one `errors.Is`?**
Yes. `circuitbreaker.ErrServiceUnavailable` and `timeout.ErrServiceUnavailable`
both alias `celeris.ErrServiceUnavailable`, so
`errors.Is(err, celeris.ErrServiceUnavailable)` matches both.

**Do I install these globally or per route?**
Either. `s.Use(...)` applies to every route; `group.Use(...)` scopes to a group;
passing the handler as a leading argument to `s.GET(...)` scopes it to one route.
Scope the circuit breaker to the routes that call the flaky dependency, not the
whole server. See [Middleware](/docs/middleware) and [Routing](/docs/routing).

**How do these interact with async handlers?**
They're ordinary middleware and run in the chain regardless of dispatch mode. For
blocking I/O handlers wrapped by `timeout`/`circuitbreaker`, mark the route
`.Async()` so the blocking call runs off the event loop — see [Routing](/docs/routing).

**Where do the overload CPU samples come from?**
From the server's `observe.Collector` with a `CPUMonitor` attached
(`observe.NewCPUMonitor()`). The collector is created automatically unless
`Config.DisableMetrics` is set; see [Configuration](/docs/configuration).

## See also

- [Middleware](/docs/middleware) — the full in-tree catalog and ordering model,
  plus the `proxy` middleware that makes `ClientIP()` trustworthy.
- [Configuration](/docs/configuration) — server timeouts, `maxRequestBodySize`,
  the metrics collector, and `DisableMetrics`.
- [Routing](/docs/routing) — per-route middleware and the `Async`/`Sync` dispatch
  model.
- [Streaming, SSE & WebSocket](/docs/streaming) — why preemptive timeouts and
  streaming don't mix.
