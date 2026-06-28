---
title: Security middleware
description: Security headers, CORS, CSRF protection, and reverse-proxy header trust.
group: Middleware
order: 2
---

Celeris ships four hardening middlewares under `github.com/goceleris/celeris/middleware`,
each in its own package with a single `New(...Config) HandlerFunc` constructor:

| Package  | Import path                                       | What it does                                          |
| -------- | ------------------------------------------------ | ----------------------------------------------------- |
| `secure` | `github.com/goceleris/celeris/middleware/secure` | Emits OWASP-recommended security response headers     |
| `cors`   | `github.com/goceleris/celeris/middleware/cors`   | Cross-Origin Resource Sharing, including preflight    |
| `csrf`   | `github.com/goceleris/celeris/middleware/csrf`   | Cross-Site Request Forgery protection (double-submit) |
| `proxy`  | `github.com/goceleris/celeris/middleware/proxy`  | Trusts forwarded headers from known reverse proxies   |

All four follow the same conventions: pass **zero** `Config` values to get safe
defaults, or pass **exactly one** to override. Every constructor validates its
configuration eagerly and **panics at `New(...)`** on a misconfiguration, so a bad
setup fails at startup rather than silently weakening protection at request time.

Install them with `s.Use(...)` (the global chain) or as group/route middleware —
see [Middleware](/docs/middleware) for chain ordering. The one exception is
`proxy`, which must run **pre-routing** with `s.Pre(...)`; this is explained in its
section below. Ordering between the security middlewares matters and is called out
where relevant.

```go
import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/secure"
    "github.com/goceleris/celeris/middleware/cors"
    "github.com/goceleris/celeris/middleware/csrf"
    "github.com/goceleris/celeris/middleware/proxy"
)

s := celeris.New(celeris.Config{Addr: ":8080"})

s.Pre(proxy.New(proxy.Config{TrustedProxies: []string{"10.0.0.0/8"}})) // pre-routing
s.Use(secure.New())                                                    // security headers
s.Use(cors.New())                                                      // CORS (before auth)
// ... your auth middleware ...
s.Use(csrf.New())                                                      // CSRF (after auth)
```

---

## `secure` — security headers

`secure.New()` with no arguments installs a conservative, modern set of security
headers on every response. Source: `celeris/middleware/secure/secure.go`,
`celeris/middleware/secure/config.go`.

```go
s.Use(secure.New()) // sensible defaults, no config needed
```

### Default headers

These are emitted by default on every response (HSTS is conditional — see below):

| Header                              | Default value                       | Field                         |
| ----------------------------------- | ----------------------------------- | ----------------------------- |
| `X-Content-Type-Options`            | `nosniff`                           | `XContentTypeOptions`         |
| `X-Frame-Options`                   | `SAMEORIGIN`                        | `XFrameOptions`               |
| `X-XSS-Protection`                  | `0`                                 | `XSSProtection`               |
| `Referrer-Policy`                   | `strict-origin-when-cross-origin`   | `ReferrerPolicy`              |
| `Cross-Origin-Opener-Policy`        | `same-origin`                       | `CrossOriginOpenerPolicy`     |
| `Cross-Origin-Resource-Policy`      | `same-origin`                       | `CrossOriginResourcePolicy`   |
| `X-DNS-Prefetch-Control`            | `off`                               | `XDNSPrefetchControl`         |
| `X-Permitted-Cross-Domain-Policies` | `none`                              | `XPermittedCrossDomain`       |
| `Origin-Agent-Cluster`             | `?1`                                | `OriginAgentCluster`          |
| `Strict-Transport-Security`         | `max-age=63072000; includeSubDomains` | `HSTSMaxAge` (2 years)      |

`X-XSS-Protection` defaults to `0` on purpose: the legacy XSS auditor is disabled
per modern best practice (it could itself be abused). Rely on a Content-Security-Policy
instead (see below).

### Opt-in headers (off by default)

These ship empty and are only emitted when you set them:

