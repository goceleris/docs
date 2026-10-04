---
title: Compression, caching, and content
description: Response compression, ETag conditional responses, response caching, Protocol Buffers, and OpenAPI docs.
group: Middleware
order: 5
---

This page covers the middleware that shrink, validate, cache, and document your
responses: `compress` (zstd/brotli/gzip negotiation), `etag` (conditional `304`
responses), `cache` (full-response caching with pluggable stores), `protobuf`
(Protocol Buffers helpers), and `swagger` (OpenAPI docs UI).

Three of these — `compress`, `etag`, and `cache` — are **transform** middleware:
they buffer the downstream response, inspect or rewrite the bytes, then flush.
Because they all touch the same buffered body, **the order you install them in
matters**, and there is a section dedicated to getting it right. Two of them —
`compress` and `protobuf` — ship as **separate Go submodules** with their own
`go.mod`, so they're installed with their own `go get`.

## Response compression

The `compress` middleware buffers the response body, picks the best encoding the
client accepts, compresses, and sets `Content-Encoding`. It always adds
`Vary: Accept-Encoding` so caches key on the negotiated encoding — even when it
decides **not** to compress.

It is a **separate submodule**:

```bash
go get github.com/goceleris/celeris/middleware/compress
```

```go
import "github.com/goceleris/celeris/middleware/compress"

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(compress.New()) // zstd → br → gzip, MinLength 256
```

Source: `celeris/middleware/compress/compress.go`, `compress/config.go`.

### What it negotiates

`compress.New()` with no config supports **zstd, brotli (`br`), and gzip**, in
that server-side priority order. The actual codec is chosen by intersecting your
`Encodings` list with the client's `Accept-Encoding` header (via
`c.AcceptsEncodings`). `deflate` is supported but **opt-in** — you must add it to
`Encodings` to enable it.

```go
s.Use(compress.New(compress.Config{
    MinLength: 1024,                              // don't compress bodies < 1 KiB
    Encodings: []string{"zstd", "br", "gzip"},   // server priority order
    ExcludedContentTypes: []string{"image/", "video/", "audio/"},
}))
```

### Config reference

| Field                  | Type                       | Default                          | Meaning                                                                                  |
| ---------------------- | -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `MinLength`            | `int`                      | `256`                            | Minimum body size in bytes to compress. `0` = compress all non-empty bodies.             |
| `Encodings`            | `[]string`                 | `["zstd", "br", "gzip"]`         | Supported encodings in priority order. Valid: `zstd`, `br`, `gzip`, `deflate`.           |
| `GzipLevel`            | `compress.Level`           | `LevelDefault`                   | gzip level. Range `-1`..`9`, or `LevelBest`.                                              |
| `BrotliLevel`          | `compress.Level`           | `LevelDefault`                   | brotli level. Range `-1`..`11`, or `LevelBest`.                                           |
| `ZstdLevel`            | `compress.Level`           | `LevelDefault`                   | zstd level. Range `-1`..`4` (SpeedBestCompression), or `LevelBest`.                       |
| `DeflateLevel`         | `compress.Level`           | `LevelDefault`                   | deflate level. Range `-1`..`9`, or `LevelBest`. Only used if `deflate` is in `Encodings`. |
| `ExcludedContentTypes` | `[]string`                 | `["image/", "video/", "audio/"]` | Content-type **prefixes** never compressed. Empty slice disables exclusions.              |
| `Skip`                 | `func(*Context) bool`      | `nil`                            | Return `true` to skip compression for a request.                                         |
| `SkipPaths`            | `[]string`                 | `nil`                            | Exact-match paths to skip.                                                               |

Source: `compress/config.go:30-74`.

### Per-codec levels

`compress.Level` is an `int` with named sentinels. The zero value is
`LevelDefault`, so an unset level field is the library default for that codec.

| Constant       | Value | Resolves to                                                   |
| -------------- | ----- | ------------------------------------------------------------- |
| `LevelDefault` | `0`   | Library default (gzip `DefaultCompression`, brotli 6, zstd `SpeedDefault`). |
| `LevelNone`    | `-1`  | Store-only / no compression (zstd maps to its fastest mode).  |
| `LevelBest`    | `-2`  | Codec maximum: gzip 9, brotli 11, zstd 4.                     |
| `LevelFastest` | `1`   | Fastest (lowest) level.                                       |

You can also pass an explicit integer in the codec's valid range. Out-of-range
levels **panic at construction**, so a bad config fails loudly at startup, not at
request time:

```go
s.Use(compress.New(compress.Config{
    ZstdLevel:   compress.LevelBest,  // max zstd
    BrotliLevel: 4,                   // explicit brotli level 4
    GzipLevel:   compress.LevelNone,  // gzip store-only (no compression)
}))
```

Source: `compress/config.go:11-28`, `compress/config.go:109-146`.

### When compression is skipped

Even when the client accepts a codec, `compress` flushes the body **uncompressed**
(but still sets `Vary: Accept-Encoding`) in these cases:

- The response status is not `2xx`, or it is `206 Partial Content`. A 206's
  `Content-Range` counts bytes of the uncompressed file, and once a
  `Content-Encoding` applies a range is over the encoded bytes (RFC 9110
  §14.1.2), so a compressed part could not be reassembled.
