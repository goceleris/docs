#!/usr/bin/env bun
/**
 * build-data — transform the results/ tree into compact dashboard assets.
 *
 * Walks results/ directly (the on-disk tree is the single source of truth),
 * validates + loads each cell, averages all runs per (version, arch), and emits:
 *   src/data/generated/manifest.json      — versions/arches/provenance + default
 *   src/data/generated/competitors.json   — adapter registry (id -> meta + color)
 *   src/data/generated/scenarios.json     — scenario registry (id -> taxonomy)
 *   public/data/v/<version>/<arch>.json   — per-version aggregated payload
 *
 * Never crashes on empty/partial/malformed data: bad cells are skipped (warned),
 * and an empty tree yields valid empty assets. Run with --validate-only to gate
 * a publish without emitting (exits non-zero if any cell fails validation).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  resultsRoot,
  listVersions,
  listDates,
  listArches,
  listRuns,
  versionCmpDesc,
  dateCmpDesc,
  ARCHES,
} from "../src/lib/results/walk";
import { loadCell } from "../src/lib/results/load";
import { aggregateVersionArch, DEFAULT_AGG_OPTS } from "../src/lib/results/aggregate";
import { buildAdapterMeta, buildScenarioMeta, serverName, LANGUAGES, CATEGORY_META } from "../src/lib/results/taxonomy";
import type {
  AdapterMeta,
  CompetitorsRegistry,
  LoadedCell,
  Manifest,
  ManifestArch,
  ManifestVersion,
  ProvenanceEntry,
  ScenarioMeta,
  ScenarioRegistry,
} from "../src/lib/results/types";

const CONFIG = {
  /** Runs shorter than this (ns) are smoke tests, excluded from averaging by default. */
  minDurationNs: 30_000_000_000,
  includeSmoke: process.env.BUILD_INCLUDE_SMOKE === "1",
  tsMaxPoints: DEFAULT_AGG_OPTS.tsMaxPoints,
  tsMinFraction: DEFAULT_AGG_OPTS.tsMinFraction,
};

const validateOnly = process.argv.includes("--validate-only");
const repoRoot = process.cwd();
// RESULTS_ROOT overrides the results/ source (used by the demo-fixture flow and
// tests); otherwise read the committed results/ tree.
const root = process.env.RESULTS_ROOT ? resolve(process.env.RESULTS_ROOT) : resultsRoot(repoRoot);

const SRC_DATA = join(repoRoot, "src", "data", "generated");
const PUB_DATA = join(repoRoot, "public", "data");

let warnings = 0;
let validationErrors = 0;
function warn(msg: string) {
  warnings++;
  process.stderr.write(`build-data: WARN ${msg}\n`);
}

function writeJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function nowISO(): string {
  return new Date().toISOString();
}

