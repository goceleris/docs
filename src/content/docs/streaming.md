---
title: Streaming responses
description: Incremental output with StreamWriter, detaching connections, hijacking, and the buffered Stream helpers.
group: Real-Time
order: 1
---

Most handlers build a complete response in memory and hand it to a writer like
`c.JSON` or `c.Blob` (see [Sending responses](/docs/responses)). That works when you
know the whole body up front. This page is about the cases where you don't: the body
is large, unbounded, or produced over time, and you want bytes to reach the client
*as they are generated* rather than all at once at the end.

The primitive for that is `Context.StreamWriter`, used together with `Context.Detach`.
This guide covers the streaming primitives only. Two protocols built on top of them
have dedicated pages — read those instead if you want a higher-level API:

- [Server-Sent Events](/docs/sse) — one-way `text/event-stream` with replay support.
- [WebSocket](/docs/websocket) — full-duplex framed connections with a fan-out hub.

## When you need streaming

Reach for `StreamWriter` when any of these is true:

- **The body is large or unbounded.** A multi-gigabyte export, a tail of a log file,
  or a feed that runs until the client disconnects. You cannot — and should not —
  buffer it all in memory first.
- **You want incremental progress.** Long-running work where the client should see
  output (a progress meter, partial results) before the job finishes.
- **You are implementing a custom streaming protocol.** Chunked transfer with your
  own framing, NDJSON, or anything where you control the bytes on the wire directly.

If your body fits comfortably in memory and you have it all at once, you do **not**
need streaming — use `c.JSON`, `c.Blob`, `c.String`, etc. They are simpler and faster.

