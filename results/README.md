# Benchmark results

Machine-generated benchmark data for [goceleris/celeris](https://github.com/goceleris/celeris),
published by [goceleris/probatorium](https://github.com/goceleris/probatorium)'s
`mage Publish` after each cluster benchmark run.

**There may be no data here yet** — the first results land when the benchmark
tier runs on the cluster.

## Layout

```
results/
  <version>/                       # e.g. v1.4.15
    <yyyymmdd>/                    # run date
      <arch>/                      # x86_64 | arm64
        summary.json               # per-(scenario × server) aggregates (rps, latency pctls, RSS, CPU)
        timeseries.json.gz         # per-second rps / p99 / errors over each run
        histograms.json.gz         # merged HdrHistograms (base64) for exact-percentile recompute
        env.json                   # kernel, Go, CPU, compile flags for that run
      run-2/ run-3/ ...            # back-to-back runs when a release seeds a fresh baseline
```

`arch` is always `x86_64` or `arm64`. This on-disk tree is the **single source of
truth**. The static documentation site (Astro, in this repo) reads the tree
directly at build time and derives every dashboard asset itself — there is no
committed manifest or `latest/` mirror to maintain.

Producers commit the four files of a cell directly, then fire a
`benchmark-published` `repository_dispatch`. Cloudflare Workers Builds rebuilds
and deploys the site on that push by itself, so nothing here has to trigger a
deploy; `.github/workflows/sync-benchmarks.yml` instead **verifies** the
publish — it asserts that the cell the dispatch points at is really on disk
(a dispatch for a cell that never landed fails the job) and then runs
`bun run validate` over the whole tree.

The site build itself stays lenient: it validates every cell it reads and
*skips* malformed ones, so one corrupt cell cannot take the deploy down. The
red check is `bun run validate` (`scripts/build-data.ts --validate-only`),
which walks the same tree, emits nothing and exits non-zero if any cell fails
validation — it runs in `ci.yml` on every pull request and push to `main`, and
in `sync-benchmarks.yml` on every publish.
