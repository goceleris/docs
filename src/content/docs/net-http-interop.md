---
title: Using net/http handlers and middleware
description: Adapt existing net/http handlers and middleware, and mount Celeris under the standard library.
group: Data & Integration
order: 2
---

Celeris handlers have the signature `func(c *celeris.Context) error`, not the
standard library's `func(w http.ResponseWriter, r *http.Request)`. That difference
is what lets Celeris run its own request lifecycle — but it also means you cannot
drop an existing `http.Handler` straight into a route. The interop layer closes
that gap in both directions:

- **Into Celeris** — wrap an `http.Handler`, an `http.HandlerFunc`, or a
  `func(http.Handler) http.Handler` middleware so it runs inside a Celeris chain.
- **Out of Celeris** — expose a `celeris.HandlerFunc` as a plain `http.Handler`
  for stdlib routers, test harnesses, or `httptest`.
- **A batteries-included reverse proxy** built on `net/http/httputil`.

Everything here is an *adapter*: it reconstructs an `*http.Request`, runs the
stdlib code against a buffering response writer, and copies the result back. That
is convenient and correct for the vast majority of handlers, but it is **not**
zero-copy and it does **not** support streaming or connection hijack. The
[Caveats](#caveats) section is required reading before you put an adapter on a hot
path.

## Why interop

The point of interop is **incremental migration and ecosystem reuse**. You rarely
rewrite a service in one commit. With the adapters you can:

- Mount an existing `http.ServeMux`, a `gorilla/mux` router, or a third-party
  handler under a Celeris route while you port endpoints one at a time.
- Keep using a battle-tested stdlib middleware — `rs/cors`, `gorilla/csrf`, a
  vendor SDK's auth middleware — until a native equivalent exists or you decide
  the adapter overhead is acceptable.
- Reuse your stdlib-based tests: `celeris.ToHandler` produces something
  `net/http/httptest` can drive directly.
- Stand up a reverse proxy to a legacy backend in one line.

The adapters live in two places: the core `Adapt`/`AdaptFunc`/`ToHandler`
functions are on the `celeris` package itself, and the middleware/proxy adapters
are in the `github.com/goceleris/celeris/middleware/adapters` package.

```go
import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/adapters"
)
```

## Adapt an `http.Handler` into a Celeris handler

`celeris.Adapt` turns any `http.Handler` into a `celeris.HandlerFunc` you can pass
to `s.GET`, `s.POST`, a route group, `s.Use`, or any other place a handler is
expected. Source: `celeris/bridge.go:16`.

```go
func Adapt(h http.Handler) celeris.HandlerFunc
```

Under the hood, `Adapt` reconstructs an `*http.Request` from the Celeris
`Context` (method, path, query, headers, body, and request context), runs the
stdlib handler against an in-memory response writer, and then replays the captured
status, headers, and body through `c.Blob`.

```go
// An existing stdlib handler — maybe vendored, maybe legacy code you haven't
// ported yet.
func legacyHello(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/plain")
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte("hello from net/http"))
}

s := celeris.New(celeris.Config{Addr: ":8080"})

// Mount the stdlib handler on a Celeris route.
s.GET("/legacy", celeris.Adapt(http.HandlerFunc(legacyHello)))
```

### Mounting a whole stdlib router

Because a `*http.ServeMux` (or any third-party router) is itself an
`http.Handler`, you can mount an entire sub-tree behind a Celeris catch-all and
migrate routes out of it one at a time:

```go
// The old mux still owns these paths.
old := http.NewServeMux()
old.HandleFunc("/old/reports", reportsHandler)
old.HandleFunc("/old/admin", adminHandler)

s := celeris.New(celeris.Config{Addr: ":8080"})

// Native Celeris routes win by specificity; everything else under /old/*
// falls through to the legacy mux.
s.GET("/old/*path", celeris.Adapt(old))
s.GET("/", homeHandler) // already ported to Celeris
```

> The catch-all `*path` pattern is required so the route matches any sub-path — but `Adapt`
> does **not** read the `*path` parameter for path reconstruction. It uses `c.Path()`, the full
> concrete request path, so the wrapped handler sees the correct URL regardless of how the
> catch-all is named. See [Routing](/docs/routing) for how catch-all segments and match precedence work.
>
> `Adapt`, `AdaptFunc`, and `ToHandler` ship in the core `celeris` package — no extra import needed.

### `AdaptFunc` — the `http.HandlerFunc` shorthand

`celeris.AdaptFunc` is a convenience wrapper, exactly equivalent to
`Adapt(http.HandlerFunc(h))`. Use it when you have a bare function rather than a
type that already implements `http.Handler`. Source: `celeris/bridge.go:51`.

```go
func AdaptFunc(h http.HandlerFunc) celeris.HandlerFunc
```

```go
s.GET("/legacy", celeris.AdaptFunc(legacyHello)) // no manual http.HandlerFunc(...)
```

### Semantics and limitations

What the adapted handler sees, and how its output is mapped back:

| Aspect            | Behaviour                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Request method    | Taken from the Celeris request.                                                            |
| URL / query       | The Celeris path plus raw query string are reconstructed onto the `*http.Request`.         |
| Request body      | Read from `c.Body()` and exposed on `r.Body`; an empty body leaves `r.Body` as `http.NoBody`. |
| Request headers   | All non-pseudo headers (those not starting with `:`) are copied across.                     |
| `r.Host`          | Set from the `:authority` header when present.                                              |
| `r.ContentLength` | Parsed from the `content-length` request header when valid.                                 |
| Request context   | The handler's `r.Context()` is the Celeris request context.                                 |
| Response status   | Whatever the handler writes; defaults to `200` if it never calls `WriteHeader`.             |
| Response headers  | Copied back to the Celeris response (header names are lower-cased).                          |
| Response body     | **Buffered fully in memory**, then written via `c.Blob`.                                    |

The two hard limits to remember:

- **The response is buffered, not streamed.** The stdlib handler writes into an
  in-memory buffer; nothing reaches the client until the handler returns. Flushes
  are not propagated. This rules out Server-Sent Events, chunked streaming, and
  long-poll handlers through `Adapt` — write those natively (see [Streaming](/docs/streaming)
  and [Server-Sent Events](/docs/sse)).
- **The response body is capped at 100 MB.** If the handler tries to write more
  than 100 MB, the underlying `Write` returns an error to the stdlib handler;
  `Adapt` does not inspect this and still replays the bytes buffered before the
  limit with the handler's own status (200 unless it called `WriteHeader`), so the
  client may receive a truncated response. Source: `celeris/bridge.go:109-117`.

> The reconstructed `http.ResponseWriter` does **not** implement `http.Hijacker`
> or `http.Flusher`. A handler that type-asserts for either (WebSocket upgrade,
> SSE flush) will not get it — port that handler to a native Celeris handler
> instead.

## Expose a Celeris handler as an `http.Handler`

`celeris.ToHandler` is the reverse of `Adapt`: it wraps a `celeris.HandlerFunc`
so it satisfies the standard `http.Handler` interface. This is what you reach for
when you want to mount a Celeris handler inside a stdlib router, or — most
commonly — drive it from `net/http/httptest`. Source: `celeris/stdlib.go:22`.

```go
func ToHandler(h celeris.HandlerFunc) http.Handler
```

```go
hello := func(c *celeris.Context) error {
    return c.JSON(200, map[string]string{"msg": "hi"})
}

// Mount inside a stdlib mux.
mux := http.NewServeMux()
mux.Handle("/hello", celeris.ToHandler(hello))
log.Fatal(http.ListenAndServe(":8080", mux))
```

Driving a Celeris handler from `httptest` without spinning up a real server:

```go
func TestHello(t *testing.T) {
    h := celeris.ToHandler(func(c *celeris.Context) error {
        return c.JSON(200, map[string]string{"msg": "hi"})
    })

    req := httptest.NewRequest(http.MethodGet, "/hello", nil)
    rec := httptest.NewRecorder()

    h.ServeHTTP(rec, req)

    if rec.Code != http.StatusOK {
        t.Fatalf("got %d, want 200", rec.Code)
    }
}
```

What `ToHandler` carries across from the incoming `*http.Request` into the Celeris
`Context`:

| Field on `*http.Request` | Mapped into Celeris as                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `r.Method`               | request method (`:method`)                                       |
| `r.RequestURI`           | request path (`:path`) — note `RequestURI` includes the raw query string |
| `r.TLS`                  | scheme — `https` when non-nil, otherwise `http`                  |
| `r.Host`                 | `:authority`                                                      |
| `r.Header`               | request headers (names lower-cased)                              |
| `r.Body`                 | request body                                                      |
| `r.RemoteAddr`           | `c.RemoteAddr()`                                                  |
| `r.ProtoMajor`           | protocol major version                                           |

Two limits mirror the other direction:

- The **request body is read fully into memory** and capped at 100 MB; a larger
  body returns `413 Request Entity Too Large`, and a read error returns `400`.
  Source: `celeris/stdlib.go:47-61`.
- If the Celeris handler returns a non-nil `error` and nothing has been written
  yet, `ToHandler` responds with `500 Internal Server Error`. A panic in the
  handler is recovered and also yields a `500` (when the response is not already
  flushed). Source: `celeris/stdlib.go:73-89`.

## Wrap net/http middleware

The most valuable adapter for migration is `adapters.WrapMiddleware`. It adapts
the ubiquitous `func(http.Handler) http.Handler` middleware idiom — used by
`rs/cors`, `gorilla/csrf`, `gorilla/handlers`, and countless in-house libraries —
into a `celeris.HandlerFunc` you can register with `s.Use`, on a group, or on a
single route. Source: `celeris/middleware/adapters/adapters.go:32`.

```go
func WrapMiddleware(mw func(http.Handler) http.Handler) celeris.HandlerFunc
```

```go
import (
    "net/http"

    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/adapters"
)

// A standard func(http.Handler) http.Handler middleware.
addHeader := func(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Middleware", "active")
        next.ServeHTTP(w, r)
    })
}

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(adapters.WrapMiddleware(addHeader)) // runs for every route
s.GET("/", func(c *celeris.Context) error {
    return c.String(200, "ok")
})
```

Using a real third-party library, e.g. `rs/cors`:

```go
corsHandler := cors.Handler(cors.Options{AllowedOrigins: []string{"*"}})
s.Use(adapters.WrapMiddleware(corsHandler))
```

For where `s.Use`, group `Use`, and route `Use` sit in the execution order, see
[Middleware](/docs/middleware).

### How short-circuiting is handled

`WrapMiddleware` reconstructs an `*http.Request` and runs your stdlib middleware
against a capturing `http.ResponseWriter`. The middleware is then free to do one
of two things, and the adapter handles both:

| Middleware behaviour                              | What the adapter does                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Calls `next.ServeHTTP`** (the common case)      | Headers it set before the call are copied to the Celeris response, then the Celeris chain continues via `c.Next()`. |
| **Does not call the inner handler** (e.g. a 403)  | The Celeris chain is aborted; the captured status, headers, and body are written back via `c.Blob`. |

That second row is what makes auth/CORS middleware work correctly: a stdlib
middleware that rejects a request with `403` (without ever calling `next`) cleanly
stops the Celeris chain and returns its own response.

```go
// A stdlib auth gate that short-circuits unauthenticated requests.
requireKey := func(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Header.Get("X-API-Key") != "secret" {
            http.Error(w, "forbidden", http.StatusForbidden) // never calls next
            return
        }
        next.ServeHTTP(w, r)
    })
}

s.Use(adapters.WrapMiddleware(requireKey))
// Requests without the key get a 403 straight from the stdlib middleware;
// the Celeris handler chain never runs.
```

Panics raised inside the Celeris chain are propagated back out *after* the stdlib
middleware returns, so your Celeris recovery middleware sees the original panic
value rather than having it swallowed by a `recover()` inside the stdlib
middleware. Source: `celeris/middleware/adapters/adapters.go:57-72`.

### Limitations of wrapped middleware

- **`nil` panics.** `WrapMiddleware(nil)` panics with
  `adapters: WrapMiddleware argument must not be nil`. Source:
  `celeris/middleware/adapters/adapters.go:33-35`.
- **No `Hijacker` / `Flusher`.** The capturing response writer implements neither,
  so middleware that needs WebSocket upgrade or streaming flush will not work
  through `WrapMiddleware`. Implement those natively.
- **Per-call allocation cost.** Each invocation reconstructs an `*http.Request`
  (roughly 8–15 heap allocations depending on header count and body). For
  middleware on every request, see [Caveats](#caveats).
- **Do not double up with native equivalents.** Running, say, `rs/cors` via
  `WrapMiddleware` *and* the native `celeris/middleware/cors` in the same chain
  produces duplicate `Access-Control-*` headers and conflicting preflight
  handling. Pick one. Source: `celeris/middleware/adapters/doc.go:10-13`.

## Built-in reverse proxy

`adapters.ReverseProxy` wraps the standard library's `net/http/httputil`
`ReverseProxy` into a `celeris.HandlerFunc`, so forwarding to a backend is a
one-liner. Source: `celeris/middleware/adapters/adapters.go:210`.

```go
func ReverseProxy(target *url.URL, opts ...adapters.Option) celeris.HandlerFunc
```

```go
target, _ := url.Parse("http://backend:8080")

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Any("/api/*path", adapters.ReverseProxy(target))
```

The proxy automatically sets `X-Forwarded-For`, `X-Forwarded-Host`, and
`X-Forwarded-Proto` on the outbound request (via
`httputil.ProxyRequest.SetXForwarded`). It **panics if `target` is `nil`**.
Source: `celeris/middleware/adapters/adapters.go:210-237`.

### Options

Configure the proxy with functional options. Source:
`celeris/middleware/adapters/config.go`.

| Option                                                                  | Configures                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `WithTransport(rt http.RoundTripper)`                                   | The `http.RoundTripper` used to reach the backend (timeouts, pooling, TLS).                      |
| `WithModifyRequest(f func(*http.Request))`                              | Mutate the outbound request before it is sent (add headers, rewrite paths).                      |
| `WithModifyResponse(f func(*http.Response) error)`                      | Inspect or modify the backend response before forwarding; returning an error invokes the error handler. |
| `WithErrorHandler(f func(http.ResponseWriter, *http.Request, error))`   | Handle proxy failures (connection refused, timeout); defaults to `httputil`'s built-in handler. |

A fully configured example:

```go
target, _ := url.Parse("http://backend:8080")

proxy := adapters.ReverseProxy(target,
    // Custom transport with timeouts.
    adapters.WithTransport(&http.Transport{
        ResponseHeaderTimeout: 5 * time.Second,
    }),
    // Tag every outbound request.
    adapters.WithModifyRequest(func(r *http.Request) {
        r.Header.Set("X-Forwarded-By", "celeris")
    }),
    // Rewrite a response header coming back from the backend.
    adapters.WithModifyResponse(func(resp *http.Response) error {
        resp.Header.Set("X-Proxy", "celeris")
        return nil
    }),
    // Friendly error when the backend is down.
    adapters.WithErrorHandler(func(w http.ResponseWriter, r *http.Request, err error) {
        w.WriteHeader(http.StatusBadGateway)
        _, _ = w.Write([]byte("backend unavailable"))
    }),
)

s.Any("/api/*path", proxy)
```

> `ReverseProxy` delegates to `celeris.Adapt` (Source:
> `celeris/middleware/adapters/adapters.go:236`), so it inherits the same **buffering**
> behaviour: the backend response is read fully into memory (100 MB cap) before it
> reaches the client. **Streaming responses — SSE, WebSocket upgrade, or large
> downloads — are not supported through this proxy.** Source:
> `celeris/bridge.go:92-117`.

## Caveats

The adapters are correct and convenient, but they are a compatibility shim, not a
performance feature. Know the trade-offs before you commit to one.

- **Adapter overhead.** Every adapted call reconstructs an `*http.Request` and
  routes through a capturing `http.ResponseWriter`. `WrapMiddleware` costs roughly
  8–15 heap allocations per request. On a hot path served thousands of times per
  second, that overhead is measurable. Source:
  `celeris/middleware/adapters/adapters.go:104-152` (`buildRequest`).
- **No zero-copy, no streaming.** `Adapt`, `WrapMiddleware`, and `ReverseProxy`
  all buffer the full response in memory (100 MB cap). `ToHandler` buffers the
  request body the same way. Nothing flushes incrementally.
- **No hijack or flush.** None of the adapter response writers implement
  `http.Hijacker` or `http.Flusher`. WebSocket upgrade, SSE, and chunked
  streaming must be written as native Celeris handlers.
- **When to port natively instead.** Reach for a native handler or native
  middleware when: the route is on a hot path; you need streaming, SSE, or
  WebSocket; a native Celeris equivalent already exists (e.g. CORS, auth,
  compression — see the [Middleware](/docs/middleware) hub); or the response can
  be large. Use the adapters for migration glue and for stdlib libraries that
  have no native counterpart and run infrequently.

## Common pitfalls

- **Streaming through an adapter silently buffers.** An SSE or chunked handler
  wrapped with `Adapt` will appear to "work" but the client receives nothing until
  the handler finishes, and large streams hit the 100 MB cap. Write streaming
  handlers natively — see [Streaming](/docs/streaming) and [Server-Sent Events](/docs/sse).
- **Stacking a wrapped stdlib middleware on top of its native Celeris twin.**
  Duplicate headers and conflicting behaviour result. Use one or the other.
- **Passing a `nil` middleware or proxy target.** `WrapMiddleware(nil)` and
  `ReverseProxy(nil)` both panic at construction — fail-fast, but make sure your
  `url.Parse` error is handled before you pass the result in.
- **Expecting `Hijack()`/`Flush()` to be available.** A type assertion for either
  interface inside an adapted handler will fail. That code path needs a native
  handler.
- **Forgetting the catch-all when mounting a sub-router.** Mount a stdlib mux on a
  catch-all pattern (`/old/*path`), not a static path, or it only matches the exact
  prefix. See [Routing](/docs/routing).

## FAQ

**Can I adapt a `gorilla/mux` router or a `chi` router?**
Yes — both implement `http.Handler`, so `celeris.Adapt(router)` works. Mount it on
a catch-all route and migrate endpoints out over time.

**Does `Adapt` pass the request context through?**
Yes. The reconstructed `*http.Request` uses the Celeris request context
(`c.Context()`), so deadlines, cancellation, and context values flow into the
stdlib handler. Source: `celeris/bridge.go:67`.

**How do I test a Celeris handler with `httptest`?**
Wrap it with `celeris.ToHandler` and call `ServeHTTP` against an
`httptest.NewRecorder` — no live server required. See [Testing](/docs/testing)
for the full testing story.

**My wrapped CORS/auth middleware returns its own 403 — does the Celeris handler
still run?**
No. When the stdlib middleware does not call `next.ServeHTTP`, the Celeris chain
is aborted and the middleware's captured response is returned verbatim.

**Why is the response capped at 100 MB?**
The adapters buffer the full body in memory, and the 100 MB cap is a safety bound
against unbounded buffering. If you need to move more than that, you need a
streaming native handler rather than an adapter.

## See also

- [Middleware](/docs/middleware) — global, group, and per-route middleware ordering,
  plus the native middleware hub (CORS, auth, compression, and more).
- [Routing](/docs/routing) — catch-all patterns and match precedence for mounting
  sub-routers.
- [Streaming](/docs/streaming) and [Server-Sent Events](/docs/sse) — when you need
  to stream instead of buffer.
- [Testing](/docs/testing) — drive Celeris handlers from `net/http/httptest` via
  `ToHandler`.
