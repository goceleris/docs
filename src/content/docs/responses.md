---
title: Sending responses
description: Write JSON, XML, HTML, text, blobs, redirects, files, and negotiate content types.
group: Routing & Handlers
order: 4
---

Every handler has the signature `func(c *celeris.Context) error`. Inside it you
build the response by calling one of the `Context` write methods. This page
covers the body writers (JSON, XML, HTML, text, blobs), status codes, response
headers, cookies, redirects, and content negotiation.

File serving and incremental streaming have their own pages — see
[Static files](/docs/static-files) and [Streaming, SSE & WebSocket](/docs/streaming).

## The write-once model

A response is written exactly once. The first body method you call
(`JSON`, `XML`, `HTML`, `String`, `Blob`, `NoContent`, …) flushes the status
line, headers, and body to the wire and marks the `Context` as written. Any
**second** write returns `ErrResponseWritten`:

```go
s.GET("/once", func(c *celeris.Context) error {
    if err := c.JSON(200, map[string]string{"ok": "yes"}); err != nil {
        return err
    }
    // Already on the wire — this returns celeris.ErrResponseWritten.
    return c.String(500, "too late")
})
```

You can check whether anything has been written with `IsWritten()` before
attempting a write — handy in middleware that conditionally produces a fallback
response:

```go
if !c.IsWritten() {
    return c.NoContent(204)
}
return nil
```

A few rules to keep in mind:

- **Default status is 200.** If you never set a status, body writers that take a
  `code` argument use whatever you pass; `Status*` helpers use the value from
  `Status` (see below).
- **Detached contexts reject standard writes.** If the connection has been
  detached (e.g. by WebSocket or SSE middleware), the body-*writing* methods
  (`JSON`, `String`, `HTML`, `Blob`, …) return `ErrDetached`. (`NoContent`, which
  sends no body, is exempt.) Use the streaming write API instead — see
  [Streaming, SSE & WebSocket](/docs/streaming).
- **Return the error.** All body writers return `error`. Returning it from your
  handler lets Celeris centralise error handling — see
  [Error handling](/docs/error-handling).

| Error | Returned when |
| --- | --- |
| `ErrResponseWritten` | A body method is called after a response was already sent. |
| `ErrDetached` | A body-*writing* method (`JSON`/`String`/`Blob`/…) is called on a detached context. `NoContent` is exempt. |

## Status codes

`Status(code)` sets the status code on the `Context` and returns the `Context`
for chaining:

```go
return c.Status(201).StatusJSON(created)
```

`StatusCode()` reads the status code currently set on the `Context`.

> **Important:** `Status` does **not** feed `JSON`, `XML`, `String`, or `Blob` —
> those methods each take their own `code` argument and ignore the value set by
> `Status`. `Status` only feeds the `Status*` convenience helpers below.

```go
// These two are equivalent:
c.Status(201)
c.JSON(200, v) // ⚠️ writes 200, NOT 201 — JSON ignores Status

// Use a Status* helper to honour Status(201):
c.Status(201).StatusJSON(v) // writes 201
```

The `Status*` helpers read the code from `Status` so you can express the status
and the body separately:

| Helper | Equivalent to |
| --- | --- |
| `StatusJSON(v)` | `c.JSON(c.statusCode, v)` |
| `StatusXML(v)` | `c.XML(c.statusCode, v)` |
| `StatusString(s)` | `c.Blob(c.statusCode, "text/plain", []byte(s))` |
| `StatusBlob(ct, data)` | `c.Blob(c.statusCode, ct, data)` |

## Body responses

### JSON

