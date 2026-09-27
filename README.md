<p align="center">
  <img src=".github/cover.png" alt="goceleris / docs cover: docs, architecture, guides and benchmarks for Celeris (guides, deep-dives, api, benchmarks)">
</p>

<p align="center">
  <a href="https://github.com/goceleris/docs/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/goceleris/docs/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <a href="https://goceleris.dev"><img src="https://img.shields.io/website?url=https%3A%2F%2Fgoceleris.dev&amp;label=goceleris.dev" alt="goceleris.dev website status"></a>
  <a href="https://codecov.io/gh/goceleris/docs"><img src="https://codecov.io/gh/goceleris/docs/graph/badge.svg" alt="Codecov test coverage"></a>
  <a href="package.json"><img src="https://img.shields.io/github/package-json/dependency-version/goceleris/docs/astro" alt="Astro version from package.json"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fgoceleris%2Fdocs%2Fmain%2Fpackage.json&amp;query=%24.engines.bun&amp;label=bun" alt="Bun version required by package.json engines"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/goceleris/docs" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <strong>The source of <a href="https://goceleris.dev">goceleris.dev</a>:</strong> the documentation, architecture deep-dives
  and benchmark dashboard for <a href="https://github.com/goceleris/celeris">celeris</a>, the HTTP engine for Go.
</p>

<p align="center">
  <a href="https://goceleris.dev/docs/">Documentation</a> ·
  <a href="https://goceleris.dev/benchmarks/">Benchmark dashboard</a> ·
  <a href="https://goceleris.dev/methodology/">Methodology</a> ·
  <a href="#run-it-locally">Run it locally</a>
</p>

## What this repository is

