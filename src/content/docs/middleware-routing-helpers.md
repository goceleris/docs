---
title: URL rewriting and request preprocessing
description: "Pre-routing middleware: reverse-proxy headers, redirects, regex rewrites, method override, and health checks."
group: Middleware
order: 6
---

Some middleware needs to run *before* the router picks a handler — to canonicalise
a URL, swap an HTML form's tunnelled method for the real one, or answer a
Kubernetes probe without ever touching your routes. Celeris exposes a dedicated
hook for this, `Server.Pre`, and ships four ready-made middleware packages that
plug into it (or, for health checks, into `Server.Use`).

This page covers the request-shaping middleware that lives outside the security
and auth families: `redirect`, `rewrite`, `methodoverride`, and `healthcheck`.
For authentication, CORS, CSRF, rate limiting, and the trusted-proxy middleware,
see [Security middleware](/docs/middleware-security). For the general middleware
model (global, group, per-route ordering), see [Middleware](/docs/middleware).

## Pre-routing vs route middleware

There are two places middleware can run, and the difference matters for
everything on this page.

| Hook                 | Runs                              | Can mutate before routing?                | Source                  |
| -------------------- | --------------------------------- | ----------------------------------------- | ----------------------- |
| `Server.Pre(mw...)`  | **before** route lookup           | yes — method, path, scheme, host          | `celeris/server.go:141` |
| `Server.Use(mw...)`  | after lookup, before the handler  | no — the route is already chosen          | `celeris/server.go:128` |

`Server.Pre` registers **pre-routing** middleware. It executes before the router
resolves the handler chain, so a `Pre` handler may rewrite the request method or
path and the router will then match against the *modified* values
(`celeris/server.go:136-144`). This is exactly what `redirect`, `rewrite`, and
`methodoverride` need: they reshape the request and let routing happen
afterwards.

```go
s := celeris.New(celeris.Config{Addr: ":8080"})

// Pre-routing: runs before the router looks at the request.
s.Pre(redirect.HTTPSRedirect())

// Route middleware: runs after a route is matched.
s.Use(logger)

s.GET("/users/:id", showUser)
```

The mutators these middleware reach for are all on `*Context`:

| Method               | Effect                                          | Source                         |
| -------------------- | ----------------------------------------------- | ------------------------------ |
| `SetMethod(m)`       | overrides the HTTP method seen by the router    | `celeris/context_request.go:27`|
| `SetPath(p)`         | overrides the request path before route lookup  | `celeris/context_request.go:34`|
| `SetScheme(scheme)`  | overrides `Scheme()` (e.g. from a proxy header) | `celeris/context_request.go:411`|
| `SetHost(host)`      | overrides `Host()`                              | `celeris/context_request.go:676`|

### The short-circuit contract

A `Pre` handler has a binary choice on every request:

- **Pass through** — call `return c.Next()` so routing (or the next `Pre`
  handler) proceeds. It may have mutated the method/path first.
- **Short-circuit** — write a response (e.g. `c.Redirect(...)`) and return
  **without** calling `c.Next()`. No routing occurs and the request is
  considered handled (`celeris/server.go:138-140`).

> The rule of thumb: **if a `Pre` handler writes to the response, it must not
> call `Next`.** The redirect middleware follows this exactly — when it issues a
> redirect it returns immediately; otherwise it falls through to `c.Next()`.

`Pre` middleware runs in registration order, and every `Pre` must be registered
before `Start`.

## redirect — URL canonicalisation

The `redirect` package (`github.com/goceleris/celeris/middleware/redirect`)
provides nine constructors for the most common canonicalisation patterns:
forcing HTTPS, normalising the `www.` prefix, and fixing trailing slashes. Each
returns a `celeris.HandlerFunc` you install with `Server.Pre`.

```go
import "github.com/goceleris/celeris/middleware/redirect"

s.Pre(redirect.HTTPSRedirect())
s.Pre(redirect.RemoveTrailingSlashRedirect())
```

### Redirect constructors

These send a `3xx` response and short-circuit (no `Next`) when they fire;
otherwise they pass through. Source: `celeris/middleware/redirect/redirect.go`.

