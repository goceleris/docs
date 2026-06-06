// Shared helpers for the benchmarking storage scripts (Phase 4, #165/#166).
//
// The on-disk tree is the single source of truth. index.json is a derived
// cache; latest/ is a derived mirror. These helpers are the only place that
// knows how to read a published cell and project its headline numbers, so the
// migration script, the workflow's index updater, and the validator all agree.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const SCHEMA = {
  index: "index/1",
  histograms: "histograms/1",
  env: "env/1",
  timeseries: "timeseries/1",
  summaryMajor: "5", // report.Document SchemaVersion is "5.x" (currently 5.2)
};

// Locked arch vocabulary. Go's amd64 maps to x86_64 at the publish boundary.
export const ARCHES = ["x86_64", "arm64"];

// Legacy 3.0 marked celeris adaptive/iouring/epoll variants with this category;
// the canonical celeris headline picks the best server in this category.
export const CELERIS_CATEGORY = "celeris";
export const DEFAULT_RUN = "run-1";

export function resultsRoot(repoRoot) {
  return join(repoRoot, "results");
}

export function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// cellFile returns a forward-slash repo-root-relative path under results/ for a
// run-1 cell file, matching the manifest's "files" pointers.
export function cellFile(version, date, arch, name) {
  return posix.join("results", version, date, arch, name);
}

const VERSION_RE = /^v\d+\.\d+\.\d+/;
const DATE_RE = /^\d{8}$/;

export function listVersions(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_RE.test(e.name))
    .map((e) => e.name);
}

export function listDates(root, version) {
  const dir = join(root, version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .map((e) => e.name);
}

export function listArches(root, version, date) {
  const dir = join(root, version, date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ARCHES.includes(e.name))
    .map((e) => e.name);
}

// listRuns tolerates both the Phase 4 flat layout (four files directly under
// the arch dir as run-1) and a future Phase 5 run-N/ subdirectory layout,
// and the run-N-rated/ subdirectory a back-to-back rated pass publishes
// to alongside its saturation pass (see mage_tier.go's RatedRunIDSuffix).
// The regex accepts the rated suffix as an optional tail so the same
// walker can enumerate both panels of a back-to-back run.
export function listRuns(root, version, date, arch) {
  const dir = join(root, version, date, arch);
  if (!existsSync(dir)) return [];
  const subRuns = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^run-\d+(?:-rated)?$/.test(e.name))
    .map((e) => e.name);
  if (subRuns.length > 0) return subRuns.sort(runCmp);
  if (existsSync(join(dir, "summary.json"))) return [DEFAULT_RUN];
  return [];
}

// runDir is the directory that actually holds the four files for a run.
export function runDir(root, version, date, arch, runId) {
  const flat = join(root, version, date, arch);
  if (runId === DEFAULT_RUN && existsSync(join(flat, "summary.json"))) return flat;
  return join(flat, runId);
}

// runFilePath returns the repo-relative pointer used in the manifest "files".
export function runFilePath(version, date, arch, runId, name) {
  if (runId === DEFAULT_RUN) return cellFile(version, date, arch, name);
  return posix.join("results", version, date, arch, runId, name);
}

// runKey splits a run id into its numeric k and optional variant suffix
// ("run-2" -> [2, ""], "run-2-rated" -> [2, "rated"]). The numeric part
// sorts first so the canonical order is run-1, run-1-rated, run-2,
// run-2-rated, ...; the variant part breaks ties lexicographically, so
// a future variant (e.g. "run-1-soak") would naturally land after the
// rated one with no comparator change. Unknown shapes sort as 0/"" to
// keep the comparator total.
function runKey(r) {
  const m = /^run-(\d+)(?:-(.+))?$/.exec(r);
  if (!m) return [0, "", r];
  return [Number(m[1]), m[2] || "", r];
}

export function runCmp(a, b) {
  const [na, sa] = runKey(a);
  const [nb, sb] = runKey(b);
  if (na !== nb) return na - nb;
  return sa.localeCompare(sb);
}

// versionCmpDesc: semver, newest first; no-prerelease sorts ahead of prerelease.
export function versionCmpDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pb.nums[i] - pa.nums[i];
  }
  if (pa.pre === "" && pb.pre !== "") return -1;
  if (pa.pre !== "" && pb.pre === "") return 1;
  return pb.pre.localeCompare(pa.pre);
}

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(v);
  if (!m) return { nums: [0, 0, 0], pre: v };
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" };
}

