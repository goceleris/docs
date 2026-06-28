---
title: Context API reference
description: A categorized index of every Context method for request reading, response writing, and connection control.
group: Reference
order: 3
---

This is the **lookup table** for `*celeris.Context` — every method grouped by what
it does, with its signature, a one-line behaviour note, and a link to the guide
that explains it with examples. If you are learning the API for the first time,
read the guides instead; come here when you already know what you want and just
need the exact signature or a refresher on an edge case.

Every method below lives on `*celeris.Context`, the single value your handler
receives:

```go
func handler(c *celeris.Context) error {
    id := c.Param("id")
    return c.JSON(200, map[string]string{"id": id})
}
```

Source files: request readers are in `celeris/context_request.go`, response
writers in `celeris/context_response.go`, flow control and the per-request store
(`Next`/`Abort`/`Set`/`Get`/`Context`) in `celeris/context.go`, the
`Cookie`/`Param`/`SameSite` types in `celeris/types.go`, and the error sentinels
in `celeris/errors.go`.

## Cross-cutting rules

These apply to almost everything below. Read them once; the tables assume them.

| Rule | What it means |
| ---- | ------------- |
| **Context is pooled** | The `*Context` is recycled across requests. Never retain it, and never retain a slice it returns (`Body()`, `RequestHeaders()`, `ResponseHeaders()`) past the handler return — copy first. See [Handling requests](/docs/request-handling). |
| **Header keys are lowercase** | `Header(key)` lowercases the key for you; response setters lowercase + strip CR/LF/NUL. Both `Header("Content-Type")` and `Header("content-type")` work, but stored keys are always lowercase (HTTP/2 mandates it). |
| **Write-once** | The first response method (`JSON`, `Blob`, `NoContent`, `Redirect`, `File*`, `StreamWriter`, …) wins. A second call returns `ErrResponseWritten`. `IsWritten()` reports whether the response has been sent. |
| **Status setter is separate** | `Status(code)` stores a code for the `Status*` helpers only. The regular writers (`JSON(code, v)`, `Blob(code, …)`) take their own code and ignore the stored one. |
| **Error sentinels** | Response/read methods return typed errors you can match with `errors.Is`. See [Error sentinels](#error-sentinels) at the bottom. |

---

## 1. Request line and params

The method, path, matched route, query string, and protocol — plus URL parameter
accessors. Guide: [Handling requests](/docs/request-handling) and
[Routing](/docs/routing).

| Signature | Behaviour |
| --------- | --------- |
| `Method() string` | HTTP method, e.g. `"GET"`. |
| `SetMethod(m string)` | Override the method (used by method-override middleware in `Server.Pre`). |
| `Path() string` | Request path without the query string. |
| `SetPath(p string)` | Override the path (URL-rewrite middleware). |
| `FullPath() string` | The matched **route pattern** (e.g. `/users/:id`), or `""` if no route matched. Use for low-cardinality metric labels. |
| `RawQuery() string` | Raw query string without the leading `?`; `""` if none. |
| `SetRawQuery(q string)` | Override the raw query; invalidates any cached parsed query. |
| `Protocol() string` | `"1.1"` for HTTP/1.1 or `"2"` for HTTP/2 (OTel `network.protocol.version` convention). |
| `Param(key) string` | URL path parameter, or `""` if absent. |
| `ParamDefault(key, def string) string` | Path param, or `def` if absent **or empty**. |
| `ParamInt(key) (int, error)` | Path param parsed as `int`; error if missing or not an integer. |
| `ParamInt64(key) (int64, error)` | Path param parsed as `int64`; error if missing or not an integer. |
| `Query(key) string` | First query value for `key`, or `""`. Zero-alloc for the common unescaped case. |
| `QueryDefault(key, def string) string` | Query value, or `def` if absent **or empty**. |
| `QueryInt(key string, def int) int` | Query value as `int`, or `def` if absent/invalid. |
| `QueryInt64(key string, def int64) int64` | Query value as `int64`, or `def` if absent/invalid. |
| `QueryBool(key string, def bool) bool` | Query value as bool. `true/1/yes` → true, `false/0/no` → false; else `def`. |
| `QueryValues(key) []string` | All values for `key`; `nil` if absent. |
| `QueryParams() url.Values` | All query parameters as `url.Values`; `nil` if no query string. |

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    id, err := c.ParamInt("id")
    if err != nil {
        return celeris.NewHTTPError(400, "id must be an integer")
    }
    page := c.QueryInt("page", 1)        // ?page=2 → 2; missing → 1
    return c.JSON(200, map[string]int{"id": id, "page": page})
})
```

> `Param*` reads route captures (`/users/:id`); `Query*` reads the `?key=value`
> string. `Path()` is the concrete request path, `FullPath()` is the pattern.

---

## 2. Headers, cookies, and body

Read request headers, the content length, request cookies, and the raw body.
Guide: [Handling requests](/docs/request-handling).

| Signature | Behaviour |
| --------- | --------- |
| `Header(key) string` | Request header value by name (key lowercased automatically); `""` if absent. Keys are stored lowercase. |
| `RequestHeaders() [][2]string` | All request headers as key/value pairs. **Do not retain** past the handler return — copy first (the slice and its strings may alias the pooled read buffer). |
| `ContentLength() int64` | Parsed `Content-Length`, or `-1` if absent or invalid. |
| `Cookie(name) (string, error)` | Request cookie value, or [`ErrNoCookie`](#error-sentinels) if not present. Value returned as-is (not decoded). |
| `Body() []byte` | Raw request body. **Must not be modified or retained** past the handler return. |
| `BodyCopy() []byte` | A fresh heap copy of the body, safe to retain; `nil` if empty. |
| `BodyReader() io.Reader` | An `io.Reader` over the already-received body bytes. |
| `AcceptsEncodings(offers ...string) string` | Best match from `Accept-Encoding`, or `""`. |
| `AcceptsLanguages(offers ...string) string` | Best match from `Accept-Language`, or `""`. |

```go
func logBody(c *celeris.Context) error {
    body := c.BodyCopy() // safe to keep after the handler returns
    go audit(body)
    return c.Next()
}
```

> Use `Body()` for synchronous work inside the handler; switch to `BodyCopy()` the
> moment the bytes outlive the request (async, logging, goroutines).

---

## 3. Binding and forms

Deserialize the body into a struct, or read URL-encoded / multipart form fields.
Guide: [Binding and validation](/docs/binding-and-validation).

| Signature | Behaviour |
| --------- | --------- |
| `Bind(v any) error` | Auto-detect JSON or XML from `Content-Type` and unmarshal into `v`. [`ErrEmptyBody`](#error-sentinels) if body empty. |
| `BindJSON(v any) error` | Unmarshal the JSON body into `v`. `ErrEmptyBody` if empty. |
| `BindXML(v any) error` | Unmarshal the XML body into `v`. `ErrEmptyBody` if empty. |
| `FormValue(name) string` | First value for a form field (parses url-encoded or multipart on first call); `""` on error/absent. |
| `FormValueOK(name) (string, bool)` | First value plus presence flag — distinguishes a missing field from an empty value. |
| `FormValues(name) []string` | All values for a form field; `nil` on error/absent. |
| `FormFile(name) (multipart.File, *multipart.FileHeader, error)` | First uploaded file for a field. `HTTPError` 400 if not multipart or field missing. |
| `MultipartForm() (*multipart.Form, error)` | The full parsed multipart form (values + files). `HTTPError` 400 if not multipart. |

```go
type CreateUser struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

