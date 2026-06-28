/** Build-time helpers for static pages (landing, etc.). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../data/generated/manifest.json";
import competitors from "../data/generated/competitors.json";
import type { CompetitorsRegistry, Manifest, VersionPayload } from "./results/types";

export const SITE_URL = process.env.SITE_URL || "https://goceleris.dev";

export interface HeroStat {
  version: string;
  peakRps: number;
  peakScenario: string;
  totalAdapters: number;
  /** Scenarios where Celeris is the fastest full Go framework, e.g. "39/43". */
  goWinRate: string;
  /** Median throughput lead over the next-fastest full Go framework, where Celeris wins. */
  goWinMarginPct: number | null;
  /** Maximum such lead (for an "up to +X%" stat). */
  goMaxMarginPct: number | null;
  /** Scenario where the maximum lead occurs. */
  goMaxMarginScenario: string;
}

/** Pull a headline stat from the default version's payload, or null when no data. */
export function heroStat(): HeroStat | null {
  const m = manifest as Manifest;
  if (!m.default) return null;
  const { version, arch } = m.default;
  try {
    const p = JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "v", version, `${arch}.json`), "utf8"),
    ) as VersionPayload;

    const reg = competitors as CompetitorsRegistry;
    const meta = (id: string) => reg.adapters[id];
    const isCel = (id: string) => meta(id)?.is_celeris ?? id.startsWith("celeris");
    // Compare Celeris only against full Go web frameworks (gin/echo/chi/iris/fiber/hertz) —
    // not low-level libs (gnet, fasthttp, nbio) or the stdlib, which aren't full frameworks.
    const isGoFramework = (id: string) =>
      meta(id)?.language === "go" && (isCel(id) || meta(id)?.kind === "framework");

    // Celeris' absolute peak throughput across scenarios (a capability number).
    let peak = { rps: 0, scn: "" };
    for (const [scn, v] of Object.entries(p.headline.celeris.saturation_rps)) {
      if (v.mean > peak.rps) peak = { rps: v.mean, scn };
    }

    // Competitive standing among full Go frameworks: per scenario, is the fastest Go
    // framework a Celeris engine, and by how much over the next-best full framework.
    const scns = p.headline.scenarios;
    let goWins = 0;
    let goTotal = 0;
    const goMargins: number[] = [];
    let maxMargin = { pct: 0, scn: "" };
    for (const scn of scns) {
      let bestGo = { id: "", v: 0 };
      let bestCel = 0;
      let bestRival = 0;
      for (const [id, sp] of Object.entries(p.servers)) {
        if (!isGoFramework(id)) continue;
        const v = sp.scenarios[scn]?.saturation_rps?.mean;
        if (v == null) continue;
        if (v > bestGo.v) bestGo = { id, v };
        if (isCel(id)) bestCel = Math.max(bestCel, v);
        else bestRival = Math.max(bestRival, v);
      }
      if (bestGo.v <= 0) continue;
      goTotal++;
      if (isCel(bestGo.id)) {
        goWins++;
        if (bestRival > 0 && bestCel > 0) {
          const mar = ((bestCel - bestRival) / bestRival) * 100;
          goMargins.push(mar);
          if (mar > maxMargin.pct) maxMargin = { pct: mar, scn };
        }
      }
    }
    goMargins.sort((a, b) => a - b);
    const medianMargin = goMargins.length ? goMargins[Math.floor(goMargins.length / 2)] : null;

    return {
      version,
      peakRps: Math.round(peak.rps),
      peakScenario: peak.scn,
      totalAdapters: p.meta.adapters,
      goWinRate: `${goWins}/${goTotal}`,
      goWinMarginPct: medianMargin != null ? Math.round(medianMargin) : null,
      goMaxMarginPct: maxMargin.scn ? Math.round(maxMargin.pct) : null,
      goMaxMarginScenario: maxMargin.scn,
    };
  } catch {
    return null;
  }
}

export interface HeroBar {
  /** Display label, e.g. "Celeris", "actix", "net/http". */
  name: string;
  rps: number;
  isCeleris: boolean;
  /** Language/ecosystem tag, e.g. "Go", "Rust". */
  lang?: string;
  /** Steady-state p99 latency (ms) under load, from the timeseries; null if absent. */
  p99?: number | null;
}

/**
 * Real per-framework throughput for the hero artifact: Celeris (best engine) vs
 * the top full Go framework rivals vs net/http, on a representative, well-
 * populated scenario where Celeris leads. All numbers come straight from the
 * default version's payload — nothing synthetic. Returns null when no data.
 */
