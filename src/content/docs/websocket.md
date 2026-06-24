---
title: WebSocket
description: Build real-time WebSocket endpoints with the native, zero-dependency websocket middleware.
group: Real-Time
order: 3
---

Celeris ships a native, zero-dependency WebSocket implementation (RFC 6455) in the
`middleware/websocket` package. You register it on a `GET` route, give it a
`Handler`, and Celeris takes care of the upgrade handshake, frame parsing,
masking, fragmentation, control frames, UTF-8 validation, and (optionally)
permessage-deflate compression. The same `Handler` runs unchanged whether you're
on a native engine (epoll/io_uring) or the std engine — only the I/O plumbing
underneath differs.

Import it as:

```go
import "github.com/goceleris/celeris/middleware/websocket"
```

> `websocket` ships in the core `github.com/goceleris/celeris` module — no extra
> dependency to add.

> WebSocket needs HTTP/1.1 connection takeover. HTTP/2 multiplexes streams over a
> single TCP connection, so it can't be hijacked — the middleware returns
> **426 Upgrade Required** for HTTP/2 upgrade requests
> (`celeris/middleware/websocket/websocket.go:69`).

## Echo-server quickstart

Register `websocket.New` on a `GET` route. Your `Handler` receives a
`*websocket.Conn` and should **block** until the connection is done — when it
returns, the connection is closed automatically.

```go
package main

import (
    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/middleware/websocket"
)

func main() {
    s := celeris.New(celeris.Config{Addr: ":8080"})

    s.GET("/ws", websocket.New(websocket.Config{
        Handler: func(c *websocket.Conn) {
            for {
                mt, msg, err := c.ReadMessage()
                if err != nil {
                    return // peer closed, or read error → exit the loop
                }
                if err := c.WriteMessage(mt, msg); err != nil {
                    return
                }
            }
        },
    }))

    s.Start()
}
```

That's a complete RFC 6455 echo server. `Handler` is the only required field;
`websocket.New` **panics** at registration if it is `nil`
(`celeris/middleware/websocket/config.go:170`).

A few rules to internalise from the start:

- The middleware is a normal `HandlerFunc`. **Non-WebSocket requests are passed
  through** to the next handler, so you can stack it with other middleware on the
  same route (`celeris/middleware/websocket/websocket.go:64`).
- WebSocket routes are **async by construction** — registering
  `s.GET("/ws", websocket.New(cfg))` is all you need. You do **not** (and should
  not bother to) call `.Async()`: it would have no effect here. Note that
  `.Async()` is a method on the `*Route` that `s.GET(...)` returns, *not* on the
  `HandlerFunc` that `websocket.New` returns — so `websocket.New(cfg).Async()`
  does **not compile**. If you ever want to chain it explicitly, it goes on the
  route: `s.GET("/ws", websocket.New(cfg)).Async()` (still unnecessary).
- Never force a WebSocket route to run inline. Handlers that take over the
  connection are async by construction — do **not** call `.Sync()` on the route
  or its group. See [Routing](/docs/routing).
- When `Handler` returns, Celeris sends a normal close frame (code `1000`) if you
  haven't already and closes the connection
  (`celeris/middleware/websocket/websocket.go:137`).

### Reading request data inside the handler

Route params, query params, and request headers are **captured at upgrade time**
and read off the `*Conn` (not a `*Context`):

```go
// Route: /ws/:room
s.GET("/ws/:room", websocket.New(websocket.Config{
    Handler: func(c *websocket.Conn) {
        room  := c.Param("room")    // route parameter
        token := c.Query("token")   // query parameter ?token=...
        ua    := c.Header("user-agent")
        _ = room
        _ = token
        _ = ua
        // ...
    },
}))
```

## The `Conn` API

`*websocket.Conn` is the connection handle (`celeris/middleware/websocket/conn.go:38`).
All write methods (`WriteMessage`, `WriteText`, `WriteBinary`, `WriteJSON`,
`WritePing`, `WriteControl`) are internally serialised behind a single write lock,
so calling them from several goroutines concurrently is safe — each complete
message arrives intact. Reading, however, is single-goroutine: have at most **one**
goroutine in `ReadMessage`/`ReadMessageReuse`/`NextReader` at a time. The common
pattern is one read loop plus any number of writer goroutines
(`celeris/middleware/websocket/doc.go:30-32`).

### Reading messages

