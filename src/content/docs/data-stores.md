---
title: Stores and database drivers
description: The pluggable KV store interface, in-memory and Redis backends, and event-loop-colocated database drivers.
group: Data & Integration
order: 1
---

Celeris ships two distinct-but-related data layers, and it helps to keep them apart from the start:

1. **The `store.KV` abstraction** — a tiny byte-level key/value interface that the
   built-in middleware (session, cache, CSRF, idempotency, SSE replay) persist
   through. You hand a middleware a `store.KV`; it does not care whether the bytes
   live in process memory or in Redis.
2. **Database drivers** — `driver/redis`, `driver/postgres`, and `driver/memcached`.
   These are full-featured clients you call directly from your handlers. Their
   distinguishing feature is that, when opened `WithEngine(srv)`, their socket I/O
   runs on the *same* worker threads as your HTTP handlers.

The two layers meet in the middle: the Redis driver (layer 2) backs the Redis
session/CSRF stores (layer 1). This page covers both, plus the async-handler
interaction that makes colocation worthwhile.

## The `store.KV` abstraction

The contract lives in `celeris/middleware/store/kv.go`. `KV` is deliberately small — three
methods, all `context`-aware and all operating on raw `[]byte`:

```go
type KV interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}
```

The contract every backend must honor (`celeris/middleware/store/kv.go` (`KV`)):

| Method     | Contract |
| ---------- | -------- |
| `Get`      | Returns `(nil, store.ErrNotFound)` on a missing or expired key. Returning `(nil, nil)` is **forbidden** — callers rely on `err != nil` to detect absence. |
| `Set`      | `ttl == 0` stores with no expiry. A positive `ttl` is honored; sub-second precision is best-effort. |
| `Delete`   | Idempotent — deleting a missing key returns `nil`. |
| All        | Safe for concurrent use from many goroutines. Bytes returned by `Get` are caller-owned (the backend copies). |

`store.ErrNotFound` is the single sentinel for "no such key". Adapters map their
native miss signal (Redis `nil`, `sql.ErrNoRows`, zero rows) onto it, so your code
can always write `errors.Is(err, store.ErrNotFound)`.

### Capability (extension) interfaces

Some middleware need more than Get/Set/Delete. Rather than bloat the core
interface, Celeris exposes optional **capability interfaces**. A backend implements
whichever it can support atomically; middleware feature-detect them with a type
assertion and fall back to emulation (or a documented no-op) when absent
(`celeris/middleware/store/kv.go` (`GetAndDeleter`)):

| Interface           | Method(s) | What it adds | Who needs it |
| ------------------- | --------- | ------------ | ------------ |
| `GetAndDeleter`     | `GetAndDelete` | Atomic GET+DEL (Redis `GETDEL`) | CSRF single-use token validation (TOCTOU-safe) |
| `Scanner`           | `Scan(prefix)` | Enumerate keys by prefix | Session `Reset` (delete all of a prefix) |
| `PrefixDeleter`     | `DeletePrefix(prefix)` | Efficient/atomic prefix delete | Cache `InvalidatePrefix` |
| `SetNXer`           | `SetNX` | Atomic "set if not exists" | Idempotency lock acquisition |
| `Scripter`          | `EvalSHA`, `ScriptLoad` | Server-side atomic scripts (Lua) | Redis ratelimit token-bucket |
| `Counter`           | `Increment` | Atomic post-increment counter | SSE replay shared cross-process ID space |

The fallback behavior matters when you choose a backend. For example, a backend
that does **not** implement `Scanner` makes session `Reset` a documented no-op; a
backend without `SetNXer` cannot serve as an idempotency store at all. The
capability table in the next section maps these requirements to concrete backends.

### `NewMemoryKV` — the in-memory backend

`store.NewMemoryKV` (`celeris/middleware/store/memory.go` (`NewMemoryKV`)) returns a sharded,
in-memory `*MemoryKV` that implements `KV` **plus every optional extension
except `Scripter`** (`GetAndDeleter`, `Scanner`, `PrefixDeleter`, `SetNXer`,
`Counter` — server-side Lua scripting is Redis-only). It is the
default store for every middleware that takes one, and the reference backend.

```go
import "github.com/goceleris/celeris/middleware/store"

kv := store.NewMemoryKV() // zero-config: NumCPU shards, 1-minute cleanup
defer kv.Close()          // stop the background expiry-reaper goroutine
```

Tune it with `MemoryKVConfig` (`celeris/middleware/store/memory.go` (`MemoryKVConfig`)):

| Field             | Type              | Default | Meaning |
| ----------------- | ----------------- | ------- | ------- |
| `Shards`          | `int`             | `runtime.NumCPU()`, rounded up to a power of two | Number of lock shards; more shards reduce contention under parallel load. |
| `CleanupInterval` | `time.Duration`   | `1 minute` | How often expired entries are evicted. |
| `CleanupContext`  | `context.Context` | `nil`   | If set, cancelling it stops the cleanup goroutine. If `nil`, `Close()` is the only way to stop it. |

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

kv := store.NewMemoryKV(store.MemoryKVConfig{
    Shards:          16,
    CleanupInterval: 30 * time.Second,
    CleanupContext:  ctx, // goroutine stops when ctx is cancelled
})
```

> **Always pair `NewMemoryKV` with a `Close()` or a `CleanupContext`.** A bare
> `NewMemoryKV()` whose handle you drop leaks the cleanup goroutine. After
> `Close()`, Get/Set/Delete still work, but expired entries are no longer reaped.

### `Prefixed` — sharing one backend across middleware

`store.Prefixed(inner, prefix)` (`celeris/middleware/store/prefix.go` (`Prefixed`)) wraps any `KV`
and transparently prepends `prefix` to every key. This lets several middleware
share a single backend without key collisions:

```go
kv := store.NewMemoryKV()
defer kv.Close()

