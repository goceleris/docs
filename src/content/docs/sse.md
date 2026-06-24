---
title: Server-Sent Events
description: "Stream events to browsers with the SSE middleware: heartbeats, slow-client policies, brokers, and Last-Event-ID replay."
group: Real-Time
order: 2
---

Server-Sent Events (SSE) is the simplest way to push a continuous, one-way stream
of updates from your server to a browser. The client opens a single long-lived
`GET` with the standard [`EventSource`](https://developer.mozilla.org/docs/Web/API/EventSource)
API, the server holds the connection open and writes `text/event-stream` frames,
and the browser handles reconnection automatically. No upgrade handshake, no
framing protocol — just HTTP.

Celeris ships a dedicated `middleware/sse` package that handles the wire format,
heartbeats, disconnect detection, slow-client backpressure, multi-subscriber
fan-out, and `Last-Event-ID` replay for you. This page documents that package.

> **Import path:** `github.com/goceleris/celeris/middleware/sse`. For two-way
> communication, reach for [WebSocket](/docs/websocket) instead; for raw chunked
> output that isn't event-shaped, see [Streaming](/docs/streaming).

## Two ways to do SSE

There are two layers you can build on, depending on how much control you want.

**Low-level — `Context.StreamWriter` + `Detach`.** You detach the connection from
the request lifecycle, write SSE-formatted bytes yourself, and manage the loop.
This is covered on the [Streaming](/docs/streaming) page. You own everything:
header flushing, heartbeats, `Last-Event-ID` parsing, the event format. Use it
only when you have an unusual requirement the middleware doesn't cover.

**The `sse` middleware (recommended).** You write a `Handler` that receives a
`*sse.Client` and calls `Send`. The middleware does the detach, flushes the SSE
response headers, runs heartbeats, formats every event, detects disconnects, and
(optionally) handles slow-client policy and reconnect replay. The rest of this
page is about this path.

```go
import "github.com/goceleris/celeris/middleware/sse"

s.GET("/events", sse.New(sse.Config{
    Handler: func(client *sse.Client) {
        client.SendData("hello")
    },
}))
```

`sse.New` returns a `celeris.HandlerFunc`, so it registers like any other handler
(see [Routing](/docs/routing)). It works across **all** Celeris engines — std,
epoll, and io_uring — because the middleware detaches the connection internally;
you never manage the event-loop lifecycle yourself. Source:
`celeris/middleware/sse/sse.go:307`.

## Basic usage

The handler runs once per connected client and **blocks for the lifetime of the
connection**. When it returns, the stream is closed automatically. The typical
shape is a loop that selects on `client.Context().Done()` (the client
disconnected) and your event source.

```go
s.GET("/clock", sse.New(sse.Config{
    Handler: func(client *sse.Client) {
        ticker := time.NewTicker(time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-client.Context().Done():
                return // client disconnected — exit the handler
            case t := <-ticker.C:
                if err := client.Send(sse.Event{
                    Event: "tick",
                    Data:  t.Format(time.RFC3339),
                }); err != nil {
                    return // write failed — connection is gone
                }
            }
        }
    },
}))
```

On the browser side:

```js
const es = new EventSource("/clock");
es.addEventListener("tick", (e) => console.log("server time:", e.data));
```

### The `Client` API

Everything you do inside a handler goes through the `*sse.Client`.
Source: `celeris/middleware/sse/sse.go`.

| Method                              | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `Send(e Event) error`               | Send a full event (id, event type, data, retry). Thread-safe.           |
| `SendData(data string) error`       | Convenience for `Send(Event{Data: data})`.                              |
| `SendComment(text string) error`    | Send a comment line (`: text`). Useful for custom keep-alives.          |
| `Close() error`                     | Close the stream early. Idempotent; safe to call multiple times.        |
| `Context() context.Context`         | Cancelled when the client disconnects or the stream is closed.          |
| `LastEventID() string`              | The `Last-Event-ID` header sent on reconnect (`""` on first connect).   |
| `DroppedEvents() uint64`            | Events dropped under a slow-client policy (see below). Zero unless queued. |
| `QueueDepth() int`                  | Current outbound-queue length (zero in default blocking mode).          |
| `WritePreparedEvent(*PreparedEvent) error` | Write a pre-formatted event without re-encoding. Used by the broker. |

The return contract for `Send` is worth internalising:

- **non-nil error** — the event was *not* delivered (client closed, context
  cancelled, or the write failed). The caller should stop and let the handler
  return. A `Close()`'d client returns `sse.ErrClientClosed`; a connection whose
  context was already cancelled returns that context error (e.g. `context.Canceled`).
  Don't switch on the specific error — any non-nil value means "stop".
- **nil error (default mode)** — the event was written to the wire and flushed.
- **nil error (queued mode)** — the event was *enqueued or dropped* per your
  slow-client policy; check `DroppedEvents()` to detect drops.

Source: `celeris/middleware/sse/sse.go:48-75`.

> Always check the error from `Send` and bail out on non-nil. A failed write
> cancels the client's context, so the next loop iteration would otherwise spin.

### Sending different event shapes

```go
// Data only — the browser fires the generic "message" event.
client.SendData(`{"status":"ok"}`)

// Named event type — the browser fires this name via addEventListener.
client.Send(sse.Event{Event: "user.joined", Data: `{"id":42}`})

// With an ID — the browser echoes it back as Last-Event-ID on reconnect.
client.Send(sse.Event{ID: "1001", Event: "msg", Data: "hi"})

// A comment / keep-alive (no event fired client-side).
client.SendComment("still here")
```

## Config

`sse.Config` is the single struct you pass to `sse.New`. Only `Handler` is
required (the middleware panics at registration if it is nil). Source:
`celeris/middleware/sse/config.go`.

| Field               | Type                                            | Default            | Purpose                                                                 |
| ------------------- | ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| `Handler`           | `func(*Client)`                                 | — (required)       | Runs per client; blocks until the stream ends.                        |
| `HeartbeatInterval` | `time.Duration`                                 | `15s`              | Interval between heartbeat comments. **Negative disables.**           |
| `RetryInterval`     | `int` (milliseconds)                            | `0` (no field)     | Sent once as the `retry:` field so the browser uses this reconnect delay. |
| `MaxQueueDepth`     | `int`                                           | `0` (unbounded/blocking) | Bounds the per-client outbound queue. See slow-client handling.   |
| `OnSlowClient`      | `func(*Client, Event) ClientPolicy`             | `ClientPolicyDrop` | Policy when the queue is full. Only consulted when `MaxQueueDepth > 0`. |
| `ReplayStore`       | `ReplayStore`                                   | `nil`              | Enables automatic `Last-Event-ID` replay. See resumable streams.      |
| `OnConnect`         | `func(*celeris.Context, *Client) error`         | `nil`              | Runs before headers are written; return an error to reject the connection. |
| `OnDisconnect`      | `func(*celeris.Context, *Client)`               | `nil`              | Runs after the stream closes.                                         |
| `Skip`              | `func(*celeris.Context) bool`                   | `nil`              | Skip the middleware for matching requests.                            |
| `SkipPaths`         | `[]string`                                       | `nil`              | Skip these exact paths.                                               |

### Heartbeats

A heartbeat is a comment line (`: heartbeat`) written on an interval. It serves
two purposes: it keeps proxies from closing an idle connection, and it surfaces a
broken connection — when the write fails, the middleware cancels the client's
context, which unblocks your handler's `select`.

```go
sse.Config{
    HeartbeatInterval: 30 * time.Second, // custom interval
}

sse.Config{
    HeartbeatInterval: -1, // disable heartbeats entirely
}
```

Setting `HeartbeatInterval` to `0` keeps the default of 15 seconds; only a
**negative** value disables it. Source: `celeris/middleware/sse/config.go:47-50`,
`celeris/middleware/sse/sse.go:516`.

### Reconnect delay

`RetryInterval` (milliseconds) is sent once in the initial `retry:` field. When a
browser's `EventSource` loses the connection, it waits this long before
reconnecting. Leave it `0` to use the browser default (typically ~3s).

```go
sse.Config{RetryInterval: 5000} // browser waits 5s before reconnecting
```

### Connection lifecycle hooks

`OnConnect` runs **before** the SSE response headers are written, so returning a
non-nil error rejects the connection with a real HTTP status code instead of an
empty stream — perfect for auth.

```go
sse.New(sse.Config{
    OnConnect: func(c *celeris.Context, client *sse.Client) error {
        if c.Header("authorization") == "" {
            return celeris.NewHTTPError(401, "auth required")
        }
        return nil
    },
    OnDisconnect: func(c *celeris.Context, client *sse.Client) {
        log.Printf("client gone; dropped=%d", client.DroppedEvents())
    },
    Handler: streamHandler,
})
```

Source: `celeris/middleware/sse/sse.go:358-364`, `:433-435`.

## Slow-client handling

By default (`MaxQueueDepth == 0`), `Send` writes **directly to the wire and
blocks** until the write completes. If one client's TCP buffer fills because the
consumer is slow, that client's `Send` blocks — but since each handler runs in its
own goroutine, it only stalls *that* client's handler.

Set `MaxQueueDepth` to switch to **queued mode**: `Send` enqueues onto a bounded
channel that a per-client drain goroutine writes to the wire, and returns
immediately. When the queue is full at `Send` time, the middleware consults
`OnSlowClient` (or applies `ClientPolicyDrop` if you didn't set one).

```go
sse.New(sse.Config{
    MaxQueueDepth: 256,
    OnSlowClient: func(c *sse.Client, e sse.Event) sse.ClientPolicy {
        // Escalate: tolerate a few drops, then evict a persistently slow client.
        if c.DroppedEvents() > 1000 {
            return sse.ClientPolicyClose
        }
        return sse.ClientPolicyDrop
    },
    Handler: streamHandler,
})
```

### `ClientPolicy` values

Source: `celeris/middleware/sse/config.go:24-39`.

| Policy               | Effect when the queue is full                                                         |
| -------------------- | ------------------------------------------------------------------------------------ |
| `ClientPolicyDrop`   | **(default)** Discard the event, increment `DroppedEvents()`. `Send` returns `nil`.  |
| `ClientPolicyClose`  | Increment `DroppedEvents()`, cancel the client's context (handler exits). `Send` returns `ErrClientClosed`. |
| `ClientPolicyBlock`  | Fall back to blocking: `Send` waits for queue space until the context is cancelled.  |

`Drop` is the sane default for SSE: a missing event leaves the stream coherent
because the next event with a fresh ID supersedes it, and if you've configured a
`ReplayStore`, the client can recover dropped events on reconnect.

### Observing a slow client

Two gauges let you monitor backpressure (both return zero in default blocking
mode):

```go
sse.Config{
    HeartbeatInterval: 10 * time.Second,
    MaxQueueDepth:     128,
    OnDisconnect: func(c *celeris.Context, cl *sse.Client) {
        if d := cl.DroppedEvents(); d > 0 {
            metrics.Add("sse.dropped", float64(d))
        }
    },
}
// Inside the handler you can also gauge live depth:
//   if client.QueueDepth() > 100 { ...degrade gracefully... }
```

Source: `celeris/middleware/sse/sse.go:191-205`.

## Fan-out with a Broker

When one event source feeds **many** subscribers — a chat room, a live
leaderboard, a notification bus — you don't want to re-format the same event N
times or let one slow subscriber block the others. The `Broker` solves both: it
formats each event **once** into a `PreparedEvent`, then non-blocking-sends it to
every subscriber's private bounded queue, each drained by its own goroutine.

```go
broker := sse.NewBroker(sse.BrokerConfig{})

// Every connection subscribes itself and blocks until it disconnects.
s.GET("/feed", sse.New(sse.Config{
    Handler: func(client *sse.Client) {
        unsubscribe := broker.Subscribe(client)
        defer unsubscribe()       // MUST defer — joins the broker's drain goroutine
        <-client.Context().Done() // park until the client leaves
    },
}))

// Anywhere else — an HTTP handler, a Kafka consumer, a goroutine — publish:
s.POST("/announce", func(c *celeris.Context) error {
    broker.Publish(sse.Event{Event: "announce", Data: c.Query("msg")})
    return c.NoContent(204)
})
```

`Subscribe` returns an `unsubscribe` function that the handler **must** defer —
it removes the subscriber and joins its drain goroutine. Calling it twice is safe.
Subscribing to a closed broker is a no-op. Source:
`celeris/middleware/sse/broker.go:145-171`.

### Broker API

Source: `celeris/middleware/sse/broker.go`.

| Method / func                            | Purpose                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `NewBroker(BrokerConfig) *Broker`        | Construct a broker.                                                              |
| `Subscribe(*Client) (unsubscribe func())`| Register a client for every subsequent publish.                                 |
| `Publish(Event) *PreparedEvent`          | Format once, fan out to all subscribers, return the `PreparedEvent`.            |
| `PublishPrepared(*PreparedEvent)`        | Fan out an already-prepared event (no re-encode).                               |
| `SubscriberCount() int`                  | Point-in-time gauge of current subscribers.                                     |
| `CallbackPanics() uint64`                | Count of recovered panics in your `OnSlowSubscriber` callback.                  |
| `Close()`                                | Unsubscribe everyone and reject new `Subscribe` calls. Idempotent.             |

### `BrokerConfig`

All fields are optional. Source: `celeris/middleware/sse/broker.go:33-57`.

| Field                       | Type                                       | Default                | Purpose                                                              |
| --------------------------- | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `SubscriberBuffer`          | `int`                                      | `64`                   | Per-subscriber queue capacity inside the broker.                   |
| `OnSlowSubscriber`          | `func(*Client, *PreparedEvent) BrokerPolicy` | `BrokerPolicyDrop`   | Policy when a subscriber's queue is full at publish time.          |
| `SlowSubscriberConcurrency` | `int`                                      | `GOMAXPROCS*4`         | Caps in-flight slow-path goroutines. Negative opts out (benchmarks only). |

`BrokerPolicy` mirrors `ClientPolicy` (source: `celeris/middleware/sse/broker.go:14-29`):

| Policy                | Effect on a slow subscriber                                         |
| --------------------- | ------------------------------------------------------------------ |
| `BrokerPolicyDrop`    | **(default)** Drop the event for that subscriber only.             |
| `BrokerPolicyRemove`  | Unsubscribe it from the broker, but leave the `Client` open.       |
| `BrokerPolicyClose`   | Unsubscribe **and** close the underlying `Client`.                 |

### `PreparedEvent` — encode once, send many

When you publish to many subscribers, the bytes only need to be formatted once.
`Broker.Publish` does this for you and hands back the `*PreparedEvent`, which you
can reuse — for instance, to feed your replay store, or to publish the identical
bytes to a second broker:

```go
// Format once, fan out to N subscribers, then reuse the same bytes.
pe := broker.Publish(sse.Event{ID: "42", Event: "msg", Data: payload})
log.Printf("broadcast %d bytes to %d subscribers", pe.Len(), broker.SubscriberCount())

// Or build it yourself and publish it (e.g. cache a "hello" event):
hello := sse.NewPreparedEvent(sse.Event{Event: "welcome", Data: "hi"})
broker.PublishPrepared(hello)
```

Source: `celeris/middleware/sse/prepared.go`. A `PreparedEvent` is immutable and
safe for concurrent reads once constructed.

### Ordering guarantees

Per subscriber, events arrive in publish order (each drains a FIFO channel).
**Across** subscribers there is no global ordering — fan-out is concurrent, so a
fast subscriber may see event N before a slow one sees event N-1. Source:
`celeris/middleware/sse/broker.go:185-198`.

## Resumable streams (`Last-Event-ID`)

When a browser's `EventSource` reconnects, it sends the ID of the last event it
received in a `Last-Event-ID` header. SSE's whole value proposition is that you
can use this to replay what the client missed.

You have two options.

**Do it yourself.** Read `client.LastEventID()` and replay from your own data
source at the top of the handler:

```go
Handler: func(client *sse.Client) {
    for _, e := range fetchEventsSince(client.LastEventID()) {
        if err := client.Send(e); err != nil {
            return
        }
    }
    // ...then go live...
}
```

**Let the middleware do it.** Set `Config.ReplayStore`. The middleware then:

- on connect with a `Last-Event-ID`, reads the missed events and writes them to
  the wire **before** your `Handler` runs;
- wraps every `Send` so it also appends to the store, **rewriting the wire `id:`
  field with the store-assigned canonical ID** (so you don't manage IDs at all);
- on an unknown cursor, falls through to a fresh start (details below).

Source: `celeris/middleware/sse/config.go:71-92`, `celeris/middleware/sse/sse.go:466-502`.

### In-memory ring buffer

`NewRingBuffer(size)` retains the last `size` events in memory. IDs are sequential
decimal strings starting at `1`. Bounded memory, but lost on process restart and
not shared across instances — ideal for a single-process feed.

```go
store := sse.NewRingBuffer(1000) // remember the last 1000 events

s.GET("/feed", sse.New(sse.Config{
    ReplayStore: store,
    Handler: func(client *sse.Client) {
        // No need to set IDs — the store assigns them. Just send.
        unsubscribe := broker.Subscribe(client)
        defer unsubscribe()
        <-client.Context().Done()
    },
}))
```

Source: `celeris/middleware/sse/replay_ring.go:15`.

### KV-backed store (durable / multi-instance)

`NewKVReplayStore` persists events to a `store.KV` (see [Data stores](/docs/data-stores)),
so replay survives a restart and — with a shared backend like Redis — works across
multiple instances. It returns an error only when `KV` is nil.

```go
import "github.com/goceleris/celeris/middleware/store"

kv := store.NewMemoryKV() // or a Redis-backed KV in production
replay, err := sse.NewKVReplayStore(sse.KVReplayStoreConfig{
    KV:     kv,
    Prefix: "feed:",
    TTL:    1 * time.Hour, // how long events stay replayable
})
if err != nil {
    log.Fatal(err)
}

s.GET("/feed", sse.New(sse.Config{ReplayStore: replay, Handler: feedHandler}))
```

`KVReplayStoreConfig` fields (source: `celeris/middleware/sse/replay_kv.go:32-79`):

| Field                    | Type            | Default        | Purpose                                                              |
| ------------------------ | --------------- | -------------- | ------------------------------------------------------------------ |
| `KV`                     | `store.KV`      | — (required)   | Backing store.                                                      |
| `Prefix`                 | `string`        | `""`           | Namespace for event blobs and the shared counter.                  |
| `TTL`                    | `time.Duration` | `0` (no expiry)| Lifetime of stored events.                                         |
| `MaxIndex`               | `int`           | `65536`        | Soft cap on the in-memory ID index (oldest 25% dropped when full). |
| `AsyncAppend`            | `bool`          | `false`        | Return from `Append` before the KV write completes (see below).    |
| `AsyncAppendConcurrency` | `int`           | `64`           | Caps in-flight async-append goroutines.                            |
| `CounterKey`             | `string`        | `<Prefix>seq`  | KV key for the cross-instance ID counter.                          |

When the supplied KV also implements `store.Counter` (the in-memory KV does, via
`Increment`; so does the Redis adapter via `INCR`), IDs are allocated atomically
against the backend, giving every process a single monotonic ID space. Without
`Counter`, the store falls back to a per-process counter and multi-instance setups
will see ID collisions. Source: `celeris/middleware/sse/replay_kv.go:81-124`.

#### `AsyncAppend` — latency vs. durability

By default the store's `Append` runs **synchronously inside the per-client write
lock** so the store's ID order exactly matches the on-wire order. Against a remote
KV that means a slow `Set` directly stalls `Send` (and any concurrent heartbeat).

Turning on `AsyncAppend` makes `Append` return as soon as the ID is allocated; the
actual `KV.Set` fires in a background goroutine. This trades durability for
latency:

- an `Append` that returns is **not** guaranteed to be in the KV by the next
  reconnect;
- a concurrent reconnect may briefly miss an in-flight event.

Use it only when wire-write latency dominates and your replay can tolerate eventual
consistency.

```go
replay, _ := sse.NewKVReplayStore(sse.KVReplayStoreConfig{
    KV:          redisKV,
    Prefix:      "chat:",
    TTL:         30 * time.Minute,
    AsyncAppend: true, // don't let a slow Redis Set stall Send
})
```

Source: `celeris/middleware/sse/replay_kv.go:48-72`, `:160-190`.

### Unknown-cursor behaviour

If the incoming `Last-Event-ID` can't be interpreted — malformed, or aged out of
the retention window — the store's `Since` returns `sse.ErrLastIDUnknown`. The
middleware treats this as a **fresh start**: it writes no replay events but still
runs your `Handler`, and the original header value stays visible via
`client.LastEventID()` so your handler can react (for example, send a "you may have
missed messages" marker). Source: `celeris/middleware/sse/replay.go:8-14`,
`celeris/middleware/sse/sse.go:484-488`.

```go
Handler: func(client *sse.Client) {
    // ReplayStore already wrote any replayable events before we got here.
    // If the client *had* a cursor but we couldn't honour it, warn them.
    if id := client.LastEventID(); id != "" {
        client.Send(sse.Event{Event: "resume", Data: "cursor too old; resync"})
    }
    // ...go live...
}
```

## Event format

`sse.Event` is the struct you hand to `Send`. Source:
`celeris/middleware/sse/event.go:13-30`.

| Field   | Type     | Wire output                          | Notes                                                                 |
| ------- | -------- | ------------------------------------ | -------------------------------------------------------------------- |
| `ID`    | `string` | `id: <ID>\n`                         | Echoed back by the browser as `Last-Event-ID`. Omitted when empty.   |
| `Event` | `string` | `event: <Event>\n`                   | The client-side event name (`message` when empty).                   |
| `Data`  | `string` | `data: <line>\n` per line            | Multi-line data is split on newlines, each line gets its own prefix. |
| `Retry` | `int`    | `retry: <Retry>\n`                   | Reconnect delay in **milliseconds**. Omitted when ≤ 0.              |

The middleware strips `\r`, `\n`, and `\0` from the `id` and `event` fields to
prevent SSE field-injection, strips `\r` and `\n` from comments (so a crafted
comment can't terminate its line and inject `data:`/`event:`/`id:` fields), and
correctly splits multi-line `Data` across `data:` lines per the spec. You almost
never need to format events yourself, but `FormatEvent(buf []byte, e Event) []byte`
is exported for benchmarking and advanced reuse:

```go
buf := sse.FormatEvent(nil, sse.Event{Event: "ping", Data: "hi"})
// buf == "event: ping\ndata: hi\n\n"
```

Source: `celeris/middleware/sse/event.go:34-62`.

## How it works across engines

Every SSE handler blocks until the client disconnects. On native engines (epoll,
io_uring) a handler that blocks would otherwise stall the event loop, so the
middleware spawns a goroutine to drive the stream and returns from the request
handler immediately; on the std engine it runs the stream inline (returning would
tell `net/http` the response is done). You don't have to think about any of this —
the middleware calls `Context.Detach` and picks the right path internally. This is
why the same `sse.Config` runs unchanged on all engines. Source:
`celeris/middleware/sse/sse.go:366-554`. For the underlying detach mechanics, see
[Streaming](/docs/streaming).

## Common pitfalls

- **Forgetting to check `Send`'s error.** A failed write cancels the context; if
  you ignore the error your loop spins. Always `return` on non-nil.
- **Calling `Send` after the handler returns.** The contract is that all events
  flow while the handler is on the stack. If you publish into a `Client` from a
  spawned goroutine, join that goroutine **before** the handler returns. (The
  middleware guards against a panic, returning `ErrClientClosed`, but the
  ownership is yours.) Source: `celeris/middleware/sse/sse.go:64-69`.
- **Not deferring the broker's `unsubscribe`.** It both removes the subscriber and
  joins its drain goroutine; skipping it leaks a goroutine per connection.
- **Treating `HeartbeatInterval: 0` as "disabled".** Zero means the 15s default;
  use a **negative** value to disable.
- **Expecting global ordering from a broker.** Order is per-subscriber only.
- **Assuming `AsyncAppend` is durable.** It isn't — a returned `Append` may not
  yet be in the KV. Leave it off unless you've measured a latency problem.
- **Forcing an SSE route `Sync()`.** SSE routes are async by construction; don't
  override the dispatch mode. See [Routing](/docs/routing).
- **No CORS for cross-origin `EventSource`.** Add CORS middleware on the endpoint
  if the page lives on a different origin. See [Middleware](/docs/middleware).

## FAQ

**SSE or WebSocket?** SSE is one-way (server → client), text-only, auto-reconnects,
and runs over plain HTTP — ideal for feeds, notifications, and progress streams.
Use [WebSocket](/docs/websocket) when you need the client to send messages too, or
need binary frames.

**Do I have to set event IDs for replay?** No. With a `ReplayStore` configured, the
middleware assigns and rewrites the wire `id:` for every `Send` — you can leave
`Event.ID` empty.

**How do I send to a specific subset of clients?** Use multiple brokers (one per
room/topic) and subscribe each client to the brokers it belongs to. A client may be
subscribed to several brokers at once.

**Can a broker-subscribed client also use `MaxQueueDepth`?** Yes — they're
independent layers. The broker writes via `WritePreparedEvent` (always
synchronous), so the per-client queue only engages if something calls
`client.Send` directly. Source: `celeris/middleware/sse/prepared.go:26-42`.

**How do I detect that a client left?** Select on `client.Context().Done()`, or
watch for a non-nil error from `Send`. Heartbeats turn a silently dead connection
into a write error that cancels the context.

## See also

- [Streaming](/docs/streaming) — the low-level `StreamWriter` + `Detach` API SSE
  is built on, plus chunked responses.
- [WebSocket](/docs/websocket) — two-way, framed communication.
- [Data stores](/docs/data-stores) — the `store.KV` interface behind
  `NewKVReplayStore`, including the Redis adapter and `Counter`.
- [Routing](/docs/routing) — registering the endpoint and dispatch modes.
- [Middleware](/docs/middleware) — CORS, auth, and ordering on the SSE route.