| Method                                            | Returns                  | Notes                                                                 |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `ReadMessage() (MessageType, []byte, error)`      | type, owned copy, error  | Safe to retain/store/pass to other goroutines.                       |
| `ReadMessageReuse() (MessageType, []byte, error)` | type, reused buffer, error | Zero-alloc; the slice is valid **only until the next read call**.   |
| `ReadJSON(v any) error`                           | error                    | Reads the next message and `json.Unmarshal`s it into `v`.            |

`ReadMessage` returns an **owned copy** of the payload — keep it, send it to
another goroutine, store it in a map, whatever. `ReadMessageReuse` hands back an
internal buffer that is overwritten on the next read; use it for echo servers and
forwarding proxies where you process the message immediately and don't retain it
(`celeris/middleware/websocket/conn.go:394`, `:411`).

```go
// Owned copy — safe to keep:
mt, msg, err := c.ReadMessage()

// Zero-alloc — process before the next read:
mt, msg, err := c.ReadMessageReuse()

// JSON decode straight off the wire:
var cmd struct{ Action string `json:"action"` }
if err := c.ReadJSON(&cmd); err != nil {
    return
}
```

`MessageType` is one of `websocket.TextMessage` or `websocket.BinaryMessage`
(`celeris/middleware/websocket/conn.go:29-33`). Control frames (ping/pong/close)
are handled transparently by the read loop and never surface from
`ReadMessage`/`ReadMessageReuse`.

### Writing messages

| Method                                                  | Sends                                                |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `WriteMessage(messageType MessageType, data []byte) error` | A complete text or binary message.                |
| `WriteText(data []byte) error`                          | A text message (`WriteMessage(TextMessage, …)`).     |
| `WriteBinary(data []byte) error`                        | A binary message (`WriteMessage(BinaryMessage, …)`). |
| `WriteJSON(v any) error`                                | `json.Marshal(v)` sent as a **text** message.        |
| `WritePing(data []byte) error`                          | A ping control frame. Keep `data` ≤ 125 bytes — this method does **not** validate the length (`WriteControl` does). |
| `WriteControl(messageType int, data []byte, deadline time.Time) error` | A control frame with a per-frame deadline. Returns `ErrControlTooLarge` if `data` > 125 bytes. |

```go
c.WriteText([]byte("hello"))
c.WriteBinary(blob)
c.WriteJSON(map[string]any{"type": "tick", "n": 42})
c.WritePing(nil)
```

If compression has been negotiated and a data payload is at least the compression
threshold, `WriteMessage` compresses it transparently — and only keeps the
compressed form if it actually came out smaller
(`celeris/middleware/websocket/conn.go:591`).

`WriteControl` is the right tool for pings/pongs/close from a separate goroutine
under load: it acquires the write lock **with a deadline** so a stalled large
write can't block your keepalive forever, returning `websocket.ErrWriteTimeout`
if it can't get the lock in time. Its `messageType` parameter is a plain `int`
that must hold a control opcode (`websocket.OpClose`, `websocket.OpPing`,
`websocket.OpPong`) — convert with `int(...)` because those constants are typed
`websocket.Opcode` — and `data` must be ≤ 125 bytes
(`celeris/middleware/websocket/conn.go:718`).

```go
err := c.WriteControl(
    int(websocket.OpPing),
    []byte("keepalive"),
    time.Now().Add(5*time.Second),
)
if err == websocket.ErrWriteTimeout {
    // couldn't grab the write lock in time
}
```

### Ping / pong / close handlers

Override the default control-frame behaviour with the setter methods. **Set them
before you start the read loop** — they aren't safe to swap mid-flight
(`celeris/middleware/websocket/conn.go:992-1001`).

| Method                                                    | Default behaviour                                            |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `SetPingHandler(func(data []byte) error)`                | Replies with a pong carrying the same payload.              |
| `SetPongHandler(func(data []byte) error)`                | No-op.                                                      |
| `SetCloseHandler(func(code int, text string) error)`     | Echoes the close frame back and returns a `*CloseError`.   |

The matching getters `PingHandler()`, `PongHandler()`, and `CloseHandler()`
return the current handler.

#### Keepalive with ping/pong

A classic pattern: send pings on a ticker, and reset the read deadline whenever a
pong comes back. If the peer goes silent, the next read hits the deadline and the
loop exits.