sessionStore := store.Prefixed(kv, "sess:")
cacheStore   := store.Prefixed(kv, "cache:")
```

The wrapper implements all four extension interfaces — `GetAndDeleter`,
`Scanner`, `PrefixDeleter`, and `SetNXer` — **unconditionally**, rewriting keys
and prefixes accordingly (`celeris/middleware/store/prefix.go` (`prefixedKV.GetAndDelete`)). When the inner
backend supports a capability natively, `Prefixed` delegates to it; otherwise it
falls back (`GetAndDelete` → Get-then-Delete, `SetNX` → a *non-atomic*
Get-then-Set, and `Scan`/`DeletePrefix` → no-ops when the inner is not a
`Scanner`). So a `Prefixed(memoryKV, ...)` works for session, cache, CSRF, and
idempotency, and a `Prefixed(redisKV, ...)` delegates to Redis's native, atomic
implementations. Note the consequence: a `Prefixed` value always *satisfies*
`SetNXer`, but only guarantees atomic set-if-absent when the inner backend does
— matters for idempotency locks under concurrency.

> **`Prefixed` does not forward `Counter` or `Scripter`.** The wrapper only
> re-implements the four interfaces above, so a `Prefixed(memoryKV, ...)` is *not*
> a `store.Counter` even though the bare `MemoryKV` is. Wrapping a backend in
> `Prefixed` therefore demotes SSE replay to a per-process counter — pass the
> unwrapped `Counter`-capable backend (and the SSE store's own `CounterKey`) when
> you need cross-instance IDs.

### Which middleware accept a `Store`

These built-in middleware persist through a `store.KV` (or a capability superset
of it). Most default to an in-memory backend when you leave the field unset, so a
single-instance app needs zero store configuration:

| Middleware    | Config field | Type | Capabilities required | Default |
| ------------- | ------------ | ---- | --------------------- | ------- |
| Session       | `Store` | `store.KV` | `Scanner` for `Reset` (else no-op) | in-memory (`session.NewMemoryStore`) — `celeris/middleware/session/config.go` (`Config.Store`, `applyDefaults`) |
| Cache         | `Store` | `store.KV` | `PrefixDeleter`/`Scanner` for prefix invalidation | in-memory — `celeris/middleware/cache/config.go` (`Config.Store`, `applyDefaults`) |
| CSRF          | `Storage` | `store.KV` | `GetAndDeleter` for single-use tokens | **nil** — pure double-submit cookie mode (`celeris/middleware/csrf/config.go` (`Config.Storage`)) |
| Idempotency   | `Store` | `idempotency.KVStore` (`store.KV` + `store.SetNXer`) | **`SetNXer` is mandatory** | in-memory — `celeris/middleware/idempotency/config.go` (`KVStore`) |
| SSE replay    | `KV` | `store.KV` | `Counter` for cross-process IDs (else per-process) | none — you supply it — `celeris/middleware/sse/replay_kv.go` (`KVReplayStoreConfig`) |

> **CSRF is the exception to the in-memory default.** Leaving `Config.Storage`
> unset runs CSRF in *pure double-submit cookie mode* (stateless — no server-side
> store at all). Set `Storage` only when you want server-side token validation;
> `SingleUseToken = true` **requires** it (the constructor panics otherwise —
> `celeris/middleware/csrf/config.go` (`Config.validate`)).

> **Rate limiting is the exception.** The ratelimit middleware uses its own
> `ratelimit.Store` interface (`celeris/middleware/ratelimit/config.go` (`Store`)), **not**
> `store.KV` — its operations are token-bucket-shaped, not key/value-shaped.
> Redis-backed rate limiting ships as `middleware/ratelimit/redisstore`, which
> implements `ratelimit.Store` via `EVALSHA`. Do not pass a `store.KV` where a
> `ratelimit.Store` is expected.

Idempotency's requirement is worth calling out because it is a compile-time
constraint, not a runtime fallback:

```go
// idempotency.KVStore = store.KV + store.SetNXer (celeris/middleware/idempotency/config.go, KVStore)
type KVStore interface {
    store.KV
    store.SetNXer
}
```

`store.MemoryKV` satisfies this out of the box (it implements `SetNXer` —
`celeris/middleware/store/memory.go` (`MemoryKV.SetNX`)). Because `Config.Store` is typed as `KVStore`
(`celeris/middleware/idempotency/config.go` (`Config.Store`)), a backend without atomic SetNX *cannot* be
assigned to it — the constraint is enforced at compile time, not at runtime. There
is simply nowhere to acquire the lock without `SetNX`.

## Choosing a backend

The decision is almost entirely about **how many instances** of your service run.

### Single instance → in-memory

If exactly one process serves traffic, `store.NewMemoryKV` is the right default. It
is allocation-light, lock-sharded, and implements every capability interface, so
every middleware works at full fidelity (single-use CSRF tokens, session `Reset`,
prefix cache invalidation, idempotency locks). There is no network hop.

The catch: state is per-process. Sessions, idempotency locks, and cached responses
do not survive a restart and are not visible to other instances.

### Horizontally scaled → Redis (distributed)

The moment you run more than one instance behind a load balancer, in-memory state
fragments — a session created on instance A is invisible to instance B, and an
idempotency lock taken on A does not stop a retry from racing through on B. Move the
store to a backend every instance shares. Today that backend is **Redis**, via the
adapters in `middleware/session/redisstore`, `middleware/csrf/redisstore`, and the
SSE KV replay store pointed at a Redis-backed `store.KV`.

```go
import (
    "github.com/goceleris/celeris/driver/redis"
    "github.com/goceleris/celeris/middleware/session"
    sessredis "github.com/goceleris/celeris/middleware/session/redisstore"
)

// 1. open the Redis driver (colocated with the server — see below)
rdb, err := redis.NewClient("localhost:6379", redis.WithEngine(srv))
if err != nil {
    log.Fatal(err)
}
defer rdb.Close()

// 2. build a store.KV-compatible session backend on top of it
store := sessredis.New(rdb) // default key prefix "sess:"