| Header                        | Field                       | Notes                                                                                          |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`     | `ContentSecurityPolicy`     | The single most effective XSS defense; opt-in because policies are app-specific.                |
| `Permissions-Policy`          | `PermissionsPolicy`         | Gates browser features (camera, geolocation, …).                                               |
| `Cross-Origin-Embedder-Policy`| `CrossOriginEmbedderPolicy` | `require-corp`/`credentialless`. Off by default — `require-corp` breaks cross-origin resources. |
| `X-Download-Options`          | `XDownloadOptions`          | `noopen`. Legacy IE-only and obsolete; opt-in only.                                            |

```go
s.Use(secure.New(secure.Config{
    ContentSecurityPolicy: "default-src 'self'; img-src 'self' data:",
    PermissionsPolicy:     "geolocation=(), camera=()",
}))
```

To deliver a CSP in report-only mode (collect violations without enforcing), set
`CSPReportOnly: true` alongside a non-empty `ContentSecurityPolicy`. The header
key switches to `Content-Security-Policy-Report-Only`. Setting `CSPReportOnly`
without a policy — or with `ContentSecurityPolicy: secure.Suppress` (a no-op) —
**panics** at `New(...)`.

```go
s.Use(secure.New(secure.Config{
    ContentSecurityPolicy: "default-src 'self'; report-uri /csp-report",
    CSPReportOnly:         true, // observe first, enforce later
}))
```

### HSTS

`Strict-Transport-Security` is special: it is **only sent over HTTPS** connections.
The middleware checks `c.Scheme() == "https"` per request and omits the header on
plain HTTP, so an HSTS policy is never advertised over an insecure channel. (Behind
a TLS-terminating proxy, scheme detection depends on the `proxy` middleware setting
the scheme from `X-Forwarded-Proto` — see the proxy section.)

| Field                   | Type   | Default      | Effect                                                              |
| ----------------------- | ------ | ------------ | ------------------------------------------------------------------ |
| `HSTSMaxAge`            | `int`  | `63072000`   | `max-age` in seconds (2 years).                                     |
| `DisableHSTS`           | `bool` | `false`      | Omit the header entirely.                                           |
| `HSTSExcludeSubdomains` | `bool` | `false`      | When `false`, `includeSubDomains` is appended (the default).        |
| `HSTSPreload`           | `bool` | `false`      | Appends `preload` (for the browser preload list).                  |

```go
s.Use(secure.New(secure.Config{
    HSTSMaxAge:   31536000, // 1 year
    HSTSPreload:  true,      // eligible for the preload list
}))
// → Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

`New(...)` **panics** if `HSTSPreload` is set with `HSTSMaxAge < 31536000` (one year),
or if `HSTSPreload` is combined with `HSTSExcludeSubdomains` — both violate the
browser preload-list requirements, so the checks catch the mistake at startup.

### Omitting a single default header: the `Suppress` sentinel

Setting a header field to the empty string does **not** remove it — the empty value
is replaced by the default. To explicitly drop a header that is on by default, set
its field to `secure.Suppress` (the sentinel `"-"`):

```go
s.Use(secure.New(secure.Config{
    XFrameOptions: secure.Suppress, // omit X-Frame-Options entirely
}))
```

This distinction matters: `""` means "use the default", `secure.Suppress` means
"emit nothing for this header".

### Skipping requests

Both `Skip func(c *celeris.Context) bool` and `SkipPaths []string` (exact path
match) bypass the middleware. This pattern is shared by all four packages.

```go
s.Use(secure.New(secure.Config{
    SkipPaths: []string{"/healthz", "/metrics"},
}))
```

### Loading from a config file

Every `secure.Config` field carries a `yaml` tag, so the config can be unmarshalled
from a YAML file (e.g. with `gopkg.in/yaml.v3`) and passed straight to `New`. The
tags use snake_case, e.g. `x_frame_options`, `hsts_max_age`, `content_security_policy`,
`hsts_preload`. The `Skip` function field is tagged `yaml:"-"` (skipped).