func create(c *celeris.Context) error {
    var in CreateUser
    if err := c.Bind(&in); err != nil {
        if errors.Is(err, celeris.ErrEmptyBody) {
            return celeris.NewHTTPError(400, "request body required")
        }
        return celeris.NewHTTPError(400, "invalid body")
    }
    return c.JSON(201, in)
}
```

> `FormValueOk` exists as a **deprecated** alias for `FormValueOK` — prefer the
> capitalized form.

---

## 4. Identity and connection metadata

Who is calling, over what scheme, and on what connection. Guide:
[Handling requests](/docs/request-handling).

| Signature | Behaviour |
| --------- | --------- |
| `ClientIP() string` | Client IP. Walks `X-Forwarded-For` against `Config.TrustedProxies` (right-to-left) when configured; else leftmost XFF, then `X-Real-Ip`, then `""`. |
| `SetClientIP(ip string)` | Override the value `ClientIP` returns (proxy middleware). |
| `RemoteAddr() string` | TCP peer address (`host:port`), e.g. `192.168.1.1:54321`; `""` if unavailable. |
| `Scheme() string` | `"http"` or `"https"` (override → `:scheme` pseudo-header → `"http"`). |
| `SetScheme(scheme string)` | Override the scheme (proxy middleware applying `X-Forwarded-Proto`). |
| `IsTLS() bool` | True when `Scheme() == "https"`. |
| `Host() string` | Request host from `:authority` (HTTP/2) or `Host` (HTTP/1.1), or override. |
| `SetHost(host string)` | Override the host (normalisation middleware). |
| `IsWebSocket() bool` | True if the request is a WebSocket upgrade (`Upgrade: websocket`). |
| `BasicAuth() (user, pass string, ok bool)` | Decode HTTP Basic credentials from `Authorization`; `ok=false` if absent or malformed. |

```go
func ipAllowlist(c *celeris.Context) error {
    if !allowed(c.ClientIP()) {
        return c.AbortWithStatus(403)
    }
    return c.Next()
}
```

> `ClientIP()` is only trustworthy behind a proxy when you set
> `Config.TrustedProxies` (or use the proxy middleware), otherwise the leftmost
> `X-Forwarded-For` entry is attacker-controllable. See
> [Security middleware](/docs/middleware-security).

---

## 5. Writing the response

Status, serializers, raw blobs, headers, cookies, redirects, and file serving.
Every writer is **write-once** and returns [`ErrResponseWritten`](#error-sentinels)
on a second call (and [`ErrDetached`](#error-sentinels) after `Detach`). Guide:
[Sending responses](/docs/responses).

### Status

| Signature | Behaviour |
| --------- | --------- |
| `Status(code int) *Context` | Store a status code for the `Status*` helpers; returns `c` for chaining. |
| `StatusCode() int` | The status code set on the response so far. |
| `StatusJSON(v any) error` | `JSON(storedCode, v)`. |
| `StatusXML(v any) error` | `XML(storedCode, v)`. |
| `StatusString(s string) error` | Plain-text body with the stored code. |
| `StatusBlob(contentType string, data []byte) error` | `Blob(storedCode, contentType, data)`. |

### Body serializers

| Signature | Behaviour |
| --------- | --------- |
| `JSON(code int, v any) error` | Serialize `v` as JSON (`application/json`). |
| `XML(code int, v any) error` | Serialize `v` as XML (`application/xml`). |
| `HTML(code int, html string) error` | Write `html` with `text/html; charset=utf-8`. |
| `String(code int, format string, args ...any) error` | `fmt.Sprintf`-style plain-text body (formats only when `args` given). |
| `Blob(code int, contentType string, data []byte) error` | Write raw bytes with an explicit content type. The primitive all the others build on. |
| `NoContent(code int) error` | Status line + headers, no body. |
| `Respond(code int, v any) error` | Content-negotiated write: JSON / XML / text by `Accept`, falling back to JSON. |
| `Negotiate(offers ...string) string` | Best content type for the request `Accept` header (supports `q=`); first offer if no `Accept`. |
| `Redirect(code int, url string) error` | Send a redirect. [`ErrInvalidRedirectCode`](#error-sentinels) if `code` ∉ 300–308. |

```go
func get(c *celeris.Context) error {
    u, ok := lookup(c.Param("id"))
    if !ok {
        return c.NoContent(404)
    }
    return c.Status(200).StatusJSON(u) // or simply c.JSON(200, u)
}
```

### Response headers and cookies

| Signature | Behaviour |
| --------- | --------- |
| `SetHeader(key, value string)` | Set a response header, replacing any existing value. Key lowercased; CR/LF/NUL stripped. |
| `AddHeader(key, value string)` | Append a header value without replacing (e.g. multiple `set-cookie`). Sanitized like `SetHeader`. |
| `ResponseHeaders() [][2]string` | Headers set so far. **Do not modify** the returned slice. |
| `SetResponseHeaders(headers [][2]string)` | Replace all response headers (copied in). Used by caching middleware. |
| `SetCookie(cookie *Cookie)` | Append a `Set-Cookie` header from a [`Cookie`](#the-cookie-type). Values sent as-is per RFC 6265. |
| `DeleteCookie(name, path string)` | Append a `Set-Cookie` that expires the named cookie (path must match the original). |

### Serving files

| Signature | Behaviour |
| --------- | --------- |
| `File(filePath string) error` | Serve a file by path; content type from extension; supports `Range` (206). `HTTPError` 413 if over 100 MB. **Sanitize untrusted paths yourself.** |
| `FileFromDir(baseDir, userPath string) error` | Serve a file safely from within `baseDir` — cleans/joins and rejects traversal (incl. symlink escape) with `HTTPError` 400. |
| `FileFromFS(name string, fsys fs.FS) error` | Serve a file from an `fs.FS` (e.g. `embed.FS`). `HTTPError` 413 if over 100 MB. Sanitize untrusted `name`. |
| `Attachment(filename string)` | Set `Content-Disposition: attachment` (prompts a download). |
| `Inline(filename string)` | Set `Content-Disposition: inline` (suggests in-browser display). |

```go
//go:embed assets/*
var assets embed.FS