This repository builds **goceleris.dev**: the landing page, the user documentation, the methodology page
and the benchmark dashboard. It is a fully static [Astro](https://astro.build) site with no server:
every page is plain HTML generated at build time, and the dashboard is a single client-only Preact
island that loads the per-version JSON the build emitted.

The benchmark data lives in this repository. Each published run is a set of committed files under
[`results/`](results/); the build reads that tree directly and derives every dashboard asset from it,
so there is no database. [probatorium](https://github.com/goceleris/probatorium) measures the runs and
publishes them here.

## Run it locally

Requires [Bun](https://bun.sh) at the version `engines.bun` in [`package.json`](package.json) sets
(the badge above reads it).

```bash
bun install --frozen-lockfile
bun run dev     # build:data, then astro dev at http://localhost:4321
bun run demo    # the same, against a synthesized demo dataset for a richer preview
```

- `/` is the landing page with the headline benchmark stats.
- `/docs` is the documentation.
- `/benchmarks` is the dashboard.
- `/methodology` explains how the numbers are made.

`bun run dev` builds the dashboard data from the committed `results/` tree, so it shows the published
runs out of the box. `bun run demo` synthesizes a broader multi-version fixture tree under
`.dev-results/` (gitignored) when you want to exercise more of the dashboard.

## Scripts

Every task is a Bun script (see [`package.json`](package.json)):

| Script | What it does |
| --- | --- |
| `bun run dev` | `build:data`, then `astro dev` (localhost:4321) |
| `bun run demo` | Synthesize demo fixtures, build data from them, then `astro dev` |
| `bun run build` | `build:data` → `astro build` → `pagefind --site dist` → `dist/` |
| `bun run preview` | Serve the built `dist/` locally |
| `bun test` | Data-layer tests |
| `bun run validate` | Validate `results/` without emitting anything: the **publish gate** |
| `bun run check` | `astro check` (types and content schema); run `build:data` first |
| `bun run build:data` | Rebuild the dashboard assets from `results/` |
| `bun run demo:data` | Synthesize fixtures, then build data from them |
| `bun run fixtures` | Synthesize the demo fixture tree only |
| `bun run start` | Alias for `bun run dev` |

`validate` runs `build-data --validate-only`. It walks every cell and emits nothing. It exits non-zero
when a cell's `summary.json` or `env.json` fails validation, and with status 2 if it examined no cells
at all, so a gate that inspected nothing can never report success. Problems in `timeseries.json.gz`
are reported as warnings. Unlike `build`, it also scans the versions listed in `DEACTIVATED_VERSIONS`:
hiding a version from the dashboard is a presentation decision, not a licence for its committed data
to rot.

It runs in two places: the `build` job of [`ci.yml`](.github/workflows/ci.yml) on every pull request
and push to `main`, and [`sync-benchmarks.yml`](.github/workflows/sync-benchmarks.yml) on every publish.
`bun run build` deliberately does **not** fail on a bad cell: when a cell's `summary.json` is missing,
unreadable or invalid, it warns, marks the cell `excluded:invalid` and carries on, so one corrupt cell
cannot take the whole deploy down. That is why the separate gate exists.

## Stack

The versions live in [`package.json`](package.json) and [`bun.lock`](bun.lock); the Astro and Bun
badges above read `package.json` on `main`.

- **[Astro](https://astro.build)** with `output: 'static'`, built with **Bun**: no SSR and no runtime
  server.
- Integrations: **@astrojs/mdx**, **@astrojs/preact** (`compat: false`) and **@astrojs/sitemap**.
- **Dashboard**: one **Preact + [@preact/signals](https://preactjs.com/guide/v10/signals/)** island under
  [`src/dashboard/`](src/dashboard/), mounted with `client:only="preact"` on the benchmarks page. It
  ships six views in [`views/`](src/dashboard/views/): `HeadToHead`, `Leaderboard`, `Matrix`,
  `OverTime`, `Resources` and `Versions`. The over-time view draws with
  **[uPlot](https://github.com/leeoniya/uPlot)**
  ([`charts/UplotChart.tsx`](src/dashboard/charts/UplotChart.tsx)).
- **Search**: full-text search over the documentation pages with **[Pagefind](https://pagefind.app)**,
  indexed against the built site (`pagefind --site dist`); it degrades silently in dev.
- **Fonts**: self-hosted, subset **Inter** and **JetBrains Mono** through Astro's Fonts API (the
  top-level `fonts` key in [`astro.config.mjs`](astro.config.mjs)), emitted at build time with
  metric-override fallbacks, so there is no runtime font JavaScript and no third-party request.
- **Code**: **[Shiki](https://shiki.style)** highlights at build time with dual themes
  (`github-dark-default` / `github-light-default`), so highlighted code ships as plain HTML.

The canonical URL comes from `SITE_URL` in [`astro.config.mjs`](astro.config.mjs) (default
`https://goceleris.dev`), which drives the sitemap, canonical links and Open Graph URLs.

## Content structure

The documentation is an Astro **content collection**
([`src/content/docs/**/*.{md,mdx}`](src/content/docs/)). Each page's frontmatter is validated against
the schema in [`src/content.config.ts`](src/content.config.ts):

```yaml
---
title: Routing            # required
description: ...          # optional
group: Routing & Handlers # sidebar section (default "Guides")
order: 1                  # sort order within the group (default 100)
draft: false              # default false
---
```

The sidebar groups appear in this order:

1. **Getting Started**: install Celeris, learn the mental model, serve a request
2. **Routing & Handlers**: routes, params, binding, responses, errors, files
3. **Middleware**: the chain and ordering, plus the in-tree catalog
4. **Real-Time**: streaming, Server-Sent Events, WebSocket fan-out
5. **Data & Integration**: database and cache drivers on the event loop, net/http interop
6. **Reference**: every `Config` field, the four I/O engines, the full `Context` API
7. **Operations**: deploy behind TLS, shut down cleanly, observe, tune, test

Pages beyond the docs collection live in [`src/pages/`](src/pages/): the landing page (`index`), the
docs index and article routes (`docs/index`, `docs/[...slug]`), the `benchmarks` dashboard,
`methodology`, a branded `404`, and generated [`llms.txt`](https://llmstxt.org/) / `llms-full.txt`
maps.

## Benchmark data pipeline

`results/` is the **single source of truth**. A cell is laid out as:

```text
results/<version>/<yyyymmdd>/<arch>/
  summary.json          # per-(scenario × server) aggregates: rps, latency percentiles, RSS, CPU
  timeseries.json.gz    # per-second rps / p99 / errors over the run
  histograms.json.gz    # merged HdrHistograms (base64), kept for provenance; the site does not read them yet
  env.json              # run provenance: version, arch, date, run, git ref, celeris and loadgen versions,
                        # run config and the test fabric
```

[`scripts/build-data.ts`](scripts/build-data.ts) walks that tree (override the root with
`RESULTS_ROOT`), validates and loads each cell, averages all runs per `(version, arch)`, and excludes
smoke runs (anything shorter than 30 s) unless `BUILD_INCLUDE_SMOKE=1`. It never crashes on empty or
malformed data: bad cells are skipped with a warning, and an empty tree yields valid empty assets.
Versions in its `DEACTIVATED_VERSIONS` set are left out of the dashboard.

It emits two sets of assets, both **gitignored** and rebuilt on every build:

- `src/data/generated/{manifest,competitors,scenarios}.json`: the versions, the adapter registry and
  the scenario taxonomy
- `public/data/v/<version>/<arch>.json`: one aggregated payload per version and arch

The landing page's headline stats are computed from those assets by [`src/lib/site.ts`](src/lib/site.ts).
The typed data layer that walks, validates and aggregates cells lives in
[`src/lib/results/`](src/lib/results/) and is covered by `bun test`.

### How a benchmark gets published

1. On the cluster, probatorium's `mage Publish` writes the four files of a cell into
   `results/<version>/<yyyymmdd>/<arch>/` of this repository and pushes them to `main` (one commit by
   default; with `PUBLISH_VIA=contents` it writes each file through the GitHub contents API instead).
   It then fires a `repository_dispatch` event of type `benchmark-published` (a small pointer payload:
   `{ version, arch, date, run_id, path, commit }`).
2. That push to `main` is what triggers **Cloudflare Workers Builds**, which rebuilds and redeploys the
   site; the build reads the new `results/` tree.
3. [`sync-benchmarks.yml`](.github/workflows/sync-benchmarks.yml) listens for that dispatch (it can also
   be run by hand) and **verifies** the publish with `contents: read` and no deploy: it checks that the
   cell the pointer describes is committed, retrying a few times while `main` catches up, fails the job
   if it never lands, and then runs `bun run validate` over the tree. It does **not** trigger the
   deploy; the push to `main` already did.

## Deploy and hosting

The site is a **Cloudflare Workers static-assets** deployment: an assets-only Worker (no SSR, no
Worker script), configured in [`wrangler.jsonc`](wrangler.jsonc):

- `name: "goceleris-docs"`, with assets served from `./dist`
- `not_found_handling: "404-page"`, so the branded `dist/404.html` is served (with a 404 status) on
  unknown routes

**Cloudflare Workers Builds** rebuilds and deploys on every push to `main` (`bun run build` → `dist/`),
so a merged publish ships automatically. The only build setting is **`SITE_URL`** (default
`https://goceleris.dev`); there is no deploy hook.

Caching and crawling are static config:

- [`public/_headers`](public/_headers): content-hashed `/_astro/*` is `immutable`; `/brand`, `/og`,
  `/favicon.svg`, `/pagefind` and `/data` cache for a day; HTML keeps Cloudflare's default of always
  revalidating, so a deploy shows up immediately.
- [`public/robots.txt`](public/robots.txt): allows everything except `/data/`, and points crawlers at
  `https://goceleris.dev/sitemap-index.xml`.

## Repository layout

```text
src/
  content/docs/      # the docs content collection
  dashboard/         # the Preact + uPlot dashboard island (views, charts, state)
  lib/results/       # typed data layer: walk, validate, aggregate, taxonomy
  lib/site.ts        # landing-page headline stats
  pages/             # index, docs, benchmarks, methodology, 404, llms(.full).txt
  layouts/ components/ styles/
scripts/             # build-data and helper CLIs (see below)
results/             # committed benchmark cells: the single source of truth
public/              # static assets, _headers, robots.txt
test/fixtures/       # cell fixtures; sample-cell feeds the data-layer tests (scripts/build-data.test.ts)
```

### Helper scripts

- [`build-data.ts`](scripts/build-data.ts): the pipeline above (`build:data` / `validate`).
- [`import-run.ts`](scripts/import-run.ts): reshape a raw probatorium run into a `results/` cell (a
  manual bridge; the canonical source stays the probatorium run).
- [`regroup-docs.ts`](scripts/regroup-docs.ts): rewrite each doc's `group` / `order` frontmatter to the
  curated information architecture (idempotent).
- [`dev-fixtures.ts`](scripts/dev-fixtures.ts): synthesize the demo tree under `.dev-results/` from the
  preserved sample cell.
- [`gen-og.ts`](scripts/gen-og.ts) / [`gen-logo.ts`](scripts/gen-logo.ts): render the Open Graph image
  and the brand mark as static assets.

## Related projects

| Project | What it is |
| --- | --- |
| [celeris](https://github.com/goceleris/celeris) | The HTTP engine for Go that this site documents |
| [loadgen](https://github.com/goceleris/loadgen) | The HTTP/1.1 and HTTP/2 load generator behind the published benchmarks |
| [probatorium](https://github.com/goceleris/probatorium) | The benchmark and validation harness that measures celeris and publishes runs here |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local checks CI runs, and [SECURITY.md](SECURITY.md) to
report a vulnerability.

## License

[Apache-2.0](LICENSE). Package name: `celeris-site`.