```yaml
# secure.yaml
x_frame_options: DENY
hsts_max_age: 31536000
hsts_preload: true
content_security_policy: "default-src 'self'"
```

### Note on header injection

Header values are validated **once at `New(...)`**: a CR, LF, or NUL byte in any
configured value **panics** immediately (it would otherwise enable header injection).
Keep configured values free of control characters.

---

## `cors` — Cross-Origin Resource Sharing

`cors.New()` answers preflight `OPTIONS` requests and decorates cross-origin
responses with `Access-Control-*` headers. Source: `celeris/middleware/cors/cors.go`,
`celeris/middleware/cors/config.go`.

```go
s.Use(cors.New()) // defaults: AllowOrigins ["*"], standard methods/headers
```

### Defaults

| Field          | Default                                                       |
| -------------- | ------------------------------------------------------------ |
| `AllowOrigins` | `["*"]` (any origin)                                          |
| `AllowMethods` | `GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS`               |
| `AllowHeaders` | `Origin, Content-Type, Accept, Authorization`               |
| `MaxAge`       | `0` (no preflight cache)                                      |

### Allowed origins

`AllowOrigins` accepts three kinds of entry:

- **`"*"`** — allow any origin. The response echoes `Access-Control-Allow-Origin: *`.
- **An exact origin** — e.g. `"https://app.example.com"`. The scheme and host are
  matched case-insensitively; entries with a path, query, or fragment are invalid.
- **A single-`*` subdomain wildcard** — e.g. `"https://*.example.com"`. This matches
  `https://sub.example.com` but **not** `https://a.b.example.com` (the wildcard spans
  exactly one label by default) and **not** the bare apex `https://example.com`.

A pattern with **more than one `*`** **panics** at `New(...)`.

```go
s.Use(cors.New(cors.Config{
    AllowOrigins: []string{
        "https://app.example.com",   // exact
        "https://*.example.com",     // one-level subdomain wildcard
    },
    AllowMethods: []string{"GET", "POST", "PUT", "DELETE"},
    AllowHeaders: []string{"Content-Type", "Authorization", "X-CSRF-Token"},
    MaxAge:       3600, // cache preflight for 1 hour
}))
```

For dynamic decisions, two callback fields run **after** the static and wildcard
checks (and cannot be combined with a `"*"` entry — doing so **panics**):

| Field                    | Signature                                          | When to use                              |
| ------------------------ | -------------------------------------------------- | ---------------------------------------- |
| `AllowOriginsFunc`       | `func(origin string) bool`                         | Origin-only logic (e.g. a tenant table). |
| `AllowOriginRequestFunc` | `func(c *celeris.Context, origin string) bool`     | Decisions needing the full request.      |

Both callbacks only receive origins that already look like a serialized origin
(scheme + host, no path/query/fragment/userinfo); malformed values are rejected
before your function runs.

```go
s.Use(cors.New(cors.Config{
    AllowOrigins: []string{"https://app.example.com"}, // no "*" allowed alongside funcs
    AllowOriginRequestFunc: func(c *celeris.Context, origin string) bool {
        return tenantAllowsOrigin(c.Header("x-tenant-id"), origin)
    },
}))
```

### Credentials

To let the browser send cookies/credentials on cross-origin requests, set
`AllowCredentials: true`. The CORS spec forbids credentials with a wildcard origin,
and Celeris enforces this with **panics** at `New(...)`:

- `AllowCredentials` + `AllowOrigins` containing `"*"` → **panics** (always invalid).
- `AllowCredentials` + a subdomain wildcard like `"https://*.example.com"` → **panics**,
  unless you also set `UnsafeAllowCredentialsWithWildcard: true`. This combination is
  spec-compliant (the browser receives the echoed concrete origin, not `*`) but widens
  the credential scope to every matching subdomain — only enable it deliberately.

```go
s.Use(cors.New(cors.Config{
    AllowOrigins:     []string{"https://app.example.com"},
    AllowCredentials: true, // browser may send cookies
}))
```