> The `c.Stream` / `c.StreamReader` helpers look like streaming but **buffer the
> entire reader before writing**. They are covered [below](#the-buffered-stream-helpers)
> — do not use them for true incremental output.

## StreamWriter

`Context.StreamWriter()` returns a `*StreamWriter` for incremental writing, or `nil`
if streaming is unavailable. You always check for `nil` first.

```go
sw := c.StreamWriter()
if sw == nil {
    // Either the engine does not expose a streamer, or a middleware is
    // buffering this response (see "Incompatibility with buffering").
    return c.String(200, "streaming not supported")
}
```

Source: `celeris/context_response.go:1490`.

`StreamWriter()` returns `nil` in two situations:

1. The active engine's response writer does not implement the streaming interface.
   (All shipped engines — `std`, `epoll`, `io_uring` — *do* support streaming, so in
   practice this only happens behind unusual custom transports.)
2. Response **buffering** is active for this request — a middleware called
   `BufferResponse` upstream. Streamed bytes go straight to the wire and cannot be
   recalled or rewritten, so the two are mutually exclusive. See
   [Incompatibility with buffering](#incompatibility-with-buffering).

### The StreamWriter API

Once you hold a non-nil `*StreamWriter`, you drive the response with these methods.
Source: `celeris/context_response.go:1439-1474`.

| Method                                  | Returns          | Purpose                                                                 |
| --------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `WriteHeader(status int, headers [][2]string)` | `error`   | Send the status line and headers. Call **once**, before the first `Write`. |
| `Write(data []byte)`                    | `(int, error)`   | Send one chunk of the body. Call as many times as you like.              |
| `Flush()`                               | `error`          | Push buffered bytes onto the network now (e.g. after each SSE event).    |
| `Close()`                               | `error`          | Signal end of body; syncs the byte count back to the `Context`.         |
| `BytesWritten()`                        | `int64`          | Total bytes written through this writer. Safe for concurrent use.       |

Key rules:

- **You supply the `Content-Type`.** Unlike `c.JSON`/`c.Blob`, `StreamWriter` writes
  nothing for you. Set every header you need — including `content-type` — in the
  `WriteHeader` call. Headers are passed as `[][2]string` (a slice of `{key, value}`
  pairs), lower-cased keys by convention.
- **`WriteHeader` is once.** It writes the status line. Call it before your first
  `Write`, and only once.
- **`Flush` controls latency.** `Write` may buffer; `Flush` guarantees the bytes are
  on the wire. For interactive streams (progress, events) flush after each logical
  unit. For bulk throughput you can flush less often, or rely on the engine's own
  flushing.
- **Always `Close`.** It terminates the response body framing and reconciles the byte
  counter on the `Context`. Defer it.

A minimal NDJSON stream (no detach needed for the blocking variant — see the next
section for the async/native variant):

```go
s.GET("/export", func(c *celeris.Context) error {
    sw := c.StreamWriter()
    if sw == nil {
        return c.String(500, "streaming unsupported")
    }
    if err := sw.WriteHeader(200, [][2]string{
        {"content-type", "application/x-ndjson"},
    }); err != nil {
        return err
    }
    defer sw.Close()

    enc := json.NewEncoder(sw)
    for rows.Next() {
        var r Row
        if err := rows.Scan(&r); err != nil {
            return err
        }
        if err := enc.Encode(&r); err != nil { // one JSON object + newline
            return err
        }
        if err := sw.Flush(); err != nil { // ship each row promptly
            return err
        }
    }
    return nil
})
```

Because `*StreamWriter` satisfies `io.Writer` (its `Write([]byte) (int, error)`
signature), you can hand it to `json.NewEncoder`, `io.Copy`, `fmt.Fprintf`, gzip
writers, and any other standard library writer.

After you use a `StreamWriter`, `Context.IsWritten()` returns `true` and
`Context.BytesWritten()` tracks the running total (it may keep increasing while the
stream is still in progress). Source: `celeris/context_response.go:1241`,
`celeris/context_response.go:1247`.

## The async-detach model

The example above blocks the handler until the whole stream is sent. That is fine for
a bounded export, but for **long-lived** streams (SSE, a feed that runs for minutes,
a connection that stays open until the client leaves) blocking the handler is wrong on
native engines: it pins an event-loop worker thread for the lifetime of the stream.

The fix is to **detach** the connection from the request lifecycle, hand it to a
goroutine, and return from the handler. But whether you may do that depends on the
engine — and Celeris exposes a single boolean to decide.

### EngineSupportsAsyncDetach

`Context.EngineSupportsAsyncDetach()` reports whether the active engine can keep the
connection alive after the handler returns. Source:
`celeris/context_response.go:1380`.

| Engine                  | `EngineSupportsAsyncDetach()` | Streaming strategy                                                  |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------ |
| Native (`epoll`, `io_uring`) | `true`                   | Detach, spawn a goroutine, **return `nil`** from the handler.      |
| `std` (net/http)        | `false`                       | Spawn the work but **block until it finishes** before returning.   |

The reason for the asymmetry: native engines run handlers on a small pool of
event-loop threads, so a long-lived handler starves the loop — you must return to free
the thread, and the engine keeps the detached connection alive for your goroutine. The
`std` engine, by contrast, is `net/http`: it closes the connection the moment the
handler returns, so the work must complete *before* you return.

### Detach

`Context.Detach()` removes the `Context` from the handler chain's lifecycle and
returns a `done func()`. Source: `celeris/context_response.go:1390`.

> **You MUST call `done()` exactly once when you are finished with the `Context`.**
> If you don't, the `Context` is never released back to the pool — a permanent leak.
> Always `defer done()` inside the goroutine that owns the stream.

After `Detach`, the framework will not recycle the `Context` when the handler returns;
the returned `done` is what releases it.

### The canonical pattern

Write one handler that works on both native and `std` engines by branching on
`EngineSupportsAsyncDetach()`:

```go
s.GET("/feed", func(c *celeris.Context) error {
    sw := c.StreamWriter()
    if sw == nil {
        return c.String(500, "streaming unsupported")
    }
    done := c.Detach()
    if err := sw.WriteHeader(200, [][2]string{
        {"content-type", "text/event-stream"},
        {"cache-control", "no-cache"},
    }); err != nil {
        done()
        return err
    }

    run := func() {
        defer done()      // release the Context — required
        defer sw.Close()  // finish the response body
        for event := range events {
            if _, err := sw.Write([]byte("data: " + event + "\n\n")); err != nil {
                return // client gone or write failed
            }
            if err := sw.Flush(); err != nil {
                return
            }
        }
    }

    if c.EngineSupportsAsyncDetach() {
        go run()    // native: hand off and free the worker thread
        return nil
    }
    run()           // std: must finish before the handler returns
    return nil
})
```

The shape to internalise:

- Get the `StreamWriter`, check for `nil`.
- `Detach()` to obtain `done`.
- The streaming goroutine **always** `defer done()` and `defer sw.Close()`.
- Native (`EngineSupportsAsyncDetach() == true`): `go run(); return nil`.
- `std` (`false`): call `run()` inline, then `return nil`.

This is the same pattern the [SSE](/docs/sse) and [WebSocket](/docs/websocket)
middleware use internally; if you only need those protocols, prefer the middleware and
skip the boilerplate.

> See [Engines](/docs/engines) for which engine is active in your deployment and how
> the adaptive controller chooses between them.

## The buffered Stream helpers

Despite their names, `Context.Stream` and `Context.StreamReader` are **not**
incremental. They read the *entire* `io.Reader` into memory and then write it as a
single blob. Source: `celeris/context_response.go:1110` and
`celeris/context_response.go:1125`.

```go
// Reads ALL of r into memory, then writes it. Not streaming.
func (c *Context) Stream(code int, contentType string, r io.Reader) error
func (c *Context) StreamReader(code int, contentType string, r io.Reader) error // alias
```

`StreamReader` is just an alias for `Stream` with a clearer name — behaviour is
identical. Both:

- buffer the whole reader before sending anything;
- enforce a **100 MB cap**. A reader larger than that yields an `HTTPError` with
  status **413** (`stream body exceeds 100MB limit`).

```go
// Fine for a small, bounded reader you happen to have as an io.Reader:
s.GET("/report.csv", func(c *celeris.Context) error {
    return c.Stream(200, "text/csv", smallBuffer) // buffered, <= 100 MB
})
```

Use these only for **small, bounded** readers where buffering is acceptable. For
anything large, unbounded, or latency-sensitive, use `StreamWriter` instead — it is
the only way to get true incremental output.

## Hijacking

When you need the raw TCP connection — to speak a non-HTTP protocol, or to implement
an upgrade that the framework doesn't model — call `Context.Hijack()`. It returns the
underlying `net.Conn` and hands you full ownership. Source:
`celeris/context_response.go:1258`.

```go
s.GET("/raw", func(c *celeris.Context) error {
    conn, err := c.Hijack()
    if err != nil {
        return err // e.g. ErrHijackNotSupported on HTTP/2
    }
    defer conn.Close() // you own it now

    // Speak whatever protocol you like directly on conn.
    _, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\n\r\n"))
    // ...
    return nil
})
```

Rules and constraints:

- **HTTP/1.1 only.** HTTP/2 multiplexes many logical streams over one TCP connection,
  so a single stream cannot take it over. `Hijack` on an HTTP/2 request returns
  `celeris.ErrHijackNotSupported` (source: `celeris/errors.go:27`). Always check the
  error.
- **You own the connection.** After a successful `Hijack`, Celeris steps out
  completely. You are responsible for writing any status line/headers and for
  **closing** the connection (`defer conn.Close()`).
- **No response after hijack.** `Hijack` marks the response as written; calling it
  after a response has already been sent returns an error.
- The standard verb methods like `c.JSON` will return `ErrResponseWritten` once the
  connection is hijacked — don't mix them.

For WebSocket specifically, prefer the [WebSocket](/docs/websocket) middleware (which
uses engine-integrated upgrades where available and falls back to hijacking on `std`).
Reach for raw `Hijack` only for custom protocols the middleware doesn't cover.

## Response buffering (for middleware authors)

This section is only relevant if you are **writing middleware** that needs to inspect
or rewrite a response after the handler produced it (loggers, compressors, ETag,
response transforms). Application handlers can skip it.

Celeris exposes two ways to intercept a response. Source:
`celeris/context_response.go:1161` and `celeris/context_response.go:1188`.

| Method                   | Effect                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `CaptureResponse()`      | The response is written to the wire **and** a copy is captured for inspection. Ideal for loggers. |
| `BufferResponse()`       | Response methods (`JSON`, `XML`, `Blob`, `NoContent`, …) are captured **instead of** written. Defers the wire write entirely. |
| `FlushResponse()`        | Sends the buffered response. Depth-tracked: only the outermost layer's flush actually writes. |
| `ResponseBody()`         | The captured body (`[]byte`), or `nil` if capture was not enabled.                            |
| `ResponseStatus()` / `ResponseContentType()` | The captured status code / `Content-Type`.                               |
| `IsWritten()`            | `true` once a response has reached the wire. Source: `celeris/context_response.go:1241`.      |
| `BytesWritten()`         | Body size in bytes (running total while streaming). Source: `celeris/context_response.go:1247`. |

`BufferResponse` is **depth-tracked**: several middleware layers can each call it, and
the response is only sent when the outermost layer calls `FlushResponse`. A typical
buffering middleware looks like:

```go
func transform(c *celeris.Context) error {
    c.BufferResponse()        // capture instead of writing
    if err := c.Next(); err != nil {
        return err
    }
    body := c.ResponseBody()  // inspect / rewrite the captured body
    c.SetResponseBody(transformed(body))
    return c.FlushResponse()  // outermost flush writes to the wire
}
```

### StreamWriter is incompatible with buffering

This is the crucial interaction for middleware authors. **While buffering is active,
`Context.StreamWriter()` returns `nil`.** Source: `celeris/context_response.go:1490`.

Streaming writes bytes directly and irrevocably to the wire; buffering holds a response
in memory so it can be discarded or rewritten. The two cannot coexist — a buffered
layer could never replay or mutate bytes that have already left the building. So:

- A handler that buffers (or sits under a buffering middleware) **cannot** also stream.
  `StreamWriter()` will hand back `nil`, which is exactly why the streaming examples
  above check for it.
- Likewise, `CaptureResponse()` does **not** capture streamed bytes — there is no
  in-memory copy of a stream.

If you write middleware that buffers, be aware it silently disables streaming for every
handler beneath it. Apply such middleware only to routes that don't stream, or skip
buffering when the handler intends to stream.

## Common pitfalls

- **Forgetting `done()`.** Every `Detach()` returns a `done func()` that you must call
  exactly once, or you leak the `Context` permanently. `defer done()` in the streaming
  goroutine.
- **Blocking the handler on a native engine.** If `EngineSupportsAsyncDetach()` is
  `true` and you run a long-lived stream inline (without `go`), you pin an event-loop
  worker thread. Spawn a goroutine and return `nil`.
- **Returning before the goroutine finishes on `std`.** If `EngineSupportsAsyncDetach()`
  is `false` and you spawn a goroutine and return, `net/http` closes the connection out
  from under it. Block until the stream finishes instead.
- **Not calling `Close()`.** The response framing is finalised by `sw.Close()`. Defer
  it alongside `done()`.
- **Expecting `Stream`/`StreamReader` to be incremental.** They buffer the whole
  reader (100 MB cap → 413). Use `StreamWriter` for real streaming.
- **Mixing `StreamWriter` with `c.JSON`/`c.Blob`.** Once you stream, the response is
  written; later response calls return `ErrResponseWritten`. Pick one.
- **Streaming under a buffering middleware.** `StreamWriter()` returns `nil` whenever a
  middleware called `BufferResponse` upstream. Check for `nil`.
- **Hijacking an HTTP/2 request.** Returns `ErrHijackNotSupported`. Hijack is HTTP/1.1
  only.

## FAQ

**Do I always need `Detach()` to stream?**
No. For a *bounded* stream where blocking the handler is acceptable you can call
`StreamWriter()`, write, `Close()`, and return — without detaching. `Detach` exists for
*long-lived* streams on native engines, where you must return from the handler to free
the event-loop thread. The branch on `EngineSupportsAsyncDetach()` is the safe,
portable pattern.

**Which `Content-Type` does `StreamWriter` set?**
None. You set every header, including `content-type`, in the `WriteHeader` call.

**Why is my `StreamWriter()` returning `nil`?**
Almost always because a middleware upstream is buffering the response
(`BufferResponse`). Streaming and buffering are mutually exclusive. Move the streaming
route off the buffering middleware, or stop buffering it.

**How do I detect when the client disconnects?**
A `Write` (or `Flush`) on the `StreamWriter` returns an error once the peer has gone
away. Check the error from each `Write`/`Flush` and stop the loop when it fails — the
examples above do exactly this. This is the **only** portable signal, and on HTTP/1.1
it is the *only* one: **`c.Context().Done()` does not fire when an HTTP/1.1 client
disconnects.** A dropped HTTP/1.1 connection surfaces solely as a write/flush error, so
do not block a stream on `c.Context().Done()` waiting for the client to leave — you will
wait forever. Cancellation through `c.Context()` is only delivered on HTTP/2, where a
stream reset (e.g. `RST_STREAM`) cancels the request context. If you have cleanup that
must run when the client goes away (cancelling a database cursor, stopping a producer
goroutine), drive it from the write/flush error on `StreamWriter`, not from
`c.Context().Done()`.

**Should I use `StreamWriter` directly for SSE or WebSocket?**
Usually no. The [SSE](/docs/sse) and [WebSocket](/docs/websocket) middleware build the
detach/streaming dance for you (plus event framing, replay, idle timeouts, fan-out).
Use raw `StreamWriter` for custom protocols or one-off chunked responses.

## Related pages

- [Server-Sent Events](/docs/sse) — higher-level `text/event-stream` API.
- [WebSocket](/docs/websocket) — full-duplex framed connections.
- [Engines](/docs/engines) — which engine is active and what `EngineSupportsAsyncDetach`
  reflects.
- [Sending responses](/docs/responses) — the non-streaming response writers.
