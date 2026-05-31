#!/usr/bin/env node
// migrate-v1.mjs — one-shot lift of the legacy schema_version 3.0 results into
// the v5.2 split tree. Run once, by hand, then commit; never wired into CI.
//
//   node scripts/migrate-v1.mjs [--repo <dir>] [--apply]
//
// Without --apply it prints what it would write (dry run). With --apply it
// writes the tree, deletes the legacy files, and rebuilds index.json + latest/.
//
// The lift is intentionally lossy in one direction: 3.0 carries pre-computed
// latency percentiles (in ms) and a per-second rps time-series, but no HDR
// base64 and no rated-mode/SLO sweeps. We do NOT fabricate those —
// histograms.json.gz is empty, latency_at_slo and rated_mode_p99_at_target_rps
// stay empty, and env.json.migration_notes records every gap. Everything 3.0
// *does* carry is preserved: legacy latency goes into resources[].summary as a
// legacy_latency_ms annotation, the rps series goes into timeseries.json.gz, and
// the full legacy environment is stashed verbatim under env.json.legacy_environment.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCHEMA, DEFAULT_RUN, CELERIS_CATEGORY, resultsRoot } from "./lib/results.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const APPLY = process.argv.includes("--apply");
const repoRoot = arg("--repo", process.cwd());
const root = resultsRoot(repoRoot);

const VERSION = "v1.0.0";
const RUN = DEFAULT_RUN;

// Legacy arch labels on disk; environment.architecture is "x86"/"arm64".
const LEGACY = [
  { src: join(root, VERSION, "x86.json"), arch: "x86_64" },
  { src: join(root, VERSION, "arm64.json"), arch: "arm64" },
];

// host_arch_pair uses Go's GOOS/GOARCH. Legacy ran on Linux.
const HOST_ARCH_PAIR = { x86_64: "linux/amd64", arm64: "linux/arm64" };

// dateFromISO turns the legacy generated_at into the on-disk yyyymmdd dir name.
function dateFromISO(iso) {
  return (iso || "").slice(0, 10).replace(/-/g, "") || "00000000";
}

function lift(legacy, arch) {
  const env3 = legacy.environment || {};
  const benches = Array.isArray(legacy.benchmarks) ? legacy.benchmarks : [];
  const date = dateFromISO(legacy.generated_at);
  const genAt = legacy.generated_at || "";

  // Transpose benchmarks[scenario].servers[] -> per-server ServerResult covering
  // all scenarios. Collect the rps series for the timeseries sidecar.
  const byServer = new Map();
  const tsByServer = new Map(); // server -> { scenario -> [{t,rps}] }

  for (const b of benches) {
    const scenario = b.name;
    for (const s of b.servers || []) {
      const name = s.name;
      if (!byServer.has(name)) {
        byServer.set(name, {
          server: name,
          category: s.category, // baseline | celeris | theoretical
          framework: s.framework,
          saturation_mode_rps: {},
          rated_mode_p99_at_target_rps: {}, // empty: 3.0 has no rated mode
          latency_at_slo: {}, // empty: 3.0 has no SLO sweep
          loadgen_cpu_p95: {},
          sent_vs_handled_delta_pct: {},
          resources: [],
        });
      }
      const sr = byServer.get(name);

      if (typeof s.requests_per_sec === "number") {
        sr.saturation_mode_rps[scenario] = s.requests_per_sec;
      }
      if (typeof s.system_metrics?.client_cpu_percent === "number") {
        sr.loadgen_cpu_p95[scenario] = s.system_metrics.client_cpu_percent;
      }

      const sm = s.system_metrics || {};
      sr.resources.push({
        scenario,
        protocol: s.protocol,
        summary: {
          server_cpu_percent: numOrNull(sm.server_cpu_percent),
          server_cpu_user_percent: numOrNull(sm.server_cpu_user_percent),
          server_cpu_sys_percent: numOrNull(sm.server_cpu_sys_percent),
          server_memory_rss_mb: numOrNull(sm.server_memory_rss_mb),
          client_cpu_percent: numOrNull(sm.client_cpu_percent),
          throughput_bytes_per_sec: numOrNull(s.throughput_bytes_per_sec),
          total_requests: numOrNull(s.total_requests),
          error_rate: numOrNull(s.error_rate),
          duration_seconds: numOrNull(s.duration_seconds),
          // legacy pre-computed latency (ms) carried so the distribution tab can
          // render without an HDR histogram.
          legacy_latency_ms: cleanLatency(s.latency),
        },
        series: liftSeries(sm.timeseries),
      });

      const ts = sm.timeseries;
      if (Array.isArray(ts) && ts.length) {
        if (!tsByServer.has(name)) tsByServer.set(name, {});
        tsByServer.get(name)[scenario] = ts.map((p) => ({ t: p.t, rps: p.rps }));
      }
    }
  }

  const serverResults = [...byServer.values()];

  const benchmarkConfig = {
    started_at: genAt,
    finished_at: genAt,
    runs: 1,
    duration_sec: legacy.benchmark_config?.duration_seconds ?? 0,
    warmup_sec: legacy.benchmark_config?.warmup_seconds ?? 0,
    legacy_benchmark_config: legacy.benchmark_config || {},
  };

  // summary.json — a report.Document with bulk fields stripped. No
  // hdr_histogram_b64 in 3.0; resource series stays inline.
  const summary = {
    schema_version: "5.2",
    host_arch_pair: HOST_ARCH_PAIR[arch],
    benchmark_config: benchmarkConfig,
    validation_results: null, // 3.0 predates the validation gate
    soak_summary: null,
    benchmarks: serverResults,
  };

  // histograms.json.gz — empty: 3.0 has no HDR base64.
  const histograms = {
    schema_version: SCHEMA.histograms,
    generated_at: genAt,
    host_arch_pair: HOST_ARCH_PAIR[arch],
    histograms: {},
  };

  // timeseries.json.gz — timeseries/1, folding legacy per-second rps series.
  const timeseries = {
    schema_version: SCHEMA.timeseries,
    generated_at: genAt,
    host_arch_pair: HOST_ARCH_PAIR[arch],
    series: Object.fromEntries(tsByServer),
  };

  const notes = [
    "Lifted from legacy schema_version 3.0 by scripts/migrate-v1.mjs.",
    "3.0 carried pre-computed latency percentiles (ms) only; no HDR histograms exist, so histograms.json.gz is empty.",
    "3.0 predates rated-mode and SLO sweeps; latency_at_slo and rated_mode_p99_at_target_rps are empty (not fabricated).",
    `Legacy environment.architecture was '${env3.architecture}'; renamed to '${arch}' for the canonical vocabulary.`,
  ];

  const env = {
    schema_version: SCHEMA.env,
    version: VERSION,
    arch,
    date,
    run_id: RUN,
    git_sha: legacy.git_sha || "",
    git_ref: legacy.git_ref || `refs/tags/${VERSION}`,
    celeris_version: legacy.celeris_version || VERSION,
    loadgen_version: "",
    generated_at: genAt,
    migrated_from: legacy.schema_version || "3.0",
    migration_notes: notes,
    legacy_run_id: legacy.run_id || "",
    environment: {
      kernel_sysctls_applied: [],
      loadgen_host: env3.client_instance_type || "",
      fabric: env3.server_instance_type ? `AWS ${env3.server_instance_type} (${env3.infra_mode || ""})`.trim() : "",
    },
    legacy_environment: env3, // verbatim: nothing lost
    benchmark_config: benchmarkConfig,
  };

  return { date, summary, histograms, timeseries, env };
}