### Other fields

| Field                  | Type       | Effect                                                                                       |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `ExposeHeaders`        | `[]string` | Sets `Access-Control-Expose-Headers` so JS can read non-safelisted response headers.         |
| `MirrorRequestHeaders` | `bool`     | Reflect `Access-Control-Request-Headers` back instead of a fixed `AllowHeaders` list.        |
| `MaxAge`               | `int`      | Preflight cache seconds. `0` = no cache header; a negative value sends `0`.                   |
| `AllowPrivateNetwork`  | `bool`     | Honor the Private Network Access spec (`Access-Control-Allow-Private-Network` on preflight).  |
| `Skip` / `SkipPaths`   | —          | Bypass CORS for matching requests.                                                            |

### `Vary: Origin` and caching

When you configure specific origins (anything other than `"*"`), the middleware adds
`Vary: Origin` to responses so intermediate caches never serve a CORS-decorated
response to a different origin (or a bare response to a cross-origin request).
Preflight responses get a combined `Vary` covering the request-method and
request-headers as well. You don't manage this header yourself.

### Install CORS *before* auth

Browsers send the preflight `OPTIONS` request **without** credentials. If an auth
middleware runs before CORS, it will reject the unauthenticated preflight and the
real request never happens. Always install `cors.New()` **before** any
authentication/authorization middleware so the preflight is answered with `204` and
the correct headers:

```go
s.Use(cors.New(corsCfg)) // ✅ answers OPTIONS preflight first
s.Use(authMiddleware)     // runs only on the real, post-preflight request
```

---

## `csrf` — Cross-Site Request Forgery protection

`csrf.New()` implements the **double-submit cookie** pattern: it sets a random token
in a cookie on safe requests, and on unsafe requests (POST/PUT/PATCH/DELETE) it
requires a matching token in a header/form/query field. Tokens are compared in
constant time. Source: `celeris/middleware/csrf/csrf.go`,
`celeris/middleware/csrf/config.go`.

```go
s.Use(csrf.New())
```

### Two modes

| Mode                       | When                | How it validates                                                          |
| -------------------------- | ------------------- | ------------------------------------------------------------------------ |
| **Double-submit cookie**   | `Storage` is `nil`  | Request token must equal the cookie token (constant-time compare).        |
| **Server-side (stateful)** | `Storage` is set    | Token is persisted in the backend; the request token is matched against the stored value. |

In server-side mode, set `SingleUseToken: true` to delete the token from storage
after one successful validation (a fresh token is issued on the next safe request) —
useful for sensitive one-shot operations. `SingleUseToken` **requires** `Storage`
(else **panics**). Backends implementing atomic get-and-delete provide TOCTOU-safe
single use; others fall back to a non-atomic Get+Delete.

```go
import "github.com/goceleris/celeris/middleware/store"

s.Use(csrf.New(csrf.Config{
    Storage:        myKVStore,     // implements store.KV
    SingleUseToken: true,          // one-time tokens
    Expiration:     30 * time.Minute,
}))
```

### Where the token is read from

`TokenLookup` is a `"source:name"` string. **Valid sources are `header`, `form`, and
`query`** — comma-separate several and the first non-empty match wins. The default is
`header:X-CSRF-Token`.

```go
// Accept the token from a header OR a form field.
s.Use(csrf.New(csrf.Config{
    TokenLookup: "header:X-CSRF-Token,form:_csrf",
}))
```

> **`cookie` is not a valid source.** Reading the token from the same cookie that
> holds it would make the two values always identical and defeat double-submit
> entirely, so a `cookie:` source **panics** at `New(...)`. So does any malformed
> lookup (missing name, or an unknown source).

### Reading the token in handlers

Use `csrf.TokenFromContext(c)` to fetch the current token for embedding into forms
or returning to a SPA. It returns `""` if the middleware didn't run for this request
(e.g. a skipped path).

```go
s.GET("/form", func(c *celeris.Context) error {
    token := csrf.TokenFromContext(c)
    return c.HTML(200, `<input type="hidden" name="_csrf" value="`+token+`">`)
})
```

