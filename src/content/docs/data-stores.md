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

One limit applies to all three drivers. A driver opened with `WithEngine(srv)` on a
server whose `Config.Engine` is left unset does not recognise the server as async-capable
(`Server.AsyncHandlers()` answers false, even with `.Async()` routes), so a driver opened
before `Start` uses its own event loop instead of the direct path. Results are correct; only
the PostgreSQL pool was measured on this path, and it is measurably slower there. Set
`Engine: celeris.Adaptive` explicitly on Linux, which is the engine the default resolves to
there (`celeris.Std` elsewhere)
([celeris#1376](https://github.com/goceleris/celeris/issues/1376)).

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

In this mode `database/sql` owns the pool and the driver runs on a standalone
event loop. To colocate a `database/sql` pool with your server, build a
`*Connector` and rebind it with `WithEngine`, then `sql.OpenDB`
(`celeris/driver/postgres/connector.go` (`NewConnector`, `Connector.WithEngine`)):

```go
import "github.com/goceleris/celeris/driver/postgres"

conn, err := postgres.NewConnector("postgres://app:pass@localhost/mydb?sslmode=disable")
if err != nil {
    log.Fatal(err)
}
db := sql.OpenDB(conn.WithEngine(srv)) // colocated *sql.DB
defer db.Close()
```

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
| `WithHealthCheck(d)`         | Background ping sweep (0 disables) | 30s |
| `WithStatementCacheSize(n)`  | Per-conn prepared-statement LRU | 256 |
| `WithApplication(name)`      | `application_name` startup param | none |

#### Which mode is my Pool in, and the 64 MiB result cap

A Pool runs in one of two modes, and the mode decides how a large result is read:

| How the pool is opened | Mode | A result over 64 MiB |
| --- | --- | --- |
| a bare `postgres.Open(dsn)` | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |
| `WithEngine(srv)` on a server that has started (epoll, io_uring, adaptive), or that runs async handlers | direct | stops at the cap, `Rows.Err()` returns `ErrResultTooBig` |
| `WithEngine(srv)` on a server that has not started yet (or the std engine, async handlers off) | event loop | streams |
| `database/sql` (`sql.Open("celeris-postgres", dsn)`) | event loop | streams |

On a direct-mode Pool a result larger than 64 MiB stops at the cap and `Rows.Err()` returns
`ErrResultTooBig`: always check `Rows.Err()`, because `Next()` just returns false and `Close()`
returns nil. The cap is fixed (no option, no DSN parameter; the rows delivered are the ones
that fit under it). A single row larger than the cap fails the query itself (no rows;
`QueryContext` returns `ErrResultTooBig`); v1.5.11 returned that row and then the error. To
read larger results use `Pool.CopyTo`, a cursor (`DECLARE` / `FETCH`) inside a transaction, the
event-loop Pool or `database/sql`, which stream. v1.5.11 also returned `ErrResultTooBig` on
this path, after buffering the whole result (measured: 656 MiB of heap for a 97.7 MiB result,
about 6.7 times its size); the current driver stops at the cap
([celeris#1148](https://github.com/goceleris/celeris/pull/1148); a configurable or streaming
direct mode is [celeris#1426](https://github.com/goceleris/celeris/issues/1426)). Measured on a
linux/arm64 container with a 100000-row result of 1 KiB rows against postgres:16, one run each.

<!-- CANDIDATE PARAGRAPH, NOT PUBLISHED, NOT RENDERED: the bot takes the decision whether and how to publish it to Albert. Design question: celeris#1436. Facts: the reviewer's late-onRecv audit (E/lanes-20261122/CUT/LATE-ONRECV-AUDIT.md) and facts mails; main e74de74, real postgres:16, linux/arm64 docker; epoll loop mode only. Fill in the fix PR numbers and re-check the numbers on the pinned commit before publishing.

CANDIDATE A (publish if no opt-in for direct mode ships):

"Which programs are on the loop path. A streaming Rows consumer is a concern on the loop path only: database/sql through postgres.NewConnector (always), and the native Pool opened with WithEngine on a server that has not started or runs the std engine. A bare postgres.Open(dsn) and WithEngine on a started or async server are direct mode and are not affected (they read the whole result before Next, up to the 64 MiB cap above).

What a slow or paused consumer does to others. On the loop path a streaming Rows (a result over 64 rows) is read by an event-loop worker that waits for the consumer to take the next row, and that worker reads every connection placed on it. Measured with database/sql, 24 connections, 16 goroutines running SELECT 1 with a 10 s context, one 300,000-row result consumed with a sleep per row, 6 s window: with no consumer p50 142 us, p99 3.9 ms, max 42 ms; a consumer at 1 ms per row: p50 165 us, p99 3.8 ms, max 1.69 s; at 10 ms per row: p50 137 us, p99 3.4 ms, max 10 s (the queries' own deadline); after Close the numbers return to the baseline. The median and the p99 do not move; the few queries that land on the consumer's worker stall or reach their deadline. A consumer that pauses (reads a row and stops, without Close) freezes those queries for as long as it pauses: with a deadline the caller returns about 31 s after it (the deadline, up to 1 s for the cancel exchange, and a 30 s bound; the connection is replaced), and without one it waits.

How many connections are affected. The driver's own loop runs runtime.NumCPU() workers and is one loop for the whole process, shared by Redis, memcached and Postgres connections. database/sql places a connection on worker fd % workers; the native Pool's default MaxOpen is workers * 4. One paused consumer therefore freezes about 1/NumCPU of the pool's connections, and any Redis or memcached connection on the same worker. A second statement on a connection whose streaming Rows is still open (inside a Tx, or on a sql.Conn) waits for the first to be drained and is not interrupted by its context. Close of a DB, a Conn or a Pool also waits for an unread streaming Rows: measured, with an open and unread streaming Rows, db.Close, sql.Conn.Close and the native Pool.Close blocked until a 20 s watchdog, because Close waits for the worker that is parked on that stream (sql.Conn.Close also waits for open Rows by design). Read the Rows to the end or Close them before closing the DB.

After the first rows of a streaming result have arrived, a context deadline ends Next but Close still reads the rest of the reply and sends no cancel; for a long result under a deadline, expect Close to take as long as the server takes to finish (celeris#1443: measured, a 500 ms deadline over 10 s of slow rows ended Next at 524 ms and Close returned at 10.4 s).

A query issued inside a loop over a streaming result (the nested-query shape: an outer result above about 128 rows, an inner QueryRow on every row) on the default Connector, no engine, stalls under concurrency, on a warm pool as well as a cold one. Measured, 3,000 outer rows, inner SELECT 1 on every row, fresh sql.DB per run, real postgres:16, a 25 s context as the cap; "stalled" is an inner statement that took 1 s or more. One goroutine: 0 of 400 stalled, two goroutines 0 of 30. Four goroutines, cold default pool: 10 of 100 (5 ended by the 10 s connect_timeout with "startup timed out", 5 resolved late). Eight goroutines, cold default pool, 30 runs: 30 of 30 (25 by the connect_timeout, 5 late). Four goroutines, warm pool of 16 connections with the idle order shuffled, 30 runs: inner SELECT 1 18 of 30 (9 until the 25 s context, 9 resolved 1 to 24 s late) and an inner pg_sleep(0.02) 6 of 30, to the 25 s context; a stall on a warm connection has no connect_timeout bound, only the caller's context ends it, and without one it does not end. It needs concurrency, an outer result above about 128 rows and an inner query on the outer connection's worker. v1.5.11, same program, cold default pool: four goroutines 15 of 100 stalled (6 until the 25 s context, since v1.5.11 has no startup connect_timeout; the 10 s bound is new in v1.6), eight goroutines 30 of 30, so released versions stall too. With the Connector dialled in direct mode (scratch patch): four goroutines 0 of 100, eight goroutines 4 of 100 late (1.0 to 6.4 s) and none hung, warm shuffled pool 0 of 30 for each inner query, an outer result of 1,000 rows 0 of 50 and of 100,000 rows 0 of 30; above 64 MiB the caller read 326,310 rows and then Rows.Err() returned ErrResultTooBig with the connection still usable. Do not run a query on the same sql.DB while ranging over a large result: read the outer rows first.

What to do. Keep consumers draining and always Close the Rows (or end the context); a consumer that cannot keep up should read the rows into memory first. Use the native Pool without WithEngine (direct mode: no worker is shared, and a slow consumer affects nobody; a result above 64 MiB stops at the cap, see above). A CopyTo dest callback runs on the same worker and must not block (celeris#1434)."

Source of the nested-query numbers: E/lanes-20261122/CUT/CONNECTOR-STARTED-ENGINE.md, section 3 (NESTED-QUERY) and its tables; the harness is celeris/driver/postgres/cse_nested_test.go. The startup-on-dial prototype (CUT/pg-startup-on-dial.patch) did not help and is not a way out. The nested-query paragraph above is part of candidate A.

CANDIDATE C (PgBouncer and the statement cache; NOT PUBLISHED, NOT RENDERED; the bot decides what the page says; source E/lanes-20261122/CUT/PG-PGBOUNCER-26000.md; issues celeris#1454 (v1.6.1), #1455 (v1.6.0, names collide behind a pooler and can run another client's statement; fixed by #1456), #1462 (v1.6.1, the accumulation, measurements in E/lanes-20261122/CUT/OPUS-REVIEW-PR1456.md item 5); related #1405, #1360). Measured: Query with args 1,753-1,800 of 2,000 fail, QueryRow 1,800, Exec 0 after a DEALLOCATE ALL every 50 calls:

"CI runs PgBouncer 1.26.1 in transaction and session mode with prepared-statement support on (max_prepared_statements at its default of 200); transaction mode without prepared-statement support (max_prepared_statements=0) is not tested. Behind a pooler that shares server connections between clients and does not track prepared statements (PgBouncer transaction mode with max_prepared_statements=0), the default configuration is NOT supported: about half of SELECT calls fail with 26000; server-side statements grow until the pooler recycles its server connections (measured: about 6,400, 12,800 and 19,000 statements per server connection after three successive runs of 50 client connections each, up to 464 MiB per server connection, against 256 statements on a direct connection, the cache size); set auto_cache_statements=false; explicit Prepare does not work there; statement_cache_size=0 does not disable caching today (#1405). After a DEALLOCATE ALL or DISCARD ALL on a plain Postgres connection, a cached Query of a hot statement fails on every call from then on, because a hot text is never evicted."

CANDIDATE D (pool sizing; NOT PUBLISHED, NOT RENDERED; each claim reads alone; the bot decides what the page says; not a tuning tip; sources: E/lanes-20261122/CUT/POOL-MAXOPEN-OVERSHOOT.md; issues celeris#1457, #1458):

D1: "MaxOpen is a soft limit: under heavy contention a pool may exceed it by one or two connections (Postgres, Redis and memcached pools) (celeris#1457)."

D2: "MaxIdleTime is not enforced on the Postgres Pool while the health check is on, which is the default: idle connections live until MaxLifetime or until their worker's idle list is full (celeris#1458). The Redis and memcached pools enforce MaxIdleTime."

D3 (the numbers behind D2, for the sentence that gives them): "A pool whose idle connections are pinged every 30 s and never closed for idleness holds MaxOpen (plus up to two) server connections for MaxLifetime (default 30 min) after a burst. At the defaults on a host with 8 workers: MaxOpen is 8 x 4 = 32, each worker may keep 4 idle connections, so all 32 may stay open, plus up to 2 from D1: up to 34 server connections for 30 minutes after a burst, per Pool. Count every Pool of every process at MaxOpen + 2 for the whole MaxLifetime when sizing max_connections." Defaults: Postgres MaxOpen = NumWorkers x 4, MaxIdlePerWorker = max(ceil(MaxOpen / NumWorkers), 2), MaxLifetime 30 min, MaxIdleTime 5 min, health check 30 s; Redis PoolSize and memcached MaxOpen = NumWorkers x 4, MaxIdlePerWorker 2, MaxLifetime 30 min, MaxIdleTime 5 min, health check 30 s in the options of each driver. Measured by the reviewer: surplus connections stayed idle for 400 s (6 open at MaxOpen 4); peak MaxOpen + 1 or + 2 over 1,000,000 calls in every config, 6 flat over a 10-minute 33.8M-call run at MaxOpen 4.

CANDIDATE E (errors from writes, all three drivers; NOT PUBLISHED, NOT RENDERED; the bot decides what the page says; issues celeris#1460 (memcached), #1459 part 4 (Postgres); godoc PR celeris#1461):

"An error from a write does not prove that the write was not applied: a connection that closes right after the server answered can be reported as a failure (celeris#1460); do not blindly retry Incr, Decr or other non-idempotent commands on a connection error."

Facts behind it: memcached, event-loop path, 200 fresh clients per cell: with a FIN up to 5 of 200 in some Set/Get/Delete/Incr cells (binary loop Set 5, Get 4, Incr 3; text std Incr 2), 0 in others; with an RST 97 to 151 of 200; direct 0 of 200; the next call returns an error about a third of the time and succeeds on a fresh connection otherwise. Postgres has the same shape on the loop sync path (celeris#1459 part 4). Redis is probed; the same class may exist there (no result yet).

CANDIDATE F (the DSN reference entry for auto_cache_statements; NOT PUBLISHED, NOT RENDERED; the bot decides what the page says; today it is documented only in issue #1455 and a CI comment; sources: celeris/driver/postgres/dsn.go (parse: true/1/on/yes and false/0/off/no; default true), E/lanes-20261122/CUT/PG-PGBOUNCER-26000.md section 2 and 3.E, OPUS-REVIEW-PR1456.md):

"auto_cache_statements (DSN parameter; default true). By default a statement with arguments (a SELECT-style query, or a single INSERT, UPDATE or DELETE) is prepared the first time a connection runs it, under a name the driver mints, and reused afterwards from the connection's statement cache (statement_cache_size, default 256). With auto_cache_statements=false the driver creates no named server-side statement for Query, QueryRow or Exec: a statement with arguments is sent unnamed, as Parse, Bind, Execute and Sync in one flight. Set it to false behind a pooler that shares server connections between clients and does not track prepared statements: PgBouncer in transaction mode with max_prepared_statements=0 and similar. With the default there, about half of SELECT calls fail with 26000 and server-side statements accumulate until the pooler recycles its server connections (see the PgBouncer paragraph). What does not work with it: explicit Prepare (db.Prepare, Conn.PrepareContext) always creates a named statement, whatever this setting says, and behind max_prepared_statements=0 it fails (42P05). The cost: a Parse per call (the cache saved it). Statements without arguments use the simple protocol and are never cached, with either setting. statement_cache_size=0 and WithStatementCacheSize(0) do not turn the cache off today: 0 is read as 256 (celeris#1405); there is no Pool option for auto_cache_statements, only the DSN parameter."

CANDIDATE G (v1.6.0 release notes: driver fixes that also affect v1.5.x, and behaviour changes; NOT PUBLISHED, NOT RENDERED; the same text as E/lanes-20261122/CUT/RELEASE-NOTES-DRIVER-FIXES-CANDIDATE.md; v1.5.x users are told by the release notes only):

# CANDIDATE, NOT PUBLISHED: v1.6.0 release notes, "Driver fixes that also affect v1.5.x" and "Behaviour changes"

Written 2026-11-26 from the PR bodies and issues (`gh pr view` / `gh issue view`), the cut mail of 08:00Z (section 13) and `CUT/RELEASE-NOTES-ITEMS.md`. State of each PR as read while writing; the bot re-reads before the pin. Rules applied: v1.5.x users are told by these release notes only; measured facts only, each rate with its harness and count; `[VERIFY]` marks anything I could not tie to a PR body or issue; nothing is claimed for #1441 and #1447 (held for Albert). Same text is in docs#122, `data-stores.md`, as an HTML-commented candidate G (not rendered).

Status tags: MERGED = on main; OPEN = in the chain or cleared, not merged when written (keep the entry only if it merges); IN WORK = not yet pushed (conditional).


## Driver fixes that also affect v1.5.x

The PostgreSQL, Redis and memcached clients are in beta. These fixes are in v1.6.0; the cases below were measured on v1.5.11 or on main before the fix, as each entry says. Ordered by what matters to a reader.

### A. Fixes that touch data the caller did not ask to touch

**A1. A failed `Commit` no longer leaves the transaction usable (#1452, MERGED).**
Who: code that uses the native Pool's transaction (`Pool.BeginTx`, then `Tx.Commit` or `Tx.Rollback`). `database/sql` transactions were already correct.
What you could see: after a `Commit` that returned an error (a deferred unique constraint, SQLSTATE 23505, a killed backend, 40001) the `Tx` stayed usable. Statements run on it afterwards ran in autocommit and committed on their own (a second session saw the row), and a second `Commit` returned nil for a transaction that never committed. A program that returned on the error without a deferred `Rollback` kept the connection's pool slot: with `MaxOpen=2`, after two such failures `Pool.BeginTx` and `Pool.QueryRow` did not return (`acquire blocked and timed out`). Measured with a standalone reproducer (postgres:16, native Pool, `MaxOpen=2`), identical on main and on v1.5.11. On v1.5.11 only, `Commit` of a transaction the server had put in the aborted state returned nil (since #1390 it returns `ErrTxCommitRollback`).
Now: `Commit` or `Rollback` ends the `Tx` whatever it returns; later calls return `postgres.ErrTxDone`; the connection goes back to the pool only when the server's reply was read up to ReadyForQuery with the session idle, otherwise it is closed. See Behaviour change B1.

**A2. A result cut off by a lost connection ended as if it were complete (#1459, IN WORK: parts 1 to 3; [VERIFY] which parts merge; part 4 may move to v1.6.1).**
Who: the event-loop path: `database/sql` through `postgres.NewConnector`, and the native Pool opened with `WithEngine` on a server that has not started or runs the std engine. Direct mode already returned an error for `Query`.
What you could see: when the connection to PostgreSQL ended while a result was being read (the backend killed with `pg_terminate_backend`, a crash, a peer or proxy closing the socket), `Rows.Err()` was nil after fewer rows than the query produces. Measured on main `c3191ecb` against PostgreSQL 16, 10 iterations per cell, simple and extended protocol: `Err() == nil` after 999 of 20,000 rows (kill at row 1000, streaming) and after 24 of 50 rows (kill at row 25, buffered). With a proxy that cut just before `CommandComplete`, the loop path read all rows and reported success, and `QueryRow`/`Scan` returned the row with a nil error on the loop and the direct path. Harsh-matrix harness (`TestKPGStream`, native Pool, 80 calls per cell, a proxy cutting a 60,000-row reply at a random byte): 24 of 320 calls ended with `Err() == nil` after fewer rows on main (36 of 480 on `database/sql`); with the branch 0 of 320 and 0 of 480. A streaming result cut by `pg_terminate_backend` truncated silently on v1.5.11 too, measured on v1.5.11 with a probe (cut mail 13) [VERIFY: not in the PR body].
Now: a result that stops before the server's reply was read through ReadyForQuery returns an error from `Rows.Err()`, `Rows.Close()`, `Row.Scan`, `Exec` and `Commit`; it matches `ErrClosed` and `io.ErrUnexpectedEOF`, never `io.EOF`. See B6.

**A3. A query with more than one result set returned the first statement's rows under the last statement's column names (#1437, MERGED).**
Who: any `Query`, `QueryRow` or `QueryContext` (Pool, Tx or `*sql.DB`) whose text makes more than one statement return a result set (`SELECT ..; SELECT ..`).
What you could see, on real postgres:16 through `database/sql` and the native Pool (direct and loop): with a 10-row first set, `Columns()` were the second statement's names and `Scan` failed (`strconv.ParseInt: parsing "v1"` on `database/sql`, `Scan expected 2 dest, got 3` on the native Pool); with a 2,000-row first set the same wrong columns, the second statement's row as row 2001, and under `-race` a data race on the column slice; `SELECT 1 AS x; SELECT 2 AS x` returned both rows concatenated with no error. The same on v1.5.11 (reviewer's probe `r7-pgmulti`); on v1.5.11 the 2,000-row case crashed the process (see C1).
Now: the query returns `celeris-postgres: multiple result sets are not supported; the server has executed the statements`. See B3.

**A4. Statement names collided behind a pooler without prepared-statement support (#1456, OPEN; closes #1455).**
Who: clients that use the default DSN behind a pooler that shares server connections between clients and does not track prepared statements: PgBouncer in transaction mode with `max_prepared_statements=0`.
What you could see: statements were named `celst_N` (N per client connection), so two clients put two statements of one name on one server connection, and a `Bind` ran whichever was Parsed there. Measured by hand on PgBouncer 1.26.1 and postgres:16 (default DSN, `pool_size=2`): a client that ran only SELECTs got 0 rows and no error from 190 calls, and its Binds ran another client's cached INSERT (table rows 317,045 to 317,235). `TestPgBouncerNoPrep` (four scenarios, real PgBouncer, audit trigger on the table), cold review: on main `b6efd5c9` the SELECT-only client wrote 70, 49 and 110 audit INSERT rows in three scenarios; on the v1.5.11 tag, four-process scenario, it wrote 122 (the builder's +34 table rows did not reproduce in the reviewer's run; the kind of failure did); with the PR, 0 wrong statements in every run (`-race -count=3`).
Now: names are `celst_<128 random bits>_<n>`. What does NOT change: with the default DSN behind such a pooler about half of the SELECT calls still fail with SQLSTATE 26000 (279 to 315 of 600 calls per client in the reviewer's runs), and server-side statements accumulate (measured: about 6,400, 12,800 and 19,000 statements per server connection after three successive runs of 50 client connections each, up to 464 MiB per server connection; issue #1462). That configuration is not supported with the default DSN: set `auto_cache_statements=false` (0 errors, 0 wrong in the way-out test); explicit `Prepare` does not work there. See B8 and candidate C of the data-stores page (not rewritten here).

### B. Wrong values and silent success

**B-1. memcached: a request that failed was reused, and a late reply could land in another command (#1438, MERGED).**
Who: a memcached `Client` opened with `WithEngine` of a server that has no loop of its own (not started, or the std engine), which runs on the driver's own loop. Direct clients (no engine, started epoll/io_uring/adaptive, async servers) were not affected.
What you could see: after a command failed (deadline, cancel, closed or dropped connection), the worker could still write into its request after the caller returned, and the next command that reused the request got the late reply: `Get` returned the value of another key, `GetMulti` returned a key it did not ask for, a command returned before its own reply; `-race` reported it. Measured on v1.5.11 [VERIFY: ledger; not in the PR body]: text 20 wrong in 697,000 calls, binary 5 in 818,000, text under `-race` 3 wrong and 17 races, direct mode clean. Measured in the PR: started std server with 4 goroutines of HTTP load, 1,000,000 calls per row, no `-race`: text 521 wrong before and 0 after, binary 925 before and 0 after.
Now: a failed request is dropped, never reused. The writer-side root fix is v1.6.1.

**B-2. memcached binary protocol, event-loop path: a dropped connection returned success (#1448, OPEN).**
Who: a `Client` on the driver's own loop, binary protocol.
What you could see: when the server dropped the connection with a command in flight, the command returned success or a wrong answer. `TestDroppedConnFailsEveryCommand` on the base: 123 of its 513 cells fail in one run: 81 returned success (binary loop 40, binary std 41), 8 `ErrCacheMiss` (`Gets`), 13 a decoding error (`Incr`/`Decr`), 21 `celeris/engine: file descriptor not registered`. The split varies from run to run. Not asserted on v1.5.11 in the PR body [VERIFY].
Now: the command returns the close error. See B9.

**B-3. Redis: misuse of a `Pipeline` or `Tx` panicked, hung or raced (#1417, MERGED).**
Who: code that reads a typed result before `Exec`, queues a command on a `Tx` after `Exec`, calls `Pipeline.Exec` twice, or uses `Client.Watch`.
What you could see (`celeris/test/conformance/redis/handle_misuse_test.go`, real Redis, `-race`; failing on main): `Result()` before `Exec` or after an `Exec` that failed before sending: nil-pointer panic; a command queued on a `Tx` after `Exec`/`Discard`: panic; a second `Pipeline.Exec` after a successful one: blocked until the context ended (for ever with `context.Background()`) holding a pool connection; `Client.Watch` and two cluster ASKING paths read a result after returning the request to its pool: a data race, and the error could be missed or belong to another caller. On v1.5.11 and main, re-queueing and calling `Exec` after a dropped connection hung until the context ended; with the PR it works.
Now: these return errors at once. See B10.

**B-4. A statement could run after its context had ended (#1450, OPEN).**
Who: `Pool` (direct and loop) and `database/sql`, for a statement with arguments that the statement cache had not seen (the first call of a cacheable `SELECT`, `INSERT`, `UPDATE`, `DELETE`).
What you could see: when the context ended while the statement was being prepared, the error was dropped and the statement ran anyway under the ended context: a write could commit although the caller got `context.DeadlineExceeded` or `context.Canceled`; or the call returned `ErrClosed` ("connection closed") instead of the context's error. `TestPrepareEndedWriteIsNeverSent` (real server): 11 of 18 cells fail on main, 16 of 18 in the reviewer's run; pool-direct INSERT with a deadline: 40 of 40 calls returned the context's error and 40 of 40 rows were committed. `TestPrepareEndedByTheContextReportsTheContextError`: 12 "not confirmed" cases fail on main with `ErrClosed`. Whether the statement ran once or twice on main is not asserted by a test in the PR.
Now: the call returns the context's error and the statement is not sent.

**B-5. Redis: a late reply could reach a reused `Pipeline` request (#1418 and #1446, IN WORK; IF MERGED, otherwise v1.6.1).**
Conditional entry [VERIFY the PR state before the pin].
Who: the standalone Redis client (no `WithEngine`), and a started engine used from a handler where the loop runs the commands.
What you could see: a `Pipeline` released with `Release` was recycled through a `sync.Pool`, so a stale `Release` or `Discard` after another caller had re-acquired the same object wiped that caller's queue (their `Exec` returned nil and the key was never written), enqueue and `Exec` after `Release` panicked, and a stale typed handle returned the other caller's value (key `a` read back `BBBB`); audit against main `194ecf3`, redis:7.4. After a failed `Exec` a late reply could, rarely, reach a command of the next batch: reproduced only with an injected delay, 0 wrong in 2.2 million uninstrumented replies; the same on v1.5.11 and main.
Now: a released `Pipeline` is never recycled, and a failed `Exec` drops its request buffers. See B10.

### C. Crashes

**C1.** `close of closed channel` in `pgRequest.OnRowDesc`, on the event-loop worker, took the process down on v1.5.11 for a multi-statement query whose first result set was streaming (2,000 rows); fixed by #1437 (MERGED), see A3 [reviewer's probe `r7-pgmulti`; v1.5.11 measured with a probe].
**C2.** Nil-pointer panics from `Result()` before `Exec` and from a command queued on a finished `Tx`: #1417, see B-3.
**C3.** `send on closed channel` in `pgRequest.OnRow` after the 30 s cancel timer's `failAll` closed the row channel under a blocked sender: measured on v1.5.11 only (builder's evidence, `PG-BUSY-FIX.md`), fixed on main by #887, not by a PR of this list [VERIFY].

### D. Hangs, deadlocks, and the pool that does not recover

**D1. A context that ended over a large streaming result stalled the event-loop worker (#1440, MERGED).**
Who: `database/sql` through `NewConnector`, and the native Pool opened with `WithEngine` on a server that has not started, with a result of 64 rows or more (the reply is promoted to a stream).
What you could see: when the deadline passed after promotion, the caller waited with no timer and nothing drained the row channel, so the event-loop worker blocked in `sendRow`, could not read the server's cancel reply, and every connection on that worker stalled. Reproduced on real postgres:16 on main `a0509cbe`, and on v1.5.11 with an adapted copy of the test (goroutine dumps).
Now: the call returns the context's error. Cancelled-call return after the deadline, 500 iterations, run and not committed: p99 8 ms, max 14 ms; postgres:16, 2,100 iterations per entry, deadlines 0.2 to 15 ms [VERIFY the exact table in the PR]; worst case bounded: deadline, the cancel exchange (up to 1 s) and a 30 s bound, then the connection is closed. On postgres:18 under `-race` at load average 16 to 18, 12 of about 590 cancelled calls took over a second, 11 of them because the cancel was lost (the statement ran to its end; resending the cancel is #1443).

**D2. `Pool.CopyFrom` with a short deadline wedged the pool (#1442, OPEN).**
Who: `Pool.CopyFrom` (direct and loop).
What you could see: when the context ended while the call waited for the server to accept the COPY, the call, its pool slot and the server backend were stuck for good. Harsh matrix (bare `postgres.Open`, 8 goroutines, `CopyFromSlice` of 2 to 10 rows with a 24,000-byte pad, a 20 to 420 us deadline on half the calls): 62 calls, 20 failed, then all 8 goroutines stuck; 8 backends `active` in `COPY` for 9 to 10 s (a manual script, not committed).
Now: the call returns, the connection is closed and the pool replaces it. A context that ends later, after the server accepted the COPY, can still return an error although the COPY committed: do not retry a `CopyFrom` that returned a context error without checking the table.

**D3. A `Connector` on a started epoll, io_uring or adaptive server stopped the server (#1445, OPEN).**
Who: a `database/sql` `Connector` created with `WithEngine(srv)` where `srv` has started on epoll, io_uring or adaptive, with inline handlers.
What you could see: a handler that asked for a new connection waited for the startup reply on the worker that has to read the socket. Committed table on main `a0509cbe`: epoll, started, inline handlers, 16 clients: 0 of 120 requests completed (goroutine dump: workers in `Connector.Connect` -> `doStartup` -> `pgConn.wait`); the stream and "second connection" cells hung too. The native Pool already dialled direct in this case. On v1.5.11, measured with a probe (`CONNECTOR-STARTED-ENGINE.md`): 16 clients, epoll `SELECT 1`: 1 hang and 2 ok in 3 runs, stream and second-connection hang; the defect is old. Redis and memcached `WithEngine` on a started epoll or std server were clean (16 clients, 12 s, 0 errors, main and v1.5.11).
Now: the Connector dials direct in that case. See B7.

**D4. A second statement on a connection with an open streaming `Rows` deadlocked (#1449, OPEN).**
Who: `database/sql` code that runs a second statement on a `Tx` or `sql.Conn` while a first result of 64 rows or more is still open; event-loop path.
What you could see: the second statement ignored its context and `db.Close()` blocked too; harness `rv2_pgtxdead_test.go`: "second statement (3 s ctx) still blocked after 15 s", "db.Close also blocked after 10 s"; the same on v1.5.11.
Now: the second statement returns `ErrRowsOpen` at once. See B2.

**D5. A direct-mode Pool kept a dead connection after a write error (#1464, OPEN; fixes #1463).**
Who: the native Pool in direct mode (a bare `Open(dsn)`), after the server restarted or reset connections.
What you could see: a write that failed (RST: "connection reset by peer", then "broken pipe") left the connection in the pool, so the next calls got the same dead socket: more than one failed call per dead connection, up to every call, until the 30 s health check removed it. Real postgres:16 killed and restarted under a direct Pool with `MaxOpen=6`, one `Exec("SELECT 1")` per second (reviewer's run, not committed): the first 15 calls failed on main and one local port failed 10 times; with the PR 6 failures, one per port. A proxy that resets every session: 12 of 12 calls failed on a pool of 3 cut connections on main. Cut mail: a docker restart under `MaxOpen=6` gave 10 straight failed calls, a hard kill and start an 18 s outage, the same on v1.5.11 [VERIFY: cut mail 6a, not in the PR body]. Redis and memcached pools evict such connections.
Now: a write error fails and discards the connection.

### E. Smaller

**E1. A reply that does not match the request queue now fails the connection (#1453, OPEN, cleared).** Who: a server, proxy or pooler whose replies deviate from the protocol; and code that sent `COPY` through `Query`, `QueryRow`, `Exec` or `Prepare`. What you could see: the rest of the reply went to the next request: unrelated queries failed with `unexpected message 'd'`; a prepare took a `ReadyForQuery` as success (`TestPrepareUnexpectedMessageFailsConn`); a data race on `SkipParse`. See B5.
**E2. Documentation corrected (MERGED): #1427 (which Pools stop at 64 MiB and which stream), #1434 (`CopyTo`: `dest` is still called after it returned an error, and can be called once after `CopyTo` returned), #1431 (how late an io_uring or HTTP/2 timeout can fire).** #1429 is a test change only.
**E3. An error from a write does not prove the write was not applied (#1460, #1461).** A connection that closes right after the server answered can be reported as a failure (memcached event-loop path: up to 5 of 200 with FIN and 97 to 151 of 200 with RST, 0 on direct); do not blindly retry `Incr`, `Decr` or other non-idempotent commands on a connection error. v1.6.1 for the memcached behaviour; the sentence is in the godoc of all three drivers (#1461, comment only, draft).

**v1.5.x receives no further releases; upgrade to v1.6.0.**


## Behaviour changes (each with its migration hint)

- **B1. `ErrTxDone` after any `Commit` or `Rollback` of a native Tx (#1452; see A1).** A `Rollback` after a failed `Commit` returns `ErrTxDone` where it returned nil; a retried `Commit` or any statement on the ended Tx returns `ErrTxDone` (it matches `sql.ErrTxDone`; `api/driver/postgres.txt` gains `ErrTxDone`). Migration: do not reuse a `Tx` after `Commit` or `Rollback`; start a new one with `BeginTx`; a deferred `Rollback` can ignore `ErrTxDone`. `Commit` over an open streaming `Rows` returns an error matching `ErrRowsOpen` and ends the Tx [VERIFY: the bot's decision, carried into #1449 after #1452; the PR head still left the Tx open when this was written].
- **B2. `ErrRowsOpen` (#1449, OPEN; see D4).** A statement started on a connection with an open streaming `Rows` returns `ErrRowsOpen` (a new exported sentinel, `errors.Is`) instead of blocking. Migration: read the `Rows` to the end or `Close` them before the next statement on the same `Tx` or `sql.Conn`. A `Rows` of fewer than 64 rows is buffered and does not trigger it. On a `Connector` that dials direct (B7) there is no streaming and no `ErrRowsOpen`. `Tx.Rollback` over an open streaming `Rows` discards the connection and the `Rows` ends with an error matching `ErrClosed` and `io.ErrUnexpectedEOF`.
- **B3. Multiple result sets (#1437; see A3).** Callers that relied on identical-shape result sets being concatenated (`SELECT 1 AS x; SELECT 2 AS x`) now get `multiple result sets are not supported; the server has executed the statements`; a query is rejected whenever two statements return a result set, even an empty one, and `INSERT .. RETURNING ..; SELECT ..` is rejected. `Exec` with several statements and one-result-set strings (`SET; SELECT`, `SELECT; UPDATE`) are unchanged. Migration: send one row-returning statement per `Query`. A buffered first set returns the error and no rows; a streamed first set delivers its rows before the error.
- **B4. A misused `COPY` (#1453; see E1).** A `COPY` sent through `Query`/`QueryRow`/`Exec`/`Prepare` returns an error that names `CopyFrom` and `CopyTo` and closes the connection. Migration: use `Pool.CopyFrom` and `Pool.CopyTo`.
- **B5. Stricter protocol handling (#1453, OPEN).** A server or proxy whose replies deviate from the protocol (a message out of phase, a `ReadyForQuery` before the reply is complete, anything but `ReadyForQuery` after an `ErrorResponse` other than a further `ErrorResponse`, `NoticeResponse` or `ParameterStatus`) gets its connection closed and replaced. After a first `ErrorResponse` a second one is tolerated and the caller keeps the first error. That legitimate server behaviour is never closed is asserted only by the reviewer's run (60,000 calls of NOTICEs, `SET LOCAL`, `NOTIFY`, errors at every phase, cursors, `DEALLOCATE ALL`, multi-statement, `CALL INOUT`; PgBouncer 1.26.1 transaction and session modes; PostgreSQL 16 and 18): zero connections closed by the rule; that harness is not committed. Migration: none for a compliant server; a proxy that rewrites replies needs to keep them in order.
- **B6. Result ends (#1459, IN WORK; see A2) [VERIFY the parts that merge].** `Rows.Close()` returns the error the result ended with (it returned nil); a result cut off by a lost connection is an error from `Rows.Err()` that matches `ErrClosed` and `io.ErrUnexpectedEOF` and never `io.EOF`; native `Row.Scan` returns the error of `Rows.Close` when the scan itself went well, and never `sql.ErrNoRows` for a connection lost before the row. Migration: check `Rows.Err()` after the loop (code that ended on `io.EOF` from `Next` is unaffected); do not treat `ErrUnexpectedEOF` as an end of rows.
- **B7. A `Connector` on a started epoll, io_uring or adaptive server dials direct (#1445, OPEN; see D3).** It has the limits of a direct-mode Pool: a result is read whole and fails with `ErrResultTooBig` past 64 MiB (a 70 MB result returned all 70,000 rows on main and stops at 67,108 rows with the error); the error text is now `... (64 MiB); paginate the query`; a context cancelled with no deadline does not interrupt a running statement (main stopped it at 305 ms, the PR runs the full 3.0 s) while a deadline is honoured; a statement past a deadline returns `context.DeadlineExceeded` where it returned a `*PGError` with SQLSTATE 57014, so code that checks `pgErr.Code == "57014"` stops matching; `LISTEN`/`UNLISTEN` return `ErrDirectModeUnsupported` (main accepted them silently); `Connector.WithSocketBusyPoll` and the server's `SocketBusyPoll` do not apply (`TestConnectorOnAStartedServerSetsNoBusyPoll`). These reach every caller of that Connector, plain goroutines included. These numbers were measured by the reviewer with scratch programs that are not committed [VERIFY]. Migration: bind the Connector before the server starts, or use no engine, to keep streaming and the loop path. (#1441, direct by default for every `database/sql` connection, and #1447, the direct cancel watcher, are held and are NOT part of this list.)
- **B8. Statement names and the statement cache (#1456, #1455; #1405).** Names are `celst_<random>_<n>`; code that matched `celst_N` names in `pg_prepared_statements` must match the prefix. `statement_cache_size=0` and `WithStatementCacheSize(0)` do not turn caching off: 0 is read as 256 (#1405, v1.6.1); only `auto_cache_statements=false` in the DSN avoids named statements. Behind a pooler that shares server connections and does not track prepared statements the default configuration is not supported: see candidate C of the data-stores page (not repeated here).
- **B9. memcached `ErrClosed` wrapping (#1448, OPEN; see B-2).** The event loop's "loop is closed", the pool's "pool is closed" and the socket's "use of closed network connection" are returned as `ErrClosed` (wrapped with `%w`); a command whose connection closes under it returns the close error, where it could return success. `Client.Close` closes idle connections only, so a direct command in flight ends by its own reply or limit. Migration: test with `errors.Is(err, memcached.ErrClosed)`.
- **B10. Redis `Pipeline` and `Tx` (#1417 MERGED; #1418, #1446 IF MERGED).** Values obtained from a `Pipeline` (strings and typed results) are valid until `Release`; copy what you keep. A `Result()` before `Exec` returns `command has no result: its Pipeline or Tx was not executed`; a command queued on a `Tx` after `Exec` or `Discard` is not queued and its `Result()` returns `Tx already executed`; a second `Pipeline.Exec` after a successful one returns an error at once; `Tx` has no `Close` (use `Discard`; adding the alias is v1.6.1). A `Pipeline` whose `Exec` failed stays usable, and the failed-`Exec` `Result` reports the `Exec`'s own error. IF #1418 MERGES: `Exec` or an enqueue after `Release` returns an error wrapping `ErrClosed`; after `Discard` a handle reports `ErrClosed`. IF #1446 MERGES: after a failed `Exec` every command of the batch reports the `Exec`'s error, including one whose reply had already arrived; the next batch allocates new buffers (one slab allocation per failed `Exec`). Migration: do not read a `Pipeline` result after `Release`; after a failed `Exec` re-queue the commands, or `Discard`.
- **B11. `CopyFrom` after a context ends (#1442, OPEN; see D2).** The connection is closed and the pool replaces it. Do not retry a `CopyFrom` that returned a context error without checking the table (a retry can duplicate rows); in loop mode a later context end may return the server's 57014 `*PGError`, which does not match `errors.Is(err, context.DeadlineExceeded)`.
- **B12. A context that ended before a statement is sent (#1450, OPEN; see B-4).** The call returns the context's error and nothing is sent (`Pool.QueryContext` and `Pool.ExecContext` godoc). Migration: none; code that saw `ErrClosed` in this case now sees the context's error.
- **B13. Direct-mode write errors (#1464, OPEN; see D5).** A direct-mode connection whose write failed is discarded; the next call dials a new one. Migration: none.
- **B14. An error from a write does not prove the write was not applied (#1460, #1461).** Do not blindly retry `Incr`, `Decr` or other non-idempotent commands on a connection error (all three drivers).
- **B15. Items already collected in `CUT/RELEASE-NOTES-ITEMS.md`** (autocommit after `Exec("BEGIN")` on a `*sql.DB` #1410, session state, `WithWorker`, `ResetSession` discarding, `Rows` handles #1415/#1416, Redis `Tx` allocations, compress #1336, the final-differential items, the 64 MiB cap) stay as written there and are not repeated in this file [VERIFY that they are merged in the same notes].

## What I could not tie to a PR body or issue ([VERIFY] summary)

1. #1459: which parts merge; the exact wording of the `QueryRow` and `Rows.Close` changes.
2. v1.5.11 numbers taken from the ledger or the cut mail: memcached 20/697,000 and 5/818,000 (B-1); the silent truncation by `pg_terminate_backend` (A2); the 10 straight failed calls and 18 s outage (D5); C3 (`send on closed channel`, fixed by #887).
3. The #1445 limits are the reviewer's scratch measurements; #1449's `Commit` decision is carried after #1452.
4. #1418 and #1446 are conditional; #1445, #1449, #1453, #1456, #1448, #1450, #1442, #1464 were open when this was written.
5. D1's latency table: the PR body has two tables; check the figures before copying them.


CANDIDATE H = VARIANT D2 (database/sql loop path stays the default; direct is an opt-in, Connector.WithDirect(); the loop path's limits are documented as a KNOWN LIMIT; NOT PUBLISHED, NOT RENDERED; for the bot and Albert; sources: E/lanes-20261122/CUT/PG-WITHDIRECT.md, PG-WITHDIRECT-DOCS-FACTS.md, CONNECTOR-STARTED-ENGINE.md, LATE-ONRECV-AUDIT.md, PR #1441 body (control runs), issues #1436, #1443, #1375; [VERIFY] = not tied to a merged PR or a named test; #1447 is v1.6.1 under D2: do not describe it as shipped):

"The event-loop path of database/sql. A *sql.DB opened through this driver (sql.Open, NewConnector), and the native Pool opened with WithEngine on a server that has not started or runs the std engine, read replies on a shared event-loop worker. The following are known limits of that path, measured on postgres:16, linux/arm64:

1. A second statement on a Tx or a sql.Conn while a streaming result (64 rows or more) is still open does not return: the control run of the #1441 test blocked for more than 20 s and then hit its 90 s watchdog, and v1.5.11 behaved the same (second statement with a 3 s context still blocked after 15 s, db.Close blocked 10 s more). With the busy-guard change (#1449) the second statement returns ErrRowsOpen at once [VERIFY: #1449 had not merged when this was written]. Read the Rows to the end or Close them first.

2. A paused or slow consumer of a streaming result stalls the queries that share its worker. With 16 callers running SELECT 1 on 24 connections and one 300,000-row result held open and not read, the control run did not finish (60 s watchdog); at 1 ms per row the maximum latency was 1.69 s and at 10 ms per row 10 s (the queries' own deadline) while p50 and p99 did not move (database/sql, 24 connections, 16 load goroutines, 6 s window, reviewer's harness). The slow-consumer variant of the #1441 control did not reproduce in its one run. See the sizing numbers: one paused consumer freezes about 1/NumCPU of the connections, and any Redis or memcached connection on the same worker.

3. After the first rows of a streaming result have arrived, a deadline ends Next but Close reads to the end of the reply (celeris#1443; measured: a 500 ms deadline over 10 s of slow rows, Next ended at 524 ms and Close returned at 10.4 s). A deadline over a large result no longer stalls the worker (celeris#1440, merged; cancelled-call return p99 8 ms, max 14 ms in 500 iterations, run and not committed).

4. A query issued inside a loop over another query's rows, on the same *sql.DB, stalls under concurrency. Measured with a nested SELECT every 50 rows of a 3,000-row outer result, a 60 s watchdog, linux/arm64, PG16, three control runs on the loop: pool sizes 2 and 4 (1 and 2 callers) passed every time; size 16 (8 callers) failed in all 3 runs (a nested query got "startup timed out ... context deadline exceeded", then the watchdog); size 32 (16 callers) failed in the one run that reached it. Sizes 2 and 4 do not discriminate: the stall needs concurrency. With a nested SELECT 1 on every row of a 3,000-row outer result, four goroutines on a cold default pool stalled 10 of 100 runs, eight goroutines 30 of 30, and a warm shuffled pool 18 of 30; v1.5.11: four goroutines 15 of 100, eight 30 of 30 (CONNECTOR-STARTED-ENGINE.md section 3.3). Do not run a query on the same *sql.DB while ranging over a large result: read the outer rows first.

Way out: open the Connector with WithDirect [VERIFY: the name and the DSN key (direct=true) are the D2 branch's, not merged]. Its connections read each reply whole on the calling goroutine instead of streaming it through the event loop, so none of the cases above can stall other callers. Measured with direct connections (the D1 scratch and the D2 tests, same dial): the Tx second-statement test returned 1,000 rows with markers and then all 100,000 rows in order (0.35 s); with a 300,000-row result held open and not read, 16 callers on 24 connections had 0 errors and p50 338 us against 302 us at baseline; 200 iterations of the 300,000-row query under a 0.2 to 15 ms deadline: 26 ok, 174 deadline, none hung; nested-query pool sizes 2, 4, 16 and 32 passed. What it costs: a result is read whole, up to 64 MiB: the first row arrives after the last, and a larger result fails with ErrResultTooBig (a fixed cap under D2; paginate, use Pool.CopyTo or a cursor); the ErrResultTooBig text names options that exist [VERIFY]; a statement past a deadline returns context.DeadlineExceeded, not SQLSTATE 57014; SO_BUSY_POLL does not apply (Connector.WithSocketBusyPoll and the server's SocketBusyPoll); LISTEN and UNLISTEN fail with ErrDirectModeUnsupported (v1.5.11 accepted LISTEN and could never receive).

A context cancelled without a deadline does not interrupt a running statement; deadlines do. This is the documented limit of the direct-mode Pool (celeris#1375), and it applies to a direct connection of any kind: a Connector on a started epoll, io_uring or adaptive server (celeris#1445), and WithDirect users. Measured: a statement cancelled at 300 ms ran for the full 3.0 s on a direct connection and stopped at 305 ms on the loop. The direct cancel watcher (celeris#1447) is the v1.6.1 fix; it is not part of this release."

CANDIDATE I = VARIANT D1 (database/sql is direct by default, Connector.WithStreaming() or streaming=true is the opt-in for the event loop; PR #1441; NOT PUBLISHED, NOT RENDERED; written only for the bot to compare with H; [VERIFY] = depends on #1441 and the cancel-watcher PR it stacks on, neither merged when this was written):

"database/sql through this driver (sql.Open, NewConnector, Driver.Open) dials direct connections by default: the I/O runs on the calling goroutine through Go's netpoll, the reply is read whole before the call returns, and nothing is registered on the event loop; this is what a Pool without WithEngine already does. Connector.WithStreaming() or streaming=true in the DSN opts into the event loop, where rows are delivered as they arrive and there is no result cap.

What the default fixes (each has a test in celeris/test/conformance/postgres/direct_default_test.go on #1441, opened with sql.Open, and a control run with streaming=true on linux/arm64, PG16): a second statement on a Tx while a Rows is open (default: 1,000 rows each with its marker, then 100,000 rows in order; control: blocked after 20 s, then the 90 s watchdog); a paused 300,000-row Rows with 16 callers on SELECT 1 (default: 0 errors, max latency under 3 s; control: still running after 1 min); a 0.2 to 15 ms deadline over a 300,000-row result, 200 iterations (default: none hangs; control: SQLSTATE 57014 in iterations 1 and 2 and a 30 s hang in iteration 5); a nested query inside a rows loop at pool sizes 2, 4, 16 and 32 (default: pass; control: 16 failed in 3 of 3 runs, 32 in the one run that reached it, 2 and 4 passed). The slow-consumer subtest did not reproduce on the loop in its one control run.

What it costs: a result above 64 MiB of DataRow payload fails with ErrResultTooBig after the rows that fit; the cap is a setting, WithMaxResultBytes(n) on the Pool and the Connector (n of 1 or more; no DSN key), and WithStreaming has none; the first row arrives after the whole result has been read, with memory proportional to the result up to the cap [VERIFY: no test asserts the first-row timing]; Connector.WithSocketBusyPoll and the server's SocketBusyPoll do not apply; LISTEN and UNLISTEN fail with ErrDirectModeUnsupported, naming WithStreaming; a statement past a deadline returns context.DeadlineExceeded, not SQLSTATE 57014. Measured with the interleaved benchmark (database/sql, loopback docker, noisy, direct over loop): SelectOne 0.61, Select1000Rows_Text 1.03, TransactionRoundtrip 0.84, Parallel_QueryContext 0.77, equal allocations: measurements, not a performance claim.

The limits of the event-loop path still apply to a program that opts into WithStreaming: a second statement while a streaming Rows is open, a paused or slow consumer, a query inside a rows loop, and, after the first rows have arrived, a deadline that ends Next while Close reads to the end of the reply (celeris#1443: a 500 ms deadline over 10 s of slow rows, Next ended at 524 ms and Close returned at 10.4 s). A context cancelled without a deadline interrupts a statement on the loop but not on a direct connection until the cancel-watcher change is in [VERIFY: #1447 stacks under #1441; under D1 it must merge first]."

CANDIDATE B (a second alternative, ONLY IF the D2 PR is merged, i.e. Connector.WithDirect() exists): replace the last two sentences of "What to do" with: "Use the native Pool without WithEngine, or open the Connector with WithDirect() (direct mode: no worker is shared, a slow consumer affects nobody, a result above 64 MiB stops at the cap; the Connector's WithSocketBusyPoll does not apply to a direct connection)." Do not write WithDirect anywhere before the PR is merged: the name is a proposal.
-->


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

#### Session state on a pooled connection

Session-scoped state set through `Exec` (`SET`, `SET ROLE`, `set_config`, temporary tables, `LISTEN`, `PREPARE`, advisory locks) persists on a pooled connection, on `database/sql` and on the native `Pool`, which never resets.<!-- "as with other drivers" goes here ONLY after the agent doing the ResetSession code PR has verified the reference drivers; do not write it before. --> Use transaction-scoped settings (`SET LOCAL` or `set_config(..., true)`) inside a `Tx`, or a dedicated `db.Conn` cleaned up before it is returned.
<!-- depends on the ResetSession code PR (number to be filled in). Enable this line when it merges: "A connection released while a transaction is open (or failed) is discarded, not reused." Until then it is not published: this was not verified against main. -->

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