// 3. hand it to the session middleware
srv.Use(session.New(session.Config{Store: store}))
```

`sessredis.New` (`celeris/middleware/session/redisstore/redisstore.go` (`New`)) returns a
`*Store` that implements `store.KV` **plus** `Scanner` and `PrefixDeleter` (via
`SCAN` + `DEL`), so session `Reset` works across the cluster. The CSRF Redis store
(`middleware/csrf/redisstore`) additionally implements `GetAndDeleter` via Redis
`GETDEL` for safe single-use tokens.

> **Tip: overlap the session store write with the next request.** When the
> session store is a network backend (Redis), the post-handler `Set` sits on the
> response critical path. Set `session.Config.WriteBehind = true`
> (`celeris/middleware/session/config.go` (`Config.WriteBehind`)) to hand the encoded session to a single
> bounded background worker so the round trip overlaps subsequent work. Pair it
> with `session.NewWithCloser` (`celeris/middleware/session/session.go`) and drain the
> returned `io.Closer` on graceful shutdown — an acknowledged response no longer
> guarantees the session is durable across an abrupt crash, so the drain flushes
> queued writes. `Session.Destroy` stays synchronous regardless.

### Capability requirements by middleware

When you swap a backend, double-check the capabilities the middleware needs:

| You want…                              | Backend must implement | If missing… |
| -------------------------------------- | ---------------------- | ----------- |
| Single-use CSRF tokens                 | `GetAndDeleter`        | falls back to non-atomic Get+Delete (a TOCTOU window) |
| Session `Reset` (clear all sessions)   | `Scanner`              | `Reset` is a documented no-op |
| Cache prefix invalidation              | `PrefixDeleter` or `Scanner` | emulated via Scan+Delete, weaker atomicity |
| Idempotency                            | `SetNXer`              | **won't compile** — `KVStore` requires it |
| SSE replay across instances (unique IDs) | `Counter`            | falls back to a per-process counter → ID collisions across instances |

The Redis adapters and `store.MemoryKV` cover these; if you write a custom backend,
implement the capability interfaces your middleware require.

## Colocated database drivers

The drivers under `driver/redis`, `driver/postgres`, and `driver/memcached` are
full clients you call directly from handlers. What makes them *Celeris* drivers is
**colocation**: when opened with `WithEngine(srv)`, their file descriptors register
on the same event loop the HTTP workers use, so a query issued from a handler on
worker N has its socket callbacks land on worker N too. That keeps the data on one
CPU's cache and saves an epoll/io_uring syscall per round trip.

In practice you pass the `*celeris.Server` itself to `WithEngine` — the server
satisfies the small provider interface the drivers consume by exposing
`EventLoopProvider()` (`celeris/server.go` (`Server.EventLoopProvider`)) and `AsyncHandlers()`
(`celeris/server.go` (`Server.AsyncHandlers`)). The driver pulls the event loop from the first and its
effective async state from the second.

**The drivers are in beta.** The exported API of the driver packages stays under the
compatibility check, but behaviour fixes (what a value scans to, which cases return an
error) may land in minor releases and are listed in the release notes.

One limit applied to all three drivers and is fixed ([celeris#1376](https://github.com/goceleris/celeris/issues/1376),
[celeris#1477](https://github.com/goceleris/celeris/pull/1477)). `Server.AsyncHandlers()` now resolves
an unset `Config.Engine` as `Start` does, so a driver opened with `WithEngine(srv)` takes the direct path
on a server that has async handlers, with `Config.Engine` set or not. Before the fix an unset engine made
`Server.AsyncHandlers()` answer false, even with `.Async()` routes, so a driver opened before `Start` used
its own event loop; results were correct, only the PostgreSQL pool was measured on that path, and it is
measurably slower there. Setting `Engine: celeris.Adaptive` explicitly on Linux (`celeris.Std` elsewhere)
avoided it.

### Redis

```go
import "github.com/goceleris/celeris/driver/redis"

rdb, err := redis.NewClient("localhost:6379",
    redis.WithEngine(srv),          // optional; omit for a standalone loop
    redis.WithPassword("secret"),
    redis.WithDB(0),
)
if err != nil {
    log.Fatal(err)
}
defer rdb.Close()

v, err := rdb.Get(ctx, "key")
```

`redis.NewClient(addr, opts...)` (`celeris/driver/redis/client.go` (`NewClient`)) dials a lazy pool.
The typed surface covers strings, hashes, lists, sets, sorted sets, key ops,
pub/sub, scripting, pipelines, and `MULTI`/`EXEC` transactions; anything not typed
is reachable via `rdb.Do(ctx, args...)`. Common options
(`celeris/driver/redis/options.go`):

| Option                         | Effect | Default |
| ------------------------------ | ------ | ------- |
| `WithEngine(srv)`              | Colocate I/O on the server's event loop | standalone loop |
| `WithPassword` / `WithUsername` | AUTH credentials (ACL on Redis 6+) | none |
| `WithDB(n)`                    | `SELECT` database index | 0 |
| `WithPoolSize(n)`              | Total connection cap | `NumWorkers * 4` |
| `WithDialTimeout(d)`           | TCP dial timeout | 5s |
| `WithProto(2\|3)`              | RESP version target | 3 (RESP2 fallback) |
| `WithForceRESP2()`             | Skip `HELLO`; speak RESP2 (ElastiCache classic) | off |

> TLS (`rediss://`) is **not** supported — `NewClient` rejects the scheme with a
> clear error. Deploy over a VPC, loopback, or a sidecar TLS terminator
> (`celeris/driver/redis/client.go` (`NewClient`)).

### PostgreSQL

The Postgres driver offers two entry points (`celeris/driver/postgres/doc.go`):

**(a) `database/sql`** — portable, works with any ORM. Import for the side-effect
registration, then `sql.Open` with the `celeris-postgres` driver name:

```go
import (
    "database/sql"
    _ "github.com/goceleris/celeris/driver/postgres" // registers "celeris-postgres"
)

db, err := sql.Open("celeris-postgres",
    "postgres://app:pass@localhost/mydb?sslmode=disable")
```

