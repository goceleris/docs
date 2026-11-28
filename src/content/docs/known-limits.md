---
title: Known limits in v1.6.0
description: What is still open in celeris v1.6.0 and what a change in the release costs, one line per item with its issue.
group: Reference
order: 5
---

This page lists what is still open in celeris v1.6.0, and what a change in the
release costs. It is the full list behind the short "Known limits" section of the
[README](https://github.com/goceleris/celeris#known-limits), and it matches the
"Known limits and costs" section of the
[v1.6.0 release notes](https://github.com/goceleris/celeris/releases/tag/v1.6.0).
Nothing here is a fix. Each item names its issue or pull request.

## Before you adopt

- **TLS.** celeris has no TLS configuration and no `StartTLS`. The native engines (io_uring, epoll and the `Adaptive` default on Linux) serve cleartext only. The `Std` engine serves HTTPS when you pass `StartWithListener` a TLS listener, over HTTP/1.1 and at the std engine's speed. Otherwise terminate TLS in a proxy in front of celeris ([Deployment and TLS](/docs/deployment), [#446](https://github.com/goceleris/celeris/issues/446)).
- **Platforms.** Linux is the production platform: io_uring needs kernel 5.19 or later, epoll 5.10 or later. macOS and Windows run the `Std` engine, for development and testing ([Engines](/docs/engines)).
- **Database clients.** The PostgreSQL, Redis and memcached clients are beta. The exported API stays under the compatibility check; behaviour fixes may land in minor releases and are listed in the release notes ([Stores and database drivers](/docs/data-stores)).

## Engines and timing

- **Idle CPU with open connections.** On the native engines a server that holds connections open and is otherwise idle uses more CPU than a plain `net/http` or `Std` server, because each loop keeps its short wait and sweep timer. No figure is published yet. [#1478](https://github.com/goceleris/celeris/issues/1478), and [the idle cost](/docs/engines#cost-of-the-native-engines-when-idle).
- **The first request after an idle period.** On epoll, the first request after a period with no connection open can be answered later than with v1.5.11's 4 ms wait, since an idle loop now waits 100 ms. [#1474](https://github.com/goceleris/celeris/pull/1474)
- **io_uring idle CPU with many connections.** The deadline check costs a little more idle CPU with 10,000 open connections. [#1494](https://github.com/goceleris/celeris/issues/1494), [#1484](https://github.com/goceleris/celeris/pull/1484)
- **io_uring deadline corner cases.** A few connection deadlines (a detached connection, an HTTP/2 connection) are still checked at the old period, so a timeout can fire up to about a second after it falls due, never later than in v1.5.11. A fix is planned for v1.6.1. [#1489](https://github.com/goceleris/celeris/issues/1489), [#1490](https://github.com/goceleris/celeris/issues/1490), [#1491](https://github.com/goceleris/celeris/issues/1491)
- **Light-load tail latency on the loop engines.** In two WebSocket echo measurements on arm64, the native loop engines' p99 at light load was higher than the `Std` engine's. On a cluster host, with 128 connections at the rated pass of a quarter of the cell's saturation rate (median of five runs), the p99 was 1.80 to 2.03 times the std engine's (HTTP/1) in all eight loop-engine columns ([#1318](https://github.com/goceleris/celeris/issues/1318)). In one container run on a shared host, with async handlers, 64 connections and about 6,000 messages a second, the p99 of the epoll and adaptive engines was about twice the std engine's (epoll default 492 us against 202 to 315 us for std, at nearly the same goroutine scheduler latency) ([#1380](https://github.com/goceleris/celeris/issues/1380)). Neither is measured for HTTP: the rated HTTP cells in the other data disagree and are not clean. The cause is not known, and nothing is claimed beyond these runs.
- **`Config.Workers` below 2 is refused** at start on every engine, so `runtime.GOMAXPROCS(0)` fails on a one-CPU host; use `max(2, runtime.GOMAXPROCS(0))`. [#1379](https://github.com/goceleris/celeris/issues/1379)
- **A port passed in a listener can be taken during the hand-over.** `Listen` closes a supplied listener and every loop then re-binds the port with nothing holding it, so a `bind(0)` elsewhere in the process in that gap can take it and `Listen` returns `address already in use`. It was not seen after the background TCP check moved. [#1404](https://github.com/goceleris/celeris/issues/1404)
- **A failed epoll start is only partly covered by tests.** The listen-registration failure and the locking of the loop's first descriptor write have the same fix as the listen-socket failure, but no test of their own. [#1377](https://github.com/goceleris/celeris/issues/1377)
- **A 64 MiB HTTP/2 response on a busy host.** To x/net's `http2.Transport` it completes in about 0.1 s on a quiet machine on the native engines (v1.5.11 failed it), but while the host is busy with other work an occasional transfer takes seconds, up to about 2.2 s in the measurements. [#1423](https://github.com/goceleris/celeris/issues/1423), and the part of [#809](https://github.com/goceleris/celeris/issues/809) that is left.
- **An unread HTTP/2 response can now live longer.** `WriteTimeout` bounds a response that waits for the client's window, so a stream whose client never reads is reset after up to eight `WriteTimeout` windows where v1.5.11 closed it at `ReadTimeout`; set `WriteTimeout` lower if that is too long for your clients. [#1167](https://github.com/goceleris/celeris/pull/1167)
- **Stalls on big.LITTLE arm64 hosts.** On an arm64 host with CPUs of different capacity, loop engines have stalled for over a second under load (io_uring at 512 connections, 2 of 8 runs, in v1.5.11 as well); the cause is not settled. [#1036](https://github.com/goceleris/celeris/issues/1036)

## Middleware

- **`compress` and `Vary`.** An uncompressed response, where no encoding was negotiated, can lack `Accept-Encoding` in `Vary` when the handler set its own `Vary`; v1.5.11 does the same. [#1420](https://github.com/goceleris/celeris/issues/1420)

## Database clients (beta)

- **A statement cancelled at its deadline returns late.** On the direct path, a statement whose deadline passes before any row has arrived is cancelled, and the call still waits for the cancel to be answered and for the server to finish its reply (that second wait is bounded at 30 seconds) before it returns the context's error, so it returns when those waits end and not at its deadline. Since [#1482](https://github.com/goceleris/celeris/pull/1482) the rows read in that wait are no longer buffered; how late the call returns was not measured ([#1466](https://github.com/goceleris/celeris/issues/1466)).
- **A write error does not prove the write was not applied.** A reply that was delivered completely can be reported as a failure when the connection closes right after it (about one call in a thousand in a test that closes at that exact moment), so do not blindly retry `Exec`, `QueryRow` with `RETURNING` or `Commit` in PostgreSQL after a connection error. [#1470](https://github.com/goceleris/celeris/issues/1470)
- **The same for memcached** on the event-loop path: a `Set`, `Delete` or `Incr` that was executed can be reported as failed, so do not blindly retry `Incr` or `Decr`. [#1460](https://github.com/goceleris/celeris/issues/1460)
- **PostgreSQL does not deliver notifications.** `LISTEN` and `UNLISTEN` return `ErrDirectModeUnsupported` on direct connections; on the event-loop path the statement is accepted and notifications are discarded. [#1480](https://github.com/goceleris/celeris/issues/1480)
- **Behind a pooler without prepared-statement support,** named statements pile up on the shared server connections until the pooler recycles them; `auto_cache_statements=false` avoids it. [#1462](https://github.com/goceleris/celeris/issues/1462)
- **PostgreSQL on the event-loop path:** calls made right after the server closes or resets connections can fail several times in a row with `file descriptor not registered`, for a few milliseconds. [#1465](https://github.com/goceleris/celeris/issues/1465)
- **Redis `DoSlice`** on a RESP3 reply of `[member, score]` pairs from a command without `WITHSCORES` or `WITHVALUES` (`ZPOPMIN` and `ZPOPMAX` with a count, `ZMPOP`) returns an error that names `array`, where RESP2 gives a flat list: use `Do`. [#1353](https://github.com/goceleris/celeris/pull/1353)

The [Stores and database drivers](/docs/data-stores) page lists the other known limits of the beta clients, such as the pool's soft `MaxOpen`, `MaxIdleTime`, the cached-query error after `DEALLOCATE ALL`, `statement_cache_size=0`, the limits of `WithStreaming` and `CopyFrom` after a context error.