`JSON(code, v)` serialises `v` and writes it with content type
`application/json`:

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    return c.JSON(200, map[string]any{
        "id":   c.Param("id"),
        "name": "Ada",
    })
})
```

> **JSON does not HTML-escape.** Unlike the standard library's default,
> Celeris emits `<`, `>`, and `&` literally (it encodes with
> `SetEscapeHTML(false)`). This is correct for API payloads, but if you embed
> JSON inside an HTML `<script>` block you must escape it yourself.

```go
c.JSON(200, map[string]string{"q": "1 < 2 && 3 > 2"})
// → {"q":"1 < 2 && 3 > 2"}   (NOT < / & / >)
```

Celeris uses a reflection-free fast path for common API shapes (primitives,
`map[string]string`, `map[string]any`, and slices of those), falling back to
`encoding/json` for everything else. The output is byte-identical to
`encoding/json` with HTML escaping disabled, so struct tags (`json:"..."`,
`omitempty`, etc.) behave exactly as you expect:

```go
type User struct {
    ID    string `json:"id"`
    Email string `json:"email,omitempty"`
}
return c.JSON(200, User{ID: "42"}) // → {"id":"42"}
```

If `v` cannot be marshalled, `JSON` returns the encoder's error (and nothing is
written).

### XML

`XML(code, v)` marshals `v` with `encoding/xml` and writes it as
`application/xml`:

```go
type Item struct {
    XMLName xml.Name `xml:"item"`
    Name    string   `xml:"name"`
}
return c.XML(200, Item{Name: "widget"})
```

### HTML

`HTML(code, html)` writes a string as `text/html; charset=utf-8`. There is **no
templating** — the string is sent verbatim:

```go
return c.HTML(200, "<h1>Hello</h1>")
```

For dynamic HTML, render a template to a string or buffer first — see
[HTML templating](#html-templating) below.

### String (text)

`String(code, format, args...)` writes `text/plain`. With extra arguments it
formats with `fmt.Sprintf`; with no arguments the `format` string is written
as-is:

```go
c.String(200, "hello %s, you are #%d", name, n) // fmt-style
c.String(404, "not found")                       // literal, no formatting
```

> If your literal text contains `%` and you pass **no** args, it is written
> verbatim (no formatting). But if it contains `%` and you also pass args,
> `fmt.Sprintf` rules apply — escape literal percent signs as `%%`.

### Blob (the primitive)

`Blob(code, contentType, data)` is the low-level writer that all the helpers
above are built on. Use it for arbitrary content types and pre-encoded bytes:

```go
png := renderChart()
return c.Blob(200, "image/png", png)
```

Celeris sets `content-length` automatically from `len(data)` and sanitises the
content type (CR/LF/NUL bytes are stripped to prevent header injection).

### NoContent

`NoContent(code)` writes a status line and headers with an empty body:

```go
return c.NoContent(204)
```

### Body writers at a glance

| Method | Content type | Notes |
| --- | --- | --- |
| `JSON(code, v)` | `application/json` | No HTML escaping; reflection-free fast path. |
| `XML(code, v)` | `application/xml` | `encoding/xml` marshalling. |
| `HTML(code, html)` | `text/html; charset=utf-8` | Verbatim string; no templating. |
| `String(code, format, args...)` | `text/plain` | `fmt`-style when args are given. |
| `Blob(code, ct, data)` | caller-supplied | The primitive; sets `content-length`. |
| `NoContent(code)` | none | Empty body. |

## Content negotiation

### Respond

`Respond(code, v)` picks the response format from the request's `Accept`
header. It supports `application/json`, `application/xml`, and `text/plain`, and
**falls back to JSON** when nothing matches:

```go
s.GET("/item/:id", func(c *celeris.Context) error {
    item := store.Find(c.Param("id"))
    // JSON, XML, or plain text depending on what the client asked for.
    return c.Respond(200, item)
})
```

For `text/plain`, `Respond` formats the value with `%v`.

### Negotiate

`Negotiate(offers...)` inspects the `Accept` header and returns the best
matching offer, honouring quality values (`q=`). It returns `""` if none of the
offers match. When the request has no `Accept` header, it returns the first
offer:

```go
switch c.Negotiate("application/json", "text/csv") {
case "text/csv":
    return c.Blob(200, "text/csv", csvBytes)
default:
    return c.JSON(200, rows)
}
```

> **Accept vs Accept-Encoding/Accept-Language asymmetry.** `Negotiate` and
> `Respond` only look at the `Accept` header (content type). There are no
> `AcceptsEncodings` / `AcceptsLanguages` helpers — read the
> `accept-encoding` / `accept-language` request headers directly with
> `c.Header(...)` if you need to negotiate compression or language.

## Response headers

Set response headers **before** you write the body — once the body is flushed
the headers are already on the wire.

| Method | Behaviour |
| --- | --- |
| `SetHeader(key, value)` | Replaces any existing value for `key`. Sanitised. |
| `AddHeader(key, value)` | Appends a value (use for multi-value headers). Sanitised. |
| `SetHeaderTrust(key, value)` | Replace/append **without** sanitising — caller guarantees safety. |
| `AppendRespHeader(key, value)` | Append **without** sanitising or dedup walk — caller guarantees safety. |

```go
c.SetHeader("Cache-Control", "no-store")     // replaces
c.AddHeader("Vary", "Accept")                // appends
c.AddHeader("Vary", "Accept-Encoding")       // appends again
```

`SetHeader` and `AddHeader` lowercase the key (HTTP/2 requires lowercase header
names) and strip `\r`, `\n`, and NUL bytes from both key and value to prevent
response splitting (CWE-113). You can pass canonical casing like
`"Content-Type"` — it is lowercased for you.

> **Use the trusted variants only when you control the input.**
> `SetHeaderTrust` and `AppendRespHeader` skip the sanitisation scan for hot
> middleware paths. The caller **must** guarantee the key is lowercase ASCII and
> neither key nor value contains CR, LF, or NUL. `AppendRespHeader`
> additionally assumes no header with that key already exists. When in doubt,
> use `SetHeader` — it is the safe default.

To read what you've set so far, `ResponseHeaders()` returns the accumulated
header pairs (do not modify the returned slice).

## Cookies

`SetCookie(*Cookie)` appends a `Set-Cookie` header:

```go
c.SetCookie(&celeris.Cookie{
    Name:     "session",
    Value:    "abc123",
    Path:     "/",
    MaxAge:   3600,
    HTTPOnly: true,
    Secure:   true,
    SameSite: celeris.SameSiteLaxMode,
})
```

### Cookie fields

| Field | Type | Meaning |
| --- | --- | --- |
| `Name` | `string` | Cookie name. |
| `Value` | `string` | Cookie value (sent **as-is**, not URL-encoded). |
| `Path` | `string` | Scope to a URL path. |
| `Domain` | `string` | Scope to a domain. |
| `MaxAge` | `int` | `>0` → `Max-Age=N`; `0` → no `Max-Age` attribute; `<0` → `Max-Age=0` (delete). |
| `Expires` | `time.Time` | Legacy `Expires` attribute (e.g. IE11). Zero value omits it. Prefer `MaxAge`. |
| `Secure` | `bool` | HTTPS-only transmission. |
| `HTTPOnly` | `bool` | Hide from client-side scripts. |
| `SameSite` | `SameSite` | Cross-site behaviour (see below). |

### SameSite modes

| Constant | Emits | Meaning |
| --- | --- | --- |
| `SameSiteDefaultMode` | *(nothing)* | Leaves the attribute unset (browser default). |
| `SameSiteLaxMode` | `SameSite=Lax` | Sent with top-level navigations. |
| `SameSiteStrictMode` | `SameSite=Strict` | First-party context only. |
| `SameSiteNoneMode` | `SameSite=None` | All contexts — **requires `Secure`**. |

> **`SameSiteNone` needs `Secure`, and Celeris does not add it for you.** If you
> set `SameSite: SameSiteNoneMode` you must also set `Secure: true`, or browsers
> will reject the cookie. This is not auto-enforced.

> **Values are not encoded.** Cookie values are sent verbatim per RFC 6265. If
> your value may contain special characters, encode it yourself (e.g.
> `url.QueryEscape` / base64). Semicolons in `Name`, `Value`, `Path`, and
> `Domain` are stripped to prevent attribute injection, and CR/LF is stripped to
> prevent header injection.

### Deleting a cookie

`DeleteCookie(name, path)` emits a `Set-Cookie` that expires the cookie
immediately (it sets `Max-Age=0`). The `path` must match the path the cookie was
originally set with:

```go
c.DeleteCookie("session", "/")
```

## Redirects

`Redirect(code, url)` sets the `Location` header and writes an empty body:

```go
return c.Redirect(302, "/login")
```

The `code` must be a redirect status in the range **300–308**; anything else
returns `ErrInvalidRedirectCode`. Like other writers, calling it after a
response is written returns `ErrResponseWritten`.

```go
c.Redirect(200, "/x") // → ErrInvalidRedirectCode
c.Redirect(308, "/x") // OK — permanent redirect
```

## HTML templating

Celeris has **no** built-in `Render`/template API. Use the standard library's
`html/template` (which auto-escapes against XSS), render into a buffer, and send
the result with `HTML` or `Blob`:

```go
var tmpl = template.Must(template.New("page").Parse(
    `<h1>Hello {{.Name}}</h1>`,
))

