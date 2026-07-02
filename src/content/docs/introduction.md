---
title: Introduction
description: What Celeris is, who it's for, and how the documentation is organized.
group: Getting Started
order: 1
---

**Celeris** is a high-performance HTTP engine for Go. It replaces the standard
`net/http` server with its own asynchronous I/O core — **io_uring or epoll on
Linux**, with an automatic standard-library fallback everywhere else — while
keeping a routing and middleware API you already know from Gin and Echo. The
name is Latin for *swift*.

```go
import "github.com/goceleris/celeris"
```

The current release is **[`v1.5.6`](https://github.com/goceleris/celeris/releases/latest)** —
always pull the [latest release](https://github.com/goceleris/celeris/releases/latest)
from GitHub.

> New here and want to ship something? Skip ahead to
> [Getting started](/docs/getting-started). This page is the map of the
> territory, not the tutorial.

## What Celeris is

Celeris is a drop-in replacement for the `net/http` *server* — not for the
`net/http` *types* you write handlers against, and not a framework that wraps the
stdlib server. Underneath your routes sits a custom event loop:

- **On Linux** it runs a tiered **io_uring** engine (kernel 5.10+, richer
  features on 5.19+) or an edge-triggered **epoll** engine with per-core CPU
  pinning. The default **adaptive** engine starts on epoll and promotes
  connections to io_uring under sustained load.
- **On every other platform** (macOS, Windows, BSD) it transparently uses the
  **std** engine — Go's `net/http` server — so the same code builds and runs
  unchanged. You opt into a native engine via [`Config.Engine`](/docs/configuration);
  the default already picks the best available engine per platform.

On top of that core sits a familiar high-level API: route groups, hierarchical
middleware, named routes with reverse-URL generation, and error-returning
handlers. Your handler code looks like any other Go web app.

It speaks **HTTP/1.1** and **HTTP/2 cleartext (h2c)**, with optional automatic
protocol detection from the first bytes on the wire (see
[Protocols](/docs/configuration)).

### Who it's for

Celeris targets latency-sensitive, high-throughput services where `net/http`'s
syscall and scheduler overhead becomes the bottleneck — API gateways, edge
proxies, real-time fan-out, and zero-allocation microservices. If you are happy
with `net/http`'s throughput, you do not need Celeris; if you are fighting the
runtime for the last 20% of tail latency or RPS, this is the engine for that
fight.

## Why Celeris

| Pillar | What it means |
|--------|---------------|
| **Zero-allocation hot path** | `Context` objects are pooled and recycled between requests; H1/H2 fast paths reuse inline buffers and pre-encoded HPACK responses, so typical request/response cycles allocate nothing. |
| **Protocol × engine model** | Protocol (HTTP/1.1, h2c, Auto) and I/O engine (io_uring, epoll, adaptive, std) are chosen independently via two `Config` fields. Most code never touches either — the defaults are correct. |
| **Adaptive engine** | The default Linux engine starts on epoll (best for ramp-from-zero and low concurrency) and promotes connections to io_uring under sustained high load, driven by live telemetry. A `WorkloadHint` lets you bias the start choice. |
| **Async handler dispatch** | Handlers run inline on the I/O worker by default (lowest latency). Routes that block on I/O opt into a per-connection goroutine with `.Async()`, so the worker stays free to drive other connections. |
| **Batteries-included middleware** | An in-tree catalog of 30+ middleware packages — auth (JWT, basic, key), CORS, CSRF, compression, caching, rate limiting, sessions, WebSocket, SSE, OpenTelemetry, Prometheus, and more. See [Middleware](/docs/middleware). |

> Curious how the engines actually compare? Browse the open, reproducible numbers
> on the [benchmarks dashboard](/benchmarks).

## Mental model in 30 seconds

A Celeris program is three steps: **create** a server with a `Config`,
**register** middleware and routes, then **start** it.

```go
package main

import (
	"log"

	"github.com/goceleris/celeris"
)

func main() {
	// 1. Create — Config defaults are sensible; Addr is the only field you
	//    usually need. Engine defaults to Adaptive on Linux, Std elsewhere.
	s := celeris.New(celeris.Config{Addr: ":8080"})

	// 2. Register — handlers have the signature func(*celeris.Context) error.
	s.GET("/hello", func(c *celeris.Context) error {
		return c.String(200, "Hello, World!")
	})

	// 3. Start — blocks until the server stops or errors.
	log.Fatal(s.Start())
}
```

That is the entire surface you need to serve a request. Everything else —
parameters, JSON binding, middleware, streaming, graceful shutdown — layers onto
those three calls.

A few load-bearing facts about that snippet:

- [`celeris.New(Config)`](https://github.com/goceleris/celeris/blob/main/server.go)
  returns a `*Server`. Route- and middleware-registration methods (`GET`,
  `POST`, `Use`, `Group`, …) must be called **before** `Start`.
- A **handler is `func(c *celeris.Context) error`** (the `HandlerFunc` type).
  Returning an error hands it to Celeris's centralized error handling rather than
  forcing you to write the response inline. See [Routing](/docs/routing).
- The **`*Context` is pooled** — it is valid only for the duration of the
  handler. Do not retain it after the handler returns; copy out any values you
  need first.
- `Start()` blocks. For production lifecycle (signal-driven graceful shutdown),
  use `StartWithContext(ctx)` instead — see [Operations →
  Deployment](/docs/deployment).

## Key facts to know up front

These are the constraints that surprise people. Read them once before you design
around Celeris.

| Fact | What it means for you |
|------|-----------------------|
| **Native engines are Linux-only** | io_uring, epoll, and adaptive exist only on Linux. On macOS/Windows/BSD, Celeris automatically uses the **std** (`net/http`) engine — your code is unchanged, but you won't see native-engine performance off Linux. This fallback is automatic; you do not configure it. |
| **No built-in TLS** | Celeris has **no HTTPS listener and no TLS configuration** — `Config` exposes no certificate fields, and every engine (io_uring, epoll, adaptive, and std) binds a plain TCP listener. Terminate TLS at an upstream proxy (Caddy, Nginx, Envoy) and forward cleartext to Celeris. See [Deployment](/docs/deployment). |
| **Cleartext H1 / h2c only** | Protocols are HTTP/1.1 and HTTP/2 *cleartext* (h2c). There is no h2 over TLS (ALPN) because there is no TLS. `Protocol: celeris.Auto` (the default) detects H1 vs h2c per connection. |
| **Go 1.26+** | Celeris requires a modern toolchain (the module declares `go 1.26.4`). Build with Go 1.26.4 or newer. |

> **Common pitfall — expecting `https://`.** A fresh Celeris server listens on
> plain TCP. `curl https://localhost:8080` will fail; `curl http://localhost:8080`
> is correct. Put TLS termination in front of it for production.

## Where to next

The [documentation home](/docs) is the full map — grouped into Getting Started,
Routing & Handlers, Middleware, Real-Time, Data & Integration, Reference, and
Operations. If you just want to ship, jump straight to
[Getting started](/docs/getting-started), then [Core concepts](/docs/core-concepts).

## Compatibility & versioning

- **Module:** `github.com/goceleris/celeris` · **package:** `celeris`.
- **Version:** the running version is the exported `celeris.Version` constant
  (currently `1.5.6`). Pin a version in your `go.mod` and upgrade deliberately.
- **Go toolchain:** Go 1.26.4+ (the module targets `go 1.26.4`).
- **Platforms:** Linux for io_uring/epoll/adaptive; any OS Go supports for the
  std engine. The engine choice is automatic unless you set
  [`Config.Engine`](/docs/configuration).
- **net/http interop:** existing `http.Handler` / `http.HandlerFunc` code can be
  mounted with `celeris.Adapt` / `celeris.AdaptFunc` (the bridge buffers adapted
  responses in memory). See [Routing](/docs/routing) and
  [Middleware](/docs/middleware).

## FAQ

**Do I have to rewrite my `net/http` handlers?**
No. New routes use the `func(*celeris.Context) error` handler signature, but you
can mount existing `http.Handler` values with `celeris.Adapt(...)` while you
migrate incrementally.

**Will my code break on macOS or Windows?**
No. Celeris falls back to the std (`net/http`) engine automatically on non-Linux
platforms. You lose native-engine performance, not functionality — handy for
local development on a Mac and Linux in production.

**How do I serve HTTPS?**
You don't in-process — Celeris has no built-in TLS on any engine, and `Config`
exposes no certificate fields. Terminate TLS upstream (Caddy/Nginx/Envoy) and
forward cleartext. See [Deployment](/docs/deployment).

**Which engine should I use?**
The default — **Adaptive** on Linux, **Std** elsewhere. Only pin a specific
engine if you have a measured reason to. [Engines](/docs/engines) explains the
trade-offs.

**Is it production-ready?**
Celeris ships graceful and zero-downtime restart, overload control, built-in
metrics, and a broad middleware catalog, and it is continuously validated and
benchmarked in the open. See the [benchmarks dashboard](/benchmarks) and
[Deployment](/docs/deployment).