| Constructor                       | Fires when…                         | Redirects to                          |
| --------------------------------- | ----------------------------------- | ------------------------------------- |
| `HTTPSRedirect`                   | scheme is not `https`               | same host/path/query over `https`     |
| `WWWRedirect`                     | host has no `www.` prefix           | `www.` + host                         |
| `NonWWWRedirect`                  | host starts with `www.`             | host without `www.`                   |
| `TrailingSlashRedirect`           | path has no trailing `/` (not root) | path + `/`                            |
| `RemoveTrailingSlashRedirect`     | path ends with `/` (not root)       | path without trailing `/`             |
| `HTTPSWWWRedirect`                | not (`https` **and** `www.`)        | `https://www.` host (single redirect) |
| `HTTPSNonWWWRedirect`             | not (`https` **and** non-`www.`)    | `https://` host w/o `www.` (single)   |

Every constructor **preserves the original query string** (via
`buildRedirectURL`, `celeris/middleware/redirect/redirect.go:30-36`) and skips
the request — passing through to `c.Next()` — when `Host()` returns `""`, to
avoid generating a malformed redirect URL (e.g.
`celeris/middleware/redirect/redirect.go:57-60`).

### In-place rewrite variants

Two constructors normalise the trailing slash **without** sending a redirect —
they call `SetPath` and continue, so the client URL is unchanged and your
handler simply sees the canonical path:

| Constructor                       | Effect (in-place, no redirect)            |
| --------------------------------- | ----------------------------------------- |
| `TrailingSlashRewrite`            | adds trailing `/` via `SetPath`, then `Next` |
| `RemoveTrailingSlashRewrite`      | strips trailing `/` via `SetPath`, then `Next` |

The `*Rewrite` variants accept a `Config` for skip logic (`Skip`/`SkipPaths`)
but never act on `Code`, since they don't send a redirect
(`celeris/middleware/redirect/redirect.go:250-290`). They still validate the
config, so an out-of-range `Code` panics exactly as it would for a redirect
constructor — just leave `Code` unset.

### Config and the 301-vs-308 trap

```go
type Config struct {
    Skip      func(c *celeris.Context) bool // dynamic per-request skip
    SkipPaths []string                       // exact-match paths to skip
    Code      int                            // 301, 302, 303, 307, or 308
}
```

Source: `celeris/middleware/redirect/config.go`.

| Field       | Default | Notes                                                            |
| ----------- | ------- | --------------------------------------------------------------- |
| `Code`      | `301`   | Must be one of `301, 302, 303, 307, 308` — anything else panics. |
| `Skip`      | `nil`   | Return `true` to bypass for a given request.                    |
| `SkipPaths` | `nil`   | Exact path match (no glob/prefix).                              |

**The default `Code` is 301 (Moved Permanently).** Per RFC 7231 §6.4.2, clients
are *allowed to change the request method to GET* when following a 301 (and 302).
That is fine for GET navigation but silently breaks a `POST`/`PUT`/`DELETE`. If
the redirect can fire on a non-GET request, use **308** (Permanent Redirect,
preserves the method) or **307** (the temporary equivalent):

```go
// Preserve the method on redirect (e.g. an API that also forces HTTPS).
s.Pre(redirect.HTTPSRedirect(redirect.Config{Code: 308}))
```

An out-of-range `Code` panics at construction — a deliberate fail-fast:

```text
redirect: Code must be a redirect status (301, 302, 303, 307, 308), got 404
```

Source: `celeris/middleware/redirect/config.go:33-40`.

### A complete redirect example

```go
s := celeris.New(celeris.Config{Addr: ":8080"})

// Force HTTPS + www in one hop, preserving POST/PUT/DELETE, but never on the
// health endpoint (which the load balancer hits over plain HTTP).
s.Pre(redirect.HTTPSWWWRedirect(redirect.Config{
    Code:      308,
    SkipPaths: []string{"/livez", "/readyz"},
}))

s.POST("/checkout", checkout)
```

### Avoiding redirect loops

Conflicting redirects loop forever. Two combinations to never install together:

- `TrailingSlashRedirect` **and** `RemoveTrailingSlashRedirect`
- `WWWRedirect` **and** `NonWWWRedirect`

