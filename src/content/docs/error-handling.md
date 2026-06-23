---
title: Error handling
description: Return errors from handlers, map them to HTTP responses, centralize handling, and recover from panics.
group: Routing & Handlers
order: 5
---

In Celeris, errors are **return values**, not exceptions. Every handler and
middleware has the signature `func(c *celeris.Context) error`. When a handler
returns a non-nil error, Celeris propagates it up the middleware chain and,
if nobody handles it, maps it to an HTTP response through a built-in safety net.

This page covers the full model: how errors flow, the `HTTPError` type that
controls the status code, flow control with `Abort`, centralizing handling with
`Server.OnError`, custom 404/405 handlers, the sentinel errors the standard
middleware share, and how to recover from panics.

## The model

A request runs a chain of handlers (middleware first, then your route handler).
Each link calls the next with [`c.Next()`](/docs/middleware), which **returns the
first non-nil error from anything downstream** and short-circuits the rest of the
chain:

```go
// c.Next executes the next handler in the chain. It returns the first
// non-nil error from a downstream handler, short-circuiting the remainder.
func loggingMiddleware(c *celeris.Context) error {
    start := time.Now()
    err := c.Next() // run everything downstream
    log.Printf("%s %s -> %v (%s)", c.Method(), c.Path(), err, time.Since(start))
    return err // propagate
}
```

Because `c.Next()` surfaces the downstream error, a middleware sitting above a
handler can do one of three things with it:

| Choice | How | Effect |
| --- | --- | --- |
| **Propagate** | `return c.Next()` | The error keeps flowing up; eventually the safety net (or `OnError`) writes the response. |
| **Swallow** | call `c.Next()`, ignore the error, `return nil` | The error is suppressed. You should write your own response first, or the request gets a default. |
| **Replace** | inspect the error, `return someOtherError` | Translate a low-level error into an `HTTPError`, redact a message, etc. |

If an error reaches the top of the chain unhandled, Celeris's **safety net**
turns it into a response automatically (see [HTTPError](#httperror)). You never
have to write a status code for the error path unless you want to customize it.

A bare handler returning an error looks like this:

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    u, err := store.Find(c.Param("id"))
    if err != nil {
        return err // propagates; safety net maps it to 500 by default
    }
    return c.JSON(200, u)
})
```

## HTTPError

To control the status code and the message sent to the client, return a
`*celeris.HTTPError`. It is a small struct:

```go
type HTTPError struct {
    Code    int    // HTTP status code, e.g. 400, 404, 500
    Message string // human-readable description sent in the response body
    Err     error  // optional wrapped cause, for errors.Is / errors.As
}
```

Construct one with `NewHTTPError`, and optionally attach an underlying cause with
`WithError` (which returns the same `*HTTPError` for chaining):

```go
s.GET("/item/:id", func(c *celeris.Context) error {
    item, err := store.Find(c.Param("id"))
    if errors.Is(err, sql.ErrNoRows) {
        return celeris.NewHTTPError(404, "item not found")
    }
    if err != nil {
        // Wrap the cause so logs/OnError can inspect it, but the client
        // only ever sees the Message.
        return celeris.NewHTTPError(502, "upstream unavailable").WithError(err)
    }
    return c.JSON(200, item)
})
```

When an `*HTTPError` reaches the safety net, Celeris:

- Sets the response status to `Code`.
- Writes `Message` as the body with `Content-Type: text/plain` and
  `Cache-Control: no-store`.
- **Never** sends the wrapped `Err` to the client — it exists only for your own
  `errors.Is` / `errors.As` matching and logging.

The safety net uses `errors.As`, so an `*HTTPError` works even when it has been
wrapped further up the stack:

```go
return fmt.Errorf("handling order %s: %w",
    id, celeris.NewHTTPError(409, "order already shipped"))
// safety net still extracts Code=409, Message="order already shipped"
```

Any error that is **not** an `*HTTPError` (and does not wrap one) maps to
`500 Internal Server Error` with a generic `Internal Server Error` body — the
original error text is never leaked to the client.

> `HTTPError.Error()` returns a string like `code=404, message=item not found`.
> That representation is for **your logs**, not the response body. The client
> only sees `Message`.

### Reusing an HTTPError as a sentinel

Because `HTTPError` implements `Unwrap()`, you can define your own package-level
errors and match them anywhere with `errors.Is`:

```go
var ErrQuotaExceeded = celeris.NewHTTPError(429, "quota exceeded")

func charge(c *celeris.Context) error {
    if overQuota(c) {
        return ErrQuotaExceeded
    }
    // ...
}

