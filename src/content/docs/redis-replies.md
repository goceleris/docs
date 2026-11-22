---
title: Redis replies
description: How the celeris Redis driver returns each Redis reply type on RESP3 and RESP2, which typed helpers accept which reply, and the known gaps.
group: Data & Integration
order: 4
---

This page lists how the celeris Redis driver (`driver/redis`) returns each kind of reply from the server, so you can check what to expect from `Do` and from the typed helpers. For how to create a client and the rest of the driver, see [Stores and database drivers](/docs/data-stores).

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
| Hashes, sets, lists and MGet | Yes | `map[string]string` or `[]string`; a missing key gives an empty map or slice; fields and members may be empty or not ASCII<br>Methods: `HGetAll`, `SMembers`, `SIsMember`, `LRange`, `MGet` |  |
| Push messages on a command connection (client-side caching) | Yes | delivered to the `WithOnPush` callback; the replies are not disturbed<br>Methods: `WithOnPush` |  |
<!-- driver-types:end redis other -->

## Known gaps

Each gap says what you see, what error you get (or that there is none), and where it is tracked. A gap marked for v1.6.0 has a fix in review for the v1.6.0 release; a gap marked for v1.6.1 stays through v1.6.0.

<!-- driver-types:begin redis gaps -->
1. <a id="gap-1"></a>On RESP3 (the default), `DoString` and `DoInt` fail on a double, boolean or big number reply, and `DoSlice` fails on a map reply, where RESP2 returns the value. The error is `celeris-redis: expected string reply, got double`. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
2. <a id="gap-2"></a>`DoSlice` returns an empty string for every element that is an integer, a double, a boolean or a nested array. There is no error: the value is wrong without a warning. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
3. <a id="gap-3"></a>On Linux, a single value of 4 MiB or more cannot be written (`SET`, `RPUSH`, `HSET` and the other commands that carry one large argument). macOS and Windows do not have this limit. The error is `celeris/engine: worker write queue full`. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
<!-- driver-types:end redis gaps -->

## How this page is made

The tables are generated from the driver's own round-trip tests, which send commands to a real Redis server over RESP3 and over RESP2 and check every reply type and every typed helper. A row that says `Yes` is a row where all of those checks passed. When a fix lands and its test is no longer marked as a known failure, this page is regenerated, so it cannot keep describing a gap that is closed.