s.GET("/logo.png", func(c *celeris.Context) error {
    c.Inline("logo.png")
    return c.FileFromFS("assets/logo.png", assets)
})
```

> For untrusted, user-supplied paths use `FileFromDir` — `File` and `FileFromFS`
> open the path directly and are vulnerable to traversal if you pass raw input.
> See [Static files](/docs/static-files).

### Buffering and capturing (for middleware)

These let middleware inspect or rewrite a downstream response. Guide:
[Sending responses](/docs/responses) and [Middleware](/docs/middleware).

| Signature | Behaviour |
| --------- | --------- |
| `CaptureResponse()` | Write the response to the wire **and** keep a copy for inspection (ideal for loggers). |
| `BufferResponse()` | Defer the wire write entirely; depth-tracked across nested middleware. |
| `FlushResponse() error` | Send the buffered response; the write happens when depth reaches zero. Safe no-op if nothing buffered. |
| `DiscardBufferedResponse()` | Drop a buffered response without writing (e.g. timeout middleware replacing it). |
| `SetResponseBody(body []byte)` | Replace the buffered body (transform middleware: compress, etc.). |
| `ResponseBody() []byte` | The captured/buffered body, or `nil` if capture wasn't enabled. |
| `ResponseContentType() string` | The captured content type, or `""`. |
| `ResponseStatus() int` | The captured status code. |
| `IsWritten() bool` | True once a response has been written to the wire. |
| `BytesWritten() int` | Response body size in bytes (live total while streaming). |

---

## 6. Streaming and connection control

Incremental writes, taking over the connection, and WebSocket upgrade plumbing.
Guides: [Streaming responses](/docs/streaming) and
[Server-Sent Events](/docs/sse).

| Signature | Behaviour |
| --------- | --------- |
| `StreamWriter() *StreamWriter` | Incremental response writer. `nil` if the engine can't stream or buffering is active. Marks the response written. |
| `Stream(code int, contentType string, r io.Reader) error` | **Buffers** all of `r` (≤ 100 MB) then writes it. Not incremental — use `StreamWriter` for true streaming. `HTTPError` 413 if over the cap. |
| `StreamReader(code int, contentType string, r io.Reader) error` | Preferred alias for `Stream`; the name makes the buffering behaviour obvious. |
| `Detach() (done func())` | Remove the Context from the chain lifecycle so a goroutine can keep writing after the handler returns. **You must call `done()`** or the Context leaks from the pool. |
| `EngineSupportsAsyncDetach() bool` | True when the engine can keep the connection alive after the handler returns (native engines); false on the std engine. |
| `Hijack() (net.Conn, error)` | Take over the TCP connection (HTTP/1.1 only). [`ErrHijackNotSupported`](#error-sentinels) on HTTP/2. You then own and must close the conn. |
| `BytesWritten() int` | Total bytes written (also tracks `StreamWriter` output live). |

The `*StreamWriter` returned by `StreamWriter()` has its own methods:

| Signature | Behaviour |
| --------- | --------- |
| `WriteHeader(status int, headers [][2]string) error` | Send status + headers once, before any `Write`. |
| `Write(data []byte) (int, error)` | Send a body chunk; may be called repeatedly. |
| `Flush() error` | Push buffered data to the network. |
| `Close() error` | End the body and sync the byte count back to the Context. |
| `BytesWritten() int64` | Total bytes written through this writer (concurrency-safe). |

```go
func sse(c *celeris.Context) error {
    sw := c.StreamWriter()
    if sw == nil {
        return celeris.NewHTTPError(500, "streaming unsupported")
    }
    _ = sw.WriteHeader(200, [][2]string{{"content-type", "text/event-stream"}})

    if c.EngineSupportsAsyncDetach() {
        done := c.Detach()
        go func() {
            defer done() // REQUIRED — or the Context leaks
            defer sw.Close()
            for ev := range events() {
                _, _ = sw.Write(ev)
                _ = sw.Flush()
            }
        }()
        return nil
    }
    // std engine: drive the stream inline until done.
    defer sw.Close()
    for ev := range events() {
        if _, err := sw.Write(ev); err != nil {
            return err
        }
        _ = sw.Flush()
    }
    return nil
}
```

### WebSocket upgrade family

Low-level hooks for engine-integrated WebSocket support. Most applications use the
WebSocket middleware rather than these directly; install all `SetWS*` callbacks
**before** `Detach`.

| Signature | Behaviour |
| --------- | --------- |
| `UpgradeWebSocket(delivery func(data []byte)) bool` | Install the inbound-data callback; `false` if the engine has no integrated WS (fall back to `Hijack`). |
| `WSRawWriteFn() func([]byte)` | Raw frame-write fn (bypasses chunking); `nil` before `Detach` or on std. Call **after** `Detach`. |
| `WSReadPauser() (pause, resume func())` | Engine TCP backpressure callbacks; `(nil, nil)` if unsupported. Call **after** `Detach`. |
| `SetWSErrorHandler(fn func(error))` | Surface engine-side I/O errors to the next user Read/Write. |
| `SetWSDetachClose(fn func())` | Called when the engine closes the detached connection (timeout/error/shutdown). |
| `SetWSIdleDeadline(ns int64)` | Absolute idle deadline (Unix ns) for the detached connection; `0` clears. |

---

## 7. Flow control

Drive (or stop) the middleware chain. Guide: [Middleware](/docs/middleware).

| Signature | Behaviour |
| --------- | --------- |
| `Next() error` | Run the remaining handlers; returns the first non-nil downstream error (short-circuits). |
| `Abort()` | Stop pending handlers. Writes **no** response. |
| `AbortWithStatus(code int) error` | `Abort()` then `NoContent(code)`; returns the `NoContent` error. |
| `IsAborted() bool` | True if the chain was aborted. |

```go
func requireAuth(c *celeris.Context) error {
    if !authenticated(c) {
        return c.AbortWithStatus(401) // stops the chain, sends 401
    }
    return c.Next() // run the rest of the chain
}
```

> A middleware that calls `Next()` wraps the downstream handlers; one that just
> returns (without `Next()`) lets the engine advance the chain for it. Don't call
> `Next()` twice in one middleware. See [Middleware](/docs/middleware).

---

## 8. Per-request store

A scratch map for passing values from middleware to downstream handlers within a
single request. The store is cleared when the Context returns to the pool.

| Signature | Behaviour |
| --------- | --------- |
| `Set(key string, value any)` | Store an arbitrary value under `key`. |
| `Get(key string) (any, bool)` | Retrieve a stored value; `ok=false` if absent. Also reads string storage and the request ID. |
| `Keys() map[string]any` | A fresh copy of all stored pairs (including string keys and request ID); `nil` if nothing set. |
| `SetString(key, value string)` | Store a string without the `any`-boxing allocation of `Set`. |
| `GetString(key string) (string, bool)` | Read a string set by `SetString` (falls back to `Set`/request ID); `("", false)` if absent. |

```go
func tagTenant(c *celeris.Context) error {
    c.SetString("tenant", lookupTenant(c.Host()))
    return c.Next()
}

