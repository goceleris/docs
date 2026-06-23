---
title: Binding and validation
description: Deserialize JSON/XML request bodies into structs and validate input before using it.
group: Routing & Handlers
order: 3
---

Most handlers that accept a request body do two things in sequence: **bind** the
raw bytes into a Go struct, then **validate** the resulting fields before acting
on them. Celeris gives you the binding half as first-class `Context` methods; the
validation half is plain Go — there is no struct-tag validator in the core. This
page covers both, plus a common point of confusion (the `celeris/validation`
package, which is *not* for input validation).

## Binding the body

The `Context` exposes three binding methods. All three read the body that was
already received with the request, deserialize it into the value you pass, and
return an error you can return straight from your handler.

| Method | Format | How the format is chosen |
| --- | --- | --- |
| `c.Bind(v any) error` | JSON or XML | Driven by the `Content-Type` request header |
| `c.BindJSON(v any) error` | JSON | Always JSON, header ignored |
| `c.BindXML(v any) error` | XML | Always XML, header ignored |

Pass a pointer to the destination value, exactly as you would to
`json.Unmarshal` or `xml.Unmarshal`.

```go
type CreateUser struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

s.POST("/users", func(c *celeris.Context) error {
    var in CreateUser
    if err := c.Bind(&in); err != nil {
        return celeris.NewHTTPError(400, "invalid request body").WithError(err)
    }
    // in is populated; validate before use (see below)
    return c.JSON(201, in)
})
```

### `Bind` — Content-Type-driven

`Bind` inspects the `Content-Type` request header and routes accordingly:

- `application/xml` or `text/xml` (matched by prefix) → XML via
  `encoding/xml.Unmarshal`
- **everything else** → JSON via `encoding/json.Unmarshal`

The JSON branch is a *fallback*, not a check. A request with
`Content-Type: text/plain`, with some unrelated content type, or with **no
`Content-Type` header at all** is still parsed as JSON. There is no "unsupported
media type" rejection — see [Common pitfalls](#common-pitfalls).

```go
// XML when the client sends application/xml or text/xml; JSON otherwise.
var in CreateUser
if err := c.Bind(&in); err != nil {
    return celeris.NewHTTPError(400, "invalid body").WithError(err)
}
```

### `BindJSON` and `BindXML` — explicit format

When an endpoint only accepts one format, bind to that format directly and ignore
whatever `Content-Type` the client claims:

```go
var in CreateUser
if err := c.BindJSON(&in); err != nil {        // always JSON
    return celeris.NewHTTPError(400, "expected JSON body").WithError(err)
}
```

```go
var in CreateUser
if err := c.BindXML(&in); err != nil {         // always XML
    return celeris.NewHTTPError(400, "expected XML body").WithError(err)
}
```

Use the struct tags that match the format you bind:

```go
type CreateUser struct {
    Name  string `json:"name" xml:"name"`
    Email string `json:"email" xml:"email"`
}
```

### Errors from binding

All three methods share the same error contract:

| Condition | Returned error |
| --- | --- |
| Body is empty (zero bytes) | `celeris.ErrEmptyBody` |
| Body is malformed for the chosen format | the underlying `encoding/json` or `encoding/xml` error |
| Body parses successfully | `nil` |

`ErrEmptyBody` is a sentinel value, so you can branch on it with `errors.Is` and
distinguish "the client sent nothing" from "the client sent garbage":

```go
var in CreateUser
switch err := c.Bind(&in); {
case errors.Is(err, celeris.ErrEmptyBody):
    return celeris.NewHTTPError(400, "request body is required")
case err != nil:
    return celeris.NewHTTPError(400, "could not parse body").WithError(err)
}
```

The malformed-body error is the raw decoder error (for example
`*json.SyntaxError` or `*json.UnmarshalTypeError`). It is safe to wrap with
`.WithError(err)` for logging, but think twice before echoing decoder messages
verbatim to untrusted clients — a generic 400 message is usually the better
public response.

