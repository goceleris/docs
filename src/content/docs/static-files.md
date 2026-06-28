---
title: Serving files and static assets
description: Serve single files, directory trees, embedded filesystems, downloads, and static sites safely.
group: Routing & Handlers
order: 6
---

Celeris ships everything you need to serve files: single-file responses with
`Range` support, traversal-safe directory serving, embedded filesystems
(`embed.FS`), download/inline disposition helpers, a one-line `Static` router
helper, and a full-featured static middleware for SPAs, directory listings, and
pre-compressed assets.

This page is organised from the lowest-level primitive (`Context.File`) up to
the highest-level convenience (the static middleware). When in doubt, jump to
[Choosing an approach](#choosing-an-approach).

> **Security up front.** `Context.File` and `Context.FileFromFS` open the path
> you give them **directly** — they do *not* sanitise input. Whenever the path
> comes from the request (a route param, query string, header, or body), use
> [`Context.FileFromDir`](#safe-directory-serving), the
> [`Static`](#one-line-static-serving-static) helper, or the
> [static middleware](#the-static-middleware) — all of which clean the path,
> resolve symlinks, and re-check the directory boundary before opening anything.

## Single-file serving — `Context.File`

`Context.File(filePath string) error` serves one file from the OS filesystem.

```go
s.GET("/logo", func(c *celeris.Context) error {
    return c.File("./assets/logo.png")
})
```

What it does for you:

| Behaviour | Detail |
| --- | --- |
| **Content-Type** | Detected from the file extension via `mime.TypeByExtension`. Falls back to `application/octet-stream` when the extension is unknown. |
| **Range requests** | Sets `Accept-Ranges: bytes`. A valid `Range` header produces a `206 Partial Content` response with the correct `Content-Range`. |
| **Zero-copy** | On native engines that support it, the body is sent via `sendfile(2)` without copying through user space. Falls back to a buffered read otherwise (see note below). |
| **Size cap** | The whole file is read into memory, capped at **100 MB**. A larger file returns an `HTTPError` with status **413**. |

The `sendfile(2)` fast path is used transparently when the active engine's
response writer supports it. It is *not* used when response buffering or body
capture is active for the request, or on engines/protocols that don't implement
it (in those cases Celeris falls back to a buffered read and write — the
response is identical, just not zero-copy). You don't configure any of this; it
is chosen per request. See [Engines](/docs/engines) for which engine you're
running.

> **Security: `File` opens the path verbatim.** Never pass request-derived input
> to `File`. This is unsafe:
>
> ```go
> // ❌ DON'T: a request for /download/../../etc/passwd escapes your directory.
> s.GET("/download/*name", func(c *celeris.Context) error {
>     return c.File("./files/" + c.Param("name"))
> })
> ```
>
> Use [`FileFromDir`](#safe-directory-serving) for untrusted paths.

### Files larger than 100 MB

`File` rejects files over 100 MB with a `413`. To serve very large files (or
generate a large body on the fly), stream it instead with `Context.StreamWriter`:

```go
s.GET("/big.iso", func(c *celeris.Context) error {
    f, err := os.Open("/srv/images/big.iso")
    if err != nil {
        return celeris.NewHTTPError(404, "not found")
    }
    defer f.Close()

    c.SetHeader("content-type", "application/octet-stream")
    w := c.StreamWriter()
    if w == nil {
        return celeris.NewHTTPError(500, "streaming not supported")
    }
    _, err = io.Copy(w, f)
    return err
})
```

See [Streaming, SSE & WebSocket](/docs/streaming) for the full `StreamWriter` API.

## Safe directory serving — `Context.FileFromDir`

`Context.FileFromDir(baseDir, userPath string) error` is the safe way to serve a
file whose path comes from the request. It:

1. Cleans `userPath` and joins it under `baseDir`.
2. Rejects the request with **`400`** if the result escapes `baseDir` (e.g. via
   `..` segments).
3. Resolves symlinks and **re-checks** the prefix, so a symlink *inside*
   `baseDir` that points outside it can't be used to escape.
4. Returns **`400`** if the resolved path is a directory.
5. Delegates to [`File`](#single-file-serving-contextfile) for the actual
   response (so you keep Content-Type detection, `Range`/206, sendfile, and the
   100 MB cap).

```go
// Safe: traversal attempts get a 400 instead of leaking files.
s.GET("/files/*name", func(c *celeris.Context) error {
    return c.FileFromDir("./public", c.Param("name"))
})
```

A request for `/files/../../etc/passwd` returns `400 invalid file path` rather
than reading outside `./public`. A request that resolves to a directory also
returns `400` — `FileFromDir` serves files only, not listings (use the
[static middleware](#the-static-middleware) with `Browse` for listings).

## Embedded filesystems — `Context.FileFromFS`

`Context.FileFromFS(name string, fsys fs.FS) error` serves a file from any
`fs.FS` — most commonly an `embed.FS` baked into your binary, or `os.DirFS`.

```go
import "embed"

//go:embed assets/*
var assets embed.FS

s.GET("/static/logo.png", func(c *celeris.Context) error {
    return c.FileFromFS("assets/logo.png", assets)
})
```

Behaviour mirrors `File`: Content-Type from the extension, the 100 MB cap (→
`413`), and a `400` if `name` resolves to a directory.

| Detail | Note |
| --- | --- |
| **Zero-copy** | Only available when the `fs.FS` entry is backed by a real `*os.File` (e.g. `os.DirFS`). `embed.FS` and in-memory filesystems are read into memory, then written — no `sendfile`. |
| **Path syntax** | `fs.FS` paths use forward slashes, no leading `/`, and are relative to the embed root. |

> **Security: `FileFromFS` does not sanitise `name`.** It passes `name` straight
> to `fsys.Open`. For untrusted input over an `fs.FS`, prefer the
> [static middleware](#the-static-middleware) with the `FS` field, which strips
> the prefix and cleans the path for you. (`FileFromDir` works on the OS
> filesystem, not on an arbitrary `fs.FS`.)

## Downloads vs inline display

Two helpers set the `Content-Disposition` header to control how the browser
treats the response. Call them *before* you write the body.

`Context.Attachment(filename string)` prompts a download:

```go
s.GET("/reports/:id", func(c *celeris.Context) error {
    c.Attachment("report-2026.pdf")        // Content-Disposition: attachment; filename="report-2026.pdf"
    return c.FileFromDir("./reports", c.Param("id")+".pdf")
})
```

`Context.Inline(filename string)` suggests in-browser display:

```go
c.Inline("invoice.pdf")                    // Content-Disposition: inline; filename="invoice.pdf"
return c.File("./invoices/0042.pdf")
```

| Helper | Header set | Effect |
| --- | --- | --- |
| `Attachment(name)` | `Content-Disposition: attachment; filename="name"` | Browser downloads (Save As). |
| `Attachment("")` | `Content-Disposition: attachment` | Download, no suggested name. |
| `Inline(name)` | `Content-Disposition: inline; filename="name"` | Browser displays if it can. |
| `Inline("")` | `Content-Disposition: inline` | Inline, no suggested name. |

Both helpers escape the filename for the quoted-string header value, so quotes
and backslashes in the name are handled. If you build a
`Content-Disposition` header yourself, use the same escaping with
`celeris.EscapeQuotedString(s string) string`, which escapes `\` and `"` per
RFC 7230:

```go
name := celeris.EscapeQuotedString(userName) // safe to embed in filename="..."
```

## One-line static serving — `Static`

`Server.Static(prefix, root string) *Route` (and the identical
`RouteGroup.Static`) registers a `GET` route at `prefix + "/*filepath"` that
serves files from `root` via [`FileFromDir`](#safe-directory-serving) — so
traversal protection is built in.

```go
s := celeris.New(celeris.Config{Addr: ":8080"})
s.Static("/assets", "./public")
// GET /assets/css/app.css  →  ./public/css/app.css   (traversal-safe)
```

On a group, the group's prefix is prepended as usual:

```go
admin := s.Group("/admin")
admin.Static("/static", "./admin-ui")
// GET /admin/static/app.js  →  ./admin-ui/app.js
```

`Static` returns a `*Route`, so you can name it for reverse URLs (see
[Routing](/docs/routing)):

```go
s.Static("/assets", "./public").Name("assets")
url, _ := s.URL("assets", "css/app.css") // "/assets/css/app.css"
```

`Static` is deliberately minimal: it serves existing files and nothing else. No
directory index, no SPA fallback, no `Cache-Control`, no pre-compressed
variants, no directory listing. Reach for the static middleware when you need
any of those.

## The static middleware

For richer static serving, use `middleware/static`. Unlike `Static` (a single
route), the middleware runs in the chain: it serves a matching file or calls
`c.Next()` to fall through to your routes when nothing matches. It handles
`GET` and `HEAD`; all other methods fall through.

```go
import (
    "time"

    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/static"
)

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(static.New(static.Config{
    Root:   "./public",
    Prefix: "/",
    MaxAge: 24 * time.Hour,
}))
```

Serving an embedded filesystem instead of the OS filesystem:

```go
//go:embed dist/*
var dist embed.FS

s.Use(static.New(static.Config{
    FS:     dist,
    Prefix: "/",
}))
```

### `static.Config` reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `Root` | `string` | — | Directory on the OS filesystem to serve from. **Mutually exclusive with `FS`.** One of `Root`/`FS` is **required** — the middleware panics at construction if neither is set. |
| `FS` | `fs.FS` | — | Filesystem to serve from (e.g. `embed.FS`). If both `Root` and `FS` are set, `FS` takes precedence. |
| `Prefix` | `string` | `"/"` | URL prefix stripped before file lookup. `Prefix: "/static"` serves `/static/app.css` from `app.css`. Matched at segment boundaries — `/static` does **not** match `/static-docs`. Must start with `/`. |
| `Index` | `string` | `"index.html"` | File served when the request resolves to a directory. |
| `Browse` | `bool` | `false` | Render an HTML directory listing when a directory has no index file. |
| `SPA` | `bool` | `false` | Single-page-app mode: requests for non-existent files serve `Index` instead of falling through. |
| `MaxAge` | `time.Duration` | `0` | Sets `Cache-Control: public, max-age=N`. Zero means no `Cache-Control` header. |
| `Compress` | `bool` | `false` | Serve pre-compressed `.br`/`.gz` siblings when the client's `Accept-Encoding` allows. Brotli is preferred over gzip. Works with both `Root` and `FS`. |
| `Skip` | `func(c *celeris.Context) bool` | `nil` | Skip the middleware for requests where this returns `true`. |
| `SkipPaths` | `[]string` | `nil` | Skip the middleware for these exact request paths. |

### Caching and conditional requests

The middleware sets `Last-Modified` and a weak `ETag` (derived from mtime and
size) on every file response, and honours `If-None-Match` / `If-Modified-Since`,
returning **`304 Not Modified`** when the client's copy is fresh. Set `MaxAge`
to add `Cache-Control: public, max-age=N`. See [Configuration](/docs/configuration)
and the `etag` middleware in [Middleware](/docs/middleware) for related options.

### Single-page apps

```go
// dist/ contains index.html plus hashed JS/CSS bundles.
s.Use(static.New(static.Config{
    Root: "./dist",
    SPA:  true,  // unknown paths → index.html (client routing)
}))
```

With `SPA: true`, a request like `/users/42` that has no matching file serves
`index.html` so your client-side router can take over — instead of falling
through to a 404.

> **`MaxAge` is applied uniformly to every file, including `index.html`.**
> Setting a year-long `MaxAge` on a single middleware instance means
> `index.html` (the app shell) gets the same `Cache-Control: public,
> max-age=31536000` as your hashed bundles. Once a browser or CDN caches
> the shell for a year, users won't see new deploys until that TTL expires.
>
> The typical pattern is to serve hashed assets (e.g. `/assets/app-abc123.js`)
> with a long max-age and `index.html` with `no-cache` or a short TTL. To do
> that, register two middleware instances — one for the assets subtree with a
> long `MaxAge`, and one for everything else with no `MaxAge` (or `no-cache`
> via a separate `SetHeader` route):
>
> ```go
> // Hashed assets under /assets — safe to cache for a year.
> s.Use(static.New(static.Config{
>     Root:       "./dist",
>     Prefix:     "/assets",
>     MaxAge:     365 * 24 * time.Hour,
> }))
>
> // App shell and everything else — always revalidate.
> s.Use(static.New(static.Config{
>     Root:   "./dist",
>     SPA:    true,
>     MaxAge: 0,  // no Cache-Control; browser will revalidate via ETag/Last-Modified
> }))
> ```

### Pre-compressed assets

Build `app.js.br` and/or `app.js.gz` next to `app.js`. With `Compress: true`,
when a client sends `Accept-Encoding: br, gzip` the middleware serves the
`.br` variant (preferring Brotli), sets `Content-Encoding` and adds
`Vary: Accept-Encoding`. If no acceptable variant exists it serves the plain
file. This works with both `Root` and `FS`.

### Directory listings

```go
s.Use(static.New(static.Config{
    Root:   "./downloads",
    Prefix: "/downloads",
    Browse: true,   // directories without an index render an HTML listing
}))
```

Listings HTML-escape names and URL-encode hrefs. As with file serving, symlinks
are resolved and re-checked so a listing can't escape the root.

## Choosing an approach

| You want to… | Use |
| --- | --- |
| Serve one known file | [`Context.File`](#single-file-serving-contextfile) |
| Serve a request-controlled path from a directory | [`Context.FileFromDir`](#safe-directory-serving) or [`Static`](#one-line-static-serving-static) |
| Serve a file from `embed.FS` at a fixed name | [`Context.FileFromFS`](#embedded-filesystems-contextfilefromfs) |
| Mount a directory at a URL prefix, nothing fancy | [`Static`](#one-line-static-serving-static) |
| Index files, SPA fallback, caching, compression, or listings | [static middleware](#the-static-middleware) |
| Force a download / control disposition | [`Attachment` / `Inline`](#downloads-vs-inline-display) |
| Serve a file larger than 100 MB | [`StreamWriter`](#files-larger-than-100-mb) |

### `Static` helper vs static middleware

| | `Static(prefix, root)` | `static.New(Config{…})` |
| --- | --- | --- |
| Form | A single named route | Middleware in the chain |
| Source | OS directory only | OS directory (`Root`) **or** `fs.FS` (`FS`) |
| Index file | No | Yes (`Index`) |
| SPA fallback | No | Yes (`SPA`) |
| `Cache-Control` / ETag / 304 | ETag/304 via `File`; no `Cache-Control` | Full (`MaxAge`, ETag, `Last-Modified`, 304) |
| Pre-compressed `.br`/`.gz` | No | Yes (`Compress`) |
| Directory listing | No | Yes (`Browse`) |
| Traversal-safe | Yes (`FileFromDir`) | Yes |

## Common pitfalls

- **Passing request input to `File` or `FileFromFS`.** Both open the path
  directly. Use `FileFromDir`, `Static`, or the middleware for anything the
  client controls.
- **The 100 MB cap.** `File`, `FileFromDir`, `FileFromFS`, and the middleware all
  reject bodies over 100 MB with `413`. Stream larger files with
  [`StreamWriter`](#files-larger-than-100-mb).
- **Setting disposition after writing.** Call `Attachment`/`Inline` (and any
  `SetHeader`) **before** `File`/`FileFromDir`/`FileFromFS` writes the response.
- **`Root` *and* `FS` both set.** The middleware uses `FS` and ignores `Root`.
  Set exactly one.
- **Prefix that isn't a clean segment.** `Prefix` must start with `/`, and it
  matches at segment boundaries: `Prefix: "/static"` serves `/static/...` but not
  `/static-assets/...`.
- **Expecting `FileFromDir` to list directories.** It returns `400` for a
  directory. Use the middleware with `Browse: true` for listings, or `Index` for
  an index file.
- **Missing zero-copy on `embed.FS`.** `sendfile(2)` only applies to real
  `*os.File`s. `embed.FS` content is served from memory — correct, just not
  zero-copy.

## FAQ

**How is the Content-Type chosen?**
From the file extension via `mime.TypeByExtension`. If the extension is unknown,
`File`/`FileFromFS` fall back to `application/octet-stream`; the middleware
additionally sniffs the first bytes with `http.DetectContentType`.

**Do range requests / resumable downloads work?**
Yes. `File` (and the helpers built on it) set `Accept-Ranges: bytes` and answer
a valid `Range` header with `206 Partial Content` and a `Content-Range`. The
static middleware supports ranges too.

**Can I serve a single-binary app with no files on disk?**
Yes — `go:embed` your assets and serve them with `FileFromFS` (fixed paths) or
the static middleware's `FS` field (a whole tree, with SPA/caching/compression).

**Does serving a file set caching headers?**
`File` itself does not set `Cache-Control`/`ETag`. The static middleware sets
`ETag`, `Last-Modified`, optional `Cache-Control` (via `MaxAge`), and answers
conditional requests with `304`. See [Configuration](/docs/configuration).

## Related

- [Routing](/docs/routing) — wildcards, named routes, groups.
- [Streaming, SSE & WebSocket](/docs/streaming) — `StreamWriter` for large or
  generated bodies.
- [Middleware](/docs/middleware) — composing the static middleware with others.
- [Configuration](/docs/configuration) — server-wide options.
- [Engines](/docs/engines) — which engines provide the zero-copy `sendfile` path.
