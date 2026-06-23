---
title: Routing
description: Register routes, path params and wildcards, groups, named routes and reverse URLs, and route-level options.
group: Routing & Handlers
order: 1
---

Celeris matches each incoming request to exactly one handler using a method-aware
radix trie. Handlers have the signature `func(c *celeris.Context) error` — returning
an error lets Celeris centralise error handling. This page covers everything about
getting a request to the right handler: registering routes, capturing path
segments, grouping routes under a shared prefix, naming routes for reverse URL
generation, and the per-route options exposed by the `*Route` handle.

Route registration must happen **before** `Start` — the handler chains are baked at
registration time. The `*Server` is only safe for concurrent use after `Start`.

## Registering routes

Every registration method takes a path pattern followed by a variadic list of
`HandlerFunc`. The **last** handler is the terminal handler; any leading handlers
are per-route middleware that run before it (see [Middleware](/docs/middleware)).
Each method returns a `*Route` handle you can chain options onto.

```go
s := celeris.New(celeris.Config{Addr: ":8080"})

s.GET("/health", healthHandler)
s.POST("/users", createUser)
s.PUT("/users/:id", replaceUser)
s.PATCH("/users/:id", patchUser)
s.DELETE("/users/:id", deleteUser)
s.HEAD("/users/:id", headUser)
s.OPTIONS("/users", optionsUser)
```

The seven standard HTTP verbs each have a dedicated method on `*Server` (and on
`*RouteGroup`): `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`.
Source: `celeris/server.go:154-186`.

### Per-route middleware

Because the signature is variadic, you can attach middleware to a single route at
registration time. Leading handlers run in order, then the terminal handler:

```go
// auditLog and requireAdmin run before deleteUser, in that order.
s.DELETE("/users/:id", auditLog, requireAdmin, deleteUser)
```

### `Any` — all standard methods at once

`Any` registers the **same** handler chain for all seven standard methods and
returns a `[]*Route` (one per method, in the order
`GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS`):

```go
routes := s.Any("/webhook", handleWebhook)
// routes has len 7; index 0 is the GET route, etc.
for _, r := range routes {
    r.Async() // opt every method into async dispatch
}
```

Source: `celeris/server.go:189-196`.

### `Handle` — custom and runtime-chosen methods

For non-standard verbs (WebDAV `PROPFIND`, `MKCOL`, …) or when the method is only
known at runtime, use `Handle`. Custom methods are stored in an overflow map rather
than the array-indexed fast path, but otherwise behave identically:

```go
s.Handle("PROPFIND", "/dav/*path", propfindHandler)

method := resolveMethodFromConfig()
s.Handle(method, "/rpc", rpcHandler)
```

Source: `celeris/server.go:149-151`.

> The standard verb methods are just thin wrappers over `Handle`, so there is no
> behavioural difference for `GET`/`POST`/etc. versus `Handle("GET", …)`.

## Path patterns

A path pattern is built from three kinds of segment:

| Segment       | Syntax     | Matches                                            | In `Context`                       |
| ------------- | ---------- | -------------------------------------------------- | ---------------------------------- |
| **Static**    | `/users`   | the literal text                                   | —                                  |
| **Parameter** | `:id`      | exactly one path segment (up to the next `/`)      | `c.Param("id")`                    |
| **Catch-all** | `*path`    | the rest of the path, **including a leading `/`**  | `c.Param("path")`                  |

```go
s.GET("/users/:id", showUser)            // /users/42        → id = "42"
s.GET("/users/:id/posts/:pid", showPost) // /users/42/posts/7 → id="42", pid="7"
s.GET("/files/*path", serveFile)         // /files/img/a.png → path = "/img/a.png"
```

### The catch-all value carries a leading slash

This is the one surprise worth memorising. A catch-all parameter's value **always
begins with `/`**, even though the route pattern has none after `*`:

```go
s.GET("/files/*path", func(c *celeris.Context) error {
    // request: GET /files/docs/readme.md
    return c.JSON(200, map[string]string{
        "path": c.Param("path"), // "/docs/readme.md"  ← leading slash
    })
})
```

The matcher prepends the slash to the remaining path
(`celeris/router_tree.go:206-208`). When the request is exactly the prefix **with
its trailing slash** (`/files/`), the catch-all matches with an empty value `""`
(`celeris/router_tree.go:174-178`). The bare prefix without the slash (`/files`)
does **not** match `/files/*path` at all and falls through to the 404 handler — if
you need `/files` to resolve too, register a separate route for it.