For logout flows in server-side mode, `csrf.DeleteToken(c)` removes the stored token
and expires the cookie (returns `csrf.ErrTokenNotFound` if there is no token).

### Cookie attributes

| Field            | Type               | Default                    | Notes                                                          |
| ---------------- | ------------------ | -------------------------- | ------------------------------------------------------------- |
| `CookieName`     | `string`           | `_csrf`                    | Name of the CSRF cookie.                                       |
| `CookiePath`     | `string`           | `/`                        |                                                              |
| `CookieDomain`   | `string`           | (unset)                    |                                                              |
| `CookieMaxAge`   | `int`              | `86400` (24h)              | `0` = session cookie (cleared on browser close).              |
| `CookieSecure`   | `bool`             | `false`                    | Auto-forced to `true` when the request is HTTPS.              |
| `CookieHTTPOnly` | `bool`             | always `true`              | Enforced — CSRF cookies must never be JS-readable.            |
| `CookieSameSite` | `celeris.SameSite` | `celeris.SameSiteLaxMode`  | Use `SameSiteStrictMode` / `SameSiteNoneMode` as needed.      |

`New(...)` **panics** if `CookieSameSite` is `celeris.SameSiteNoneMode` while
`CookieSecure` is `false` (browsers reject `SameSite=None` without `Secure`). Note
that even when you set `CookieHTTPOnly: false` it is overridden back to `true` — this
is a security invariant, not a preference.

### Token generation and context key

| Field          | Type            | Default        | Notes                                                                       |
| -------------- | --------------- | -------------- | --------------------------------------------------------------------------- |
| `TokenLength`  | `int`           | `32`           | Random bytes per token; the hex-encoded string is twice this. **`> 32` panics at `New(...)`.** |
| `KeyGenerator` | `func() string` | (built-in)     | Override the default hex token generator (e.g. to inject a custom RNG).      |
| `ContextKey`   | `string`        | `csrf_token`   | Context store key the token is written under; read it with `TokenFromContext`. |

### Safe methods, origin checks, and trusted origins

By default `GET`, `HEAD`, `OPTIONS`, and `TRACE` are treated as **safe** (no token
required) and issue/refresh the cookie. Override with `SafeMethods`.

On unsafe methods the middleware also performs defense-in-depth origin verification
**before** comparing tokens:

- A `Sec-Fetch-Site: cross-site` request is rejected (`csrf.ErrSecFetchSite`).
- If an `Origin` header is present, it must match the request `Host` or an entry in
  `TrustedOrigins` (else `csrf.ErrOriginMismatch`).
- On HTTPS with **no** `Origin`, the `Referer` header is required and must match
  (else `csrf.ErrRefererMissing` / `csrf.ErrRefererMismatch`).

`TrustedOrigins` lists additional cross-origin allowlist entries — full origins
(`"https://app.example.com"`) or one-level subdomain wildcards (`"https://*.example.com"`).
A wildcard entry **must** use the `https://` scheme or `New(...)` **panics**. An empty
list means same-origin only.

```go
s.Use(csrf.New(csrf.Config{
    TrustedOrigins: []string{"https://app.example.com", "https://*.example.com"},
}))
```

### Sentinel errors

The middleware returns typed `*celeris.HTTPError` sentinels you can match with
`errors.Is`, or intercept with a custom `ErrorHandler func(c, err) error`:

| Sentinel                | Code | Cause                                                |
| ----------------------- | ---- | ---------------------------------------------------- |
| `csrf.ErrMissingToken`  | 403  | Token absent from cookie or request source.          |
| `csrf.ErrForbidden`     | 403  | Token mismatch (or invalid cookie value).            |
| `csrf.ErrOriginMismatch`| 403  | `Origin` does not match host or a trusted origin.    |
| `csrf.ErrRefererMissing`| 403  | HTTPS request with no `Origin` and no `Referer`.     |
| `csrf.ErrRefererMismatch`| 403 | `Referer` does not match host or a trusted origin.   |
| `csrf.ErrSecFetchSite`  | 403  | `Sec-Fetch-Site: cross-site`.                        |
| `csrf.ErrTokenNotFound` | 404  | `DeleteToken` called with no token present.           |

