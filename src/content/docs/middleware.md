---
title: Middleware
description: How middleware works in Celeris, the install model, ordering rules, and the full catalog.
group: Middleware
order: 1
---

Middleware in Celeris is just a `HandlerFunc` — the exact same signature as a route
handler, `func(c *celeris.Context) error`. A middleware does some work, calls
`c.Next()` to run the rest of the chain, then optionally does more work on the way
back out. Because there is no separate middleware type, anything you can do in a
handler you can do in middleware, and the catalog packages are nothing more than
constructors that return a `HandlerFunc`.

This page is the hub: it covers the execution model, the install points and their
ordering rules, the conventions every catalog package shares, the recommended
install order, the full catalog, and net/http interop. For the mechanics of
attaching middleware to individual routes and groups, see [Routing](/docs/routing).

## The model

A middleware is wrapped around the handlers that follow it. The chain runs
**outside-in** on the way in and **inside-out** on the way out:

```go
func Timing(c *celeris.Context) error {
    start := time.Now()        // 1. pre-work, before downstream handlers

    err := c.Next()            // 2. run the rest of the chain

    dur := time.Since(start)   // 3. post-work, after downstream handlers returned
    c.SetHeader("x-elapsed", dur.String())
    return err                 // 4. propagate (or swallow) the downstream error
}

s.Use(Timing)
```

`Context.Next()` advances to and runs the next handler in the chain, returning the
**first non-nil error** from anything downstream and short-circuiting the rest
(`celeris/context.go:309`). A middleware can inspect or swallow that error simply by
choosing what to return.

### Short-circuiting

There are three ways to stop the chain early:

| Technique                        | What happens                                                                 |
| -------------------------------- | --------------------------------------------------------------------------- |
| **Return without calling `Next`**| Downstream handlers never run; whatever you wrote (or returned) is final.    |
| **`c.Abort()`**                  | Sets the chain index past the end so no pending handler runs. Writes nothing on its own — write a response first. (`celeris/context.go:323`) |
| **`c.AbortWithStatus(code)`**    | Calls `Abort()` and sends an empty-body status code. Returns the error for propagation. (`celeris/context.go:330`) |

```go
// A guard that rejects unauthenticated requests and stops the chain.
func RequireAuth(c *celeris.Context) error {
    if c.Header("authorization") == "" {
        // Return WITHOUT c.Next(): the route handler never runs.
        return celeris.NewHTTPError(401, "missing credentials")
    }
    return c.Next()
}
```

`c.IsAborted()` reports whether the chain was aborted (`celeris/context.go:337`),
which downstream middleware can check before doing expensive work.

> Returning an error and aborting are different things. Returning a non-nil error
> hands control to error handling (see [Responses](/docs/responses) and `OnError`
> below) but the chain has already unwound. `Abort()` prevents *pending* handlers
> from running at all. Most guards return an error and never call `Next()`, which
> achieves both: nothing downstream runs and the error flows to your error handler.

### Passing data from a middleware to a handler

Middleware often computes something the handler needs — an authenticated user, a
tenant, a trace tag. Stash it in the per-request store with `c.SetString` (or
`c.Set` for non-strings) on the way in, then read it downstream. Reads return a
`(value, ok bool)` pair — `ok` is `false` when the key was never set, so you don't
mistake a missing value for an empty one:

```go
// Middleware: resolve the tenant and stash it.
func Tenant(c *celeris.Context) error {
    c.SetString("tenant", c.Header("x-tenant")) // string value
    c.Set("requestStart", time.Now())           // any value
    return c.Next()
}

// Handler: read it back, checking the bool.
func listItems(c *celeris.Context) error {
    tenant, ok := c.GetString("tenant")
    if !ok {
        return celeris.NewHTTPError(400, "missing tenant")
    }
    start, _ := c.Get("requestStart") // (any, bool); type-assert as needed
    _ = start.(time.Time)
    return c.JSON(200, map[string]string{"tenant": tenant})
}
```