- The body is empty, or smaller than `MinLength`.
- The response already has a `Content-Encoding` header (don't double-compress).
- The content type matches an `ExcludedContentTypes` prefix.
- Compressing would **expand** the body (`len(compressed) >= len(body)`).
- The request is a streaming response — SSE (`Accept: text/event-stream`) or a
  WebSocket upgrade — because those can't be buffered. `HEAD`/`OPTIONS` also pass
  through.

If compression itself errors, the middleware degrades gracefully: it flushes the
original uncompressed body so the client never sees a blank page.

Source: `compress/compress.go:84-198`.

### Install order relative to `etag`

When `compress` does compress a response that already carries a **strong** ETag,
it **weakens** that ETag (prefixes it with `W/`). A strong validator must match
the bytes on the wire octet-for-octet, and the wire now carries the compressed
form — so the original strong tag would corrupt cache validation (RFC 7232 §2.3).
This is exactly why `etag` must run **inside** `compress` — see [the ordering
section](#the-transform-stack-ordering).

## ETag and conditional `304` responses

The `etag` middleware computes a validator over the response body and answers
`If-None-Match` requests with `304 Not Modified` when the validator matches —
saving the body transfer on a cache revalidation. It is part of the core module
(no extra `go get`):

```go
import "github.com/goceleris/celeris/middleware/etag"

s.Use(etag.New()) // weak ETags, CRC-32
```

Source: `celeris/middleware/etag/etag.go`, `etag/config.go`.

### Weak vs strong

ETags come in two flavours. **Weak** ones (the default) are written `W/"abc123"`
and assert only that two responses are *semantically equivalent*. **Strong** ones
are written `"abc123"` and assert byte-for-byte identity.

```go
s.Use(etag.New(etag.Config{Strong: true})) // strong: "abc123"
```

Weak is the safe default precisely because a response may later be
content-negotiated or transfer-encoded (e.g. compressed) — and as noted above,
`compress` will downgrade a strong tag to weak anyway.

### Config reference

| Field       | Type                    | Default            | Meaning                                                                       |
| ----------- | ----------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `Strong`    | `bool`                  | `false` (weak)     | `true` emits strong tags (`"..."`); `false` emits weak (`W/"..."`).            |
| `HashFunc`  | `func([]byte) string`   | CRC-32 IEEE hex    | Computes the opaque tag from the body. Quotes / `W/` are added for you.        |
| `Skip`      | `func(*Context) bool`   | `nil`              | Return `true` to skip ETag handling.                                          |
| `SkipPaths` | `[]string`              | `nil`              | Exact-match paths to skip.                                                    |

Source: `etag/config.go:5-24`.

### Custom hash function

The default validator is a fast **CRC-32** (IEEE) hash of the body. For a stronger
collision guarantee, plug in your own `HashFunc` — return just the opaque value;
the middleware wraps it in quotes (and `W/` if weak) based on `Strong`:

```go
import (
    "crypto/sha256"
    "encoding/hex"
)

s.Use(etag.New(etag.Config{
    Strong: true,
    HashFunc: func(body []byte) string {
        sum := sha256.Sum256(body)
        return hex.EncodeToString(sum[:])
    },
}))
```

### It only acts on GET/HEAD success bodies

`etag` runs only for `GET` and `HEAD`. It writes an ETag only when the status is
`2xx` and the body is non-empty. On an `If-None-Match` match it discards the
buffered body and returns `304` with the validator header set.

A `206 Partial Content` is never hashed: its body is one part of the file, whose
hash is not the file's tag. Without a tag of the handler's it passes through
untouched. With one, `etag` keeps it (see below) and answers a matching
`If-None-Match` with `304`, as for a full response: `If-None-Match` is evaluated
before `Range` (RFC 9110 §13.2.2).

If a downstream handler or middleware (for example the `static` file middleware)
**already** set an `ETag` header, `etag` reuses that tag verbatim instead of
hashing the body — so you never get a double tag. Source: `etag/etag.go:17-111`.

### It must be the innermost transform

`etag` hashes the body it sees. For the validator to describe the resource (and to
stay stable across compression), it must compute over the **uncompressed** body —
which means it has to run *closer to the handler* than `compress`. Put differently:
`compress` wraps `etag`. The next section makes this concrete.

## Response caching

The `cache` middleware stores entire responses (status, headers, body) and replays
them on subsequent matching requests — skipping the handler entirely on a hit. It
is part of the core module:

```go
import "github.com/goceleris/celeris/middleware/cache"

s.Use(cache.New()) // in-memory store, 1-minute TTL, GET/HEAD, 2xx only
```

A hit sets `X-Cache: HIT`; a miss runs the handler and sets `X-Cache: MISS`. A
store transport error sets `X-Cache: ERROR` and passes through uncached. Source:
`celeris/middleware/cache/cache.go`, `cache/config.go`, `cache/store.go`.

### Config reference

| Field                 | Type                          | Default                | Meaning                                                                                 |
| --------------------- | ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `Store`               | `store.KV`                    | `NewMemoryStore()`     | Cache backend. Any `store.KV` works (in-memory, Redis, …).                              |
| `TTL`                 | `time.Duration`               | `1 * time.Minute`      | Default entry lifetime. Capped by `Cache-Control: max-age` when respected.               |
| `KeyGenerator`        | `func(*Context) string`       | method+path+query+vary | Derives the cache key. See below.                                                       |
| `DisableSingleflight` | `bool`                        | `false`                | Turn off the coalescing of concurrent misses for the same key into one handler run.      |
| `Methods`             | `[]string`                    | `["GET", "HEAD"]`      | Methods eligible for caching. Others pass through untouched.                             |
| `StatusFilter`        | `func(int) bool`              | `2xx only`             | Decides whether a computed response is stored. A `206` or `416` is never stored, whatever it says, even when the key includes `Range` (in `VaryHeaders` or a `KeyGenerator`): both answer one request's `Range`, and a replay would skip the handler's `If-Range` check. |
| `VaryHeaders`         | `[]string`                    | `nil`                  | Request headers folded into the default key.                                            |
| `HeaderName`          | `string`                      | `"X-Cache"`            | Header set to `HIT`/`MISS`/`ERROR`. `""` disables it.                                    |
| `MaxBodyBytes`        | `int`                         | `1 << 20` (1 MiB)      | Bodies larger than this are not cached.                                                  |
| `IncludeHeaders`      | `[]string`                    | `nil` (all)            | Whitelist of response headers to store. When set, only these are kept.                  |
| `ExcludeHeaders`      | `[]string`                    | `["set-cookie"]`       | Response headers to drop from the stored set (applied after `IncludeHeaders`).          |
| `IgnoreCacheControl`  | `bool`                        | `false`                | Store responses whatever their `Cache-Control` says. By default `no-store`/`private` skip and `max-age=N` caps the TTL. |
| `Skip`                | `func(*Context) bool`         | `nil`                  | Return `true` to skip caching for a request.                                            |
| `SkipPaths`           | `[]string`                    | `nil`                  | Exact-match paths to skip.                                                              |

Source: `cache/config.go:11-77`.

### Cache keys and `VaryHeaders`

The default key is `METHOD PATH`, plus the **sorted** query string when present,
plus the value of every header listed in `VaryHeaders`. Sorting the query means
`?a=1&b=2` and `?b=2&a=1` hit the same entry.

```go
// Cache per Accept-Encoding and per Authorization so compressed variants and
// per-user responses don't cross-contaminate.
s.Use(cache.New(cache.Config{
    VaryHeaders: []string{"Accept-Encoding", "Authorization"},
}))
```

For full control, supply a `KeyGenerator` (it ignores `VaryHeaders`):

```go
s.Use(cache.New(cache.Config{
    KeyGenerator: func(c *celeris.Context) string {
        // Tenant-scoped cache key.
        return c.Method() + " " + c.Header("x-tenant-id") + " " + c.Path()
    },
}))
```

Source: `cache/cache.go:304-347`.

### Singleflight

By default, if many requests miss on the **same key** at once, only one runs the
handler — the rest wait and replay the leader's response. This is the classic
protection against a *cache stampede* when a hot entry expires. The others wait
for the handler only: the leader stores the response after they have it, so a slow
or hung store `Set` holds none of them, and a request that arrives during that
`Set` gets the response too, within the response's TTL: a `Set` that never returns
does not keep serving it after that. A waiter waits only as long as its own request
context lives; on `epoll` and `io_uring` an HTTP/1 request's context has no end of
its own, so give it one with the `timeout` middleware if a waiter must give up. If
the handler (or the store's `Set`) panics, the panic stays the
leader's and each waiter runs its own handler. Disable coalescing only if your
handler must run per-request:

```go
s.Use(cache.New(cache.Config{DisableSingleflight: true}))
```

Both of `Config`'s switches are named so that `false`, a field a `Config` literal
leaves out, is the default: before celeris v1.6.0 a `Config` that did not set
`Singleflight: true` silently turned coalescing off, and `RespectCacheControl:
false` had no effect ([celeris#922](https://github.com/goceleris/celeris/issues/922)).

Source: `cache/cache.go:87-124`.

### Honoring `Cache-Control`

Unless `IgnoreCacheControl` is set, the middleware reads the **response's**
`Cache-Control`:

- `no-store` or `private` → the response is **not** cached.
- `max-age=N` → the effective TTL is `min(cfg.TTL, N seconds)`.

```go
s.GET("/report", func(c *celeris.Context) error {
    c.SetHeader("cache-control", "max-age=30") // cache this one for ≤ 30s
    return c.JSON(200, buildReport())
})

s.GET("/me", func(c *celeris.Context) error {
    c.SetHeader("cache-control", "private")    // never cached
    return c.JSON(200, currentUser(c))
})
```

`Set-Cookie` is excluded from the stored header set by default, so a cached
response won't leak one user's session cookie to another. Source:
`cache/cache.go:191-220`, `cache/config.go:107-109`.

### Invalidation

Two package-level helpers let you evict entries imperatively — for example after a
write that makes a cached read stale. They operate on the same `store.KV` you
passed to `cache.New`:

| Function                                  | Effect                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| `cache.Invalidate(s store.KV, key)`       | Delete the exact entry for `key`.                            |
| `cache.InvalidatePrefix(s store.KV, pfx)` | Delete every entry whose key starts with `pfx`.             |

`InvalidatePrefix` requires the store to implement `store.PrefixDeleter`; if it
doesn't, it returns `cache.ErrNotSupported`. The default in-memory store supports
it.

```go
store := cache.NewMemoryStore()
s.Use(cache.New(cache.Config{Store: store}))

s.POST("/users/:id", func(c *celeris.Context) error {
    updateUser(c.Param("id"))
    // Bust the cached GET for this user. Key shape matches the default
    // generator: "GET " + path.
    _ = cache.Invalidate(store, "GET /users/"+c.Param("id"))
    return c.NoContent(204)
})
```

> Construct your store **once** and share the same value between `cache.New` and
> your invalidation calls. The middleware does not expose the store it created
> internally, so to invalidate you must own the reference.

Source: `cache/cache.go:398-415`.

### Pluggable stores

`Store` is any `store.KV` — the small `Get`/`Set`/`Delete` interface that all
Celeris middleware stores share (`celeris/middleware/store/kv.go`). The default is
an in-memory sharded LRU (`cache.NewMemoryStore`); swap in a distributed backend
to share a cache across instances.

```go
store := cache.NewMemoryStore(cache.MemoryStoreConfig{
    MaxEntries:      10_000,           // global cap; 0 = unlimited
    CleanupInterval: 30 * time.Second, // expired-entry sweep cadence
})
defer store.Close() // stops the cleanup goroutine
s.Use(cache.New(cache.Config{Store: store}))
```

`MemoryStore` fields (`cache/store.go:14-32`):

| Field             | Default            | Meaning                                                    |
| ----------------- | ------------------ | --------------------------------------------------------- |
| `Shards`          | `runtime.NumCPU()` | Lock shards, rounded up to a power of two.                |
| `MaxEntries`      | `0` (unlimited)    | Total entry cap across shards; LRU eviction when over.    |
| `CleanupInterval` | `1 * time.Minute`  | How often expired entries are swept.                      |
| `CleanupContext`  | `nil`              | Cancel this context to stop the cleanup goroutine.        |

Any type satisfying `store.KV` works as a cache backend — including a
Redis-backed store, which also gives you `InvalidatePrefix` because it implements
`store.PrefixDeleter`. See [Data stores](/docs/data-stores) for the `store.KV`
interface and the available backends.

## The transform-stack ordering

`compress`, `cache`, and `etag` all buffer the downstream response. They compose
correctly only in this order — outermost first:

```go
s.Use(compress.New()) // 1. outermost: compresses the final bytes, adds Vary
s.Use(cache.New())    // 2. caches the (uncompressed, ETagged) representation
s.Use(etag.New())     // 3. innermost: hashes the raw handler body
```

Read it from the handler outward. The handler produces a body. `etag` (innermost)
hashes that raw body and may short-circuit to `304`. `cache` stores/replays that
representation. `compress` (outermost) compresses whatever made it back out and
sets `Content-Encoding` + `Vary: Accept-Encoding`.

Why this order:

- **`etag` innermost** so it hashes the *uncompressed* body. A validator over
  compressed bytes would change whenever you tuned a compression level, and would
  vary by negotiated codec.
- **`compress` outermost** so it compresses the post-cache, post-ETag bytes — and
  so it can downgrade a strong ETag to weak (`W/`) when it changes the wire form
  (RFC 7232 §2.3). If `compress` ran *inside* `cache`, you'd cache a body whose
  encoding doesn't match the `Vary` the outer layer would have set.
- **`cache` in the middle** keys on the request (fold `Accept-Encoding` into
  `VaryHeaders` if you cache across codecs) and stores the representation `etag`
  produced.

Remember that `s.Use` order is also the *execution* order on the way **in**, and
the reverse on the way **out** — see [Middleware](/docs/middleware) for the full
chain model.

## Protocol Buffers

The `protobuf` package provides helpers to write and read `proto.Message` values
over HTTP, with content negotiation against JSON. It is a **separate submodule**:

```bash
go get github.com/goceleris/celeris/middleware/protobuf
```

```go
import "github.com/goceleris/celeris/middleware/protobuf"
```

Source: `celeris/middleware/protobuf/protobuf.go`, `protobuf/middleware.go`,
`protobuf/config.go`.

### Content types and errors

| Constant / error             | Value                                                |
| ---------------------------- | ---------------------------------------------------- |
| `protobuf.ContentType`       | `"application/x-protobuf"` (primary)                 |
| `protobuf.ContentTypeAlt`    | `"application/protobuf"` (accepted alternative)      |
| `protobuf.ErrNilMessage`     | passed a `nil` `proto.Message`                       |
| `protobuf.ErrInvalidProtoBuf`| unmarshal failed (wraps the underlying error)        |
| `protobuf.ErrNotProtoBuf`    | `Bind` saw a non-protobuf `Content-Type`             |

Source: `protobuf/config.go:9-25`.

### Package-level functions

These work without installing any middleware — call them directly from a handler:

| Function                                             | What it does                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `Write(c, code, v)`                                  | Marshal `v` and write with `application/x-protobuf`.                          |
| `BindProtoBuf(c, v)`                                 | Unmarshal the body into `v` regardless of `Content-Type`. Empty body → `ErrEmptyBody`. |
| `Bind(c, v)`                                         | Like `BindProtoBuf`, but first check `Content-Type` is protobuf; else `ErrNotProtoBuf`. |
| `Respond(c, code, v, jsonFallback)`                  | Negotiate: protobuf if the client accepts it, else JSON.                      |

```go
s.POST("/echo", func(c *celeris.Context) error {
    var msg pb.EchoRequest
    if err := protobuf.Bind(c, &msg); err != nil {
        if errors.Is(err, protobuf.ErrNotProtoBuf) {
            return celeris.NewHTTPError(415, "send application/x-protobuf")
        }
        return celeris.NewHTTPError(400, "invalid protobuf")
    }
    return protobuf.Write(c, 200, &pb.EchoResponse{Text: msg.Text})
})
```

`Respond` is the convenient one for dual-protocol APIs — the same handler serves
protobuf clients and browsers:

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    u := loadUser(c.Param("id")) // *pb.User, also JSON-serializable
    // Client sent Accept: application/x-protobuf  → protobuf bytes
    // Client sent Accept: application/json (or *) → JSON
    return protobuf.Respond(c, 200, u, u)
})
```

`Respond` writes the *exact* protobuf variant the client preferred
(`application/x-protobuf` vs `application/protobuf`) and honors `q=0` to exclude a
form. Source: `protobuf/protobuf.go:30-134`.

### The middleware just stores config

`protobuf.New(Config)` doesn't transform anything — it stashes a `Config`
(marshal/unmarshal options) in the request context so handlers can read it back
with `protobuf.FromContext(c)` and use the configured options without threading
them through every call. The default unmarshal option is `DiscardUnknown: true`.

```go
s.Use(protobuf.New(protobuf.Config{
    UnmarshalOptions: proto.UnmarshalOptions{DiscardUnknown: false}, // strict
}))

s.POST("/strict", func(c *celeris.Context) error {
    pbx := protobuf.FromContext(c) // *protobuf.Helper
    var msg pb.Item
    if err := pbx.Bind(&msg); err != nil { // uses the strict options above
        return celeris.NewHTTPError(400, "bad protobuf")
    }
    return pbx.Write(200, &msg)
})
```

`FromContext` returns a `*Helper` with `Write(code, v)` and `Bind(v)` methods.
`Helper.Bind` — like the package-level `Bind` — first checks the request
`Content-Type` is protobuf and returns `ErrNotProtoBuf` otherwise, then unmarshals
with the stored options. If the middleware wasn't installed, `FromContext` falls
back to default options, so it's always safe to call. Source:
`protobuf/middleware.go:14-60`, `protobuf/config.go:55-68`.

## OpenAPI docs (Swagger)

The `swagger` middleware serves an interactive OpenAPI viewer from your spec. It
is part of the core module:

```go
import "github.com/goceleris/celeris/middleware/swagger"

//go:embed openapi.yaml
var spec []byte

s.Use(swagger.New(swagger.Config{SpecContent: spec}))
// → GET /swagger/      serves the UI
// → GET /swagger/spec  serves the raw spec
// → GET /swagger       301-redirects to /swagger/ (Location: ./swagger/)
// → GET /swagger/assets/swagger-ui-dist@<version>/…  the embedded Swagger UI files
// → GET /swagger/oauth2-redirect.html (and .js)       Swagger UI's OAuth2 redirect page
```

The page refers to the spec, to its files and to the redirect page relative to
itself, and the redirect's `Location` is relative too. So the defaults also work
behind a reverse proxy that publishes the app under another prefix and strips it
(the browser asks for `/ext/swagger/`, the app sees `/swagger/`).

Source: `celeris/middleware/swagger/swagger.go`, `swagger/config.go`.

### Renderers

Pick the frontend with `Renderer`:

| Constant                    | Value          | UI                       |
| --------------------------- | -------------- | ------------------------ |
| `swagger.RendererSwaggerUI` | `"swagger-ui"` | Swagger UI (default)     |
| `swagger.RendererScalar`    | `"scalar"`     | Scalar API reference     |
| `swagger.RendererReDoc`     | `"redoc"`      | ReDoc                    |

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    Renderer:    swagger.RendererScalar,
    CDN:         true, // Scalar and ReDoc are not embedded: pick CDN or AssetsPath
}))
```

Swagger UI is **embedded** in the package and served by the middleware itself,
so the default page loads no script or stylesheet from a third party. Scalar and
ReDoc are not embedded: set `CDN: true` (pinned, integrity-checked) or
`AssetsPath`, or `New` panics. See [assets](#assets-embedded-cdn-or-self-hosted).

### Where the spec comes from

Provide the spec one of three ways — exactly one of `SpecContent` or `SpecURL` is
required (the middleware **panics at construction** if neither is set):

| Field         | Type     | Meaning                                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------------------- |
| `SpecContent` | `[]byte` | Inline spec (JSON or YAML). Served at `{BasePath}/spec`; the page loads it as `spec`, relative to itself. |
| `SpecURL`     | `string` | URL to an externally hosted spec. When set, `SpecContent` is ignored and `/spec` is **not** registered. |
| `SpecFile`    | `string` | Original filename (e.g. `"openapi.yaml"`); a hint for content-type detection of `SpecContent`. |

If you don't set `SpecFile`, the content type of an inline spec is sniffed from
its first non-whitespace byte (`{`/`[` → JSON, else YAML). Source:
`swagger/config.go:143-160`, `swagger/config.go:304-328`, `swagger/swagger.go:176-187`.

### Config reference

| Field        | Type                  | Default               | Meaning                                                         |
| ------------ | --------------------- | --------------------- | -------------------------------------------------------------- |
| `BasePath`   | `string`              | `"/swagger"`          | URL prefix. Must start with `/` (panics otherwise).            |
| `SpecContent`| `[]byte`              | `nil`                 | Inline spec bytes.                                             |
| `SpecURL`    | `string`              | `""`                  | External spec URL.                                            |
| `SpecFile`   | `string`              | `""`                  | Filename hint for content-type detection.                     |
| `Renderer`   | `swagger.UIRenderer`  | `RendererSwaggerUI`   | UI frontend.                                                  |
| `UI`         | `swagger.UIConfig`    | see below             | Appearance/behavior of the UI.                               |
| `Options`    | `map[string]any`      | `nil`                 | Renderer-specific JSON-serializable config (must marshal).    |
| `AssetsPath` | `string`              | `""` (embedded)       | URL prefix of UI assets you serve yourself.                  |
| `CDN`        | `bool`                | `false`               | Load the UI from jsDelivr, pinned to an exact version with SRI hashes. |
| `Skip`       | `func(*Context) bool` | `nil`                 | Skip predicate.                                              |
| `SkipPaths`  | `[]string`            | `nil`                 | Exact-match paths to skip.                                   |

Source: `swagger/config.go:111-236`.

### UI options

`UIConfig` tunes the page. Several fields are **Swagger UI only** and ignored by
Scalar/ReDoc:

| Field                       | Type     | Default                 | Notes                                                              |
| --------------------------- | -------- | ----------------------- | ----------------------------------------------------------------- |
| `Title`                     | `string` | `"API Documentation"`   | HTML page title.                                                   |
| `DocExpansion`              | `string` | `"list"`                | `"list"`, `"full"`, or `"none"` (panics on any other value). Swagger UI only. |
| `DeepLinking`               | `bool`   | `false`                 | Deep links for tags/operations. Swagger UI only.                  |
| `PersistAuthorization`      | `bool`   | `false`                 | Keep auth across sessions. Swagger UI only.                       |
| `DefaultModelsExpandDepth`  | `*int`   | `nil` (UI default 1)    | `IntPtr(0)` = names only, `IntPtr(-1)` = hide models. Swagger UI only. |
| `OAuth2RedirectURL`         | `string` | `""` (`{BasePath}/oauth2-redirect.html`) | OAuth2 redirect URL. Leave it empty: the middleware serves the redirect page. Swagger UI only. |
| `ValidatorURL`              | `string` | `""` (badge off)        | Validator the online validator badge sends the spec URL to. Swagger UI only. |
| `OAuth2`                    | `*OAuth2Config` | `nil`            | Pre-fills the OAuth2 dialog. Swagger UI only.                     |

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    UI: swagger.UIConfig{
        Title:                    "Acme API",
        DocExpansion:             "none",
        DeepLinking:              true,
        DefaultModelsExpandDepth: swagger.IntPtr(-1), // hide the models section
    },
}))
```

`DefaultModelsExpandDepth` is a `*int` so the middleware can tell "unset" (use the
UI default of 1) from an explicit `0`. Use `swagger.IntPtr` to set it. Source:
`swagger/config.go:24-87`, `swagger/config.go:238-243`.

### OAuth2 with PKCE

For protected specs you can pre-fill the Swagger UI authorization dialog. Browser
flows **must** use PKCE — only the *public* `ClientID` is safe to embed in the
served HTML, so there is deliberately no `ClientSecret` field. Run any
confidential token exchange on your backend, never in the page.

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    UI: swagger.UIConfig{
        OAuth2: &swagger.OAuth2Config{
            ClientID: "my-public-client",  // public; embedded in HTML
            AppName:  "Acme API Docs",
            Scopes:   []string{"read", "write"},
            // PKCE (the recommended public-client flow) is on by default;
            // DisablePKCE: true turns it off.
        },
    },
}))
```

The authorization server sends the browser back to Swagger UI's redirect page,
which hands the result to the docs page through `window.opener`, so it must come
from the docs page's own origin. The middleware serves it, the one shipped in
swagger-ui-dist, at `{BasePath}/oauth2-redirect.html` (its script at
`{BasePath}/oauth2-redirect.js`), whether the UI's files are embedded, on the CDN
or self-hosted. That is where Swagger UI sends the browser when
`OAuth2RedirectURL` is empty: the page's directory plus `oauth2-redirect.html`,
as an absolute URL on the page's origin. Register that URL with the authorization
server as a redirect URI (for example `https://api.example.com/swagger/oauth2-redirect.html`,
or the public URL behind a proxy). Set `OAuth2RedirectURL` only to use a page of
your own; it is sent as the `redirect_uri`, so it must be an absolute URL on the
docs page's origin. If your app serves its own page at
`{BasePath}/oauth2-redirect.html`, list both paths in `SkipPaths`. Otherwise the
middleware answers them and your route does not run: a handler that answers the
request ends the chain ([celeris#927](https://github.com/goceleris/celeris/issues/927)).

`OAuth2Config` fields: `ClientID`, `Realm`, `AppName`, `Scopes`, `DisablePKCE`
(PKCE is on unless it is set; it replaces `UsePKCE`, which an `OAuth2Config`
literal that left it out turned off).
Source: `swagger/config.go`, `swagger/swagger.go`, `swagger/assets.go`.

### Renderer-specific options

`Options` is a free-form `map[string]any` (it must be JSON-serializable, or the
middleware panics at construction) passed straight to the renderer:

- **Swagger UI**: ignored. Configure Swagger UI through `UI` (see
  [UI options](#ui-options)).
- **ReDoc** → `Redoc.init()`.
- **Scalar** → `data-configuration`.

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    Renderer:    swagger.RendererReDoc,
    CDN:         true,
    Options: map[string]any{
        "expandResponses":    "200,201",
        "hideDownloadButton": true,
    },
}))
```

Source: `swagger/config.go:168-186`, `swagger/swagger.go:281-372`.

### Assets: embedded, CDN or self-hosted

Where the page loads the renderer's JavaScript and CSS from:

| Source | How | Swagger UI | Scalar / ReDoc |
| ------ | --- | ---------- | -------------- |
| Embedded (default) | nothing to set | served from `{BasePath}/assets/swagger-ui-dist@<version>/` | not embedded: `New` panics, set `CDN` or `AssetsPath` |
| CDN | `CDN: true` | jsDelivr, exact version, SRI | jsDelivr, exact version, SRI |
| Self-hosted | `AssetsPath: "/prefix"` | your files | your files |

**Embedded.** The middleware embeds swagger-ui-dist (`swagger.SwaggerUIVersion`)
byte for byte as published, together with its upstream licence notices
(Apache-2.0 `LICENSE` and `NOTICE`, plus the bundles' third-party notices). It
serves them under `{BasePath}/assets/swagger-ui-dist@<version>/` with
`Cache-Control: public, max-age=31536000, immutable`, which is safe because the
version is part of the URL. The page then works without Internet access, as
long as the spec is `SpecContent` or a `SpecURL` on your own server, and its
Content-Security-Policy needs no third-party origin for scripts or styles. (The
page's initialiser is still an inline `<script>`.) Swagger UI's online validator
badge is off: the page sets `validatorUrl: "none"`, so no viewer's browser sends
the spec's URL to `validator.swagger.io` (which would also fetch the spec when it
can reach it). Set `UI.ValidatorURL` to a validator you trust to show the badge.
The page references the files relative to `{BasePath}/`, so they also load
behind a reverse proxy that publishes the page under another prefix
(`/ext/swagger/` forwarded to `/swagger/`). Embedding adds about 2 MB to any binary that imports the package.
Like the page and the spec, the files are public unless an authentication
middleware runs before `swagger`: the bundle is a 1.5 MiB response at a fixed
URL.
Scalar (4.4 MB) and ReDoc (1.1 MB) are not embedded: the renderer is chosen at
run time, so every embedded bundle would end up in every binary. (Measured in
[celeris#851](https://github.com/goceleris/celeris/pull/851): with
swagger-ui-dist 5.33.1, linux/amd64 and arm64 binaries grow by 2.03 to 2.07 MB
and `swagger-ui-bundle.js` is 1,586,002 bytes; Scalar 1.72.4's
`standalone.js` is 4,381,105 bytes and ReDoc 2.5.4's `redoc.standalone.js`
1,103,471.)

**The asset requests must reach the middleware.** Besides `{BasePath}/` and
`{BasePath}/spec`, the browser asks the middleware for
`{BasePath}/assets/swagger-ui-dist@<version>/…`. If only the page and the spec
get through, the page loads but stays blank. Mounted with `s.Use` (or `s.Pre`),
the middleware sees every request under `{BasePath}`, whether or not a route
matches it: the global middleware also runs for unmatched requests, before the
404 (since celeris v1.6.0; before it, only when a `NotFound` handler was set,
[celeris#852](https://github.com/goceleris/celeris/issues/852)). A route of yours
that also matches one of its paths, such as an SPA's catch-all `/*filepath`, does
not run for the paths the middleware answers: a handler that answers the request
ends the chain ([celeris#927](https://github.com/goceleris/celeris/issues/927)).
A group-scoped mount sees only the group's routes, so it needs such a catch-all
route, `g.GET("/*filepath", …)`; the bare `/swagger` (no
trailing slash) then matches no route, so it answers 404 instead of redirecting to
`/swagger/`. Prefer `s.Use`. Forward the whole `{BasePath}/` prefix through any proxy
or ingress rule.

**CDN.** `CDN: true` loads the renderer from `cdn.jsdelivr.net`, pinned to the
exact versions in `swagger.SwaggerUIVersion`, `swagger.ScalarVersion` and
`swagger.ReDocVersion`. Every tag carries a Subresource Integrity hash and
`crossorigin="anonymous"`, so the browser refuses a file that differs from the
release the package was built against. The page then needs `cdn.jsdelivr.net` in
its CSP, and viewers need Internet access. Before
[celeris#851](https://github.com/goceleris/celeris/pull/851), Swagger UI loaded
from `unpkg.com`, so a CSP written for the old default must allow
`cdn.jsdelivr.net` instead. Wherever it is loaded from, Scalar's bundle also names
`fonts.scalar.com` (its default fonts, the `withDefaultFonts` option) and
`proxy.scalar.com` (its request proxy, the `proxyUrl` option).

```go
s.Use(swagger.New(swagger.Config{SpecContent: spec, CDN: true}))
```

**Self-hosted.** Set `AssetsPath` to a URL prefix you serve the files from, for
example with the `static` middleware:

```go
// Serve the downloaded swagger-ui-dist files under /swagger-assets.
s.Use(static.New(static.Config{Root: "./swagger-ui-dist", Prefix: "/swagger-assets"}))
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    AssetsPath:  "/swagger-assets", // page now references {AssetsPath}/swagger-ui-bundle.js etc.
}))
```

You are responsible for putting the files at that prefix, under the names the
packages publish them: Swagger UI needs `swagger-ui.css`, `swagger-ui-bundle.js`
and `swagger-ui-standalone-preset.js` (swagger-ui-dist's root); ReDoc needs
`redoc.standalone.js` (redoc's `bundles/`); Scalar needs `standalone.js`
(`@scalar/api-reference`'s `dist/browser/`). Before celeris v1.6.0 the Scalar
page asked for `standalone.min.js`, a name the package does not publish: if you
served Scalar's file under that name, serve it as `standalone.js` now. Swagger
UI's OAuth2 redirect page is still served by the middleware. The page is
written for the pinned versions above and carries no integrity hash, because the files are yours. `AssetsPath` and `CDN`
cannot both be set (`New` panics). Source: `swagger/assets.go`, `swagger/pins.go`.
See [Static files](/docs/static-files) for serving a directory.

## Common pitfalls

- **Wrong transform order.** Installing `etag` *outside* `compress` makes it hash
  compressed bytes — your validator then changes with every compression-level
  tweak. Order is `compress` → `cache` → `etag` (outermost to innermost).
- **Caching across encodings without varying.** If `compress` and `cache` are both
  on but `Accept-Encoding` is not in `VaryHeaders`, a client that accepts gzip can
  receive a cached entry stored for a brotli client (or vice versa). Add
  `Accept-Encoding` to `VaryHeaders`, or cache *inside* compress (the recommended
  order does the latter).
- **Forgetting `Vary` semantics.** `compress` always adds `Vary: Accept-Encoding`,
  even on uncompressed passes — don't strip it downstream, or shared caches will
  serve the wrong variant.
- **Bodies over `MaxBodyBytes` silently aren't cached.** The default cap is 1 MiB.
  Large responses pass through without an error; raise `MaxBodyBytes` if you
  intend to cache them.
- **Caching authenticated responses.** The default key ignores `Authorization`,
  and `Set-Cookie` is dropped from stored headers — but the *body* of a per-user
  response would still be shared. Add identifying headers to `VaryHeaders` (or a
  custom `KeyGenerator`), or set `Cache-Control: private` on those responses.
- **Invalidation needs your own store reference.** `cache.Invalidate` /
  `InvalidatePrefix` operate on the `store.KV` *you* constructed and passed in —
  the middleware never exposes a store it created for you.
- **`swagger` panics on an incomplete config.** `swagger.New` panics if neither
  `SpecContent` nor `SpecURL` is set, if `BasePath` doesn't start with `/`, if
  `Renderer` is `RendererScalar` or `RendererReDoc` without `CDN: true` or
  `AssetsPath` (neither is embedded), and if both `AssetsPath` and `CDN` are set.
- **`compress` levels panic on bad ranges.** An out-of-range level (e.g.
  `ZstdLevel: 9`) panics at startup — use the `Level` sentinels or a value in the
  codec's valid range.

## FAQ

**Does `compress` handle SSE or WebSocket responses?**
No — it detects `Accept: text/event-stream` and WebSocket upgrades and passes them
through unbuffered (still adding `Vary`). Buffering would break streaming. See
[Streaming](/docs/streaming).

**Why is my ETag weak even though I set `Strong: true`?**
Because `compress` compressed the response. A strong validator must match the wire
bytes octet-for-octet, so once the body is compressed the tag is downgraded to
weak (`W/`). This is correct per RFC 7232 §2.3.

**Can I use Redis (or another backend) for the cache?**
Yes. `Config.Store` accepts any `store.KV`. A Redis-backed store also gives you
`InvalidatePrefix` since it implements `store.PrefixDeleter`. See
[Data stores](/docs/data-stores).

**Do I need the `protobuf` middleware to write protobuf?**
No. `protobuf.Write`, `Bind`, and `Respond` are package functions that work on a
bare `*Context`. The middleware only matters when you want handlers to share
custom marshal/unmarshal options via `FromContext`.

**How do I serve the OpenAPI spec at a different path?**
Set `BasePath`. The UI is served at `{BasePath}/` and the inline spec at
`{BasePath}/spec`; a bare `{BasePath}` 301-redirects to the trailing-slash form
with a relative `Location` (`./api/` for `BasePath: "/docs/api"`), so the redirect
stays under a reverse proxy's prefix.

**How does `cache` choose what to store from a single concurrent burst?**
By default (unless `DisableSingleflight` is set), one leader runs the handler and
its waiters replay the same bytes — preventing a stampede when a hot key expires.

## See also

- [Responses](/docs/responses) — content negotiation (`c.Negotiate`,
  `c.AcceptsEncodings`), `Blob`, `JSON`, and `HTML`.
- [Data stores](/docs/data-stores) — the `store.KV` interface and available
  backends (in-memory, Redis, …) shared by `cache` and the other stateful
  middleware.
- [Static files](/docs/static-files) — serving directories, used for self-hosted
  Swagger assets, and the ETag interplay with the `static` middleware.
- [Streaming](/docs/streaming) — SSE and WebSocket, which `compress` and the
  transform middleware pass through.
- [Middleware](/docs/middleware) — the global/group/route chain model and
  install-order semantics that govern the transform stack.
- [Observability](/docs/observability) — metrics and tracing for cache hit rates
  and response sizes.
