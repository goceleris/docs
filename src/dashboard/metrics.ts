/** Metric catalog + value extraction over a per-version payload. */
import type { CellStatus, ScenarioMetrics, VersionPayload } from "@results/types";
import type { MetricId } from "./state";
import { fmtRps, fmtBytes, fmtNsAsMs, fmtPct } from "./format";

export interface MetricDef {
  id: MetricId;
  label: string;
  lowerBetter: boolean;
  fmt: (n: number) => string;
  needsSlo?: boolean;
}

export const METRICS: MetricDef[] = [
  { id: "saturation", label: "Saturation RPS", lowerBetter: false, fmt: fmtRps },
  { id: "slo", label: "RPS @ SLO", lowerBetter: false, fmt: fmtRps, needsSlo: true },
  { id: "rated_p99", label: "Rated p99", lowerBetter: true, fmt: fmtNsAsMs },
  { id: "peak_rss", label: "Peak RSS", lowerBetter: true, fmt: fmtBytes },
  { id: "steady_rss", label: "Steady RSS", lowerBetter: true, fmt: fmtBytes },
  { id: "cpu", label: "Mean CPU", lowerBetter: true, fmt: (n) => fmtPct(n) },
  { id: "errors", label: "Error %", lowerBetter: true, fmt: (n) => fmtPct(n, 2) },
];

export function metricDef(id: MetricId): MetricDef {
  return METRICS.find((m) => m.id === id) ?? METRICS[0];
}

export function scenarioMetrics(
  p: VersionPayload,
  server: string,
  scenario: string,
): ScenarioMetrics | undefined {
  return p.servers[server]?.scenarios[scenario];
}

export interface MetricValue {
  value: number | null;
  status: CellStatus;
}

export function metricValue(m: ScenarioMetrics | undefined, id: MetricId, slo: string): MetricValue {
  if (!m) return { value: null, status: "not_applicable" };
  const status = m.status;
  switch (id) {
    case "saturation":
      return { value: m.saturation_rps?.mean ?? null, status };
    case "slo":
      return { value: m.latency_at_slo?.[slo]?.mean ?? null, status };
    case "rated_p99":
      return { value: m.rated_p99_ns?.mean ?? null, status };
    case "peak_rss":
      return { value: m.resources?.peak_rss_bytes?.mean ?? null, status };
    case "steady_rss":
      return { value: m.resources?.steady_rss_bytes?.mean ?? null, status };
    case "cpu":
      return { value: m.resources?.mean_cpu_pct?.mean ?? null, status };
    case "errors":
      return { value: m.sent_vs_handled_delta_pct?.mean ?? null, status };
    default:
      return { value: null, status };
  }
}

/** Whether any selected adapter has a non-null value for this metric+scenario. */
export function metricHasData(
  p: VersionPayload,
  servers: string[],
  scenario: string,
  id: MetricId,
  slo: string,
): boolean {
  return servers.some((s) => metricValue(scenarioMetrics(p, s, scenario), id, slo).value != null);
}
