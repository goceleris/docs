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

Source of the nested-query numbers: E/lanes-20261122/CUT/CONNECTOR-STARTED-ENGINE.md, section 3 (NESTED-QUERY) and its tables; the harness is driver/postgres/cse_nested_test.go. The startup-on-dial prototype (CUT/pg-startup-on-dial.patch) did not help and is not a way out. The nested-query paragraph above is part of candidate A.

CANDIDATE C (PgBouncer and the statement cache; NOT PUBLISHED, NOT RENDERED; the bot decides what the page says; source E/lanes-20261122/CUT/PG-PGBOUNCER-26000.md; issues celeris#1454, #1455; related #1405, #1360):

"CI runs PgBouncer 1.26.1 in transaction and session mode with prepared-statement support on (max_prepared_statements at its default of 200); transaction mode without prepared-statement support (max_prepared_statements=0) is not tested. After DEALLOCATE ALL or DISCARD ALL run by the application, and behind a pooler that drops or renames prepared statements, a repeated parameterised Query or QueryRow of a cached text fails with SQLSTATE 26000 on every call until the entry is evicted or the connection closes, and behind a shared pooler without prepared-statement support it can run another client's statement; put auto_cache_statements=false in the DSN (a Parse per call) and do not use Prepare there. statement_cache_size=0 and WithStatementCacheSize(0) do not turn the cache off (they become 256, #1405)."

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