Note `GetString` returns `(string, bool)`, not a bare string — unlike Gin's
`c.GetString`. For non-string values use `Set` / `Get`, which round-trip an `any`
you type-assert at the read site (`celeris/context.go:400`, `celeris/context.go:413`,
`celeris/context.go:483`, `celeris/context.go:499`).

## Install points

There are five places to install middleware. They compose into a single flat chain
that is **baked at route-registration time** — once a route is registered, its chain
is fixed, so install order in your setup code matters.

| Install point             | Method                                  | Scope                                  | When it runs                          |
| ------------------------- | --------------------------------------- | -------------------------------------- | ------------------------------------- |
| Pre-routing               | `s.Pre(mw...)`                          | Every request, before route matching   | Before the router resolves a handler  |
| Global                    | `s.Use(mw...)`                          | Every matched route                    | Outermost of the route chain          |
| Per-group                 | `g.Use(mw...)` / `s.Group(p, mw...)`   | Routes registered on that group        | After global, before route handlers   |
| Per-route (registration)  | `s.GET(path, mw..., handler)`           | One route                              | Leading handlers, before the terminal |
| Per-route (after the fact)| `r.Use(mw...)`                          | One route                              | Just before that route's terminal     |

### Pre-routing — `Server.Pre`

`Pre` registers middleware that runs **before the router matches the request**, so
it can mutate the request method, path, scheme, host, or client IP before the
handler is even chosen (`celeris/server.go:141`). This is the only layer that can
rewrite *what gets routed*.

```go
s.Pre(proxy.New(proxy.Config{TrustedProxies: []string{"10.0.0.0/8"}}))
s.Pre(redirect.HTTPSRedirect())
```

> **Pre-routing has no auto-abort.** Writing a response in a pre-routing middleware
> does **not** stop the chain. Custom pre-routing middleware that produces a
> response (a redirect, a 4xx) MUST `return` *without* calling `c.Next()`. If it
> writes a body **and** calls `Next()`, the router still runs and may write a second
> response. The shipped `redirect` middleware already returns without `Next()`.
> (Source: `celeris/middleware/doc.go`.)

### Global — `Server.Use`

`Use` registers global middleware that runs for every matched route, in registration
order, outermost first (`celeris/server.go:128`).

```go
s.Use(requestid.New())
s.Use(logger.New())
s.Use(recovery.New())
```

> **`s.Use` MUST precede every route or it panics.** Chains are composed when each
> route is registered, so calling `Use` after a `GET`/`POST`/etc. would silently
> give some routes the middleware and others not. Celeris panics to surface this:
> *"Server.Use called after routes were registered…"*. Put all `s.Use` calls above
> your first route. (Source: `celeris/server.go:128-134`.)

### Per-group — `Group.Use`

Group middleware applies to routes registered on that group, running **after**
server-level middleware but **before** the route's own handlers. You can pass it to
`Group(prefix, mw...)` or add it with `g.Use(mw...)`. Unlike the server, a group's
`Use` does **not** panic if called late — it simply applies only to routes
registered afterward, so add all `Use` calls before registering routes
(`celeris/group.go:71`).

```go
api := s.Group("/api", requestid.New()) // group middleware at creation
api.Use(jwt.New(jwt.Config{SigningKey: key}))
api.GET("/items", listItems) // runs: server Use -> requestid -> jwt -> listItems
```

Sub-groups inherit a **copy** of the parent's middleware plus their own. See
[Routing](/docs/routing) for the full group semantics.

### Per-route at registration — leading handlers

Every registration method is variadic; the **last** handler is the terminal handler
and any **leading** handlers are per-route middleware that run in order before it
(`celeris/server.go:105`).

```go
// auditLog and requireAdmin run before deleteUser, in that order.
s.DELETE("/users/:id", auditLog, requireAdmin, deleteUser)
```

### Per-route after the fact — `Route.Use`

`Route.Use` prepends middleware to a single route's chain, inserting it **just
before** the terminal handler. It panics if the route has no handlers
(`celeris/router.go:179`).

