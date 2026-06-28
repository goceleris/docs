import { payload, scenario, adapters, hovered } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { adapterShort, isCeleris, scenarioName, scenarioMeta } from "../registry";
import { scenarioMetrics } from "../metrics";
import { fmtRps } from "../format";
import { Crown } from "../components/Icons";

/** Adapters × scenarios dominance heatmap, per-column normalized on saturation RPS. */
export function Matrix() {
  const p = payload.value;
  if (!p) return <CenterNote>No data.</CenterNote>;

  const scns = p.headline.scenarios;
  const rows = adapters.value.filter((id) => p.servers[id]);
  rows.sort((a, b) => (isCeleris(a) === isCeleris(b) ? a.localeCompare(b) : isCeleris(a) ? -1 : 1));

  // per-column max for normalization + leader
  const colMax: Record<string, number> = {};
  const colLeader: Record<string, string> = {};
  for (const scn of scns) {
    let mx = 0;
    let leader = "";
    for (const id of rows) {
      const v = scenarioMetrics(p, id, scn)?.saturation_rps?.mean;
      if (v != null && v > mx) {
        mx = v;
        leader = id;
      }
    }
    colMax[scn] = mx;
    colLeader[scn] = leader;
  }

  const hov = hovered.value;

  return (
    <Panel title="Dominance matrix" sub="saturation RPS, shaded per column — brighter is faster; the column leader is crowned" nopad>
      <div class="scroll-thin" style={{ overflow: "auto", height: "100%" }}>
        <table class="matrix">
          <thead>
            <tr>
              <th class="corner">adapter \ scenario</th>
              {scns.map((scn) => (
                <th
                  class="col-h"
                  title={scenarioName(scn)}
                  onClick={() => (scenario.value = scn)}
                >
                  <span class="rot">{scenarioMeta(scn)?.display_name ?? scn}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => (
              <tr
                class={hov === id ? "hl" : ""}
                onMouseEnter={() => (hovered.value = id)}
                onMouseLeave={() => (hovered.value = null)}
              >
                <th class={`row-h${isCeleris(id) ? " celeris" : ""}`}>{adapterShort(id)}</th>
                {scns.map((scn) => {
                  const m = scenarioMetrics(p, id, scn);
                  const v = m?.saturation_rps?.mean;
                  const st = m?.status ?? "not_applicable";
                  if (v == null) {
                    return (
                      <td class="cell">
                        <span class={`glyph ${st}`}>{st === "dnf" ? "×" : st === "not_applicable" ? "" : ""}</span>
                      </td>
                    );
                  }
                  const norm = colMax[scn] ? v / colMax[scn] : 0;
                  const leader = colLeader[scn] === id;
                  return (
                    <td
                      class={`cell${isCeleris(id) ? " cel" : ""}`}
                      title={`${adapterShort(id)} · ${scenarioName(scn)}: ${fmtRps(v)} rps`}
                      style={{ background: `color-mix(in oklch, var(--accent) ${Math.round(norm * 78)}%, transparent)` }}
                    >
                      {leader && <Crown s={12} class="crown" style={{ color: "var(--accent-bright)" }} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        .matrix { border-collapse: collapse; font-size: var(--fs-3xs); }
        .matrix th, .matrix td { border: 1px solid var(--border); }
        .matrix .corner { position: sticky; left: 0; top: 0; z-index: 3; background: var(--surface-2); padding: 4px 8px; text-align: left; color: var(--text-faint); }
        .matrix thead th.col-h { height: 116px; vertical-align: bottom; background: var(--surface-1); position: sticky; top: 0; z-index: 2; cursor: pointer; padding: 4px; }
        .matrix .rot { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; color: var(--text-muted); max-height: 108px; overflow: hidden; }
        .matrix th.col-h:hover .rot { color: var(--accent-text); }
        .matrix tbody th.row-h { position: sticky; left: 0; z-index: 1; background: var(--surface-1); text-align: left; padding: 3px 8px; white-space: nowrap; color: var(--text-muted); }
        .matrix tbody th.row-h.celeris { color: var(--accent-text); }
        .matrix tr.hl td, .matrix tr.hl th.row-h { outline: 1px solid var(--border-strong); }
        .matrix td.cell { width: 30px; height: 26px; text-align: center; position: relative; }
        .matrix td.cell.cel { box-shadow: inset 0 0 0 1px var(--border-accent); }
        .matrix .crown { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
        .matrix .glyph.not_applicable { display: block; width: 100%; height: 100%; background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, var(--border) 4px, var(--border) 5px); }
        .matrix .glyph.dnf { color: var(--danger); font-weight: 700; }
      `}</style>
    </Panel>
  );
}
