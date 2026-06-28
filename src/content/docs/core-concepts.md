---
title: Core concepts
description: The Server, Context, handlers, the protocol x engine model, and async dispatch — the model behind everything else.
group: Getting Started
order: 3
---

This page is the conceptual spine of Celeris. Once you understand the six ideas
below — the **Server** lifecycle, the **handler** contract, the pooled
**Context**, the **protocol × engine** matrix, **sync vs async** dispatch, and
**registration-time vs request-time** — every other page (routing, middleware,
configuration, engines, streaming) is just detail layered on top.

Everything here is grounded in real exported APIs. Where a rule is subtle, the
relevant type or method is named so you can find it in your editor's go-doc.

## 1. The Server lifecycle

A `celeris.Server` has two distinct phases: **build** and **run**.

```go
package main

import (
    "log"

    "github.com/goceleris/celeris"
)

func main() {
    // Build phase: cheap, synchronous, no I/O.
    s := celeris.New(celeris.Config{Addr: ":8080"})
    s.GET("/", func(c *celeris.Context) error {
        return c.String(200, "hello")
    })

    // Run phase: binds the socket and blocks.
    log.Fatal(s.Start())
}
```

### `New` is cheap and non-blocking

`celeris.New(cfg)` (server.go) only allocates the `Server` struct, creates the
router, seeds the per-route async default from `Config.AsyncHandlers`, and — unless
`Config.DisableMetrics` is set — eagerly constructs the metrics collector so that
`Server.Collector()` returns non-nil before `Start`. **It does not bind a socket,
spawn any goroutines, or touch the network.** You can construct a `Server`,
register routes, and inspect it (`Routes()`, `Collector()`) entirely offline.

### `Start*` binds and runs

The actual work happens when you call one of the start methods:

| Method | Blocks until | Use when |
| --- | --- | --- |
| `Start()` | `Shutdown` is called or the engine errors | Simplest case; you manage shutdown elsewhere |
| `StartWithContext(ctx)` | `ctx` is cancelled (then graceful shutdown) or the engine errors | You want context-driven lifecycle (signals, parent ctx) |
| `StartWithListener(ln)` | as `Start` | Zero-downtime restart via an inherited socket |
| `StartWithListenerAndContext(ctx, ln)` | as `StartWithContext` | Inherited socket + context lifecycle |

All of them call into a single internal preparation step that is **guarded by a
`sync.Once`**. That preparation validates the config, resolves the engine,
constructs the CPU monitor, and installs the engine. Because it runs exactly
once:

- The **second** call to any `Start*` method returns `celeris.ErrAlreadyStarted`
  (server.go). A `Server` is single-use; you cannot restart it after `Shutdown`.
- Configuration validation errors and engine-initialization errors surface from
  the **first** `Start*` call, not from `New`.

```go
s := celeris.New(celeris.Config{Addr: ":8080"})

go func() {
    if err := s.Start(); err != nil {
        log.Printf("server stopped: %v", err)
    }
}()

if err := s.Start(); err != nil {
    // err == celeris.ErrAlreadyStarted
}
```

### Graceful shutdown

`Shutdown(ctx)` stops accepting new connections, drains in-flight requests, then
fires any hooks you registered with `OnShutdown` — in registration order, with
the shutdown context. `StartWithContext` wires this up for you: when the context
is cancelled, the server shuts down using `Config.ShutdownTimeout` (default 30s).

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
defer stop()

s.OnShutdown(func(ctx context.Context) {
    db.Close() // runs during graceful shutdown
})