### Match precedence

When more than one pattern could match a request, Celeris always prefers the most
specific: **static > parameter > catch-all**. This ordering is independent of the
order in which you register the routes — the trie sorts children by specificity at
insert time (`celeris/router_tree.go:106`).

```go
s.GET("/users/:id", showUser)
s.GET("/users/me", showCurrentUser) // registered AFTER, still wins for /users/me

// GET /users/me  → showCurrentUser  (static beats :id)
// GET /users/42  → showUser         (falls back to the param)
```

### Slash normalisation

The router collapses **consecutive** slashes before matching, so `//users///42`
resolves the same as `/users/42` (`celeris/router_tree.go:236-263`). When that
collapse runs it also drops a single trailing slash, so `/users/42//` matches
`/users/:id`.

> **A lone trailing slash is *not* normalised.** Because the trim only happens as a
> side effect of the consecutive-slash collapse, a request to `/users/42/` — clean
> apart from the one trailing slash — does **not** match `/users/:id` and falls
> through to your 404 handler. If you want both `/users/42` and `/users/42/` to hit
> the same handler, either register both patterns or normalise the trailing slash
> in a [`Pre`](/docs/middleware) middleware before routing (see below).

Celeris never issues a redirect to a canonical form on its own — it simply matches
(or doesn't). The `redirect` middleware package handles trailing-slash
normalisation, either by rewriting the path in place or by emitting a redirect.
Install it with `Pre` so it runs before routing:

```go
import "github.com/goceleris/celeris/middleware/redirect"

// Strip the trailing slash before the router runs, so /users/42/ matches /users/:id.
s.Pre(redirect.RemoveTrailingSlashRewrite())

// …or send a 301/308 to the canonical (no-trailing-slash) URL instead.
s.Pre(redirect.RemoveTrailingSlashRedirect())
```

See [Middleware](/docs/middleware) for the full middleware catalogue.

### Patterns that panic at registration

Path validation runs when you register the route, so a malformed pattern fails
loudly at startup rather than silently mis-routing. Registration **panics** when:

| Condition                                | Example            | Panic message                                       |
| ---------------------------------------- | ------------------ | --------------------------------------------------- |
| Path does not begin with `/`             | `s.GET("users", …)`| `path must begin with '/'`                           |
| A parameter name is empty                | `/users/:`         | `path contains empty parameter name`                |
| A catch-all name is empty                | `/files/*`         | `path contains empty catchAll name`                 |
| A catch-all is not the last segment      | `/files/*p/more`   | `catchAll parameter must be the last path segment`  |

Source: `celeris/router_tree.go:265-288` and `celeris/router.go:412-416`.

## Reading path parameters

Inside a handler, read captured parameters off the `*Context`. All accessors are in
`celeris/context_request.go:94-126`.

| Method                                | Returns                | Behaviour                                                   |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `Param(key) string`                   | string                 | Value, or `""` if the parameter is absent                 |
| `ParamDefault(key, def) string`       | string                 | Value, or `def` if absent **or empty**                    |
| `ParamInt(key) (int, error)`          | `int`, `error`         | Parsed; error if missing or not a valid integer           |
| `ParamInt64(key) (int64, error)`      | `int64`, `error`       | Parsed; error if missing or not a valid integer           |

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    id, err := c.ParamInt("id")
    if err != nil {
        return celeris.NewHTTPError(400, "id must be an integer")
    }
    return c.JSON(200, map[string]int{"id": id})
})

s.GET("/posts/:slug", func(c *celeris.Context) error {
    page := c.ParamDefault("slug", "index")
    return c.String(200, "rendering "+page)
})
```

### `FullPath` — the matched pattern

`c.FullPath()` returns the **route pattern** that matched (e.g. `/users/:id`), not
the concrete request path (`celeris/context_request.go:38`). This is exactly what
you want for low-cardinality metric labels and structured-log fields — using the
raw path would explode your label cardinality with one series per `id`.

```go
s.GET("/users/:id", func(c *celeris.Context) error {
    metrics.Inc(c.FullPath()) // "/users/:id", not "/users/42"
    return c.JSON(200, lookup(c.Param("id")))
})
```

`FullPath` returns `""` when no route matched (e.g. inside a custom NotFound
handler).

## Route groups

`Server.Group(prefix, middleware...)` creates a `*RouteGroup` that shares a path
prefix and a middleware stack across many routes (`celeris/server.go:335`). Group
middleware runs **after** server-level middleware but **before** the route's own
handlers.

```go
api := s.Group("/api", requestID)   // prefix "/api", group middleware requestID
api.Use(authMiddleware)             // add more middleware (before any routes)
api.GET("/items", listItems)        // → GET /api/items
api.POST("/items", createItem)      // → POST /api/items
```

`*RouteGroup` exposes the same registration surface as `*Server`: `GET`, `POST`,
`PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `Any`, `Handle`, and `Static`
(`celeris/group.go:77-133`).