function numOrNull(v) {
  return typeof v === "number" ? v : null;
}
function cleanLatency(lat) {
  if (!lat || typeof lat !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(lat)) {
    if (typeof v === "number") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
// liftSeries downsamples the per-second rps series to <=60 points (the v5.2
// ResourceStats.series cap) for the inline summary copy.
function liftSeries(ts) {
  if (!Array.isArray(ts)) return [];
  return ts.slice(0, 60).map((p) => ({ t_sec: p.t, rps: p.rps }));
}

function writeCell(date, arch, files) {
  const dir = join(root, VERSION, date, arch);
  if (APPLY) mkdirSync(dir, { recursive: true });
  const plan = [
    ["summary.json", JSON.stringify(files.summary, null, 2) + "\n"],
    ["histograms.json.gz", gzipSync(Buffer.from(JSON.stringify(files.histograms)))],
    ["timeseries.json.gz", gzipSync(Buffer.from(JSON.stringify(files.timeseries)))],
    ["env.json", JSON.stringify(files.env, null, 2) + "\n"],
  ];
  for (const [name, content] of plan) {
    const p = join(dir, name);
    if (APPLY) writeFileSync(p, content);
    const size = APPLY ? statSync(p).size : Buffer.byteLength(content);
    process.stderr.write(`${APPLY ? "wrote" : "would write"} ${p} (${size} bytes)\n`);
  }
}

function main() {
  for (const { src, arch } of LEGACY) {
    if (!existsSync(src)) {
      process.stderr.write(`skip ${arch}: source ${src} not found\n`);
      continue;
    }
    const legacy = JSON.parse(readFileSync(src, "utf8"));
    const files = lift(legacy, arch);
    writeCell(files.date, arch, files);
  }

  // Delete legacy flat files (versioned + stray + flat latest).
  const legacyPaths = [
    join(root, VERSION, "x86.json"),
    join(root, VERSION, "arm64.json"),
    join(root, "arm64.json"), // stray top-level duplicate (if present)
    join(root, "x86.json"), // stray top-level duplicate (if present)
    join(root, "latest", "x86.json"),
    join(root, "latest", "arm64.json"),
  ];
  for (const p of legacyPaths) {
    if (!existsSync(p)) continue;
    if (APPLY) rmSync(p);
    process.stderr.write(`${APPLY ? "deleted" : "would delete"} ${p}\n`);
  }

  if (!APPLY) {
    process.stderr.write("\ndry run complete. re-run with --apply to write the tree.\n");
    return;
  }

  // Rebuild index.json then mirror latest/ via the canonical scripts so the
  // migration uses the exact code paths the workflow does.
  const here = dirname(fileURLToPath(import.meta.url));
  run(["node", join(here, "update-index.mjs"), "--repo", repoRoot]);
  run(["node", join(here, "refresh-latest.mjs"), "--repo", repoRoot]);
  process.stderr.write("\nmigration applied: tree written, legacy deleted, index + latest rebuilt.\n");
}

function run(argv) {
  execFileSync(argv[0], argv.slice(1), { stdio: "inherit" });
}

main();
