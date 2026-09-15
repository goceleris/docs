/**
 * Load + validate a single benchmark cell from disk. Never throws on bad input:
 * a malformed summary returns null (cell skipped); a corrupt/optional timeseries
 * degrades to null while the cell's scalars are still used.
 *
 * `errors` is the publish gate's channel: the lenient build only warns about
 * them, while `build-data --validate-only` exits non-zero if any cell reported
 * one. A cell can therefore be returned AND carry errors (mislabelled env) —
 * the site keeps rendering what it always rendered, the gate goes red.
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { LoadedCell, RawEnv, RawSummary, RawTimeseries } from "./types";
import { runDir } from "./walk";
import { validateEnv, validateSummary, validateTimeseriesDoc, type CellExpect } from "./validate";

export interface LoadResult {
  cell: LoadedCell | null;
  errors: string[];
  warnings: string[];
}

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readGzJSON<T>(path: string): T {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T;
}

/** Smoke runs (short duration) are excluded from averaging by default. */
export function isSmoke(durationNs: number, minNs: number): boolean {
  return durationNs > 0 && durationNs < minNs;
}

export function loadCell(
  root: string,
  expect: CellExpect,
  opts: { minDurationNs: number },
): LoadResult {
  const dir = runDir(root, expect.version, expect.date, expect.arch, expect.runId);
  const errors: string[] = [];
  const warnings: string[] = [];

  const summaryPath = join(dir, "summary.json");
  if (!existsSync(summaryPath)) {
    return { cell: null, errors: [`missing summary.json in ${dir}`], warnings };
  }

  let summary: RawSummary;
  try {
    summary = readJSON<RawSummary>(summaryPath);
  } catch (e) {
    return { cell: null, errors: [`summary.json parse failed: ${(e as Error).message}`], warnings };
  }

  const summaryErrs = validateSummary(summary);
  if (summaryErrs.length) {
    return { cell: null, errors: summaryErrs, warnings };
  }

  // env.json is optional: absent or unparseable is a warning and the cell still
  // loads from the summary. But a *present and parseable* env.json that
  // disagrees with its own path (env says arm64, path says x86_64) is a
  // mislabelled cell — the exact corruption that had to be scrubbed by hand in
  // d3424f4 — so validateEnv's findings are errors, which is what makes
  // `--validate-only` reject them.
  let env: RawEnv = { schema_version: "env/1" };
  try {
    if (existsSync(join(dir, "env.json"))) {
      env = readJSON<RawEnv>(join(dir, "env.json"));
      errors.push(...validateEnv(env, expect));
    } else warnings.push("env.json missing; using config from summary");
  } catch (e) {
    warnings.push(`env.json parse failed: ${(e as Error).message}`);
  }

  let timeseries: RawTimeseries | null = null;
  const tsPath = join(dir, "timeseries.json.gz");
  if (existsSync(tsPath)) {
    try {
      const doc = readGzJSON<RawTimeseries>(tsPath);
      const tsErrs = validateTimeseriesDoc(doc);
      if (tsErrs.length) warnings.push(...tsErrs);
      else timeseries = doc;
    } catch (e) {
      warnings.push(`timeseries.json.gz decode failed: ${(e as Error).message}`);
    }
  } else {
    warnings.push("timeseries.json.gz missing");
  }

  const cfg = summary.benchmark_config || env.benchmark_config || {};
  const durationNs = Number(cfg.duration || 0);

  const cell: LoadedCell = {
    version: expect.version,
    date: expect.date,
    arch: expect.arch,
    runId: expect.runId,
    dir,
    summary,
    env,
    timeseries,
    durationNs,
    smoke: isSmoke(durationNs, opts.minDurationNs),
  };
  return { cell, errors, warnings };
}
