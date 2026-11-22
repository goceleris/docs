/**
 * The tie rule of a composed cell (tools/mergedocs). A composed cell holds two
 * dispatches of one architecture: the candidate dispatch (celeris, its v1.5.11
 * twin and the drift anchors) and the frameworks dispatch. Celeris counts as
 * ahead of a framework measured in the OTHER dispatch only when its margin
 * exceeds the tie margin of that scenario (the largest drift any anchor showed
 * on it, floored at 5 %); against a framework of its own dispatch the 5 % band
 * holds. Without composition.json (every single-dispatch cell) nothing here
 * applies and a win is a strict maximum, as before.
 */
import type { RawComposition, VersionPayload } from "./types";

export const TIE_FLOOR = 0.05;
const CANDIDATE = "candidate";

/** The margin celeris must exceed over `rivalId` on `scn`. */
export function rivalMargin(comp: RawComposition, scn: string, rivalId: string): number {
  const floor = comp.tie_floor || TIE_FLOOR;
  if (comp.columns[rivalId] === CANDIDATE) return floor;
  // other dispatch (or a column the composition does not list: never assume the best case)
  const m = comp.tie_margin_by_scenario[scn];
  if (typeof m === "number" && Number.isFinite(m)) return Math.max(floor, m);
  return Math.max(floor, ...Object.values(comp.tie_margin_by_scenario));
}

export type Standing = "ahead" | "tie" | "behind";

/**
 * Celeris' standing on one scenario: `celeris` is its best rate, `rivals` the
 * rates of the full Go frameworks. Ahead only if it clears every rival by that
 * rival's margin; behind if some rival clears celeris by its margin; else a tie.
 */
export function standing(
  comp: RawComposition | null | undefined,
  scn: string,
  celeris: number,
  rivals: { id: string; v: number }[],
): Standing {
  if (!comp) {
    // legacy: strict maximum
    return rivals.every((r) => celeris > r.v) ? "ahead" : "behind";
  }
  let ahead = true;
  for (const r of rivals) {
    const m = rivalMargin(comp, scn, r.id);
    if (r.v > celeris * (1 + m)) return "behind";
    if (!(celeris > r.v * (1 + m))) ahead = false;
  }
  return ahead ? "ahead" : "tie";
}

/** Plain-language lines for the page: the drift figures of one architecture. */
export function describeComposition(c: RawComposition): string[] {
  const margins = Object.values(c.tie_margin_by_scenario);
  const lo = margins.length ? Math.min(...margins) : c.tie_floor;
  const hi = margins.length ? Math.max(...margins) : c.tie_floor;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `Measured in two dispatches ${c.gap_hours_between_dispatches.toFixed(1)} h apart. Celeris, its v1.5.11 twin and ${Object.keys(c.anchors).length} drift anchors ran in the first; the other frameworks and the same anchors ran in the second.`,
    `Anchor drift between the dispatches: up to ${pct(c.max_anchor_drift)}. Against a framework from the other dispatch celeris counts as ahead only beyond a per-scenario margin of ${pct(lo)} to ${pct(hi)}; otherwise it is a tie. Against its own dispatch the ${pct(c.tie_floor)} band holds.`,
  ];
  if (c.reboot.between_dispatches) {
    lines.push(c.reboot.note || "The test host rebooted between the two dispatches.");
  }
  if (c.drift_warning) lines.push("An anchor drifted by more than 15% between the dispatches: cross-dispatch comparisons are weak.");
  return lines;
}

/**
 * Per scenario of a payload: is celeris the fastest full Go framework (win), in
 * the tie band (composed cells only) or not. `margins` are the percent leads of
 * the wins over the best rival; `total` counts scenarios with any Go data.
 */
export function goTally(
  p: VersionPayload,
  isGoFramework: (id: string) => boolean,
  isCel: (id: string) => boolean,
): { wins: number; ties: number; total: number; margins: number[]; maxMargin: { pct: number; scn: string } } {
  let wins = 0;
  let ties = 0;
  let total = 0;
  const margins: number[] = [];
  let maxMargin = { pct: 0, scn: "" };
  for (const scn of p.headline.scenarios) {
    let any = 0;
    let bestCel = 0;
    let bestRival = 0;
    const rivals: { id: string; v: number }[] = [];
    for (const [id, sp] of Object.entries(p.servers)) {
      if (!isGoFramework(id)) continue;
      const v = sp.scenarios[scn]?.saturation_rps?.mean;
      if (v == null) continue;
      any = Math.max(any, v);
      if (isCel(id)) bestCel = Math.max(bestCel, v);
      else {
        bestRival = Math.max(bestRival, v);
        rivals.push({ id, v });
      }
    }
    if (any <= 0) continue;
    total++;
    const st = standing(p.composition, scn, bestCel, rivals);
    if (st === "tie") {
      ties++;
      continue;
    }
    if (st !== "ahead") continue;
    wins++;
    if (bestRival > 0 && bestCel > 0) {
      const mar = ((bestCel - bestRival) / bestRival) * 100;
      margins.push(mar);
      if (mar > maxMargin.pct) maxMargin = { pct: mar, scn };
    }
  }
  return { wins, ties, total, margins, maxMargin };
}
