---
title: Authentication middleware
description: HTTP Basic, API key, JWT (HMAC/RSA/ECDSA/JWKS), and server-side sessions.
group: Middleware
order: 3
---

Celeris ships four authentication middleware packages, each a thin `celeris.HandlerFunc`
you install with `s.Use(...)` (or attach per route / per group):

| Package | Import | Use it for |
| ------- | ------ | ---------- |
| `basicauth` | `github.com/goceleris/celeris/middleware/basicauth` | HTTP Basic credentials (`Authorization: Basic ...`) |
| `keyauth` | `github.com/goceleris/celeris/middleware/keyauth` | API keys / bearer tokens from any request part |
| `jwt` | `github.com/goceleris/celeris/middleware/jwt` | Signed JWTs (HMAC, RSA, ECDSA, EdDSA, JWKS) |
| `session` | `github.com/goceleris/celeris/middleware/session` | Server-side sessions backed by a key-value store |

The first three answer *"who is this request?"* on every call. The fourth keeps
per-user state across requests behind a cookie (or header). They compose: you can
gate a route with `jwt`, fall back to `keyauth`, then load a `session` for the
authenticated user.

This page covers the **shared configuration model** first, then each package in
detail, and finishes with a stacking recipe. Every example is grounded in the
exported APIs at `celeris/middleware/{basicauth,keyauth,jwt,session}`.

## Shared model

All three credential middleware (`basicauth`, `keyauth`, `jwt`) share the same
config shape so you can swap or stack them without relearning the surface.

### Common config fields

| Field | Type | Behaviour |
| ----- | ---- | --------- |
| `Skip` | `func(c *celeris.Context) bool` | Return `true` to bypass the middleware for this request. |
| `SkipPaths` | `[]string` | Exact-match paths to bypass (e.g. `/health`, `/login`). |
| `ErrorHandler` | `func(c *celeris.Context, err error) error` | Called on every auth failure. Return an error to reject, or `nil` to (conditionally) let the request continue. |
| `SuccessHandler` | `func(c *celeris.Context)` | Called *after* successful validation, *before* `c.Next()`. Use it to enrich the context (tenant ID, scopes, metrics). |

`keyauth` and `jwt` additionally expose:

| Field | Type | Behaviour |
| ----- | ---- | --------- |
| `ContinueOnIgnoredError` | `bool` | When `true`, if `ErrorHandler` returns `nil` the middleware calls `c.Next()` instead of short-circuiting. This is the hook that makes auth stacking work. |

> **OPTIONS is never blocked.** Every credential middleware short-circuits CORS
> preflight (`OPTIONS`) requests before checking credentials, regardless of
> install order — so a misordered `cors`/auth pair never breaks preflight.

### One sentinel across all stacks: `ErrUnauthorized`

Every auth package re-exports the same canonical 401 error,
`celeris.ErrUnauthorized` (defined in `celeris/errors.go:44`). `basicauth.ErrUnauthorized`,
`keyauth.ErrUnauthorized`, and `jwt.ErrUnauthorized` are all aliases of it, so a
single `errors.Is` check matches a failure from *any* layer of a mixed stack:

```go
import "github.com/goceleris/celeris"

func authFailed(err error) bool {
    return errors.Is(err, celeris.ErrUnauthorized)
}
```

`keyauth` and `jwt` add finer-grained sentinels (`ErrMissingKey`, `ErrTokenMissing`,
`ErrJWTExpired`, …) that still satisfy `errors.Is(err, celeris.ErrUnauthorized)`
because they wrap a 401 `*celeris.HTTPError`. See [Error handling](/docs/error-handling)
for how returned errors map to responses.

### Constant-time comparison

Credential comparison must not leak timing. The built-in helpers handle this for
you:

- `basicauth.Config.Users` auto-generates a **constant-time** validator (HMAC-SHA256
  over a per-process random key, with an equal-cost path for unknown users).
- `keyauth.StaticKeys(...)` pads all keys to a uniform length and compares every
  candidate with `crypto/subtle.ConstantTimeCompare`, so neither key existence nor
  length leaks.
