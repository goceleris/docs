/**
 * Cell validation — the contract checks the build runs on every cell it reads,
 * absorbing the gate the deleted scripts/validate-results.mjs used to enforce at
 * publish time. Pure functions returning error strings; callers decide whether a
 * failure skips the cell (build) or aborts (publish-time `--validate-only`).
 */
import type { RawEnv, RawSummary } from "./types";
import { ARCHES } from "./walk";

const SUMMARY_MAJOR = "5";
const ENV_SCHEMA = "env/1";
const TIMESERIES_SCHEMA = "timeseries/1";
const HISTOGRAMS_SCHEMA = "histograms/1";

export interface CellExpect {
  version: string;
  date: string;
  arch: string;
  runId: string;
}

export function validateSummary(summary: unknown): string[] {
  const errs: string[] = [];
  const s = summary as RawSummary | null;
  if (!s || typeof s !== "object") return ["summary.json is not an object"];
  const sv = String(s.schema_version ?? "");
  if (sv !== SUMMARY_MAJOR && !sv.startsWith(`${SUMMARY_MAJOR}.`)) {
    errs.push(`summary schema_version must be ${SUMMARY_MAJOR}.x, got ${JSON.stringify(s.schema_version)}`);
  }
  if (!Array.isArray(s.benchmarks)) {
    errs.push("summary benchmarks[] must be an array");
  }
  if (typeof s.host_arch_pair !== "string" || !s.host_arch_pair.includes("/")) {
    errs.push("summary host_arch_pair must look like linux/amd64");
  }
  return errs;
}

export function validateEnv(env: unknown, expect: CellExpect): string[] {
  const errs: string[] = [];
  const e = env as RawEnv | null;
  if (!e || typeof e !== "object") return ["env.json is not an object"];
  if (e.schema_version !== ENV_SCHEMA) {
    errs.push(`env schema_version must be ${ENV_SCHEMA}, got ${JSON.stringify(e.schema_version)}`);
  }
  if (e.arch && !(ARCHES as readonly string[]).includes(e.arch)) {
    errs.push(`env arch must be one of ${ARCHES.join(", ")}, got ${e.arch}`);
  }
  if (e.version && e.version !== expect.version) errs.push(`env version ${e.version} != path ${expect.version}`);
  if (e.date && e.date !== expect.date) errs.push(`env date ${e.date} != path ${expect.date}`);
  if (e.arch && e.arch !== expect.arch) errs.push(`env arch ${e.arch} != path ${expect.arch}`);
  return errs;
}

export function validateTimeseriesDoc(ts: unknown): string[] {
  const d = ts as { schema_version?: string; scenarios?: unknown };
  if (!d || typeof d !== "object") return ["timeseries is not an object"];
  if (d.schema_version !== TIMESERIES_SCHEMA) {
    return [`timeseries schema_version must be ${TIMESERIES_SCHEMA}, got ${JSON.stringify(d.schema_version)}`];
  }
  if (!Array.isArray(d.scenarios)) return ["timeseries scenarios[] must be an array"];
  return [];
}

export function validateHistogramsDoc(h: unknown): string[] {
  const d = h as { schema_version?: string; histograms?: unknown };
  if (!d || typeof d !== "object") return ["histograms is not an object"];
  if (d.schema_version !== HISTOGRAMS_SCHEMA) {
    return [`histograms schema_version must be ${HISTOGRAMS_SCHEMA}, got ${JSON.stringify(d.schema_version)}`];
  }
  return [];
}