func handler(c *celeris.Context) error {
    tenant, _ := c.GetString("tenant")
    return c.JSON(200, map[string]string{"tenant": tenant})
}
```

> Prefer `SetString`/`GetString` for string values — they avoid the per-call
> interface boxing that `Set`/`Get` incur.

---

## 9. Request lifecycle and metadata

The standard library request context, the request ID, timing, and a release hook.
Guide: [Observability](/docs/observability).

| Signature | Behaviour |
| --------- | --------- |
| `Context() context.Context` | The request's `context.Context` (deadlines; cancelled by an HTTP/2 stream reset, **not** by an HTTP/1.1 client disconnect). Always non-nil. |
| `SetContext(ctx context.Context)` | Replace the request context (must be non-nil); used to attach values or deadlines. |
| `RequestID() string` | The canonical request ID set by request-ID middleware; `""` if none. Zero-alloc. |
| `SetRequestID(id string)` | Set the canonical request ID (used by request-ID middleware). |
| `WorkerID() int` | Event-loop worker handling the request, or `-1` on the std engine / synthetic contexts. |
| `StartTime() time.Time` | When request processing began (shared across the chain; avoids per-middleware `time.Now()`). |
| `OnRelease(fn func())` | Register a cleanup callback fired (LIFO) when the Context returns to the pool. Panics are recovered. |

```go
func handler(c *celeris.Context) error {
    select {
    case <-c.Context().Done(): // deadline hit, or HTTP/2 stream reset
        return c.Context().Err()
    case res := <-doWork(c):
        return c.JSON(200, res)
    }
}
```

> `c.Context()` carries deadlines you attach (via `SetContext`) and is cancelled by
> an **HTTP/2 stream reset** — but it does **not** fire on a plain HTTP/1.1 client
> disconnect: `Done()` never closes when an H1 peer goes away. To detect a
> disconnected client while streaming, check the error returned by
> `StreamWriter.Write`/`Flush` rather than relying on `ctx.Done()`. Use `Context()`
> for deadlines and H2 cancellation; use the stream-writer error for H1 disconnect
> detection. `OnRelease` is for releasing per-request resources (close a
> checked-out connection, decrement a gauge) without a `defer` in every handler.

---

## The `Cookie` type

`SetCookie` takes a `*celeris.Cookie` (`celeris/types.go:48-71`):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `Name` | `string` | Cookie name. Semicolons stripped. |
| `Value` | `string` | Cookie value (sent as-is; encode yourself if needed). Semicolons stripped. |
| `Path` | `string` | Scope path. |
| `Domain` | `string` | Scope domain. |
| `MaxAge` | `int` | `0` omits the attribute; negative deletes (`Max-Age=0`). |
| `Expires` | `time.Time` | Legacy `Expires` attribute; zero omits it. Prefer `MaxAge`. |
| `Secure` | `bool` | HTTPS-only. |
| `HTTPOnly` | `bool` | Hidden from client-side scripts. |
| `SameSite` | `SameSite` | One of `SameSiteDefaultMode`, `SameSiteLaxMode`, `SameSiteStrictMode`, `SameSiteNoneMode`. |

```go
c.SetCookie(&celeris.Cookie{
    Name:     "session",
    Value:    token,
    Path:     "/",
    MaxAge:   3600,
    Secure:   true,
    HTTPOnly: true,
    SameSite: celeris.SameSiteLaxMode,
})
```

---

## Error sentinels

Match these with `errors.Is` (`celeris/errors.go`):

| Sentinel | Returned by | Meaning |
| -------- | ----------- | ------- |
| `ErrEmptyBody` | `Bind`, `BindJSON`, `BindXML` | The request body is empty. |
| `ErrNoCookie` | `Cookie` | The named cookie is not present. |
| `ErrResponseWritten` | `JSON`/`XML`/`HTML`/`String`/`Blob`/`NoContent`/`Redirect`/`Status*`/`FlushResponse` | A response was already written (write-once). |
| `ErrDetached` | `Blob`/`JSON`/`XML`/`HTML`/`String`/`File*`/`Stream` | The Context was detached — use `StreamWriter` or the middleware's write API. |
| `ErrInvalidRedirectCode` | `Redirect` | Status code outside 300–308. |
| `ErrHijackNotSupported` | `Hijack` | The connection can't be taken over (e.g. HTTP/2). |

```go
if err := c.JSON(200, payload); err != nil {
    if errors.Is(err, celeris.ErrResponseWritten) {
        // an earlier handler already replied — nothing to do
        return nil
    }
    return err
}
```

`HTTPError` (returned by `FormFile`, `File*`, `Stream`, etc.) is a struct, not a
sentinel — build one with `celeris.NewHTTPError(code, message)` and match it with
`errors.As`. See [Error handling](/docs/error-handling).

## Common pitfalls

- **Retaining pooled slices.** `Body()`, `RequestHeaders()`, and
  `ResponseHeaders()` return views into recycled buffers. Copy (`BodyCopy()`, or a
  manual copy) before using them after the handler returns. Never stash the
  `*Context` itself.
- **`Status(code)` does not write anything.** It only feeds the `Status*` helpers.
  `c.Status(404)` alone sends nothing; you still need `c.StatusJSON(v)` /
  `c.NoContent(404)` / a regular writer.
- **Double writes.** The second response writer returns `ErrResponseWritten`. If
  you might write from both middleware and handler, gate on `IsWritten()`.
- **Forgetting `done()` after `Detach`.** The Context leaks from the pool forever.
  Always `defer done()` in the spawned goroutine.
- **`Stream` is not streaming.** It buffers the whole reader (≤ 100 MB). For
  incremental output use `StreamWriter`. See [Streaming responses](/docs/streaming).
- **`Detach` then a normal writer.** After `Detach`, `JSON`/`Blob`/etc. return
  `ErrDetached`. Write through `StreamWriter` or the WebSocket/SSE write fns.

## FAQ

**`Param` vs `Query` vs `FormValue`?**
`Param` reads route captures (`/users/:id`), `Query` reads the URL query string
(`?page=2`), `FormValue` reads a parsed request body (url-encoded or multipart).

**Why are my header keys lowercase?**
HTTP/2 mandates lowercase header names, so Celeris normalises everywhere. `Header`
lowercases the key you pass, and the response setters lowercase what they store —
read and write with any casing, but expect lowercase back.

**Which response method should I default to?**
`JSON(code, v)` for APIs, `String`/`HTML` for text, `Blob` when you control the
content type and bytes, `Respond` when the client's `Accept` header should decide.

**How do I keep the body after the handler returns?**
`BodyCopy()` (not `Body()`), and never keep the `*Context`. See
[Handling requests](/docs/request-handling).

## See also

- [Handling requests](/docs/request-handling) — reading method, path, headers,
  body, and identity with examples.
- [Sending responses](/docs/responses) — serializers, headers, cookies, and the
  buffer/capture model.
- [Binding and validation](/docs/binding-and-validation) — `Bind*` and form
  parsing in depth.
- [Streaming responses](/docs/streaming) and [Server-Sent Events](/docs/sse) —
  `StreamWriter`, `Detach`, and long-lived connections.
- [Routing](/docs/routing) — path patterns and the `Param*` accessors.
- [Error handling](/docs/error-handling) — `HTTPError` and the error safety net.
