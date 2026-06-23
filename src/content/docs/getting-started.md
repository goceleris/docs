---
title: Getting started
description: Install Celeris, build and run your first server, and understand the request lifecycle.
group: Getting Started
order: 2
---

This page takes you from an empty directory to a running Celeris server, then
adds a path parameter, a JSON endpoint, and graceful shutdown — the shape of a
real production entry point. Every snippet here is runnable and grounded in the
Celeris source.

## Requirements

| Requirement | Notes |
| --- | --- |
| **Go 1.26 or newer** | Celeris targets the current Go toolchain. |
| **Linux** for the high-performance engines | The `io_uring` engine needs kernel **5.10+**; the `epoll` engine needs kernel **3.10+**. |
| Any other OS (macOS, Windows, BSD) | Supported via automatic fallback to the portable `std` (`net/http`) engine — no code changes needed. |

You don't choose an engine to get started. On Linux, Celeris defaults to its
**Adaptive** engine and auto-detects HTTP/1.1 vs. cleartext HTTP/2 (h2c) on the
wire. Everywhere else it falls back to `std`. See [Engines](/docs/engines) for
the details.

## Install

```bash
go get github.com/goceleris/celeris@latest
```

That single import gives you the server, router, `Context`, and the built-in
middleware that ships in the core module (CORS, recovery, logging, request ID,
rate limiting, and more — see [Middleware](/docs/middleware)).

A few middleware packages are published as **separate Go submodules** because
they pull in heavier third-party dependencies. You only `go get` these if you
use them:

| Submodule | Import path |
| --- | --- |
| Response compression | `github.com/goceleris/celeris/middleware/compress` |
| Prometheus-style metrics | `github.com/goceleris/celeris/middleware/metrics` |
| OpenTelemetry tracing | `github.com/goceleris/celeris/middleware/otel` |
| Protobuf encoding | `github.com/goceleris/celeris/middleware/protobuf` |

```bash
# Only if you need compression, for example:
go get github.com/goceleris/celeris/middleware/compress@latest
```

> **Why submodules?** Each has its own `go.mod`, so your application's
> dependency graph stays lean when you don't use them. Adding the core
> `celeris` import does **not** pull in OpenTelemetry, Prometheus, or the
> compression libraries.

## Your first server

Create a `main.go`:

```go
package main

import (
    "log"

    "github.com/goceleris/celeris"
)

func main() {
    s := celeris.New(celeris.Config{Addr: ":8080"})

    s.GET("/hello", func(c *celeris.Context) error {
        return c.String(200, "Hello, World!")
    })

    log.Fatal(s.Start())
}
```

Three things are happening:

- **`celeris.New(celeris.Config{Addr: ":8080"})`** builds a server bound to port
  8080. `Config` has many fields but `Addr` is the only one you need to start —
  everything else has a sensible default. See [Configuration](/docs/configuration)
  for the full reference.
- **`s.GET("/hello", handler)`** registers a route. A handler is always
  `func(c *celeris.Context) error`. Returning the error (instead of writing it
  yourself) lets Celeris centralize error handling — more on that below.
- **`s.Start()`** prepares the engine and **blocks** until the server is shut
  down or the engine returns an error. Wrapping it in `log.Fatal` surfaces any
  startup error (e.g. the port is already in use).

`c.String(code, format, args...)` writes a `text/plain` response and accepts
`fmt`-style formatting:

```go
return c.String(200, "Hello, %s!", name)
```

## Run it and curl it

```bash
go run main.go
```

In another terminal:

```bash
curl http://localhost:8080/hello
# Hello, World!
```

That's a working server with zero configuration beyond the listen address.

## Add a path parameter and a JSON endpoint

Routes can capture path segments with `:name`, read back with `c.Param("name")`.
For JSON responses, return any value from `c.JSON(code, v)` — Celeris serializes
it and sets `Content-Type: application/json`.

