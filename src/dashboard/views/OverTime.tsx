import type uPlot from "uplot";
import { payload, scenario, adapters } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import UplotChart, { axisDefaults } from "../charts/UplotChart";
import { adapterColor, adapterShort, isCeleris, scenarioName } from "../registry";
import { fmtRps } from "../format";
import type { TimeseriesAgg } from "@results/types";

/** Linear-interpolate (x0,y0) onto target xs; null outside the source range. */
function interp(x0: number[], y0: number[], xs: number[]): (number | null)[] {
  if (!x0.length) return xs.map(() => null);
  return xs.map((x) => {
    if (x < x0[0] || x > x0[x0.length - 1]) return null;
    let i = 1;
    while (i < x0.length && x0[i] < x) i++;
    const a = i - 1;
    const b = Math.min(i, x0.length - 1);
    if (a === b) return y0[a];
    const t = (x - x0[a]) / (x0[b] - x0[a]);
    return y0[a] + (y0[b] - y0[a]) * t;
  });
}

interface SeriesPick {
  id: string;
  ts: TimeseriesAgg;
}

export function OverTime() {
  const p = payload.value;
  const scn = scenario.value;
  if (!p || !scn) return <CenterNote>No scenario selected.</CenterNote>;

  const found: SeriesPick[] = adapters.value
    .map((id) => ({ id, ts: p.timeseries[`${scn}|${id}`] }))
    .filter((x): x is SeriesPick => !!x.ts);

  if (!found.length) {
    return (
      <Panel title={`Over time · ${scenarioName(scn)}`}>
        <CenterNote>
          <h2>No time-series for this selection</h2>
          <p>This run didn't capture per-second samples for the selected adapters &amp; scenario.</p>
        </CenterNote>
      </Panel>
    );
  }

  // Draw rivals first, celeris last → celeris lines render on top.
  const picks = [...found].sort((a, b) => Number(isCeleris(a.id)) - Number(isCeleris(b.id)));

  // Reference x = longest grid among picks.
  const ref = picks.reduce((a, b) => (b.ts.t_grid.length > a.ts.t_grid.length ? b : a));
  const xs = ref.ts.t_grid;
  const multiRun = picks.some((s) => s.ts.n_runs > 1);

  const seriesFor = (sel: (t: TimeseriesAgg) => number[]) =>
    picks.map((s) => interp(s.ts.t_grid, sel(s.ts), xs));

  const rpsData = [xs, ...seriesFor((t) => t.rps.mean)] as uPlot.AlignedData;
  const p99Data = [xs, ...seriesFor((t) => t.p99_ms.mean)] as uPlot.AlignedData;
  const errData = [xs, ...seriesFor((t) => t.errors.mean)] as uPlot.AlignedData;

  const lineSeries = (): uPlot.Series[] =>
    picks.map((s) => {
      const c = adapterColor(s.id);
      const cel = isCeleris(s.id);
      return {
        label: adapterShort(s.id),
        stroke: cel ? c : `${c}9c`, // dim rivals so celeris stands out
        width: cel ? 2.4 : 1.25,
        points: { show: false },
      } as uPlot.Series;
    });

  const ax = axisDefaults();
  const baseOpts = (yFmt: (v: number) => string): Omit<uPlot.Options, "width" | "height"> => ({
    scales: {
      x: { time: false },
      // Baseline at 0 (honest for throughput/latency) and avoid uPlot's auto-range
      // occasionally clamping above the data when many series share a near-flat plateau.
      y: { range: (_u, _min, max) => [0, (max && max > 0 ? max : 1) * 1.05] },
    },
    legend: { show: false },
    cursor: { points: { size: 6 } },
    axes: [
      { ...ax } as uPlot.Axis,
      { ...ax, size: 56, values: (_u, vals) => vals.map((v) => yFmt(v)) } as uPlot.Axis,
    ],
    series: [{ label: "t" }, ...lineSeries()],
  });

  return (
    <Panel
      title={`Over time · ${scenarioName(scn)}`}
      sub={`per-second mean over a ${Math.round(p.meta.duration_ns / 1e9)}s run · ${multiRun ? `${picks[0].ts.n_runs} runs` : "single run"} · ${picks.length} adapters`}
      nopad
      style={{ height: "100%" }}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ flex: 1, display: "grid", gridTemplateRows: "1fr 1fr 0.8fr", gap: "2px", minHeight: 0 }}>
          <ChartBlock title="Requests / sec" data={rpsData} opts={baseOpts(fmtRps)} />
          <ChartBlock title="p99 latency (ms)" data={p99Data} opts={baseOpts((v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)))} />
          <ChartBlock title="Errors / sec" data={errData} opts={baseOpts((v) => `${Math.round(v)}`)} />
        </div>
        <Legend picks={picks} />
      </div>
    </Panel>
  );
}

function ChartBlock({ title, data, opts }: { title: string; data: uPlot.AlignedData; opts: Omit<uPlot.Options, "width" | "height"> }) {
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0, borderBottom: "1px solid var(--border)" }}>
      <div class="panel-sub" style={{ padding: "4px 10px" }}>{title}</div>
      <UplotChart data={data} options={opts} />
    </div>
  );
}

function Legend({ picks }: { picks: SeriesPick[] }) {
  // Celeris first in the legend for readability (even though drawn last).
  const ordered = [...picks].sort((a, b) => Number(isCeleris(b.id)) - Number(isCeleris(a.id)));
  return (
    <div class="legend" style={{ padding: "8px 12px" }}>
      {ordered.map((s) => (
        <span class="lg">
          <span class="swatch" style={{ background: adapterColor(s.id) }} />
          {adapterShort(s.id)}
        </span>
      ))}
    </div>
  );
}
