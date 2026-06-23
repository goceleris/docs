import { useEffect, useState } from "preact/hooks";
import type uPlot from "uplot";
import { arch, scenario, versionsList, warmAllVersions, cachedPayload, payload } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import UplotChart, { axisDefaults } from "../charts/UplotChart";
import { celerisIds, adapterColor, adapterShort, scenarioName } from "../registry";
import { fmtRps } from "../format";

export function Versions() {
  const [, force] = useState(0);
  useEffect(() => {
    void warmAllVersions().then(() => force((n) => n + 1));
  }, [arch.value]);

  const scn = scenario.value;
  // ascending order for a left→right trend
  const versions = [...versionsList.value].reverse();
  if (versions.length < 2) {
    return (
      <Panel title="Version trend">
        <CenterNote>
          <h2>Trend appears with a second version</h2>
          <p>Once another celeris version is published, this charts throughput across releases.</p>
        </CenterNote>
      </Panel>
    );
  }

  const cels = celerisIds();
  const xs = versions.map((_, i) => i);
  const series: uPlot.Series[] = [{ label: "version" }];
  const ys: (number | null)[][] = [];
  for (const id of cels) {
    const y = versions.map((v) => cachedPayload(v, arch.value)?.servers[id]?.scenarios[scn]?.saturation_rps?.mean ?? null);
    if (y.every((v) => v == null)) continue;
    ys.push(y);
    series.push({ label: adapterShort(id), stroke: adapterColor(id), width: 2.2, points: { show: true, size: 6 } });
  }

  const ax = axisDefaults();
  const data = [xs, ...ys] as uPlot.AlignedData;
  const opts: Omit<uPlot.Options, "width" | "height"> = {
    scales: { x: { time: false } },
    legend: { show: false },
    axes: [
      { ...ax, values: (_u, vals) => vals.map((v) => versions[v] ?? "") } as uPlot.Axis,
      { ...ax, values: (_u, vals) => vals.map((v) => fmtRps(v)) } as uPlot.Axis,
    ],
    series,
  };

  return (
    <Panel
      title={`Version trend · ${scenarioName(scn)}`}
      sub={`saturation RPS across releases (${arch.value})`}
    >
      {ys.length === 0 ? (
        <CenterNote>No celeris data for this scenario across versions.</CenterNote>
      ) : (
        <div style={{ height: "100%", minHeight: "340px" }}>
          <UplotChart data={data} options={opts} />
        </div>
      )}
      {void payload.value}
    </Panel>
  );
}