```go
s.Use(csrf.New(csrf.Config{
    ErrorHandler: func(c *celeris.Context, err error) error {
        if errors.Is(err, csrf.ErrMissingToken) {
            return c.JSON(403, map[string]string{"error": "csrf token required"})
        }
        return err
    },
}))
```

### Install CSRF *after* auth

CSRF binds to the authenticated session, so it should run **after** authentication
(and after CORS). A typical chain:

```go
s.Use(cors.New(corsCfg)) // before auth — answers preflight
s.Use(authMiddleware)     // establishes the session
s.Use(csrf.New(csrfCfg))  // after auth — protects state-changing requests
```

---

## `proxy` — trusting reverse-proxy headers (pre-routing)

When Celeris runs behind a load balancer or reverse proxy (nginx, an ALB, Cloudflare),
the TCP peer is the *proxy*, not the client. `proxy.New()` rewrites the request's
client IP, scheme, and host from forwarded headers — **but only when the immediate
peer is a trusted proxy**. Source: `celeris/middleware/proxy/proxy.go`,
`celeris/middleware/proxy/config.go`.

Install it with `s.Pre(...)` so it runs **before routing**: downstream routing,
rate-limiting, logging, and your handlers should all observe the corrected
`c.ClientIP()`, `c.Scheme()`, and `c.Host()`.

```go
s.Pre(proxy.New(proxy.Config{
    TrustedProxies: []string{"10.0.0.0/8", "172.16.0.0/12"},
}))
```

### Why this middleware exists

`X-Forwarded-For` and friends are **client-controllable** — anyone can send them.
If you trust them unconditionally, an attacker spoofs any client IP, defeating
IP-based rate limiting, allow/deny lists, and audit logs. The proxy middleware only
honors forwarded headers when the connection's actual peer IP falls within
`TrustedProxies`, and it walks the `X-Forwarded-For` chain right-to-left, skipping
trusted hops to land on the real client. The result is written via
`c.SetClientIP(...)`, which `c.ClientIP()` then returns.

### Configuration

| Field                   | Type       | Default                          | Effect                                                                                          |
| ----------------------- | ---------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `TrustedProxies`        | `[]string` | `nil`                            | CIDRs or bare IPs whose forwarded headers are trusted. **Empty ⇒ the middleware is a no-op.**   |
| `TrustedHeaders`        | `[]string` | `["x-forwarded-for","x-real-ip"]`| Which headers to read the client IP from.                                                       |
| `DisableForwardedProto` | `bool`     | `false`                          | When `false`, `X-Forwarded-Proto` overrides `c.Scheme()`.                                       |
| `DisableForwardedHost`  | `bool`     | `false`                          | When `false`, `X-Forwarded-Host` overrides `c.Host()`.                                          |
| `Skip` / `SkipPaths`    | —          | —                                | Bypass for matching requests.                                                                   |

Bare IPs in `TrustedProxies` are expanded to `/32` (IPv4) or `/128` (IPv6). Invalid
CIDR/IP entries **panic** at `New(...)`.

`x-forwarded-for` and `x-real-ip` have built-in handling: `x-forwarded-for` is walked
right-to-left skipping trusted hops, while `x-real-ip` is parsed as a single IP. Any
other entry in `TrustedHeaders` (e.g. `cf-connecting-ip`) is also treated as a
single-value IP header — its value is parsed as an IP address and used only if valid.
Header names are matched case-insensitively (lowercased at init):

```go
s.Pre(proxy.New(proxy.Config{
    TrustedProxies: []string{"173.245.48.0/20"}, // your CDN's egress range
    TrustedHeaders: []string{"cf-connecting-ip"},
}))
```

