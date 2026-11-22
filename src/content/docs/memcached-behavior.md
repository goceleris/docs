---
title: Memcached behavior
description: What the celeris memcached driver does with values, keys, counters, flags and CAS tokens on the text and binary protocols, and the known gaps.
group: Data & Integration
order: 5
---

This page lists what the celeris memcached driver (`driver/memcached`) does at the edges of its API: which values and keys it accepts, what each command returns for a key that is not there, and where the text and binary protocols behave the same. For how to create a client and the rest of the driver, see [Stores and database drivers](/docs/data-stores).

Memcached stores bytes, so there is no list of column types here; the rows are behaviors. Every row was checked on both the text protocol (the default) and the binary protocol (`WithProtocol`).

## How to read the table

- **Supported** is `Yes` when the behavior is correct on both protocols. `With v1.6.0` means a fix is in review for v1.6.0. `Partly` and `No` mean there is a gap that stays after v1.6.0.
- The gap numbers link to [Known gaps](#known-gaps) at the end of the page.

## Values, keys and commands

<!-- driver-types:begin memcached behaviour -->
| Behavior | Supported | What you get | Notes and known gaps |
| --- | --- | --- | --- |
| Values of any bytes, from empty up to the server's 1 MiB item limit, including bytes that look like protocol (CRLF, END, VALUE) | Yes | the same bytes, with `Get` as a string or `GetBytes` as a `[]byte`<br>Methods: `Set`, `SetBytes`, `Get`, `GetBytes`, `GetMulti`, `GetMultiBytes` | Both the text and the binary protocol give the same result. |
| Gets on a value that is not empty | Yes | an `Item` with the value, the flags and the CAS token<br>Methods: `Gets` |  |
| Gets on an empty value | With v1.6.0 | an `Item` with the value, the flags and the CAS token | The text protocol is correct. With the binary protocol, use `Get` or `GetBytes` for an empty value until the fix: they return it correctly.<br>`Gets` does not work with the binary protocol ([gap 1](#gap-1)). |
| A value over the server's item size limit (1 MiB and 2 MiB are tested) | Yes | the server's error; the connection stays in step, and the next `Set` and `Get` work<br>Methods: `SetBytes` |  |
| Keys: up to 250 bytes, UTF-8 and symbols; longer keys, empty keys, and keys with a space, a control character or a line break | Yes | a valid key works; an invalid one fails before anything is sent, with `ErrMalformedKey` (a key with CRLF in it cannot inject a command)<br>Methods: `Set`, `Get` |  |
| Counters: Incr and Decr at the edges | Yes | `uint64`; `Incr` wraps from the largest value to 0, `Decr` stops at 0; a value that is not a number is the server's error; a missing key is `ErrCacheMiss`<br>Methods: `Incr`, `Decr` | Counters follow the server's rules: they are unsigned 64-bit numbers. |
| A key that is not there | Yes | `ErrCacheMiss` from `Get`, `GetBytes`, `Gets`, `Touch`, `Delete` and `CAS`; `ErrNotStored` from `Append` and `Prepend`; `GetMulti` gives an empty map and no error<br>Methods: `Get`, `GetBytes`, `Gets`, `Touch`, `Delete`, `Append`, `Prepend`, `CAS`, `GetMulti` |  |
| Item flags (0 to 4294967295) and CAS tokens | Yes | `Item.Flags` and `Item.CAS`; every store gives a new token; `CAS` with an old token is `ErrCASConflict`. The client cannot set flags itself; it reads what another client stored<br>Methods: `Gets`, `Get`, `GetMulti`, `CAS` |  |
| Go values accepted by Set: string, \[\]byte, int, int64, float64, bool | Yes | stored as their text form (true as 1, false as 0)<br>Methods: `Set` |  |
| GetMulti of many keys with hits, misses, empty and large values | Yes | a map with one entry per key that exists; a key listed twice gives one entry<br>Methods: `GetMulti`, `GetMultiBytes` | The binary protocol pipelines the keys; the result is the same as on the text protocol. |
<!-- driver-types:end memcached behaviour -->

## Known gaps

Each gap says what you see, what error you get (or that there is none), and where it is tracked. A gap marked for v1.6.0 has a fix in review for the v1.6.0 release; a gap marked for v1.6.1 stays through v1.6.0.

<!-- driver-types:begin memcached gaps -->
1. <a id="gap-1"></a>With the binary protocol, `Gets` on an item whose value is empty reports a cache miss, and the item's flags and CAS token are lost, so it cannot be updated with `CAS`. The text protocol is correct. The error is `celeris-memcached: cache miss`. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
<!-- driver-types:end memcached gaps -->

## How this page is made

The table is generated from the driver's own round-trip tests, which run against a real memcached server on the text protocol and on the binary protocol. A row that says `Yes` is a row where both passed. When a fix lands and its test is no longer marked as a known failure, this page is regenerated, so it cannot keep describing a gap that is closed.
