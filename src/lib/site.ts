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

export function fmtRpsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