```go
r := s.GET("/admin", adminDashboard)
r.Use(requireAdmin) // requireAdmin now runs immediately before adminDashboard
```

### Composition order

For a request that matches a grouped route, the final chain is:

```
Pre  →  server Use  →  group Use  →  per-call leading handlers  →  Route.Use  →  terminal handler
```

Within each band, handlers run in the order you added them. The whole chain is one
flat slice (`celeris/group.go:19-26`), so on the way back out it unwinds in reverse:
the terminal handler returns first, then `Route.Use`, then the leading handlers, and
so on out to the outermost `s.Use`.

## Universal conventions

Nearly every package under `middleware/*` follows the same shape, so once you learn
one you know them all.

| Convention                | Detail                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Constructor**           | `New(config ...Config) celeris.HandlerFunc` — call with no args for defaults, or one `Config` to tune it. |
| **Config is variadic**    | `cors.New()` and `cors.New(cors.Config{…})` both work; passing more than one config is not supported.   |
| **Validated at construction** | Config is checked when you call `New`, not per request. Most packages **panic on invalid config** so misconfiguration fails loudly at startup. |
| **`Skip func(c) bool`**   | Dynamic, per-request bypass. Return `true` to skip this middleware for the request.                     |
| **`SkipPaths []string`**  | Static path bypass, matched **exactly** against `c.Path()` (no prefix or glob matching).                |

> **Not every package has `Skip` / `SkipPaths`.** The skip pair is on the
> request-filtering middleware (`cors`, `compress`, `jwt`, `ratelimit`, and most
> others). A few content helpers don't expose it — `protobuf`, for example, has only
> `MarshalOptions` / `UnmarshalOptions` (`celeris/middleware/protobuf/config.go`).
> Check the package's `Config` before relying on a skip field.

```go
// All catalog packages share this shape.
s.Use(compress.New(compress.Config{
    SkipPaths: []string{"/metrics", "/health"},          // static bypass
    Skip: func(c *celeris.Context) bool {                 // dynamic bypass
        return strings.HasPrefix(c.Path(), "/stream/")
    },
}))
```

A few packages deviate from the single-`New` shape, but keep the variadic-`Config`
convention:

- **`redirect`** exposes purpose-named constructors instead of one `New` —
  `HTTPSRedirect`, `WWWRedirect`, `NonWWWRedirect`, `TrailingSlashRedirect`,
  `RemoveTrailingSlashRedirect`, and combined `HTTPSWWWRedirect` /
  `HTTPSNonWWWRedirect`, each `func(config ...Config) celeris.HandlerFunc`
  (`celeris/middleware/redirect/redirect.go`).
- **`session`** offers `New(config ...Config) celeris.HandlerFunc`,
  `NewHandler(config ...Config) *Handler` when you need the handle object, and
  `NewWithCloser(config ...Config) (celeris.HandlerFunc, io.Closer)` when you want
  a closer to drain the optional write-behind queue on shutdown
  (`celeris/middleware/session/session.go`). See [Authentication
  middleware](/docs/middleware-auth) for `Config.WriteBehind` and graceful drain.

### Auth conventions

The authentication packages (`basicauth`, `keyauth`, `jwt`, `session`) additionally
share an `ErrorHandler func(c *celeris.Context, err error) error` field. `jwt` and
`keyauth` also expose `ContinueOnIgnoredError bool`: when `true`, the middleware
calls `c.Next()` whenever `ErrorHandler` returns `nil` (i.e. the error was
deliberately ignored). This is what lets you stack auth schemes — try JWT, fall back
to an API key:

```go
jwtAuth := jwt.New(jwt.Config{
    SigningKey:             hmacSecret,
    ContinueOnIgnoredError: true,
    ErrorHandler: func(c *celeris.Context, err error) error {
        return nil // ignore JWT failure, let keyauth try next
    },
})
keyAuth := keyauth.New(keyauth.Config{
    Validator: func(c *celeris.Context, key string) (bool, error) {
        return key == apiKey, nil
    },
})
api := s.Group("/api", jwtAuth, keyAuth)
// Valid JWT → proceeds after jwtAuth.
// No/invalid JWT → falls through to keyAuth; if that also fails, 401.
```

