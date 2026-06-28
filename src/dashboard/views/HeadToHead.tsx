import { payload, opponent } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { adapterColor, adapterName, adapterShort, isCeleris, scenarioName } from "../registry";
import { fmtRps, fmtDelta } from "../format";

/** Celeris (best variant per scenario) vs one rival across all scenarios. */
export function HeadToHead() {
  const p = payload.value;
  if (!p) return <CenterNote>No data.</CenterNote>;

  const rivals = Object.keys(p.servers).filter((id) => !isCeleris(id)).sort();
  const opp = rivals.includes(opponent.value) ? opponent.value : rivals[0];
  if (!opp) return <CenterNote>No rival adapters available.</CenterNote>;

  const scns = p.headline.scenarios;
  const rows = scns
    .map((scn) => {
      const cel = p.headline.celeris.saturation_rps[scn];
      const rival = p.servers[opp]?.scenarios[scn]?.saturation_rps?.mean ?? null;
      return { scn, celServer: cel?.server, cel: cel?.mean ?? null, rival };
    })
    .filter((r) => r.cel != null || r.rival != null);

  const oppColor = adapterColor(opp);
  const celColor = "var(--accent)";

  let wins = 0;
  let losses = 0;
  for (const r of rows) {
    if (r.cel != null && r.rival != null) r.cel >= r.rival ? wins++ : losses++;
  }

  return (
    <Panel
      title="Head-to-Head"
      sub={`Celeris (best engine per scenario) vs ${adapterName(opp)} — wins ${wins} · trails ${losses}`}
      actions={
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <span class="panel-sub">vs</span>
          <select class="control" value={opp} onChange={(e) => (opponent.value = (e.target as HTMLSelectElement).value)}>
            {rivals.map((r) => (
              <option value={r}>{adapterShort(r)}</option>
            ))}
          </select>
        </label>
      }
    >
      <div class="h2h">
        <div class="h2h-legend">
          <span><i style={{ background: "var(--accent)" }} /> Celeris</span>
          <span><i style={{ background: oppColor }} /> {adapterShort(opp)}</span>
        </div>
        {rows.map((r) => {
          const max = Math.max(r.cel ?? 0, r.rival ?? 0) || 1;
          const lw = r.cel != null ? (r.cel / max) * 100 : 0;
          const rw = r.rival != null ? (r.rival / max) * 100 : 0;
          const win = r.cel != null && r.rival != null && r.cel >= r.rival;
          return (
            <div class="h2h-row">
              <div class="h2h-left">
                <span class="h2h-v">{r.cel != null ? fmtRps(r.cel) : "—"}</span>
                <span class="h2h-bar l"><span style={{ width: `${lw}%`, background: celColor }} /></span>
              </div>
              <div class="h2h-mid">
                <div class="h2h-scn">{scenarioName(r.scn)}</div>
                {r.cel != null && r.rival != null && (
                  <div class={`h2h-delta ${win ? "up" : "down"}`}>{fmtDelta(r.cel, r.rival)}</div>
                )}
              </div>
              <div class="h2h-right">
                <span class="h2h-bar r"><span style={{ width: `${rw}%`, background: oppColor }} /></span>
                <span class="h2h-v">{r.rival != null ? fmtRps(r.rival) : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
      <style>{`
        .h2h { display: flex; flex-direction: column; gap: 8px; }
        .h2h-legend { display: flex; gap: 16px; font-size: var(--fs-3xs); color: var(--text-muted); margin-bottom: 6px; }
        .h2h-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
        .h2h-row { display: grid; grid-template-columns: 1fr 150px 1fr; align-items: center; gap: 10px; font-size: var(--fs-2xs); }
        .h2h-left { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
        .h2h-right { display: flex; align-items: center; gap: 8px; }
        .h2h-v { font-variant-numeric: tabular-nums; color: var(--text-muted); min-width: 48px; }
        .h2h-left .h2h-v { text-align: right; }
        .h2h-bar { position: relative; height: 16px; flex: 1; background: var(--surface-3); border-radius: var(--r-xs); overflow: hidden; }
        .h2h-bar span { position: absolute; top: 0; bottom: 0; border-radius: var(--r-xs); }
        .h2h-bar.l span { right: 0; }
        .h2h-bar.r span { left: 0; }
        .h2h-mid { text-align: center; }
        .h2h-scn { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .h2h-delta { font-weight: 600; font-variant-numeric: tabular-nums; }
        .h2h-delta.up { color: var(--accent-bright); }
        .h2h-delta.down { color: var(--text-faint); }
      `}</style>
    </Panel>
  );
}