// elsewhere, e.g. in middleware or OnError:
if errors.Is(err, ErrQuotaExceeded) { /* ... */ }
```

Do **not** mutate a shared `HTTPError`'s fields at request time — it is shared
across all requests. Build a fresh one with `NewHTTPError` if a request needs a
distinct message. (The same rule applies to the framework sentinels below.)

## Flow control vs errors

Returning an error is one way to stop a request. **Aborting** is another, and
the two are independent. `Abort` stops the chain without (necessarily) producing
an error:

```go
func (c *Context) Abort()                       // stop the chain, write nothing
func (c *Context) AbortWithStatus(code int) error // stop and send `code` with no body
func (c *Context) IsAborted() bool              // was the chain aborted?
```

Use `Abort` from middleware when you have **already written a response** and want
to prevent the rest of the chain from running:

```go
func maintenanceGate(c *celeris.Context) error {
    if maintenanceMode() {
        c.Abort()
        return c.JSON(503, map[string]string{"status": "maintenance"})
    }
    return c.Next()
}
```

`AbortWithStatus` is a shortcut that aborts and writes a status with an empty
body (it returns the error from `NoContent` so you can propagate it):

```go
func requireHeader(c *celeris.Context) error {
    if c.Header("X-Api-Version") == "" {
        return c.AbortWithStatus(400) // stop the chain, send 400, empty body
    }
    return c.Next()
}
```

> **There is no error accumulator.** Celeris has no `c.Error(err)` method that
> collects errors on the context, and no `AbortWithError`. The contract is
> simple: a handler communicates failure by **returning** an error. Abort is
> purely for flow control.

## Centralized handling with OnError

For a consistent error response across your whole app, register a global handler
with `Server.OnError`. It runs **after all middleware has had its chance** and
**before** the default text/plain fallback — i.e. it is the one place to shape
every unhandled error into your house format.

```go
func (s *Server) OnError(handler func(c *Context, err error)) *Server
```

The canonical pattern is a JSON envelope that honors `HTTPError` codes and falls
back to 500:

```go
s.OnError(func(c *celeris.Context, err error) {
    code := 500
    msg := "internal server error"

    var he *celeris.HTTPError
    if errors.As(err, &he) {
        code = he.Code
        msg = he.Message
    }

    // Log the full error (including any wrapped cause) server-side only.
    log.Printf("request error: %v", err)

    _ = c.JSON(code, map[string]any{
        "error": map[string]any{
            "code":    code,
            "message": msg,
        },
    })
})
```

Key facts about `OnError`:

- It **should write a response.** If your handler writes nothing, Celeris falls
  back to the default text/plain output (the same one described under
  [HTTPError](#httperror)).
- It is only invoked for **unhandled** errors. If a handler already wrote a
  response (`c.IsWritten()` is true), `OnError` is skipped — Celeris will not
  overwrite a committed response.
- It must be set **before** `Start` (registration is not safe to change once the
  server is serving).
- Pair it with [`requestid`](/docs/middleware) so each logged error carries a
  correlation ID via `c.RequestID()`.

```go
s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(requestid.New())
s.OnError(jsonErrorHandler)
// ... routes ...
log.Fatal(s.Start())
```

## Custom 404 and 405 handlers

Two dedicated hooks handle the "no matching route" cases. They take an ordinary
`HandlerFunc`:

```go
func (s *Server) NotFound(handler HandlerFunc) *Server
func (s *Server) MethodNotAllowed(handler HandlerFunc) *Server
```

- **`NotFound`** runs when no route matches the path at all. Without it, Celeris
  sends `404 Not Found` as `text/plain`.
- **`MethodNotAllowed`** runs when the path matches but the method does not (e.g.
  `POST` to a `GET`-only route). The **`Allow` header is set automatically** to
  the list of supported methods before your handler runs. Without it, Celeris
  sends `405 Method Not Allowed` as `text/plain`, again with the `Allow` header.

```go
s.NotFound(func(c *celeris.Context) error {
    return c.JSON(404, map[string]string{"error": "not found"})
})