```go
package main

import (
    "log"

    "github.com/goceleris/celeris"
)

func main() {
    s := celeris.New(celeris.Config{Addr: ":8080"})

    s.GET("/hello", func(c *celeris.Context) error {
        return c.String(200, "Hello, World!")
    })

    // Path parameter: /users/42 → id == "42"
    s.GET("/users/:id", func(c *celeris.Context) error {
        return c.JSON(200, map[string]string{"id": c.Param("id")})
    })

    log.Fatal(s.Start())
}
```

```bash
curl http://localhost:8080/users/42
# {"id":"42"}
```

`c.Param` always returns a `string`; convert it yourself (`strconv.Atoi`, etc.)
if you need a number. For routing beyond path params — wildcards, groups, named
routes, and reverse URL generation — see [Routing](/docs/routing). For reading
query strings, headers, cookies, and request bodies, see
[Handling requests](/docs/request-handling) and
[Binding and validation](/docs/binding-and-validation).

## Production entry point: graceful shutdown

`s.Start()` is perfect for experiments, but it has no shutdown story — a `SIGINT`
or `SIGTERM` kills the process mid-request. For anything you deploy, switch to
**`StartWithContext`** and feed it a context wired to OS signals:

```go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"

    "github.com/goceleris/celeris"
)

func main() {
    // Cancel ctx on Ctrl-C (SIGINT) or SIGTERM (the signal orchestrators
    // and container runtimes send on stop).
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    s := celeris.New(celeris.Config{Addr: ":8080"})

    s.GET("/ping", func(c *celeris.Context) error {
        return c.String(200, "pong")
    })

    // Blocks until ctx is canceled, then drains in-flight requests
    // before returning.
    if err := s.StartWithContext(ctx); err != nil {
        log.Fatal(err)
    }
}
```

When the context is canceled, Celeris stops accepting new connections and waits
for in-flight requests to finish before returning. The drain window is bounded
by `Config.ShutdownTimeout` (default **30s**). To run cleanup when the server
stops — close a database pool, flush a buffer — register a hook with
`s.OnShutdown`:

```go
s.OnShutdown(func(ctx context.Context) {
    pool.Close()
})
```

Shutdown hooks fire in registration order with the shutdown context, after the
engine has drained.

> **Tip:** `Config.ShutdownTimeout` only applies to `StartWithContext`. If you
> need a custom drain deadline, set it on the `Config` you pass to
> `celeris.New`.

## The golden ordering rule

> **Register all middleware (`Use`) and all routes BEFORE you call any
> `Start*` method. And register `Use` middleware before the routes it should
> wrap.**

Celeris bakes each route's middleware chain at the moment the route is
registered. As a direct consequence, **`s.Use(...)` panics if you call it after
any route has been registered** — because that middleware could only apply to
routes declared *after* the call, silently giving some routes the middleware and
others not.

```go
import (
    "log"

    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/logger"
    "github.com/goceleris/celeris/middleware/requestid"
)

// ...

s := celeris.New(celeris.Config{Addr: ":8080"})

// 1. Global middleware first.
s.Use(requestid.New())
s.Use(logger.New())

// 2. Then routes (they capture the middleware registered above).
s.GET("/hello", helloHandler)
s.GET("/users/:id", userHandler)

// 3. Then start.
log.Fatal(s.Start())
```

> The `requestid` and `logger` packages live under
> `github.com/goceleris/celeris/middleware/...` but ship **inside the core
> module** — no extra `go get` needed. See [Middleware](/docs/middleware) for
> the full catalog.

This is the single most common pitfall for newcomers. The order is always:
**`Use` → routes → `Start`**. (`s.Pre(...)` pre-routing middleware and route
groups follow the same "before `Start`" rule.)

The panic message spells out the fix if you ever trip it:

```
celeris: Server.Use called after routes were registered — ...
Move Use calls before any GET/POST/etc.
```

## Request lifecycle overview

Knowing the path a request takes makes middleware and error handling far easier
to reason about. For every request, Celeris runs these stages in order:

