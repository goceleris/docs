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

  const Sep = () => <span class="hl-sep">·</span>;

  return (
    <div class="headline scroll-thin">
      <span class="lead">
        Celeris is fastest in <span class="hl-num">{wins}</span>/<span class="hl-num">{scns.length}</span> scenarios
      </span>
      {peak.rps > 0 && (
        <>
          <Sep />
          <span class="hl-chip">
            peak <span class="hl-num">{fmtRps(peak.rps)}</span> rps
            <span style={{ color: "var(--text-faint)" }}> ({scenarioName(peak.scn)})</span>
          </span>
        </>
      )}
      <Sep />
      <span class="hl-chip">
        avg of <span class="hl-num">{p.meta.runs_included}</span> run{p.meta.runs_included === 1 ? "" : "s"}
      </span>
      <Sep />
      <span class="hl-chip">
        <span class="hl-num">{p.meta.adapters}</span> adapters
      </span>
      <Sep />
      <span class="hl-chip">
        <span class="hl-num">{p.meta.scenarios}</span> scenarios
      </span>
    </div>
  );
}