s.MethodNotAllowed(func(c *celeris.Context) error {
    // Allow header is already populated for you.
    return c.JSON(405, map[string]string{
        "error":   "method not allowed",
        "allowed": c.Header("Allow"), // reads the auto-set value
    })
})
```

These handlers run *inside* the error path, so if they themselves return an
error it flows through `OnError` / the safety net like any other.

## Writing first, then returning an error is a no-op

Once a response has been committed, the error path cannot overwrite it. Every
response method (`JSON`, `Blob`, `String`, `NoContent`, …) is guarded by the
"already written" check and returns `celeris.ErrResponseWritten` if you call a
second one. More importantly, the safety net and `OnError` both check
`c.IsWritten()` and **skip** if the response is already on the wire:

```go
func (c *Context) IsWritten() bool // true once a response has been committed
```

```go
s.GET("/half-written", func(c *celeris.Context) error {
    _ = c.JSON(200, partialResult) // committed: status 200 sent
    return errors.New("too late")  // IGNORED — body is already 200/partialResult
})
```

The error is still returned (middleware above can log it), but it will **not**
change the status code or body. Decide your outcome before you write. If you need
to validate before committing, do the checks first and return the error instead
of writing.

## Sentinel errors reference

Celeris exports a set of package-level sentinel errors. Match them with
`errors.Is`; treat them as read-only.

### Canonical HTTP sentinels

These two are `*HTTPError` values, so returning one both signals intent **and**
sets the correct status through the safety net:

| Sentinel | Status | Meaning |
| --- | --- | --- |
| `celeris.ErrUnauthorized` | 401 | Canonical "Unauthorized" used by all auth middleware. |
| `celeris.ErrServiceUnavailable` | 503 | Canonical "Service Unavailable" used by load-shedding middleware. |

Auth middleware (`jwt`, `keyauth`, `basicauth`) **re-export**
`ErrUnauthorized`, and load-shedding middleware (`timeout`, `circuitbreaker`)
re-export `ErrServiceUnavailable`, all as the *same* value. That means
`errors.Is` matches across a mixed middleware stack:

```go
import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/jwt"
)

// Whether the 401 came from jwt, keyauth, basicauth, or your own handler:
if errors.Is(err, celeris.ErrUnauthorized) { /* uniform handling */ }

// jwt.ErrUnauthorized == celeris.ErrUnauthorized, so this is equivalent:
if errors.Is(err, jwt.ErrUnauthorized) { /* ... */ }
```

### Operational sentinels

Returned by various `Context` (and one `Server`) method — plain `error`s, not
`HTTPError`s:

| Sentinel | Returned by |
| --- | --- |
| `celeris.ErrNoCookie` | `Context.Cookie` when the named cookie is absent. |
| `celeris.ErrEmptyBody` | `Context.Bind`, `Context.BindJSON`, `Context.BindXML` when the request body is empty. |
| `celeris.ErrResponseWritten` | A `Context` response method called after the response was already written. |
| `celeris.ErrDetached` | Standard response writers (`Context.JSON`, `Context.String`, …) on a detached context (WebSocket/SSE). |
| `celeris.ErrInvalidRedirectCode` | `Context.Redirect` with a status outside 300–308. |
| `celeris.ErrHijackNotSupported` | `Context.Hijack` when the connection cannot be taken over (e.g. HTTP/2). |
| `celeris.ErrAcceptControlNotSupported` | `Server.PauseAccept` / `Server.ResumeAccept` on an engine without accept control. |

> Never mutate a shared sentinel. They are package-level singletons; changing one
> affects every caller and every `errors.Is` check across the process.

## Recovering from panics

A panic in a handler must not crash the server. Celeris gives you two layers.

### The recommended layer: recovery middleware

Install [`middleware/recovery`](/docs/middleware) to convert panics into normal
errors (which then flow through `OnError` / the safety net), with logging and a
configurable response.

```go
import "github.com/goceleris/celeris/middleware/recovery"

