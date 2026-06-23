---
title: Observability
description: Logging, request IDs, metrics (built-in Collector, Prometheus, OpenTelemetry), and profiling.
group: Operations
order: 3
---

Observability in Celeris is built from small, composable pieces: a structured
logger, request IDs that thread through every log line, three independent metrics
systems, and loopback-only profiling and diagnostics endpoints. This page covers
each one, when to reach for it, and how they fit together.

A few rules up front:

- **Logging** is `slog`-based. The server has a default logger
  (`Config.Logger`), and the `middleware/logger` package gives you per-request
  access logs on top of it.
- **Metrics** come from three systems that count the *same* traffic
  independently — the built-in `observe.Collector`, Prometheus, and
  OpenTelemetry. Pick one as your source of truth. Never add their numbers
  together.
- **Profiling and diagnostics** (`middleware/pprof`, `middleware/debug`) are
  **loopback-only by default**. They only answer requests from `127.0.0.1` /
  `::1` unless you replace the `AuthFunc`.

## Three metrics systems — pick one source of truth

Celeris ships three complementary measurement systems. They serve different
operational needs and **record the same request independently**.

| System | Import | Best for | Dependencies |
| --- | --- | --- | --- |
| Built-in Collector | `github.com/goceleris/celeris/observe` | Lightweight internal diagnostics, health checks, the `/debug/celeris` endpoint | None (in-tree) |
| Prometheus | `github.com/goceleris/celeris/middleware/metrics` | Production monitoring, Grafana, SLO/alerting | Separate Go module |
| OpenTelemetry | `github.com/goceleris/celeris/middleware/otel` | Distributed tracing, cross-service correlation, OTLP backends (Jaeger, Tempo, …) | Separate Go module |

The framework documents this overlap explicitly in
`celeris/middleware/doc.go` ("Counter overlap"):

> Each system records the same request independently — the Collector's
> `RequestsTotal`, Prometheus's `celeris_requests_total`, and OTel's
> `http.server.request.duration` count are **NOT** shared. Enabling all three
> gives three independent views of the same traffic; do **NOT** add numbers
> across systems. Pick one as the source of truth for a given chart, alert, or
> SLO.