function build() {
  // Clear derived outputs up front so removed versions/arches never linger.
  if (!validateOnly && existsSync(join(PUB_DATA, "v"))) {
    rmSync(join(PUB_DATA, "v"), { recursive: true, force: true });
  }

  const versions = listVersions(root).sort(versionCmpDesc);

  const adapters = new Map<string, AdapterMeta>();
  const scenarios = new Map<string, ScenarioMeta>();
  const manifestVersions: ManifestVersion[] = [];

  for (const version of versions) {
    const dates = listDates(root, version).sort(dateCmpDesc);
    const perArch: Record<string, LoadedCell[]> = {};
    const excludedPerArch: Record<string, number> = {};
    const provenance: ProvenanceEntry[] = [];

    for (const date of dates) {
      for (const arch of listArches(root, version, date)) {
        for (const runId of listRuns(root, version, date, arch)) {
          const { cell, errors, warnings: w } = loadCell(
            root,
            { version, date, arch, runId },
            { minDurationNs: CONFIG.minDurationNs },
          );
          for (const e of errors) {
            warn(`${version}/${date}/${arch}/${runId}: ${e}`);
            validationErrors++;
          }
          for (const m of w) warn(`${version}/${date}/${arch}/${runId}: ${m}`);
          if (!cell) {
            provenance.push(prov(version, date, arch, runId, 0, "excluded:invalid"));
            excludedPerArch[arch] = (excludedPerArch[arch] || 0) + 1;
            continue;
          }
          if (cell.smoke && !CONFIG.includeSmoke) {
            provenance.push(prov(version, date, arch, runId, cell.durationNs, "excluded:smoke"));
            excludedPerArch[arch] = (excludedPerArch[arch] || 0) + 1;
            continue;
          }
          (perArch[arch] ||= []).push(cell);
          provenance.push(prov(version, date, arch, runId, cell.durationNs, "included"));
          // register taxonomy
          for (const sr of cell.summary.benchmarks) {
            const id = serverName(sr);
            if (!adapters.has(id)) adapters.set(id, buildAdapterMeta(sr));
            for (const scn of Object.keys(sr.saturation_mode_rps || {})) {
              if (!scenarios.has(scn)) scenarios.set(scn, buildScenarioMeta(scn));
            }
            for (const scn of Object.keys(sr.cell_statuses || {})) {
              if (!scenarios.has(scn)) scenarios.set(scn, buildScenarioMeta(scn));
            }
          }
        }
      }
    }

    const archesEmitted: ManifestArch[] = [];
    for (const arch of ARCHES) {
      const cells = perArch[arch];
      if (!cells || !cells.length) continue;
      const payload = aggregateVersionArch(version, arch, cells, excludedPerArch[arch] || 0, CONFIG);
      const rel = `/data/v/${version}/${arch}.json`;
      const abs = join(PUB_DATA, "v", version, `${arch}.json`);
      let bytes = 0;
      if (!validateOnly) {
        const str = JSON.stringify(payload);
        bytes = Buffer.byteLength(str);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, str);
      }
      archesEmitted.push({
        arch,
        asset: rel,
        adapters: payload.meta.adapters,
        scenarios: payload.meta.scenarios,
        runs_included: payload.meta.runs_included,
        runs_excluded: payload.meta.runs_excluded,
        dates: payload.meta.dates,
        has_timeseries: payload.meta.has_timeseries,
        has_resources: payload.meta.has_resources,
        bytes,
      });
    }

    if (archesEmitted.length) {
      const probe = perArch[archesEmitted[0].arch][0];
      manifestVersions.push({
        version,
        latest_date: dates[0] || "",
        released_at: probe?.env.generated_at || probe?.summary.benchmark_config?.finished_at || "",
        flags: [],
        arches: archesEmitted,
        provenance,
      });
    } else if (provenance.length) {
      // version had only excluded (e.g. smoke) runs — record it as smoke_only for the UI
      manifestVersions.push({
        version,
        latest_date: dates[0] || "",
        released_at: "",
        flags: ["no_full_runs"],
        arches: [],
        provenance,
      });
    }
  }

  const archesPresent = ARCHES.filter((a) =>
    manifestVersions.some((v) => v.arches.some((x) => x.arch === a)),
  );
  const firstWithData = manifestVersions.find((v) => v.arches.length);
  const manifest: Manifest = {
    schema_version: "dashboard-manifest/1",
    generated_at: nowISO(),
    default: firstWithData
      ? {
          version: firstWithData.version,
          arch: (firstWithData.arches.find((a) => a.arch === "x86_64") || firstWithData.arches[0]).arch,
        }
      : null,
    arches: archesPresent,
    versions: manifestVersions,
  };

  const competitors: CompetitorsRegistry = {
    schema_version: "competitors/1",
    adapters: Object.fromEntries([...adapters].sort(([a], [b]) => a.localeCompare(b))),
    languages: LANGUAGES,
  };

  const scenarioRegistry: ScenarioRegistry = {
    schema_version: "scenarios/1",
    scenarios: Object.fromEntries([...scenarios].sort(([a], [b]) => a.localeCompare(b))),
    categories: CATEGORY_META,
  };

  if (validateOnly) {
    process.stderr.write(
      `build-data: validate-only — ${manifest.versions.length} version(s), ${validationErrors} validation error(s), ${warnings} warning(s)\n`,
    );
    process.exit(validationErrors > 0 ? 1 : 0);
  }

  writeJSON(join(SRC_DATA, "manifest.json"), manifest);
  writeJSON(join(SRC_DATA, "competitors.json"), competitors);
  writeJSON(join(SRC_DATA, "scenarios.json"), scenarioRegistry);

  process.stderr.write(
    `build-data: ${manifest.versions.length} version(s), ${adapters.size} adapter(s), ${scenarios.size} scenario(s), ` +
      `default=${manifest.default ? `${manifest.default.version}/${manifest.default.arch}` : "none"}, ${warnings} warning(s)\n`,
  );
}

function prov(
  version: string,
  date: string,
  arch: string,
  runId: string,
  durationNs: number,
  disposition: string,
): ProvenanceEntry {
  return { date, run_id: runId, arch, git_sha: version, duration_ns: durationNs, disposition };
}

build();