## What `Bind` does not do

Binding is deliberately narrow. It does **not**:

- **Bind form data.** `Bind` only handles JSON and XML *bodies*. For
  `application/x-www-form-urlencoded` and `multipart/form-data`, use the form
  APIs instead — `c.FormValue(name)`, `c.FormValueOK(name)`, `c.FormValues(name)`,
  `c.FormFile(name)`, and `c.MultipartForm()`. These parse the body lazily on
  first access; see [Handling requests](/docs/request-handling) for details.
- **Validate anything.** A successful bind only means the bytes deserialized
  into your struct shape. Missing fields become zero values; unknown JSON keys
  are ignored; type mismatches surface as decoder errors, but business rules
  ("email must be non-empty", "age must be positive") are never checked.

The idiomatic flow is therefore always two steps: **bind first, then validate.**

```go
var in CreateUser
if err := c.Bind(&in); err != nil {
    return celeris.NewHTTPError(400, "invalid request body").WithError(err)
}
if err := validateCreateUser(in); err != nil {   // your code
    return err
}
```

## Validating struct fields

Celeris core has **no built-in struct-tag validator** (there is no
`validate:"required"`-style mechanism). Validation is ordinary Go: check the
fields you care about and return a `*celeris.HTTPError` with status `400` when
something is wrong. `celeris.NewHTTPError(code, message)` builds the error, and
`.WithError(err)` optionally wraps an underlying cause for `errors.Is` /
`errors.As` and logging.

```go
func validateCreateUser(in CreateUser) error {
    if strings.TrimSpace(in.Name) == "" {
        return celeris.NewHTTPError(400, "name is required")
    }
    if !strings.Contains(in.Email, "@") {
        return celeris.NewHTTPError(400, "email is invalid")
    }
    return nil
}
```

Returning an `*celeris.HTTPError` from a handler lets Celeris translate it into
the right status code centrally — you do not have to write the response yourself.
See [Error handling](/docs/error-handling) for how returned errors become
HTTP responses.

If you prefer a third-party validator (for example a struct-tag library from the
Go ecosystem), nothing stops you: bind with `c.Bind`, run your validator on the
struct, and map its error to an `HTTPError`. Celeris stays out of the way.

```go
var in CreateUser
if err := c.Bind(&in); err != nil {
    return celeris.NewHTTPError(400, "invalid request body").WithError(err)
}
if err := myValidator.Struct(&in); err != nil {        // your dependency
    return celeris.NewHTTPError(400, "validation failed").WithError(err)
}
```

## The `validation` package is not input validation

There is a package at `github.com/goceleris/celeris/validation`. **It has nothing
to do with validating request input.** It is an internal property-testing
facility: a set of in-process *assertion counters* that the engine and middleware
bump under the `validation` build tag.

- Production binaries (built **without** `-tags=validation`) compile against no-op
  stubs — the counters and their endpoint are stripped at compile time, so there
  is zero runtime cost.
- Validation builds (`-tags=validation`) expose the counters as atomics and serve
  a JSON snapshot of the `Counters` struct (via `Snapshot`) over a unix socket,
  which external property-test harnesses poll. `RecordPanic` and similar helpers
  feed those counters.

The counters track engine invariants (recovered panics, rate-limit token
violations, and so on), not the correctness of any individual request body. As an
application author you never import this package and it plays no part in binding
or validating input. Use `c.Bind*` plus your own field checks, as shown above.

## Negotiated responses

Binding handles the *request* side; the matching *response* side often wants to
answer in the same family of formats. Celeris can pick the response encoding from
the client's `Accept` header:

- `c.Respond(code, v)` writes `v` as JSON, XML, or plain text, whichever best
  matches `Accept` (falling back to JSON when nothing matches).
- `c.Negotiate(offers...)` returns the best-matching content type from the offers
  you list, so you can branch yourself. With an empty `Accept` header it returns
  the first offer.