The built-in Collector counts **everything** that reaches the server, including
unmatched routes and panic recoveries. The Prometheus and OTel middleware only
count requests that flow through them in the chain, so where you place them
affects what they see (see [Ordering](#recommended-ordering)).

## Built-in metrics — the Collector

The server creates an `observe.Collector` **eagerly in `New`** unless you set
`Config.DisableMetrics: true` (`celeris/config.go:133`, `celeris/server.go:99`).
It uses lock-free, cache-line-padded counters sharded per worker, so recording is
cheap on the hot path.

### Getting the Collector

`Server.Collector()` returns the live collector, or `nil` only when metrics are
disabled via `DisableMetrics` (`celeris/server.go:543`). Because the collector is
created in `New`, it is non-nil immediately — you do **not** need to wait for
`Start`. Engine-derived fields (`ActiveConns`, `EngineMetrics`), however, stay
zero until the server is running and the engine is wired:

```go
s := celeris.New(celeris.Config{Addr: ":8080"})

// Collector() is already non-nil here (DisableMetrics is false).
col := s.Collector()
if col != nil {
    snap := col.Snapshot()
    fmt.Printf("requests=%d errors=%d active=%d\n",
        snap.RequestsTotal, snap.ErrorsTotal, snap.ActiveConns)
}
```

> **Pitfall:** `Collector()` returns `nil` only when `DisableMetrics` is true —
> still nil-check it before dereferencing. The `middleware/debug` `/metrics`
> endpoint returns `501 Not Implemented` when no collector is wired in
> (`celeris/middleware/debug/debug.go:197`).

### Reading a Snapshot

`Collector.Snapshot()` returns a point-in-time copy of all counters
(`celeris/observe/collector.go:187`). All fields are read-only values captured
at the moment of the call.

| Field | Type | Meaning |
| --- | --- | --- |
| `RequestsTotal` | `uint64` | Cumulative requests handled. |
| `ErrorsTotal` | `uint64` | Cumulative requests that returned HTTP 5xx. |
| `ActiveConns` | `int64` | Currently open connections (from engine metrics). |
| `EngineSwitches` | `uint64` | Times the adaptive engine changed strategies. |
| `LatencyBuckets` | `[]uint64` | Request counts per latency histogram bucket. |
| `BucketBounds` | `[]float64` | Upper-bound thresholds (seconds) for each bucket. |
| `EngineMetrics` | `observe.EngineMetrics` | Underlying engine's own counters (see below). |
| `CPUUtilization` | `float64` | System CPU utilization in `[0.0, 1.0]`, or `-1` if no CPU monitor is configured or sampling failed. |

The histogram is paired: `LatencyBuckets[i]` is the count of requests whose
latency was `<= BucketBounds[i]` seconds (the final bucket is the overflow).
The default bounds are `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5`
seconds (`celeris/observe/collector.go:13`).

```go
snap := s.Collector().Snapshot()

for i, count := range snap.LatencyBuckets {
    if i < len(snap.BucketBounds) {
        fmt.Printf("<= %.3fs: %d\n", snap.BucketBounds[i], count)
    } else {
        fmt.Printf("overflow: %d\n", count)
    }
}

if snap.CPUUtilization >= 0 {
    fmt.Printf("cpu: %.1f%%\n", snap.CPUUtilization*100)
}
```

### EngineMetrics

`Snapshot.EngineMetrics` (and `Server.EngineInfo().Metrics`) expose the I/O
engine's own counters (`celeris/engine/engine.go:85`). These are the same
counters the adaptive controller reads to pick an engine.

| Field | Type | Meaning |
| --- | --- | --- |
| `RequestCount` | `uint64` | Cumulative requests handled by the engine. |
| `ActiveConnections` | `int64` | Currently open connections. |
| `ErrorCount` | `uint64` | Cumulative connection/protocol-level errors. |
| `Throughput` | `float64` | Recent requests-per-second rate. |
| `AsyncRoutes` | `int` | Routes registered with `.Async(true)`. |
| `AsyncPromotedConns` | `uint64` | Connections promoted to the per-conn dispatch goroutine. |
| `Workers` | `int` | Number of I/O workers / event loops. |
| `AcceptCount` | `uint64` | Cumulative connections accepted. |
| `CloseCount` | `uint64` | Cumulative connections closed. |
| `BytesRead` / `BytesWritten` | `uint64` | Cumulative payload bytes in / out. |

### EngineInfo

If you only want engine-level info (not the request histogram),
`Server.EngineInfo()` returns the active engine type and its metrics, or `nil`
if the server isn't started (`celeris/server.go:500`):

```go
if info := s.EngineInfo(); info != nil {
    fmt.Printf("engine=%v workers=%d active=%d\n",
        info.Type, info.Metrics.Workers, info.Metrics.ActiveConnections)
}
```

`EngineInfo.Type` is the active `EngineType` (`IOUring`, `Epoll`, `Adaptive`,
or `Std`) — see [Engines](/docs/engines).

### Exposing built-in metrics

The collector has no HTTP endpoint of its own. To expose it, either serve a
`Snapshot()` from a handler, or wire it into the `/debug/celeris/metrics`
endpoint (see [Profiling & diagnostics](#profiling--diagnostics)). The `Context`
has no accessor for the server, so capture the collector (or the `*Server`) in a
closure when you register the route:

```go
col := s.Collector() // non-nil unless DisableMetrics is set
s.GET("/internal/metrics", func(c *celeris.Context) error {
    if col == nil {
        return c.NoContent(503)
    }
    return c.JSON(200, col.Snapshot())
})
```

## Structured logging

The `middleware/logger` package emits one structured `slog` record per request.
It is intentionally rich and zero-alloc on the steady-state path.

### The server-level logger

`Config.Logger` is the server's structured logger; it defaults to
`slog.Default()` when nil (`celeris/config.go:197`). This logger is used by the
server itself (and is the default sink for several middleware, including
`recovery` — see [Error handling](/docs/error-handling)). Set it once at
construction:

```go
import "log/slog"

handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
s := celeris.New(celeris.Config{
    Addr:   ":8080",
    Logger: slog.New(handler),
})
```

### Request access logs

Install `logger.New()` to log every request (`celeris/middleware/logger/logger.go:24`).
With no config its `Output` defaults to `slog.Default()` and it uses the default
level mapping (`celeris/middleware/logger/config.go:209`):

```go
import "github.com/goceleris/celeris/middleware/logger"

s.Use(logger.New())
```

Every entry carries these base attributes (always emitted):
`method`, `path`, `status`, `latency`, `bytes`. When present, the middleware also
adds `client_ip`, `request_id` (from [Request IDs](#request-ids)), and `error`
(the handler's returned error string). Source:
`celeris/middleware/logger/logger.go:116`.

#### Level mapping

`Config.Level` maps a response status code to a `slog.Level`. The default maps
5xx → `Error`, 4xx → `Warn`, everything else → `Info`
(`celeris/middleware/logger/config.go:222`). Override it to, say, treat 404s as
info:

```go
s.Use(logger.New(logger.Config{
    Level: func(status int) slog.Level {
        if status == 404 {
            return slog.LevelInfo
        }
        if status >= 500 {
            return slog.LevelError
        }
        return slog.LevelInfo
    },
}))
```

#### Optional fields

Each of these is an opt-in boolean (or list) on `logger.Config`. They are off by
default to keep entries compact (`celeris/middleware/logger/config.go`):

| Field | Type | Adds attr | Notes |
| --- | --- | --- | --- |
| `LogHost` | `bool` | `host` | Request `Host` header. |
| `LogUserAgent` | `bool` | `user_agent` | |
| `LogReferer` | `bool` | `referer` | |
| `LogRoute` | `bool` | `route` | Matched pattern from `c.FullPath()`; omitted on 404. |
| `LogPID` | `bool` | `pid` | Process ID, cached at init. |
| `LogQueryParams` | `bool` | `query` | Raw query string. |
| `LogFormValues` | `bool` | `form` | Only for `application/x-www-form-urlencoded`; redact via `SensitiveFormFields`. |
| `LogCookies` | `bool` | `cookies` | Cookie **names** only — values omitted for security. |
| `LogBytesIn` | `bool` | `bytes_in` | Request `Content-Length`. |
| `LogScheme` | `bool` | `scheme` | e.g. `https`. |
| `LogResponseHeaders` | `[]string` | `resp_header.<name>` | Named response headers, case-insensitive. |
| `LogContextKeys` | `[]string` | `ctx.<key>` | Values pulled from the context store via `c.Get`. |

#### Callbacks

| Field | Signature | When |
| --- | --- | --- |
| `Skip` | `func(c *celeris.Context) bool` | Return true to skip logging this request entirely. |
| `SkipPaths` | `[]string` | Exact-match paths to exclude (no glob/prefix). |
| `Fields` | `func(c, latency) []slog.Attr` | Append custom attrs; called after the handler returns. |
| `Done` | `func(c, latency, status)` | Always invoked, even when the log level is disabled — handy for alerting on 5xx outside the log pipeline. |

```go
s.Use(logger.New(logger.Config{
    LogRoute:     true,
    LogUserAgent: true,
    Fields: func(c *celeris.Context, latency time.Duration) []slog.Attr {
        return []slog.Attr{slog.String("tenant", c.Header("x-tenant-id"))}
    },
    Done: func(c *celeris.Context, latency time.Duration, status int) {
        if status >= 500 {
            metrics.Increment("server_errors") // your alerting hook
        }
    },
}))
```

### Capturing bodies

`CaptureRequestBody` and `CaptureResponseBody` log the request/response body
(attrs `request_body` / `response_body`), each truncated to `MaxCaptureBytes`
(default 4096) (`celeris/middleware/logger/config.go:93`). Response capture
requires the response to be buffered, which the middleware enables via
`c.CaptureResponse()` automatically.

```go
s.Use(logger.New(logger.Config{
    CaptureRequestBody:  true,
    CaptureResponseBody: true,
    MaxCaptureBytes:     2048,
}))
```

> **Pitfall:** body capture buffers payloads and logs raw content — keep
> `MaxCaptureBytes` small and combine with redaction. A negative
> `MaxCaptureBytes` with capture enabled **panics** at construction.

### Redaction — `nil` vs `[]string{}` semantics

This is the single most important thing to get right in the logger. **Header and
form-field redaction have asymmetric defaults**
(`celeris/middleware/logger/config.go:107` and `:180`):

| Setting | `nil` (unset) | `[]string{}` (empty) | non-empty |
| --- | --- | --- | --- |
| `SensitiveHeaders` | **Default list is used** (`authorization`, `cookie`, `set-cookie`, `x-api-key`) | **Redaction disabled** | Only the listed headers are redacted |
| `SensitiveFormFields` | **No redaction** (every form value logged verbatim) | No redaction | Only the listed fields are redacted |

So for headers, `nil` is safe (defaults apply). For form fields, `nil` is
**dangerous** — if you set `LogFormValues: true` without setting
`SensitiveFormFields`, passwords and tokens are logged in the clear. Always pass
a list when logging form values:

```go
s.Use(logger.New(logger.Config{
    LogFormValues:       true,
    SensitiveFormFields: logger.DefaultSensitiveFormFields(), // password, token, ssn, …
}))
```

Helpers `logger.DefaultSensitiveHeaders()` and
`logger.DefaultSensitiveFormFields()` return fresh copies of the built-in lists
(`celeris/middleware/logger/config.go:25` and `:55`). Redacted values are
replaced with `[REDACTED]`. Note that **every configured sensitive header is
always emitted as `[REDACTED]`**, present or not — a constant-presence design
that avoids leaking which headers a request carried
(`celeris/middleware/logger/logger.go:231`).

### Presets — CLF and JSON

Two preset configs are provided (`celeris/middleware/logger/config.go:243`,
`:283`):

```go
// Combined / Common Log Format — emits a single "clf" attr per request.
s.Use(logger.New(logger.CLFConfig()))

// Structured JSON to stdout (LogHost, LogUserAgent, LogReferer, LogRoute,
// LogQueryParams all on; uses slog.NewJSONHandler).
s.Use(logger.New(logger.JSONConfig()))
```

### FastHandler — zero-alloc text output

`FastHandler` is a high-performance `slog.Handler` that formats records directly
into a pooled buffer with zero steady-state allocations, producing
`slog.TextHandler`-compatible output (`celeris/middleware/logger/fasthandler.go:21`).
The logger middleware has a fast path that bypasses `slog.Record` entirely when
the output uses `FastHandler`.

```go
import (
    "log/slog"
    "os"

    "github.com/goceleris/celeris/middleware/logger"
)

fh := logger.NewFastHandler(os.Stderr, &logger.FastHandlerOptions{
    Level: slog.LevelInfo,
    Color: true, // ANSI colors for status/method/latency on a terminal
})
s.Use(logger.New(logger.Config{Output: slog.New(fh)}))
```

`FastHandlerOptions`:

| Field | Type | Meaning |
| --- | --- | --- |
| `Level` | `slog.Level` | Minimum level (default `Info`). |
| `Color` | `bool` | ANSI colors: red=ERROR, yellow=WARN, green=INFO, cyan=DEBUG; status/method/latency are colored too. |
| `TimeFormat` | `string` | Custom Go time layout; empty uses the built-in zero-alloc RFC3339-millis formatter. |

Two related `Config` knobs interact with it: `DisableColors` forces plain text
(useful for log files/CI), and `TimeFormat` sets the layout for FastHandler
output. When `FastHandler`'s writer is `io.Discard`, the handler reports
`Enabled() == false` and short-circuits all formatting — letting you keep
per-request instrumentation (request-id propagation, latency, redaction) with no
log output, which is exactly what benchmarks use
(`celeris/middleware/logger/fasthandler.go:123`).

## Request IDs

`middleware/requestid` assigns a unique ID to every request, stores it on the
context, and echoes it in a response header. The `logger` middleware then
automatically includes it as the `request_id` attr, so install requestid
**before** logger (`celeris/middleware/requestid/requestid.go:60`).

```go
import "github.com/goceleris/celeris/middleware/requestid"

s.Use(requestid.New())
s.Use(logger.New()) // logs now carry request_id
```

### Reading the ID

From inside a handler, prefer `c.RequestID()`. The package also exposes
helpers:

```go
import (
    "context"

    "github.com/goceleris/celeris/middleware/requestid"
)

func handler(c *celeris.Context) error {
    id := requestid.FromContext(c) // reads from the context store

    // If EnableStdContext is on, the ID is also in the stdlib context,
    // reachable by code that only has a context.Context:
    _ = func(ctx context.Context) string { return requestid.FromStdContext(ctx) }
    return c.JSON(200, map[string]string{"id": id})
}
```

- `requestid.FromContext(c)` reads the ID from the Celeris context store
  (`celeris/middleware/requestid/requestid.go:38`).
- `requestid.FromStdContext(ctx)` reads it from a stdlib `context.Context` —
  but **only works if `EnableStdContext` is true** (see below)
  (`celeris/middleware/requestid/requestid.go:17`).
- `requestid.ContextKey` is the store key (`"request_id"`).

### Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Generator` | `func() string` | Buffered UUID v4 | Produces new IDs. Custom generators are validated and retried up to 3 times, then fall back to UUID. |
| `Header` | `string` | `x-request-id` | Header read on the way in and written on the way out. |
| `DisableTrustProxy` | `bool` | `false` | When `false` (default), an inbound request-ID header is **trusted** and reused. Set `true` to always generate a fresh ID. |
| `EnableStdContext` | `bool` | `false` | Also store the ID in the stdlib `context.Context` (costs one alloc/request). Required for `FromStdContext`. |
| `Skip` / `SkipPaths` | — | — | Skip the middleware per request / for exact paths. |

> **Pitfall — propagation and trust:** by default Celeris **trusts** an inbound
> `x-request-id`. This is what you want behind a trusted proxy or gateway that
> assigns IDs at the edge. If clients are untrusted, set
> `DisableTrustProxy: true` so a client can't spoof or collide IDs:

```go
s.Use(requestid.New(requestid.Config{
    DisableTrustProxy: true, // never trust the inbound header
    EnableStdContext:  true, // make ID visible to db drivers, etc.
}))
```

Inbound IDs are validated regardless: an ID must be 1–128 printable-ASCII bytes
or it is discarded and regenerated (`celeris/middleware/requestid/requestid.go:43`).

## Prometheus (separate module)

The `middleware/metrics` package is a **separate Go module** — add it
explicitly:

```bash
go get github.com/goceleris/celeris/middleware/metrics
```

It serves a Prometheus exposition endpoint (default `/metrics`) and records
per-request metrics (`celeris/middleware/metrics/metrics.go:30`):

```go
import "github.com/goceleris/celeris/middleware/metrics"

s.Use(metrics.New(metrics.Config{
    Namespace: "myapp",
}))
// curl localhost:8080/metrics
```

### Metrics emitted

All carry the base labels `method`, `path`, `status` (plus any custom labels),
namespaced by `Namespace` (default `celeris`). Setting `Subsystem` inserts a
second prefix, so the names become `<ns>_<sub>_…`:

| Metric | Type | Description |
| --- | --- | --- |
| `<ns>_requests_total` | Counter | Total HTTP requests. |
| `<ns>_request_duration_seconds` | Histogram | Request duration (uses `Buckets`). |
| `<ns>_request_size_bytes` | Histogram | Request body size (uses `SizeBuckets`). |
| `<ns>_response_size_bytes` | Histogram | Response body size (uses `SizeBuckets`). |
| `<ns>_active_requests` | Gauge | Currently in-flight requests. |

`path` uses the matched route pattern (`c.FullPath()`), so high-cardinality
path params don't explode your label space — `404` requests are labeled
`<unmatched>`.

### Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Path` | `string` | `/metrics` | Endpoint path. Only `GET`/`HEAD` are served. |
| `Namespace` | `string` | `celeris` | Metric name prefix. |
| `Subsystem` | `string` | `""` | Second-level name prefix. |
| `Buckets` | `[]float64` | `DefaultBuckets()` | Duration histogram bounds (must be ascending). |
| `SizeBuckets` | `[]float64` | exponential byte buckets | Size histogram bounds. |
| `Registry` | `*prometheus.Registry` | dedicated registry w/ Go + process collectors | Bring your own registry. |
| `ConstLabels` | `map[string]string` | — | Constant labels on every metric (service, env, …). |
| `LabelFuncs` | `map[string]func(*celeris.Context) string` | — | Custom label dimensions. Keys `method`/`path`/`status` are reserved (panic on conflict). |
| `AuthFunc` | `func(c *celeris.Context) bool` | nil (open) | Gate the endpoint; `false` → `403`. |
| `IgnoreStatusCodes` | `[]int` | — | Drop matching responses from all metrics (e.g. `404` scanner noise). |
| `Skip` / `SkipPaths` | — | — | Skip recording per request / for exact paths. |

```go
s.Use(metrics.New(metrics.Config{
    Namespace:   "myapp",
    ConstLabels: map[string]string{"service": "api", "env": "prod"},
    Buckets:     metrics.DefaultBuckets(),
    LabelFuncs: map[string]func(*celeris.Context) string{
        "tenant": func(c *celeris.Context) string { return c.Header("x-tenant-id") },
    },
    AuthFunc: func(c *celeris.Context) bool {
        return c.Header("authorization") == "Bearer "+scrapeToken
    },
    IgnoreStatusCodes: []int{404},
}))
```

> The metrics endpoint itself is never recorded, regardless of `SkipPaths`.

## OpenTelemetry (separate module)

The `middleware/otel` package is also a **separate Go module**:

```bash
go get github.com/goceleris/celeris/middleware/otel
```

It creates a server span per request with W3C trace-context propagation and
(optionally) OTel metrics, exporting to whatever providers you've configured
globally (`celeris/middleware/otel/otel.go:90`). By default it uses the global
providers, so configure your tracer/meter/propagator once via the OTel SDK and
just install the middleware:

```go
import "github.com/goceleris/celeris/middleware/otel"

// otel.SetTracerProvider(...), otel.SetMeterProvider(...),
// otel.SetTextMapPropagator(...) configured elsewhere via the OTel SDK.

s.Use(otel.New())
```

### Spans and metrics

Each request produces a server-kind span named `"METHOD /route"` with standard
HTTP semantic-convention attributes (method, route, scheme, path, protocol
version, server address, response status/size). The request ID is added as a
`request.id` span attribute when present (`celeris/middleware/otel/otel.go:235`).
When metrics are enabled (the default), it also records
`http.server.request.duration`, `http.server.active_requests`,
`http.server.request.body.size`, and `http.server.response.body.size`.

### Reading the active span

`otel.SpanFromContext(c)` returns the active span so you can add attributes or
events from a handler (`celeris/middleware/otel/otel.go:85`):

```go
func handler(c *celeris.Context) error {
    span := otel.SpanFromContext(c)
    span.AddEvent("cache.miss")
    span.SetAttributes(attribute.String("user.tier", "premium"))
    return c.JSON(200, payload)
}
```

### Configuration & PII toggles

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `TracerProvider` | `trace.TracerProvider` | global | Tracer source. |
| `MeterProvider` | `metric.MeterProvider` | global | Meter source. |
| `Propagators` | `propagation.TextMapPropagator` | global | Context inject/extract. |
| `SpanNameFormatter` | `func(c) string` | `"METHOD /route"` | Custom span name. |
| `Filter` | `func(c) bool` | nil | Allow-list (inverse of `Skip`): `false` → skip. |
| `DisableMetrics` | `bool` | `false` | Tracing only, no metric instruments. |
| `CollectClientIP` | `bool` | `false` | Add `client.address`. **PII opt-in.** |
| `CollectUserAgent` | `*bool` | `true` | Add `user_agent.original` (set `*false` to disable). |
| `CustomAttributes` | `func(c) []attribute.KeyValue` | — | Extra span attributes per request. |
| `CustomMetricAttributes` | `func(c) []attribute.KeyValue` | — | Extra metric attributes per request. |
| `ServerPort` | `int` | `0` | Add `server.port` when `> 0`. |
| `Skip` / `SkipPaths` | — | — | Skip per request / for exact paths. |

> **PII note:** `client.address` is **off by default** (opt in via
> `CollectClientIP`), and `url.query` is **never** added to spans because query
> strings frequently carry tokens, emails, and session IDs. If you need the
> query string, add it yourself via `CustomAttributes`
> (`celeris/middleware/otel/config.go:65`).

```go
disableUA := false
s.Use(otel.New(otel.Config{
    CollectClientIP:  true,           // accept the PII tradeoff
    CollectUserAgent: &disableUA,     // *false → off
    ServerPort:       8080,
    CustomAttributes: func(c *celeris.Context) []attribute.KeyValue {
        return []attribute.KeyValue{attribute.String("deployment", "blue")}
    },
}))
```

## Profiling & diagnostics

Two middleware expose runtime internals over HTTP. Both default to
**loopback-only** access — they reject any non-`127.0.0.1` / non-`::1` client
with `403` unless you replace `AuthFunc`.

### pprof

`middleware/pprof` mounts the standard `net/http/pprof` handlers under
`/debug/pprof` (`celeris/middleware/pprof/pprof.go:32`). It is part of the main
module (no extra `go get`).

```go
import "github.com/goceleris/celeris/middleware/pprof"

s.Use(pprof.New())
// from the same host only, by default:
//   go tool pprof http://localhost:8080/debug/pprof/heap
//   curl http://localhost:8080/debug/pprof/profile?seconds=30 > cpu.pprof
```

Available endpoints: `index`, `cmdline`, `profile`, `symbol`, `trace`,
`allocs`, `block`, `goroutine`, `heap`, `mutex`, `threadcreate`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Prefix` | `string` | `/debug/pprof` | URL prefix. Must start with `/`, must not be `/`. |
| `AuthFunc` | `func(c) bool` | loopback-only | Return `false` → `403`. |
| `Skip` / `SkipPaths` | — | — | Bypass per request / for exact paths. |

> **Pitfall:** to expose pprof off-box (e.g. through a bastion) you must replace
> `AuthFunc` — `func(*celeris.Context) bool { return true }` opens it to the
> world. Never do that on a public listener; gate it behind real auth or keep it
> loopback and tunnel in.

### debug — `/debug/celeris` JSON

`middleware/debug` serves a JSON diagnostics tree under `/debug/celeris`,
loopback-only by default (`celeris/middleware/debug/debug.go:75`). Part of the
main module.

```go
import (
    "github.com/goceleris/celeris/middleware/debug"
)

s.Use(debug.New(debug.Config{
    Server:    s,             // enables /routes
    Collector: s.Collector(), // enables /metrics (else 501)
}))
```

Endpoints (each returns JSON; `GET`/`HEAD` only):

| Path | Returns |
| --- | --- |
| `/debug/celeris` | Index listing of enabled endpoints. |
| `/debug/celeris/status` | `uptime`, `go_version`. |
| `/debug/celeris/metrics` | The Collector `Snapshot` — or `501` if no `Collector` is configured. |
| `/debug/celeris/config` | `go_version`, `go_os`, `go_arch`, `num_cpu`, `goroutines`. |
| `/debug/celeris/routes` | Registered routes via `Server.Routes()` — empty if no `Server` is set. |
| `/debug/celeris/memory` | `alloc`, `total_alloc`, `sys`, `heap_inuse`, `heap_idle`, `num_gc`, `gc_cpu_fraction` (cached, see `MemStatsTTL`). |
| `/debug/celeris/build` | Main module path, Go version, VCS metadata. |
| `/debug/celeris/runtime` | `goroutines`, `num_cpu`, `gomaxprocs`. |

| Config field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Prefix` | `string` | `/debug/celeris` | URL prefix (must start with `/`). |
| `AuthFunc` | `func(c) bool` | loopback-only | `false` → `403`. |
| `Server` | `*celeris.Server` | nil | Enables `/routes`. Nil is safe (empty list). |
| `Collector` | `*observe.Collector` | nil | Enables `/metrics`. Nil → `/metrics` returns `501`. |
| `Endpoints` | `map[string]bool` | nil (all on) | Selectively enable/disable named endpoints. |
| `MemStatsTTL` | `time.Duration` | `1s` | Cache window for `/memory` (`ReadMemStats` stops the world). Floored at `100ms`. |
| `Skip` / `SkipPaths` | — | — | Bypass per request / for exact paths. |

To enable only a subset of endpoints:

```go
s.Use(debug.New(debug.Config{
    Server:    s,
    Collector: s.Collector(),
    Endpoints: map[string]bool{
        "status":  true,
        "metrics": true,
        "routes":  true,
        // memory/build/config/runtime omitted → disabled
    },
}))
```

> **Pitfall — `/memory` is expensive.** `runtime.ReadMemStats` triggers a
> stop-the-world pause; the endpoint caches results for `MemStatsTTL`
> (default 1s, floored at 100ms) so scraping it in a tight loop won't storm the
> runtime with STW pauses.

## Recommended ordering

Place observability middleware early so the rest of the chain is instrumented,
and assign request IDs first so every downstream log carries them. This mirrors
the ordering in `celeris/middleware/doc.go`:

```go
s.Use(requestid.New())               // 1. assign ID first
s.Use(metrics.New(metrics.Config{})) // 2. Prometheus (or otel) — can also follow logger
s.Use(logger.New())                  // 3. access log, includes the request_id
s.Use(recovery.New())                // 4. catch panics below; logger records the 500
// ... auth, business middleware ...
s.Use(debug.New(debug.Config{Server: s, Collector: s.Collector()}))
s.Use(pprof.New())
```

Because `debug` and `pprof` intercept by path prefix, their position in the
chain is flexible — but keep them after security/auth middleware if you ever
loosen their loopback default.

## Common pitfalls

- **Summing across systems.** The Collector, Prometheus, and OTel each count
  the same traffic independently. Pick one as the source of truth per
  chart/alert; never add their counters.
- **`Collector()` is `nil` only when `DisableMetrics: true`.** It is created
  eagerly in `New`, so it's non-nil before `Start` — but always nil-check before
  dereferencing. Engine-derived fields stay zero until the server is running.
- **Form-value redaction defaults to OFF.** `SensitiveFormFields: nil` logs
  every form value in the clear. Pass `logger.DefaultSensitiveFormFields()`
  whenever `LogFormValues: true`.
- **Header redaction `[]string{}` disables it.** For `SensitiveHeaders`, `nil`
  means "use defaults" but an explicit empty slice means "redact nothing."
- **Request-ID spoofing.** The inbound `x-request-id` is trusted by default. Set
  `DisableTrustProxy: true` for untrusted clients.
- **`FromStdContext` returns `""`** unless `EnableStdContext: true`.
- **pprof/debug are loopback-only.** Don't `return true` from `AuthFunc` on a
  public listener.
- **Where you place metrics/otel decides what they count** — middleware below
  them in the chain isn't measured by them, unlike the always-on Collector.

## FAQ

**Do I need Prometheus and OTel both?** No. They are independent. Many teams run
Prometheus for SLOs and OTel for tracing; that's fine, just don't reconcile
their numbers — treat each as its own source of truth.

**How do I get latency percentiles from the built-in Collector?** It exposes a
fixed-bound histogram (`LatencyBuckets` / `BucketBounds`), not exact
percentiles. Compute approximate percentiles from the buckets, or use Prometheus
/ OTel histograms for `histogram_quantile`-style queries.

**Can I disable metrics entirely?** Yes — set `Config.DisableMetrics: true`.
`Server.Collector()` then returns `nil` and per-request recording is skipped.

**Why is `CPUUtilization` `-1`?** No CPU monitor is configured, or sampling
failed. It is a valid sentinel — check `>= 0` before using it.

**How do I log without producing output (for benchmarking middleware cost)?**
Point a `FastHandler` at `io.Discard`; it short-circuits formatting while
keeping request-id propagation, latency capture, and redaction logic active.

## Related pages

- [Middleware](/docs/middleware) — the middleware chain, ordering, and the full
  catalog.
- [Error handling](/docs/error-handling) — the `recovery` middleware logs panics
  through `Config.Logger`.
- [Engines](/docs/engines) — what `EngineInfo`/`EngineMetrics` report and how the
  adaptive engine uses them.
- [Configuration](/docs/configuration) — `Config.Logger`, `Config.DisableMetrics`,
  and `Config.TrustedProxies`.
- [Deployment & TLS](/docs/deployment) — running behind proxies and exposing
  metrics safely.