### Sub-groups inherit a copy of the parent

`group.Group(prefix, mw...)` nests groups. The child concatenates prefixes and
receives a **copy** of the parent's middleware (so later changes to the parent do
not retroactively affect the child) plus the child's own middleware. The child also
inherits the parent's async/sync setting (`celeris/group.go:137-150`).

```go
api := s.Group("/api")
api.Use(authMiddleware)

v1 := api.Group("/v1")          // prefix "/api/v1", inherits authMiddleware
v1.GET("/users", listUsersV1)   // → GET /api/v1/users, runs authMiddleware
```

### `Use` must precede route registration

Group middleware chains are composed when each route is registered, so `Group.Use`
only affects routes added **after** the call. Add all `Use` calls first, then
register routes (`celeris/group.go:71-74`).

```go
api := s.Group("/api")
api.Use(authMiddleware)   // ✅ before any routes
api.GET("/items", listItems)
// api.Use(metrics)       // ⚠️ would NOT apply to /items above
```

> At the **server** level the same rule is enforced more strictly: `s.Use(...)`
> **panics** if called after any route is registered, to surface the silent
> inconsistency where some routes get the middleware and others don't
> (`celeris/server.go:128-134`). On a group it does not panic — it simply applies
> only going forward — so be deliberate about ordering.

## The `*Route` handle

Every registration returns a `*Route` you can chain configuration onto. All `*Route`
methods must be called before `Start`.

### Naming routes

| Method                    | On duplicate name                         | Source                  |
| ------------------------- | ----------------------------------------- | ----------------------- |
| `Name(name) *Route`       | **panics**: `duplicate route name: …`     | `celeris/router.go:148` |
| `TryName(name) error`     | returns `ErrDuplicateRouteName`           | `celeris/router.go:164` |

Use `Name` when a duplicate is a programming error you want to catch at startup; use
`TryName` when names may legitimately collide (e.g. plugin-registered routes) and
you want to handle it:

```go
s.GET("/users/:id", showUser).Name("user")

if err := s.GET("/posts/:id", showPost).TryName("post"); err != nil {
    if errors.Is(err, celeris.ErrDuplicateRouteName) {
        log.Printf("route name already taken: %v", err)
    }
}
```

### Route-level middleware after registration

`Route.Use` prepends middleware to a single route's chain, inserting it just before
the terminal handler (`celeris/router.go:181`). It panics if the route has no
handlers:

```go
r := s.GET("/admin", adminDashboard)
r.Use(requireAdmin) // requireAdmin now runs before adminDashboard
```

### Dispatch mode: `Async`, `Sync`, `UsesDriver`

By default a handler runs **inline** on the I/O worker — ideal for CPU- or
cache-bound work. For routes that block on I/O, opt into a per-connection dispatch
goroutine so the blocking call doesn't stall the event loop. Precedence is
**route > group > server default** (`Config.AsyncHandlers`).

| Method                  | Effect                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| `Async(opt ...bool)`    | Mark async (no arg = `true`). Overrides group/server default.            |
| `Sync()`                | Force inline. Equivalent to `Async(false)`; reads better at the call site. |
| `UsesDriver()`          | Exactly `Async()`, but signals intent: a route using a Celeris driver.   |

```go
s.GET("/healthz", healthHandler)                  // inline (default)
s.GET("/db", dbHandler).Async()                    // blocking I/O → async
s.GET("/users/:id", getUser).UsesDriver()          // driver round-trip → async

api := s.Group("/api").Async()                     // async for routes added after…
api.GET("/cached", cachedHandler).Sync()           // …opt this one back to inline
```

`UsesDriver` is the recommended marker for routes that call a Celeris
postgres/redis/memcached driver opened `WithEngine(srv)`: such drivers may complete
faster than the adaptive promotion threshold, so an explicit mark guarantees the
handler is dispatched off the worker. Source: `celeris/router.go:205-258`.

For the full dispatch model and `Config.AsyncHandlers`, see [Engines](/docs/engines).

## Reverse URLs

Once a route is named, build a concrete URL from its pattern without hard-coding
strings. There are two builders on `*Server`:

| Method                                    | Param substitution               | Source                  |
| ----------------------------------------- | -------------------------------- | ----------------------- |
| `URL(name, params...) (string, error)`    | positional, in pattern order     | `celeris/server.go:250` |
| `URLMap(name, map) (string, error)`       | by parameter name                | `celeris/server.go:280` |

```go
s.GET("/users/:id/posts/:pid", showPost).Name("post")

u, _ := s.URL("post", "42", "7")
// u == "/users/42/posts/7"   (positional: :id then :pid)

u, _ = s.URLMap("post", map[string]string{"id": "42", "pid": "7"})
// u == "/users/42/posts/7"   (by name, order-independent)
```

For a catch-all segment, pass the remaining path as the value; a duplicated leading
slash is de-duplicated automatically:

```go
s.GET("/files/*path", serveFile).Name("file")
u, _ := s.URL("file", "/img/logo.png") // "/files/img/logo.png"
```

Both builders:

- return `ErrRouteNotFound` if no route with that name exists;
- return an error if a required parameter is missing (and `URL` also errors on the
  **wrong number** of positional params);
- insert values **as-is, without URL encoding** — encode yourself when a value may
  contain reserved characters.

```go
u, err := s.URL("post", "42") // too few params for a two-param route
if errors.Is(err, celeris.ErrRouteNotFound) {
    // unknown name
}
// otherwise err describes the param-count mismatch
```

## Introspection

`Server.Routes()` returns a `[]RouteInfo` describing every registered route, sorted
by method then path for deterministic output (`celeris/server.go:241`). Handy for
startup logging, debug endpoints, or generating an API map.

```go
for _, r := range s.Routes() {
    log.Printf("%-7s %-30s (%d handlers)", r.Method, r.Path, r.HandlerCount)
}
```

`RouteInfo` fields (`celeris/server.go:39-46`):

| Field          | Type     | Description                                                |
| -------------- | -------- | --------------------------------------------------------- |
| `Method`       | `string` | HTTP method, e.g. `"GET"`                                  |
| `Path`         | `string` | The route pattern, e.g. `"/users/:id"`                    |
| `HandlerCount` | `int`    | Total handlers in the chain (middleware + terminal)       |

## Common pitfalls

- **Duplicate method + path silently overwrites.** Registering the same method and
  path twice keeps only the last handler and emits a `WARN` log
  (`celeris: duplicate route registration; previous handler overwritten`). It does
  not panic, so it's easy to miss — watch your logs (`celeris/router.go:520-528`).
- **Never `Sync()` a WebSocket or SSE route.** Handlers that hijack/detach the
  connection are async by construction; forcing them inline breaks them. The same
  warning applies to `Group.Sync()` over such routes
  (`celeris/router.go:236-242`, `celeris/group.go:54-65`).
- **`s.Use(...)` after a route panics.** Move all server-level `Use` calls above
  your first route registration. (Group `Use` does not panic but silently applies
  only going forward.)
- **Catch-all values start with `/`.** Trim it if you're joining the value onto a
  filesystem root yourself. (`Static` already handles this for you.)
- **Reverse URLs are not encoded.** `URL`/`URLMap` insert raw values — encode any
  value that may contain `/`, `?`, `#`, or spaces.

## FAQ

**Does registration order matter for matching?**
No. Specificity (static > param > catch-all) always wins regardless of the order
you register routes in.

**Can two routes share a parameter name at the same position?**
Yes — `/users/:id` and `/users/:id/posts` reuse the same `:id` node. The name only
has to be unique within a single pattern.

**How do I serve a directory of files?**
Use `s.Static(prefix, root)` (or `group.Static`). It registers a catch-all GET route
with built-in path-traversal protection — you don't manage the `*path` parameter
yourself (`celeris/server.go:232-237`).

**What happens on a path match with the wrong method?**
The router returns the set of allowed methods; register a handler with
`s.MethodNotAllowed(...)` to customise the 405 response (the `Allow` header is set
automatically). Define a catch-all for unmatched paths with `s.NotFound(...)`. Both
are covered in [Middleware](/docs/middleware).

## See also

- [Middleware](/docs/middleware) — global, group, and per-route middleware ordering,
  plus `Pre` (pre-routing), `NotFound`, and `MethodNotAllowed`.
- [Engines](/docs/engines) — the async/sync dispatch model and `Config.AsyncHandlers`.
- [Getting started](/docs/getting-started) — install Celeris and write your first
  server.