For "HTTPS *and* a www change", prefer the combined `HTTPSWWWRedirect` /
`HTTPSNonWWWRedirect` constructors over chaining `HTTPSRedirect` with
`WWWRedirect`: the combined form does it in a single hop and sidesteps the
double-redirect (`celeris/middleware/redirect/redirect.go:180-248`).

## rewrite — regex path rewriting

When the trailing-slash and www helpers aren't enough, the `rewrite` package
(`github.com/goceleris/celeris/middleware/rewrite`) matches the request path
against an ordered list of regular-expression rules. Its single constructor is
`New`, and patterns are **compiled once at init** with `regexp.MustCompile`
(`celeris/middleware/rewrite/rewrite.go:24-48`).

```go
import "github.com/goceleris/celeris/middleware/rewrite"

s.Pre(rewrite.New(rewrite.Config{
    Rules: []rewrite.Rule{
        {Pattern: `^/api/v1/(.*)$`, Replacement: "/api/v2/$1"},
    },
}))
```

### Rules

```go
type Rule struct {
    Pattern      string   // Go regexp matched against the path
    Replacement  string   // replacement, supports $1, $2 capture groups
    RedirectCode int      // 0 = silent rewrite; 301/302/303/307/308 = redirect
    Methods      []string // restrict to these methods (empty = all)
    Host         string   // restrict to this exact Host (empty = all)
}
```

Source: `celeris/middleware/rewrite/config.go:9-27`.

| Field          | Behaviour                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `Pattern`      | Go regex. **Anchor with `^…$`** for exact-path matches — otherwise it's a substring match. Empty pattern panics at init. |
| `Replacement`  | Capture groups `$1`, `$2`, … via `regexp.ReplaceAllString` semantics.   |
| `RedirectCode` | Per-rule override of `Config.RedirectCode`. `0` means "use the config-level value". |
| `Methods`      | Case-insensitive method allow-list. Empty matches every method.        |
| `Host`         | Exact `Host` header match. Empty matches every host.                   |

**First match wins.** Rules are evaluated in the order you list them; the first
regex that matches stops the search (`celeris/middleware/rewrite/rewrite.go:61-88`).

### Silent rewrite vs redirect

The `RedirectCode` on the `Config` (and the per-rule override) decides what
happens when a rule matches:

- **`0` (default) — silent rewrite.** The middleware calls `SetPath(newPath)`
  and continues with `c.Next()`. The browser's URL bar is unchanged; only your
  handler sees the rewritten path.
- **`301/302/303/307/308` — redirect.** The middleware builds
  `scheme://host` + the rewritten path (plus `?query` when present) and sends a
  `c.Redirect`, short-circuiting (`celeris/middleware/rewrite/rewrite.go:77-83`).

```go
type Config struct {
    Skip         func(c *celeris.Context) bool
    SkipPaths    []string
    Rules        []Rule
    RedirectCode int // 0 = silent SetPath; otherwise a redirect status
}
```

Source: `celeris/middleware/rewrite/config.go:29-45`.

### A complete rewrite example

```go
s.Pre(rewrite.New(rewrite.Config{
    Rules: []rewrite.Rule{
        // Silently shim legacy GET paths onto the v2 handler (URL unchanged).
        {
            Pattern:     `^/api/v1/(.*)$`,
            Replacement: "/api/v2/$1",
            Methods:     []string{"GET", "HEAD"},
        },
        // Permanently move a public marketing page (visible 308 redirect).
        {
            Pattern:      `^/old-pricing$`,
            Replacement:  "/pricing",
            RedirectCode: 308,
        },
        // Route a single vhost's admin paths internally.
        {
            Pattern:     `^/admin/(.*)$`,
            Replacement: "/internal/$1",
            Host:        "admin.example.com",
        },
    },
}))
```

### Init-time validation

`New` panics (at construction, not per request) if:

- `Rules` is empty — `rewrite: Rules must not be empty`
- any `Pattern` is empty — `rewrite: Rules[i].Pattern must not be empty`
- a `RedirectCode` (config or rule) is non-zero and not a valid redirect status
- a `Pattern` is not a valid regex (surfaced by `regexp.MustCompile`)

Source: `celeris/middleware/rewrite/config.go:55-79`.

## methodoverride — tunnelling PUT/PATCH/DELETE through POST