(Source: `celeris/middleware/doc.go`, `celeris/middleware/jwt/config.go`,
`celeris/middleware/keyauth/config.go`.)

## Submodules

Four packages are their **own Go modules** because they pull in heavy or optional
dependencies. Add each with a separate `go get`:

| Package      | Why it's split out                       | Install                                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------------- |
| `compress`   | zstd / brotli / gzip encoders            | `go get github.com/goceleris/celeris/middleware/compress` |
| `metrics`    | Prometheus client                        | `go get github.com/goceleris/celeris/middleware/metrics`  |
| `otel`       | OpenTelemetry SDK                        | `go get github.com/goceleris/celeris/middleware/otel`     |
| `protobuf`   | `google.golang.org/protobuf`             | `go get github.com/goceleris/celeris/middleware/protobuf` |

All other in-tree `middleware/*` packages (`recovery`, `logger`, `requestid`,
`cors`, `jwt`, …) ship in the **core module** — importing them needs no separate
`go get`; only the four above carry their own `go.mod`. (Source: the presence of
`go.mod` in each of these four directories only.)

## Recommended install order

Order is not cosmetic: each layer needs the context the layer above it established.
The canonical order is documented in `celeris/middleware/doc.go`. Pre-routing first,
then the route chain:

```go
// --- Pre-routing (Server.Pre) ---
s.Pre(proxy.New(proxy.Config{TrustedProxies: []string{"10.0.0.0/8"}})) // real client IP/scheme first
s.Pre(redirect.HTTPSRedirect())                                        // uses scheme from proxy
s.Pre(rewrite.New(rewrite.Config{Rules: []rewrite.Rule{
    {Pattern: `^/old/(.*)$`, Replacement: "/new/$1"},
}}))                                                                    // path edits after redirect
s.Pre(methodoverride.New())                                            // after path is finalized

// --- Route chain (Server.Use), outermost first ---
s.Use(healthcheck.New())   // probes respond early; ALWAYS Use, NEVER Pre
s.Use(requestid.New())     // assign ID first so all logs carry it
s.Use(logger.New())        // log every request with the request ID
s.Use(recovery.New())      // catch panics below; logger (above it) records the 500 recovery produces
// s.Use(metrics.New(...))  // optional: Prometheus
// s.Use(otel.New(...))     // optional: OpenTelemetry tracing
s.Use(secure.New())        // OWASP headers before any response escapes
s.Use(cors.New())          // handle preflight before auth rejects OPTIONS
// s.Use(bodylimit.New(...))     // reject oversized bodies before parsing
// s.Use(ratelimit.New(...))     // shed load before expensive auth/business logic
s.Use(circuitbreaker.New())     // trip on error spikes; after ratelimit, before timeout
// s.Use(jwt.New(...))           // auth (see Auth conventions)
// s.Use(csrf.New())             // after authentication is established
// s.Use(session.New(...))       // may depend on the authenticated user
s.Use(timeout.New(timeout.Config{Timeout: 30 * time.Second})) // bound handler execution
s.Use(singleflight.New())  // collapse identical in-flight requests
s.Use(compress.New())      // compress responses; wraps etag
s.Use(etag.New())          // innermost transform: 304 Not Modified
```

A few rules worth internalizing:

- **`healthcheck` goes in `Use`, never `Pre`.** A pre-routing `rewrite` rule could
  otherwise retarget the probe paths.
- **`proxy` first in `Pre`** so every downstream layer sees the real client IP and
  scheme.
- **`cors` before any auth** so preflight `OPTIONS` is answered before auth would
  reject it.
- **`compress` wraps `etag`** — the ETag is computed on the *uncompressed* body, so
  `etag` must be inside `compress`.

### The Vary header contract