// dateCmpDesc: yyyymmdd strings sort lexicographically; newest first.
export function dateCmpDesc(a, b) {
  return b.localeCompare(a);
}

// serverName extracts the adapter name from a ServerResult under either the
// v5.2 ("server") or migration ("name") key.
function serverName(sr) {
  return sr.server || sr.name;
}

// deriveHeadline projects the browse-without-fetch numbers from a summary
// document (report.Document with bulk fields stripped). It reads only the
// scalar maps that survive the split, so it never needs histograms or series.
export function deriveHeadline(summary) {
  const benchmarks = Array.isArray(summary.benchmarks) ? summary.benchmarks : [];

  const scenarioSet = new Set();
  for (const sr of benchmarks) {
    for (const sc of Object.keys(sr.saturation_mode_rps || {})) scenarioSet.add(sc);
  }
  const scenarios = [...scenarioSet].sort();

  // Winner per scenario across all adapters by saturation RPS.
  const topByScenario = {};
  for (const sc of scenarios) {
    let best = null;
    for (const sr of benchmarks) {
      const rps = (sr.saturation_mode_rps || {})[sc];
      if (typeof rps !== "number") continue;
      if (!best || rps > best.saturation_rps) {
        best = { server: serverName(sr), saturation_rps: rps };
      }
    }
    if (best) topByScenario[sc] = best;
  }

  // Celeris' own headline: best celeris-category adapter per scenario.
  const celServers = benchmarks.filter((b) => b.category === CELERIS_CATEGORY);
  const celeris = { saturation_rps: {}, latency_at_slo: {}, p99_ns_at_target: {} };
  for (const sc of scenarios) {
    let best = null;
    for (const sr of celServers) {
      const rps = (sr.saturation_mode_rps || {})[sc];
      if (typeof rps !== "number") continue;
      if (!best || rps > best.rps) best = { rps, sr };
    }
    if (!best) continue;
    celeris.saturation_rps[sc] = best.rps;
    const slo = normalizeSlo((best.sr.latency_at_slo || {})[sc]);
    if (slo != null) celeris.latency_at_slo[sc] = slo;
    const p99 = pickP99((best.sr.rated_mode_p99_at_target_rps || {})[sc]);
    if (p99 != null) celeris.p99_ns_at_target[sc] = p99;
  }

  return {
    adapters: benchmarks.length,
    scenarios,
    top_by_scenario: topByScenario,
    celeris,
  };
}

// latency_at_slo[scenario] maps an SLO p99 bound (milliseconds, as the producer
// emits it: {"10":rps,"50":rps,"100":rps,"500":rps,"1000":rps}) to the throughput
// sustained under that bound. Surface the whole map so the headline carries every
// measured SLO point — the producer never emits a 1ms bucket, so singling one out
// would either be empty or invent data.
function normalizeSlo(slo) {
  if (typeof slo === "number") return slo; // tolerate a flat scalar
  if (slo && typeof slo === "object" && Object.keys(slo).length) return slo;
  return null;
}

// rated_mode_p99_at_target[scenario] is p99 latency (ns) at the rated rate;
// tolerate a flat number, a {p99_ns}/{p99} object, or a {targetRps: p99_ns} map.
function pickP99(rated) {
  if (typeof rated === "number") return rated;
  if (rated && typeof rated === "object") {
    if (typeof rated.p99_ns === "number") return rated.p99_ns;
    if (typeof rated.p99 === "number") return rated.p99;
    const entries = Object.entries(rated).filter(([, v]) => typeof v === "number");
    if (entries.length) {
      entries.sort((a, b) => Number(b[0]) - Number(a[0]));
      return entries[0][1];
    }
  }
  return null;
}

// fileBytes returns sizes for the four cell files (0 when missing).
export function fileBytes(dir) {
  const out = {};
  for (const [key, name] of Object.entries({
    summary: "summary.json",
    timeseries: "timeseries.json.gz",
    histograms: "histograms.json.gz",
    env: "env.json",
  })) {
    const p = join(dir, name);
    out[key] = existsSync(p) ? statSync(p).size : 0;
  }
  return out;
}