// Blocks until SIGINT, then drains and runs OnShutdown hooks.
log.Fatal(s.StartWithContext(ctx))
```

> Calling `Shutdown` on a server that was never started is a safe no-op (returns
> `nil`).

See [Configuration](/docs/configuration) for the full `Config` reference and
[Deployment](/docs/deployment) for zero-downtime restart patterns with
`StartWithListener` and `InheritListener`.

## 2. The handler contract

Every handler and every piece of middleware in Celeris has the **same** type
(types.go):

```go
type HandlerFunc func(*Context) error
```

That single type is the whole contract. There are two outcomes:

1. **Write a response and return `nil`.** You wrote what you wanted; you are done.
2. **Return a non-nil error.** The error propagates up through the middleware
   chain. Any middleware can inspect or swallow it by checking the return value
   of `Context.Next()`. If nothing handles it, an internal safety net writes an
   appropriate response.

```go
func getUser(c *celeris.Context) error {
    id := c.Param("id")
    user, err := store.Find(id)
    if err != nil {
        // Returned, not written — the safety net (or a custom OnError) handles it.
        return celeris.NewHTTPError(404, "user not found").WithError(err)
    }
    return c.JSON(200, user) // wrote a response, return nil
}
```

Because middleware **is** a `HandlerFunc`, the only thing that distinguishes
middleware from a leaf handler is whether it calls `c.Next()` to continue the
chain:

```go
func logging(c *celeris.Context) error {
    start := time.Now()
    err := c.Next() // run the rest of the chain
    log.Printf("%s %s -> %v (%s)", c.Method(), c.Path(), err, time.Since(start))
    return err
}
```

You install global middleware with `Server.Use`, per-group middleware with
`RouteGroup.Use`, and per-route middleware with `Route.Use`. The
[Middleware](/docs/middleware) page covers the chain in depth.

> **Customising the safety net.** Register `Server.OnError(func(c *Context, err
> error))` to control what an unhandled returned error produces. If your handler
> does not write a response, the default `text/plain` fallback applies.

## 3. The Context is pooled

The `*Context` your handler receives is **obtained from a `sync.Pool`**
(context.go) and is reset and returned to that pool after your handler chain
completes. This is central to Celeris's allocation profile, and it imposes one
rule you must internalise:

> **The Lifetime Rule:** A `*Context`, and anything it hands you by reference,
> is valid only for the duration of the handler. **Never retain a `*Context`,
> nor any slice/reader it returns, past the moment your handler returns.**

Retaining a `Context` (storing it in a struct, capturing it in a goroutine that
outlives the request, etc.) means a later request will mutate the object under
you. This is the single most common source of subtle bugs when coming from
frameworks that allocate a fresh request object per request.

### What is and isn't safe to keep

| Returns a view into pooled memory (do **not** retain) | Returns a safe-to-retain copy |
| --- | --- |
| `c.Body()` — raw request body | `c.BodyCopy()` — fresh copy of the body |
| `c` itself | `c.RequestHeaders()` — copy of all headers |

String getters (`c.Param`, `c.Header`, `c.Path`, `c.Method`, …) are fine to
*use* inside the handler, but their bytes may be backed by the connection's read
buffer — assign the `string` into your own structure before letting it outlive
the request (a Go `string` copy is just `x := c.Param("id")`).

The two methods documented for cross-request lifetimes are explicit about it in
source:

- `c.BodyCopy()` (context_request.go): "returns a copy of the request body that
  is safe to retain after the handler returns. Use this instead of `Body()` when
  the body must outlive the request lifecycle (e.g., for async processing or
  logging)." `Body()` itself warns the slice "must not be modified or retained
  after the handler returns."
- `c.RequestHeaders()` (context_request.go): "returns all request headers as
  key-value pairs. The returned slice is a copy safe for concurrent use."

```go
func enqueue(c *celeris.Context) error {
    // WRONG — body is a view into pooled memory:
    // go worker.Process(c.Body())

    // RIGHT — copy first, then it can outlive the request:
    payload := c.BodyCopy()
    go worker.Process(payload)

    return c.NoContent(202)
}
```

### If you need the request to outlive the handler

For long-lived flows (Server-Sent Events, WebSocket), use `c.Detach()` (it
returns a `done` function) so the framework knows the connection is hijacked and
defers its cleanup. Detached flows are covered on the [Streaming](/docs/streaming)
page. Note that detached handlers are async by construction.

Need a value to flow *within* the request, across middleware and handlers? Use
the per-request store: `c.Set/Get` (any value), `c.SetString/GetString`
(zero-alloc strings), or `c.SetRequestID/RequestID`. These live and die with the
request, which is exactly what you want.

## 4. The protocol × engine model

Two configuration axes look similar but are **orthogonal**. Conflating them is a
classic footgun.

- **Protocol** (`Config.Protocol`) is the wire format clients speak.
- **Engine** (`Config.Engine`) is the I/O strategy the server uses to move bytes.

### Protocol — what's on the wire

`celeris.Protocol` (config.go) is **cleartext only** — Celeris does not terminate
TLS itself; put it behind a TLS-terminating proxy or load balancer.

| Protocol | Meaning |
| --- | --- |
| `celeris.Auto` (default) | Auto-detect between HTTP/1.1 and HTTP/2 cleartext (h2c) |
| `celeris.HTTP1` | HTTP/1.1 only |
| `celeris.H2C` | HTTP/2 cleartext (h2c) only |

A related flag, `Config.EnableH2Upgrade` (a `*bool`), controls whether the
server honours `HTTP/1.1 Upgrade: h2c` requests. Left `nil`, it is inferred from
the protocol — enabled for `Auto`, disabled for `HTTP1` and `H2C`.

### Engine — how bytes move

`celeris.EngineType` (config.go) selects the I/O implementation. **The engine is
an I/O strategy, not a protocol** — every engine serves every supported protocol;
they differ only in how they talk to the kernel.

| Engine | Platform | What it uses |
| --- | --- | --- |
| `celeris.Adaptive` (default on Linux) | Linux | Dynamically switches between epoll and io_uring based on load |
| `celeris.Epoll` | Linux | Edge-triggered `epoll` |
| `celeris.IOUring` | Linux 5.10+ | `io_uring` async I/O |
| `celeris.Std` | All platforms | Go's `net/http` server |

The default engine is `Adaptive` on Linux and `Std` elsewhere (e.g. macOS dev
machines transparently use the std engine).

### The matrix

Because the axes are independent, any protocol pairs with any engine:

| | `Auto` | `HTTP1` | `H2C` |
| --- | --- | --- | --- |
| `Adaptive` | ✓ | ✓ | ✓ |
| `Epoll` | ✓ | ✓ | ✓ |
| `IOUring` | ✓ | ✓ | ✓ |
| `Std` | ✓ | ✓ | ✓ |

Pick the **protocol** by what your clients/proxy speak; pick the **engine** by
your platform and performance goals. In most cases you set neither and accept the
defaults. The [Engines](/docs/engines) page covers the adaptive engine's
promotion behaviour and the `WorkloadHint` knob in detail.

## 5. Sync vs async dispatch

This is the most performance-relevant concept in Celeris, and the one most worth
understanding before you build.

### The two dispatch modes

- **Sync (inline) — the default.** The handler runs **inline on the engine's I/O
  worker**, which is `LockOSThread`'d to a CPU. No goroutine is spawned. This is
  optimal for CPU-only or cache-only handlers: zero scheduling overhead, maximal
  locality.
- **Async.** The handler is dispatched to a **spawned goroutine**, freeing the
  worker to return to `epoll_wait` / `io_uring_enter` while the handler blocks.
  This is what you want when a handler does **blocking I/O** (database driver,
  external HTTP call, file read): instead of one blocked handler stalling a whole
  I/O worker, you get goroutine-per-connection parallelism, matching `net/http`'s
  model.

The trade-off, per `Config.AsyncHandlers` go-doc (config.go): async costs a
goroutine spawn (~100ns) plus scheduler overhead per request — a measured ~3–5%
regression on a pure static-response benchmark. So:

| Workload | Choose |
| --- | --- |
| CPU-only, cache-only, static responses, latency-critical | **Sync** (default) |
| Touches a DB, cache, or upstream service (blocking I/O) | **Async** |

### Setting it: default + per-route/group overrides

`Config.AsyncHandlers` is the **server-level default**. Individual routes and
groups override it. The precedence is **route > group > server** (most specific
wins):

```go
// Server default: sync.
s := celeris.New(celeris.Config{Addr: ":8080"})

