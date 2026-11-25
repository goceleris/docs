---
title: Redis replies
description: How the celeris Redis driver returns each Redis reply type on RESP3 and RESP2, which typed helpers accept which reply, and the known gaps.
group: Data & Integration
order: 4
---

This page lists how the celeris Redis driver (`driver/redis`) returns each kind of reply from the server, so you can check what to expect from `Do` and from the typed helpers. For how to create a client and the rest of the driver, see [Stores and database drivers](/docs/data-stores).

The PostgreSQL, Redis and memcached clients are in beta: the exported API of the driver packages stays under the compatibility check, but behaviour fixes (what a value scans to, which cases return an error) may land in minor releases and are listed in the release notes.

The client speaks RESP3 by default and falls back to RESP2 when the server does not support it or when you pass `WithForceRESP2()`. Some replies exist only on RESP3 (a double, a boolean, a big number); on RESP2 the server sends the same data in a simpler form, and the tables show both.

## How to read the tables

- **Supported** is `Yes` when the reply is returned correctly on both RESP3 and RESP2. `With v1.6.0` means a fix is in review for v1.6.0. `Partly` and `No` mean there is a gap that stays after v1.6.0.
- `Do(ctx, args...)` returns a `*Value`. Its `Type` field says what the server sent, and the payload is in one field of `Value`: `Str`, `Int`, `Float`, `Bool`, `BigN`, `Array` or `Map`.
- The typed helpers `DoString`, `DoInt`, `DoBool` and `DoSlice` convert a reply to a Go value. They return an error when the reply is not of their kind; that is on purpose, and the table lists those as "returns an error on purpose".
- The gap numbers link to [Known gaps](#known-gaps) at the end of the page.

## Reply types

<!-- driver-types:begin redis reply-types -->
| Reply | Supported | How `Do` returns it | Notes and known gaps |
| --- | --- | --- | --- |
| Simple string (+OK) | Yes | `Value.Type` is `TySimple`, the payload is in `Value.Str` | `OK` and `PONG` are simple strings. |
| Integer | Yes | `Value.Type` is `TyInt`, the payload is in `Value.Int` | The full range of an `int64`, negative numbers and zero work. |
| Bulk string | Yes | `Value.Type` is `TyBulk`, the payload is in `Value.Str` | Any bytes, an empty string, and text in any language. Replies of up to 3 MiB work. |
| Null | Yes | `Value.Type` is `TyNull` | A missing key, an empty blocking pop, and the holes in an `MGET` reply are all `TyNull`. The typed helpers (`Get`, `LPop`, `HGet`) return `ErrNil` for them. |
| Array (also nested, empty, with nulls) | Yes | `Value.Type` is `TyArray`, the payload is in `Value.Array` | Empty arrays, nested arrays and arrays with nulls work. |
| Map (RESP3) | Yes | `Value.Type` is `TyMap`, the payload is in `Value.Map`; on RESP2 the server sends `TyArray` instead, with the payload in `Value.Array` | On RESP3 you get a `TyMap`; on RESP2 the server sends the same data as a flat list of key and value. |
| Set (RESP3) | Yes | `Value.Type` is `TySet`, the payload is in `Value.Array`; on RESP2 the server sends `TyArray` instead, with the payload in `Value.Array` |  |
| Double (RESP3) | Yes | `Value.Type` is `TyDouble`, the payload is in `Value.Float`; on RESP2 the server sends `TyBulk` instead, with the payload in `Value.Str` | `+Inf`, `-Inf` and nested doubles (such as `ZRANGE ... WITHSCORES`) work. |
| Boolean (RESP3) | Yes | `Value.Type` is `TyBool`, the payload is in `Value.Bool`; on RESP2 the server sends `TyInt` instead, with the payload in `Value.Int` |  |
| Big number (RESP3) | Yes | `Value.Type` is `TyBigInt`, the payload is in `Value.BigN`; on RESP2 the server sends `TyBulk` instead, with the payload in `Value.Str` |  |
| Verbatim string (RESP3) | Yes | `Value.Type` is `TyVerbatim`, the payload is in `Value.Str`; on RESP2 the server sends `TyBulk` instead, with the payload in `Value.Str` | `Value.Str` keeps the three-letter format prefix, such as `txt:`; `DoString` removes it. |
<!-- driver-types:end redis reply-types -->

An error reply from the server is returned as a `*RedisError`, whose `Prefix` is the first word of the message (`WRONGTYPE`, `ERR`, or the prefix your own script uses), and the connection stays usable after it.

## Typed helpers on each reply

Each row is one kind of reply; the columns say which helper turns it into a Go value.

<!-- driver-types:begin redis typed-helpers -->
| Reply | Supported | Helpers that return it | Notes and known gaps |
| --- | --- | --- | --- |
| Bulk string | Yes | Returns it: `DoString`<br>Returns an error on purpose: `DoInt`, `DoBool`, `DoSlice` |  |
| Integer | Yes | Returns it: `DoString`, `DoInt`, `DoBool`<br>Returns an error on purpose: `DoSlice` |  |
| Simple string | Yes | Returns it: `DoString`<br>Returns an error on purpose: `DoInt`, `DoBool`, `DoSlice` |  |
| Double (RESP3) | With v1.6.0 | No helper returns it today<br>Returns an error on purpose: `DoInt`, `DoBool`, `DoSlice` | `DoString` does not work on RESP3 ([gap 1](#gap-1)). |
| Boolean true (RESP3) | Yes, more with v1.6.0 | Returns it: `DoBool`<br>Returns an error on purpose: `DoSlice` | `DoString`, `DoInt` do not work on RESP3 ([gap 1](#gap-1)). |
| Boolean false (RESP3) | Yes, more with v1.6.0 | Returns it: `DoBool`<br>Returns an error on purpose: `DoSlice` | `DoString`, `DoInt` do not work on RESP3 ([gap 1](#gap-1)). |
| Big number (RESP3) | With v1.6.0 | No helper returns it today<br>Returns an error on purpose: `DoInt`, `DoBool`, `DoSlice` | `DoString` does not work on RESP3 ([gap 1](#gap-1)). |
| Verbatim string (RESP3) | Yes | Returns it: `DoString`<br>Returns an error on purpose: `DoInt`, `DoBool`, `DoSlice` |  |
| Set (RESP3) | Yes | Returns it: `DoSlice`<br>Returns an error on purpose: `DoString`, `DoInt`, `DoBool` |  |
| Array of bulk strings | Yes | Returns it: `DoSlice`<br>Returns an error on purpose: `DoString`, `DoInt`, `DoBool` |  |
| Array of integers (an EVAL reply) | With v1.6.0 | No helper returns it today<br>Returns an error on purpose: `DoString`, `DoInt`, `DoBool` | `DoSlice` does not work ([gap 2](#gap-2)). |
| Map (RESP3), a flat array on RESP2 | With v1.6.0 | No helper returns it today<br>Returns an error on purpose: `DoString`, `DoInt`, `DoBool` | `DoSlice` does not work on RESP3 ([gap 1](#gap-1)).<br>`DoSlice` does not work ([gap 2](#gap-2)). |
<!-- driver-types:end redis typed-helpers -->

## Other behavior

<!-- driver-types:begin redis other -->
| Behavior | Supported | What you get | Notes and known gaps |
| --- | --- | --- | --- |
| Values up to 3 MiB, and values that contain CRLF, $, + or any byte | Yes | the same bytes back<br>Methods: `Set`, `SetBytes`, `Get`, `GetBytes`, `Do` | A value of 1 MiB to 3 MiB works, and so do values that contain `\r\n`, `$` or `+`, which look like protocol. |
| Values of 4 MiB and more | With v1.6.0 |  | `Set`, `SetBytes` do not work on Linux ([gap 3](#gap-3)). |
| Error replies | Yes | a `*RedisError` whose `Prefix` is the first word (`WRONGTYPE`, `ERR`, or your script's own); the connection stays usable<br>Methods: `Do` |  |
| Commands that reply with a number with a fraction | Yes | `float64`, infinities included, the same on RESP2 and RESP3<br>Methods: `ZScore`, `IncrByFloat`, `HIncrByFloat`, `ZIncrBy` |  |
| Hashes, sets, lists and MGet | Yes | `map[string]string` or `[]string`; `HGetAll`, `SMembers` and `LRange` give an empty map or slice for a missing key; `MGet` gives an empty string for a missing key (see Behavior to know about below); fields and members may be empty or not ASCII<br>Methods: `HGetAll`, `SMembers`, `SIsMember`, `LRange`, `MGet` |  |
| Push messages on a command connection (client-side caching) | Yes | delivered to the `WithOnPush` callback; the replies are not disturbed<br>Methods: `WithOnPush` |  |
<!-- driver-types:end redis other -->

## Known gaps

Each gap says what you see, what error you get (or that there is none), and where it is tracked. A gap marked for v1.6.0 has a fix in review for the v1.6.0 release; a gap marked for v1.6.1 stays through v1.6.0.

<!-- driver-types:begin redis gaps -->
1. <a id="gap-1"></a>On RESP3 (the default), `DoString` fails on a double, boolean or big number reply, `DoInt` fails on a boolean, and `DoSlice` fails on a map, where RESP2 returns the value. The error is `celeris-redis: expected string reply, got double`. A fix is in review for v1.6.0: [#1353](https://github.com/goceleris/celeris/pull/1353).
2. <a id="gap-2"></a>`DoSlice` returns an empty string for an element that is an integer or a nested array, and on RESP3 also for a double, a boolean or a big number. There is no error: the value is wrong without a warning. A fix is in review for v1.6.0: [#1353](https://github.com/goceleris/celeris/pull/1353).
3. <a id="gap-3"></a>On Linux, when the driver runs on its own event loop (a client opened without `WithEngine`, or with the engine of a server that has not started or runs the std engine, with async handlers off), a single write above 4 MiB fails, and the connection is closed. That is `SET`, `RPUSH`, `HSET` and the other commands that carry one large argument; the encoded command counts, so a value of exactly 4 MiB fails. A client in direct mode, and macOS and Windows, have no such cap. The fix in review raises the limit to 64 MiB; a single write above that still fails, and chunking it is tracked in the issue. The error is `celeris/engine: worker write queue full`. A fix is in review for v1.6.0: [#1362](https://github.com/goceleris/celeris/pull/1362) (issue [#1357](https://github.com/goceleris/celeris/issues/1357)).
<!-- driver-types:end redis gaps -->

## Behavior to know about

The tables above come from the driver's round-trip tests. The sections below describe behavior those tests do not show. Each limit names the issue that tracks it.

### Missing keys in `MGet` and `HMGet`

`MGet` and `HMGet` return an empty string for a missing key or hash field, which cannot be told from a stored empty value. When the difference matters, use `Do(ctx, "MGET", keys...)` or `Do(ctx, "HMGET", key, fields...)` and check each element for `TyNull`, or use `Get` and `HGet`, which return `ErrNil` for a miss ([celeris#1406](https://github.com/goceleris/celeris/issues/1406)).

### Typed helpers on RESP3

`DoString` reads a double, a boolean and a big number, `DoInt` reads a boolean, and `DoSlice` reads a map as a flat list of keys and values, as they do on RESP2. In a `DoSlice` result an integer, double or boolean element is its text; a nested array or an error element is an error (`expected string reply, got array`), not an empty string. `DoInt` still does not read a big number.
<!-- depends on celeris#1353. If it does not merge before the pin, replace with: "On a RESP3 connection (the default) DoString does not read a double, a boolean or a big number, DoInt does not read a boolean, and DoSlice does not read a map: each returns an error such as 'celeris-redis: expected string reply, got double'. DoSlice returns an empty string, with no error, for an element that is an integer or a nested array, and on RESP3 also for a double, a boolean or a big number (celeris#1353)." -->

### Context deadlines and cancellation

- A context with a deadline ends a command, `Pipeline.Exec` or `Tx.Exec` that waits for the server when the deadline passes, in every mode of the driver, and the error matches `context.DeadlineExceeded` (a direct-mode connection used to report the socket's raw `i/o timeout`).
- A `cancel()` ends a command that blocks on the server (`BLPOP`, `BRPOP`, `BRPOPLPUSH`, `BLMOVE`, `BLMPOP`, `BZPOPMIN`, `BZPOPMAX`, `BZMPOP`, `XREAD` and `XREADGROUP` with `BLOCK`, `WAIT` and `WAITAOF`, run through `Client.Do`) in every mode, with an error that matches `context.Canceled`, when the context has no deadline. On a direct-mode connection nothing else is watched for a cancel: an ordinary command, a pipeline or a `Tx` waits for the server's answer ([celeris#1387](https://github.com/goceleris/celeris/issues/1387)). A direct-mode connection is a client opened with `WithEngine` on a server that runs async handlers or has started on the epoll, io_uring or adaptive engine, and, off Linux, any client opened with `WithEngine`.
- The server may still run a command whose context ended, so the connection is closed and the pool dials another. A pop whose context ends just as the server answers may already have removed the element, and it is lost: use `BLMOVE` or `BRPOPLPUSH` to a processing list when an element must not be lost.
<!-- depends on celeris#1395. If it does not merge before the pin, replace the three items with: "On a direct-mode connection, a context canceled with cancel() (no deadline) while a command runs does not interrupt the call; a context with a deadline does, but the error is the socket's raw 'read tcp ...: i/o timeout' and errors.Is(err, context.DeadlineExceeded) is false (celeris#1387). Other modes return the context's error." -->
- On a `ClusterClient`, a command whose context ends is counted as a node failure: the node is marked failing and a topology refresh is attempted, which fails at once because the context is over. The mark is cleared only when a later topology read gets an answer from that node ([celeris#1397](https://github.com/goceleris/celeris/issues/1397)).
- If the context ends while the pool is dialling a connection, you get the dialler's own error, `dial tcp ...: i/o timeout` or `dial tcp ...: operation was canceled`. A deadline normally matches `context.DeadlineExceeded`, but the dialler can instead report `os.ErrDeadlineExceeded`; a `cancel()` matches `context.Canceled`. If the context was already over before the dial, you get the context's own error. Test both sentinels, or use `net.Error.Timeout()` ([celeris#1396](https://github.com/goceleris/celeris/issues/1396)).

### Large writes

On Linux, when the client runs on its own event loop (opened without `WithEngine`, or with the engine of a server that has not started or runs the std engine with async handlers off), a single write above 4 MiB fails with `celeris/engine: worker write queue full` (`ErrQueueFull`), and the connection is closed. The encoded command counts, so a value of exactly 4 MiB fails. A client in direct mode, macOS and Windows have no such cap. Split the value ([celeris#1357](https://github.com/goceleris/celeris/issues/1357)).
<!-- depends on celeris#1362. If it merges, replace with: "On Linux, when the client runs on its own event loop (...as above), a single write above 64 MiB fails with 'celeris/engine: write of N bytes exceeds the per-write limit of 64 MiB' (errors.Is(err, ErrQueueFull) is true). Direct mode, macOS and Windows have no such cap. Split the value (celeris#1357)." -->

### Colocation with an unset engine

A client opened with `WithEngine(srv)` on a server whose `Config.Engine` is left unset does not recognise the server as async-capable, even with `.Async()` routes, so a client opened before `Start` uses its own event loop instead of the direct path. Results are correct; only the PostgreSQL pool was measured on this path, and it is measurably slower there. Set `Engine: celeris.Adaptive` explicitly on Linux (`celeris.Std` elsewhere) ([celeris#1376](https://github.com/goceleris/celeris/issues/1376)).

## How this page is made

The tables are generated from the driver's own round-trip tests, which send commands to a real Redis server over RESP3 and over RESP2 and check every reply type and every typed helper. A row that says `Yes` is a row where all of those checks passed. When a fix lands and its test is no longer marked as a known failure, this page is regenerated, so it cannot keep describing a gap that is closed.
