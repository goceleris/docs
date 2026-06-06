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
  writeFileSync,
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

  const run = (script, args, cwd = tmp) => {
    const r = spawnSync("node", [join(scriptsDir, script), ...args], { cwd, encoding: "utf8" });
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

  // ---- Back-to-back + rated subdirs (see mage_tier.go's RatedRunIDSuffix) ----
  // A second self-test cell tree that mirrors a real 3-pass saturation +
  // 3-pass rated back-to-back run. The single-cell fixture above
  // validates the flat (run-1) layout; this one validates the
  // sibling run-K/ + run-K-rated/ subdirs coexist, get enumerated
  // individually in the index, and that default_run still resolves
  // to run-1 (the saturation pass, not a rated subdir).
  const multiTmp = mkdtempSync(join(tmpdir(), "results-selftest-multi-"));
  try {
    const multiRel = `results/${VER}/${DATE}/${ARCH}`;
    const multiAbs = join(multiTmp, multiRel);
    // Saturation subdirs (run-2, run-3) — copy the fixture and re-stamp
    // env.run_id so validate-results.mjs accepts each cell against its
    // own dispatch payload. The fixture's env carries run-1; every
    // subdir needs its own id.
    for (const k of [2, 3]) {
      const subAbs = join(multiAbs, `run-${k}`);
      mkdirSync(subAbs, { recursive: true });
      for (const f of ["summary.json", "histograms.json.gz", "timeseries.json.gz"]) {
        copyFileSync(join(fixtureDir, f), join(subAbs, f));
      }
      const envRaw = JSON.parse(readFileSync(join(fixtureDir, "env.json"), "utf8"));
      envRaw.run_id = `run-${k}`;
      writeFileSync(join(subAbs, "env.json"), JSON.stringify(envRaw));
    }
    // Rated subdirs (run-2-rated, run-3-rated) — same shape with the
    // rated suffix; the producer's env.run_id is the full rated id.
    for (const k of [2, 3]) {
      const subAbs = join(multiAbs, `run-${k}-rated`);
      mkdirSync(subAbs, { recursive: true });
      for (const f of ["summary.json", "histograms.json.gz", "timeseries.json.gz"]) {
        copyFileSync(join(fixtureDir, f), join(subAbs, f));
      }
      const envRaw = JSON.parse(readFileSync(join(fixtureDir, "env.json"), "utf8"));
      envRaw.run_id = `run-${k}-rated`;
      writeFileSync(join(subAbs, "env.json"), JSON.stringify(envRaw));
    }

    // Validate each cell against its dispatch payload. The selftest's
    // single-cell case ships --run; for the rated pass we re-stamp env
    // to match. We use the multiTmp cwd (not the single-cell tmp) so
    // the relative --path resolves against the right tree.
    for (const k of [2, 3]) {
      run("validate-results.mjs", [
        "--path", `${multiRel}/run-${k}`,
        "--version", VER, "--arch", ARCH, "--date", DATE, "--run", `run-${k}`,
      ], multiTmp);
      run("validate-results.mjs", [
        "--path", `${multiRel}/run-${k}-rated`,
        "--version", VER, "--arch", ARCH, "--date", DATE, "--run", `run-${k}-rated`,
      ], multiTmp);
    }
    run("update-index.mjs", [], multiTmp);

    const multiIdx = JSON.parse(readFileSync(join(multiTmp, "results", "index.json"), "utf8"));
    const multiRuns = multiIdx.versions?.[0]?.dates?.[0]?.arches?.[0]?.runs || [];
    const runIds = multiRuns.map((r) => r.run_id);
    assert(
      JSON.stringify(runIds) === JSON.stringify(["run-2", "run-2-rated", "run-3", "run-3-rated"]),
      `runs enumerated in sorted order: ${JSON.stringify(runIds)}`,
    );
    assert(
      multiIdx.versions?.[0]?.dates?.[0]?.default_run === "run-2",
      `default_run still picks the lowest run-K when run-1 absent, got ${multiIdx.versions?.[0]?.dates?.[0]?.default_run}`,
    );
    // The rated subdirs each carry their own files pointers, distinct
    // from the saturation subdirs (proves the rated pass didn't
    // overwrite the saturation grid at run-K).
    const ratedFiles = multiRuns.find((r) => r.run_id === "run-2-rated")?.files || {};
    assert(
      ratedFiles.summary && ratedFiles.summary.endsWith("/run-2-rated/summary.json"),
      `rated subdir files pointer stays in run-2-rated/, got ${ratedFiles.summary}`,
    );
  } catch (e) {
    console.error("  ERROR (multi-run):", e.message);
    failed = true;
  } finally {
    rmSync(multiTmp, { recursive: true, force: true });
  }
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