In this mode `database/sql` owns the pool and, by default, every connection is a direct connection
(see [database/sql: direct by default](#databasesql-direct-by-default-withstreaming-for-the-event-loop)
below). To set the Connector's options, build a `*Connector` and open it with `sql.OpenDB`
(`celeris/driver/postgres/connector.go` (`NewConnector`, `Connector.WithMaxResultBytes`)):

```go
import "github.com/goceleris/celeris/driver/postgres"

conn, err := postgres.NewConnector("postgres://app:pass@localhost/mydb?sslmode=disable")
if err != nil {
    log.Fatal(err)
}
db := sql.OpenDB(conn.WithMaxResultBytes(256 << 20)) // direct connections, 256 MiB result cap
defer db.Close()
```

`Connector.WithEngine(srv)` binds the Connector to the server's event loops, but only a
Connector with `WithStreaming()` uses them (and one bound to a server that had already started
on epoll, io_uring or adaptive is direct all the same): see the section below.

**(b) Direct `Pool`** — skips `database/sql` overhead and pins connections to
worker-affinity slots. This is the peak-throughput path
(`celeris/driver/postgres/pool.go` (`Open`)):

```go
pool, err := postgres.Open("postgres://app:pass@localhost/mydb?sslmode=disable",
    postgres.WithEngine(srv),
)
if err != nil {
    log.Fatal(err)
}
defer pool.Close()

var id int
var name string
err = pool.QueryRow(ctx,
    "SELECT id, name FROM users WHERE id = $1", 42,
).Scan(&id, &name)
```

The `Pool` API mirrors `database/sql`: `QueryContext`/`QueryRow` return `*Rows`/`*Row`
with the familiar `Next()`/`Scan()`/`Err()` loop, `ExecContext` returns a `Result`,
and `BeginTx` returns a `*Tx` with `Commit`/`Rollback` plus savepoints. `Pool`
options (`celeris/driver/postgres/pool.go` (`WithMaxOpen`)):

| Option                       | Effect | Default |
| ---------------------------- | ------ | ------- |
| `WithEngine(srv)`            | Colocate the pool on the server's event loop | none: a bare `Open(dsn)` is a direct-mode pool (see below) |
| `WithMaxOpen(n)`             | Total connection cap | `NumWorkers * 4` |
| `WithMaxIdlePerWorker(n)`    | Per-worker idle list cap | `ceil(MaxOpen / NumWorkers)` |
| `WithMaxLifetime(d)`         | Max age of a pooled conn | 30m |
| `WithMaxIdleTime(d)`         | Max idle before eviction | 5m |
| `WithHealthCheck(d)`         | Interval of the background ping sweep; 0 selects the default (it does not disable the sweep), a negative value turns it off | 30s |
| `WithStatementCacheSize(n)`  | Per-conn prepared-statement LRU | 256 |
| `WithMaxResultBytes(n)`      | Result buffer cap of a direct connection (n of 1 or more) | 64 MiB |
| `WithApplication(name)`      | `application_name` startup param | none |

#### Which mode is my Pool in, and the 64 MiB result cap

A Pool, or a `database/sql` handle, runs in one of two modes, and the mode decides how a large result is read:

| How it is opened | Mode | A result over 64 MiB |
| --- | --- | --- |
| a bare `postgres.Open(dsn)` | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |
| `WithEngine(srv)` on a server that has started (epoll, io_uring, adaptive), or that runs async handlers | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |
| `WithEngine(srv)` on a server that has not started yet and has no async handlers (no `Config.AsyncHandlers` and no `.Async()` route), or on the std engine | event loop | streams |
| `database/sql` (`sql.Open("celeris-postgres", dsn)`, `NewConnector`) | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |
| `database/sql` with `Connector.WithStreaming()` or `streaming=true` in the DSN | event loop | streams |
| `database/sql` with `Connector.WithStreaming()`, the Connector bound with `WithEngine(srv)` to a server that had already started (epoll, io_uring, adaptive) | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |

On a direct connection a result larger than the cap stops at the cap and `Rows.Err()` returns
`ErrResultTooBig`: always check `Rows.Err()`, because `Next()` just returns false and a caller
that checks nothing sees a truncated result with no other sign. The cap is 64 MiB by default and
is a setting: `postgres.WithMaxResultBytes(n)` on the Pool and `Connector.WithMaxResultBytes(n)`
(n of 1 or more; there is no DSN key); an event-loop connection has no cap. The rows delivered
are the ones that fit under it, and the `ErrResultTooBig` message names `WithMaxResultBytes`,
`Connector.WithStreaming` and paginating the query. A single row larger than the cap fails the
query itself: the call returns `ErrResultTooBig` and no rows, and the connection stays usable.
To read larger results raise the cap, use `Pool.CopyTo`, a cursor (`DECLARE` / `FETCH`) inside a
transaction, or an event-loop connection (`WithStreaming`). Before v1.6.0 a direct-mode Pool
buffered the whole reply, several times its size in memory, before it returned
`ErrResultTooBig`; the current driver stops at the cap
([celeris#1148](https://github.com/goceleris/celeris/pull/1148)).

#### database/sql: direct by default, `WithStreaming` for the event loop

`database/sql` through this driver (`sql.Open`, `NewConnector`, `Driver.Open`) dials **direct**
connections by default: the I/O runs on the calling goroutine through Go's netpoll, the whole
result is read before the call returns, and nothing is registered on the event loop. This is
what a Pool without `WithEngine` already does. `Connector.WithStreaming()`, or `streaming=true`
in the DSN, opts into the event loop, where rows are delivered as they arrive and there is no
result cap ([celeris#1441](https://github.com/goceleris/celeris/pull/1441), tracking the open
points in [celeris#1436](https://github.com/goceleris/celeris/issues/1436)). A Connector bound
with `WithEngine` to a server that had already started on epoll, io_uring or adaptive dials direct
connections even with `WithStreaming`, because those workers run an inline handler on their own
thread.

What the default changes, each with its one-line way back:

- A result above the cap fails with `ErrResultTooBig` after the rows that fit: raise `WithMaxResultBytes`, or use `WithStreaming`, or paginate.
- The first row arrives after the whole result has been read, and memory is proportional to the result up to the cap (by design). Each in-flight query holds its whole result, so N concurrent connections can hold N times the cap.
- `LISTEN` and `UNLISTEN` fail with `ErrDirectModeUnsupported` on direct connections. LISTEN/NOTIFY is not supported: the driver has no way to deliver notifications. On the event-loop path (`WithStreaming`) the statements are accepted and notifications are discarded, as in v1.5.11. `NOTIFY` works on every path; listen on a dedicated connection from another library (pgx or lib/pq).
- `Connector.WithSocketBusyPoll` and the server's `SocketBusyPoll` apply to the event loop only; the default connections make no `SO_BUSY_POLL` call.
- A statement that runs past a deadline returns `context.DeadlineExceeded` (a cancelled context, `context.Canceled`), not a `*PGError` with SQLSTATE 57014.

In v1.5.x every `database/sql` connection ran on the event loop and had these two stalls. Measured on postgres:16 (linux/arm64, a 10-CPU laptop shared with other work; the tests are in `celeris/test/conformance/postgres`, added by celeris#1441, each run against the default and, as a control, with `streaming=true`), the default does not have them:

| case | default (direct) | event loop (`streaming=true`) |
| --- | --- | --- |
| one 300,000-row result held open and not read, 16 callers on `SELECT 1` (24 connections) | 0 errors, max latency under 3 s | the callers on the paused consumer's worker wait, up to their own deadline or for ever |
| a nested query inside a loop over a 3,000-row result, pool sizes 2, 4, 16, 32 (half as many callers) | all pass | a nested query can stall under concurrency |

**`WithStreaming` brings the limits of the event-loop path with it** (they also apply to a native Pool opened with `WithEngine` on a server that has not started yet and has no async handlers):

- A second statement on a `Tx` or `sql.Conn` (or on a native `Pool` `Tx`) while a streaming result (64 rows or more) is still open returns `ErrRowsOpen` at once, without sending anything ([celeris#1449](https://github.com/goceleris/celeris/pull/1449)). Read the rows to the end or `Close` them first; after cancelling a query's context, call `rows.Close()` before the next statement. On v1.5.11 the second statement did not return (blocked after 15 s with a 3 s context, and `db.Close` blocked 10 s more). On a native `Pool` `Tx`, `Commit` over an open streaming result sends nothing, ends the transaction (it is rolled back, not committed) and returns `ErrRowsOpen`: close the rows before `Commit`. A `*sql.DB` is not affected (the second statement takes another connection), and a result of fewer than 64 rows never triggers it.
- A paused or slow consumer stalls the queries that share its worker: a streaming result is read by an event-loop worker that waits for the consumer to take the next row, and that worker serves every other connection placed on it, so their calls wait, up to their own deadline or for ever ([celeris#1436](https://github.com/goceleris/celeris/issues/1436)).
- `Close` of a `DB`, a `Conn` or a `Pool` waits for an unread streaming result: with an open, unread streaming result, `db.Close` and `Pool.Close` block ([celeris#1436](https://github.com/goceleris/celeris/issues/1436)).
- After the first rows have arrived, a deadline ends `Next` but `Close` still reads the rest of the reply and sends no cancel: for a long result under a deadline, `Close` takes as long as the server takes to finish it ([celeris#1443](https://github.com/goceleris/celeris/issues/1443)).
- A query issued inside a loop over another query's rows can stall under concurrency: the worker waits for the consumer to take a row while the nested query's reply needs that same worker. Read the outer rows first.

**Cancelling a context.** On a direct connection a context that ends while a statement runs ends the call, whether it ended by a deadline or by a cancel with no deadline ([celeris#1447](https://github.com/goceleris/celeris/pull/1447); before it, only a deadline did): the driver sends a CancelRequest and the call returns the context's error. Each CancelRequest is a new connection to the PostgreSQL postmaster: about 20 to 30 ms each, measured on a loaded host. There is no measured ceiling on the CancelRequest rate a server tolerates when many request contexts are cancelled at once. If the cancel exchange does not finish within 1 s (the dial is refused, the write fails, or the server does not close the cancel connection), the connection is discarded and replaced (a new dial and authentication), the call returns the context's error at once, and the statement may keep running on the server until it finishes.

> The Postgres driver enforces SSL policy from the DSN's `sslmode`. Use a valid
> `sslmode` for your deployment; the DSN is validated at `Open`/`NewConnector` time.

#### The statement cache

Every connection keeps a least-recently-used cache of server-side prepared
statements, 256 by default (`WithStatementCacheSize(n)` or `statement_cache_size=n`
in the DSN). A statement that has arguments (a `SELECT`-style query, or a single
`INSERT`, `UPDATE` or `DELETE`) is prepared the first time a connection runs it and
reused afterwards, which skips the parse and plan on the server. A statement without
arguments uses the simple protocol and is not cached, unless you prepare it with
`db.Prepare`. `statement_cache_size=0` does not turn the cache off: the driver reads 0
as 256. `auto_cache_statements=false` only stops the driver from preparing statements
by itself: a statement with arguments then runs unnamed and is parsed every time.

The key is the statement text. A connection that runs more distinct texts than the
cache holds evicts the least recently used one and closes it on the server: a
protocol-level `Close` is sent ahead of the query that evicted it, on the goroutine
that holds the connection, with no extra round trip and no wait. What a miss costs
is the round trip that prepares the new statement. Put values in arguments
(`WHERE id = $1`), not in the text (`WHERE id = 42`, or an `IN (...)` list whose
length changes), or raise the cache size to the number of distinct texts a connection
sees. Each cached statement also lives in the server's memory for the life of the
connection. The cache does not follow a schema change: after `ALTER TABLE ... ALTER
COLUMN ... TYPE` a statement already cached on a connection fails with SQLSTATE
`0A000` on that connection until it is closed
([celeris#1360](https://github.com/goceleris/celeris/issues/1360)).

> Before v1.6.0 an eviction started a background `DEALLOCATE` on the same connection
> the next query used: a `Pool` hung and a `database/sql` connection on Linux was
> closed with a protocol error, at the first eviction (the 257th distinct statement
> with the default size) (celeris#1371). Applications that build SQL text dynamically hit it.

#### Behind a connection pooler

A pooler that shares server connections between clients and does not track prepared statements (PgBouncer in transaction mode with `max_prepared_statements=0`) is not supported with the default DSN. About half of the `SELECT` calls with arguments fail with SQLSTATE `26000` (in the runs, 279 to 315 of 600 calls per client), and the named statements the driver creates accumulate on the server connections until the pooler recycles them ([celeris#1462](https://github.com/goceleris/celeris/issues/1462)): in a measurement with 50 client connections of 256 statements each, three runs in a row without restarting the pooler left about 6,400, then 12,800, then 19,000 statements on each server connection (up to 464 MiB per server connection), against 256 on a direct connection. Set `auto_cache_statements=false` in the DSN. An explicit `Prepare` (`db.Prepare`, `Conn.PrepareContext`) does not work behind such a pooler. With prepared-statement support on in the pooler (PgBouncer with `max_prepared_statements` above 0, the configuration the driver's CI tests) the default works, and the pooler bounds the statements (200 per server connection in that configuration).

`auto_cache_statements` (DSN parameter; `true`, `1`, `on`, `yes` or `false`, `0`, `off`, `no`; default `true`). By default a statement with arguments (a `SELECT`-style query, or a single `INSERT`, `UPDATE` or `DELETE`) is prepared the first time a connection runs it, under a name the driver makes up, and reused afterwards from the connection's statement cache (`statement_cache_size`, default 256). With `auto_cache_statements=false` the driver creates no named server-side statement for `Query`, `QueryRow` or `Exec`: a statement with arguments is sent unnamed, as Parse, Bind, Execute and Sync in one flight, and is parsed on every call. A statement without arguments uses the simple protocol and is never cached, with either setting. Explicit `Prepare` always creates a named statement, whatever this setting says. `statement_cache_size=0` and `WithStatementCacheSize(0)` do not turn the cache off: 0 is read as 256 ([celeris#1405](https://github.com/goceleris/celeris/issues/1405)). There is no `Pool` option for `auto_cache_statements`, only the DSN parameter.

#### Session state on a pooled connection

Session-scoped state set through `Exec` (`SET`, `SET ROLE`, `set_config`, temporary tables, `LISTEN`, `PREPARE`, advisory locks) persists on a pooled connection, on `database/sql` and on the native `Pool`, which never resets ([celeris#1409](https://github.com/goceleris/celeris/issues/1409)). Use transaction-scoped settings (`SET LOCAL` or `set_config(..., true)`) inside a `Tx`, or a dedicated `db.Conn` cleaned up before it is returned.

A connection released while a transaction is open (or failed) is discarded, not reused ([celeris#1410](https://github.com/goceleris/celeris/pull/1410)). On the native `Pool`, a call that leaves a transaction open (for example `Exec("BEGIN")`) returns `ErrTxLeftOpen`; a `database/sql` handle returns no error for it.

#### Known limits of the Postgres driver

**The pool's `MaxOpen` is a soft limit** ([celeris#1457](https://github.com/goceleris/celeris/issues/1457)). Under heavy contention the pool can dial a new connection at the moment an idle one is being returned, so it may hold one or two connections more than `MaxOpen` (in the measurement the peak was `MaxOpen` plus 1 or 2, and it did not climb further). The extra connections are not handed to two callers at once (in the measurement no connection was ever out twice). The pool code (`celeris/driver/internal/async/pool.go`) is shared by the native Postgres `Pool`, the Redis client and the memcached client, which therefore have the same soft limit; `database/sql` has its own pool and is not affected. When you size the server's `max_connections` (or Redis's `maxclients`, or memcached's connection limit), leave room for `MaxOpen` plus 2 per pool.

**`MaxIdleTime` is not enforced on the Postgres `Pool` while the health check runs**, which is the default ([celeris#1458](https://github.com/goceleris/celeris/issues/1458)). The health check pings every idle connection (every 30 s by default), the ping counts as a use of the connection, and so its idle time starts again at every sweep. When `MaxIdleTime` is longer than the health-check interval, as at the defaults (5 minutes against 30 seconds), the connection never reaches it. There is one way to make `MaxIdleTime` effective today: set `WithHealthCheck` to an interval longer than `MaxIdleTime`, so that the sweep finds a connection that has been idle since the sweep before it and closes it (by the code of the sweep, a connection is closed at the first or second sweep after it became idle; this was not measured). Turning the sweep off with a negative `WithHealthCheck` does not help: `MaxIdleTime` and `MaxLifetime` are then checked only when a connection is taken from its worker's idle list or returned to it, and the most recently returned connection is taken first, so older idle connections stay until they are taken or the pool is closed. `WithMaxIdlePerWorker` bounds how many idle connections a worker keeps (a connection returned beyond it is closed), not how long they stay. An idle connection is closed only when it reaches `MaxLifetime` (30 minutes by default) or when its worker's idle list is full. A pool therefore keeps up to `MaxOpen` connections (plus up to two, see above) for up to `MaxLifetime` after a burst, not for `MaxIdleTime`: at the defaults on a host with 8 workers, `MaxOpen` is 8 x 4 = 32 and each worker may keep 4 idle connections, so up to 34 server connections can stay open for 30 minutes after a burst, per `Pool`. When you size `max_connections`, count every `Pool` of every process at `MaxOpen` + 2 for the whole `MaxLifetime`. The Redis and memcached clients enforce `MaxIdleTime`.

**A cached `Query` fails after `DEALLOCATE ALL` or `DISCARD ALL`** ([celeris#1454](https://github.com/goceleris/celeris/issues/1454)). If the application runs `DEALLOCATE ALL` or `DISCARD ALL` on a connection (or a pooler between the driver and the server drops the prepared statements), a `Query` or `QueryRow` with arguments whose statement that connection has cached fails with SQLSTATE `26000` (the prepared statement does not exist), and it fails again on every later call, because a statement that stays in use is never evicted from the cache. `Exec` re-prepares the statement and is not affected. In a measurement with a `DEALLOCATE ALL` every 50 calls, about 1,800 of 2,000 `Query` calls with arguments failed and no `Exec` did. `statement_cache_size=0` does not help (the driver reads 0 as 256). What works: `auto_cache_statements=false` in the DSN (a statement with arguments then runs unnamed and is parsed on every call; no failure in the measurement), a statement prepared with `db.Prepare` (no failure in the measurement), or not running those commands on a pooled connection.

**`CopyFrom` after a context error may have committed.** A context that ends while the call waits for the server to accept the COPY closes the connection and returns the context's error, and no row was written. A context that ends later, once the server has accepted the COPY, can return an error although the COPY committed: the call returns `ctx.Err()` on one path and the server's cancellation error (a `*PGError` with SQLSTATE `57014`, which does not match `errors.Is(err, context.DeadlineExceeded)`) on another, and the server may already have committed the rows. In a run of 400 calls per mode with tight deadlines, 187 (direct mode) and 156 (event loop) returned an error although the COPY had committed. Do not retry a `CopyFrom` that returned a context error without checking the table: a retry can duplicate rows.

**A deadline that passes before the first row still has the whole reply read** ([celeris#1466](https://github.com/goceleris/celeris/issues/1466)). On a direct-mode `Pool`, when a statement's context deadline passes before any row has arrived, the driver still reads, parses and buffers the whole reply (up to the 64 MiB cap) while it drains the cancelled statement, so the call can return seconds after its deadline and holds the result's memory meanwhile.

**Calls right after the server resets connections can fail a few times** ([celeris#1465](https://github.com/goceleris/celeris/issues/1465)). On Linux, on the event-loop path (a native `Pool` opened with `WithEngine` on a server that has not started yet and has no async handlers, and `database/sql` with `WithStreaming`), calls made right after the server closed or reset the connections can fail several times in a row with `celeris/engine: file descriptor not registered` on the same connection. It heals within milliseconds; with a 20 ms pause between calls no repeated failure was seen.

**After a server restart the first statement on each idle `database/sql` connection fails once** ([celeris#1467](https://github.com/goceleris/celeris/issues/1467)). The same holds after a failover or `pg_terminate_backend`; the next statement works. On the default (direct) connections the error is the server's own FATAL error (a `*PGError`, SQLSTATE 57P01 for `pg_terminate_backend`; it does not match `ErrClosed`), or a connection-loss error that matches `ErrClosed` when the server only closed the socket. v1.5.x failed that statement too, with `ErrClosed`. Code that retries only on `ErrClosed` or `driver.ErrBadConn` must also retry on SQLSTATE class 57P.

**LISTEN/NOTIFY is not supported** ([celeris#1480](https://github.com/goceleris/celeris/issues/1480)). The driver has no way to deliver notifications. On direct connections `LISTEN` and `UNLISTEN` are refused with `ErrDirectModeUnsupported`; on the event-loop path the statement is accepted and notifications are discarded.

#### Errors from writes

An error from a write does not prove that the write was not applied. This holds for `Pool.ExecContext` and `Tx.ExecContext`, for `Pool.QueryRow` and `Tx.QueryRow` with a statement that has `RETURNING` (an `INSERT`, `UPDATE` or `DELETE ... RETURNING` statement is a write), and for `Tx.Commit`. A call whose reply was cut off by a lost connection returns an error, not a result that looks complete ([celeris#1459](https://github.com/goceleris/celeris/pull/1459)). One limit remains ([celeris#1470](https://github.com/goceleris/celeris/issues/1470)): a connection that closes right after the server answered can still be reported as a failure, although the whole reply had arrived and the write was applied. It showed in about one call in a thousand in a test that closes the connection at exactly that moment. Do not blindly retry a statement that is not idempotent (an `INSERT` without a unique key, an `UPDATE` that adds to a value) after a connection error: check the state first, or make the statement safe to repeat. The Redis and memcached clients document the same for their write commands; the memcached event-loop path has the same case ([celeris#1460](https://github.com/goceleris/celeris/issues/1460)), so do not blindly retry `Incr` or `Decr` there either.

### Memcached

```go
import "github.com/goceleris/celeris/driver/memcached"

mc, err := memcached.NewClient("localhost:11211", memcached.WithEngine(srv))
if err != nil {
    log.Fatal(err)
}
defer mc.Close()
```

`memcached.NewClient(addr, opts...)` (`celeris/driver/memcached/client.go` (`NewClient`)) follows the
same shape as the Redis client and accepts `WithEngine` to colocate. TLS is not
supported.

#### Known limits of the Redis and memcached drivers

- **Redis, a failed `Pipeline.Exec`:** when a deadline fires while the server drops the connection, two code paths can both record the error of the same command, so which error it reports (the connection's `EOF` or the context's) is not fixed, and the race detector can report it ([celeris#1433](https://github.com/goceleris/celeris/issues/1433); the fix is planned for v1.6.1).
- **Redis, a `Pipeline` after `Release`:** do not use a `Pipeline`, or a command handle it returned (`*StringCmd`, `*IntCmd`, ...), after `Release`: the Pipeline belongs to the pool again, and reading a handle you kept is undefined. Call `Release` at most once, and copy what you keep past `Release` (for example with `strings.Clone`): values read from a Pipeline are valid until `Release`.
- **Redis, a command above 4 MiB (Linux, the default client):** the default Redis client, built without `WithEngine`, runs on the driver's own event loop on Linux, which holds at most **4 MiB** of unsent bytes per connection. A command whose encoded frame is over 4 MiB, or does not fit beside the bytes already queued (a pipeline counts as one frame), such as a `SET` of a value of 4 MiB or more, fails with `ErrQueueFull` ("celeris/engine: worker write queue full"). Nothing is sent, and the driver closes that connection. A Redis client on a started epoll or io_uring server uses direct connections, and the engines' own driver write path allows 64 MiB. Postgres connections on the driver's loop (`WithStreaming`, or a `Pool` opened with `WithEngine` on a server that has not started) have the same 4 MiB cap, and there the connection stays usable. A change that raises the cap to 64 MiB is proposed in [celeris#1362](https://github.com/goceleris/celeris/pull/1362).
- **Redis, `DoString`, `DoInt` and `DoSlice` on RESP3 replies:** connections speak RESP3 by default (`HELLO 3`, with a fall back to RESP2 if the server rejects it). `DoString` returns an error (`celeris-redis: expected string reply, got double`, and likewise for a boolean, a big number or a map), `DoInt` returns `expected int reply, got bool` for a boolean, and `DoSlice` returns `expected array reply, got map` for a map; an element of a `DoSlice` result that is an integer, a double or a boolean reads as an empty string with no error. A change is proposed in [celeris#1353](https://github.com/goceleris/celeris/pull/1353).
- **memcached, binary `Add` on an existing key:** on the binary protocol `Add` (and `AddBytes`) on a key that already exists returns `ErrCASConflict` instead of `ErrNotStored`, as the `Add` doc comment says; the text protocol returns `ErrNotStored`. Nothing is stored in either case ([celeris#1451](https://github.com/goceleris/celeris/issues/1451)).

### Cache-aside: Redis in front of Postgres

The `driver/redis` and `driver/postgres` packages ship in the core
`github.com/goceleris/celeris` module — no extra dependency to pull in. The two
together give you the canonical cache-aside read path inside a handler: check
Redis, fall through to Postgres on a miss, then populate the cache. Get the
request context with `c.Context()` (there is no `c.Request()`):

```go
import (
    "database/sql"
    "errors"
    "time"

    "github.com/goceleris/celeris"
    "github.com/goceleris/celeris/driver/postgres"
    "github.com/goceleris/celeris/driver/redis"
)

func getUser(rdb *redis.Client, pool *postgres.Pool) celeris.HandlerFunc {
    return func(c *celeris.Context) error {
        ctx := c.Context()
        key := "user:" + c.Param("id")

        // 1. Try the cache. A miss surfaces as redis.ErrNil.
        if v, err := rdb.Get(ctx, key); err == nil {
            return c.String(200, v)
        } else if !errors.Is(err, redis.ErrNil) {
            return err // a real Redis error, not a miss
        }

        // 2. Cache miss → load from Postgres. No row → 404.
        var name string
        err := pool.QueryRow(ctx,
            "SELECT name FROM users WHERE id = $1", c.Param("id"),
        ).Scan(&name)
        if errors.Is(err, sql.ErrNoRows) {
            return c.String(404, "not found")
        }
        if err != nil {
            return err
        }

        // 3. Populate the cache for next time (5-minute TTL).
        if err := rdb.Set(ctx, key, name, 5*time.Minute); err != nil {
            return err
        }
        return c.String(200, name)
    }
}
```

Register it on a driver route so the blocking round trips park the handler
goroutine instead of stalling an I/O worker:

```go
srv.GET("/users/:id", getUser(rdb, pool)).UsesDriver()
```

On a write, invalidate the cached entry so the next read repopulates it. `Del`
returns `(int64, error)` — the count of keys removed — so capture both values
rather than discarding to a single variable:

```go
if _, err := pool.ExecContext(ctx,
    "UPDATE users SET name = $1 WHERE id = $2", newName, id,
); err != nil {
    return err
}

n, err := rdb.Del(ctx, "user:"+id) // n == 0 simply means the key wasn't cached
if err != nil {
    return err
}
_ = n
```

The verified driver signatures used above (`celeris/driver/redis/commands.go`,
`celeris/driver/postgres/pool.go`):

| Call | Signature | Miss / not-found sentinel |
| ---- | --------- | ------------------------- |
| `rdb.Get` | `Get(ctx, key string) (string, error)` | `redis.ErrNil` (`celeris/driver/redis/errors.go` (`ErrNil`)) |
| `rdb.Set` | `Set(ctx, key string, value any, expiration time.Duration) error` | — |
| `rdb.Del` | `Del(ctx, keys ...string) (int64, error)` | — (returns 0 if no key matched) |
| `pool.QueryRow(...).Scan` | `QueryRow(ctx, query string, args ...any) *Row`; `(*Row).Scan(dest ...any) error` | `sql.ErrNoRows` (`celeris/driver/postgres/pool.go` (`Row.Scan`)) |

### How colocation works

When you pass `WithEngine(srv)`, the driver pulls the server's `EventLoopProvider`
(`celeris/server.go` (`Server.EventLoopProvider`)) and registers its connection FDs on it. Concretely:

- Without `WithEngine`, each driver resolves a **standalone** event loop, shared
  and reference-counted across all drivers that omit `WithEngine`.
- With `WithEngine`, driver FDs land on the same worker goroutine as HTTP handlers.
  This saves one epoll/io_uring syscall per I/O and improves data locality — the
  Redis driver docs cite lower latency from better data locality for serial
  queries (`celeris/driver/redis/doc.go`).

**Correctness is identical** with or without `WithEngine`; the difference is purely
performance.

## Standalone vs engine-colocated mode

`WithEngine` is **always optional**. Drivers run perfectly well standalone (e.g. in
a worker process, a CLI, or a test) — they resolve a private event loop on first
use. Reach for `WithEngine(srv)` only when the driver is called from inside an HTTP
handler and you want the colocation win.

### The async-handler interaction (important)

Colocation interacts with Celeris's async dispatch, and getting it wrong leaves
performance on the table. The drivers read the server's **effective** async state
at dial time and pick their I/O path accordingly:

- **Async dispatch on** — the handler runs on a spawned, unlocked goroutine, so a
  blocking driver call parks that goroutine on Go's netpoll without stalling an I/O
  worker. The drivers detect this (`celeris/server.go` (`Server.AsyncHandlers`), `AsyncHandlers`) and select
  their direct net-conn fast path.
- **Async dispatch off** — the handler runs inline on a `LockOSThread`'d worker. A
  blocking call there would stall the worker, so a different (mini-loop) path is used.

The key detail: `Server.AsyncHandlers()` reports the **effective** state — it
returns `true` if the server-level `Config.AsyncHandlers` is set **or** any route
opted in via `.Async()` / `.UsesDriver()` (`celeris/server.go` (`Server.AsyncHandlers`)). So you have two
ways to put a driver route on the fast path:

```go
// Option A: server-wide async dispatch
srv := celeris.New(celeris.Config{Addr: ":8080", AsyncHandlers: true})

// Option B: mark just the routes that do blocking driver I/O
srv.GET("/users/:id", getUser).UsesDriver()
```

`.UsesDriver()` (`celeris/router.go` (`Route.UsesDriver`)) is exactly equivalent to `.Async()` but reads
as intent at the call site — it marks a route whose handler performs a blocking
backend round trip via a Celeris driver. It is the recommended way to flag driver
routes:

```go
srv.GET("/users/:id", getUser).UsesDriver()   // == .Async(), clearer intent
```

> **Why per-route marking matters.** The adaptive safety net
> (`Config.AsyncHandlers = true` alone) only auto-promotes handlers slower than
> ~300µs. A fast localhost driver call (sub-300µs) would otherwise keep blocking a
> worker on every request. Mark such routes explicitly with `.UsesDriver()`
> (`celeris/router.go` (`Route.UsesDriver`)).

> **Ordering footgun.** `AsyncHandlers()` reflects routes registered *so far*. If
> you rely on per-route `.UsesDriver()` (rather than the server-wide flag), open
> your `WithEngine` drivers **after** registering those routes — or just set
> `Config.AsyncHandlers = true` to be order-independent (`celeris/server.go` (`Server.AsyncHandlers`)).

## Platform support

The drivers under `driver/redis`, `driver/postgres` and `driver/memcached`, and the middleware
stores built on them (CSRF, JWT cache, rate limit and session stores over Redis, Postgres and
memcached), run on the celeris event loop on **Linux**. Linux is the supported production path and
the one the benchmarks measure. On macOS and the other unix hosts they run on a
goroutine-per-connection fallback, for development and testing.

On **Windows** the drivers and every store compile (`GOOS=windows go build ./...` and `go vet ./...`
pass over the whole module) and work through the same kind of portable fallback: each connection is
a `net.Conn` read by its own goroutine, with no `WithEngine` colocation, no write queue and no
tuning. CI cross-compiles for windows/amd64 and windows/arm64 and runs the fallback's tests and the
drivers' fake-server tests on `windows-latest`; the integration suites against real Redis, Postgres
and memcached run on Linux only. Windows is not benchmarked and is not a production target: deploy
on Linux.

## Common pitfalls

- **Dropping a `MemoryKV` without `Close()`.** Leaks the cleanup goroutine. Call
  `Close()` or pass a `CleanupContext`.
- **Expecting `(nil, nil)` from `Get` on a miss.** The contract returns
  `(nil, store.ErrNotFound)`. Test with `errors.Is(err, store.ErrNotFound)`.
- **Using an in-memory store across multiple instances.** State fragments per
  process; sessions, locks, and caches won't be shared. Switch to a Redis-backed
  store for horizontal scaling.
- **Passing a non-`SetNXer` backend to idempotency.** `idempotency.KVStore` requires
  `store.SetNXer`; a backend without it won't satisfy the interface.
- **Confusing `store.KV` with `ratelimit.Store`.** Rate limiting uses its own
  interface; use `middleware/ratelimit/redisstore` for distributed rate limiting.
- **`WithEngine` without a native engine.** Colocation needs an event-loop engine.
  On the `std` (net/http) fallback engine, `EventLoopProvider()` returns `nil`
  (`celeris/server.go` (`Server.EventLoopProvider`)) — the driver transparently falls back to a standalone loop,
  so you lose the colocation benefit (correctness is unaffected).
- **Forgetting to mark fast driver routes.** A sub-300µs driver call on a route
  that isn't `.Async()`/`.UsesDriver()` (and without server-wide `AsyncHandlers`)
  blocks an I/O worker every request. Mark it.
- **Expecting `rediss://` / TLS.** Not supported by the Redis driver yet; terminate
  TLS at a sidecar or use a private network.

## FAQ

**Do I need the database drivers to use the stores?**
No. The middleware stores depend only on `store.KV`. The in-memory backend has zero
external dependencies. You only pull in `driver/redis` when you want a distributed
store or want to call Redis from your handlers.

**Can one backend serve several middleware?**
Yes — wrap it with `store.Prefixed(inner, "sess:")`, `store.Prefixed(inner, "csrf:")`,
etc., so keys don't collide. The prefix wrapper preserves the backend's capability
interfaces.

**Is `WithEngine` required for colocated drivers?**
No. It is optional; without it a standalone, reference-counted loop is resolved.
`WithEngine` only adds the colocation performance win, with identical correctness.

**Will a driver call block my I/O worker?**
Only if the route isn't dispatched async. Set `Config.AsyncHandlers = true` or mark
the route `.UsesDriver()` so the blocking call parks the handler goroutine on
netpoll instead of stalling a worker.

**Which store capabilities does `MemoryKV` support?**
All of them: `GetAndDeleter`, `Scanner`, `PrefixDeleter`, `SetNXer`, and `Counter`.
That's why it works as a full-fidelity default for every middleware.

## Related pages

- [Core concepts](/docs/core-concepts) — async dispatch and the handler model.
- [Engines](/docs/engines) — the epoll / io_uring / std engines that back colocation.
- [Middleware](/docs/middleware) — overview of the built-in middleware that consume
  these stores.
- [Auth middleware](/docs/middleware-auth) — session, CSRF, and idempotency, all
  store-backed.
- [Traffic middleware](/docs/middleware-traffic) — caching and rate limiting.
- [Routing](/docs/routing) — `.Async()` and `.UsesDriver()` route options.
