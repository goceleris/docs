# Celeris site

The static website for [Celeris](https://github.com/goceleris/celeris) — landing
page, user docs, and the benchmarks dashboard — built with **Astro + Bun** and
deployed to **Cloudflare Pages**.

Benchmark data is pushed into [`results/`](results/) by
[probatorium](https://github.com/goceleris/probatorium); the site reads that tree
directly at build time and derives every dashboard asset itself.

## Develop

```bash
bun install
bun run dev        # serve against the real results/ tree (empty until data lands)
bun run demo       # serve with a synthesized demo dataset (.dev-results, gitignored)
```

- `http://localhost:4321/` — landing
- `/docs` — documentation
- `/benchmarks` — dashboard

## Build

```bash
bun run build      # build:data → astro build → pagefind index  →  dist/
bun run preview    # serve the built dist/
bun test           # data-layer tests
bun run validate   # validate the results/ tree without emitting (publish gate)
```

## How it fits together

- **`scripts/build-data.ts`** walks `results/` and emits compact assets:
  `src/data/generated/{manifest,competitors,scenarios}.json` and per-version
  payloads under `public/data/v/<version>/<arch>.json`. Runs before every build.
- **`src/lib/results/`** is the self-contained, typed data layer (walk, validate,
  aggregate, taxonomy). `bun test` covers it.
- **`src/dashboard/`** is the Preact island that renders the dashboard from those
  assets (uPlot for time-series, hand-built SVG for bars/heatmap).
- **`src/content/docs/`** holds the markdown docs (Astro content collection).
- **`.github/workflows/sync-benchmarks.yml`** pings a Cloudflare Pages deploy hook
  when probatorium publishes a run.

## Cloudflare Pages

- Build command: `bun run build`
- Output directory: `dist`
- Set `SITE_URL` (defaults to `https://goceleris.dev`) and the
  `CF_PAGES_DEPLOY_HOOK_URL` repo secret for publish-triggered rebuilds.
