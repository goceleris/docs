/**
 * results/ tree enumeration + ordering. Typed, self-contained reimplementation
 * of the (now-deleted) scripts/lib/results.mjs walker — the on-disk tree is the
 * single source of truth, so the site build walks it directly rather than
 * trusting any derived manifest.
 *
 * Layout: results/<version>/<yyyymmdd>/<arch>/[run-N[-variant]/]{the 4 files}
 * with a flat run-1 (files directly under <arch>/) supported for back-compat.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Canonical arch vocabulary. Go's amd64 maps to x86_64 at the publish boundary. */
export const ARCHES = ["x86_64", "arm64"] as const;
export type Arch = (typeof ARCHES)[number];

export const CELERIS_CATEGORY = "celeris";
export const DEFAULT_RUN = "run-1";

const VERSION_RE = /^v\d+\.\d+\.\d+/;
const DATE_RE = /^\d{8}$/;
const RUN_RE = /^run-\d+(?:-[a-z]+)?$/;

export function resultsRoot(repoRoot: string): string {
  return join(repoRoot, "results");
}

export function listVersions(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_RE.test(e.name))
    .map((e) => e.name);
}

export function listDates(root: string, version: string): string[] {
  const dir = join(root, version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .map((e) => e.name);
}

export function listArches(root: string, version: string, date: string): string[] {
  const dir = join(root, version, date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (ARCHES as readonly string[]).includes(e.name))
    .map((e) => e.name);
}

/**
 * listRuns tolerates the flat layout (four files directly under <arch>/ as run-1)
 * and run-N/ + run-N-variant/ subdirectories (e.g. run-2-rated). Returns canonical
 * sorted order.
 */
export function listRuns(root: string, version: string, date: string, arch: string): string[] {
  const dir = join(root, version, date, arch);
  if (!existsSync(dir)) return [];
  const subRuns = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_RE.test(e.name))
    .map((e) => e.name);
  if (subRuns.length > 0) return subRuns.sort(runCmp);
  if (existsSync(join(dir, "summary.json"))) return [DEFAULT_RUN];
  return [];
}

/** The directory that actually holds the four files for a run. */
export function runDir(root: string, version: string, date: string, arch: string, runId: string): string {
  const flat = join(root, version, date, arch);
  if (runId === DEFAULT_RUN && existsSync(join(flat, "summary.json"))) return flat;
  return join(flat, runId);
}

function runKey(r: string): [number, string] {
  const m = /^run-(\d+)(?:-(.+))?$/.exec(r);
  if (!m) return [0, r];
  return [Number(m[1]), m[2] || ""];
}

/** run-1, run-1-rated, run-2, run-10 … (numeric first, variant tie-break). */
export function runCmp(a: string, b: string): number {
  const [na, sa] = runKey(a);
  const [nb, sb] = runKey(b);
  if (na !== nb) return na - nb;
  return sa.localeCompare(sb);
}

interface Semver {
  nums: [number, number, number];
  pre: string;
}

function parseSemver(v: string): Semver {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(v);
  if (!m) return { nums: [0, 0, 0], pre: v };
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" };
}

/** Semver, newest first; a release sorts ahead of its prereleases. */
export function versionCmpDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pb.nums[i] - pa.nums[i];
  }
  if (pa.pre === "" && pb.pre !== "") return -1;
  if (pa.pre !== "" && pb.pre === "") return 1;
  return pb.pre.localeCompare(pa.pre);
}

/** yyyymmdd strings, newest first. */
export function dateCmpDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
