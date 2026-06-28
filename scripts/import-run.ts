#!/usr/bin/env bun
/**
 * import-run — publish a probatorium benchmark run into this repo's results/ tree.
 *
 * Probatorium emits a per-run roll-up (results.json + timeseries.json.gz). This
 * transforms it into the cell layout the site reads:
 *   results/<version>/<yyyymmdd>/<arch>/{summary,timeseries.json.gz,histograms.json.gz,env}.json
 *
 *   bun scripts/import-run.ts <probatorium-run-dir> --version v1.5.2 [--arch x86_64] [--date yyyymmdd]
 *
 * A manual bridge until probatorium's own publisher writes here directly. The
 * canonical source remains the probatorium run; this only reshapes it.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const srcDir = process.argv[2];
if (!srcDir || srcDir.startsWith("--") || !existsSync(join(srcDir, "results.json"))) {
  process.stderr.write("usage: bun scripts/import-run.ts <probatorium-run-dir> --version vX.Y.Z [--arch x86_64] [--date yyyymmdd]\n");
  process.exit(1);
}

const summary = JSON.parse(readFileSync(join(srcDir, "results.json"), "utf8"));
const bc = summary.benchmark_config || {};

const version = arg("--version");
if (!version) {
  process.stderr.write("error: --version is required (e.g. --version v1.5.2)\n");
  process.exit(1);
}
const pair = String(summary.host_arch_pair || "linux/amd64");
const arch = arg("--arch", pair.includes("arm64") ? "arm64" : "x86_64")!;
const finished = String(bc.finished_at || "");
const date = arg("--date", finished.slice(0, 10).replace(/-/g, "")) || "";
if (!/^\d{8}$/.test(date)) {
  process.stderr.write(`error: could not derive a yyyymmdd date (got ${JSON.stringify(date)}); pass --date\n`);
  process.exit(1);
}

const repoRoot = process.cwd();
const cellDir = join(repoRoot, "results", version, date, arch);
mkdirSync(cellDir, { recursive: true });

// Label the cell with the published version (the run dir's bench tag).
summary.benchmark_config = { ...bc, celeris_version: version, git_ref: version };
writeFileSync(join(cellDir, "summary.json"), JSON.stringify(summary));

if (existsSync(join(srcDir, "timeseries.json.gz"))) {
  copyFileSync(join(srcDir, "timeseries.json.gz"), join(cellDir, "timeseries.json.gz"));
}

// Keep the four-file shape even though the site doesn't consume histograms yet.
const histSrc = join(srcDir, "histograms.json.gz");
if (existsSync(histSrc)) copyFileSync(histSrc, join(cellDir, "histograms.json.gz"));
else writeFileSync(join(cellDir, "histograms.json.gz"), gzipSync(Buffer.from(JSON.stringify({ schema_version: "histograms/1", histograms: {} }))));

const env = {
  schema_version: "env/1",
  version,
  arch,
  date,
  run_id: "run-1",
  git_sha: version,
  celeris_version: version,
  loadgen_version: bc.loadgen_version || "",
  generated_at: finished,
  environment: summary.environment || {},
  benchmark_config: summary.benchmark_config,
};
writeFileSync(join(cellDir, "env.json"), JSON.stringify(env));

process.stderr.write(`import-run: wrote ${version}/${date}/${arch} (${(summary.benchmarks || []).length} adapters)\n`);