s.GET("/healthz", healthHandler)            // sync (server default)
s.GET("/db", dbHandler).Async()             // async — blocking I/O

api := s.Group("/api").Async()              // group default: async
api.GET("/products", listProducts)          //   → async (from group)
api.GET("/cached", cachedHandler).Sync()    //   → sync (route overrides group)
```

The override methods (router.go, group.go):

| Method | Effect |
| --- | --- |
| `Route.Async()` / `Route.Async(true)` | Force this route async |
| `Route.Async(false)` / `Route.Sync()` | Force this route sync |
| `Route.UsesDriver()` | Exactly equivalent to `.Async()`, but signals intent: this route makes a blocking backend round-trip via a Celeris driver |
| `RouteGroup.Async()` / `RouteGroup.Sync()` | Set the group default for routes registered *after* the call |

> **`UsesDriver()` is intent, not magic.** It is identical to `.Async()`. It
> exists because, when you set `Config.AsyncHandlers = true`, an adaptive safety
> net only auto-promotes handlers slower than ~300µs — so a fast localhost driver
> call (sub-300µs) would otherwise keep blocking a worker on every request. Mark
> driver routes explicitly with `.UsesDriver()` (or `.Async()`) to be safe.

> **Safety:** never call `.Sync()` (or `.Async(false)`) on a WebSocket or SSE
> handler. Detached flows are async by construction; the per-route flag cannot
> downgrade them.

### A note on groups and ordering

`RouteGroup.Async()` / `.Sync()` only affect routes registered **after** the
call. To make an entire group async, call `.Async()` immediately after
`Group(...)`:

```go
api := s.Group("/api").Async()   // every /api/* route below is async
api.GET("/a", a)
api.GET("/b", b)
```

Sub-groups inherit the parent group's dispatch override.

## 6. Registration-time vs request-time

The last concept ties the others together. Celeris does most of its work
**once, at registration time** — not per request.

- **Middleware chains are baked at registration.** When you register a route
  (`GET`, `POST`, group `handle`, etc.), Celeris composes the full handler chain
  — server middleware + group middleware + route middleware + handler — into a
  single slice **then and there**. It is not assembled per request.

This produces the framework's most important ordering rule:

> **Call `Use` before registering routes.** Because chains are baked at
> registration time, middleware added after a route is registered does **not**
> apply to that route. `Server.Use` is strict about this: calling it after any
> route has been registered **panics**, on purpose, to surface the
> silently-inconsistent-coverage bug rather than let it ship.

```go
s := celeris.New(cfg)

