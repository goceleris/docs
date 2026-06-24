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
the context is canceled and Celeris drains in flight requests, then `StartWithContext`
returns. This is the recommended path: cancelling the context is what every engine
drains on, so it behaves identically across `std` and the native Linux engines.

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
stops accepting and drains in flight requests) and, on a goroutine, calls `Shutdown`
with a fresh context bounded by `Config.ShutdownTimeout` (defaulting to **30s** when
unset or non-positive) to run your `OnShutdown` hooks. `StartWithContext` then returns
the engine's exit error. Source: `celeris/server.go:771-794`.

> `StartWithContext` is blocking. It returns once the engine has stopped accepting and
> drained, or when the engine returns a fatal error. The internal `Shutdown` goroutine
> (which runs your `OnShutdown` hooks) is not awaited by the return, so if you need to
> be certain a hook finished before the process exits, do that hook's blocking work
> synchronously inside the hook and keep the drain budget large enough — see
> [Drain hooks](#drain-hooks-onshutdown).

### Shutting down programmatically: `Shutdown`

`Shutdown(ctx)` is the explicit, programmatic way to stop a running server. It stops
accepting new connections, drains in flight requests bounded by the `ctx` you pass,
closes the internal CPU monitor, and runs your `OnShutdown` hooks. `Config.ShutdownTimeout`
is **not** consulted on this path — *you* own the deadline via the context you pass.
Source: `celeris/server.go:367-382`.

```go
// You own the drain deadline here.
shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
defer cancel()
if err := s.Shutdown(shutCtx); err != nil {
	log.Printf("shutdown error: %v", err)
}
```

> **Prefer `StartWithContext` over a bare `Start()` + `Shutdown()` pair.** `Start()`
> runs the engine on a non-cancelable background context, so on the native Linux
> engines (`epoll`, `io_uring`) — whose drain is driven entirely by listen-context
> cancellation — a later `Shutdown` call cannot unwind the running engine. The
> context-driven entry points (`StartWithContext` / `StartWithListenerAndContext`)
> cancel the listen context for you and work uniformly on every engine. Source:
> `celeris/server.go:354-360` (`Start` uses `context.Background()`),
> `celeris/engine/epoll/engine.go:157-159`, `celeris/engine/iouring/engine.go:305-309`
> (native `Shutdown` is a no-op; drain happens on listen-context cancellation).

### Entry points at a glance

| Method | Blocks until | Drain deadline | Use when |
| ------ | ------------ | -------------- | -------- |
| `StartWithContext(ctx)` | engine drained or engine error | `Config.ShutdownTimeout` (default 30s), applied to the hook phase | The common case: signal-driven shutdown. |
| `StartWithListenerAndContext(ctx, ln)` | engine drained or engine error | `Config.ShutdownTimeout` (default 30s), applied to the hook phase | Socket handoff + signal-driven shutdown. |
| `Start()` | engine error or process exit | n/a (drain via `StartWithContext`) | Rare; prefer the context entry points. |
| `StartWithListener(ln)` | engine error or process exit | n/a (drain via `StartWithListenerAndContext`) | Socket handoff with the context entry point below. |
| `Shutdown(ctx)` | drain + hooks complete | the `ctx` you pass | Programmatic shutdown from your own code. |

Source: `celeris/server.go:354`, `367`, `705`, `716`, `771`.

## Shutdown sequence

`Shutdown(ctx)` runs a fixed, well-defined sequence. Knowing the order matters when
you register hooks that depend on it. Source: `celeris/server.go:367-382`.

1. **Returns immediately if never started.** If the server was never started (no
   engine installed), `Shutdown` closes the CPU monitor (a no-op if it was never
   created) and returns `nil`. Calling `Shutdown` on a server you never started is
   therefore safe and cheap.
2. **Stop accepting, then drain.** The engine stops accepting new connections and
   drains in flight requests, bounded by the `ctx` you pass: per the engine contract,
   when the deadline expires remaining connections are closed rather than waited on
   indefinitely (`celeris/engine/engine.go:16-18`).
3. **Close the CPU monitor.** Celeris releases the internal CPU-utilization monitor
   (on Linux this frees the `/proc/stat` file descriptor that powers the adaptive
   engine and `CPUUtilization` metrics).
4. **Fire `OnShutdown` hooks.** Your registered hooks run **in registration order**,
   each receiving the **same** shutdown context you passed to `Shutdown`. A panic in
   one hook is recovered and does not abort the others, nor does it crash the process.

`Shutdown` returns the engine's drain error (or `nil`). Note that hook panics are
swallowed (recovered) — they do not surface in the return value — so do your own
error logging inside the hook.

> **The shutdown context is shared across the engine drain *and* every hook.** Within a
> single `Shutdown(ctx)` call, the same `ctx` bounds the drain and then flows into each
> hook in turn — so if you pass a 5s context and the drain eats 4.5s, your hooks have
> only ~500ms of budget left. Size `ShutdownTimeout` (or the context you build manually)
> to cover both the request drain *and* the slowest resource you close in a hook.

## Drain hooks: `OnShutdown`

`Server.OnShutdown(fn)` registers a function to run during `Shutdown`, after the
request drain completes. This is where you close database pools, flush log buffers,
deregister from service discovery, or persist in-memory state. Source:
`celeris/server.go:224-227`.

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
  deadline — it will run to completion and delay your process exit.
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
`PauseAccept` and `ResumeAccept` do exactly that. Source: `celeris/server.go:515-540`.

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
full `Shutdown`) for portability. Source: `celeris/server.go:515-539`,
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

