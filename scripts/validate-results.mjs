#!/usr/bin/env node
// validate-results.mjs — gate a published benchmark cell before indexing.
//
// The publisher (probatorium) commits the four split files directly. This
// validator is the docs side's contract check: it refuses to index a cell that
// is malformed, mislabeled, or inconsistent with its dispatch pointer. Exits
// non-zero on the first failure so the workflow aborts before touching
// index.json or latest/.
//
//   node scripts/validate-results.mjs --path results/v1.4.13/20260531/x86_64 \
//        [--version v1.4.13] [--arch x86_64] [--date 20260531] [--run run-1] \
//        [--repo <dir>]

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { SCHEMA, ARCHES } from "./lib/results.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const repoRoot = arg("--repo", process.cwd());
const relPath = arg("--path", null);
if (!relPath) hardFail("missing --path (e.g. results/v1.4.13/20260531/x86_64)");

const wantVersion = arg("--version", null);
const wantArch = arg("--arch", null);
const wantDate = arg("--date", null);
const wantRun = arg("--run", null);

const cellDir = isAbsolute(relPath) ? relPath : join(repoRoot, relPath);
const errors = [];

function hardFail(msg) {
  process.stderr.write(`validate-results: ${msg}\n`);
  process.exit(1);
}
function check(cond, msg) {
  if (!cond) errors.push(msg);
}

// 1. all four files exist
for (const f of ["summary.json", "timeseries.json.gz", "histograms.json.gz", "env.json"]) {
  check(existsSync(join(cellDir, f)), `missing required file: ${f}`);
}
if (errors.length) report();

// 2. summary.json parses and is a 5.x report.Document
let summary;
try {
  summary = JSON.parse(readFileSync(join(cellDir, "summary.json"), "utf8"));
} catch (e) {
  hardFail(`summary.json does not parse: ${e.message}`);
}
const sv = String(summary.schema_version || "");
check(
  sv === SCHEMA.summaryMajor || sv.startsWith(`${SCHEMA.summaryMajor}.`),
  `summary.json schema_version must be 5.x, got ${JSON.stringify(summary.schema_version)}`,
);
check(Array.isArray(summary.benchmarks), "summary.json benchmarks[] must be an array");
check(
  typeof summary.host_arch_pair === "string" && summary.host_arch_pair.includes("/"),
  "summary.json host_arch_pair must look like linux/amd64",
);

// 3. env.json parses and matches the dispatch pointer + the path tuple
let env;
try {
  env = JSON.parse(readFileSync(join(cellDir, "env.json"), "utf8"));
} catch (e) {
  hardFail(`env.json does not parse: ${e.message}`);
}
check(env.schema_version === SCHEMA.env, `env.json schema_version must be ${SCHEMA.env}`);
check(ARCHES.includes(env.arch), `env.json arch must be one of ${ARCHES.join(", ")}, got ${env.arch}`);
if (wantVersion) check(env.version === wantVersion, `env.version ${env.version} != payload ${wantVersion}`);
if (wantArch) check(env.arch === wantArch, `env.arch ${env.arch} != payload ${wantArch}`);
if (wantDate) check(env.date === wantDate, `env.date ${env.date} != payload ${wantDate}`);
if (wantRun) check(env.run_id === wantRun, `env.run_id ${env.run_id} != payload ${wantRun}`);

const parts = relPath.replace(/^results\//, "").replace(/\/$/, "").split("/");
if (parts.length >= 3) {
  const [pVer, pDate, pArch] = parts;
  check(env.version === pVer, `env.version ${env.version} != path ${pVer}`);
  check(env.date === pDate, `env.date ${env.date} != path ${pDate}`);
  check(env.arch === pArch, `env.arch ${env.arch} != path ${pArch}`);
  check(ARCHES.includes(pArch), `path arch ${pArch} not in canonical vocabulary`);
}

// 4. histograms.json.gz is valid gzip and a histograms/1 doc
try {
  const hist = JSON.parse(gunzipSync(readFileSync(join(cellDir, "histograms.json.gz"))).toString("utf8"));
  check(
    hist.schema_version === SCHEMA.histograms,
    `histograms.json.gz schema_version must be ${SCHEMA.histograms}, got ${hist.schema_version}`,
  );
  check(hist.histograms && typeof hist.histograms === "object", "histograms.json.gz histograms must be an object");
} catch (e) {
  errors.push(`histograms.json.gz is not valid gzip/JSON: ${e.message}`);
}

// 5. timeseries.json.gz is valid gzip and a timeseries/1 doc
try {
  const ts = JSON.parse(gunzipSync(readFileSync(join(cellDir, "timeseries.json.gz"))).toString("utf8"));
  check(
    ts.schema_version === SCHEMA.timeseries,
    `timeseries.json.gz schema_version must be ${SCHEMA.timeseries}, got ${ts.schema_version}`,
  );
} catch (e) {
  errors.push(`timeseries.json.gz is not valid gzip/JSON: ${e.message}`);
}

report();

function report() {
  if (errors.length) {
    for (const e of errors) process.stderr.write(`validate-results: FAIL ${e}\n`);
    process.exit(1);
  }
  process.stderr.write(`validate-results: OK ${relPath}\n`);
  process.exit(0);
}