HTML forms can only emit `GET` and `POST`. The `methodoverride` package
(`github.com/goceleris/celeris/middleware/methodoverride`) lets a client tunnel
a real method (`PUT`, `PATCH`, `DELETE`, …) through a POST by declaring it in a
form field or header. The middleware reads that value and calls `SetMethod`
*before* routing.

> **Install with `Server.Pre`, never `Server.Use`.** With `Use`, the router has
> already matched on the original `POST`, so the override has no effect on
> routing — and it does so silently. The package documents this explicitly
> (`celeris/middleware/methodoverride/doc.go:8-13`).

```go
import "github.com/goceleris/celeris/middleware/methodoverride"

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Pre(methodoverride.New())

// Now an HTML form posting _method=DELETE routes to the DELETE handler.
s.DELETE("/users/:id", deleteUser)
```

### How a request is rewritten

On each request the middleware (`celeris/middleware/methodoverride/methodoverride.go:34-58`):

1. Skips if `Skip`/`SkipPaths` says so.
2. Checks the original method is in `AllowedMethods` (default: just `POST`).
3. Reads the override value via the `Getter`.
4. Rewrites with `SetMethod` only if the override (upper-cased) is in
   `TargetMethods`. **Values outside `TargetMethods` are silently ignored**, so a
   client cannot tunnel itself into `CONNECT` or `TRACE`.

### Config

```go
type Config struct {
    Skip           func(c *celeris.Context) bool
    SkipPaths      []string
    AllowedMethods []string // original methods eligible for override
    TargetMethods  []string // methods allowed as override targets
    Getter         func(c *celeris.Context) string // where to read the override
}
```

Source: `celeris/middleware/methodoverride/config.go:17-40`.

| Field            | Default                         | Notes                                              |
| ---------------- | ------------------------------- | -------------------------------------------------- |
| `AllowedMethods` | `["POST"]`                      | Only these original methods are eligible.          |
| `TargetMethods`  | `["PUT", "DELETE", "PATCH"]`    | Override allow-list; others ignored.               |
| `Getter`         | form `_method`, then header     | See getters below.                                 |
| `Skip`/`SkipPaths`| `nil`                          | Standard skip controls.                            |

`AllowedMethods` and `TargetMethods` must not contain empty/whitespace-only
strings — the middleware panics at init if they do
(`celeris/middleware/methodoverride/config.go:61-72`).

### Getters: where the override comes from

The default getter checks the **form field `_method`** first, then the header
**`X-HTTP-Method-Override`** — that order lets plain HTML forms (which can't set
custom headers) drive the override with no JavaScript
(`celeris/middleware/methodoverride/config.go:79-87`). The package also exports
the constants `methodoverride.DefaultFormField` (`"_method"`) and
`methodoverride.DefaultHeader` (`"X-HTTP-Method-Override"`).

Swap the source with one of the getter factories:

| Getter                                  | Reads from                                  |
| --------------------------------------- | ------------------------------------------- |
| *(default)*                             | form `_method`, then header `X-HTTP-Method-Override` |
| `HeaderGetter(name)`                    | the named header only                       |
| `FormFieldGetter(field)`                | the named form field only                   |
| `FormThenHeaderGetter(field, header)`   | the named form field, then the named header |
| `QueryGetter(param)`                    | the named **query parameter** — see warning |

Source: `celeris/middleware/methodoverride/config.go:89-126`.

```go
// API clients send the method in a header only.
s.Pre(methodoverride.New(methodoverride.Config{
    Getter: methodoverride.HeaderGetter("X-Method"),
}))
```

> **`QueryGetter` is CSRF-risky.** Query parameters are embeddable in links and
> images — `<img src="/users/42?_method=DELETE">` can trigger a destructive
> override across sites. The package provides it for parity with other
> frameworks but documents the risk explicitly; prefer `HeaderGetter` for API
> clients (`celeris/middleware/methodoverride/config.go:118-126`).

### Interaction with CSRF