```go
Handler: func(c *websocket.Conn) {
    c.SetPongHandler(func(data []byte) error {
        return c.SetReadDeadline(time.Now().Add(60 * time.Second))
    })
    _ = c.SetReadDeadline(time.Now().Add(60 * time.Second))

    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            if err := c.WritePing(nil); err != nil {
                return
            }
        }
    }()

    for {
        mt, msg, err := c.ReadMessage()
        if err != nil {
            return
        }
        _ = c.WriteMessage(mt, msg)
    }
},
```

> On native engines (epoll/io_uring) `SetReadDeadline` is a no-op (the underlying
> `net.Conn` isn't exposed) — see [Engine behavior](#engine-behavior). For a
> deadline that works on **every** engine, configure
> [`IdleTimeout`](#config) instead, which both paths honour.

### Closing the connection

| Method                                       | Behaviour                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `GracefulClose(code int, text string) error` | Sends a close frame and waits (up to ~5s) for the peer's close response.    |
| `Close() error`                              | Closes the underlying connection immediately.                               |

```go
// Polite shutdown: tell the peer why, then drain its close response.
c.GracefulClose(websocket.CloseNormalClosure, "bye")
```

You usually don't need to call either — returning from `Handler` triggers an
automatic close-frame send and `Close`. Use `GracefulClose` when you want a clean
RFC 6455 closing handshake before exiting (`celeris/middleware/websocket/conn.go:799`).

### Connection metadata

| Method                       | Returns                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `NetConn() net.Conn`         | Underlying `net.Conn` on the std (hijack) path; **`nil` on native engines**. |
| `Context() context.Context`  | Connection context, cancelled when the connection closes.                 |
| `Subprotocol() string`       | The negotiated subprotocol, or `""` if none.                              |
| `RemoteAddr() net.Addr`      | Peer address (`nil` when `NetConn` is `nil`).                              |
| `LocalAddr() net.Addr`       | Local address (`nil` when `NetConn` is `nil`).                            |
| `IP() string`                | Peer IP without port; result is cached after the first call.              |
| `Param(key) string`          | Route parameter captured at upgrade time.                                 |
| `Query(key) string`          | Query parameter captured at upgrade time.                                 |
| `Header(key) string`         | Request header captured at upgrade time.                                  |
| `Locals(key) any`            | Per-connection value (concurrency-safe).                                  |
| `SetLocals(key, val)`        | Store a per-connection value (concurrency-safe).                          |

`Locals`/`SetLocals` give you a concurrency-safe per-connection bag — handy for
stashing an authenticated user ID at connect time and reading it during
broadcasts (`celeris/middleware/websocket/conn.go:922-939`).

```go
Handler: func(c *websocket.Conn) {
    c.SetLocals("userID", c.Query("uid"))
    // ...later, from any goroutine...
    uid := c.Locals("userID")
    _ = uid
},
```

### Deadlines and limits

| Method                                  | Behaviour                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `SetReadLimit(limit int64)`             | Maximum message size in bytes (default 64MB). Oversize messages close with `1009`.    |
| `SetReadDeadline(t time.Time) error`    | Per-read deadline. **Returns `nil` (no-op) on native engines.**                       |
| `SetWriteDeadline(t time.Time) error`   | Per-write deadline. **Returns `nil` (no-op) on native engines.**                      |

`SetReadDeadline`/`SetWriteDeadline` delegate to the underlying `net.Conn`, which
only exists on the std (hijack) path; on native engines they are no-ops
(`celeris/middleware/websocket/conn.go:976`, `:985`). For portable idle
enforcement use [`Config.IdleTimeout`](#config).

### Runtime compression control

If compression was negotiated, you can toggle it per connection:

- `EnableWriteCompression(enable bool)` — turn write compression on/off for this
  connection (only meaningful after negotiation).
- `SetCompressionLevel(level int) error` — set the flate level for subsequent
  writes; valid range `-2`…`9`, else returns an error
  (`celeris/middleware/websocket/conn.go:1015-1027`).

### Streaming large messages

`WriteMessage`/`ReadMessage` buffer a whole message in memory. For payloads too
large to hold at once, stream them frame-by-frame:

| Method                                                      | Returns                                  |
| ---------------------------------------------------------- | ---------------------------------------- |
| `NextWriter(messageType MessageType) (io.WriteCloser, error)` | A writer; each `Write` sends a frame, `Close` finalises the message. |
| `NextReader() (MessageType, io.Reader, error)`             | The next message as a streaming `io.Reader`. |

```go
// Send a large body in chunks:
w, err := c.NextWriter(websocket.BinaryMessage)
if err != nil {
    return
}
if _, err := io.Copy(w, src); err != nil {
    _ = w.Close()
    return
}
_ = w.Close() // Close sends the final (FIN) frame — required.

// Read a message as a stream:
mt, r, err := c.NextReader()
if err != nil {
    return
}
_, _ = io.Copy(dst, r)
_ = mt
```

Rules from the source (`celeris/middleware/websocket/writer.go:21-48`,
`celeris/middleware/websocket/reader.go:70-79`):

- **Only one writer may be active at a time.** Calling `WriteMessage`,
  `WriteText`, `WriteBinary`, or `WriteJSON` while a `NextWriter` is open returns
  an error (`celeris/middleware/websocket/conn.go:595`). Control frames
  (ping/pong/close via `WritePing`/`WriteControl`) *can* still be sent
  concurrently.
- **You must call `Close()` on the writer** to send the final frame; until then
  the message is incomplete on the wire.
- The `io.Reader` from `NextReader` is valid only until the next `NextReader`,
  `ReadMessage`, or `Close` call.
- When compression is negotiated, `NextWriter` buffers the whole message and
  compresses on `Close` (permessage-deflate context spans the entire message).

## Config

`websocket.Config` (`celeris/middleware/websocket/config.go:46`) is passed to
`websocket.New`. Only `Handler` is required.

| Field                    | Type                              | Default        | Purpose                                                                                  |
| ------------------------ | --------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `Handler`                | `func(*Conn)`                     | — (required)   | Runs after a successful upgrade; blocks until the connection is done.                     |
| `Skip`                   | `func(*celeris.Context) bool`     | `nil`          | Skip the middleware for matching requests.                                                |
| `SkipPaths`              | `[]string`                        | `nil`          | Skip exact paths (matched on `c.Path()`).                                                 |
| `CheckOrigin`            | `func(*celeris.Context) bool`     | same-origin    | Accept/reject the request origin. See [Origin checking](#origin-checking).               |
| `Subprotocols`           | `[]string`                        | `nil`          | Server-supported subprotocols, in preference order.                                      |
| `ReadBufferSize`         | `int`                             | `4096`         | I/O read buffer size in bytes.                                                            |
| `WriteBufferSize`        | `int`                             | `4096`         | I/O write buffer size in bytes.                                                           |
| `ReadLimit`              | `int64`                           | `64MB`         | Maximum message size; oversize messages close with `1009`.                               |
| `HandshakeTimeout`       | `time.Duration`                   | `0` (none)     | Deadline for the upgrade handshake (std/hijack path).                                     |
| `IdleTimeout`            | `time.Duration`                   | `0` (none)     | Max time between messages before close; works on **all** engines.                        |
| `EnableCompression`      | `bool`                            | `false`        | Negotiate permessage-deflate (RFC 7692).                                                  |
| `CompressionLevel`       | `int`                             | `1` (best speed) | Flate level, `-2`…`9` (effective only when compression is enabled).                     |
| `CompressionThreshold`   | `int`                             | `128`          | Minimum payload size in bytes before a message is compressed.                            |
| `MaxBackpressureBuffer`  | `int`                             | `256`          | Inbound chunk buffer on the engine path; native engines only.                            |
| `BackpressureHighPct`    | `int`                             | `75`           | Fill % at which the engine pauses inbound delivery.                                       |
| `BackpressureLowPct`     | `int`                             | `25`           | Fill % at which the engine resumes inbound delivery (must be `< HighPct`).               |
| `OnConnect`              | `func(*Conn) error`               | `nil`          | Runs after upgrade, before `Handler`; a non-nil error closes the connection.             |
| `OnDisconnect`           | `func(*Conn)`                     | `nil`          | Runs after `Handler` returns.                                                             |
| `WriteBufferPool`        | `BufferPool`                      | `nil`          | Pool write buffers across connections (std/hijack path only).                            |

Defaults are applied in `applyDefaults` (`celeris/middleware/websocket/config.go:141`).
Note `CompressionLevel` and `CompressionThreshold` defaults are only filled in
when `EnableCompression` is true.

### Connect / disconnect hooks

`OnConnect` is your authorization checkpoint: it runs **after** the upgrade
completes but **before** `Handler`, and returning an error closes the connection
cleanly without ever invoking `Handler`. `OnDisconnect` always runs after
`Handler` returns — good for teardown like deregistering from a broadcast set.

```go
websocket.New(websocket.Config{
    OnConnect: func(c *websocket.Conn) error {
        if c.Query("token") != "secret" {
            return errors.New("unauthorized")
        }
        c.SetLocals("authed", true)
        return nil
    },
    OnDisconnect: func(c *websocket.Conn) {
        log.Printf("closed: %s", c.IP())
    },
    Handler: echo,
})
```

### Compression (permessage-deflate)

Enable RFC 7692 compression with `EnableCompression: true`. It's negotiated
during the handshake, so it only kicks in when the client also supports it.
Messages below `CompressionThreshold` (default 128 bytes) are sent uncompressed,
and even above the threshold the compressed form is only used if it's actually
smaller.

```go
websocket.New(websocket.Config{
    EnableCompression:    true,
    CompressionLevel:     websocket.CompressionLevelBestSpeed, // 1 (default)
    CompressionThreshold: 256,
    Handler:              echo,
})
```

Compression-level constants (`celeris/middleware/websocket/compress.go:11-19`):

| Constant                              | Value | Meaning              |
| ------------------------------------- | ----- | -------------------- |
| `websocket.CompressionLevelHuffman`   | `-2`  | Huffman only         |
| `websocket.CompressionLevelDefault`   | `-1`  | flate default        |
| `websocket.CompressionLevelBestSpeed` | `1`   | best speed (default) |
| `websocket.CompressionLevelBestSize`  | `9`   | best compression     |

### Backpressure (native engines)

On native engines the middleware keeps a bounded buffer of inbound chunks between
the engine's event loop and your handler goroutine. When it fills past
`BackpressureHighPct` of `MaxBackpressureBuffer`, the engine **pauses** inbound
delivery for that connection, which closes the kernel's TCP receive window and
slows the peer at the network level; when it drains below `BackpressureLowPct`,
delivery resumes (`celeris/middleware/websocket/config.go:112-129`). This is fully
automatic — the defaults (256 / 75% / 25%) suit most workloads.

You can observe health with `Conn.BackpressureDropped()`, which should always be
`0` in normal operation. A non-zero value means the engine pause/resume mechanism
isn't keeping up. It always returns `0` on the std (hijack) path, where the kernel
TCP stack handles backpressure directly (`celeris/middleware/websocket/conn.go:887`).

### Write-buffer pooling (std/hijack path)

`WriteBufferPool` lets you share `*bufio.Writer` instances across connections to
cut per-connection memory for many idle sockets. It is **only consulted on the
std (hijack) path** — native engines pool their own write buffer internally and
ignore this setting (`celeris/middleware/websocket/conn.go:206`,
`celeris/middleware/websocket/websocket.go:319`). Implement the `BufferPool`
interface (`Get(dst io.Writer) *bufio.Writer` and `Put(*bufio.Writer)`); the
typical implementation wraps a `sync.Pool` and `Reset(dst)`s the writer on
borrow (`celeris/middleware/websocket/config.go:28`).

## Broadcasting to many connections (Hub)

Real-time apps usually need to push one message to *every* connected client
(chat, live tickers, presence). `websocket.Hub` is the built-in fan-out
abstraction: register connections, broadcast to all (or a filtered subset),
unregister on disconnect. It encodes each frame **once** per broadcast and reuses
it across every connection, so the wire-encoding cost is O(1) regardless of
subscriber count (`celeris/middleware/websocket/hub.go:56`).

```go
hub := websocket.NewHub(websocket.HubConfig{})

s.GET("/ws", websocket.New(websocket.Config{
    Handler: func(c *websocket.Conn) {
        unregister := hub.Register(c) // MUST be deferred
        defer unregister()
        for {
            if _, _, err := c.ReadMessage(); err != nil {
                return
            }
        }
    },
}))

// From any goroutine / publisher in your app:
hub.Broadcast(websocket.TextMessage, []byte(`{"type":"tick"}`))
```

`Register` returns an unregister function you **must** defer; it is safe to call
twice and a no-op after `Hub.Close` (`celeris/middleware/websocket/hub.go:92`).

| Method                                                                 | Returns / behaviour                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `NewHub(cfg HubConfig) *Hub`                                          | Construct a hub.                                                           |
| `Register(c *Conn) func()`                                            | Add a conn; returns the unregister func to defer.                         |
| `Broadcast(messageType MessageType, data []byte) (delivered int, err error)` | Send to every registered conn.                                    |
| `BroadcastFilter(mt MessageType, data []byte, pred func(*Conn) bool) (int, error)` | Send only to conns where `pred` returns `true`.            |
| `BroadcastPrepared(pm *PreparedMessage) (int, error)`                | Send an already-encoded message (see below).                              |
| `Len() int`                                                          | Current registered-conn count.                                            |
| `Close()`                                                            | Unregister and close every conn; drains in-flight broadcasts first.       |

`Broadcast` returns the number of connections reached and the first per-conn
error (if any). Authorize the connection **before** `Register` — the hub
broadcasts to every registered conn unfiltered.

### Room / channel routing

Use `BroadcastFilter` with a predicate over `Conn.Locals` to target a subset
without maintaining a second hub (`celeris/middleware/websocket/hub.go:153`):

```go
// On connect, tag the conn with its room:
c.SetLocals("room", c.Param("room"))

// Publish to one room only:
hub.BroadcastFilter(websocket.TextMessage, payload, func(c *websocket.Conn) bool {
    return c.Locals("room") == "lobby"
})
```

### Handling slow or dead connections

By default a conn whose write fails during a broadcast is unregistered **and
closed**. Override with `HubConfig.OnSlowConn`, returning a `HubPolicy`
(`celeris/middleware/websocket/hub.go:10-37`):

| Policy             | Effect                                                          |
| ------------------ | -------------------------------------------------------------- |
| `HubPolicyDrop`    | Skip this message; keep the conn registered.                   |
| `HubPolicyRemove`  | Unregister the conn but leave its lifecycle to you.            |
| `HubPolicyClose`   | Unregister **and** close the conn. Default.                    |

```go
hub := websocket.NewHub(websocket.HubConfig{
    OnSlowConn: func(c *websocket.Conn, err error) websocket.HubPolicy {
        return websocket.HubPolicyClose // boot misbehaving peers
    },
})
```

`Hub.Close` waits for every in-flight broadcast to finish before tearing down
conns, so a shutdown path that synchronises on `Close` cannot race a still
fanning-out message (`celeris/middleware/websocket/hub.go:315`).

### Bounding broadcast concurrency

A `Broadcast` fans out to every conn concurrently. `HubConfig.MaxConcurrency`
caps how many of those per-conn writes run at once via a semaphore, keeping
goroutine pressure bounded on very large hubs
(`celeris/middleware/websocket/hub.go:46`). Leave it `0` (the default) to use
`DefaultHubConcurrency()` — `runtime.GOMAXPROCS(0) * 4`
(`celeris/middleware/websocket/hub.go:54`):

```go
hub := websocket.NewHub(websocket.HubConfig{
    MaxConcurrency: 256, // cap in-flight per-conn writes during a Broadcast
})
```

### Reusing an encoded message

When you publish the same payload repeatedly, build a `PreparedMessage` once and
reuse it. The frame is encoded a single time (with separate cached
uncompressed/compressed variants) and shared across every send
(`celeris/middleware/websocket/prepared.go:9-54`):

```go
pm, err := websocket.NewPreparedMessage(websocket.TextMessage, payload)
if err != nil {
    return
}
hub.BroadcastPrepared(pm)   // fan-out
// or, per-connection:
_ = conn.WritePreparedMessage(pm)
```

`NewPreparedMessage` rejects control opcodes (ping/pong/close) and returns
`websocket.ErrInvalidPreparedOpcode` — control frames have RFC 6455 §5.5 size
constraints the cache-and-reuse model can't honour; use `WriteControl`
per-connection for those (`celeris/middleware/websocket/prepared.go:42`).

## Origin checking

By default the middleware enforces a **same-origin** policy: the request's
`Origin` header host must match the `Host` header
(`celeris/middleware/websocket/websocket.go:84`). This protects against
cross-site WebSocket hijacking (CSWSH) from a malicious page. The exact default
behaviour:

- `Origin` present but cross-origin → **403**.
- `Origin` missing on an **`https`** request → **403** (treated as a CSRF-class
  signal).
- `Origin` missing on plain **`http`** → allowed (loopback dev tools and CLI
  clients commonly omit it).

Override it with `CheckOrigin`, which returns `true` to accept the request:

```go
// Allow all origins (only if you really mean it — disables CSWSH protection):
websocket.New(websocket.Config{
    CheckOrigin: func(c *celeris.Context) bool { return true },
    Handler:     echo,
})

// Restrict to an allow-list:
allowed := map[string]bool{
    "https://app.example.com": true,
    "https://admin.example.com": true,
}
websocket.New(websocket.Config{
    CheckOrigin: func(c *celeris.Context) bool {
        return allowed[c.Header("origin")]
    },
    Handler: echo,
})
```

When `CheckOrigin` is set, the built-in same-origin logic is bypassed entirely —
your function is the sole gate. A rejected origin yields **403** with body
`websocket: origin not allowed` (`celeris/middleware/websocket/websocket.go:82`).

> **Don't reflexively allow all origins.** `func(*celeris.Context) bool { return
> true }` disables the browser's only built-in defence against another site
> opening an authenticated socket to your server. Prefer an explicit allow-list,
> or pair an allow-all policy with a token check in `OnConnect`.

## Close handling

When the peer sends a close frame, the read loop returns a `*CloseError` from the
default close handler (`celeris/middleware/websocket/conn.go:1029`):

```go
type CloseError struct {
    Code int
    Text string
}
```

Classify it with the helpers:

| Function                                              | Returns `true` when…                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `IsCloseError(err error, codes ...int) bool`         | `err` is a `*CloseError` whose code is in `codes`.                  |
| `IsUnexpectedCloseError(err error, expected ...int)` | `err` is a `*CloseError` whose code is **not** in `expected`.       |
| `FormatCloseMessage(code int, text string) []byte`   | Builds a close-frame payload (code + text) for `WriteControl`.      |

```go
for {
    _, msg, err := c.ReadMessage()
    if err != nil {
        if websocket.IsUnexpectedCloseError(err,
            websocket.CloseNormalClosure,
            websocket.CloseGoingAway,
        ) {
            log.Printf("abnormal close: %v", err)
        }
        return
    }
    _ = msg
}
```

The standard RFC 6455 close codes are exported as constants
(`celeris/middleware/websocket/opcode.go:28-43`):

| Constant                          | Code   | Meaning                       |
| --------------------------------- | ------ | ----------------------------- |
| `CloseNormalClosure`              | `1000` | Normal closure                |
| `CloseGoingAway`                  | `1001` | Endpoint going away           |
| `CloseProtocolError`              | `1002` | Protocol error                |
| `CloseUnsupportedData`            | `1003` | Unacceptable data type        |
| `CloseNoStatusReceived`           | `1005` | No status code (reserved)     |
| `CloseAbnormalClosure`            | `1006` | Abnormal closure (reserved)   |
| `CloseInvalidPayload`             | `1007` | Invalid payload data          |
| `ClosePolicyViolation`            | `1008` | Policy violation              |
| `CloseMessageTooBig`              | `1009` | Message too big               |
| `CloseMandatoryExt`               | `1010` | Mandatory extension missing   |
| `CloseInternalError`              | `1011` | Internal server error         |
| `CloseServiceRestart`            | `1012` | Service restart               |
| `CloseTryAgainLater`              | `1013` | Try again later               |

Send a specific close code to the peer with `GracefulClose` (which also waits for
the peer's response) or with `WriteControl` + `FormatCloseMessage`:

```go
_ = c.WriteControl(
    int(websocket.OpClose),
    websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "too noisy"),
    time.Now().Add(time.Second),
)
```

## Engine behavior

The same `Handler` runs on every engine, but the I/O underneath differs in ways
worth knowing (`celeris/middleware/websocket/doc.go:41-44`):

| Aspect                | Native engines (epoll, io_uring)                                        | std engine (hijack)                                     |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Connection ownership  | Stays in the event loop; reads delivered to the handler goroutine.     | Connection is hijacked; handler reads/writes directly. |
| `NetConn()`           | Returns `nil`.                                                          | Returns the live `*net.TCPConn`.                        |
| `SetReadDeadline` / `SetWriteDeadline` | No-op (returns `nil`).                                 | Applied to the underlying socket.                       |
| `IdleTimeout`         | Enforced via the engine's idle sweep.                                   | Enforced via `net.Conn.SetReadDeadline`.               |
| Backpressure          | Engine-integrated (TCP receive window); see [Backpressure](#backpressure-native-engines). | Handled by the kernel TCP stack.       |
| `WriteBufferPool`     | Ignored (engine pools its own write buffer).                            | Consulted.                                              |

The practical takeaways:

1. **Don't rely on `NetConn()` or `SetReadDeadline`/`SetWriteDeadline` for
   portable code.** They only do something on the std engine. For an idle
   timeout that works everywhere, set `Config.IdleTimeout` — both paths converge
   to the same observable behaviour (`celeris/middleware/websocket/config.go:104-110`).
2. **Backpressure tuning only matters on native engines.** On the std path the
   relevant fields are simply ignored.

## The low-level alternative

For advanced cases the `*celeris.Context` exposes the primitives the middleware
is built on. Reach for these only when the middleware doesn't fit — most
applications never need them.

| Method                                                    | Use                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `c.Hijack() (net.Conn, error)`                           | Take over the raw TCP connection (HTTP/1.1 only; HTTP/2 fails).     |
| `c.UpgradeWebSocket(delivery func([]byte)) bool`         | Engine-integrated upgrade; `false` if the engine doesn't support it. |

`Hijack` hands you the raw `net.Conn` and makes you responsible for the
handshake, framing, and closing it (`celeris/context_response.go:1256`).
`UpgradeWebSocket` installs a data-delivery callback for the native engine path
and returns `false` on the std engine, where you fall back to `Hijack`
(`celeris/context_response.go:1290`). Driving these correctly means
re-implementing RFC 6455 yourself — the `websocket` middleware exists precisely so
you don't have to. For other long-lived response patterns built on the same
primitives, see [Streaming responses](/docs/streaming).

## Common pitfalls

- **`Handler` must block.** Returning early closes the connection. Run your read
  loop (and any keepalive ticker) inside the handler and only return when you want
  to disconnect.
- **`Handler: nil` panics at startup.** It's the one required field
  (`celeris/middleware/websocket/config.go:170`).
- **Never `.Sync()` a WebSocket route.** WebSocket handlers are async by
  construction; forcing them inline breaks them (see [Routing](/docs/routing)).
- **`ReadMessageReuse` slices are transient.** The returned buffer is overwritten
  on the next read — copy it (or use `ReadMessage`) if you keep it past the next
  read call.
- **Allow-all origins disables CSWSH protection.** Prefer an allow-list or a token
  check in `OnConnect`.
- **`NetConn()` / `SetReadDeadline` are `nil` / no-ops on native engines.** Use
  `Config.IdleTimeout` for a portable idle timeout.
- **`WriteControl` data is capped at 125 bytes** and the opcode must be a control
  opcode, or it returns an error (`celeris/middleware/websocket/conn.go:718`).

## FAQ

**Why am I getting a 426 response?**
The request arrived over HTTP/2, which can't be hijacked. WebSocket requires
HTTP/1.1 (`celeris/middleware/websocket/websocket.go:69`).

**Why does my upgrade return 403?**
The default same-origin check rejected it — either the `Origin` host didn't match
`Host`, or `Origin` was missing on an `https` request. Set `Config.CheckOrigin`
for non-browser clients or cross-origin setups
(`celeris/middleware/websocket/websocket.go:84`).

**Can I read and write from different goroutines?**
Yes. One goroutine may read while others write — all write methods are internally
serialised. Just don't have two goroutines reading, or two writing the same
message at once.

**How do I cap message size?**
Set `Config.ReadLimit` (or call `Conn.SetReadLimit` at runtime). The default is
64MB; oversize messages close the connection with code `1009`
(`celeris/middleware/websocket/config.go:74`).

**How do I time out idle connections on every engine?**
Set `Config.IdleTimeout`. Unlike `SetReadDeadline`, it's honoured on both the
native and std paths (`celeris/middleware/websocket/config.go:104`).

**Does the middleware send a close frame for me?**
Yes — when `Handler` returns, Celeris sends a `1000` close frame (if you haven't
already) and closes the connection. Use `GracefulClose` if you want to send a
specific code and wait for the peer's close response.

## See also

- [Streaming responses](/docs/streaming) — incremental output and the low-level
  `StreamWriter`/`Detach`/`Hijack` primitives the upgrade is built on.
- [Server-Sent Events](/docs/sse) — one-way push when you don't need full duplex.
- [Routing](/docs/routing) — registering the `GET` route and why WebSocket routes
  are async.
- [Middleware](/docs/middleware) — composing the WebSocket middleware with the
  rest of your stack.