Some middleware set the `Vary` response header (`cors` → `Vary: Origin`, `compress`
→ `Vary: Accept-Encoding`). They all use `AddHeader`, not `SetHeader`, so they don't
clobber each other. If a handler of yours sets `Vary`, it MUST also use `AddHeader`:

```go
c.AddHeader("vary", "Accept-Language") // correct — preserves cors/compress values
c.SetHeader("vary", "Accept-Language") // WRONG — clobbers middleware-set Vary
```

(Source: `celeris/middleware/doc.go`.)

## The catalog

Every package below lives under `github.com/goceleris/celeris/middleware/<pkg>` and
exposes the conventions above. Packages marked **(submodule)** need a separate
`go get`. Pre-routing packages install with `s.Pre`; everything else with `s.Use`
(or on a group / route). Each category has a dedicated page with the full `Config`
options and worked examples — follow the **Details** link under each table.

### Pre-routing — `Server.Pre`

| Package          | Purpose                                                         |
| ---------------- | -------------------------------------------------------------- |
| `proxy`          | Extract real client IP / scheme / host from trusted proxy headers. |
| `redirect`       | HTTPS, www, and trailing-slash URL normalization (301/308).    |
| `rewrite`        | Regex-based URL rewriting (`pattern → replacement`).           |
| `methodoverride` | Override `POST` via a `_method` form field or header.         |
| `healthcheck`    | Liveness / readiness probes (install with `Use`, not `Pre`).   |

Details: [URL rewriting and request preprocessing](/docs/middleware-routing-helpers).

### Observability

| Package       | Purpose                                                             |
| ------------- | ------------------------------------------------------------------ |
| `logger`      | Structured request logging via `log/slog`.                         |
| `requestid`   | Assign / propagate a per-request ID.                               |
| `healthcheck` | Liveness / readiness probe endpoints answered early.               |
| `metrics`     | Prometheus per-path/method/status histograms & counters. **(submodule)** |
| `otel`        | OpenTelemetry spans with W3C trace-context propagation. **(submodule)** |
| `pprof`       | Go profiling endpoints (loopback-only by default).                 |
| `debug`       | Debug endpoints intercepted by path prefix.                        |

Details: [Observability](/docs/observability).

> Celeris also has a built-in core collector
> (`github.com/goceleris/celeris/observe`) for lightweight internal counts and
> latency percentiles. The core collector, `metrics`, and `otel` each count traffic
> **independently** — never add numbers across them; pick one as the source of truth
> for a given chart, alert, or SLO. (Source: `celeris/middleware/doc.go`.)

### Security

| Package  | Purpose                                                  |
| -------- | ------------------------------------------------------- |
| `secure` | OWASP security response headers.                        |
| `cors`   | Cross-Origin Resource Sharing, including preflight.     |
| `csrf`   | CSRF token validation (after authentication).           |

Details: [Security middleware](/docs/middleware-security).

### Authentication

| Package     | Purpose                                                      |
| ----------- | ---------------------------------------------------------- |
| `basicauth` | HTTP Basic authentication.                                 |
| `keyauth`   | API-key authentication with a `Validator`.                 |
| `jwt`       | JWT validation; supports stacking via `ContinueOnIgnoredError`. |
| `session`   | Server-side sessions (`New`, `NewHandler`, or `NewWithCloser`). |

Details: [Authentication middleware](/docs/middleware-auth).

### Traffic management

| Package          | Purpose                                                      |
| ---------------- | ---------------------------------------------------------- |
| `ratelimit`      | Per-client request rate limiting.                          |
| `circuitbreaker` | Trip open on error-rate spikes.                            |
| `timeout`        | Bound handler execution time.                              |
| `overload`       | Shed load when the server is saturated.                    |
| `bodylimit`      | Reject oversized request bodies before parsing.            |
| `singleflight`   | Collapse identical in-flight requests into one.            |
| `idempotency`    | Deduplicate retried writes via an idempotency key.         |

Details: [Rate limiting and resilience](/docs/middleware-traffic).

