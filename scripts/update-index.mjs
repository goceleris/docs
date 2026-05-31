#!/usr/bin/env node
// update-index.mjs — rebuild results/index.json from the on-disk tree.
//
// The tree is the single source of truth; this script derives the manifest as
// a browse-without-fetch cache. It is idempotent: running it twice over the
// same tree yields a byte-identical index.json (modulo --now).
//
//   node scripts/update-index.mjs [--repo <dir>] [--now <iso>]
//
// Invoked by the docs sync workflow (the single writer of index.json and
// latest/) and by the one-shot migration. It always scans the whole tree, so a
// re-publish of a single cell is reflected without bespoke upsert logic.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA,
  ARCHES,
  DEFAULT_RUN,
  resultsRoot,
  readJSON,
  listVersions,
  listDates,
  listArches,
  listRuns,
  runDir,
  runFilePath,
  runCmp,
  versionCmpDesc,
  dateCmpDesc,
  deriveHeadline,
  fileBytes,
} from "./lib/results.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const repoRoot = arg("--repo", process.cwd());
const nowISO = arg("--now", new Date().toISOString());
const root = resultsRoot(repoRoot);

function buildRun(version, date, arch, runId) {
  const dir = runDir(root, version, date, arch, runId);
  const summary = readJSON(join(dir, "summary.json"));
  const env = readJSON(join(dir, "env.json"));

  const files = {};
  for (const name of ["summary.json", "timeseries.json.gz", "histograms.json.gz", "env.json"]) {
    const key = name.split(".")[0];
    files[key] = runFilePath(version, date, arch, runId, name);
  }

  const cfg = summary.benchmark_config || env.benchmark_config || {};
  return {
    run_id: runId,
    schema_version: String(summary.schema_version || ""),
    started_at: cfg.started_at || env.started_at || "",
    finished_at: cfg.finished_at || env.finished_at || "",
    runs_count: Number(cfg.runs || cfg.runs_count || 1),
    files,
    bytes: fileBytes(dir),
    headline: deriveHeadline(summary),
  };
}

function buildArch(version, date, arch) {
  const runs = listRuns(root, version, date, arch)
    .map((r) => buildRun(version, date, arch, r))
    .sort((a, b) => runCmp(a.run_id, b.run_id));
  return { arch, runs };
}

function buildDate(version, date) {
  const arches = listArches(root, version, date)
    .sort((a, b) => ARCHES.indexOf(a) - ARCHES.indexOf(b))
    .map((arch) => buildArch(version, date, arch));

  const probe = pickProbeEnv(version, date, arches);
  const firstArch = arches[0];
  const defaultRun = firstArch?.runs.find((r) => r.run_id === DEFAULT_RUN)
    ? DEFAULT_RUN
    : firstArch?.runs[0]?.run_id || DEFAULT_RUN;

  return {
    date,
    generated_at: probe?.generated_at || "",
    git_sha: probe?.git_sha || "",
    loadgen_version: probe?.loadgen_version || "",
    fabric: probe?.environment?.fabric || "",
    default_run: defaultRun,
    arches,
  };
}

// pickProbeEnv reads one env.json for the date's run-level provenance (all
// arches share it). Prefer x86_64, then arm64.
function pickProbeEnv(version, date, arches) {
  for (const arch of ["x86_64", "arm64"]) {
    const node = arches.find((a) => a.arch === arch);
    if (!node || !node.runs.length) continue;
    const runId = node.runs[0].run_id;
    try {
      return readJSON(join(runDir(root, version, date, arch, runId), "env.json"));
    } catch {
      // try next arch
    }
  }
  return null;
}

function buildVersion(version) {
  const dates = listDates(root, version)
    .sort(dateCmpDesc)
    .map((d) => buildDate(version, d));

  return {
    version,
    released_at: dates[0]?.generated_at || "",
    latest_date: dates[0]?.date || "",
    dates,
  };
}

function build() {
  const versions = listVersions(root).sort(versionCmpDesc).map(buildVersion);

  let latest = null;
  if (versions.length && versions[0].dates.length) {
    const v = versions[0];
    const d = v.dates[0];
    latest = { version: v.version, date: d.date, run_id: d.default_run };
  }

  const present = new Set();
  for (const v of versions)
    for (const d of v.dates) for (const a of d.arches) present.add(a.arch);
  const arches = ARCHES.filter((a) => present.has(a));

  return {
    schema_version: SCHEMA.index,
    updated_at: nowISO,
    latest,
    arches,
    versions,
  };
}

const index = build();
const outPath = join(root, "index.json");
writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n");
process.stderr.write(
  `update-index: wrote ${outPath} (${index.versions.length} version(s), latest=${
    index.latest ? `${index.latest.version}/${index.latest.date}/${index.latest.run_id}` : "none"
  })\n`,
);
