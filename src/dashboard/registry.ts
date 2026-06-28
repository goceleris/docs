/**
 * Static registries (bundled at build) + helpers. The per-version payloads are
 * fetched lazily at runtime (see state.ts); these small maps are always present.
 */
import competitors from "@data/generated/competitors.json";
import scenariosReg from "@data/generated/scenarios.json";
import manifest from "@data/generated/manifest.json";
import type {
  AdapterMeta,
  CompetitorsRegistry,
  Manifest,
  ScenarioMeta,
  ScenarioRegistry,
} from "@results/types";

export const COMPETITORS = competitors as CompetitorsRegistry;
export const SCENARIOS = scenariosReg as ScenarioRegistry;
export const MANIFEST = manifest as Manifest;

const FALLBACK = "#8b949e";

export function adapter(id: string): AdapterMeta | undefined {
  return COMPETITORS.adapters[id];
}

export function adapterColor(id: string): string {
  return COMPETITORS.adapters[id]?.color ?? FALLBACK;
}

export function adapterName(id: string): string {
  return COMPETITORS.adapters[id]?.display_name ?? id;
}

export function adapterShort(id: string): string {
  return COMPETITORS.adapters[id]?.short_name ?? id;
}

export function isCeleris(id: string): boolean {
  return COMPETITORS.adapters[id]?.is_celeris ?? id.startsWith("celeris");
}

export function scenarioMeta(id: string): ScenarioMeta | undefined {
  return SCENARIOS.scenarios[id];
}

export function scenarioName(id: string): string {
  return SCENARIOS.scenarios[id]?.display_name ?? id;
}

/** All celeris adapter ids, brand order. */
export function celerisIds(): string[] {
  return Object.values(COMPETITORS.adapters)
    .filter((a) => a.is_celeris)
    .map((a) => a.id)
    .sort();
}

/** Curated default rival set (used as the initial adapter selection). */
export const CURATED_RIVALS = [
  "actix",
  "ntex",
  "drogon",
  "lithium",
  "h2o",
  "uws",
];