Method override changes the method *before* CSRF middleware runs. Make sure the
overridden targets (`PUT`, `DELETE`, `PATCH`) are **not** in your CSRF
middleware's safe-methods list, or the protection is bypassed
(`celeris/middleware/methodoverride/doc.go:72-76`, "CSRF Middleware
Interaction"). See [Security middleware](/docs/middleware-security).

## healthcheck — Kubernetes-style probes

The `healthcheck` package
(`github.com/goceleris/celeris/middleware/healthcheck`) answers liveness,
readiness, and startup probes. It intercepts **`GET`/`HEAD`** requests to the
configured probe paths and returns a small JSON status, passing every other
request straight through (`celeris/middleware/healthcheck/healthcheck.go:66-91`).

> Unlike the other middleware on this page, install `healthcheck` with
> **`Server.Use`** (it is route middleware, not pre-routing), and install it
> **first** so probes are answered before any heavier middleware runs. The
> package's own examples use `server.Use(healthcheck.New())`
> (`celeris/middleware/healthcheck/doc.go:10`).

```go
import "github.com/goceleris/celeris/middleware/healthcheck"

s := celeris.New(celeris.Config{Addr: ":8080"})
s.Use(healthcheck.New())   // install first
s.Use(logger)              // everything else after
s.GET("/users/:id", showUser)
```

### Probe paths

| Probe     | Field       | Default        | Constant                       |
| --------- | ----------- | -------------- | ------------------------------ |
| Liveness  | `LivePath`  | `/livez`       | `healthcheck.DefaultLivePath`  |
| Readiness | `ReadyPath` | `/readyz`      | `healthcheck.DefaultReadyPath` |
| Startup   | `StartPath` | `/startupz`    | `healthcheck.DefaultStartPath` |

Set any path to the **empty string `""` to disable that probe**
(`celeris/middleware/healthcheck/config.go:94`). Enabled paths must start with
`/`, and no two enabled probes may share a path — both are init-time panics
(`celeris/middleware/healthcheck/config.go:111-137`).

### Checkers

Each probe has a `Checker func(c *celeris.Context) bool`. Return `true` for
healthy (`200`), `false` for unhealthy (`503`). All three default to
always-`true` (`celeris/middleware/healthcheck/config.go:42-52`).

```go
type Config struct {
    Skip           func(c *celeris.Context) bool
    SkipPaths      []string
    LivePath       string
    ReadyPath      string
    StartPath      string
    LiveChecker    Checker
    ReadyChecker   Checker
    StartChecker   Checker
    CheckerTimeout time.Duration
}
```

Source: `celeris/middleware/healthcheck/config.go:21-67`.

```go
s.Use(healthcheck.New(healthcheck.Config{
    // Liveness stays trivial — the process is up if it can answer.
    // Readiness gates traffic on dependencies being reachable.
    ReadyChecker: func(c *celeris.Context) bool {
        return db.PingContext(c.Context()) == nil
    },
    // Startup flips to true once warm-up finishes.
    StartChecker: func(_ *celeris.Context) bool {
        return atomic.LoadInt32(&warmedUp) == 1
    },
}))
```

The `*Context` is passed in so a checker can honour the request deadline (e.g.
`db.PingContext(c.Context())`).

### Timeouts: `CheckerTimeout` and the fast path

| `CheckerTimeout` value          | Behaviour                                                            |
| ------------------------------- | ------------------------------------------------------------------- |
| `0`                             | Use the default — `healthcheck.DefaultCheckerTimeout` (`5s`).        |
| positive duration               | Run the checker with that deadline; if it doesn't return, respond `503`. |
| `healthcheck.FastPathTimeout`   | Run the checker **synchronously inline** — no goroutine/channel/context overhead. Use only for trivial checkers that cannot block. |

Source: `celeris/middleware/healthcheck/config.go:54-75`. A checker that
**panics** is recovered and treated as a failure (`503`), so a bad probe never
crashes the server (`celeris/middleware/healthcheck/healthcheck.go:154-161`).

```go
s.Use(healthcheck.New(healthcheck.Config{
    ReadyChecker:   readyCheck,
    CheckerTimeout: 2 * time.Second, // fail readiness fast under load
}))
```

> Trivial built-in (always-true) checkers are automatically run on the fast
> path regardless of `CheckerTimeout`, since the timeout machinery would be pure
> overhead for a check that can't block
> (`celeris/middleware/healthcheck/healthcheck.go:32-61`). You only need to set
> `FastPathTimeout` yourself when you supply your own cheap, non-blocking
> checker.

### Response shape

| Request           | Healthy                          | Unhealthy                                  |
| ----------------- | -------------------------------- | ------------------------------------------ |
| `GET /readyz`     | `200` `{"status":"ok"}`          | `503` `{"status":"unavailable"}`           |
| `HEAD /readyz`    | `200`, empty body                | `503`, empty body                          |

Content type is `application/json`. `HEAD` returns the status code with no body
(`celeris/middleware/healthcheck/healthcheck.go:163-174`).

### Wiring to Kubernetes probes

The default paths map directly onto the three probe kinds:

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
startupProbe:
  httpGet: { path: /startupz, port: 8080 }
```

`livez` should be cheap and stay `true` as long as the process can serve;
restarting on a false liveness is drastic. Put dependency checks (DB, cache,
downstream services) behind `readyz`, which only removes the pod from the
Service's endpoints. For probe tuning and rollout shapes, see
[Deployment](/docs/deployment).

## Common pitfalls

- **Registering pre-routing middleware with `Use`.** `redirect`, `rewrite`, and
  `methodoverride` must go through `Server.Pre`. With `Use`, the router has
  already matched on the original method/path, so mutating it does nothing — and
  fails silently. (`healthcheck` is the exception: it *is* `Use` middleware.)
- **Default 301 on a non-GET redirect.** A 301/302 lets clients downgrade the
  method to GET. Use `Code: 308` (or `307`) whenever a redirect can fire on
  `POST`/`PUT`/`DELETE`.
- **Unanchored rewrite patterns.** `Pattern: "/api"` is a *substring* match and
  will also catch `/api-docs` or `/v2/api`. Anchor with `^/api$` (or
  `^/api/(.*)$`) for exact-path intent.
- **Redirect loops.** Don't pair `TrailingSlashRedirect` with
  `RemoveTrailingSlashRedirect`, or `WWWRedirect` with `NonWWWRedirect`. For
  HTTPS + www, use the combined constructors.
- **HTTPS redirect loop behind a proxy.** A TLS-terminating proxy speaks plain
  HTTP to your backend, so `Scheme()` returns `"http"` and `HTTPSRedirect`
  redirects forever. Install the trusted-proxy middleware (which sets the scheme
  from `X-Forwarded-Proto`) via `Server.Pre` **before** the redirect — see
  [Security middleware](/docs/middleware-security).
- **`QueryGetter` and CSRF.** Query-based method override is embeddable in links
  and images; avoid it for any state-changing route.
- **Probe paths that collide with routes.** `healthcheck` intercepts its paths
  before routing reaches your handlers; if you also register a route at `/readyz`
  it will never be hit unless you disable that probe (set its path to `""`).

## FAQ

**Should redirects keep the query string?** Yes — every `redirect` constructor
and `rewrite` redirect preserves the original query string automatically.

**Silent rewrite or redirect for moving a public URL?** Use a **redirect**
(`308` for permanence) so clients and search engines update their links. Use a
**silent rewrite** (`RedirectCode: 0`, i.e. `SetPath`) when the move is internal
and the client URL should stay the same.

**Does `methodoverride` let a client request any method?** No. Only values in
`TargetMethods` (default `PUT`, `DELETE`, `PATCH`) are honoured; anything else is
ignored. And only original methods in `AllowedMethods` (default `POST`) are
eligible to be overridden at all.

**How do I exclude the health endpoint from an HTTPS redirect?** Pass its path in
`Config.SkipPaths`, e.g.
`redirect.HTTPSRedirect(redirect.Config{SkipPaths: []string{"/livez"}})`.

**Why does `rewrite.New` panic at startup?** It compiles every regex once at init
and validates the config eagerly — empty `Rules`, an empty `Pattern`, a bad
`RedirectCode`, or an invalid regex all fail loudly at construction rather than
mis-routing at runtime.

## See also

- [Middleware](/docs/middleware) — the global/group/per-route model, plus `Pre`,
  `NotFound`, and `MethodNotAllowed`.
- [Security middleware](/docs/middleware-security) — auth, CORS, CSRF, rate
  limiting, and the trusted-proxy middleware that sets the scheme/host.
- [Routing](/docs/routing) — how patterns match after a `Pre` handler has
  reshaped the request.
- [Deployment](/docs/deployment) — wiring `healthcheck` paths to Kubernetes
  liveness/readiness/startup probes.
