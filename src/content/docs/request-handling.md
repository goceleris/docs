---
title: Handling requests
description: Read the method, path, query, headers, cookies, body, forms, and file uploads from the Context.
group: Routing & Handlers
order: 2
---

Every handler receives a `*celeris.Context`. It is your single entry point for
reading the incoming request — the method and path, query string, headers,
cookies, the body, and `multipart` form uploads. This page covers each accessor,
its exact semantics, and the pitfalls worth knowing before they bite you in
production.

For turning the body into a typed struct, see binding (`Bind`, `BindJSON`,
`BindXML`) — that is covered in [Binding and validation](/docs/binding-and-validation).
For the size limits referenced throughout, see [Configuration](/docs/configuration).

## The Context lifetime rule

The `Context` is pooled and reused across requests. **Anything that hands back a
view into request memory is only valid until your handler returns.** Once the
handler returns, the underlying buffers may be recycled for the next request.

This affects exactly two accessors:

| Accessor | Returns | After handler returns |
| --- | --- | --- |
| `Body()` | The raw body bytes (zero-copy) | Invalid — may be overwritten |
| `Header(key)` | A header value (substring of the parsed buffer) | Invalid — may be overwritten |

If you need request data to outlive the handler — async processing, a background
goroutine, deferred logging — copy it first. Two accessors are explicitly
documented as safe to retain:

| Safe-to-retain accessor | Returns |
| --- | --- |
| `BodyCopy()` | A fresh heap copy of the body (`[]byte`) |
| `RequestHeaders()` | A copy of all headers as `[][2]string`, safe for concurrent use |

```go
s.POST("/ingest", func(c *celeris.Context) error {
    // WRONG: body is recycled after this handler returns
    go process(c.Body())

    // RIGHT: hand the goroutine its own copy
    payload := c.BodyCopy()
    go process(payload)

    return c.String(202, "queued")
})
```

A plain `string(c.Body())` or `c.Header("...")` value you use *within* the
handler is fine — Go copies the bytes into the new string. The rule only bites
when you keep a `[]byte` slice or pass the `Context` itself somewhere that
outlives the request.

## The request line