These are covered in full on the [Sending responses](/docs/responses) page.

```go
s.POST("/users", func(c *celeris.Context) error {
    var in CreateUser
    if err := c.Bind(&in); err != nil {
        return celeris.NewHTTPError(400, "invalid request body").WithError(err)
    }
    if err := validateCreateUser(in); err != nil {
        return err
    }
    return c.Respond(201, in) // JSON / XML / text per the Accept header
})
```

## Worked example: create a user

A complete handler that accepts JSON *or* XML, validates the fields, and returns
`201 Created`:

```go
package main

import (
    "errors"
    "strings"

    "github.com/goceleris/celeris"
)

type CreateUser struct {
    Name  string `json:"name"  xml:"name"`
    Email string `json:"email" xml:"email"`
}

func validateCreateUser(in CreateUser) error {
    if strings.TrimSpace(in.Name) == "" {
        return celeris.NewHTTPError(400, "name is required")
    }
    if !strings.Contains(in.Email, "@") {
        return celeris.NewHTTPError(400, "email is invalid")
    }
    return nil
}

func createUser(c *celeris.Context) error {
    var in CreateUser

    // 1. Bind — format chosen by Content-Type (XML for application/xml or
    //    text/xml, JSON otherwise).
    switch err := c.Bind(&in); {
    case errors.Is(err, celeris.ErrEmptyBody):
        return celeris.NewHTTPError(400, "request body is required")
    case err != nil:
        return celeris.NewHTTPError(400, "could not parse body").WithError(err)
    }

    // 2. Validate.
    if err := validateCreateUser(in); err != nil {
        return err
    }

    // 3. Persist (omitted) and respond 201.
    return c.JSON(201, in)
}
```

## Common pitfalls

- **A missing `Content-Type` still binds as JSON.** `Bind` only switches to XML
  for an `application/xml` / `text/xml` prefix; every other value — including no
  header at all — falls back to JSON. If you require XML, use `BindXML` so an
  unexpected content type fails loudly instead of silently parsing as JSON.
- **Don't treat every bind error the same.** An empty body returns the sentinel
  `celeris.ErrEmptyBody`; a malformed body returns a decoder error. Use
  `errors.Is(err, celeris.ErrEmptyBody)` when "required body" and "bad body"
  deserve different messages.
- **A successful bind is not a valid request.** Zero values, missing fields, and
  unknown extra keys all bind cleanly. Always run your own field checks before
  using the data.
- **`Bind` does not read form fields.** Posting a `<form>` with the default
  encoding sends `application/x-www-form-urlencoded`, which `Bind` will try to
  parse as JSON and fail. Use `c.FormValue` and friends for forms.
- **The `celeris/validation` package won't validate your input.** It is a
  build-tag assertion-counter facility for the engine's own property tests, not a
  request validator.

## FAQ

**Can I reject requests whose `Content-Type` isn't JSON?**
Yes — `Bind` won't do it for you, but you can check the header first with
`c.Header("content-type")` and return a `415` (`celeris.NewHTTPError(415, ...)`)
before binding, or simply use `BindJSON` and treat the decode error as a 400.

**How do I forbid unknown JSON fields?**
The binding helpers use `encoding/json.Unmarshal`, which ignores unknown keys by
design. If you need strict decoding, read the raw bytes with `c.Body()` and run
your own `json.Decoder` with `DisallowUnknownFields()` set.

**Where do returned errors go?**
Returning an `error` (especially a `*celeris.HTTPError`) from a handler hands it
to Celeris's central error handling. See [Error handling](/docs/error-handling).

## Related

- [Handling requests](/docs/request-handling) — reading query, headers, cookies, body, and form/file uploads.
- [Sending responses](/docs/responses) — `JSON`, `XML`, `Respond`, and content negotiation.
- [Error handling](/docs/error-handling) — `HTTPError`, returning errors, and central error handling.
- [Configuration reference](/docs/configuration) — server-level options.
