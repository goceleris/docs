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
`benchmark-published` `repository_dispatch`; `.github/workflows/sync-benchmarks.yml`
pings the Cloudflare Pages deploy hook so the published run appears on the
dashboard. The site build validates every cell it reads and skips malformed ones.
