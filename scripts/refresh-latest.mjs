#!/usr/bin/env node
// refresh-latest.mjs — mirror the canonical newest run into results/latest/.
//
// latest/ is a derived mirror of the cell index.json marks as `latest` (newest
// version's newest date's default run). It is laid out per-arch to match the
// four-file split: latest/<arch>/{summary.json, timeseries.json.gz,
// histograms.json.gz, env.json}, replacing the legacy flat latest/x86.json.
//
//   node scripts/refresh-latest.mjs [--repo <dir>]
//
// Both the migration and the sync workflow call this (single writer of latest/).

import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resultsRoot, readJSON, runDir } from "./lib/results.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const repoRoot = arg("--repo", process.cwd());
const root = resultsRoot(repoRoot);

const FILES = ["summary.json", "timeseries.json.gz", "histograms.json.gz", "env.json"];

const indexPath = join(root, "index.json");
if (!existsSync(indexPath)) {
  process.stderr.write("refresh-latest: results/index.json not found; run update-index.mjs first\n");
  process.exit(1);
}
const index = readJSON(indexPath);
if (!index.latest) {
  process.stderr.write("refresh-latest: index.latest is null; nothing to mirror\n");
  process.exit(0);
}

const { version, date, run_id: runId } = index.latest;
const latestDir = join(root, "latest");

const vNode = index.versions.find((v) => v.version === version);
const dNode = vNode?.dates.find((d) => d.date === date);
if (!dNode) {
  process.stderr.write(`refresh-latest: index has no node for ${version}/${date}\n`);
  process.exit(1);
}

// Clear stale per-arch dirs so a removed arch doesn't linger.
if (existsSync(latestDir)) {
  for (const e of readdirSync(latestDir, { withFileTypes: true })) {
    if (e.isDirectory()) rmSync(join(latestDir, e.name), { recursive: true });
  }
}

for (const a of dNode.arches) {
  const arch = a.arch;
  const run = a.runs.find((r) => r.run_id === runId) ? runId : a.runs[0]?.run_id;
  if (!run) continue;
  const srcDir = runDir(root, version, date, arch, run);
  const dstDir = join(latestDir, arch);
  mkdirSync(dstDir, { recursive: true });
  for (const f of FILES) {
    const src = join(srcDir, f);
    if (!existsSync(src)) {
      process.stderr.write(`refresh-latest: WARN missing ${src}; skipping\n`);
      continue;
    }
    copyFileSync(src, join(dstDir, f));
  }
  process.stderr.write(`refresh-latest: mirrored ${arch} <- ${version}/${date}/${run}\n`);
}

process.stderr.write(`refresh-latest: latest/ now mirrors ${version}/${date}/${runId}\n`);
