---
title: Testing
description: Unit-test handlers and middleware with celeristest, and assert on responses.
group: Operations
order: 5
---

Celeris handlers have the signature `func(c *celeris.Context) error`, which makes
them trivially testable in isolation — you don't need a live listener, a socket,
or the engine event loop. The `celeristest` package fabricates a real
`*celeris.Context` wired to an in-memory recorder, so you call your handler
directly and assert on what it wrote. This page covers the supported way to build
a context, shape the request, invoke handlers and middleware chains, assert on
errors and status codes, and — when you genuinely need the wire — stand up a real
server on an ephemeral port for integration tests.

`celeristest` is the **only** supported entry point for constructing a `Context`
in tests. The lower-level helpers it calls (`AcquireTestContext`, `AddTestParam`,
and friends) are deliberately undocumented plumbing; see
[What not to use](#what-not-to-use) below.

## The `celeristest` package

There are two constructors. Both build a `*celeris.Context` and return a
`*ResponseRecorder` that captures whatever the handler writes.

| Constructor                                              | Returns                                | Cleanup                                                  |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `NewContext(method, path string, opts ...Option)`       | `(*celeris.Context, *ResponseRecorder)` | You must `defer celeristest.ReleaseContext(ctx)`        |
| `NewContextT(t *testing.T, method, path, opts ...Option)` | `(*celeris.Context, *ResponseRecorder)` | Registers `t.Cleanup` automatically — no defer needed   |

Source: `celeris/celeristest/celeristest.go:254` (`NewContextT`) and
`celeris/celeristest/celeristest.go:264` (`NewContext`).

`NewContextT` is the one to reach for in almost every test — it registers the
release with `t.Cleanup`, so you can't forget it and you won't leak a pooled
context:

```go
import (
    "testing"

    "github.com/goceleris/celeris/celeristest"
)

func TestHello(t *testing.T) {
    ctx, rec := celeristest.NewContextT(t, "GET", "/hello")

    if err := helloHandler(ctx); err != nil {
        t.Fatalf("handler returned error: %v", err)
    }
    if rec.StatusCode != 200 {
        t.Fatalf("status = %d, want 200", rec.StatusCode)
    }
    if got := rec.BodyString(); got != "hello" {
        t.Fatalf("body = %q, want %q", got, "hello")
    }
}
```

The plain `NewContext` is identical except you own the cleanup. Prefer it only
when you're not inside a `*testing.T` (for example, in a benchmark or a table
helper that constructs many contexts in a loop and releases each one eagerly):

```go
func TestHelloManual(t *testing.T) {
    ctx, rec := celeristest.NewContext("GET", "/hello")
    defer celeristest.ReleaseContext(ctx)

    _ = helloHandler(ctx)
    _ = rec
}
```

> Both constructors draw the context, stream, and recorder from `sync.Pool`s.
> The context **must not** be used after `ReleaseContext` (or after the
> `NewContextT` cleanup runs) — it has been recycled. Never stash a `*Context`
> in a package-level variable across tests.

### The `ResponseRecorder`

The recorder is a plain struct with three fields and two convenience methods
(`celeris/celeristest/celeristest.go:26`). It captures exactly one response — the
last one the handler wrote.

| Field / method            | Type           | Description                                                        |
| ------------------------- | -------------- | ----------------------------------------------------------------- |
| `StatusCode`              | `int`          | HTTP status the handler wrote. **`0` if the handler wrote nothing.** |
| `Headers`                 | `[][2]string`  | Response headers as ordered `{key, value}` pairs                  |
| `Body`                    | `[]byte`       | Raw response body bytes                                            |
| `Header(key string)`      | `string`       | Value of the **first** header matching `key`, or `""` if absent   |
| `BodyString()`            | `string`       | `Body` as a string                                                 |

