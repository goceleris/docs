#!/usr/bin/env bun
/**
 * dev-fixtures — synthesize a realistic multi-version benchmark tree under
 * .dev-results/ (gitignored) from the preserved sample cell, so the dashboard can
 * be previewed with data without committing anything into the real results/ tree.
 *
 *   bun scripts/dev-fixtures.ts
 *   RESULTS_ROOT=.dev-results bun scripts/build-data.ts   # then build assets from it
 *
 * Not part of the production build. The live site reads the real results/ tree.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RawEnv, RawSummary } from "../src/lib/results/types";

const repoRoot = process.cwd();
const fixture = join(repoRoot, "test", "fixtures", "sample-cell");
const out = join(repoRoot, ".dev-results");

if (!existsSync(join(fixture, "summary.json"))) {
  process.stderr.write("dev-fixtures: test/fixtures/sample-cell not found; nothing to generate\n");
  process.exit(1);
}

const baseSummary = JSON.parse(readFileSync(join(fixture, "summary.json"), "utf8")) as RawSummary;
const baseEnv = JSON.parse(readFileSync(join(fixture, "env.json"), "utf8")) as RawEnv;

// The smoke sample ran celeris and competitors on disjoint scenario sets. fillMatrix
// (below) fills a complete, internally-consistent matrix (+ synthetic resources) so
// the preview looks like a real full run. DEMO ONLY — never touches results/.

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

const RSS_MIB: Record<string, number> = {
  celeris: 46,
  go: 64,
  rust: 22,
  cpp: 26,
  python: 115,
  csharp: 92,
  bun: 74,
  zig: 18,
};

function fillMatrix(summary: RawSummary) {
  const benches = summary.benchmarks;
  const allScn = new Set<string>();
  for (const b of benches) for (const k of Object.keys(b.saturation_mode_rps || {})) allScn.add(k);
  const scenarios = [...allScn];

  const gmean: Record<string, number> = {};
  for (const scn of scenarios) {
    const vals: number[] = [];
    for (const b of benches) {
      const v = b.saturation_mode_rps?.[scn];
      if (typeof v === "number" && isFinite(v) && v > 0) vals.push(v);
    }
    gmean[scn] = vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : 1e5;
  }

  const isCelB = (b: RawSummary["benchmarks"][number]) =>
    b.category === "celeris" || (b.name || b.server || "").startsWith("celeris");

  // Phase 1 — fill any missing saturation cell from the adapter's strength.
  for (const b of benches) {
    const id = b.name || b.server || "x";
    const ratios: number[] = [];
    for (const [scn, v] of Object.entries(b.saturation_mode_rps || {})) {
      if (v > 0 && gmean[scn] > 0) ratios.push(v / gmean[scn]);
    }
    const strength = ratios.length ? ratios.reduce((a, c) => a + c, 0) / ratios.length : 1;
    b.saturation_mode_rps ||= {};
    for (const scn of scenarios) {
      if (b.saturation_mode_rps[scn] == null) {
        b.saturation_mode_rps[scn] = Math.max(1500, gmean[scn] * strength * (1 + (fnv(`${id}-${scn}`) - 0.5) * 0.12));
      }
    }
  }

  // Phase 2 — celeris is the product: let its engines lead each scenario,
  // io_uring fastest, then auto, epoll, std (a credible, plausible ordering).
  const CEL_TIER: Record<string, number> = {
    "celeris-iouring-h1-async": 1.34,
    "celeris-iouring-auto+upg-async": 1.27,
    "celeris-epoll-h1-sync": 1.16,
    "celeris-std-h1": 1.05,
  };
  for (const scn of scenarios) {
    let maxRival = 0;
    for (const b of benches) {
      if (!isCelB(b)) maxRival = Math.max(maxRival, b.saturation_mode_rps![scn] ?? 0);
    }
    for (const b of benches) {
      const id = b.name || b.server || "";
      const tier = CEL_TIER[id];
      if (tier) b.saturation_mode_rps![scn] = Math.round(maxRival * tier * (1 + (fnv(`t-${id}-${scn}`) - 0.5) * 0.05));
    }
  }

  // Phase 3 — derive latency_at_slo / rated p99 / resources from final saturation.
  for (const b of benches) {
    const id = b.name || b.server || "x";
    const isCel = isCelB(b);
    const lang = isCel ? "celeris" : (b.language || "go").toLowerCase();
    const rssBase = (RSS_MIB[lang] ?? 60) * 1024 * 1024;
    b.latency_at_slo = {};
    b.rated_mode_p99_at_target_rps = {};
    b.resources = {};
    b.cell_statuses = {};
    for (const scn of scenarios) {
      const rps = b.saturation_mode_rps![scn];
      b.latency_at_slo[scn] = {
        "10": Math.round(rps * (isCel ? 0.62 : 0.46)),
        "50": Math.round(rps * (isCel ? 0.78 : 0.66)),
        "100": Math.round(rps * (isCel ? 0.86 : 0.78)),
        "500": Math.round(rps * 0.93),
        "1000": Math.round(rps * 0.97),
      };
      b.rated_mode_p99_at_target_rps[scn] = Math.round(
        (isCel ? 1 : 2.1) * 1e6 * (2.5 + fnv(`p-${id}-${scn}`) * 6),
      );
      const rss = rssBase * (1 + (fnv(`r-${id}-${scn}`) - 0.5) * 0.18);
      b.resources[scn] = {
        summary: {
          peak_rss_bytes: Math.round(rss),
          steady_rss_bytes: Math.round(rss * 0.86),
          mean_cpu_pct: Math.round((45 + fnv(`c-${id}-${scn}`) * 45) * 10) / 10,
          gc_pause_p99_ns: lang === "go" || isCel ? Math.round((0.4 + fnv(`g-${id}`) * 2) * 1e6) : null,
          goroutine_hwm: lang === "go" || isCel ? Math.round(120 + fnv(`go-${id}`) * 400) : null,
          fd_hwm: Math.round(260 + fnv(`f-${id}`) * 400),
        },
      };
    }
  }
}

// Versions ascending in capability so the "Versions" trend shows celeris improving.
const VERSIONS = [
  { version: "v1.4.14", date: "20260604", factor: 0.82, runs: 2, arches: ["x86_64"] },
  { version: "v1.4.15", date: "20260610", factor: 0.93, runs: 3, arches: ["x86_64", "arm64"] },
  { version: "v1.5.0", date: "20260616", factor: 1.0, runs: 3, arches: ["x86_64", "arm64"] },
];

// Deterministic per-run jitter so cross-run bands have visible spread.
function jitter(seedStr: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // map to ~ [-0.04, 0.04]
  return ((h >>> 0) % 1000) / 1000 / 12.5 - 0.04;
}

function scaleMap(m: Record<string, number> | undefined, f: number): Record<string, number> | undefined {
  if (!m) return m;
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) o[k] = v * f;
  return o;
}

fillMatrix(baseSummary);

rmSync(out, { recursive: true, force: true });

let cells = 0;
for (const v of VERSIONS) {
  for (const arch of v.arches) {
    for (let k = 1; k <= v.runs; k++) {
      const archFactor = arch === "arm64" ? 0.88 : 1;
      const f = v.factor * archFactor * (1 + jitter(`${v.version}-${arch}-${k}`));
      const dir =
        v.runs === 1
          ? join(out, v.version, v.date, arch)
          : join(out, v.version, v.date, arch, `run-${k}`);
      mkdirSync(dir, { recursive: true });

      const summary: RawSummary = JSON.parse(JSON.stringify(baseSummary));
      summary.benchmark_config = {
        ...summary.benchmark_config,
        duration: 120_000_000_000,
        warmup: 30_000_000_000,
        celeris_version: v.version,
        git_ref: v.version,
      };
      for (const b of summary.benchmarks) {
        b.saturation_mode_rps = scaleMap(b.saturation_mode_rps, f);
        // latency_at_slo rps scales with throughput too.
        if (b.latency_at_slo) {
          for (const scn of Object.keys(b.latency_at_slo)) {
            const inner = b.latency_at_slo[scn];
            for (const slo of Object.keys(inner)) inner[slo] = Math.round(inner[slo] * f);
          }
        }
      }
      writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));

      const env: RawEnv = JSON.parse(JSON.stringify(baseEnv));
      env.version = v.version;
      env.arch = arch;
      env.date = v.date;
      env.run_id = v.runs === 1 ? "run-1" : `run-${k}`;
      env.celeris_version = v.version;
      if (env.benchmark_config) env.benchmark_config.duration = 120_000_000_000;
      writeFileSync(join(dir, "env.json"), JSON.stringify(env));

      copyFileSync(join(fixture, "timeseries.json.gz"), join(dir, "timeseries.json.gz"));
      copyFileSync(join(fixture, "histograms.json.gz"), join(dir, "histograms.json.gz"));
      cells++;
    }
  }
}

process.stderr.write(`dev-fixtures: wrote ${cells} cell(s) across ${VERSIONS.length} version(s) into ${out}\n`);