export function heroBars(): { scenario: string; bars: HeroBar[] } | null {
  const m = manifest as Manifest;
  if (!m.default) return null;
  const { version, arch } = m.default;
  try {
    const p = JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "v", version, `${arch}.json`), "utf8"),
    ) as VersionPayload;
    const reg = competitors as CompetitorsRegistry;
    const meta = (id: string) => reg.adapters[id];
    const isCel = (id: string) => meta(id)?.is_celeris ?? id.startsWith("celeris");
    const isGoFramework = (id: string) =>
      meta(id)?.language === "go" && (isCel(id) || meta(id)?.kind === "framework");
    const rpsOf = (id: string, scn: string) => p.servers[id]?.scenarios[scn]?.saturation_rps?.mean ?? null;
    const NETHTTP = "stdhttp-h1";

    // Steady-state p99 latency (ms) from the timeseries band: median of the
    // back half of the per-second p99 series (skips the warm-up ramp).
    const ts = (p as unknown as { timeseries?: Record<string, { p99_ms?: { mean?: (number | null)[] } }> }).timeseries;
    const p99Of = (id: string, scn: string): number | null => {
      const arr = (ts?.[`${scn}|${id}`]?.p99_ms?.mean ?? []).filter(
        (v): v is number => v != null && Number.isFinite(v),
      );
      if (!arr.length) return null;
      const back = arr.slice(Math.floor(arr.length / 2)).sort((a, b) => a - b);
      return back[Math.floor(back.length / 2)];
    };

    // Choose the scenario that tells the clearest, highest-throughput story:
    // Celeris is the fastest, net/http is present, and at least two rival Go
    // frameworks have data — then maximise Celeris' absolute rps.
    let best: { scn: string; cel: number } | null = null;
    for (const scn of p.headline.scenarios) {
      let cel = 0;
      let rivals = 0;
      let topRival = 0;
      for (const [id, sp] of Object.entries(p.servers)) {
        if (!isGoFramework(id)) continue;
        const v = sp.scenarios[scn]?.saturation_rps?.mean;
        if (v == null) continue;
        if (isCel(id)) cel = Math.max(cel, v);
        else {
          rivals++;
          topRival = Math.max(topRival, v);
        }
      }
      if (cel <= 0 || cel <= topRival || rivals < 2) continue; // Celeris must lead
      if (rpsOf(NETHTTP, scn) == null) continue; // net/http baseline present
      if (!best || cel > best.cel) best = { scn, cel };
    }
    if (!best) return null;
    const scn = best.scn;

    // Celeris (best engine) vs a recognizable cross-language field: the fastest
    // C/C++ servers (lithium, h2o), the fast exotics (actix/drogon), the best
    // Java framework (netty), popular Go (fiber/gin), and the mainstream Python/
    // Node names everyone knows (FastAPI/Express). Celeris still tops them all —
    // beating even the hand-tuned C/C++ libraries is the point of the chart.
    const celRps = best.cel;
    // The specific Celeris engine that achieved the peak — used for its timeseries.
    let celId = "";
    for (const [id, sp] of Object.entries(p.servers)) {
      if (!isCel(id)) continue;
      const v = sp.scenarios[scn]?.saturation_rps?.mean;
      if (v != null && Math.round(v) === Math.round(celRps)) celId = id;
    }
    const CURATED = [
      { id: "lithium", name: "lithium", lang: "C++" },
      { id: "h2o", name: "h2o", lang: "C" },
      { id: "actix", name: "actix", lang: "Rust" },
      { id: "drogon", name: "drogon", lang: "C++" },
      { id: "netty", name: "netty", lang: "Java" },
      { id: "fiber-h1", name: "fiber", lang: "Go" },
      { id: "gin-h1", name: "gin", lang: "Go" },
      { id: "fastapi", name: "FastAPI", lang: "Python" },
      { id: "express", name: "Express", lang: "Node" },
    ];
    const rivals = CURATED
      .filter((r) => rpsOf(r.id, scn) != null)
      .map((r) => ({ name: r.name, lang: r.lang, rps: Math.round(rpsOf(r.id, scn) as number), p99: p99Of(r.id, scn) }));

    const bars: HeroBar[] = [
      { name: "Celeris", lang: "Go", rps: Math.round(celRps), isCeleris: true, p99: p99Of(celId, scn) },
      ...rivals.map((r) => ({ name: r.name, lang: r.lang, rps: r.rps, isCeleris: false, p99: r.p99 })),
      { name: "net/http", lang: "Go", rps: Math.round(rpsOf(NETHTTP, scn) as number), isCeleris: false, p99: p99Of(NETHTTP, scn) },
    ].sort((a, b) => b.rps - a.rps);

    return { scenario: scn, bars };
  } catch {
    return null;
  }
}

export function fmtMs(ms: number): string {
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function fmtRpsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