s.Use(recovery.New()) // 4 KB stack capture, JSON 500 response by default
```

The default response is `{"error":"Internal Server Error"}` with status 500.
To customize, pass a `recovery.Config`. The full set of fields:

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `ErrorHandlerErr` | `func(c, error) error` | — | **Preferred** handler. Receives the panic as an `error` (non-error panic values are wrapped with `fmt.Errorf`), so `errors.Is`/`errors.As` work. Wins if both handlers are set. |
| `ErrorHandler` | `func(c, any) error` | JSON 500 | Legacy handler receiving the raw panic value. Kept for backward compatibility. |
| `BrokenPipeHandler` | `func(c, any) error` | — | Custom response when the panic is a broken pipe / connection reset (client disconnected). |
| `StackSize` | `int` | 4096 | Max bytes of stack trace to capture. `0` disables capture (value/method/path still logged). |
| `DisableLogStack` | `bool` | false | Suppress panic logging entirely (panics are still caught). |
| `StackAll` | `bool` | false | Capture all goroutine stacks, not just the current one. |
| `DisableBrokenPipeLog` | `bool` | false | Suppress the WARN log for broken-pipe panics. |
| `Logger` | `*slog.Logger` | `slog.Default()` | slog logger for panic entries. |
| `LogLevel` | `slog.Level` | `slog.LevelError` | Level for normal panic logs (broken pipe is always WARN). |
| `Skip` / `SkipPaths` | func / `[]string` | — | Exclude specific requests/paths from recovery. |

Prefer `ErrorHandlerErr` for new code — it matches the typed-error pattern used
by the rest of the middleware family:

```go
s.Use(recovery.New(recovery.Config{
    StackSize: 8192,
    ErrorHandlerErr: func(c *celeris.Context, err error) error {
        // err is the panic value as an error; errors.Is/As work here.
        log.Printf("recovered: %v", err)
        return c.JSON(500, map[string]string{"error": "internal error"})
    },
}))
```

The middleware exports sentinels for the cases it recognizes, so a downstream
handler (or your `OnError`) can branch with `errors.Is`:

| Sentinel | Meaning |
| --- | --- |
| `recovery.ErrPanic` | Base sentinel for a recovered panic. |
| `recovery.ErrBrokenPipe` | Panic caused by a broken pipe / `ECONNRESET` (client gone). |
| `recovery.ErrPanicContextCancelled` | Panic occurred after the request context was cancelled. |
| `recovery.ErrPanicResponseCommitted` | Panic occurred after the response was already committed. |

Two behaviors worth knowing:

- **`http.ErrAbortHandler` is re-panicked**, not recovered, preserving the
  standard library's abort semantics.
- **Ordering matters.** Register `recovery` *after* `logger`/`metrics` in your
  `Use` chain so those middleware still observe the 500 produced by a recovered
  panic. See the middleware ordering guidance in
  [Middleware](/docs/middleware).

> **Performance note.** The default logger is `slog.Default()`, which usually
> writes to stderr behind a global mutex. If your handlers can panic at high
> rates, pass a non-blocking `Logger` (e.g. an async slog handler, or
> `slog.New(slog.NewTextHandler(io.Discard, nil))`) to avoid gating the worker
> on stderr writes.

### The last-resort layer: the engine's built-in recover

Even **without** the recovery middleware, Celeris has a final safety net at the
engine level. If a panic escapes the entire chain (for example, the recovery
middleware was never installed, or a *pre-routing* middleware panicked outside
the route chain), the engine recovers it, logs it with a stack trace, and writes
a bare `500 Internal Server Error` (`text/plain`, `Cache-Control: no-store`).

This last-resort recover keeps the process alive but is intentionally minimal —
no JSON envelope, no customization, no `OnError`. For anything more than "don't
crash," install `recovery.New()` and (optionally) wire panic reporting (Sentry,
structured 500s, etc.) through its `ErrorHandlerErr`.

## Common pitfalls

- **Writing then returning an error.** Once you call `c.JSON`/`c.String`/etc.,
  the response is committed; a later returned error is logged but cannot change
  the output. Validate before you write.
- **Expecting `OnError` to run after a handler wrote a response.** It won't —
  `OnError` and the safety net both skip when `c.IsWritten()` is true.
- **Looking for `c.Error()` or `AbortWithError`.** Neither exists. Return the
  error; use `Abort` only for flow control.
- **Leaking internal error text.** A non-`HTTPError` always becomes a generic
  500 body. To send a specific message, wrap it in `NewHTTPError` — and remember
  the wrapped `Err` is never sent to the client.
- **Mutating a shared sentinel or a package-level `HTTPError`.** They are shared
  across all requests. Build a fresh `NewHTTPError` when a request needs its own
  message.
- **Registering `recovery` before `logger`/`metrics`.** Put `recovery` after
  them so observability middleware see the recovered 500.
- **Calling `OnError`, `NotFound`, or `MethodNotAllowed` after `Start`.**
  Configure them before the server begins serving.

## FAQ

**Do I need both `recovery.New()` and `OnError`?**
They do different jobs. `recovery` turns *panics* into errors (and can write its
own response); `OnError` shapes *returned errors* into your house format. A
common setup uses both: `recovery.New()` near the top of the chain, and
`OnError` for the JSON envelope. If `recovery`'s handler writes a response, that
request is already committed and `OnError` is skipped for it.

**How do I send a 4xx with a custom message and still log the cause?**
`return celeris.NewHTTPError(400, "invalid input").WithError(cause)`. The client
sees `invalid input`; your `OnError`/logs can read `cause` via `errors.As`/
`Unwrap`.

**What status does a plain `errors.New("...")` produce?**
500, with a generic `Internal Server Error` body. The text you passed is never
sent to the client. Use `HTTPError` to control the status and message.

**How do I treat a 401 the same regardless of which auth middleware produced
it?**
Match `errors.Is(err, celeris.ErrUnauthorized)`. The `jwt`, `keyauth`, and
`basicauth` packages all re-export the same value, so one check covers them all.

**Where do request IDs come from in my error logs?**
Add the [`requestid`](/docs/middleware) middleware and read `c.RequestID()` in
your `OnError` handler (the recovery middleware already includes it in its
panic logs).

## See also

- [Routing](/docs/routing) — handler signature, returning errors, named routes.
- [Middleware](/docs/middleware) — the chain, `c.Next()`, ordering, `recovery`,
  `logger`, `requestid`, and the observability stack.
- [Responses](/docs/responses) — the response methods (`JSON`, `String`,
  `Status`, `NoContent`) referenced throughout.