s.GET("/hello/:name", func(c *celeris.Context) error {
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, map[string]string{
        "Name": c.Param("name"),
    }); err != nil {
        return err
    }
    return c.HTML(200, buf.String())
    // or: return c.Blob(200, "text/html; charset=utf-8", buf.Bytes())
})
```

Parse and compile templates **once** at startup (e.g. a package-level
`template.Must(...)`), not per request.

## Serving files

File serving (`File`, `FileFromDir`, `FileFromFS`), `Range` request support, and
download/inline `Content-Disposition` helpers (`Attachment`, `Inline`) are
covered on the [Static files](/docs/static-files) page.

For large or open-ended bodies, write incrementally with the stream writer
instead of buffering — see [Streaming, SSE & WebSocket](/docs/streaming).

## Common pitfalls

- **`Status(code)` does not change `JSON`/`XML`/`String`/`Blob`.** They take
  their own status argument. Use `Status(code).StatusJSON(v)` (etc.) when you
  want `Status` to take effect.
- **Writing twice.** The second write returns `ErrResponseWritten`; it does not
  panic, but the bytes never reach the client. Guard with `IsWritten()` in
  middleware.
- **Expecting HTML-escaped JSON.** `JSON` emits `<`, `>`, `&` literally. Escape
  yourself if embedding JSON in HTML.
- **`SameSiteNone` without `Secure`.** Browsers silently drop the cookie. Always
  pair them.
- **Cookie values with special characters.** They are not URL-encoded — encode
  them before assigning to `Value`.
- **Setting headers after the body.** Set every response header (and cookie)
  before the body write that flushes them.

## FAQ

**Does `JSON` escape HTML characters?**
No. It writes `<`, `>`, and `&` literally (`SetEscapeHTML(false)`), which is
correct for APIs. Escape manually if you embed JSON in HTML.

**How do I send a 201 with a JSON body?**
`return c.Status(201).StatusJSON(v)` — or just `return c.JSON(201, v)`. Both
work; `JSON` takes the code directly, while `Status(201)` only feeds the
`Status*` helpers.

**How do I return an empty 204?**
`return c.NoContent(204)`.

**Is there a template renderer?**
No. Render `html/template` to a buffer and call `HTML`/`Blob`. See
[HTML templating](#html-templating).

**How do I negotiate gzip or a language?**
`Negotiate`/`Respond` only handle the `Accept` (content type) header. Read
`accept-encoding` / `accept-language` directly via `c.Header(...)`.

## Related

- [Routing](/docs/routing) — handler signatures, groups, named routes.
- [Error handling](/docs/error-handling) — returning `HTTPError` and centralised handling.
- [Static files](/docs/static-files) — `File`, `FileFromDir`, ranges, downloads.
- [Streaming, SSE & WebSocket](/docs/streaming) — incremental responses.
