import { payload, scenario, adapters, metric, slo, hovered } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { BarList, type BarItem } from "../components/BarList";
import { METRICS, metricDef, metricValue, scenarioMetrics } from "../metrics";
import { adapterName, adapterColor, isCeleris, scenarioName } from "../registry";
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

  const ts = p.timeseries?.[`${scenario}|${server}`];
  const sparkValid = (ts?.rps?.mean ?? []).filter((v): v is number => v != null && Number.isFinite(v));

  return (
    <Panel title={adapterName(server)} sub={m ? `status: ${m.status}` : "no data"}>
      {ts && sparkValid.length > 1 && (
        <div class="spark-wrap">
          <div class="spark-head">
            <span>throughput · {ts.window_s ? `${Math.round(ts.window_s)}s run` : "over the run"}</span>
            <span class="tnum">{ts.n_runs ? `${ts.n_runs} run${ts.n_runs === 1 ? "" : "s"}` : ""}</span>
          </div>
          <Sparkline data={ts.rps.mean} color={adapterColor(server)} />
        </div>
      )}
      {rows.length === 0 ? (
        <CenterNote>No measured metrics for this cell.</CenterNote>
      ) : (
        <div class="kv">
          {rows.map((r) => (
            <div class="kv-row">
              <span class="kv-k">{r.k}</span>
              <span class="kv-v tnum">
                {r.v}
                {r.sub && <span class="kv-sub">{r.sub}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Tiny throughput-over-the-run sparkline (area + line), no deps. */
function Sparkline({ data, color }: { data: (number | null)[]; color: string }) {
  const W = 100;
  const H = 30;
  const valid = data
    .map((v, i) => [i, v] as const)
    .filter((e): e is [number, number] => e[1] != null && Number.isFinite(e[1] as number));
  if (valid.length < 2) return null;
  const ys = valid.map((e) => e[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const range = max - min || 1;
  const n = data.length - 1 || 1;
  const pts = valid.map(([i, v]) => [(i / n) * W, H - ((v - min) / range) * (H - 3) - 1.5] as [number, number]);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z`;
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} style={{ fill: `color-mix(in oklch, ${color} 16%, transparent)`, stroke: "none" }} />
      <path
        d={line}
        vector-effect="non-scaling-stroke"
        style={{ fill: "none", stroke: color, strokeWidth: 1.6, strokeLinejoin: "round", strokeLinecap: "round" }}
      />
    </svg>
  );
}
