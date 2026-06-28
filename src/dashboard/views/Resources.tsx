import { payload, scenario, adapters } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { BarList, type BarItem } from "../components/BarList";
import { scenarioMetrics } from "../metrics";
import { fmtBytes, fmtPct, fmtRps } from "../format";
import { scenarioName } from "../registry";

export function Resources() {
  const p = payload.value;
  const scn = scenario.value;
  if (!p || !scn) return <CenterNote>No scenario selected.</CenterNote>;

  if (!p.meta.has_resources) {
    return (
      <Panel title={`Resources · ${scenarioName(scn)}`}>
        <CenterNote>
          <h2>Resource sampling not in this run</h2>
          <p>
            This run didn't capture RSS / CPU / GC metrics. Throughput and latency are available now
            under the other tabs.
          </p>
        </CenterNote>
      </Panel>
    );
  }

  const sel = adapters.value.filter((id) => p.servers[id]);
  const bar = (sel2: (s: ReturnType<typeof scenarioMetrics>) => number | null | undefined): BarItem[] =>
    sel.map((id) => {
      const m = scenarioMetrics(p, id, scn);
      return { id, value: sel2(m) ?? null, status: m?.status ?? "not_applicable" };
    });

  const peak = sortAsc(bar((m) => m?.resources?.peak_rss_bytes?.mean));
  const cpu = sortAsc(bar((m) => m?.resources?.mean_cpu_pct?.mean));
  const eff = sortDesc(
    sel.map((id) => {
      const m = scenarioMetrics(p, id, scn);
      const rps = m?.saturation_rps?.mean;
      const rss = m?.resources?.steady_rss_bytes?.mean;
      const v = rps != null && rss ? rps / (rss / (1024 * 1024)) : null;
      return { id, value: v, status: m?.status ?? "not_applicable" } as BarItem;
    }),
  );

  return (
    <div class="panel-grid" style={{ gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" }}>
      <Panel title="Peak RSS" sub="lower is better">
        <BarList items={peak} max={Math.max(0, ...peak.map((i) => i.value ?? 0))} fmt={fmtBytes} crownTop />
      </Panel>
      <Panel title="Mean CPU" sub="lower is better">
        <BarList items={cpu} max={Math.max(0, ...cpu.map((i) => i.value ?? 0))} fmt={(n) => fmtPct(n)} crownTop />
      </Panel>
      <Panel title="Efficiency — RPS per MiB RSS" sub="higher is better" style={{ gridColumn: "1 / -1" }}>
        <BarList items={eff} max={Math.max(0, ...eff.map((i) => i.value ?? 0))} fmt={(n) => fmtRps(n)} crownTop />
      </Panel>
    </div>
  );
}

function sortAsc(items: BarItem[]): BarItem[] {
  return [...items].sort((a, b) => (a.value == null ? 1 : b.value == null ? -1 : a.value - b.value));
}
function sortDesc(items: BarItem[]): BarItem[] {
  return [...items].sort((a, b) => (a.value == null ? 1 : b.value == null ? -1 : b.value - a.value));
}
