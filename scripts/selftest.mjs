#!/usr/bin/env node
// selftest.mjs — end-to-end ingest contract test.
//
// Copies a fixture cell (a real split produced by probatorium `mage Publish`)
// into a throwaway repo root, then runs the real pipeline against it:
//   validate-results -> update-index -> refresh-latest
// and asserts the manifest + latest/ mirror come out right.
//
// This guards the producer<->consumer contract end to end: required files,
// schema versions, the index/latest derivation, and the headline projection.
// A regression like a renamed summary field, a changed file set, or a broken
// "latest" computation fails here instead of silently shipping an empty index.
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptsDir, "..", "test", "fixtures", "cell");
const VER = "v1.4.14";
const DATE = "20260604";
const ARCH = "x86_64";
const RUN = "run-1";
const cellRel = `results/${VER}/${DATE}/${ARCH}`;

const tmp = mkdtempSync(join(tmpdir(), "results-selftest-"));
let failed = false;
try {
  const cellAbs = join(tmp, cellRel);
  mkdirSync(cellAbs, { recursive: true });
  for (const f of ["summary.json", "env.json", "histograms.json.gz", "timeseries.json.gz"]) {
    copyFileSync(join(fixtureDir, f), join(cellAbs, f));
  }

  const run = (script, args) => {
    const r = spawnSync("node", [join(scriptsDir, script), ...args], { cwd: tmp, encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) process.stdout.write(`  [${script}] ${out}\n`);
    if (r.status !== 0) throw new Error(`${script} exited with status ${r.status}`);
  };

  // Mirror the dispatch payload the docs workflow passes through to validate.
  run("validate-results.mjs", [
    "--path", cellRel,
    "--version", VER, "--arch", ARCH, "--date", DATE, "--run", RUN,
  ]);
  run("update-index.mjs", []);
  run("refresh-latest.mjs", []);

  const idx = JSON.parse(readFileSync(join(tmp, "results", "index.json"), "utf8"));
  const assert = (cond, msg) => {
    if (cond) {
      console.log("  ok:", msg);
    } else {
      console.error("  FAIL:", msg);
      failed = true;
    }
  };

  assert(idx.latest && idx.latest.version === VER, `index.latest.version == ${VER}`);
  assert(idx.latest && idx.latest.run_id === RUN, `index.latest.run_id == ${RUN}`);
  assert(Array.isArray(idx.versions) && idx.versions.some((v) => v.version === VER), `versions[] contains ${VER}`);
  assert(Array.isArray(idx.arches) && idx.arches.includes(ARCH), `arches[] contains ${ARCH}`);
  const run0 = idx.versions?.[0]?.dates?.[0]?.arches?.[0]?.runs?.[0];
  assert(run0 && run0.headline && run0.headline.adapters > 0, "headline.adapters > 0");
  assert(run0 && run0.files && run0.files.summary && run0.files.timeseries, "run.files references all artifacts");
  assert(existsSync(join(tmp, "results", "latest", ARCH, "summary.json")), `latest/${ARCH}/summary.json mirrored`);
  assert(existsSync(join(tmp, "results", "latest", ARCH, "env.json")), `latest/${ARCH}/env.json mirrored`);
} catch (e) {
  console.error("  ERROR:", e.message);
  failed = true;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error("selftest: FAILED");
  process.exit(1);
}
console.log("selftest: OK");
