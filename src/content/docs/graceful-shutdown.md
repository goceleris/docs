---
title: Graceful shutdown and zero-downtime restarts
description: Drain in-flight requests on shutdown and hand off the listening socket for zero-downtime deploys.
group: Operations
order: 2
---

When an orchestrator sends your process a `SIGTERM` (a Kubernetes rolling update, a
`systemctl restart`, a `docker stop`), you want two things: every request already in
flight should finish, and — if you can manage it — the new process should start
accepting on the same socket before the old one lets go, so no client ever sees a
connection refused. Celeris gives you both.

This page covers stopping cleanly (`StartWithContext` / `Shutdown`), the exact
sequence Celeris runs during a drain, the `OnShutdown` hook for releasing your own
resources, pausing the accept loop without a full shutdown, and inheriting the
listening socket across a restart for true zero-downtime deploys.

## Graceful shutdown

The idiomatic entry point is `StartWithContext`. Wire a context to your termination
signals with the standard library's `signal.NotifyContext`; when the signal lands,
the context is canceled, Celeris stops accepting, drains the requests in flight, then
runs your `OnShutdown` hooks, and only then does `StartWithContext` return. This is the
recommended path. A cancel starts that shutdown on every engine, and since celeris
v1.6.0 it runs in the same order on every engine: the drain first, then the hooks
([celeris#703](https://github.com/goceleris/celeris/issues/703)). The drain covers
every HTTP/1.1 request but not every HTTP/2 stream; see
[What the drain waits for](#what-the-drain-waits-for).

```go
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/goceleris/celeris"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s := celeris.New(celeris.Config{
		Addr:            ":8080",
		ShutdownTimeout: 15 * time.Second,
	})
	s.GET("/hello", func(c *celeris.Context) error {
		return c.String(200, "hello")
	})

	// Blocks until ctx is canceled (signal received) or the engine errors.
	if err := s.StartWithContext(ctx); err != nil {
		log.Fatal(err)
	}
}
```

When `ctx` is canceled, `StartWithContext` cancels the engine's listen context (which
stops accepting and drains in flight requests) and, on a watcher goroutine, calls
`Shutdown` with a fresh context bounded by `Config.ShutdownTimeout` (defaulting to
**30s** when unset or non-positive). That `Shutdown` waits for the drain and then runs
your `OnShutdown` hooks, all under that one deadline (on `std` a cancel does not keep
to it today; see [the FAQ](#faq)). `StartWithContext` then waits for both: it returns
the engine's exit error only after the engine has stopped **and** that `Shutdown`,
hooks included, has returned. If your code already called `Shutdown` itself during the
run, the cancel does not run it, or your hooks, a second time; and a `Shutdown` your
code calls after the cancel has started one waits for that one instead of running its
own (see [Shutting down programmatically](#shutting-down-programmatically-shutdown)).
`StartWithListenerAndContext` behaves the same way. Source: `celeris/server.go`
(`StartWithContext`, `StartWithListenerAndContext`, `listenUntilCancelled`).

The godoc states the contract (since celeris v1.6.0,
[celeris#673](https://github.com/goceleris/celeris/issues/673)):

> **`StartWithContext`:** "When the context is canceled, the server shuts down
> gracefully using Config.ShutdownTimeout (default 30s), and StartWithContext returns
> once that shutdown, including the [Server.OnShutdown] hooks, has finished; so it does
> when a direct [Server.Shutdown] stops it. A hook must therefore not wait for
> StartWithContext to return; see [Server.OnShutdown]."
>
> **`OnShutdown`:** "The hooks run before the Start* call that served the server
> returns, whatever shut it down: a Start* call waits for the direct [Server.Shutdown]
> call that stopped it, and [Server.StartWithContext] and
> [Server.StartWithListenerAndContext] wait for the Shutdown a cancel of their context
> triggers, hooks included (celeris#703). A hook must therefore not wait for that Start
> call to return, directly or through anything that happens only after it returns. The
> two would wait on each other: a hook that returns when its ctx is done ends the wait
> when that ctx is done ([Config.ShutdownTimeout] after a cancel), and a hook that
> ignores ctx never does."

So a `main` that exits as soon as `StartWithContext` returns does not cut a hook short.
The one thing a hook must not do is wait for `StartWithContext` (or
`StartWithListenerAndContext`) to return, for example by blocking on a channel your
`main` closes after the call returns. A hook that selects on its `ctx` is released
after `Config.ShutdownTimeout`; one that ignores `ctx` hangs the shutdown for good.

> Before v1.6.0, `StartWithContext` did not wait for the hooks: it could return before
> they had run, and a cancel could skip `Shutdown`, and so the hooks, altogether
> ([celeris#673](https://github.com/goceleris/celeris/issues/673)).

### Shutting down programmatically: `Shutdown`

`Shutdown(ctx)` is the explicit, programmatic way to stop a running server. It stops
the engine, waits for the requests in flight to drain, closes the internal CPU monitor,
and runs your `OnShutdown` hooks. The wait for the drain is bounded by the `ctx` you
pass: if `ctx` is done first, the hooks still run, with that `ctx`, and `Shutdown`
returns its error (see [Shutdown sequence](#shutdown-sequence)). Since celeris v1.6.0
this is the same on every engine; before, `Shutdown` on `epoll` and `io_uring` ran the
hooks and returned without waiting for the drain
([celeris#703](https://github.com/goceleris/celeris/issues/703)). When your call is
what shuts the server down, `Config.ShutdownTimeout` is **not** consulted — *you* own
the deadline via the context you pass. Source: `celeris/server.go` (`Shutdown`).

Because `Shutdown` waits for the requests in flight, a handler must not call it and
wait for it: the call would wait for its own request until `ctx` is done. Start it on
its own goroutine instead (`go s.Shutdown(ctx)`), as with net/http.

The `Start*` call that your `Shutdown` stops returns only after that `Shutdown` has
returned, hooks included, on every engine since celeris v1.6.0
([celeris#703](https://github.com/goceleris/celeris/issues/703)). So the usual shape,
a signal goroutine that calls `Shutdown` and a `main` that exits when `Start` returns,
keeps its hooks:

```go
go func() {
	<-sigCh // from signal.Notify
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}()
if err := s.Start(); err != nil { // returns after the Shutdown above has returned
	log.Fatal(err)
}
```

On `epoll`, `io_uring` and `adaptive`, `Start` also waits for the drain itself, even
past `ctx`. On `std` it returns when `Shutdown` does. If `ctx` ran out first, requests
may still be in their handlers, and exiting then cuts them off (see
[the FAQ](#faq)). Before v1.6.0, `Start` could return before your hooks had run: on
those versions wait for `Shutdown` to return before exiting, as net/http teaches.

The exception is a call made after cancelling the context of `StartWithContext` or
`StartWithListenerAndContext` has already started a shutdown. Since celeris v1.6.0
([celeris#673](https://github.com/goceleris/celeris/issues/673)), that call does not run
a second shutdown, which would run your hooks again. The `Shutdown` godoc:

> "When cancelling the context of [Server.StartWithContext] or
> [Server.StartWithListenerAndContext] has already started a shutdown, Shutdown does
> not run a second one: it waits for that one, hooks included, and returns its result,
> or ctx's error if ctx is done first."

That shutdown keeps its `Config.ShutdownTimeout` deadline. The `ctx` you pass bounds
only how long your call waits for it; if `ctx` is done first, the shutdown carries on
without your call.

```go
// You own the drain deadline here.
shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
defer cancel()
if err := s.Shutdown(shutCtx); err != nil {
	log.Printf("shutdown error: %v", err)
}
```

> **Prefer `StartWithContext` over a bare `Start()` + `Shutdown()` pair.** On the
> native Linux engines (`epoll`, `io_uring`) the drain is driven entirely by
> listen-context cancellation: their engine-level `Shutdown` is a no-op. Since v1.6.0
> ([celeris#595](https://github.com/goceleris/celeris/issues/595)), `Server.Shutdown`
> cancels the listen context of every entry point, `Start()` included, so a later
> `Shutdown` does stop a server started with `Start()`; before v1.6.0, `Start()` ran on
> a non-cancelable background context and `Shutdown` could not unwind a native engine.
> The context-driven entry points (`StartWithContext` / `StartWithListenerAndContext`)
> are still the better path: a cancel runs `Shutdown` for you with
> `Config.ShutdownTimeout`, and the call returns only after the engine and the hooks
> have finished. Source:
> `celeris/server.go` (`Start`, `listenContext`, `Shutdown`),
> `celeris/engine/epoll/engine.go` and `celeris/engine/iouring/engine.go` (`Shutdown`).

### Entry points at a glance

| Method | Blocks until | Drain deadline | Use when |
| ------ | ------------ | -------------- | -------- |
| `StartWithContext(ctx)` | after a cancel: the engine has stopped and `Shutdown`, hooks included, has finished; otherwise an engine error | `Config.ShutdownTimeout` (default 30s): one deadline for the drain and then the hooks | The common case: signal-driven shutdown. |
| `StartWithListenerAndContext(ctx, ln)` | as `StartWithContext` | `Config.ShutdownTimeout` (default 30s): one deadline for the drain and then the hooks | Socket handoff + signal-driven shutdown. |
| `Start()` | the `Shutdown` that stops it has returned, hooks included (since v1.6.0), or an engine error | the `ctx` you pass to `Shutdown` | Rare; prefer the context entry points. |
| `StartWithListener(ln)` | as `Start()` | the `ctx` you pass to `Shutdown` | Socket handoff with the context entry point below. |
| `Shutdown(ctx)` | the drain, bounded by `ctx`, and then every hook (see [Shutdown sequence](#shutdown-sequence)) | the `ctx` you pass, unless a cancel has already started the shutdown (see [above](#shutting-down-programmatically-shutdown)) | Programmatic shutdown from your own code. |

Source: `celeris/server.go` (`StartWithContext`, `StartWithListenerAndContext`, `Start`,
`StartWithListener`, `Shutdown`).

## Shutdown sequence

`Shutdown(ctx)` runs a fixed, well-defined sequence. Knowing the order matters when
you register hooks that depend on it. Source: `celeris/server.go` (`Shutdown`), and each
engine's `Shutdown`.

1. **Returns immediately if never started.** If the server was never started (no
   engine installed), `Shutdown` closes the CPU monitor (a no-op if it was never
   created) and returns `nil`. Calling `Shutdown` on a server you never started is
   therefore safe and cheap.
2. **Shut the engine down.** On `std` this is net/http's `Server.Shutdown`: stop
   accepting, then wait for in flight requests, bounded by the `ctx` you pass. When
   `ctx` expires it stops waiting, but it does not close the connections of requests
   still running (see [the FAQ](#faq)). `adaptive` waits, bounded by `ctx`, for its
   engines to unwind. On `epoll` and
   `io_uring` this step returns at once: those engines drain as their listen context is
   cancelled (the next step).
3. **Cancel the listen context and wait for the drain.** Cancelling it is what stops a
   running `epoll` or `io_uring` engine: its workers stop accepting, let the handlers
   they are running return and wait for their async handlers, send what the sockets
   have not taken yet (see [What the drain waits for](#what-the-drain-waits-for)), and
   close their connections. `Shutdown` then waits, bounded by `ctx`, until the engine's `Listen` has
   returned, which is when the drain is over (on `std` and `adaptive`, at once: step 2
   drained). What that drain covers, and what it does not, is in
   [What the drain waits for](#what-the-drain-waits-for).
4. **Close the CPU monitor.** Celeris releases the internal CPU-utilization monitor
   (on Linux this frees the `/proc/stat` file descriptor that powers the adaptive
   engine and `CPUUtilization` metrics).
5. **Fire `OnShutdown` hooks.** Your registered hooks run **in registration order**,
   each receiving the **same** shutdown context you passed to `Shutdown`. A panic in
   one hook is recovered and does not abort the others, nor does it crash the process.

So on every engine the hooks start after the requests in flight have finished (with
the HTTP/2 exceptions [below](#what-the-drain-waits-for)), a direct `Shutdown` returns
after the hooks, and the `Start*` call it stopped returns after `Shutdown`. If `ctx` is
done before the drain is over, the hooks run then, with that `ctx`, and `Shutdown`
returns its error (see
[What happens to requests still running when the deadline expires?](#faq)). A
cancelled `StartWithContext` returns only after both the engine and the hooks have
finished. Before celeris v1.6.0, on `epoll` and `io_uring` the hooks ran, and a direct
`Shutdown` returned, while requests were still in flight
([celeris#703](https://github.com/goceleris/celeris/issues/703)).

`Shutdown` returns the engine's shutdown error, or `ctx`'s error if the drain did not
finish within `ctx`, or `nil`. Note that hook panics are swallowed (recovered) — they
do not surface in the return value — so do your own error logging inside the hook.

### What the drain waits for

The drain waits for:

- every **HTTP/1.1** request, on every engine;
- on `epoll`, `io_uring` and `adaptive`, every **HTTP/2** stream whose handler runs on
  the connection's worker, which is every route that is not async.

It does not wait for two kinds of HTTP/2 stream
([celeris#759](https://github.com/goceleris/celeris/issues/759)):

- On `epoll`, `io_uring` and `adaptive`, a stream on an **async route**
  (`.Async()`, or a route `Config.AsyncHandlers` has made async) runs on a shared
  HTTP/2 worker pool that the drain does not join. The hooks can run while its
  handler is still running, and the client does not get its response: the
  connection closes under it (`unexpected EOF`).
- On `std`, **every h2c stream**. net/http hands an h2c connection to the HTTP/2
  server and stops tracking it, so the drain does not wait for it. The hooks can run
  while the handler is still running; the response is still delivered.

Once the handlers have returned, the native engines keep sending what the sockets have
not taken yet before they close the connections, so a response larger than the socket
buffers still reaches a client that reads slowly. `epoll` (and `adaptive` while it runs
`epoll`) keeps sending until the shutdown's deadline (`Config.ShutdownTimeout` after a
cancel, or the `ctx` of a direct `Shutdown`), and never for less than 250 ms; a client
that never reads holds the shutdown that long and no longer. Before celeris v1.6.0
`epoll` closed each connection as soon as the handlers had returned, and such a
response lost its tail ([celeris#760](https://github.com/goceleris/celeris/issues/760)).
`io_uring` keeps sending for 250 ms whatever the deadline, so a client slower than that
can still lose the tail ([celeris#806](https://github.com/goceleris/celeris/issues/806)),
and `std` drains through net/http.

(Measured on each engine with one request in flight at the shutdown. An h2c request on
an `.Async()` route got `unexpected EOF` on `epoll`, `io_uring` and `adaptive`, with the
hooks run first. On a route that is not async it got its response, with the hooks run
after the handler. On `std` the hooks ran before the h2c handler returned, and the
response still arrived. A 3 MiB response was written 200 ms into the shutdown, to a
client with a 64 KiB receive buffer that started reading 1 s later. The client got all
of it on `std`, `epoll` and `adaptive` (before v1.6.0, 2,634,240 of its 3,145,849 bytes
on `epoll` and `adaptive`). On `io_uring` it depends on what the kernel had taken when
the 250 ms ran out: all of it on one machine, 2,634,119 of 3,145,728 body bytes on a CI
runner.)

> **The shutdown context is shared across the engine drain *and* every hook.** Within a
> single `Shutdown(ctx)` call, the same `ctx` bounds the drain and then flows into each
> hook in turn — so if you pass a 5s context and the drain eats 4.5s, your hooks have
> only ~500ms of budget left. Size `ShutdownTimeout` (or the context you build
> manually) to cover both the request drain *and* the slowest resource you close in a
> hook.

## Drain hooks: `OnShutdown`

`Server.OnShutdown(fn)` registers a function to run at the end of `Shutdown`, after the
requests in flight have finished (or the shutdown deadline has passed), on every engine
(see [Shutdown sequence](#shutdown-sequence), and
[What the drain waits for](#what-the-drain-waits-for) for the HTTP/2 exceptions). This
is where you close database pools, flush log buffers, deregister from service
discovery, or persist in-memory state.
Source: `celeris/server.go` (`OnShutdown`).

```go
s := celeris.New(celeris.Config{
	Addr:            ":8080",
	ShutdownTimeout: 20 * time.Second,
})

db := openPool()
logSink := openAsyncLogger()

// Hooks fire in registration order during Shutdown.
s.OnShutdown(func(ctx context.Context) {
	// Respect the deadline — don't block past the drain budget.
	if err := db.Close(); err != nil {
		log.Printf("draining db pool: %v", err)
	}
})
s.OnShutdown(func(ctx context.Context) {
	if err := logSink.Flush(ctx); err != nil {
		log.Printf("flushing logs: %v", err)
	}
})

ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()
log.Fatal(s.StartWithContext(ctx))
```

Rules to internalize:

- **Register before `Start`.** Like all server configuration, `OnShutdown` must be
  called before the server starts. `OnShutdown` returns the `*Server` so you can chain
  registrations.
- **Hooks run in registration order.** If hook B depends on hook A having already run
  (e.g. flush a buffer that A populated), register A first.
- **Respect the context deadline.** The same `ctx` flows into every hook. Long-running
  cleanup should select on `ctx.Done()` and bail out rather than block the process
  from exiting. Celeris does **not** forcibly interrupt a hook that ignores the
  deadline — it will run to completion, and a cancelled `StartWithContext` does not
  return until it has.
- **Never wait for the `Start*` call inside a hook.** The hooks run *before* the
  `Start*` call returns, whether a cancel or your own `Shutdown` stopped it, so a
  hook that waits for it to return, directly or on something your code does only
  after it returns, waits on itself. It is released when its `ctx` is done
  (`Config.ShutdownTimeout` after a cancel) if it honours `ctx`, and never if it
  does not.
- **Panics are contained.** A panic in one hook is recovered; remaining hooks still
  run and the process does not crash. This is a safety net, not a license to skip
  error handling — log failures yourself.

### Draining session write-behind

The session middleware has an opt-in `WriteBehind` mode that moves the post-handler
store write off the response critical path: the encoded session is snapshotted and
handed to a single background worker, so the response returns before the store write
lands. The tradeoff is durability — a response acknowledged to the client does not
guarantee the session write is durable across an abrupt death (SIGKILL, panic, power
loss). A **graceful** shutdown, however, can drain every in-flight and queued write,
so nothing enqueued is lost.

To get that guarantee, construct the middleware with a handle you can close and drain
it from an `OnShutdown` hook. Use `session.NewWithCloser` (returns the middleware plus
an `io.Closer`) or `session.NewHandler` (returns a `*Handler` with `Close() error`).
Both block until every queued write has been applied; when `WriteBehind` is disabled
the closer is a no-op, so this wiring is always safe.

```go
mw, closer := session.NewWithCloser(session.Config{
	Store:       sessionStore,
	WriteBehind: true,
})
s.Use(mw)

// Flush the write-behind queue during the drain so no enqueued session write is lost.
s.OnShutdown(func(ctx context.Context) {
	if err := closer.Close(); err != nil {
		log.Printf("draining session write-behind: %v", err)
	}
})
```

Plain `session.New` gives you no such handle, so a graceful stop cannot drain the
queue and the final updates of in-flight requests may be lost — prefer
`NewWithCloser`/`NewHandler` whenever `WriteBehind` is on. See
[Middleware](/docs/middleware) for the full session configuration surface. Source:
`celeris/middleware/session/writebehind.go`, `celeris/middleware/session/session.go:319,395`.

## Pause and resume accept

Sometimes you want to stop taking *new* connections while keeping the existing ones
served — for example, to quiesce a node for maintenance, fail a load-balancer health
check, or back off under pressure — without tearing the whole server down.
`PauseAccept` and `ResumeAccept` do exactly that. Source: `celeris/server.go`
(`PauseAccept`, `ResumeAccept`).

```go
// Stop accepting new connections; in flight requests keep running.
if err := s.PauseAccept(); err != nil {
	if errors.Is(err, celeris.ErrAcceptControlNotSupported) {
		// std engine, or server not started — fall back to a full Shutdown.
	}
}

// Later, start accepting again.
_ = s.ResumeAccept()
```

| Method | Effect |
| ------ | ------ |
| `PauseAccept() error` | Stop accepting new connections. Existing connections continue to be served. |
| `ResumeAccept() error` | Resume accepting after a pause. |

**Native engines only.** Accept control is implemented by the native Linux engines
(`epoll`, `io_uring`, and the `adaptive` controller that drives them). The `std`
(net/http) engine does **not** support it: both methods return
`celeris.ErrAcceptControlNotSupported` on `std`, and also when the server has not been
started yet (no engine is installed). Always check the error and have a fallback (a
full `Shutdown`) for portability. Source: `celeris/server.go` (`PauseAccept`,
`ResumeAccept`),
`celeris/errors.go:29-31`, `celeris/engine/engine.go:27-35`. See
[Engines](/docs/engines) for which engine runs where.

> Pause/resume is for *temporary* quiescing. It does not drain — in flight requests
> keep running, and paused connections are simply not accepted. For an orderly stop
> that drains and runs your hooks, use `Shutdown`.

## Zero-downtime restart via socket handoff

A graceful shutdown still has a gap: between the old process releasing the port and
the new process binding it, new connections are refused. To close that gap, hand the
**already-bound listening socket** to the replacement process so it can accept on the
same fd while the old process drains.

The pieces:

| API | Role |
| --- | ---- |
| `celeris.InheritListener(envVar)` | Reconstruct a `net.Listener` from an inherited fd whose number is in the named **environment variable**. Returns `nil, nil` if the variable is unset. |
| `Server.StartWithListener(ln)` | Start the server on an existing `net.Listener` instead of binding `Config.Addr`. |
| `Server.StartWithListenerAndContext(ctx, ln)` | Same, plus signal-driven graceful shutdown bounded by `Config.ShutdownTimeout`. |

Source: `celeris/server.go` (`InheritListener`, `StartWithListener`,
`StartWithListenerAndContext`).

### `InheritListener` takes an env-var *name*, not an address

This is the single most common mistake. `InheritListener` reads the **name of an
environment variable**, parses the integer file descriptor stored there, and rebuilds
a `net.Listener` from it:

```go
// The parent process exports CELERIS_LISTENER_FD=<fd number> before exec'ing
// the child. The child reads it back here.
ln, err := celeris.InheritListener("CELERIS_LISTENER_FD")
if err != nil {
	log.Fatal(err)
}
if ln == nil {
	// Variable unset → this is a cold start, not an inherited handoff.
	ln, err = net.Listen("tcp", ":8080")
	if err != nil {
		log.Fatal(err)
	}
}
```

Passing an address like `InheritListener(":8080")` is wrong — there is no env var
named `:8080`, so it returns `nil, nil` and you silently fall through to a cold bind.
`InheritListener` returns an error only when the variable *is* set but holds an
invalid fd. Source: `celeris/server.go` (`InheritListener`).

### Listener ownership: hands off

Once you pass a listener to `StartWithListener`, the server owns it. **Do not `Accept`
on it or `Close` it yourself.** What happens to the listener depends on the engine:

- **`std` engine:** the supplied listener is used directly to accept connections.
- **Native engines (`epoll`, `io_uring`, `adaptive`):** Celeris extracts the bound
  address from your listener, then **closes** that listener so the engine's workers
  can rebind their own `SO_REUSEPORT` sockets on the same `(host, port)`. This is by
  design — the multi-worker native engines need their own per-worker sockets.

In both cases the contract is the same: after calling `StartWithListener`, the
listener belongs to Celeris. That holds when the start fails, too: if the server cannot
start before its engine runs (a configuration error, or an engine that cannot be
created), Celeris closes the listener before it returns the error, since celeris v1.6.0
([celeris#737](https://github.com/goceleris/celeris/issues/737)). The one exception is
`ErrAlreadyStarted`: the server is already running, so the listener you passed stays
yours. Source: `celeris/server.go` (`StartWithListener`, `prepareWithListener`).

> Because native engines rebind via `SO_REUSEPORT`, the old and new processes can both
> hold a socket on the port simultaneously during the handoff window — which is exactly
> what makes the zero-gap restart possible. See [Engines](/docs/engines) for the
> native vs. std distinction.

### The `Addr` vs. `Listener` ambiguity error

If you both pass a listener **and** set `Config.Addr` to a concrete address that
disagrees with the listener's bound address, Celeris rejects the configuration at
start rather than silently discarding one of them. You get a validation error:

```
ambiguous configuration: Addr="..." but Listener is bound to "..."; the explicit Addr will be discarded
```

To avoid it when using socket handoff, **leave `Config.Addr` empty** (or set it to a
value that matches the listener). Two cases are deliberately *allowed* and do not
error: the default `":8080"`, and any `"<host>:0"` (pick-any-port), since delegating
port selection to the pre-bound listener is a common, intentional pattern. Source:
`celeris/resource/config.go:152-161`.

```go
// ✅ No Addr → no ambiguity. The listener decides the bind address.
s := celeris.New(celeris.Config{ShutdownTimeout: 20 * time.Second})
log.Fatal(s.StartWithListener(ln))

// ❌ Conflicting Addr → "ambiguous configuration" validation error at start.
s := celeris.New(celeris.Config{Addr: ":9090"})
log.Fatal(s.StartWithListener(ln)) // ln bound to :8080
```

## Full inherit example

Putting it together: a process that inherits the socket when present, binds fresh
otherwise, and drains gracefully on `SIGTERM`. A supervising parent (or an exec-self
restart) sets `CELERIS_LISTENER_FD` to the listener's fd number before launching the
replacement.

```go
package main

import (
	"context"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/goceleris/celeris"
)

const listenerEnv = "CELERIS_LISTENER_FD"

func main() {
	// 1. Try to inherit the socket from the parent process.
	ln, err := celeris.InheritListener(listenerEnv)
	if err != nil {
		log.Fatalf("inherit listener: %v", err)
	}
	// 2. Cold start: nothing inherited, bind fresh.
	if ln == nil {
		ln, err = net.Listen("tcp", ":8080")
		if err != nil {
			log.Fatalf("listen: %v", err)
		}
		log.Printf("cold start on %s", ln.Addr())
	} else {
		log.Printf("inherited listener on %s", ln.Addr())
	}

	// 3. Leave Addr empty so the listener decides the bind address —
	//    avoids the "ambiguous configuration" error.
	s := celeris.New(celeris.Config{
		ShutdownTimeout: 20 * time.Second,
	})
	s.GET("/hello", func(c *celeris.Context) error {
		return c.String(200, "hello from pid "+strconv.Itoa(os.Getpid()))
	})

	// 4. Release resources during the drain.
	s.OnShutdown(func(ctx context.Context) {
		log.Println("draining resources before exit")
	})

	// 5. Drain gracefully on SIGTERM/SIGINT; ShutdownTimeout bounds the drain.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := s.StartWithListenerAndContext(ctx, ln); err != nil {
		log.Fatal(err)
	}
	log.Println("server stopped cleanly")
}
```

The handoff dance (which the parent/supervisor performs) is, in outline:

1. The parent holds the bound listener and knows its fd number.
2. The parent sets `CELERIS_LISTENER_FD=<fd>` and execs the new binary, passing the fd
   through (the child inherits open fds across `exec`).
3. The child calls `InheritListener("CELERIS_LISTENER_FD")` and starts accepting on the
   same socket.
4. The parent sends itself (or is sent) `SIGTERM`. Its
   `StartWithContext`/`StartWithListenerAndContext` cancellation drains in flight
   requests and runs its `OnShutdown` hooks, and the call returns once both are done,
   so the parent then exits.

During steps 3–4 both processes accept on the port (native engines via `SO_REUSEPORT`,
std via the shared inherited fd), so no client connection is refused.

## Common pitfalls

- **Passing an address to `InheritListener`.** It takes an **environment variable
  name**, not an address. `InheritListener(":8080")` returns `nil, nil` and you fall
  through to a cold bind without noticing.
- **Touching the listener after `StartWithListener`.** Don't `Accept` on or `Close`
  the listener you handed off — Celeris owns it, and on native engines it is closed and
  rebound via `SO_REUSEPORT`.
- **Setting `Config.Addr` *and* passing a conflicting listener.** This trips the
  `ambiguous configuration` validation error at start. Leave `Addr` empty for handoff
  (or match the listener exactly).
- **Registering `OnShutdown` after `Start`.** Hooks (and all configuration) must be
  registered before the server starts.
- **Waiting for the `Start*` call inside a hook.** The hooks run before the `Start*`
  call returns, so the two wait on each other. See
  [Drain hooks](#drain-hooks-onshutdown).
- **Exiting before `Shutdown` has returned.** Since v1.6.0 the `Start*` call waits for
  the `Shutdown` that stopped it, so exiting when it returns is safe. On earlier
  versions it is not: wait for `Shutdown` to return, as net/http teaches. On `std`, a
  `Shutdown` whose `ctx` expired returns while handlers may still be running, and so
  does `Start` (see [the FAQ](#faq)).
- **Counting on the drain for HTTP/2 async routes, or h2c on `std`.** The drain does
  not wait for them. See [What the drain waits for](#what-the-drain-waits-for).
- **Under-sizing the shutdown budget.** `ShutdownTimeout` (or your manual context)
  covers the request drain *and* every `OnShutdown` hook, sharing one deadline. If your
  hooks do real work (flushing a remote sink, closing pools), budget for it.
- **Calling `Shutdown` from a handler and waiting for it.** `Shutdown` waits for the
  requests in flight, the handler's own included, so it waits until its `ctx` is done.
  Run it on its own goroutine.
- **Expecting hook panics in the return value.** Hook panics are recovered and *not*
  reflected in `Shutdown`'s return. Log errors inside the hook.
- **Using `PauseAccept` on the std engine.** It returns
  `ErrAcceptControlNotSupported`. Accept control is native-engines-only.

## FAQ

**What's the default drain timeout?**
30 seconds — used by `StartWithContext` and `StartWithListenerAndContext` when
`Config.ShutdownTimeout` is zero or negative. When your own `Shutdown(ctx)` call is
what shuts the server down there is no default; you supply the context
(`celeris/config.go` (`ShutdownTimeout`), `celeris/server.go` (`listenUntilCancelled`)).
A call made after a cancel has started the shutdown waits for that one, which keeps its
`Config.ShutdownTimeout` deadline.

**Is calling `Shutdown` on a server I never started safe?**
Yes. It returns `nil` immediately (after a harmless CPU-monitor cleanup). Source:
`celeris/server.go` (`Shutdown`).

**Do `OnShutdown` hooks run if the engine never started?**
No. If no engine was installed, `Shutdown` returns before reaching the hook loop. Hooks
fire only when an engine was started.

**What happens to requests still running when the deadline expires?**
Celeris stops waiting for them; it does not interrupt them. When the deadline
(`Config.ShutdownTimeout` on the context entry points, or the `ctx` you pass to
`Shutdown`) passes before the drain is over, the `OnShutdown` hooks run then, with the
expired context, and a direct `Shutdown` returns `context.DeadlineExceeded` once they
have run. A handler still running keeps running and keeps its connection, and its
response still reaches the client when it finishes. The deadline has passed by then,
so on `epoll` and `io_uring` that response gets 250 ms to go out before the connection
closes: one larger than the socket buffers, to a client that reads slowly, can lose its
tail (see [What the drain waits for](#what-the-drain-waits-for)). `c.Context()` is not cancelled
at the deadline, so a handler cannot see it there.

When the `Start*` call returns differs by engine:

- On `epoll`, `io_uring` and `adaptive`, the engine's `Listen` returns only once that
  handler has finished, and the `Start*` call waits for `Listen`. `Start`,
  `StartWithListener` and a cancelled `StartWithContext` all return after the handler,
  so a `main` that exits when they return does not cut the response off.
- On `std`, `Listen` returns as soon as the drain begins, so the `Start*` call that a
  direct `Shutdown` stopped returns when that `Shutdown` returns: at the deadline, after
  the hooks, while the handler keeps running. A process that exits then cuts the
  response off. A *cancel* of `StartWithContext`'s context does not stop at
  `ShutdownTimeout` at all today: the hooks, and the call, wait for the handler
  ([celeris#753](https://github.com/goceleris/celeris/issues/753)).

(Measured with a 500 ms deadline, a 100 ms hook and a request held 2 s, reading each
call's return as it happens:

- On `epoll`, `io_uring` and `adaptive` the hooks started at 500-510 ms. A direct
  `Shutdown` returned `DeadlineExceeded` at 602-617 ms, after the hook, and `Start`
  and `StartWithContext` returned at 2.0 s.
- On `std` a direct `Shutdown` returned at 610-616 ms, and `Start` or
  `StartWithContext` returned with it. A cancel ran the hooks at 2.17-2.19 s.
- The client got the whole response at 2.0 s on every engine, and `c.Context()` was
  never cancelled.)

Keep handlers shorter than the budget, and give long-running ones (streams) a stop
signal of your own that your signal handler fires before it cancels the context.

**Can I pause accept instead of shutting down for a maintenance window?**
On native engines, yes — `PauseAccept` then `ResumeAccept`. It keeps in flight requests
running but does not drain; it is not a substitute for `Shutdown` when you actually want
to stop.

## See also

- [Deployment & TLS](/docs/deployment) — running behind a proxy, TLS termination, and
  where graceful restarts fit a rolling deploy.
- [Engines](/docs/engines) — native (`epoll`, `io_uring`, `adaptive`) vs. `std`, which
  determines `SO_REUSEPORT` rebind behavior and accept-control support.
- [Configuration](/docs/configuration) — `ShutdownTimeout` and the rest of the `Config`
  surface.