`X-Forwarded-Proto` is only accepted when it is exactly `http` or `https`;
`X-Forwarded-Host` is validated against header-injection and path-traversal
characters before it is applied. Honoring `X-Forwarded-Proto` is what lets the
`secure` middleware correctly send HSTS behind a TLS-terminating proxy (since HSTS is
gated on `c.Scheme() == "https"`).

### Over-broad trust is a vulnerability

Only list the networks your proxies actually originate from. Trusting `0.0.0.0/0`
(everything) is equivalent to trusting client-supplied headers — it re-opens the
spoofing hole the middleware exists to close. Scope `TrustedProxies` as tightly as
your topology allows.

### Relationship to `Config.TrustedProxies`

The core server already has a `TrustedProxies []string` field on
[`celeris.Config`](/docs/configuration) that scopes the **built-in** `c.ClientIP()`
XFF parsing. The `proxy` middleware is the fuller solution: it additionally rewrites
scheme and host, supports custom IP headers, and applies the correction pre-routing
so every downstream consumer sees consistent values. Use the middleware when you need
scheme/host rewriting or non-standard headers; the `Config` field alone suffices if
all you need is a trusted client IP from `X-Forwarded-For`. See
[Request handling](/docs/request-handling) for `c.ClientIP()` and
[Deployment](/docs/deployment) for running behind a proxy.

---

## Common pitfalls

- **CORS after auth blocks preflight.** The unauthenticated `OPTIONS` preflight is
  rejected by auth and the real request never fires. Put `cors.New()` first.
- **CSRF `cookie:` lookup panics.** `TokenLookup` may use `header`, `form`, or
  `query` — never `cookie`. Reading the token from its own cookie defeats the scheme.
- **`SameSite=None` without `Secure` panics.** Set `CookieSecure: true` whenever
  `CookieSameSite: celeris.SameSiteNoneMode`.
- **Empty string ≠ removed in `secure`.** `""` falls back to the default; use
  `secure.Suppress` to actually drop a header.
- **HSTS over HTTP is silently skipped.** That's intentional. Behind a TLS-terminating
  proxy you need the `proxy` middleware (or `X-Forwarded-Proto` handling) so
  `c.Scheme()` reports `https`; otherwise HSTS is never emitted.
- **`proxy` with empty `TrustedProxies` does nothing.** It's a deliberate no-op so
  you can't accidentally trust spoofed headers — but it also means you must populate
  the list for the middleware to take effect.
- **Over-broad `TrustedProxies` = IP spoofing.** Never use `0.0.0.0/0`. Scope to your
  proxy's real source networks.

## FAQ

**Do I need both `secure` and `cors`?**
They solve different problems. `secure` hardens how the browser treats *your*
responses; `cors` controls which *other* origins may call your API. Most apps use
both.

**Which order do the four go in?**
`proxy` first (via `s.Pre`, pre-routing), then `secure`, then `cors` (before auth),
then your auth, then `csrf` (after auth).

**Does `csrf` protect a token-authenticated (Bearer) API?**
CSRF specifically targets *cookie*-based session auth, where the browser attaches
credentials automatically. A pure Bearer-token API that doesn't rely on cookies is
not susceptible in the same way; CSRF is most valuable for cookie-session apps.

**Can I load these configs from a file?**
`secure.Config` carries `yaml` tags for file-based config. The other packages'
configs are plain structs — build them in code.

**How do I disable a single default `secure` header?**
Set its field to `secure.Suppress` (`"-"`). Setting `""` keeps the default.

## See also

- [Middleware](/docs/middleware) — global vs. group vs. route middleware and chain
  ordering, plus `Pre` (pre-routing).
- [Configuration](/docs/configuration) — the server-level `TrustedProxies` field and
  other `celeris.Config` options.
- [Request handling](/docs/request-handling) — `c.ClientIP()`, `c.Scheme()`,
  `c.Host()`, cookies, and the `*Context` request API.
- [Deployment](/docs/deployment) — running Celeris behind a reverse proxy and TLS
  termination.
