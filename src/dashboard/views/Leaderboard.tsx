import { payload, scenario, adapters, metric, slo, hovered } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { BarList, type BarItem } from "../components/BarList";
import { METRICS, metricDef, metricValue, scenarioMetrics } from "../metrics";
import { adapterName, isCeleris, scenarioName } from "../registry";
import { fmtRps, fmtNsAsMs, fmtBytes, fmtPct, fmtInt, fmtDelta } from "../format";

export function Leaderboard() {
  const p = payload.value;
  const scn = scenario.value;
  if (!p || !scn) return <CenterNote>No scenario selected.</CenterNote>;

  const def = metricDef(metric.value);
  const sel = adapters.value.filter((id) => p.servers[id]);

  const items: BarItem[] = sel.map((id) => {
    const mv = metricValue(scenarioMetrics(p, id, scn), metric.value, slo.value);
    return { id, value: mv.value, status: mv.status };
  });

  // sort: best first (per metric polarity); valued before null
  items.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return def.lowerBetter ? a.value - b.value : b.value - a.value;
  });

  const max = Math.max(0, ...items.map((i) => i.value ?? 0));

  // best celeris value → Δ annotations
  const celBest = items
    .filter((i) => isCeleris(i.id) && i.value != null)
    .reduce<number | null>((acc, i) => (acc == null ? i.value! : def.lowerBetter ? Math.min(acc, i.value!) : Math.max(acc, i.value!)), null);
  if (celBest != null) {
    for (const it of items) {
      if (!isCeleris(it.id) && it.value != null) it.note = fmtDelta(celBest, it.value);
    }
  }

  const metricToolbar = (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
      <div class="seg">
        {METRICS.map((m) => (
          <button class={metric.value === m.id ? "active" : ""} onClick={() => (metric.value = m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {def.needsSlo && (
        <div class="seg" aria-label="SLO p99 bound">
          {["10", "50", "100", "500", "1000"].map((s) => (
            <button class={slo.value === s ? "active" : ""} onClick={() => (slo.value = s)}>
              {s}ms
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const hov = hovered.value;
  const detailId = hov && p.servers[hov] ? hov : items.find((i) => isCeleris(i.id))?.id ?? items[0]?.id;

  return (
    <div class="panel-grid" style={{ gridTemplateColumns: "1.7fr 1fr" }}>
      <Panel
        title={scenarioName(scn)}
        sub={`${def.label} · ${def.lowerBetter ? "lower is better" : "higher is better"} · ${sel.length} adapters`}
        actions={metricToolbar}
      >
        {items.length === 0 ? (
          <CenterNote>Select adapters in the rail to compare.</CenterNote>
        ) : (
          <BarList items={items} max={max} fmt={def.fmt} crownTop />
        )}
      </Panel>

      {detailId ? <DetailPanel server={detailId} scenario={scn} /> : <Panel title="Details"><CenterNote>Hover a row.</CenterNote></Panel>}
    </div>
  );
}

function DetailPanel({ server, scenario }: { server: string; scenario: string }) {
  const p = payload.value!;
  const m = scenarioMetrics(p, server, scenario);
  const rps = m?.saturation_rps;
  const rows: { k: string; v: string; sub?: string }[] = [];
  if (rps) {
    rows.push({ k: "Saturation RPS", v: fmtInt(rps.mean), sub: `±${rps.cv != null ? (rps.cv * 100).toFixed(1) : "0"}% · ${rps.n} run${rps.n === 1 ? "" : "s"}` });
    rows.push({ k: "Range", v: `${fmtRps(rps.min)} – ${fmtRps(rps.max)}` });
  }
  if (m?.rated_p99_ns) rows.push({ k: "Rated p99", v: fmtNsAsMs(m.rated_p99_ns.mean) });
  if (m?.latency_at_slo) {
    const ladder = Object.entries(m.latency_at_slo)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${k}ms→${fmtRps(v.mean)}`)
      .join("  ");
    rows.push({ k: "RPS @ SLO", v: ladder || "—" });
  }
  if (m?.resources?.peak_rss_bytes) rows.push({ k: "Peak RSS", v: fmtBytes(m.resources.peak_rss_bytes.mean) });
  if (m?.resources?.mean_cpu_pct) rows.push({ k: "Mean CPU", v: fmtPct(m.resources.mean_cpu_pct.mean) });
  if (m?.sent_vs_handled_delta_pct) rows.push({ k: "Error %", v: fmtPct(m.sent_vs_handled_delta_pct.mean, 3) });
  if (m?.connect_errors && m.connect_errors.mean > 0) rows.push({ k: "Connect errors", v: fmtInt(m.connect_errors.mean) });

  return (
    <Panel title={adapterName(server)} sub={m ? `status: ${m.status}` : "no data"}>
      {rows.length === 0 ? (
        <CenterNote>No measured metrics for this cell.</CenterNote>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {rows.map((r) => (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", borderBottom: "1px solid var(--border)", paddingBottom: "8px" }}>
              <span style={{ color: "var(--text-muted)" }}>{r.k}</span>
              <span class="tnum" style={{ textAlign: "right" }}>
                {r.v}
                {r.sub && <div class="panel-sub">{r.sub}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