- `jwt` verifies signatures cryptographically, which is inherently constant-time
  with respect to the secret.

If you write a **custom** `Validator`, you are responsible for timing safety: use
`crypto/subtle.ConstantTimeCompare` rather than `==` on secrets.

## basicauth — HTTP Basic

`basicauth.New` reads the `Authorization: Basic <base64(user:pass)>` header and
validates the decoded credentials. The simplest form is a static user map:

```go
import "github.com/goceleris/celeris/middleware/basicauth"

s.Use(basicauth.New(basicauth.Config{
    Users: map[string]string{
        "alice": "s3cr3t",
        "bob":   "hunter2",
    },
    Realm: "Admin Area", // sent in WWW-Authenticate; default "Restricted"
}))
```

When `Users` is set and no custom validator is supplied, Celeris builds a
constant-time validator automatically — you do not call any hashing helper. On
failure the default `ErrorHandler` responds `401` with `WWW-Authenticate`,
`Cache-Control: no-store`, and `Vary: authorization` headers, and returns
`basicauth.ErrUnauthorized`.

### Config reference

| Field | Type | Notes |
| ----- | ---- | ----- |
| `Users` | `map[string]string` | Plaintext user→pass. Auto constant-time validator. |
| `HashedUsers` | `map[string]string` | User→opaque hash string. **Requires** `HashedUsersFunc`. |
| `HashedUsersFunc` | `func(hash, password string) bool` | Verifies a candidate against a stored hash. Required whenever `HashedUsers` is set — `New` panics otherwise. |
| `Validator` | `func(user, pass string) bool` | Custom credential check. |
| `ValidatorWithContext` | `func(c *celeris.Context, user, pass string) bool` | Like `Validator` but with the request context. Takes precedence over `Validator`. |
| `Realm` | `string` | Authentication realm. Default `"Restricted"`. |
| `Skip`, `SkipPaths`, `ErrorHandler`, `SuccessHandler` | — | See [Shared model](#shared-model). |

At least one of `Users`, `HashedUsers`, `Validator`, or `ValidatorWithContext`
must be set, or `New` panics.

### Hashed passwords (bcrypt / argon2)

**Never store plaintext passwords in production.** Storing real credentials means
hashing them with a slow, credential-grade KDF. There is no built-in default —
fast hashes like SHA-2/SHA-3/BLAKE2 are crackable at billions of guesses per
second — so you must wire a `HashedUsersFunc`. The function receives the stored
hash and the plaintext candidate and returns `true` on match:

```go
import (
    "github.com/goceleris/celeris/middleware/basicauth"
    "golang.org/x/crypto/bcrypt"
)

s.Use(basicauth.New(basicauth.Config{
    HashedUsers: map[string]string{
        // bcrypt hash of "s3cr3t"
        "alice": "$2y$12$Q9Q0...redacted...",
    },
    HashedUsersFunc: func(hash, password string) bool {
        return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
    },
}))
```

> **Pitfall — timing on unknown users.** `HashedUsersFunc` MUST take constant
> time for *any* input, including empty or invalid hash strings. `basicauth`
> already calls your function against a dummy stored hash for unknown users, so
> the lookup itself is timing-equal — but your function must not short-circuit
> on a malformed hash. `bcrypt.CompareHashAndPassword` returns instantly on an
> empty hash, so for argon2 (or hand-rolled schemes) compare against a
> pre-computed dummy hash with `crypto/subtle.ConstantTimeCompare`.

The deprecated `basicauth.HashPassword` helper returns a hex SHA-256 digest; it
is **not** credential-grade and is retained only for backwards compatibility. Do
not use it for new code.

### Reading the username downstream

After a successful check, the username is stored in the context. Read it with the
zero-allocation helper:

```go
func dashboard(c *celeris.Context) error {
    user := basicauth.UsernameFromContext(c) // "" if not authenticated
    return c.String(200, "Hello, "+user)
}
```

Celeris also exposes the raw decoder directly on the context —
`c.BasicAuth() (user, pass string, ok bool)` (see [Request handling](/docs/request-handling)) —
if you want to parse credentials without installing the middleware.

## keyauth — API keys

`keyauth` extracts a key from a configurable request location and runs it through
a **required** `Validator`. The default lookup is the `X-API-Key` header.

```go
import "github.com/goceleris/celeris/middleware/keyauth"

s.Use(keyauth.New(keyauth.Config{
    Validator: keyauth.StaticKeys(
        "key_live_abc123",
        "key_live_def456",
    ),
}))
```

`StaticKeys` returns a ready-made constant-time validator. For dynamic keys (a DB
lookup, a tenant resolver), supply your own `Validator` — and use
`crypto/subtle` for the comparison:

```go
s.Use(keyauth.New(keyauth.Config{
    Validator: func(c *celeris.Context, key string) (bool, error) {
        tenant, err := lookupTenant(c.Context(), key) // your storage
        if err != nil {
            return false, err // surfaced to ErrorHandler
        }
        if tenant == nil {
            return false, nil // 401 keyauth.ErrUnauthorized
        }
        c.SetString("tenant_id", tenant.ID)
        return true, nil
    },
}))
```

> Read `tenant_id` back in your handler with `v, ok := c.GetString("tenant_id")`.
> See [Passing data from a middleware to a handler](/docs/middleware#passing-data-from-a-middleware-to-a-handler).

### KeyLookup format

`KeyLookup` is a `source:name[:prefix]` string. Comma-separate multiple sources
for fallback — the first non-empty match wins.

| Source | Reads from | Example |
| ------ | ---------- | ------- |
| `header` | request header | `header:X-API-Key` |
| `query` | URL query param | `query:api_key` |
| `cookie` | cookie | `cookie:api_key` |
| `form` | form field | `form:api_key` |
| `param` | path param | `param:key` |

The optional `:prefix` strips a leading prefix from a **`header`** value
(case-insensitive), which is how you accept bearer tokens. The prefix is only
applied to `header` sources; for `query`/`cookie`/`form`/`param` it is ignored.
Fallback example — header first, then query:

```go
s.Use(keyauth.New(keyauth.Config{
    KeyLookup:  "header:Authorization:Bearer ,query:api_key",
    AuthScheme: "Bearer", // emitted in WWW-Authenticate; default "ApiKey"
    Validator:  keyauth.StaticKeys("key_live_abc123"),
}))
```

> Mind the trailing space in `"Bearer "` — the prefix is matched verbatim, so
> include the space that separates the scheme from the token.

### Config reference

| Field | Type | Notes |
| ----- | ---- | ----- |
| `Validator` | `func(c, key) (bool, error)` | **Required.** Returns `(valid, err)`. `New` panics if nil. |
| `KeyLookup` | `string` | `source:name[:prefix]`, comma-fallback. Default `"header:X-API-Key"`. |
| `AuthScheme` | `string` | Scheme in `WWW-Authenticate`. Default `"ApiKey"`. Must be HTTP token chars. |
| `Realm` | `string` | Realm in `WWW-Authenticate`. Default `"Restricted"`. |
| `ChallengeParams` | `map[string]string` | RFC 6750 params (`error`, `error_description`, `scope`, `error_uri`). |
| `ContinueOnIgnoredError` | `bool` | Proceed when `ErrorHandler` returns `nil` (for optional auth). |
| `Skip`, `SkipPaths`, `ErrorHandler`, `SuccessHandler` | — | See [Shared model](#shared-model). |

### Sentinels and reading the key

`keyauth` distinguishes a *missing* key from an *invalid* one:

| Sentinel | Meaning | `errors.Is(..., celeris.ErrUnauthorized)` |
| -------- | ------- | ----------------------------------------- |
| `keyauth.ErrMissingKey` | No key found in any configured source | ✓ (401) |
| `keyauth.ErrUnauthorized` | Key found but rejected | ✓ (alias) |

Read the validated key downstream with `keyauth.KeyFromContext(c)` (returns `""`
when unauthenticated). On rejection the default `ErrorHandler` returns the error
unchanged; the middleware then sets `WWW-Authenticate`, `Cache-Control: no-store`,
and a `Vary` header for any header-based sources.

## jwt — JSON Web Tokens

`jwt.New` extracts a token (default: `Authorization: Bearer <token>`), verifies its
signature against a configured key, validates the standard time claims, and stores
the parsed token and claims in the context.

```go
import "github.com/goceleris/celeris/middleware/jwt"

s.Use(jwt.New(jwt.Config{
    SigningKey: []byte("a-32-byte-or-longer-hmac-secret-value"),
}))
```

The default signing method is `HS256`. You must supply at least one key source, or
`New` panics.

### Where the verification key comes from

| Field | For | Notes |
| ----- | --- | ----- |
| `SigningKey` | single key | HMAC `[]byte` secret, or an RSA/ECDSA/Ed25519 **public** key. |
| `SigningKeys` | key rotation | `map[kid]key`; the token's `kid` header selects the key. |
| `KeyFunc` | full control | `func(*jwt.Token) (any, error)`; overrides the above. |
| `JWKSURL` / `JWKSURLs` | remote keysets | Auto-fetch keys from a JWKS endpoint (Auth0, Keycloak, Cognito, …). |

> **HMAC key length.** For `HS256`/`HS384`/`HS512`, Celeris logs a warning if the
> secret is shorter than the hash size (32/48/64 bytes). Use a key at least as long
> as the digest.

### Signing methods

`SigningMethod` selects the algorithm family. The exported singletons in
`celeris/middleware/jwt/types.go`:

| Family | Methods | Key type |
| ------ | ------- | -------- |
| HMAC | `SigningMethodHS256`, `HS384`, `HS512` | shared `[]byte` secret |
| RSA | `SigningMethodRS256`, `RS384`, `RS512` | RSA public key (verify) / private (sign) |
| RSA-PSS | `SigningMethodPS256`, `PS384`, `PS512` | RSA key |
| ECDSA | `SigningMethodES256`, `ES384`, `ES512` | ECDSA key |
| EdDSA | `SigningMethodEdDSA` | Ed25519 key |

RSA / ECDSA example — verification with a public key:

```go
import (
    "crypto/x509"
    "encoding/pem"

    "github.com/goceleris/celeris/middleware/jwt"
)

block, _ := pem.Decode(pubPEM)
pub, _ := x509.ParsePKIXPublicKey(block.Bytes) // *rsa.PublicKey or *ecdsa.PublicKey

s.Use(jwt.New(jwt.Config{
    SigningMethod: jwt.SigningMethodRS256,
    SigningKey:    pub,
}))
```

> **Pitfall — set `SigningMethod` to match your key.** If you supply an RSA key but
> leave `SigningMethod` at the default `HS256`, verification fails. The middleware
> enforces the configured algorithm (preventing the classic alg-confusion attack
> where an attacker swaps `RS256` for `HS256`).

### TokenLookup

Same `source:name[:prefix]` format as `keyauth`, with comma-fallback. Default
`"header:Authorization:Bearer "`. Read a token from a cookie instead (handy for
browser apps):

```go
s.Use(jwt.New(jwt.Config{
    SigningKey:  hmacSecret,
    TokenLookup: "cookie:jwt,header:Authorization:Bearer ",
}))
```

### Claims: MapClaims, structs, and typed retrieval

By default claims are parsed into `jwt.MapClaims` (a `map[string]any`). For typed
access, define a struct embedding `jwt.RegisteredClaims` and pass a `ClaimsFactory`
(preferred for structs — it avoids reflection and data races):

```go
type AppClaims struct {
    Roles []string `json:"roles"`
    jwt.RegisteredClaims
}

s.Use(jwt.New(jwt.Config{
    SigningKey:    hmacSecret,
    ClaimsFactory: func() jwt.Claims { return &AppClaims{} },
}))

func handler(c *celeris.Context) error {
    claims, ok := jwt.ClaimsFromContext[*AppClaims](c)
    if !ok {
        return celeris.ErrUnauthorized
    }
    return c.JSON(200, map[string]any{"sub": claims.Subject, "roles": claims.Roles})
}
```

`jwt.ClaimsFromContext[T]` is generic: it returns the claims typed to `T` and a
`bool` that is `false` if no claims were stored or the type does not match. With
the default `MapClaims`, retrieve with `jwt.ClaimsFromContext[jwt.MapClaims](c)`.
The raw parsed token is available via `jwt.TokenFromContext(c)`.

> `jwt.RegisteredClaims` carries the IANA-registered fields: `Issuer` (`iss`),
> `Subject` (`sub`), `Audience` (`aud`), `ExpiresAt` (`exp`), `NotBefore` (`nbf`),
> `IssuedAt` (`iat`), and `ID` (`jti`). `ExpiresAt`, `NotBefore`, and `IssuedAt`
> are `*jwt.NumericDate` (build them with `jwt.NewNumericDate`); `Audience` is a
> `jwt.Audience` that JSON-decodes from either a single string or an array.

### Parser options

`ParseOptions` adds validations beyond signature + expiry — issuer, audience, and
clock leeway:

```go
s.Use(jwt.New(jwt.Config{
    JWKSURL: "https://example.auth0.com/.well-known/jwks.json",
    ParseOptions: []jwt.ParserOption{
        jwt.WithIssuer("https://example.auth0.com/"),
        jwt.WithAudience("https://api.example.com"),
        jwt.WithLeeway(30 * time.Second), // tolerate small clock skew
    },
}))
```

`ValidMethods` restricts which algorithms the parser will accept (defaults to the
single configured `SigningMethod.Alg()`).

### JWKS rotation, refresh, and caching

Point `JWKSURL` at a provider's JWKS endpoint and the middleware fetches the
public keys, selects by the token's `kid`, and refreshes on an interval.

```go
jwksPreload := true
s.Use(jwt.New(jwt.Config{
    JWKSURL:     "https://example.auth0.com/.well-known/jwks.json",
    JWKSRefresh: 1 * time.Hour,    // re-fetch interval (default 1h)
    JWKSPreload: &jwksPreload,     // fetch eagerly at startup (default on)
}))
```

| Field | Type | Behaviour |
| ----- | ---- | --------- |
| `JWKSURL` | `string` | Single JWKS endpoint. **HTTPS is enforced** (HTTP allowed only for `localhost`/`127.0.0.1`/`::1`). |
| `JWKSURLs` | `[]string` | Multiple providers for federation; tried in order by `kid`. |
| `JWKSRefresh` | `time.Duration` | Re-fetch interval. Default `1h`. |
| `JWKSPreload` | `*bool` | Eager fetch at startup. `nil` (default) or `&true` preloads; pass a pointer to `false` to lazy-fetch on first request. |
| `JWKSCache` | `store.KV` | Optional shared cache of the raw JWKS JSON (cuts endpoint load across instances). |

For multi-instance deployments, share the keyset through a Redis-backed cache so
each instance does not hit the provider independently. The `jwtcache` helper wraps
a Celeris Redis client (see [Data stores](/docs/data-stores)):

```go
import (
    "github.com/goceleris/celeris/driver/redis"
    "github.com/goceleris/celeris/middleware/jwt"
    "github.com/goceleris/celeris/middleware/jwt/jwtcache"
)

rdb, err := redis.NewClient("localhost:6379")
if err != nil {
    log.Fatal(err)
}
s.Use(jwt.New(jwt.Config{
    JWKSURL:   "https://example.auth0.com/.well-known/jwks.json",
    JWKSCache: jwtcache.New(rdb), // cache TTL = JWKSRefresh; failures are non-fatal
}))
```

### Issuing tokens

`jwt.SignToken` creates and signs a token, and `jwt.NewNumericDate` builds the
`exp`/`iat` values:

```go
func login(c *celeris.Context) error {
    claims := jwt.MapClaims{
        "sub":  "user-42",
        "exp":  jwt.NewNumericDate(time.Now().Add(time.Hour)),
        "iat":  jwt.NewNumericDate(time.Now()),
    }
    token, err := jwt.SignToken(jwt.SigningMethodHS256, claims, hmacSecret)
    if err != nil {
        return err
    }
    return c.JSON(200, map[string]any{"token": token})
}
```

Sign with the *same* secret (HMAC) or the *private* key (RSA/ECDSA/EdDSA) that
pairs with the public key your verification middleware holds.

### Sentinels

| Sentinel | Meaning |
| -------- | ------- |
| `jwt.ErrTokenMissing` | No token found in the request |
| `jwt.ErrJWTMalformed` | Token could not be parsed |
| `jwt.ErrJWTExpired` | `exp` (or `nbf`/`iat`) failed the time check |
| `jwt.ErrTokenInvalid` | Bad signature, unknown `kid`, or other validation failure |
| `jwt.ErrUnauthorized` | Alias of `celeris.ErrUnauthorized` |

All are 401 `*celeris.HTTPError`s, so `errors.Is(err, celeris.ErrUnauthorized)`
matches every one. To respond differently to an expired token, check it in an
`ErrorHandler`:

```go
jwt.New(jwt.Config{
    SigningKey: hmacSecret,
    ErrorHandler: func(c *celeris.Context, err error) error {
        if errors.Is(err, jwt.ErrJWTExpired) {
            return c.JSON(401, map[string]any{"error": "token_expired"})
        }
        return err
    },
})
```

## session — server-side sessions

The session middleware loads (or creates) a session keyed by a cookie, exposes a
`*session.Session` on the context, and persists changes after your handler runs.
With no config it uses an in-memory store and a `celeris_session` cookie:

```go
import "github.com/goceleris/celeris/middleware/session"

s.Use(session.New())

func counter(c *celeris.Context) error {
    sess := session.FromContext(c)
    n := sess.GetInt("count") + 1
    sess.Set("count", n) // marks the session modified -> persisted after handler
    return c.JSON(200, map[string]any{"count": n})
}
```

You do not normally call `Save()` — the middleware persists automatically when the
session was modified or freshly created. Call `Save()` explicitly only to guarantee
persistence mid-handler.

> The default in-memory store keeps sessions in process memory and spawns a
> background cleanup goroutine. It is fine for single-instance apps and
> development, but for multi-instance deployments use a shared store (below).

### Config reference

| Field | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `Store` | `store.KV` | in-memory | Pluggable backend (Redis, Postgres, …). |
| `Extractor` | `session.Extractor` | cookie | Where the session ID is read from. |
| `CookieName` | `string` | `"celeris_session"` | Cookie / header name. |
| `CookiePath` | `string` | `"/"` | Cookie `Path`. |
| `CookieDomain` | `string` | — | Cookie `Domain`. |
| `CookieMaxAge` | `*int` | 86400 (24h) | `nil`=default, `IntPtr(0)`=session cookie. |
| `CookieSecure` | `bool` | `false` | HTTPS-only cookie. Auto-set to `true` over TLS. |
| `CookieHTTPOnly` | `*bool` | `true` | `BoolPtr(false)` to allow JS access. |
| `CookieSameSite` | `celeris.SameSite` | `SameSiteLaxMode` | `Strict`/`None` available. |
| `IdleTimeout` | `time.Duration` | 30m | Expiry after inactivity (server-side). |
| `AbsoluteTimeout` | `time.Duration` | 24h | Max lifetime. `-1` disables. |
| `KeyGenerator` | `func() string` | 32-byte hex | Session ID generator. |
| `Skip`, `SkipPaths`, `ErrorHandler` | — | — | `ErrorHandler` runs on store errors. |

> **`SameSiteNoneMode` requires `CookieSecure: true`** — `New` panics otherwise.
> Likewise `AbsoluteTimeout` (when positive) must be `>= IdleTimeout`.

### Extractors

By default the session ID rides in a cookie. For API clients that cannot store
cookies, read it from a header or query param — or chain several sources:

```go
s.Use(session.New(session.Config{
    Extractor: session.ChainExtractor(
        session.CookieExtractor("celeris_session"),
        session.HeaderExtractor("X-Session-ID"),
    ),
}))
```

When a non-cookie extractor is used, the middleware writes the session ID back in
a response header named after `CookieName` instead of a `Set-Cookie`. Available
extractors: `CookieExtractor`, `HeaderExtractor`, `QueryExtractor`, and
`ChainExtractor`.

### The Session object

`session.FromContext(c)` returns `*session.Session` (or `nil` if the middleware
did not run). Its methods:

| Method | Purpose |
| ------ | ------- |
| `Get(key) (any, bool)` | Raw value lookup. |
| `GetString` / `GetInt` / `GetBool` / `GetFloat64` | Typed accessors (zero value if missing/mismatched). |
| `Set(key, value)` | Store a value; marks the session modified. |
| `Delete(key)` | Remove a key (modified only if present). |
| `Clear()` | Remove all user data. |
| `Keys()` / `Len()` | Enumerate user keys / count them. |
| `Save()` | Force persistence now. |
| `Destroy()` | Invalidate: clear data, delete from store, expire the cookie. |
| `Regenerate()` | Issue a new ID, keep the data (see below). |
| `Reset()` | `Clear()` + `Regenerate()` for "log out and start fresh". |
| `ID()` / `IsFresh()` | The session ID / whether it was just created. |
| `SetIdleTimeout(d)` | Override the idle timeout for this one session. |

> **Security — regenerate on privilege change.** Always call `Regenerate()` (or
> `Reset()`) right after login or any privilege escalation to prevent session
> fixation. The data carries over; only the ID changes.

```go
func login(c *celeris.Context) error {
    user, err := authenticate(c) // your logic
    if err != nil {
        return celeris.ErrUnauthorized
    }
    sess := session.FromContext(c)
    if err := sess.Regenerate(); err != nil { // new ID, prevents fixation
        return err
    }
    sess.Set("user_id", user.ID)
    return c.Redirect(302, "/dashboard")
}

func logout(c *celeris.Context) error {
    if err := session.FromContext(c).Destroy(); err != nil {
        return err
    }
    return c.Redirect(302, "/")
}
```

### Pluggable stores

`Store` is any implementation of `store.KV` — the unified byte-level key-value
interface shared across Celeris middleware (`celeris/middleware/store`). Session
data is JSON-encoded before persistence, so the backend just needs to preserve
bytes. Use a shared store for horizontal scaling:

```go
import (
    "github.com/goceleris/celeris/driver/redis"
    "github.com/goceleris/celeris/middleware/session"
    sessionredis "github.com/goceleris/celeris/middleware/session/redisstore"
)

rdb, err := redis.NewClient("localhost:6379")
if err != nil {
    log.Fatal(err)
}
s.Use(session.New(session.Config{
    Store:        sessionredis.New(rdb),
    CookieSecure: true,
    IdleTimeout:  30 * time.Minute,
}))
```

See [Data stores](/docs/data-stores) for the full `store.KV` contract and the
available backends.

### Out-of-band access

`session.NewHandler(cfg)` returns a `*session.Handler` exposing both `Middleware()`
(install with `s.Use`) and `GetByID(ctx, id)` for inspecting a session outside the
request pipeline (admin tools, background jobs, WebSocket handlers). Sessions
returned by `GetByID` are **read-only** — calling `Save`/`Regenerate`/`Destroy` on
them panics.

## Auth stacking recipe

Because `keyauth` and `jwt` support `ContinueOnIgnoredError`, you can chain them:
prefer JWTs, fall back to an API key. Group middleware run **sequentially**, in
registration order, so the naive `s.Group("/api", jwtAuth, keyAuth)` is a footgun:
a request with a valid JWT still flows into `keyAuth`, which then 401s it for not
carrying an API key — the opposite of "prefer JWTs."

There are two correct shapes. The cleanest is to gate `keyAuth` with a `Skip` that
bypasses it once a valid JWT is already on the context. `jwt` stores the parsed
token only on the success path, so `jwt.TokenFromContext(c)` is non-`nil` exactly
when verification passed (verified in `celeris/middleware/jwt/jwt.go` — `c.Set` of
the token happens after `parser.ParseWithClaims` succeeds). The JWT layer uses a
`nil`-returning `ErrorHandler` plus `ContinueOnIgnoredError: true` so a JWT-less
(or invalid-JWT) request *continues* instead of being rejected; `keyAuth` then
decides. `keyauth.Config.Skip` is `func(c *celeris.Context) bool` and is the very
first check the middleware runs, so returning `true` short-circuits to `c.Next()`:

```go
import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/jwt"
    "github.com/goceleris/celeris/middleware/keyauth"
)

jwtAuth := jwt.New(jwt.Config{
    SigningKey:             hmacSecret,
    ContinueOnIgnoredError: true,
    ErrorHandler: func(c *celeris.Context, err error) error {
        return nil // ignore JWT failure, let keyauth try
    },
})

keyAuth := keyauth.New(keyauth.Config{
    Validator: keyauth.StaticKeys("key_live_abc123"),
    // Bypass API-key auth when a valid JWT already authenticated the request.
    Skip: func(c *celeris.Context) bool {
        return jwt.TokenFromContext(c) != nil
    },
})

// A valid JWT skips keyAuth entirely; otherwise keyAuth decides.
api := s.Group("/api", jwtAuth, keyAuth)
```

A request with a valid JWT is authenticated by `jwtAuth`; `keyAuth`'s `Skip` then
sees the stored token and waves it through. A request without a valid JWT falls
through to `keyAuth`; if that also fails, `keyAuth` returns 401. Because every layer
surfaces `celeris.ErrUnauthorized`, downstream error handling stays uniform.

If you do not want one credential to imply the other, present them as
**alternatives** on separate route groups instead of chaining — e.g.
`s.Group("/api", jwtAuth)` for token clients and `s.Group("/svc", keyAuth)` for
service clients — so each group enforces exactly one scheme.

The same `ContinueOnIgnoredError` + `ErrorHandler`-returns-`nil` shape also gives
you **optional auth** on a single middleware — enrich the context when a credential
is present, but let anonymous requests through to a handler that branches on
`keyauth.KeyFromContext(c) == ""`.

## Common pitfalls

- **Forgetting `cors` runs before auth.** Install `cors.New()` before any auth
  middleware so preflight is handled cleanly. (Auth middleware also defensively
  skip `OPTIONS`, but ordering keeps headers correct.) See the recommended order
  in [Middleware](/docs/middleware).
- **Plaintext `Users` in production.** `Users` is convenient for demos; for real
  credentials use `HashedUsers` + a bcrypt/argon2 `HashedUsersFunc`.
- **HMAC secrets too short.** `HS256` wants ≥32 bytes; Celeris warns but does not
  block. Use a long random secret.
- **Algorithm confusion.** Set `SigningMethod` (or `ValidMethods`) to exactly the
  algorithm you expect — never accept attacker-chosen `alg`.
- **JWKS over HTTP.** `JWKSURL` must be HTTPS in production; HTTP is allowed only
  for localhost during development.
- **Not regenerating session IDs on login.** Call `Regenerate()` after auth state
  changes to avoid session fixation.
- **`SameSite=None` without `Secure`.** This panics — browsers reject such
  cookies, and Celeris enforces the pairing.

## FAQ

**Which middleware should I use?**
Use `basicauth` for simple internal tools or machine-to-machine with credentials,
`keyauth` for API keys / service tokens, `jwt` for stateless auth with an identity
provider, and `session` for stateful browser logins. They compose freely.

**How do I make a route public while everything else is protected?**
Add the path to `SkipPaths`, or return `true` from `Skip` for that request.

**Can I match a 401 from any auth layer with one check?**
Yes — `errors.Is(err, celeris.ErrUnauthorized)` matches `basicauth`, `keyauth`,
and `jwt` failures because they all alias the same sentinel.

**Where does the authenticated identity live after success?**
`basicauth.UsernameFromContext(c)`, `keyauth.KeyFromContext(c)`,
`jwt.ClaimsFromContext[T](c)` / `jwt.TokenFromContext(c)`, and
`session.FromContext(c)` respectively.

## Related

- [Request handling](/docs/request-handling) — `c.BasicAuth()` and reading request data.
- [Middleware](/docs/middleware) — installing and ordering middleware.
- [Responses](/docs/responses) — how returned errors become HTTP responses.
- [Data stores](/docs/data-stores) — the `store.KV` interface and backends.
