import { Fragment } from "preact";
import { payload } from "../state";
import { isCeleris, scenarioName } from "../registry";
import { fmtRps } from "../format";

export function HeadlineStrip() {
  const p = payload.value;
  if (!p) return <div class="headline" />;

  const scns = p.headline.scenarios;
  let wins = 0;
  for (const scn of scns) {
    const top = p.headline.top_by_scenario[scn];
    if (top && isCeleris(top.server)) wins++;
  }

  // Best celeris peak across scenarios.
  let peak = { scn: "", rps: 0 };
  for (const [scn, v] of Object.entries(p.headline.celeris.saturation_rps)) {
    if (v.mean > peak.rps) peak = { scn, rps: v.mean };
  }

  const stats: { n: string; l: string; key?: boolean; title?: string }[] = [
    { n: `${wins}/${scns.length}`, l: "scenarios won", key: true },
  ];
  if (peak.rps > 0) stats.push({ n: `${fmtRps(peak.rps)}`, l: "peak req/s", title: scenarioName(peak.scn) });
  stats.push({ n: String(p.meta.adapters), l: "servers" });
  stats.push({ n: String(p.meta.scenarios), l: "scenarios" });
  stats.push({ n: String(p.meta.runs_included), l: p.meta.runs_included === 1 ? "run averaged" : "runs averaged" });

  return (
    <div class="headline scroll-thin">
      {stats.map((s, i) => (
        <Fragment key={s.l}>
          {i > 0 && <span class="hl-div" />}
          <div class={`hstat${s.key ? " key" : ""}`} title={s.title}>
            <span class="hn">{s.n}</span>
            <span class="hl">{s.l}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