```text
1. Accept           Engine accepts the connection; a last-resort recover is
                    armed for the whole request — a panic that escapes
                    everything else becomes a 500 instead of crashing the
                    process. For real panic handling (logging, Sentry, a
                    custom 500 body), add the recovery middleware.

2. Pre middleware   s.Pre(...) handlers run BEFORE route matching. They may
                    rewrite the method or path (URL rewrite, method override,
                    proxy-header extraction) or abort the request entirely.

3. Route match      The router resolves method + path. No match →
                    404 Not Found (or 405 Method Not Allowed if the path
                    exists for a different method). Custom handlers:
                    s.NotFound / s.MethodNotAllowed.

4. Handler chain    The matched route runs its composed chain in order:
                    global Use middleware → group middleware → route
                    middleware → your handler. Each layer calls c.Next()
                    to invoke the next; returning an error short-circuits
                    the rest of the chain.

5. Error safety net Any error returned from the chain lands here. If you
                    registered s.OnError it runs first. Otherwise: an
                    *HTTPError is sent with its own status code; any other
                    error becomes 500 Internal Server Error.
```

Two takeaways for everyday use:

- **You return errors; Celeris writes responses.** Instead of writing a 404
  body by hand, return `celeris.NewHTTPError(404, "user not found")` and the
  safety net turns it into the right status and message. A plain `error`
  (not an `*HTTPError`) becomes a `500` — so wrap expected failures in
  `NewHTTPError`. See the error-handling section of [Routing](/docs/routing)
  for the full pattern and [Sending responses](/docs/responses) for the
  response helpers.
- **Middleware is just a handler that calls `c.Next()`.** Code before `Next()`
  runs on the way in; code after it runs on the way out (after the handler).

```go
s.Use(func(c *celeris.Context) error {
    // ... before the handler ...
    err := c.Next() // run the rest of the chain
    // ... after the handler ...
    return err
})
```

## Common pitfalls

- **Calling `Use` after a route.** This panics by design (see the golden
  ordering rule). Move every `Use` above your first `GET`/`POST`/etc.
- **Expecting `Start()` to return.** `Start()` and `StartWithContext()` block.
  Anything you want to run *after* the server is up must go on another goroutine,
  or before the `Start*` call.
- **No graceful shutdown in production.** Use `StartWithContext` with
  `signal.NotifyContext`, not `Start`, so deploys and container stops drain
  in-flight requests instead of dropping them.
- **Forgetting a submodule.** `compress`, `metrics`, `otel`, and `protobuf`
  each need their own `go get`. The core import alone won't resolve them.
- **Returning a bare `error` and expecting a custom status.** Any non-`HTTPError`
  error becomes `500`. Use `celeris.NewHTTPError(code, msg)` to control the
  status code.

## FAQ

**Do I have to pick an engine?**
No. On Linux you get the Adaptive engine automatically; elsewhere `std`. Set
`Config.Engine` only if you want to pin a specific one — see
[Engines](/docs/engines).

**Does it support HTTP/2?**
Yes. With the default `Protocol: Auto`, Celeris auto-detects HTTP/1.1 and
cleartext HTTP/2 (h2c) on the same listener.

**Where do I read query params, headers, or a JSON request body?**
On the `Context`: `c.Query`, `c.Header` (and friends), and `c.Bind(&v)` for
decoding a request body into a struct. See [Handling requests](/docs/request-handling)
for reading inputs and [Binding and validation](/docs/binding-and-validation)
for decoding bodies into structs.

**How do I serve static files?**
`s.Static("/assets", "./public")` registers a file server with path-traversal
protection.

## Next steps

- Learn the model behind everything: [Core concepts](/docs/core-concepts)
- Tune the server: [Configuration](/docs/configuration)
- Define routes, groups, named URLs, and error handling: [Routing](/docs/routing)
- Read inputs from the request: [Handling requests](/docs/request-handling)
- Decode and validate request bodies: [Binding and validation](/docs/binding-and-validation)
- Write JSON, files, redirects, and more: [Sending responses](/docs/responses)
- Add auth, CORS, logging, and more: [Middleware](/docs/middleware)
- Understand what you're running on: [Engines](/docs/engines)
