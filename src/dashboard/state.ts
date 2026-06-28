/**
 * Dashboard state: signals + URL deep-linking + lazy per-version payload loading.
 * The island is client-only, so `location` is always available here.
 */
import { signal, computed, effect } from "@preact/signals";
import type { VersionPayload } from "@results/types";
import { MANIFEST, celerisIds, CURATED_RIVALS } from "./registry";

export type ViewId =
  | "leaderboard"
  | "overtime"
  | "resources"
  | "matrix"
  | "versions"
  | "headtohead";

export const VIEWS: { id: ViewId; label: string }[] = [
  { id: "leaderboard", label: "Leaderboard" },
  { id: "overtime", label: "Over Time" },
  { id: "resources", label: "Resources" },
  { id: "matrix", label: "Matrix" },
  { id: "versions", label: "Versions" },
  { id: "headtohead", label: "Head-to-Head" },
];

/** Views driven by the selected scenario (the scenario picker applies). */
export const SCENARIO_VIEWS: ViewId[] = ["leaderboard", "overtime", "resources"];
/** Cross-cutting views that span scenarios/versions (scenario picker is secondary). */
export const OVERVIEW_VIEWS: ViewId[] = ["matrix", "versions", "headtohead"];

export function viewLabel(id: ViewId): string {
  return VIEWS.find((v) => v.id === id)?.label ?? id;
}

export type MetricId =
  | "saturation"
  | "slo"
  | "rated_p99"
  | "peak_rss"
  | "steady_rss"
  | "cpu"
  | "errors";

const hasWindow = typeof window !== "undefined";
const params = hasWindow ? new URLSearchParams(location.search) : new URLSearchParams();
const def = MANIFEST.default;

export const version = signal<string>(params.get("v") || def?.version || "");
export const arch = signal<string>(params.get("arch") || def?.arch || "x86_64");
export const view = signal<ViewId>((params.get("view") as ViewId) || "leaderboard");
export const scenario = signal<string>(params.get("scenario") || "");
export const metric = signal<MetricId>((params.get("metric") as MetricId) || "saturation");
export const slo = signal<string>(params.get("slo") || "1000");
export const opponent = signal<string>(params.get("vs") || "fasthttp-h1");
export const hovered = signal<string | null>(null);
export const showBand = signal<boolean>(params.get("band") !== "0");

const initialAdapters = params.get("adapters");
export const adapters = signal<string[]>(
  initialAdapters
    ? initialAdapters.split(",").filter(Boolean)
    : [...celerisIds().filter((id) => id !== "celeris-std-h1"), ...CURATED_RIVALS],
);

export const payload = signal<VersionPayload | null>(null);
export const loading = signal<boolean>(false);
export const loadError = signal<string | null>(null);

/** Transient toast message (e.g. "arm64 coming soon"). */
export const toast = signal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(msg: string, ms = 3200) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, ms);
}

export const hasData = MANIFEST.versions.some((v) => v.arches.length > 0);

export const versionsList = computed(() =>
  MANIFEST.versions.filter((v) => v.arches.length > 0).map((v) => v.version),
);

export const archesForVersion = computed(() => {
  const v = MANIFEST.versions.find((x) => x.version === version.value);
  return v ? v.arches.map((a) => a.arch) : [];
});

export const scenarios = computed(() => payload.value?.headline.scenarios ?? []);

const cache = new Map<string, VersionPayload>();

export async function loadPayload(v: string, a: string): Promise<void> {
  const key = `${v}/${a}`;
  if (cache.has(key)) {
    payload.value = cache.get(key)!;
    ensureScenario();
    return;
  }
  const vNode = MANIFEST.versions.find((x) => x.version === v);
  const aNode = vNode?.arches.find((x) => x.arch === a);
  if (!aNode) {
    payload.value = null;
    loadError.value = `No published run for ${v} / ${a}.`;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const res = await fetch(aNode.asset);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as VersionPayload;
    cache.set(key, data);
    payload.value = data;
    ensureScenario();
  } catch (e) {
    loadError.value = `Couldn't load ${v} / ${a}: ${(e as Error).message}`;
    payload.value = null;
  } finally {
    loading.value = false;
  }
}

// Default scenario on first load (deep-linked ?scenario= still wins); the rest are
// fallbacks if it's absent from a given dataset.
const PREFERRED_SCENARIOS = ["get-simple-1024c", "get-json", "get-simple", "get-json-1k", "driver-pg-read"];

function ensureScenario() {
  const list = payload.value?.headline.scenarios ?? [];
  if (!scenario.value || !list.includes(scenario.value)) {
    scenario.value = PREFERRED_SCENARIOS.find((s) => list.includes(s)) ?? list[0] ?? "";
  }
}

/** Pre-warm every version's payload (cheap) so the Versions trend can render. */
export async function warmAllVersions(): Promise<void> {
  await Promise.all(
    MANIFEST.versions.flatMap((v) =>
      v.arches
        .filter((a) => a.arch === arch.value)
        .map(async (a) => {
          const key = `${v.version}/${a.arch}`;
          if (cache.has(key)) return;
          try {
            const res = await fetch(a.asset);
            if (res.ok) cache.set(key, (await res.json()) as VersionPayload);
          } catch {
            /* ignore */
          }
        }),
    ),
  );
}

export function cachedPayload(v: string, a: string): VersionPayload | undefined {
  return cache.get(`${v}/${a}`);
}

let urlSyncStarted = false;
export function startUrlSync() {
  if (!hasWindow || urlSyncStarted) return;
  urlSyncStarted = true;
  effect(() => {
    const p = new URLSearchParams();
    p.set("v", version.value);
    p.set("arch", arch.value);
    p.set("view", view.value);
    if (scenario.value) p.set("scenario", scenario.value);
    p.set("metric", metric.value);
    if (metric.value === "slo") p.set("slo", slo.value);
    if (view.value === "headtohead") p.set("vs", opponent.value);
    if (!showBand.value) p.set("band", "0");
    p.set("adapters", adapters.value.join(","));
    const next = `${location.pathname}?${p.toString()}`;
    history.replaceState(null, "", next);
  });
}

export function toggleAdapter(id: string) {
  const cur = adapters.value;
  adapters.value = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

export function setAdapters(ids: string[]) {
  adapters.value = ids;
}
