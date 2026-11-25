---
title: PostgreSQL types
description: Which PostgreSQL column types and Go values the celeris driver reads and writes, how each one comes back in Go, and the known gaps.
group: Data & Integration
order: 3
---

This page lists what the celeris PostgreSQL driver (`driver/postgres`) can read from a column and what it accepts as a query argument, so you can check a type before you rely on it. For how to open a connection and the rest of the driver, see [Stores and database drivers](/docs/data-stores).

The PostgreSQL, Redis and memcached clients are in beta: the exported API of the driver packages stays under the compatibility check, but behaviour fixes (what a value scans to, which cases return an error) may land in minor releases and are listed in the release notes.

The driver has two ways to run a query: through `database/sql` (`sql.Open("celeris-postgres", dsn)`) and through the native `Pool` (`postgres.Open`). Both are covered below. Where they differ, the table says so.

## How to read the tables

- **Supported** is `Yes` when every way of reading the type gives the right value. `Yes, more with v1.6.0` means the common way works today and the rest is fixed in v1.6.0. `With v1.6.0` means it does not work correctly today and a fix is in review for v1.6.0. `Partly` and `No` mean there is a gap that stays after v1.6.0; the notes say what to do instead.
- A query **without arguments** is sent as a simple query and PostgreSQL answers in text. A query **with arguments**, a **prepared statement** (`db.Prepare`) and a query that the driver caches for you are sent as an extended query, and PostgreSQL answers in its binary form. The driver turns both into the same Go value, except where a note says otherwise.
- **Scan into** lists the Go destinations that give the right value. `any` is what you get when you scan into an `any` (or read `driver.Value` yourself). The `sql.Null*` destination is the one that accepts a `NULL` of the type.
- The gap numbers link to [Known gaps](#known-gaps) at the end of the page.

## Column types

<!-- driver-types:begin postgres column-types -->
| Type | Supported | How it is returned | Notes and known gaps |
| --- | --- | --- | --- |
| `bool` | Yes | `bool`<br>Scan into: `any`, `*bool`<br>NULL: `*sql.NullBool` |  |
| `int2` | Yes | `int64`<br>Scan into: `any`, `*int16`, `*int64`, `*int`, `*string`<br>NULL: `*sql.NullInt64` | Values from -32768 to 32767. Scan it into its Go type or a `string`. On the native `Pool`, a `*[]byte` receives the binary wire form on a query with arguments (an error on a streamed result), and the server's text on a query without. |
| `int4` | Yes | `int64`<br>Scan into: `any`, `*int32`, `*int64`, `*int`, `*string`<br>NULL: `*sql.NullInt64` | Scan it into its Go type or a `string`. On the native `Pool`, a `*[]byte` receives the binary wire form on a query with arguments (an error on a streamed result), and the server's text on a query without. |
| `int8` | Yes | `int64`<br>Scan into: `any`, `*int64`, `*int`, `*string`<br>NULL: `*sql.NullInt64` | The full range of a Go `int64` works, including the minimum and maximum. Scan it into its Go type or a `string`. On the native `Pool`, a `*[]byte` receives the binary wire form on a query with arguments (an error on a streamed result), and the server's text on a query without. |
| `float4` | Yes | `float64`<br>Scan into: `any`, `*float32`, `*float64`<br>NULL: `*sql.NullFloat64` | Read it into a `float32` or a `float64`. |
| `float8` | Yes | `float64`<br>Scan into: `any`, `*float64`<br>NULL: `*sql.NullFloat64` | `NaN`, `+Infinity`, `-Infinity`, `1e300` and `5e-324` come back unchanged. |
| `numeric` | Yes | `string`<br>Scan into: `any`, `*string`<br>NULL: `*sql.NullString` | Returned as its decimal text, so no precision is lost: `123456789012345678901234567890.123456789`, `12.50` (the scale is kept) and `NaN` all come back as written. To compute with it, parse it with a decimal library. Scan it into its Go type or a `string`. On the native `Pool`, a `*[]byte` receives the binary wire form on a query with arguments (an error on a streamed result), and the server's text on a query without. |
| `text` | Yes | `string`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Any Unicode text, an empty string, and values of 100 KiB work. |
| `varchar(n)` | Yes | `string`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` |  |
| `char(n)` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | The value is padded with spaces to the length `n`, as PostgreSQL does (`ab` in a `char(4)` comes back as `ab  `). |
| `name` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` |  |
| `bytea` | Yes | `[]byte`<br>Scan into: `any`, `*[]byte`<br>NULL: `*sql.NullString` | All 256 byte values, an empty value and values of 100 KiB work, on every kind of query. |
| `json` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Returned as the JSON text, as bytes. Scan it into a `string` or a `[]byte`. The `jsonb` type is not in this table yet, see below. |
| `uuid` | Yes | `string`<br>Scan into: `any`, `*string`<br>NULL: `*sql.NullString` | Returned as text in the usual form, `550e8400-e29b-41d4-a716-446655440000`. Scan it into its Go type or a `string`. On the native `Pool`, a `*[]byte` receives the binary wire form on a query with arguments (an error on a streamed result), and the server's text on a query without. |
| `date` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` at midnight UTC. |
| `date` (BC, a year before 1) | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Read correctly on every kind of query since v1.6.0 (celeris#1341). |
| `time` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `timetz` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `timestamp` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` with no zone: the wall-clock fields are what PostgreSQL stores, read as UTC. Dates from 1970 back to 1708 and forward to 2292 are tested on every kind of query; the years outside that range are in the next row. |
| `timestamptz` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` for the same instant that PostgreSQL stores. Do not rely on the zone of the returned value; call `.UTC()` or `.In(...)`. |
| timestamp, timestamptz (before the year 1708 or after 2292) | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Read correctly on every kind of query since v1.6.0 (celeris#1344). Inside the range 1708 to 2292 the `timestamp` and `timestamptz` rows above are tested on every kind of query too. |
| `interval` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `int2[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `int4[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `int8[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `text[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `varchar[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `float8[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `bool[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `uuid[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `bytea[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 2](#gap-2)). |
| `int4[][]` (two-dimensional) | No | Not supported (see the known gap)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 3](#gap-3)). |
| `numeric[]` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `date[]` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `timestamptz[]` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `inet` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `cidr` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `macaddr` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `oid` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
| `enum` (a type you create) | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Returned as the label, as bytes; scan it into a `string` or a `[]byte`. |
| `enum[]` | No | `[]byte`: the binary wire form on a query with arguments, the text on a query without<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 1](#gap-1)). |
<!-- driver-types:end postgres column-types -->

### Types that are not in the table yet

`jsonb` and `jsonb[]` are not in the table yet. Since v1.6.0, reading a `jsonb` column into a `string`, a `json.RawMessage` or an `any` returns the JSON text. A native `*[]byte` on a query with arguments still starts with the format version byte `0x01`, in front of the JSON text: scan a `jsonb` into a `string` instead. The `jsonpath`, `json[]`, `jsonb[]` and `jsonpath[]` types are decoded.

## Go values you pass as arguments

These are the Go values you can pass as `$1`, `$2` and so on, and the column types each one is written to correctly. A value in the same row can be passed to a column type that is not listed if PostgreSQL converts it for you.

<!-- driver-types:begin postgres argument-kinds -->
| Go value you pass | Supported | Works with these column types | Notes and known gaps |
| --- | --- | --- | --- |
| `bool` | Yes | Works with `bool` |  |
| `int` | Yes | Works with `int2`, `int4` | Works for `int2` and `int4`. Use an `int64` for `int8` and `numeric`. |
| `int32` | Yes | Works with `int4` |  |
| `int64` | Yes | Works with `int8`, `numeric` |  |
| `float64` | Yes | Works with `numeric`, `float8` |  |
| `string` | Yes | Works with `numeric`, `text`, `char(4)`, `json`, `uuid`, `time`, `interval`, `int4[]`, `text[]`, `inet`, `cidr` | Also the way to write the types the driver has no Go type for, such as `inet`, `cidr`, `interval`, `time` and arrays: pass their PostgreSQL text form (for example `{1,2,3}` for an array). |
| `float32` | Yes | Works with `float4` |  |
| `[]byte` | Yes | Works with `text`, `bytea`, `json`, `uuid` |  |
| `time.Time` | Partly | Works with `date`, `timestamp`, `timestamptz` | The instant is kept, including the zone offset you give it.<br>Fails for `time`, `timestamptz (years before 1)` on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| nil (SQL NULL) | Yes | Works with `bool`, `int2`, `int4`, `int8`, `float4`, `float8`, `numeric`, `text`, `bytea`, `json`, `uuid`, `date`, `time`, `timestamp`, `timestamptz`, `interval`, `int4[]`, `text[]`, `inet`, `cidr` | Passing `nil` writes `NULL` to a column of any type. |
| `int16` | Partly | Works with `int2` | Fails for `int2` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `byte` | Partly | Works with `int4` | Fails for `int4` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `uint32` | Partly | Works with `int8` | Fails for `int8` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `uint64` | Partly | Works with `int8` | Fails for `int8` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| your own defined string type | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| your own defined integer type | Partly | Works with `int4` | Fails for `int4` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| a type that implements driver.Valuer | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.NullString` | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| sql.NullString holding NULL | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.NullInt64` | Partly | Works with `int8` | Fails for `int8` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| sql.NullInt64 holding NULL | Partly | Works with `int8` | Fails for `int8` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.NullBool` | Partly | Works with `bool` | Fails for `bool` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.NullFloat64` | Partly | Works with `float8` | Fails for `float8` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.NullTime` | Partly | Works with `timestamptz` | Fails for `timestamptz` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `sql.Null[int32]` | Partly | Works with `int4` | Fails for `int4` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `*string` | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| \*string holding NULL | Partly | Works with `text` | Fails for `text` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `[16]byte` | No | Not accepted today | Fails for `uuid` on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `json.RawMessage` | Partly | Works with `json` | Fails for `json` with the native Pool, on queries with arguments ([gap 5](#gap-5)). |
| `[]string` | No | Not accepted today | Fails for `text[]` on queries with arguments, including prepared statements ([gap 7](#gap-7)). |
| `[]int64` | No | Not accepted today | Fails for `int8[]` on queries with arguments, including prepared statements ([gap 7](#gap-7)). |
<!-- driver-types:end postgres argument-kinds -->

## Known gaps

Each gap says what you see, what error you get (or that there is none), and where it is tracked. A gap marked for v1.6.0 has a fix in review for the v1.6.0 release; a gap marked for v1.6.1 stays through v1.6.0.

<!-- driver-types:begin postgres gaps -->
1. <a id="gap-1"></a>A column of a type the driver has no decoder for (time, timetz, interval, inet, cidr, macaddr, oid, and arrays of numeric, date or timestamptz) is read in its binary wire form on a query with arguments, a prepared statement or a query the driver caches. Scanning it into a `string` is an error with the native `Pool`; with `database/sql` the `string` holds the raw wire bytes and there is no error, so the value is wrong without a warning there. A `[]byte` or `any` receives the wire bytes. A query without arguments returns the text. Cast the column to text in the query (`SELECT col::text`). Arrays of a type you create (`enum[]`) and extension types are not guarded: a native `string` receives their raw wire bytes with no error. The error is `celeris-postgres: scan: column of type interval (OID 1186) has no decoder in this driver, so a string would be its raw binary wire form; cast it to text in the query (SELECT col::text) or scan into any`. Known gap, tracked for v1.6.1 in [#1352](https://github.com/goceleris/celeris/issues/1352).
2. <a id="gap-2"></a>An array column cannot be scanned into a `string` or a `[]byte` on a query with arguments. With `database/sql` both are an error, shown below. With the native `Pool` a `string` is an error and a `[]byte` receives the array's binary wire bytes (an error on a streamed result). Scan it into an `any` and read the `[]driver.Value`, or cast it to text in the query (`SELECT col::text`). A query without arguments returns the array's text. The error is `sql: Scan error on column index 0, name "c": unsupported Scan, storing driver.Value type []driver.Value into type *string`. Known gap, tracked for v1.6.1 in [#1351](https://github.com/goceleris/celeris/issues/1351).
3. <a id="gap-3"></a>A multi-dimensional array column on a query with arguments is an error with `database/sql` and, with the native `Pool`, for a `string` or an `any`; a buffered native `[]byte` receives the binary wire bytes. A query without arguments returns the array's text. Read it as text with `SELECT col::text`. An array whose lower bound is not 1 returns its elements and drops the bound. The error is `postgres/protocol: multi-dimensional array (2 dimensions) is not supported as a column value; cast it to text in the query (col::text) to read its literal`. Known gap, tracked for v1.6.1 in [#1350](https://github.com/goceleris/celeris/issues/1350).
4. <a id="gap-4"></a>A `time.Time` cannot be passed to a `time` column, and a `time.Time` before year 1 cannot be passed to `timestamptz`. Pass the value as a `string`. The error is `ERROR: invalid input syntax for type time: "2025-01-15T12:34:56.789123Z" (SQLSTATE 22007)`. Known gap, tracked for v1.6.1 in [#1349](https://github.com/goceleris/celeris/issues/1349).
5. <a id="gap-5"></a>The native `Pool` accepts only `bool`, `int`, `int32`, `int64`, `float32`, `float64`, `string`, `[]byte`, `time.Time` and nil as arguments. Everything else is rejected, for example `sql.Null*` types, anything that implements `driver.Valuer`, your own defined types, pointers, `json.RawMessage`, and the integer widths `int8`, `int16`, `uint`, `uint8`, `uint16`, `uint32` and `uint64`. `database/sql` converts most of these. Pass the plain value instead, or use `database/sql`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type sql.NullString; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1 in [#1359](https://github.com/goceleris/celeris/issues/1359).
6. <a id="gap-6"></a>A `[16]byte` array is not accepted as a uuid argument. Pass the uuid as a `string`, or the 16 bytes as a `[]byte`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type [16]uint8; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1 in [#1361](https://github.com/goceleris/celeris/issues/1361).
7. <a id="gap-7"></a>Go slices (`[]string`, `[]int64`) are not accepted as array arguments. Pass the PostgreSQL array text, such as `{a,b}`, as a `string`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type []string; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1 in [#1348](https://github.com/goceleris/celeris/issues/1348).
<!-- driver-types:end postgres gaps -->

## Behavior to know about

The tables above come from the driver's round-trip tests. The sections below describe behavior those tests do not show. Each limit names the issue that tracks it.

### What a native scan returns

- Scan numbers, booleans, dates and timestamps into their Go types (`int64`, `float64`, `bool`, `time.Time`) or an `any`. Text columns (`text`, `varchar`, `json`, `jsonb`), `numeric` and `uuid` scan into a `*string` as their text.
- A number, boolean, date or timestamp scanned into a native `*string` works, but its format depends on the query: on a query with arguments (including a prepared or cached statement) it is Go's (`true`, `1.234567890125e+11`, `2024-05-06T00:00:00Z`), on a query without arguments it is the server's (`t`, `123456789012.5`, `2024-05-06`).
- A native `*[]byte` is not converted. On a query with arguments it receives the value's binary wire form (a `jsonb` value then starts with the format version byte `0x01`), and on a result that the driver streams it is an error for a boolean, number, date or timestamp. On a query without arguments it receives the server's text; a `bytea` returns its bytes, not the `\x...` hex text. Use a `*[]byte` for `text`, `varchar`, `json` and `bytea` columns; for any other type, scan into its Go type or a `*string`.

### Column types the driver has no codec for

The driver has no codec for the types in the table. On a query with arguments, a prepared statement or a cached statement, PostgreSQL sends them in binary. On the native `Pool`, scanning one into a `*string` is an error that names the type and says to cast it to text; a `*[]byte`, `*any` and a `sql.Scanner` receive the wire bytes. Through `database/sql` the same column arrives undecoded: a `*string` holds the raw wire bytes and there is no error, so cast the column to text in the query (`SELECT col::text`). A query without arguments returns the text. Typed Go values for these types are tracked in [celeris#1352](https://github.com/goceleris/celeris/issues/1352).

| Type | Native `Pool`, `*string` | `database/sql`, `*string` |
| --- | --- | --- |
| `time`, `timetz`, `interval` | error, cast to text | raw wire bytes, cast to text |
| `inet`, `cidr`, `macaddr`, `macaddr8` | error, cast to text | raw wire bytes, cast to text |
| `oid`, the other `reg*` types, `xid`, `cid`, `tid` | error, cast to text | raw wire bytes, cast to text |
| `money`, `bit`, `varbit`, `pg_lsn` | error, cast to text | raw wire bytes, cast to text |
| `point`, `line`, `lseg`, `box`, `path`, `polygon`, `circle` | error, cast to text | raw wire bytes, cast to text |
| `tsvector`, `tsquery` | error, cast to text | raw wire bytes, cast to text |
| ranges and multiranges (`int4range`, `numrange`, `daterange`, `tstzrange` and the others) | error, cast to text | raw wire bytes, cast to text |
| arrays of the types above, and `numeric[]`, `date[]`, `timestamp[]`, `timestamptz[]`, `time[]`, `interval[]` | error, cast to text | raw wire bytes, cast to text |
| arrays of a type you create (`enum[]`, composite arrays) and extension types | the raw wire bytes, no error | raw wire bytes, cast to text |

A type you create, such as an `enum`, is not in the list: its binary form is its text, so it scans into a `string` as the label.

### Arrays

An array column read on a query with arguments is a Go slice: scan it into an `any`. It cannot be scanned into a `string` (an error), nor into a `[]byte` through `database/sql` (an error); a native `Pool` gives a `[]byte` the binary wire bytes. A query without arguments returns the array's text. Cast to text in the query (`SELECT col::text`) to get the text on both ([celeris#1351](https://github.com/goceleris/celeris/issues/1351)). A multi-dimensional array on a query with arguments is an error (`multi-dimensional array (2 dimensions) is not supported as a column value`); read it with `col::text` ([celeris#1350](https://github.com/goceleris/celeris/issues/1350)). An array whose lower bound is not 1 returns its elements and drops the bound.

### Floats and dates over the simple protocol

- A statement without arguments is a simple query and PostgreSQL answers in text. If the role or database sets `extra_float_digits` to 0 or less, a `float8` such as `0.30000000000000004` is printed with 15 significant digits and reads back as `0.3`. Set it to 1 or more, or give the statement an argument (statements with arguments return binary results and are exact) ([celeris#1364](https://github.com/goceleris/celeris/issues/1364)).
- If the role or database sets `DateStyle` to the SQL, Postgres or German style, a date or timestamp read from a query without arguments into a `time.Time` or an `any`, or through `database/sql`, is an error that names `DateStyle`; it is never read as another value. A native `*string` or `*[]byte` receives the server's text unchanged. Set `DateStyle` to an ISO style, or give the statement an argument.

### Arguments

The native `Pool` accepts only `bool`, `int`, `int32`, `int64`, `float32`, `float64`, `string`, `[]byte`, `time.Time` and nil as arguments; anything else is rejected with `unsupported argument type`. `database/sql` converts `sql.Null*`, `driver.Valuer`, defined types, pointers and the other integer widths, but not arrays, slices or a `uint64` above the largest `int64` ([celeris#1359](https://github.com/goceleris/celeris/issues/1359)). A `[16]byte` is rejected as a uuid argument on both paths: pass the uuid as a `string`, or as a 16-byte `[]byte` ([celeris#1361](https://github.com/goceleris/celeris/issues/1361)). A Go slice (`[]string`, `[]int64`) is not accepted as an array argument; the call fails with `unsupported argument type []string` (through `database/sql`, `unsupported type []string, a slice of string`) ([celeris#1348](https://github.com/goceleris/celeris/issues/1348)). A `time.Time` argument for a `time` column, and one before year 1 for `timestamptz`, is rejected by the server with an error ([celeris#1349](https://github.com/goceleris/celeris/issues/1349)). A `[]byte` argument for a `jsonb` parameter is sent in binary and the server rejects it (for example `unsupported jsonb version number 123`); `json.RawMessage` does the same through `database/sql`, and the native `Pool` rejects it before sending. It is a clear error, never a wrong value; pass the JSON as a `string` ([celeris#1347](https://github.com/goceleris/celeris/issues/1347)).

### The statement cache

Each connection caches up to 256 prepared statements by default (`statement_cache_size` in the DSN, `WithStatementCacheSize`). `statement_cache_size=0` does not disable the cache: the driver reads 0 as 256, and a negative value in the DSN is rejected. A statement with arguments is prepared the first time a connection runs it and reused after that, and a statement you prepare with `db.Prepare` is cached too. `auto_cache_statements=false` in the DSN only stops the driver from preparing statements by itself: a statement with arguments then runs unnamed and is parsed every time.

The cache does not follow the schema. After `ALTER TABLE ... ALTER COLUMN ... TYPE`, a statement already cached on a connection fails with SQLSTATE `0A000` (`cached plan must not change result type`) on that connection until the connection is closed; the driver does not prepare it again ([celeris#1360](https://github.com/goceleris/celeris/issues/1360)). A statement that `DISCARD ALL` or a pooler dropped on the server fails with SQLSTATE `26000`: an `INSERT`, `UPDATE` or `DELETE` and a `db.Prepare` statement are prepared again automatically, an automatically cached `SELECT` with arguments is not.

A statement that the cache evicts is closed on the server with a protocol-level `Close` sent ahead of the query that caused the eviction. Before v1.6.0, the 257th distinct statement text on one connection (dynamic SQL, `IN` lists of varying length) hung the call or killed the connection (celeris#1371).

### Context deadlines and cancellation

- On a native `Pool` connection in direct mode, a context deadline is enforced while a statement runs: when it passes, the driver sends a CancelRequest and the call returns the context's error, `context.DeadlineExceeded`. A cancel-only context never wakes the read. It is checked each time a read returns, so if it was cancelled before the reply was complete and a partial reply arrives, the statement is cancelled then (CancelRequest, drain, the context's error), as in v1.5.11. A reply that arrives whole is returned ([celeris#1375](https://github.com/goceleris/celeris/issues/1375)). The deadline bounds the wait for the server's answer, not the sending of a statement's parameters to a server that has stopped reading ([celeris#1391](https://github.com/goceleris/celeris/issues/1391)). Direct mode is a `Pool` opened without `WithEngine`, with an engine that runs handlers asynchronously, or with a started epoll, io_uring or adaptive server, and, off Linux, with an engine that has no event loop of its own. `database/sql` is never direct and honours both a deadline and a cancel; the error it returns is the server's `canceling statement due to user request` (SQLSTATE `57014`). To bound a statement, give its context a deadline, use `database/sql`, or run the `Pool` on the event loop (a `Pool` opened with the engine of a server that has not started, on Linux).
<!-- depends on celeris#1386. If it does not merge before the pin, replace the first two sentences of this item with: "A context that ends while a statement runs on a native Pool connection in direct mode never wakes the read, neither a deadline nor cancel(). It is checked each time a read returns, so if it ended before the reply was complete and a partial reply arrives, the statement is cancelled then (CancelRequest, drain, the context's error); a reply that arrives whole is returned, as in v1.5.x. Use database/sql, the event-loop mode, or a server-side statement_timeout (celeris#1375)." and delete the sentence about the deadline bounding the wait. -->
- A cancelled connection finishes its cancel exchange before it carries another statement, so a cancel can no longer land on the next statement of the same connection and fail it with SQLSTATE `57014` (celeris#1373; present since at least v1.5.11).
- If the context ends at about the moment the connection drops, the call returns either the context's error or the network error; do not rely on which ([celeris#1389](https://github.com/goceleris/celeris/issues/1389)).
- On the native `Pool`, a statement issued on a `Tx` whose context is already done is still sent to the server and may run before it is cancelled; `database/sql` returns the context error without sending ([celeris#1392](https://github.com/goceleris/celeris/issues/1392)).
- The cancel exchange gets 1 s in total. If it does not complete (for example the cancel connection's SYN is lost), the connection is discarded and a later call dials a new one ([celeris#1383](https://github.com/goceleris/celeris/issues/1383)). After a confirmed cancel, reading the rows of a query on a loop-mode connection, and the start of `COPY FROM` in every mode, wait for the server's answer without a time bound ([celeris#1384](https://github.com/goceleris/celeris/issues/1384)).
- If the context ends while the pool is dialling a connection, you get the dialler's own error, `dial tcp ...: i/o timeout` or `dial tcp ...: operation was canceled`. A deadline normally matches `context.DeadlineExceeded`, but the dialler can instead report `os.ErrDeadlineExceeded`; a `cancel()` matches `context.Canceled`. If the context was already over before the dial, you get the context's own error. Test both sentinels, or use `net.Error.Timeout()` ([celeris#1396](https://github.com/goceleris/celeris/issues/1396)).

### Transactions and connection reset

- `Tx.Commit` returns nil when the server answers `COMMIT` with the `ROLLBACK` tag, which PostgreSQL does for a transaction in which a statement failed or was cancelled: nothing is committed, and the database is never left in a wrong state. Check the error of every statement of the transaction ([celeris#1388](https://github.com/goceleris/celeris/issues/1388)). A fix is in review for v1.6.0 ([celeris#1390](https://github.com/goceleris/celeris/pull/1390)): `Commit` then returns `postgres.ErrTxCommitRollback`.
<!-- depends on celeris#1390. If it merges before the pin, replace with: "Tx.Commit returns postgres.ErrTxCommitRollback when the server answers COMMIT with the ROLLBACK tag, which PostgreSQL does for a transaction in which a statement failed or was cancelled: nothing was committed. Before v1.6.0, Commit returned nil in that case. Code that logged and ignored a statement's error and then committed will now see the error from Commit (celeris#1388)." -->
- Session-scoped state set through `Exec` (`SET`, `SET ROLE`, `set_config`, temporary tables, `LISTEN`, `PREPARE`, advisory locks) persists on a pooled connection, on `database/sql` and on the native `Pool`, which never resets.<!-- "as with other drivers" goes here ONLY after the agent doing the ResetSession code PR has verified the reference drivers; do not write it before. --> Use transaction-scoped settings (`SET LOCAL` or `set_config(..., true)`) inside a `Tx`, or a dedicated `db.Conn` cleaned up before it is returned.
<!-- depends on the ResetSession code PR (number to be filled in). Enable this line when it merges: "A connection released while a transaction is open (or failed) is discarded, not reused." Until then it is not published: this was not verified against main. -->
- If resetting a connection's session fails, `database/sql` does not retry on a new connection and does not report the error: your statement runs on that connection as it is ([celeris#1382](https://github.com/goceleris/celeris/issues/1382)).
- A `Pool` opened with `WithEngine(srv)` on a server whose `Config.Engine` is left unset does not recognise the server as async-capable, even with `.Async()` routes, so a pool opened before `Start` uses its own event loop instead of the direct path. Results are correct; the pool is measurably slower on it. Set `Engine: celeris.Adaptive` explicitly on Linux (`celeris.Std` elsewhere) ([celeris#1376](https://github.com/goceleris/celeris/issues/1376)).

## How this page is made

The tables are generated from the driver's own round-trip tests, which write each value to a real PostgreSQL server and read it back through `database/sql` and the native `Pool`, over simple queries, queries with arguments, queries with the statement cache off, and prepared statements. A row that says `Yes` is a row where every one of those reads passed. When a fix lands and its test is no longer marked as a known failure, this page is regenerated, so it cannot keep describing a gap that is closed.
