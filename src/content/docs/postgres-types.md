---
title: PostgreSQL types
description: Which PostgreSQL column types and Go values the celeris driver reads and writes, how each one comes back in Go, and the known gaps.
group: Data & Integration
order: 3
---

This page lists what the celeris PostgreSQL driver (`driver/postgres`) can read from a column and what it accepts as a query argument, so you can check a type before you rely on it. For how to open a connection and the rest of the driver, see [Stores and database drivers](/docs/data-stores).

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
| `int2` | Yes, more with v1.6.0 | `int64`<br>Scan into: `any`, `*int16`, `*int64`, `*int`<br>NULL: `*sql.NullInt64` | Values from -32768 to 32767.<br>`*string`, `*[]byte` do not work with the native Pool, on queries with arguments ([gap 1](#gap-1)). |
| `int4` | Yes, more with v1.6.0 | `int64`<br>Scan into: `any`, `*int32`, `*int64`, `*int`<br>NULL: `*sql.NullInt64` | `*string`, `*[]byte` do not work with the native Pool, on queries with arguments ([gap 1](#gap-1)). |
| `int8` | Yes, more with v1.6.0 | `int64`<br>Scan into: `any`, `*int64`, `*int`<br>NULL: `*sql.NullInt64` | The full range of a Go `int64` works, including the minimum and maximum.<br>`*string`, `*[]byte` do not work with the native Pool, on queries with arguments ([gap 1](#gap-1)). |
| `float4` | Yes | `float64`<br>Scan into: `any`, `*float32`, `*float64`<br>NULL: `*sql.NullFloat64` | Read it into a `float32` or a `float64`. |
| `float8` | Yes | `float64`<br>Scan into: `any`, `*float64`<br>NULL: `*sql.NullFloat64` | `NaN`, `+Infinity`, `-Infinity`, `1e300` and `5e-324` come back unchanged. |
| `numeric` | Yes, more with v1.6.0 | `string`<br>Scan into: `any`<br>NULL: `*sql.NullString` | Returned as its decimal text, so no precision is lost: `123456789012345678901234567890.123456789`, `12.50` (the scale is kept) and `NaN` all come back as written. To compute with it, parse it with a decimal library.<br>`*string`, `*[]byte` do not work with the native Pool, on queries with arguments ([gap 1](#gap-1)). |
| `text` | Yes | `string`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Any Unicode text, an empty string, and values of 100 KiB work. |
| `varchar(n)` | Yes | `string`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` |  |
| `char(n)` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | The value is padded with spaces to the length `n`, as PostgreSQL does (`ab` in a `char(4)` comes back as `ab  `). |
| `name` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` |  |
| `bytea` | Yes, more with v1.6.0 | `[]byte`<br>Scan into: `any`<br>NULL: `*sql.NullString` | All 256 byte values, an empty value and values of 100 KiB work.<br>`*[]byte` does not work with the native Pool, on queries without arguments ([gap 2](#gap-2)). |
| `json` | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Returned as the JSON text, as bytes. Scan it into a `string` or a `[]byte`. The `jsonb` type is not in this table yet, see below. |
| `uuid` | Yes, more with v1.6.0 | `string`<br>Scan into: `any`<br>NULL: `*sql.NullString` | Returned as text in the usual form, `550e8400-e29b-41d4-a716-446655440000`.<br>`*string`, `*[]byte` do not work with the native Pool, on queries with arguments ([gap 1](#gap-1)). |
| `date` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` at midnight UTC. |
| `date` (BC, a year before 1) | With v1.6.0 | `time.Time`<br>NULL: `*sql.NullTime` | `any`, `*time.Time` do not work on queries without arguments ([gap 3](#gap-3)). |
| `time` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `timetz` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `timestamp` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` with no zone: the wall-clock fields are what PostgreSQL stores, read as UTC. Dates from 1970 back to 1708 and forward to 2292 are tested on every kind of query; the years outside that range are in the next row. |
| `timestamptz` | Yes | `time.Time`<br>Scan into: `any`, `*time.Time`<br>NULL: `*sql.NullTime` | Returned as a `time.Time` for the same instant that PostgreSQL stores. Do not rely on the zone of the returned value; call `.UTC()` or `.In(...)`. |
| timestamp, timestamptz (before the year 1708 or after 2292) | With v1.6.0 | `time.Time`<br>NULL: `*sql.NullTime` | Inside that range the `timestamp` and `timestamptz` rows above are correct.<br>`any`, `*time.Time` do not work on queries with arguments, including prepared statements ([gap 5](#gap-5)). |
| `interval` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `int2[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `int4[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `int8[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `text[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `varchar[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `float8[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `bool[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `uuid[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `bytea[]` | Partly | `[]driver.Value`<br>Scan into: `any`<br>NULL: `*sql.NullString` | `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 6](#gap-6)). |
| `int4[][]` (two-dimensional) | No | Not supported (see the known gap)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 7](#gap-7)). |
| `numeric[]` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `date[]` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `timestamptz[]` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `inet` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `cidr` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `macaddr` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `oid` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
| `enum` (a type you create) | Yes | `[]byte`<br>Scan into: `any`, `*string`, `*[]byte`<br>NULL: `*sql.NullString` | Returned as the label, as bytes; scan it into a `string` or a `[]byte`. |
| `enum[]` | With v1.6.0 | `[]byte` (text form)<br>NULL: `*sql.NullString` | `any`, `*string`, `*[]byte` do not work on queries with arguments, including prepared statements ([gap 4](#gap-4)). |
<!-- driver-types:end postgres column-types -->

### Types that are not in the table yet

`jsonb` and `jsonb[]` are not in the table yet. With the native `Pool`, reading a `jsonb` column into a `string` or a `[]byte` returned the stored bytes with a leading `0x01` byte in front of the JSON text. A fix is in review for v1.6.0 ([#1333](https://github.com/goceleris/celeris/pull/1333), issue [#1334](https://github.com/goceleris/celeris/issues/1334)), and `jsonb` joins the table when it lands.

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
| `time.Time` | Partly | Works with `date`, `timestamp`, `timestamptz` | The instant is kept, including the zone offset you give it.<br>Fails for `time`, `timestamptz (years before 1)` on queries with arguments, including prepared statements ([gap 8](#gap-8)). |
| nil (SQL NULL) | Yes | Works with `bool`, `int2`, `int4`, `int8`, `float4`, `float8`, `numeric`, `text`, `bytea`, `json`, `uuid`, `date`, `time`, `timestamp`, `timestamptz`, `interval`, `int4[]`, `text[]`, `inet`, `cidr` | Passing `nil` writes `NULL` to a column of any type. |
| `int16` | No, more with v1.6.0 | Not accepted today | Fails for `int2` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int2` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `byte` | No, more with v1.6.0 | Not accepted today | Fails for `int4` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int4` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `uint32` | No, more with v1.6.0 | Not accepted today | Fails for `int8` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int8` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `uint64` | No, more with v1.6.0 | Not accepted today | Fails for `int8` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int8` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| your own defined string type | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| your own defined integer type | No, more with v1.6.0 | Not accepted today | Fails for `int4` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int4` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| a type that implements driver.Valuer | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.NullString` | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| sql.NullString holding NULL | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.NullInt64` | No, more with v1.6.0 | Not accepted today | Fails for `int8` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int8` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| sql.NullInt64 holding NULL | No, more with v1.6.0 | Not accepted today | Fails for `int8` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int8` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.NullBool` | No, more with v1.6.0 | Not accepted today | Fails for `bool` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `bool` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.NullFloat64` | No, more with v1.6.0 | Not accepted today | Fails for `float8` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `float8` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.NullTime` | No, more with v1.6.0 | Not accepted today | Fails for `timestamptz` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `timestamptz` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `sql.Null[int32]` | No, more with v1.6.0 | Not accepted today | Fails for `int4` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `int4` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `*string` | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| \*string holding NULL | No, more with v1.6.0 | Not accepted today | Fails for `text` with database/sql, on queries with arguments and prepared statements ([gap 9](#gap-9)).<br>Fails for `text` with the native Pool, on queries with arguments ([gap 10](#gap-10)). |
| `[16]byte` | No | Not accepted today | Fails for `uuid` on queries with arguments, including prepared statements ([gap 11](#gap-11)). |
| `json.RawMessage` | No, more with v1.6.0 | Not accepted today | Fails for `json` with the native Pool, on queries with arguments ([gap 10](#gap-10)).<br>Fails for `json` with database/sql, on queries with arguments and prepared statements ([gap 12](#gap-12)). |
| `[]string` | No | Not accepted today | Fails for `text[]` on queries with arguments, including prepared statements ([gap 13](#gap-13)). |
| `[]int64` | No | Not accepted today | Fails for `int8[]` on queries with arguments, including prepared statements ([gap 13](#gap-13)). |
<!-- driver-types:end postgres argument-kinds -->

## Known gaps

Each gap says what you see, what error you get (or that there is none), and where it is tracked. A gap marked for v1.6.0 has a fix in review for the v1.6.0 release; a gap marked for v1.6.1 stays through v1.6.0.

<!-- driver-types:begin postgres gaps -->
1. <a id="gap-1"></a>With the native `Pool`, scanning an integer, numeric or uuid column into a `string` or a `[]byte` on a query with arguments gave the raw binary wire bytes instead of the text. There is no error: the value is wrong without a warning. A fix is in review for v1.6.0: [#1333](https://github.com/goceleris/celeris/pull/1333) (issue [#1334](https://github.com/goceleris/celeris/issues/1334)).
2. <a id="gap-2"></a>With the native `Pool` and a query without arguments, scanning a bytea column into a `[]byte` gave the text form (`\x00ff...`) instead of the bytes. There is no error: the value is wrong without a warning. A fix is in review for v1.6.0: [#1333](https://github.com/goceleris/celeris/pull/1333).
3. <a id="gap-3"></a>A BC date cannot be read from a query without arguments. The same value is read correctly when the query has arguments. The error is `parsing time "0044-03-15 BC": extra text: " BC"`. A fix is in review for v1.6.0: [#1341](https://github.com/goceleris/celeris/pull/1341).
4. <a id="gap-4"></a>On a query with arguments, a prepared statement or a query the driver caches, a column of a type the driver has no decoder for (time, timetz, interval, inet, cidr, macaddr, oid, and arrays of numeric, date, timestamptz or enum) came back as raw binary bytes. The same query without arguments returned the text. There is no error: the value is wrong without a warning. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
5. <a id="gap-5"></a>On a query with arguments, a prepared statement or a query the driver caches, a `timestamp` or `timestamptz` before about the year 1708 or after about 2292 is read as a different time. The same query without arguments is correct. There is no error: the value is wrong without a warning. A fix is planned for v1.6.0.<!-- pending: no pull request linked yet -->
6. <a id="gap-6"></a>An array column cannot be scanned into a `string` or a `[]byte` on a query with arguments. With `database/sql` you get the error below. With the native `Pool` you get the raw binary bytes today and an error as well from v1.6.0 on. Scan it into an `any` and read the `[]driver.Value`, or cast it to text in the query (`SELECT col::text`). Whether an array comes back as a Go slice or as the text literal also depends on whether the query had arguments. The error is `sql: Scan error on column index 0, name "c": unsupported Scan, storing driver.Value type []driver.Value into type *string`. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
7. <a id="gap-7"></a>A two-dimensional array is returned flattened, as one list of all its elements. A change that makes it an error is planned for v1.6.0. Read it as text, `SELECT col::text`, until it is supported. There is no error: the value is wrong without a warning. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
8. <a id="gap-8"></a>A `time.Time` cannot be passed to a `time` column, and a `time.Time` before year 1 cannot be passed to `timestamptz`. Pass the value as a `string`. The error is `ERROR: invalid input syntax for type time: "2025-01-15T12:34:56.789123Z" (SQLSTATE 22007)`. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
9. <a id="gap-9"></a>With `database/sql`, the wrappers and integer widths that it normally converts for you are rejected as arguments: `sql.NullString`, `sql.NullInt64` and the other `sql.Null*` types, anything that implements `driver.Valuer`, your own defined types, pointers, and `int16`, `uint8`, `uint32` and `uint64`. Writing a NULL with `sql.NullString{}` fails the same way. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type sql.NullString; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. A fix is in review for v1.6.0: [#1340](https://github.com/goceleris/celeris/pull/1340).
10. <a id="gap-10"></a>The native `Pool` rejects the same values (`sql.Null*`, `driver.Valuer`, defined types, pointers, `json.RawMessage`, `int16`, `uint8`, `uint32`, `uint64`) as arguments, because it does not use the conversion `database/sql` applies. Pass the plain value instead, or use `database/sql`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type sql.NullString; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
11. <a id="gap-11"></a>A `[16]byte` array is not accepted as a uuid argument. Pass the uuid as a `string`, or the 16 bytes as a `[]byte`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type [16]uint8; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
12. <a id="gap-12"></a>With `database/sql`, `json.RawMessage` is rejected as an argument, because it is a defined type, as your own types are. Go reports its type as `jsontext.Value`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type jsontext.Value; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. A fix is in review for v1.6.0: [#1340](https://github.com/goceleris/celeris/pull/1340).
13. <a id="gap-13"></a>Go slices (`[]string`, `[]int64`) are not accepted as array arguments. Pass the PostgreSQL array text, such as `{a,b}`, as a `string`. The error is `celeris-postgres: encode arg 1: celeris-postgres: unsupported argument type []string; convert to bool/int64/float64/string/[]byte/time.Time or register a codec`. Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->
<!-- driver-types:end postgres gaps -->

## How this page is made

The tables are generated from the driver's own round-trip tests, which write each value to a real PostgreSQL server and read it back through `database/sql` and the native `Pool`, over simple queries, queries with arguments, queries with the statement cache off, and prepared statements. A row that says `Yes` is a row where every one of those reads passed. When a fix lands and its test is no longer marked as a known failure, this page is regenerated, so it cannot keep describing a gap that is closed.