| Method | Returns |
| --- | --- |
| `c.Method()` | HTTP method, e.g. `"GET"` |
| `c.Path()` | Request path without the query string, e.g. `"/users/42"` |
| `c.FullPath()` | The matched route *pattern*, e.g. `"/users/:id"` (empty if no route matched) |
| `c.RawQuery()` | Raw query string without the leading `?` (empty if none) |
| `c.Protocol()` | `"1.1"` for HTTP/1.1, `"2"` for HTTP/2 |
| `c.Host()` | Request host (`:authority` on H2, `Host` header on H1) |
| `c.RemoteAddr()` | TCP peer address, e.g. `"192.168.1.1:54321"` |

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    log.Printf("%s %s matched %s over HTTP/%s",
        c.Method(), c.Path(), c.FullPath(), c.Protocol())
    return c.JSON(200, map[string]string{"id": c.Param("id")})
})
```

`Path()` is the concrete URL the client sent; `FullPath()` is the template you
registered. The latter is ideal for low-cardinality metrics labels (you don't
want a separate metric series per user ID).

> **`SetMethod` / `SetPath` / `SetRawQuery` are for middleware, not handlers.**
> Celeris exposes setters that rewrite the request line — they exist for
> pre-routing middleware that does method override or URL rewriting (registered
> with `s.Pre(...)`; see [Routing](/docs/routing)). Calling them from an
> ordinary handler has no effect on routing, which has already happened. Route
> parameters are read with `c.Param(...)`, covered in [Routing](/docs/routing).

## Query parameters

`RawQuery()` gives you the unparsed string. For individual values, use the typed
accessors — the common case (a single unescaped value) is read directly from the
raw query with zero allocations.

| Method | Behavior |
| --- | --- |
| `c.Query(key)` | First value for `key`, or `""` if absent |
| `c.QueryDefault(key, def)` | `Query(key)`, or `def` if the value is empty/absent |
| `c.QueryInt(key, def)` | Parsed as `int`; returns `def` if absent **or unparseable** |
| `c.QueryInt64(key, def)` | Parsed as `int64`; returns `def` if absent **or unparseable** |
| `c.QueryBool(key, def)` | Parsed as `bool`; returns `def` if absent **or unparseable** |
| `c.QueryValues(key)` | All values for `key` as `[]string` (`nil` if absent) |
| `c.QueryParams()` | The full `url.Values` map (`nil` if no query string) |

```go
// /search?q=celeris&page=2&limit=20&exact=true
s.GET("/search", func(c *celeris.Context) error {
    q := c.Query("q")                  // "celeris"
    page := c.QueryInt("page", 1)      // 2
    limit := c.QueryInt("limit", 50)   // 20
    exact := c.QueryBool("exact", false) // true
    return c.JSON(200, doSearch(q, page, limit, exact))
})
```

`QueryBool` recognizes `true`/`1`/`yes` as true and `false`/`0`/`no` as false
(case-insensitive); anything else falls back to the default.

### Empty string means "use the default"

`QueryDefault`, `QueryInt`, `QueryInt64`, and `QueryBool` treat an **empty
value** the same as a **missing key**. A request to `?page=` (key present, value
empty) returns the default, just as `?` (key absent) would.

### Detecting malformed values

The typed helpers deliberately **swallow parse errors** — `?page=abc` returns
your default, not an error. This is the right behavior for forgiving public APIs,
but if a malformed value should be a `400` rather than silently defaulted, parse
the raw string yourself:

```go
s.GET("/items", func(c *celeris.Context) error {
    raw := c.Query("page")
    if raw == "" {
        raw = "1"
    }
    page, err := strconv.Atoi(raw)
    if err != nil || page < 1 {
        return celeris.NewHTTPError(400, "page must be a positive integer")
    }
    return c.JSON(200, listItems(page))
})
```

For repeated keys such as `?tag=go&tag=http`, use `QueryValues("tag")`
(`["go", "http"]`). Reaching for `QueryValues` or `QueryParams` triggers a full
parse of the query string and caches it, so subsequent `Query` calls hit the
cached map.

## Headers

| Method | Behavior |
| --- | --- |
| `c.Header(key)` | First value for `key`; **key is lowercased**, value not safe to retain |
| `c.RequestHeaders()` | A copy of all headers as `[][2]string`; safe to retain |
| `c.ContentLength()` | `Content-Length` as `int64`, or `-1` if absent or invalid |

```go
s.POST("/upload", func(c *celeris.Context) error {
    ct := c.Header("Content-Type")       // key case doesn't matter
    if c.ContentLength() > 10<<20 {
        return celeris.NewHTTPError(413, "payload too large")
    }
    return handleUpload(c, ct)
})
```

Header lookups are case-insensitive — keys are normalized to lowercase
automatically (HTTP/2 mandates lowercase wire format, and the HTTP/1 parser
lowercases as it reads). You can pass `"Content-Type"` or `"content-type"`
interchangeably.

`Header` returns only the **first** value for a given key. To inspect every
header — including duplicates — iterate `RequestHeaders()`:

```go
for _, h := range c.RequestHeaders() {
    log.Printf("%s: %s", h[0], h[1])
}
```

### Pseudo-headers

On HTTP/2, the request line is delivered as pseudo-headers. You can read them
through `Header`, though the dedicated accessors are usually clearer:

| Pseudo-header | Dedicated accessor |
| --- | --- |
| `c.Header(":scheme")` | `c.Scheme()` — also honors trusted-proxy overrides |
| `c.Header(":authority")` | `c.Host()` — falls back to the `Host` header on H1 |

`c.Scheme()` returns `"http"` when no value is available, and `c.IsTLS()` is
shorthand for `c.Scheme() == "https"`.

## Cookies (reading)

```go
sid, err := c.Cookie("session")
if err == celeris.ErrNoCookie {
    return celeris.NewHTTPError(401, "no session")
}
```

`c.Cookie(name)` returns the cookie value, or `celeris.ErrNoCookie` (defined in
the `celeris` package) if no cookie with that name is present.

Two things to know:

- **Values are returned as-is, not URL-decoded.** If you set cookie values with
  percent-encoding, decode them yourself with `url.QueryUnescape` after reading.
- **There is no "all cookies" accessor.** Read cookies by name. If you need to
  enumerate them, read the raw `Cookie` request header via
  `c.Header("cookie")` and parse it yourself.

Setting cookies on the response is a separate API — see
[Sending responses](/docs/responses).

## Reading the body

The request body is **fully buffered before your handler runs**, so reading it
is a synchronous, in-memory operation — there is no streaming read to drain and
no I/O error to handle at read time. The maximum buffered size is governed by
`Config.MaxRequestBodySize` (default 100 MB; see
[Configuration](/docs/configuration)); requests exceeding it are rejected before
they reach your handler.

| Method | Returns | Retain after handler? |
| --- | --- | --- |
| `c.Body()` | Raw body `[]byte`, zero-copy | **No** |
| `c.BodyCopy()` | A heap copy of the body (`nil` if empty) | Yes |
| `c.BodyReader()` | An `io.Reader` over the body bytes | The reader wraps `Body()` — drain it within the handler |

```go
s.POST("/raw", func(c *celeris.Context) error {
    body := c.Body()                 // zero-copy view, valid this handler only
    log.Printf("received %d bytes", len(body))
    return c.String(200, "ok")
})
```

Use `BodyReader()` when an API wants an `io.Reader` — for example streaming the
body into a decoder:

```go
s.POST("/stream-decode", func(c *celeris.Context) error {
    var v map[string]any
    if err := json.NewDecoder(c.BodyReader()).Decode(&v); err != nil {
        return celeris.NewHTTPError(400, "invalid JSON")
    }
    return c.JSON(200, v)
})
```

For decoding the body straight into a struct, prefer `Bind`, `BindJSON`, or
`BindXML` over manual `BodyReader` plumbing — see
[Binding and validation](/docs/binding-and-validation).

## Forms and file uploads

The form accessors handle both `application/x-www-form-urlencoded` and
`multipart/form-data` bodies. The body is parsed lazily on the first form call
and cached, so calling several form accessors costs one parse.

| Method | Behavior |
| --- | --- |
| `c.FormValue(name)` | First value for the field, or `""` (absent **or** parse failed) |
| `c.FormValueOK(name)` | `(value, ok)` — distinguishes a present-but-empty field from a missing one |
| `c.FormValues(name)` | All values for the field as `[]string` (`nil` if absent) |
| `c.FormFile(name)` | First uploaded file for the field (multipart only) |
| `c.MultipartForm()` | The full parsed `*multipart.Form`, including all files |

### Reading form fields

```go
s.POST("/login", func(c *celeris.Context) error {
    user := c.FormValue("username")
    pass := c.FormValue("password")
    if user == "" || pass == "" {
        return celeris.NewHTTPError(400, "missing credentials")
    }
    return doLogin(c, user, pass)
})
```

When you must tell an empty field apart from an absent one, use `FormValueOK`:

```go
if v, ok := c.FormValueOK("newsletter"); ok {
    // field was submitted (possibly with an empty value)
    subscribe(v)
}
```

### Handling file uploads

`FormFile` returns the file, its `*multipart.FileHeader` (with `Filename`,
`Size`, and `Header`), and an error. **You own the returned file and must close
it.** If the request is not `multipart/form-data`, or the field is missing,
`FormFile` returns an `HTTPError` with status `400`.

```go
s.POST("/avatar", func(c *celeris.Context) error {
    file, header, err := c.FormFile("avatar")
    if err != nil {
        return err // already a 400 HTTPError when not multipart / field missing
    }
    defer file.Close() // always close

    dst, err := os.Create("/uploads/" + filepath.Base(header.Filename))
    if err != nil {
        return celeris.NewHTTPError(500, "could not save file")
    }
    defer dst.Close()

    if _, err := io.Copy(dst, file); err != nil {
        return celeris.NewHTTPError(500, "write failed")
    }
    return c.JSON(200, map[string]any{
        "name": header.Filename,
        "size": header.Size,
    })
})
```

For multiple files under one field, or to read fields and files together, use
`MultipartForm`:

```go
s.POST("/gallery", func(c *celeris.Context) error {
    form, err := c.MultipartForm()
    if err != nil {
        return err // 400 if not multipart
    }
    titles := form.Value["title"]   // []string of text fields
    for _, fh := range form.File["photos"] {
        f, err := fh.Open()
        if err != nil {
            return celeris.NewHTTPError(400, "could not open upload")
        }
        save(fh.Filename, f)
        f.Close()
    }
    return c.JSON(200, map[string]int{"count": len(form.File["photos"])})
})
```

### Form size limit

Multipart parsing is capped by `Config.MaxFormSize` (default `32 MB`, the value
of `celeris.DefaultMaxFormSize`). Set it to `-1` to disable the in-memory limit.
This is the memory budget for multipart parsing specifically; the overall body
ceiling is `MaxRequestBodySize`. Both are described in
[Configuration](/docs/configuration).

## Common pitfalls

- **Retaining `Body()` or a `Header()` value past the handler.** These point
  into recycled buffers. Use `BodyCopy()` / `RequestHeaders()` if the data must
  outlive the request, and never stash the `*Context` itself.
- **Trusting `QueryInt` to validate.** It returns your default on garbage input
  rather than an error. Parse the raw `Query` value yourself when malformed input
  should be a `400`.
- **Confusing missing with empty.** `FormValue("x")` and `Query("x")` both
  return `""` whether the field is absent or genuinely empty (and `FormValue`
  also returns `""` if parsing failed). Use `FormValueOK` / `QueryValues` when
  the distinction matters.
- **Forgetting to close uploaded files.** `FormFile` hands you an open
  `multipart.File`; always `defer file.Close()`.
- **Expecting URL-decoded cookies.** `Cookie` returns the raw value. Decode it
  yourself if you encoded it.
- **Calling `FormFile` on a non-multipart request.** It returns a `400`
  `HTTPError`, not a `nil` file — handle the error.

## FAQ

**Is the body available before the handler runs, or do I have to drain a stream?**
It is fully buffered before your handler is invoked. `Body()` returns the
complete bytes immediately; there is no read step that can fail.

**What happens when a request exceeds `MaxRequestBodySize`?**
It is rejected before reaching your handler — your code never sees an oversized
body. Tune the limit in [Configuration](/docs/configuration).

**Why does `QueryInt("page", 1)` return `1` for `?page=abc`?**
The typed query helpers swallow parse errors and return your default. If
malformed input should be an error, read `Query("page")` and parse it yourself.

**How do I read all values of a repeated query key or form field?**
Use `QueryValues(key)` for the query string and `FormValues(name)` for form
bodies; both return `[]string`.

**How do I get every header, including duplicates?**
Iterate `RequestHeaders()` — `Header(key)` only returns the first value.

**How do I turn the body into a struct?**
Use `Bind`, `BindJSON`, or `BindXML`. See
[Binding and validation](/docs/binding-and-validation).
