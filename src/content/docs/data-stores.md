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

The contract lives in `middleware/store/kv.go`. `KV` is deliberately small — three
methods, all `context`-aware and all operating on raw `[]byte`:

```go
type KV interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}
```

The contract every backend must honor (`middleware/store/kv.go:24-40`):

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
(`middleware/store/kv.go:42-99`):

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

`store.NewMemoryKV` (`middleware/store/memory.go:56`) returns a sharded,
in-memory `*MemoryKV` that implements `KV` **plus every optional extension**
(`GetAndDeleter`, `Scanner`, `PrefixDeleter`, `SetNXer`, `Counter`). It is the
default store for every middleware that takes one, and the reference backend.

```go
import "github.com/goceleris/celeris/middleware/store"

kv := store.NewMemoryKV() // zero-config: NumCPU shards, 1-minute cleanup
defer kv.Close()          // stop the background expiry-reaper goroutine
```

Tune it with `MemoryKVConfig` (`middleware/store/memory.go:15-29`):

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

`store.Prefixed(inner, prefix)` (`middleware/store/prefix.go:16`) wraps any `KV`
and transparently prepends `prefix` to every key. This lets several middleware
share a single backend without key collisions:

```go
kv := store.NewMemoryKV()
defer kv.Close()

sessionStore := store.Prefixed(kv, "sess:")
cacheStore   := store.Prefixed(kv, "cache:")
```

The wrapper surfaces *most* capabilities: the value returned by `Prefixed`
re-implements whichever of `GetAndDeleter`, `Scanner`, `PrefixDeleter`, and
`SetNXer` the inner backend supports, rewriting keys and prefixes accordingly
(`middleware/store/prefix.go:37-95`). So a `Prefixed(memoryKV, ...)` still works for
session, cache, CSRF, and idempotency, and a `Prefixed(redisKV, ...)` exposes those
four where the Redis adapter does.

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
| Session       | `Store` | `store.KV` | `Scanner` for `Reset` (else no-op) | in-memory (`session.NewMemoryStore`) — `middleware/session/config.go:63-66,176-177` |
| Cache         | `Store` | `store.KV` | `PrefixDeleter`/`Scanner` for prefix invalidation | in-memory — `middleware/cache/config.go:12-13,84-85` |
| CSRF          | `Storage` | `store.KV` | `GetAndDeleter` for single-use tokens | **nil** — pure double-submit cookie mode (`middleware/csrf/config.go:73-82`) |
| Idempotency   | `Store` | `idempotency.KVStore` (`store.KV` + `store.SetNXer`) | **`SetNXer` is mandatory** | in-memory — `middleware/idempotency/config.go:15-24` |
| SSE replay    | `KV` | `store.KV` | `Counter` for cross-process IDs (else per-process) | none — you supply it — `middleware/sse/replay_kv.go:32-34` |

> **CSRF is the exception to the in-memory default.** Leaving `Config.Storage`
> unset runs CSRF in *pure double-submit cookie mode* (stateless — no server-side
> store at all). Set `Storage` only when you want server-side token validation;
> `SingleUseToken = true` **requires** it (the constructor panics otherwise —
> `middleware/csrf/config.go:198-199`).

> **Rate limiting is the exception.** The ratelimit middleware uses its own
> `ratelimit.Store` interface (`middleware/ratelimit/config.go:19`), **not**
> `store.KV` — its operations are token-bucket-shaped, not key/value-shaped.
> Redis-backed rate limiting ships as `middleware/ratelimit/redisstore`, which
> implements `ratelimit.Store` via `EVALSHA`. Do not pass a `store.KV` where a
> `ratelimit.Store` is expected.

Idempotency's requirement is worth calling out because it is a compile-time
constraint, not a runtime fallback:

```go
// idempotency.KVStore = store.KV + store.SetNXer (middleware/idempotency/config.go:15-18)
type KVStore interface {
    store.KV
    store.SetNXer
}
```

`store.MemoryKV` satisfies this out of the box (it implements `SetNXer` —
`middleware/store/memory.go:220`). Because `Config.Store` is typed as `KVStore`
(`middleware/idempotency/config.go:24`), a backend without atomic SetNX *cannot* be
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

`sessredis.New` (`middleware/session/redisstore/redisstore.go:74`) returns a
`*Store` that implements `store.KV` **plus** `Scanner` and `PrefixDeleter` (via
`SCAN` + `DEL`), so session `Reset` works across the cluster. The CSRF Redis store
(`middleware/csrf/redisstore`) additionally implements `GetAndDeleter` via Redis
`GETDEL` for safe single-use tokens.

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
`EventLoopProvider()` (`server.go:446-455`) and `AsyncHandlers()`
(`server.go:478-497`). The driver pulls the event loop from the first and its
effective async state from the second.

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

