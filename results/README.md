# Benchmark results

Machine-generated benchmark data for [goceleris/celeris](https://github.com/goceleris/celeris),
published by [goceleris/probatorium](https://github.com/goceleris/probatorium)'s
`mage Publish` after each cluster benchmark run.

**There is no data here yet** — the first results land when the benchmark
tier runs on the cluster. `index.json` is an empty manifest until then.

## Layout

```
results/
  index.json                       # manifest: every version → date → arch → run, with file pointers
  latest/                          # mirror of the newest version's newest run (per arch)
    <arch>/{summary,timeseries.json.gz,histograms.json.gz,env}.json
  <version>/                       # e.g. v1.4.12
    <yyyymmdd>/                    # run date
      <arch>/                      # x86_64 | arm64
        summary.json               # per-(scenario × server) aggregates (rps, latency pctls, RSS, CPU)
        timeseries.json.gz         # per-second rps / p99 / errors / RSS over each run
        histograms.json.gz         # merged HdrHistograms (base64) for exact-percentile recompute
        env.json                   # kernel, Go, CPU, NUMA, compile flags for that run
      run-2/ run-3/ ...            # back-to-back runs when a release seeds a fresh baseline
```

`arch` is always `x86_64` or `arm64`. Producers commit the files directly,
then fire a `celeris-results` `repository_dispatch`; `sync-benchmarks.yml`
rebuilds `index.json` + refreshes `latest/` and validates the committed tree
against the schema in `scripts/`.