### Content

| Package    | Purpose                                                       |
| ---------- | ----------------------------------------------------------- |
| `compress` | zstd / brotli / gzip response compression. **(submodule)**  |
| `etag`     | Conditional responses (`304 Not Modified`).                 |
| `cache`    | Response caching.                                           |
| `static`   | Static file server. See also [Static files](/docs/static-files). |
| `swagger`  | OpenAPI spec + UI (Swagger UI / Scalar).                    |
| `protobuf` | Protobuf request binding & responses. **(submodule)**       |

Details: [Compression, caching, and content](/docs/middleware-content).

> For streaming endpoints (`sse`, `websocket`) see [Streaming](/docs/streaming) —
> those handlers detach the connection and have their own dispatch rules.

## net/http compatibility

Celeris bridges the standard library in both directions, so existing stdlib
middleware and handlers come along unchanged. This section is a summary; for the full
treatment — including mounting Celeris under a `net/http` server — see
[Using net/http handlers and middleware](/docs/net-http-interop).

### Wrap a `func(http.Handler) http.Handler`

`adapters.WrapMiddleware` adapts any standard net/http middleware into a Celeris
`HandlerFunc` (`celeris/middleware/adapters/adapters.go:32`). The adapted middleware
gets a reconstructed `*http.Request`; when it calls the inner handler
(`next.ServeHTTP`), the Celeris chain continues via `c.Next()`. If it short-circuits
(e.g. returns an early 403 without calling the inner handler), the captured response
is written back and the Celeris chain is aborted.

```go
import (
    "net/http"
    "github.com/goceleris/celeris/middleware/adapters"
)

// A classic stdlib middleware.
func StdlibAuth(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Header.Get("X-Token") == "" {
            http.Error(w, "forbidden", http.StatusForbidden) // short-circuits
            return
        }
        next.ServeHTTP(w, r) // continues the celeris chain
    })
}

s.Use(adapters.WrapMiddleware(StdlibAuth))
```

> `WrapMiddleware` panics if passed a `nil` middleware. The response capture is
> capped at 100MB for short-circuited responses. Headers the stdlib middleware sets
> before calling `next` are propagated to the Celeris response.

### Wrap a plain `http.Handler` / `http.HandlerFunc`

For a stdlib *handler* (not middleware), use the core bridges
`celeris.Adapt(http.Handler)` and `celeris.AdaptFunc(http.HandlerFunc)`
(`celeris/bridge.go:16`, `celeris/bridge.go:51`):

```go
s.GET("/legacy", celeris.AdaptFunc(legacyHandlerFunc))
s.Handle("GET", "/proxy/*path", celeris.Adapt(someHTTPHandler))
```

`adapters` also ships a ready-made reverse proxy: `adapters.ReverseProxy(target,
opts...)` wraps `httputil.ReverseProxy` and sets `X-Forwarded-*` headers
automatically (`celeris/middleware/adapters/adapters.go:210`).

## Server-level error and fallback handlers

Three `*Server` hooks complete the request lifecycle. All must be set before
`Start`:

| Hook                        | Fires when                                                       | Source                  |
| --------------------------- | --------------------------------------------------------------- | ----------------------- |
| `OnError(fn)`               | An unhandled error reaches the safety net after all middleware. | `celeris/server.go:215` |
| `NotFound(handler)`         | No route matches the request path.                              | `celeris/server.go:199` |
| `MethodNotAllowed(handler)` | The path matches but the method doesn't (`Allow` header is set automatically). | `celeris/server.go:206` |

```go
s.OnError(func(c *celeris.Context, err error) {
    c.JSON(500, map[string]string{"error": err.Error()})
})
s.NotFound(func(c *celeris.Context) error {
    return c.JSON(404, map[string]string{"error": "not found"})
})
s.MethodNotAllowed(func(c *celeris.Context) error {
    return c.JSON(405, map[string]string{"error": "method not allowed"})
})
```