`redis.NewClient(addr, opts...)` (`driver/redis/client.go:22`) dials a lazy pool.
The typed surface covers strings, hashes, lists, sets, sorted sets, key ops,
pub/sub, scripting, pipelines, and `MULTI`/`EXEC` transactions; anything not typed
is reachable via `rdb.Do(ctx, args...)`. Common options
(`driver/redis/options.go`):

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
> (`driver/redis/client.go:23-24`).

### PostgreSQL

The Postgres driver offers two entry points (`driver/postgres/doc.go:6-37`):

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
(`driver/postgres/connector.go:32-67`):

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
(`driver/postgres/pool.go:126`):

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
options (`driver/postgres/pool.go:80-99`):

| Option                       | Effect | Default |
| ---------------------------- | ------ | ------- |
| `WithEngine(srv)`            | Colocate the pool on the server's event loop | standalone loop |
| `WithMaxOpen(n)`             | Total connection cap | `NumWorkers * 4` |
| `WithMaxIdlePerWorker(n)`    | Per-worker idle list cap | `ceil(MaxOpen / NumWorkers)` |
| `WithMaxLifetime(d)`         | Max age of a pooled conn | 30m |
| `WithMaxIdleTime(d)`         | Max idle before eviction | 5m |
| `WithHealthCheck(d)`         | Background ping sweep (0 disables) | 30s |
| `WithStatementCacheSize(n)`  | Per-conn prepared-statement LRU | 256 |
| `WithApplication(name)`      | `application_name` startup param | none |

> The Postgres driver enforces SSL policy from the DSN's `sslmode`. Use a valid
> `sslmode` for your deployment; the DSN is validated at `Open`/`NewConnector` time.

### Memcached

```go
import "github.com/goceleris/celeris/driver/memcached"

mc, err := memcached.NewClient("localhost:11211", memcached.WithEngine(srv))
if err != nil {
    log.Fatal(err)
}
defer mc.Close()
```

`memcached.NewClient(addr, opts...)` (`driver/memcached/client.go:34`) follows the
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

The verified driver signatures used above (`driver/redis/commands.go`,
`driver/postgres/pool.go`):

| Call | Signature | Miss / not-found sentinel |
| ---- | --------- | ------------------------- |
| `rdb.Get` | `Get(ctx, key string) (string, error)` | `redis.ErrNil` (`driver/redis/errors.go:10`) |
| `rdb.Set` | `Set(ctx, key string, value any, expiration time.Duration) error` | — |
| `rdb.Del` | `Del(ctx, keys ...string) (int64, error)` | — (returns 0 if no key matched) |
| `pool.QueryRow(...).Scan` | `QueryRow(ctx, query string, args ...any) *Row`; `(*Row).Scan(dest ...any) error` | `sql.ErrNoRows` (`driver/postgres/pool.go:974`) |

### How colocation works

When you pass `WithEngine(srv)`, the driver pulls the server's `EventLoopProvider`
(`server.go:446`) and registers its connection FDs on it. Concretely:

- Without `WithEngine`, each driver resolves a **standalone** event loop, shared
  and reference-counted across all drivers that omit `WithEngine`.
- With `WithEngine`, driver FDs land on the same worker goroutine as HTTP handlers.
  This saves one epoll/io_uring syscall per I/O and improves data locality — the
  Redis driver docs cite roughly 5–20% lower latency for serial queries
  (`driver/redis/doc.go:146-156`).

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
  worker. The drivers detect this (`server.go:457-497`, `AsyncHandlers`) and select
  their direct net-conn fast path.
- **Async dispatch off** — the handler runs inline on a `LockOSThread`'d worker. A
  blocking call there would stall the worker, so a different (mini-loop) path is used.

The key detail: `Server.AsyncHandlers()` reports the **effective** state — it
returns `true` if the server-level `Config.AsyncHandlers` is set **or** any route
opted in via `.Async()` / `.UsesDriver()` (`server.go:478-497`). So you have two
ways to put a driver route on the fast path:

```go
// Option A: server-wide async dispatch
srv := celeris.New(celeris.Config{Addr: ":8080", AsyncHandlers: true})

// Option B: mark just the routes that do blocking driver I/O
srv.GET("/users/:id", getUser).UsesDriver()
```

`.UsesDriver()` (`router.go:244-258`) is exactly equivalent to `.Async()` but reads
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
> (`router.go:253-255`).

> **Ordering footgun.** `AsyncHandlers()` reflects routes registered *so far*. If
> you rely on per-route `.UsesDriver()` (rather than the server-wide flag), open
> your `WithEngine` drivers **after** registering those routes — or just set
> `Config.AsyncHandlers = true` to be order-independent (`server.go:485-487`).

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
  (`server.go:441-455`) — the driver transparently falls back to a standalone loop,
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