s.Use(logging, recover)      // ✓ register middleware first
s.GET("/", home)             //   home gets logging + recover

// s.Use(auth)               // ✗ PANICS — routes already registered
```

The same ordering discipline applies to a group's `Use` and to a group's
`Async`/`Sync`: configure the group, *then* register its routes.

Other things resolved at registration time:

- **The async flag per route** is resolved when the route is registered, against
  the server default and any group/route override.
- **Duplicate route registrations** are detected at registration: the second one
  overwrites the first and a warning is logged (this is almost always a bug).

The request-time path, by contrast, is deliberately thin: match the route
(O(1) for fully static paths via a map; a radix-trie walk otherwise), acquire a
pooled `Context`, run the pre-baked chain, recycle the `Context`.

## Common pitfalls

- **Retaining the Context or its body.** The number-one bug. Anything you pass to
  a goroutine that outlives the handler must be copied first — use `c.BodyCopy()`
  and `c.RequestHeaders()`. See [The Lifetime Rule](#3-the-context-is-pooled).
- **Calling `Use` after routes.** Panics by design. Register all middleware
  before any route. Same for group `Use`/`Async`/`Sync`, which only affect routes
  registered after the call.
- **Marking CPU-only routes `.Async()`.** You pay a goroutine spawn per request
  for no benefit (~3–5% on static responses). Keep them sync.
- **Forgetting to mark fast driver routes.** With `Config.AsyncHandlers = true`,
  the adaptive net only auto-promotes handlers slower than ~300µs. A sub-300µs
  driver call on an unmarked route keeps blocking a worker. Mark it
  `.UsesDriver()` / `.Async()`.
- **Calling `Start` twice.** The second call returns `ErrAlreadyStarted`; a
  `Server` is single-use.
- **Expecting TLS from Celeris.** Protocols are cleartext only. Terminate TLS at
  a proxy in front of the server.

## FAQ

**Is a `Context` safe to use concurrently within a single request?**
No. A `*Context` is single-goroutine by default. If you fan out work, copy the
data you need (`BodyCopy`, `RequestHeaders`) and pass the copies. For long-lived
hijacked connections, use `c.Detach()`.

**Can I restart a `Server` after `Shutdown`?**
No. Construct a new `Server`. The start path is guarded by a `sync.Once`; a
second `Start*` returns `ErrAlreadyStarted`.

**Where do config validation errors show up?**
On the first `Start*` call, not on `New`. `New` does no validation or I/O.

**Do I have to pick an engine?**
No. Leave `Config.Engine` zero and Celeris uses `Adaptive` on Linux and `Std`
elsewhere. Same for `Protocol` — zero means `Auto`.

**What's the difference between `Body()` and `BodyCopy()`?**
`Body()` returns a view into pooled memory — fast, but invalid after the handler
returns. `BodyCopy()` returns a fresh copy that is safe to keep.

**Middleware and handlers are the same type — how does Celeris tell them apart?**
It doesn't need to. A `HandlerFunc` is "middleware" if it calls `c.Next()` to
continue the chain, and a "leaf handler" if it just writes a response. Same
contract, different behaviour.

## Related pages

- [Getting started](/docs/getting-started) — your first server end to end.
- [Configuration](/docs/configuration) — the full `Config` reference.
- [Routing](/docs/routing) — routes, params, groups, named routes, error handling.
- [Middleware](/docs/middleware) — the chain in depth.
- [Engines](/docs/engines) — the adaptive engine and `WorkloadHint`.
- [Streaming](/docs/streaming) — SSE, WebSocket, and `Detach`.
