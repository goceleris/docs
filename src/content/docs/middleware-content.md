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

- The response status is not `2xx`.
- The body is empty, or smaller than `MinLength`.
- The response already has a `Content-Encoding` header (don't double-compress).
- The content type matches an `ExcludedContentTypes` prefix.
- Compressing would **expand** the body (`len(compressed) >= len(body)`).
- The request is a streaming response — SSE (`Accept: text/event-stream`) or a
  WebSocket upgrade — because those can't be buffered. `HEAD`/`OPTIONS` also pass
  through.

If compression itself errors, the middleware degrades gracefully: it flushes the
original uncompressed body so the client never sees a blank page.

Source: `compress/compress.go:84-194`.

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

If a downstream handler or middleware (for example the `static` file middleware)
**already** set an `ETag` header, `etag` reuses that tag verbatim instead of
hashing the body — so you never get a double tag. Source: `etag/etag.go:17-97`.

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
| `Singleflight`        | `bool`                        | `true`                 | Coalesce concurrent misses for the same key into one handler run.                        |
| `Methods`             | `[]string`                    | `["GET", "HEAD"]`      | Methods eligible for caching. Others pass through untouched.                             |
| `StatusFilter`        | `func(int) bool`              | `2xx only`             | Decides whether a computed response is stored.                                          |
| `VaryHeaders`         | `[]string`                    | `nil`                  | Request headers folded into the default key.                                            |
| `HeaderName`          | `string`                      | `"X-Cache"`            | Header set to `HIT`/`MISS`/`ERROR`. `""` disables it.                                    |
| `MaxBodyBytes`        | `int`                         | `1 << 20` (1 MiB)      | Bodies larger than this are not cached.                                                  |
| `IncludeHeaders`      | `[]string`                    | `nil` (all)            | Whitelist of response headers to store. When set, only these are kept.                  |
| `ExcludeHeaders`      | `[]string`                    | `["set-cookie"]`       | Response headers to drop from the stored set (applied after `IncludeHeaders`).          |
| `RespectCacheControl` | `bool`                        | `true`                 | Honor `no-store`/`private` (skip) and `max-age=N` (cap TTL).                            |
| `Skip`                | `func(*Context) bool`         | `nil`                  | Return `true` to skip caching for a request.                                            |
| `SkipPaths`           | `[]string`                    | `nil`                  | Exact-match paths to skip.                                                              |

Source: `cache/config.go:11-72`.

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

Source: `cache/cache.go:292-335`.

### Singleflight

With `Singleflight` enabled (the default), if many requests miss on the **same
key** at once, only one runs the handler — the rest wait and replay the leader's
response. This is the classic protection against a *cache stampede* when a hot
entry expires. Disable it only if your handler must run per-request:

```go
s.Use(cache.New(cache.Config{Singleflight: false}))
```

Source: `cache/cache.go:87-124`.

### Honoring `Cache-Control`

With `RespectCacheControl` on (default), the middleware reads the **response's**
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
`cache/cache.go:191-220`, `cache/config.go:102-104`.

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

Source: `cache/cache.go:386-403`.

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
// → GET /swagger       301-redirects to /swagger/
```

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
}))
```

By default the renderer's JS/CSS load from a public CDN (unpkg for Swagger UI,
jsDelivr for Scalar/ReDoc). See [self-hosted assets](#self-hosted-assets) to serve
them yourself.

### Where the spec comes from

Provide the spec one of three ways — exactly one of `SpecContent` or `SpecURL` is
required (the middleware **panics at construction** if neither is set):

| Field         | Type     | Meaning                                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------------------- |
| `SpecContent` | `[]byte` | Inline spec (JSON or YAML). Served at `{BasePath}/spec`.                                  |
| `SpecURL`     | `string` | URL to an externally hosted spec. When set, `SpecContent` is ignored and `/spec` is **not** registered. |
| `SpecFile`    | `string` | Original filename (e.g. `"openapi.yaml"`); a hint for content-type detection of `SpecContent`. |

If you don't set `SpecFile`, the content type of an inline spec is sniffed from
its first non-whitespace byte (`{`/`[` → JSON, else YAML). Source:
`swagger/config.go:101-112`, `swagger/config.go:213-237`, `swagger/swagger.go:26-83`.

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
| `AssetsPath` | `string`              | `""` (CDN)            | Local URL prefix for self-hosted UI assets.                  |
| `Skip`       | `func(*Context) bool` | `nil`                 | Skip predicate.                                              |
| `SkipPaths`  | `[]string`            | `nil`                 | Exact-match paths to skip.                                   |

Source: `swagger/config.go:86-153`.

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
| `OAuth2RedirectURL`         | `string` | `""`                    | OAuth2 redirect URL. Swagger UI only.                             |
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
`swagger/config.go:24-160`.

### OAuth2 with PKCE

For protected specs you can pre-fill the Swagger UI authorization dialog. Browser
flows **must** use PKCE — only the *public* `ClientID` is safe to embed in the
served HTML, so there is deliberately no `ClientSecret` field. Run any
confidential token exchange on your backend, never in the page.

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    UI: swagger.UIConfig{
        OAuth2RedirectURL: "/swagger/oauth2-redirect.html",
        OAuth2: &swagger.OAuth2Config{
            ClientID: "my-public-client",  // public; embedded in HTML
            AppName:  "Acme API Docs",
            Scopes:   []string{"read", "write"},
            UsePKCE:  true,                 // recommended public-client flow
        },
    },
}))
```

`OAuth2Config` fields: `ClientID`, `Realm`, `AppName`, `Scopes`, `UsePKCE`.
Source: `swagger/config.go:52-84`, `swagger/swagger.go:118-143`.

### Renderer-specific options

`Options` is a free-form `map[string]any` (it must be JSON-serializable, or the
middleware panics at construction) passed straight to the renderer:

- **Swagger UI** → `SwaggerUIBundle()`.
- **ReDoc** → `Redoc.init()`.
- **Scalar** → `data-configuration`.

```go
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    Renderer:    swagger.RendererReDoc,
    Options: map[string]any{
        "expandResponses":    "200,201",
        "hideDownloadButton": true,
    },
}))
```

Source: `swagger/config.go:120-138`, `swagger/swagger.go:175-234`.

### Self-hosted assets

To avoid the public CDN (air-gapped deploys, CSP policies, no third-party
requests), set `AssetsPath` to a URL prefix you serve the renderer's
files from yourself — for example with the `static` middleware:

```go
// Serve the downloaded swagger-ui-dist files under /swagger-assets.
s.Use(static.New(static.Config{Root: "./swagger-ui-dist", Prefix: "/swagger-assets"}))
s.Use(swagger.New(swagger.Config{
    SpecContent: spec,
    AssetsPath:  "/swagger-assets", // page now references {AssetsPath}/swagger-ui-bundle.js etc.
}))
```

You are responsible for placing the actual asset files at that prefix. The
expected filenames differ per renderer — Swagger UI needs `swagger-ui.css`,
`swagger-ui-bundle.js`, and `swagger-ui-standalone-preset.js`; ReDoc needs
`redoc.standalone.js`; Scalar needs `standalone.min.js`. Source:
`swagger/swagger.go:97-233`. See [Static files](/docs/static-files) for serving a
directory.

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
- **`swagger` needs a spec.** `swagger.New` panics if neither `SpecContent` nor
  `SpecURL` is set, and if `BasePath` doesn't start with `/`.
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
`{BasePath}/spec`; a bare `{BasePath}` 301-redirects to the trailing-slash form.

**How does `cache` choose what to store from a single concurrent burst?**
With `Singleflight` (default on), one leader runs the handler and its waiters
replay the same bytes — preventing a stampede when a hot key expires.

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