Source: `celeris/server.go:748-763` (`InheritListener`), `705-711`
(`StartWithListener`), `716-743` (`StartWithListenerAndContext`).

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
invalid fd. Source: `celeris/server.go:748-763`.

### Listener ownership: hands off

Once you pass a listener to `StartWithListener`, the server owns it. **Do not `Accept`
on it or `Close` it yourself.** What happens to the listener depends on the engine:

- **`std` engine:** the supplied listener is used directly to accept connections.
- **Native engines (`epoll`, `io_uring`, `adaptive`):** Celeris extracts the bound
  address from your listener, then **closes** that listener so the engine's workers
  can rebind their own `SO_REUSEPORT` sockets on the same `(host, port)`. This is by
  design — the multi-worker native engines need their own per-worker sockets.

In both cases the contract is the same: after calling `StartWithListener`, the
listener belongs to Celeris. Source: `celeris/server.go:557-711`.

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
4. The parent sends itself (or is sent) `SIGTERM`, drains in flight requests via its
   `StartWithContext`/`StartWithListenerAndContext` cancellation, runs its `OnShutdown`
   hooks, and exits.

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
- **Under-sizing the shutdown budget.** `ShutdownTimeout` (or your manual context)
  covers the request drain *and* every `OnShutdown` hook, sharing one deadline. If your
  hooks do real work (flushing a remote sink, closing pools), budget for it.
- **Expecting hook panics in the return value.** Hook panics are recovered and *not*
  reflected in `Shutdown`'s return. Log errors inside the hook.
- **Using `PauseAccept` on the std engine.** It returns
  `ErrAcceptControlNotSupported`. Accept control is native-engines-only.

## FAQ

**What's the default drain timeout?**
30 seconds — used by `StartWithContext` and `StartWithListenerAndContext` when
`Config.ShutdownTimeout` is zero or negative. When you call `Shutdown(ctx)` yourself
there is no default; you supply the context (`celeris/config.go:109-111`,
`celeris/server.go:777-780`).

**Is calling `Shutdown` on a server I never started safe?**
Yes. It returns `nil` immediately (after a harmless CPU-monitor cleanup). Source:
`celeris/server.go:367-372`.

**Do `OnShutdown` hooks run if the engine never started?**
No. If no engine was installed, `Shutdown` returns before reaching the hook loop. Hooks
fire only after a real drain.

**What happens to requests still running when the deadline expires?**
Per the engine contract, the engine closes remaining connections rather than waiting
indefinitely when the shutdown context's deadline elapses (`celeris/engine/engine.go:16-18`).
To bound this on the recommended path, set `Config.ShutdownTimeout`; if you call
`Shutdown(ctx)` directly, size the context you pass.

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
