import type uPlot from "uplot";
import { payload, scenario, adapters } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { BarList, type BarItem } from "../components/BarList";
import UplotChart, { axisDefaults } from "../charts/UplotChart";
import { adapterColor, adapterShort, isCeleris, scenarioName } from "../registry";
import { fmtRps, fmtNsAsMs } from "../format";
import { scenarioMetrics } from "../metrics";

const SLO_BOUNDS = [10, 50, 100, 500, 1000];

export function Latency() {
  const p = payload.value;
  const scn = scenario.value;
  if (!p || !scn) return <CenterNote>No scenario selected.</CenterNote>;

  const sel = adapters.value.filter((id) => p.servers[id]);

  // SLO curve data
  const curveSeries: uPlot.Series[] = [{ label: "slo" }];
  const ys: (number | null)[][] = [];
  for (const id of sel) {
    const m = scenarioMetrics(p, id, scn);
    if (!m?.latency_at_slo) continue;
    const y = SLO_BOUNDS.map((b) => m.latency_at_slo?.[String(b)]?.mean ?? null);
    if (y.every((v) => v == null)) continue;
    ys.push(y);
    curveSeries.push({
      label: adapterShort(id),
      stroke: adapterColor(id),
      width: isCeleris(id) ? 2.4 : 1.4,
      points: { show: true, size: 5 },
    });
  }
  const ax = axisDefaults();
  const curveData = [SLO_BOUNDS, ...ys] as uPlot.AlignedData;
  const curveOpts: Omit<uPlot.Options, "width" | "height"> = {
    scales: { x: { distr: 3, time: false } },
    legend: { show: false },
    axes: [
      {
        ...ax,
        splits: () => SLO_BOUNDS,
        values: (_u, vals) => vals.map((v) => (v != null ? `${v}ms` : "")),
      } as uPlot.Axis,
      { ...ax, values: (_u, vals) => vals.map((v) => (v != null ? fmtRps(v) : "")) } as uPlot.Axis,
    ],
    series: curveSeries,
  };

  // rated p99 bars (lower better)
  const ratedItems: BarItem[] = sel.map((id) => {
    const m = scenarioMetrics(p, id, scn);
    return { id, value: m?.rated_p99_ns?.mean ?? null, status: m?.status ?? "not_applicable" };
  });
  ratedItems.sort((a, b) => {
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return a.value - b.value;
  });
  const ratedMax = Math.max(0, ...ratedItems.map((i) => i.value ?? 0));

  return (
    <div class="panel-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
      <Panel title={`Throughput under SLO · ${scenarioName(scn)}`} sub="max RPS sustained while p99 ≤ bound (higher & flatter is better)">
        {ys.length === 0 ? (
          <CenterNote>No latency-at-SLO data captured for this scenario.</CenterNote>
        ) : (
          <div style={{ height: "100%", minHeight: "320px" }}>
            <UplotChart data={curveData} options={curveOpts} />
          </div>
        )}
      </Panel>
      <Panel title="Rated p99 latency" sub="lower is better · tail at the rated rate">
        {ratedItems.every((i) => i.value == null) ? (
          <CenterNote>No rated-mode data for this scenario.</CenterNote>
        ) : (
          <BarList items={ratedItems} max={ratedMax} fmt={(n) => fmtNsAsMs(n)} crownTop />
        )}
      </Panel>
    </div>
  );
}