A freshly constructed recorder has `StatusCode == 0`. That zero value is itself a
useful assertion: if a middleware short-circuits *without* writing a response,
the recorder stays at `0` (see [Testing middleware](#testing-middleware)).

```go
func TestUserJSON(t *testing.T) {
    ctx, rec := celeristest.NewContextT(t, "GET", "/users/42",
        celeristest.WithParam("id", "42"))

    if err := getUser(ctx); err != nil {
        t.Fatal(err)
    }
    if rec.StatusCode != 200 {
        t.Fatalf("status = %d", rec.StatusCode)
    }
    if ct := rec.Header("content-type"); ct != "application/json" {
        t.Fatalf("content-type = %q", ct)
    }
    if !strings.Contains(rec.BodyString(), `"id":42`) {
        t.Fatalf("body = %s", rec.BodyString())
    }
}
```

> Header keys are matched **exactly** as the handler wrote them. Celeris writes
> response headers in lower-case (HTTP/2 style), so assert on `"content-type"`,
> not `"Content-Type"`. When in doubt, log `rec.Headers` to see the literal keys.

## Building the request

Everything about the simulated request — body, headers, query string, path
params, auth, cookies, client address, protocol — is configured through `Option`
values passed to the constructor. Each `With*` helper returns an `Option`; pass as
many as you need, in any order. They are defined in
`celeris/celeristest/celeristest.go:129-216`.

| Option                                   | Effect on the test request                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `WithBody(body []byte)`                  | Sets the raw request body (read via `c.Body()`, `c.Bind()`, etc.)                                            |
| `WithHeader(key, value string)`          | Adds a request header. Call multiple times to add several                                                    |
| `WithQuery(key, value string)`           | Adds a query parameter; folded into the request URL so `c.Query(key)` returns it                             |
| `WithParam(key, value string)`           | Sets a captured path parameter (e.g. `:id`), readable via `c.Param(key)`                                     |
| `WithContentType(ct string)`             | Shorthand for `WithHeader("content-type", ct)`                                                               |
| `WithBasicAuth(user, pass string)`       | Sets the `authorization` header to `Basic <base64(user:pass)>`                                               |
| `WithCookie(name, value string)`         | Adds a cookie to the `cookie` header (joined `name=value`, `; ` separated)                                   |
| `WithRemoteAddr(addr string)`            | Sets the peer address returned by `c.RemoteAddr()`                                                           |
| `WithFullPath(path string)`              | Sets the matched route pattern returned by `c.FullPath()` (e.g. `/users/:id`)                                |
| `WithProtocol(version string)`           | Sets the HTTP version. `"1.1"` → HTTP/1.1, `"2"` → HTTP/2                                                     |
| `WithScheme(scheme string)`              | Overrides the scheme returned by `c.Scheme()` (e.g. `"https"`), as the proxy middleware would                |
| `WithTrustedProxies(cidrs ...string)`    | Sets trusted-proxy CIDR ranges for `c.ClientIP()` resolution from `X-Forwarded-For`                          |
| `WithHandlers(handlers ...celeris.HandlerFunc)` | Installs a handler chain so `c.Next()` works — see [Testing middleware](#testing-middleware)         |

### Body, content type, and binding

`WithBody` plus `WithContentType` is the pair you'll use to exercise any handler
that decodes a request body. Because the body and content type are real, `c.Bind`
/ `c.BindJSON` behave exactly as in production:

```go
func TestCreateUser(t *testing.T) {
    ctx, rec := celeristest.NewContextT(t, "POST", "/users",
        celeristest.WithContentType("application/json"),
        celeristest.WithBody([]byte(`{"name":"Ada","age":36}`)),
    )

    if err := createUser(ctx); err != nil {
        t.Fatal(err)
    }
    if rec.StatusCode != 201 {
        t.Fatalf("status = %d, want 201", rec.StatusCode)
    }
}
```

### Query parameters vs. path parameters

These are distinct and easy to mix up:

- **`WithQuery`** appends to the URL query string. `WithQuery("page", "2")` makes
  the request URL `…?page=2`, so `c.Query("page")` returns `"2"`.
- **`WithParam`** sets a *captured route parameter*. In production the router
  fills these by matching the path against the pattern; in a unit test there is no
  router, so you supply them directly. `WithParam("id", "42")` makes
  `c.Param("id")` return `"42"`.

```go
// Handler reads BOTH a path param and a query param.
func TestListUserPosts(t *testing.T) {
    ctx, rec := celeristest.NewContextT(t, "GET", "/users/42/posts",
        celeristest.WithParam("id", "42"),      // c.Param("id")  == "42"
        celeristest.WithQuery("page", "2"),     // c.Query("page") == "2"
        celeristest.WithQuery("page", "3"),     // QueryValues("page") == ["2","3"]
    )

    if err := listUserPosts(ctx); err != nil {
        t.Fatal(err)
    }
    _ = rec
}
```

> If your handler calls `c.FullPath()` (for low-cardinality metric labels — see
> [Routing](/docs/routing)), set it explicitly with `WithFullPath("/users/:id")`.
> Without it, `c.FullPath()` returns `""` in a unit test because no router ran.

### Cookies and basic auth

`WithCookie` writes a well-formed `cookie` header; `c.Cookie(name)` parses it back
out. `WithBasicAuth` base64-encodes the credentials into the `authorization`
header exactly as a browser would:

```go
func TestSession(t *testing.T) {
    ctx, _ := celeristest.NewContextT(t, "GET", "/me",
        celeristest.WithCookie("session", "abc123"),
        celeristest.WithBasicAuth("admin", "s3cret"),
    )

    if v, err := ctx.Cookie("session"); err != nil || v != "abc123" {
        t.Fatalf("cookie = %q, err = %v", v, err)
    }
}
```

> `WithCookie` does **not** escape `;` or CR/LF inside the value — pass
> well-formed values only. To exercise your server's handling of a *malformed*
> cookie header, set the raw header yourself with `WithHeader("cookie", …)`.
> Source: `celeris/celeristest/celeristest.go:159-169`.

### Client IP behind a proxy

`c.ClientIP()` reads `X-Forwarded-For` when present. With trusted-proxy networks
configured, it walks the chain right-to-left, skips entries inside those networks,
and returns the first untrusted IP; without them it returns the **leftmost** XFF
entry (legacy behaviour). It falls back to `X-Real-Ip`, then `""`
(`celeris/context_request.go:422`). To test the trusted-proxy path, combine
`WithHeader` for the forwarded chain with `WithTrustedProxies`:

```go
func TestClientIPBehindProxy(t *testing.T) {
    ctx, _ := celeristest.NewContextT(t, "GET", "/",
        celeristest.WithHeader("x-forwarded-for", "203.0.113.7, 10.0.0.1"),
        celeristest.WithRemoteAddr("10.0.0.1:5000"),
        celeristest.WithTrustedProxies("10.0.0.0/8"),
    )

    // 10.0.0.1 is trusted and skipped; the real client is 203.0.113.7.
    if ip := ctx.ClientIP(); ip != "203.0.113.7" {
        t.Fatalf("ClientIP = %q, want 203.0.113.7", ip)
    }
}
```

### Scheme and protocol

`WithScheme("https")` makes `c.Scheme()` return `"https"` — this models what the
proxy middleware does via `SetScheme`, since `Scheme()` no longer trusts the raw
`X-Forwarded-Proto` header. `WithProtocol` controls the HTTP version reported to
the handler:

```go
ctx, _ := celeristest.NewContextT(t, "GET", "/",
    celeristest.WithScheme("https"),
    celeristest.WithProtocol("2"),
)
// ctx.Scheme() == "https"
```

## Invoking the handler and asserting

A handler is just a function — call it. The recorder captures the result.

```go
// healthz writes its response with c.String(200, "ok").
func TestHealthz(t *testing.T) {
    ctx, rec := celeristest.NewContextT(t, "GET", "/healthz")

    err := healthz(ctx)

    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if rec.StatusCode != 200 {
        t.Fatalf("status = %d", rec.StatusCode)
    }
    // c.String writes content-type "text/plain" (no charset suffix);
    // only c.HTML adds "; charset=utf-8".
    if rec.Header("content-type") != "text/plain" {
        t.Fatalf("content-type = %q", rec.Header("content-type"))
    }
    if rec.BodyString() != "ok" {
        t.Fatalf("body = %q", rec.BodyString())
    }
}
```

There are two independent things to assert on, and a well-rounded test checks both:

1. **The returned `error`.** A handler may return `nil` (it wrote a response
   itself) or a non-nil error (it deferred to centralised error handling — see
   [Error handling](/docs/error-handling)).
2. **The recorder.** Whatever the handler wrote with `c.JSON`, `c.String`,
   `c.NoContent`, etc. is captured here.

> A handler that returns a non-nil error has, by convention, **not** written a
> response — so the recorder typically stays at `StatusCode == 0`. In production
> the engine's error safety net translates that returned error into a response;
> in a unit test *you* assert on the error (see
> [Testing error paths](#testing-error-paths)). If you want to verify the rendered
> response for an error, drive it through the engine in an
> [integration test](#integration-style-testing) instead.

### Cleanup

With `NewContextT` cleanup is automatic. With `NewContext` you are responsible for
calling `ReleaseContext` (`celeris/celeristest/celeristest.go:220`), which returns
the context, its stream, and the recorder to their pools:

```go
ctx, rec := celeristest.NewContext("GET", "/")
defer celeristest.ReleaseContext(ctx)
// ... use ctx and rec ...
```

`defer` is the safe pattern — it runs even if an assertion calls `t.Fatal` or the
handler panics. Do not access `ctx` or `rec` after release.

## Testing middleware

Middleware is a handler that calls `c.Next()` to invoke the rest of the chain
(`celeris/context.go:312`). To test that interaction you need a real chain, which
is exactly what `WithHandlers` builds. List the handlers in execution order; the
last one is the terminal handler:

```go
func TestRequireAuth_AllowsValidToken(t *testing.T) {
    var reached bool
    final := func(c *celeris.Context) error {
        reached = true
        return c.String(200, "ok")
    }

    ctx, rec := celeristest.NewContextT(t, "GET", "/private",
        celeristest.WithHeader("authorization", "Bearer good-token"),
        celeristest.WithHandlers(requireAuth, final),
    )

    // Invoke the FIRST handler in the chain; it drives the rest via c.Next().
    if err := requireAuth(ctx); err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if !reached {
        t.Fatal("middleware did not call Next() — terminal handler never ran")
    }
    if rec.StatusCode != 200 {
        t.Fatalf("status = %d", rec.StatusCode)
    }
}
```

`c.Next()` returns the **first non-nil error** from a downstream handler and
short-circuits the rest of the chain. That is the seam for testing short-circuit
behaviour: a middleware that rejects the request returns its error *before*
calling `Next`, so the terminal handler never runs and the recorder stays at
`0`:

```go
func TestRequireAuth_RejectsMissingToken(t *testing.T) {
    var reached bool
    final := func(c *celeris.Context) error {
        reached = true
        return c.String(200, "ok")
    }

    ctx, rec := celeristest.NewContextT(t, "GET", "/private",
        celeristest.WithHandlers(requireAuth, final),
    )

    err := requireAuth(ctx)

    if reached {
        t.Fatal("terminal handler ran despite missing auth")
    }
    if rec.StatusCode != 0 {
        t.Fatalf("middleware wrote a response (status %d); expected short-circuit with no write", rec.StatusCode)
    }
    if !errors.Is(err, celeris.ErrUnauthorized) {
        t.Fatalf("error = %v, want ErrUnauthorized", err)
    }
}
```

> The handler you call first must be the **head** of the chain you passed to
> `WithHandlers`. `WithHandlers` installs the chain so that `c.Next()` advances
> through it, but it does not call the head for you — you invoke
> `chain[0](ctx)` yourself, and it drives the rest via `Next`.

## Testing error paths

Celeris's idiomatic error is `*celeris.HTTPError`, which carries an HTTP status
code and an optional wrapped error (`celeris/errors.go:55`). Handlers return it to
signal a specific status; middleware and callers match on it with `errors.As` and
`errors.Is`. (For the full model, see [Error handling](/docs/error-handling).)

To assert a handler returns the right status code, unwrap the `*HTTPError`:

```go
func TestGetUser_NotFound(t *testing.T) {
    ctx, _ := celeristest.NewContextT(t, "GET", "/users/999",
        celeristest.WithParam("id", "999"),
    )

    err := getUser(ctx)

    var httpErr *celeris.HTTPError
    if !errors.As(err, &httpErr) {
        t.Fatalf("error = %v, want *celeris.HTTPError", err)
    }
    if httpErr.Code != 404 {
        t.Fatalf("code = %d, want 404", httpErr.Code)
    }
}
```

For the canonical sentinel errors that middleware packages share, match with
`errors.Is`. Both `ErrUnauthorized` (401) and `ErrServiceUnavailable` (503) are
`*HTTPError` values re-exported across the auth and traffic middleware so a single
`errors.Is` matches regardless of which package produced them
(`celeris/errors.go:44` and `celeris/errors.go:50`):

```go
if errors.Is(err, celeris.ErrUnauthorized) {
    // any auth middleware (jwt, keyauth, basicauth) rejected the request
}
if errors.Is(err, celeris.ErrServiceUnavailable) {
    // load was shed (timeout, circuitbreaker, ratelimit)
}
```

If your handler wraps a domain error, `errors.Is` reaches it through
`HTTPError.Unwrap` (`celeris/errors.go:82`):

```go
var ErrUserNotFound = errors.New("user not found")

func getUser(c *celeris.Context) error {
    u, err := db.Find(c.Param("id"))
    if err != nil {
        return celeris.NewHTTPError(404, "user not found").WithError(err)
    }
    return c.JSON(200, u)
}

// In the test:
if !errors.Is(err, ErrUserNotFound) {
    t.Fatalf("expected wrapped ErrUserNotFound, got %v", err)
}
```

## What not to use

`NewContext`, `NewContextT`, the `With*` options, `ResponseRecorder`, and
`ReleaseContext` are the entire supported testing surface. You may notice other
exported functions on the `celeris` package such as `AcquireTestContext`,
`AddTestParam`, `SetTestHandlers`, `SetTestScheme`, and `ReleaseTestContext`.

**Do not call these directly.** They are low-level plumbing that `celeristest`
uses internally to assemble a context from a stream
(`celeris/celeristest/celeristest.go:318-354`); they are exported only so the
`celeristest` package — which lives in a separate package to avoid an import
cycle — can reach them. They take internal types, have no stability guarantees,
and bypass the pooling and reset logic in `NewContext`/`ReleaseContext`. Always
go through the `celeristest` `With*` options:

| Instead of…                       | Use…                                |
| --------------------------------- | ----------------------------------- |
| `celeris.AddTestParam`            | `celeristest.WithParam`             |
| `celeris.SetTestHandlers`         | `celeristest.WithHandlers`          |
| `celeris.SetTestScheme`           | `celeristest.WithScheme`            |
| `celeris.AcquireTestContext`      | `celeristest.NewContext` / `NewContextT` |
| `celeris.ReleaseTestContext`      | `celeristest.ReleaseContext`        |

## Integration-style testing

Unit tests cover handler logic; integration tests cover the wire — routing, the
HTTP parser, the response encoder, middleware ordering, and the engine itself. The
recipe is to start a real server on `:0` (an OS-assigned ephemeral port),
discover the bound address with `Addr()`, and hit it with the standard library's
`net/http` client.

`s.Start()` blocks (it runs the accept loop), so run it in a goroutine, then poll
`s.Addr()` until the listener is bound:

```go
func TestServerIntegration(t *testing.T) {
    s := celeris.New(celeris.Config{Addr: ":0"}) // OS picks a free port
    s.GET("/ping", func(c *celeris.Context) error {
        return c.String(200, "pong")
    })

    go func() {
        if err := s.Start(); err != nil {
            t.Errorf("server start: %v", err)
        }
    }()

    // Start() binds asynchronously; Addr() returns nil until the listener
    // is up, so poll briefly.
    var addr net.Addr
    for i := 0; i < 100; i++ {
        if addr = s.Addr(); addr != nil {
            break
        }
        time.Sleep(5 * time.Millisecond)
    }
    if addr == nil {
        t.Fatal("server never bound an address")
    }

    // Graceful shutdown at the end of the test.
    t.Cleanup(func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        _ = s.Shutdown(ctx)
    })

    resp, err := http.Get("http://" + addr.String() + "/ping")
    if err != nil {
        t.Fatalf("GET /ping: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        t.Fatalf("status = %d", resp.StatusCode)
    }
    body, _ := io.ReadAll(resp.Body)
    if string(body) != "pong" {
        t.Fatalf("body = %q", body)
    }
}
```

Key APIs in play:

- **`celeris.New(Config{Addr: ":0"})`** — `:0` asks the OS for any free port,
  which keeps parallel tests from colliding on a fixed port (`celeris/config.go:64`).
- **`s.Addr() net.Addr`** — returns the listener's bound address, or `nil` if the
  server hasn't started yet. Use it to discover the OS-assigned port
  (`celeris/server.go:433`).
- **`s.Start() error`** — runs the accept loop; it blocks, so call it in a
  goroutine (`celeris/server.go:353`).
- **`s.Shutdown(ctx) error`** — stops accepting new connections, drains in-flight
  requests, fires `OnShutdown` hooks, and returns `nil` if the server was never
  started. Always give it a bounded context (`celeris/server.go:366`).

> Routes must be registered **before** `Start` — handler chains are baked at
> registration time, and the `*Server` is only safe for concurrent use after
> `Start`. See [Routing](/docs/routing).

### Validation and benchmarking

Beyond your own tests, Celeris itself is exercised by
[probatorium](https://github.com/goceleris/probatorium) in two distinct ways you
may see referenced in the project:

- **Validation** (correctness & stability) runs **nightly** (about an hour) and as
  a **weekend soak** (about a day). It hammers the server with realistic
  Markov-chain traffic, fuzzers, adversarial malformed requests, and
  connection / WebSocket torture across engines and architectures, plus a
  deterministic seed-replay corpus. It proves the server stays correct under
  hostile load — it does **not** produce performance numbers.
- **Benchmarking** (performance) runs **weekly and on demand** on a dedicated
  cluster, measuring Celeris against competitor frameworks. Those results publish
  to the [benchmarks dashboard](/benchmarks); see the [methodology](/methodology)
  for how they're run.

This is internal project infrastructure, not something you run for your own app —
your application tests are the `celeristest` unit tests and the integration tests
above.

## Common pitfalls

- **Forgetting cleanup with `NewContext`.** The plain constructor pools its
  resources; you must `defer celeristest.ReleaseContext(ctx)`. Use `NewContextT`
  to make this automatic.
- **Using a context after release.** Both the manual `ReleaseContext` and the
  `NewContextT` cleanup recycle the context. Don't keep a reference to it (or to
  the recorder) past the end of the test.
- **Asserting on capitalised header keys.** Celeris writes response headers in
  lower-case. Assert `rec.Header("content-type")`, not `"Content-Type"`.
- **Confusing `WithQuery` with `WithParam`.** `WithQuery` is the URL query string
  (`c.Query`); `WithParam` is a captured route parameter (`c.Param`).
- **Expecting a rendered body from a returned error.** A handler that returns an
  `*HTTPError` usually wrote nothing — the recorder stays at `StatusCode == 0`.
  Assert on the *error* in unit tests; use an integration test to see the engine
  render the error response.
- **Calling `Start` without a goroutine.** `Start` blocks on the accept loop. Run
  it in `go func(){…}()` and poll `Addr()` for readiness.
- **Reaching for `AddTestParam` / `AcquireTestContext`.** These are internal;
  always use the `celeristest` options.

## FAQ

**Why does `rec.StatusCode` come back as `0`?**
The handler didn't write a response. That's expected when a handler returns an
error (it deferred rendering to the engine) or when a middleware short-circuited
without writing. Assert on the returned error instead.

**Do I need a `*Server` to unit-test a handler?**
No. `celeristest.NewContextT` builds a standalone `*Context` with no server
attached. You only need a server for [integration tests](#integration-style-testing)
that go over the wire.

**How do I test a handler that reads the matched route pattern?**
Set it with `WithFullPath("/users/:id")`. Without a router, `c.FullPath()` is `""`
in a unit test.

**Can I run integration tests in parallel?**
Yes — bind each server to `:0` so the OS hands out distinct ports, then read the
actual address from `s.Addr()`. Avoid a hard-coded port, which would collide.

**How do I assert on a specific status for an error my handler returns?**
Unwrap it: `var e *celeris.HTTPError; errors.As(err, &e)` then check `e.Code`. For
the shared sentinels (`ErrUnauthorized`, `ErrServiceUnavailable`) use
`errors.Is`.

## See also

- [Error handling](/docs/error-handling) — `*HTTPError`, sentinel errors, and how
  the engine renders returned errors into responses.
- [Request handling](/docs/request-handling) — the `Context` accessors
  (`Body`, `Bind`, `Query`, `Param`, `Cookie`, `ClientIP`, `Scheme`) you assert
  against in tests.
- [Middleware](/docs/middleware) — chain composition and ordering, the model
  behind `c.Next()` and `WithHandlers`.
- [Routing](/docs/routing) — route patterns, captured parameters, and `FullPath`.