`OnError` is the last line of defense for any error a middleware returned and nobody
swallowed; if your handler writes nothing, Celeris falls back to a `text/plain`
response. For per-route error handling, return `celeris.NewHTTPError(...)` or set a
middleware's `ErrorHandler`. See [Responses](/docs/responses).

## Common pitfalls

- **`s.Use` after a route panics.** Move all server-level `Use` calls above your
  first route registration. (`Group.Use` does *not* panic but silently applies only
  going forward — also put it before routes.)
- **Pre-routing middleware doesn't auto-abort.** If a custom `Pre` middleware writes
  a response, it must `return` without `c.Next()`, or the router will run and may
  write a second response.
- **`healthcheck` in `Pre` is a trap.** Install it with `Use`; a `Pre` `rewrite`
  rule could otherwise retarget the probe paths.
- **Don't `SetHeader("vary", …)`.** Use `AddHeader` so you don't clobber the `Vary`
  values `cors`/`compress` already set.
- **Submodule import errors.** `compress`, `metrics`, `otel`, and `protobuf` are
  separate modules — a "missing go.sum entry" / "no required module" error means you
  still need the extra `go get`.
- **`compress` must wrap `etag`.** ETags are computed on the uncompressed body, so
  `etag` belongs *inside* (after) `compress` in the chain.
- **`Route.Use` on a handler-less route panics.** Register the route with at least a
  terminal handler before calling `Route.Use`.

## FAQ

**Is middleware different from a handler?**
No. Both are `func(c *celeris.Context) error`. Middleware just calls `c.Next()` to
run what follows; a terminal handler doesn't.

**How do I run code only on the way out (e.g. add a header to every response)?**
Call `c.Next()` first, then do your post-work with the returned error in hand:
`err := c.Next(); c.SetHeader(...); return err`.

**Can I change the install order at runtime?**
No. Chains are baked when each route is registered, and the `*Server` is only safe
for concurrent use after `Start`. Decide your order during setup.

**A middleware returned an error — does the chain keep running?**
No. `c.Next()` returns the first non-nil error and stops calling further handlers.
Upstream middleware can choose to swallow it by returning `nil` instead.

**How do I bypass a middleware for certain paths?**
Use the package's `SkipPaths` (exact match on `c.Path()`) or `Skip func(c) bool`
(dynamic). These are present on nearly every catalog package — a few content helpers
such as `protobuf` are the exception, so check the package's `Config` first.

## See also

The catalog above links to a dedicated page per category. The full set:

- [Security middleware](/docs/middleware-security) — `secure`, `cors`, `csrf`, `proxy`.
- [Authentication middleware](/docs/middleware-auth) — `basicauth`, `keyauth`, `jwt`, `session`.
- [Rate limiting and resilience](/docs/middleware-traffic) — `ratelimit`,
  `circuitbreaker`, `timeout`, `overload`, `bodylimit`, `singleflight`, `idempotency`.
- [Compression, caching, and content](/docs/middleware-content) — `compress`, `etag`,
  `cache`, `swagger`, `protobuf`.
- [URL rewriting and request preprocessing](/docs/middleware-routing-helpers) —
  `proxy`, `redirect`, `rewrite`, `methodoverride`, `healthcheck`.
- [Observability](/docs/observability) — `logger`, `requestid`, `metrics`, `otel`,
  `pprof`.
- [Using net/http handlers and middleware](/docs/net-http-interop) — `adapters`,
  `Adapt` / `AdaptFunc`, and mounting Celeris under the standard library.

And the related guides:

- [Routing](/docs/routing) — per-route and per-group middleware, `Pre`, `NotFound`,
  and `MethodNotAllowed` in the routing context.
- [Responses](/docs/responses) — returning errors, `NewHTTPError`, and how `OnError`
  formats the final response.
- [Static files](/docs/static-files) — the `static` middleware and `Server.Static`.
- [Streaming](/docs/streaming) — `sse` and `websocket`, which detach the connection.
- [Engines](/docs/engines) — the async/sync dispatch model that surrounds the chain.
