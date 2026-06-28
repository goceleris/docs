/**
 * Aggregation: average a metric across ALL runs of a (version, arch).
 *
 * The unit of a sample is one run's value for a (server, scenario). Status gates
 * apply first: not_applicable excluded silently, dnf excluded but counted,
 * suspect included but counted. Every averaged number ships with `n` and spread
 * so the UI can convey confidence. Nulls are emitted (never zeros) for absent
 * metrics. Time-series across runs are normalized to a common window, binned, and
 * reduced to a cross-run {mean,p50,p99,min,max} envelope.
 */
import type {
  Agg,
  CellStatus,
  LoadedCell,
  RawResourceStats,
  RawServerResult,
  ResourceAgg,
  ScenarioMetrics,
  ServerPayload,
  SimpleAgg,
  TimeseriesAgg,
  VersionHeadline,
  VersionPayload,
} from "./types";
import { CELERIS_CATEGORY } from "./walk";
import { serverName, scenarioCmp } from "./taxonomy";

export interface AggregateOpts {
  /** Bin combined time-series to at most this many points. */
  tsMaxPoints: number;
  /** Drop a run's series from the time-series if its length < this fraction of the median. */
  tsMinFraction: number;
}

export const DEFAULT_AGG_OPTS: AggregateOpts = { tsMaxPoints: 120, tsMinFraction: 0.5 };

// ---- stats helpers ----

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Linear-interpolated quantile over an ascending-sorted array. */
function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function aggFull(xs: number[], nDnf: number, nSuspect: number, round = r0): Agg | undefined {
  if (!xs.length) return undefined;
  const m = mean(xs);
  return {
    mean: round(m),
    min: round(Math.min(...xs)),
    max: round(Math.max(...xs)),
    stddev: round(stddev(xs)),
    cv: m ? r4(stddev(xs) / m) : null,
    n: xs.length,
    n_dnf: nDnf,
    n_suspect: nSuspect,
  };
}

function aggSimple(xs: number[], round = r0): SimpleAgg | undefined {
  if (!xs.length) return undefined;
  return {
    mean: round(mean(xs)),
    min: round(Math.min(...xs)),
    max: round(Math.max(...xs)),
    stddev: round(stddev(xs)),
    n: xs.length,
  };
}

// ---- per (version, arch) aggregation ----

interface ServerScan {
  category: string;
  /** scenario -> per-cell RawServerResult entries (only cells where the scenario appears). */
  scenarios: Map<string, RawServerResult[]>;
}

function scenarioKeys(sr: RawServerResult): Set<string> {
  const keys = new Set<string>();
  for (const m of [
    sr.saturation_mode_rps,
    sr.rated_mode_p99_at_target_rps,
    sr.latency_at_slo,
    sr.loadgen_cpu_p95,
    sr.sent_vs_handled_delta_pct,
    sr.connect_errors,
    sr.resources,
    sr.cell_statuses,
  ]) {
    if (m) for (const k of Object.keys(m)) keys.add(k);
  }
  return keys;
}

function statusOf(sr: RawServerResult, scenario: string): CellStatus {
  return sr.cell_statuses?.[scenario] ?? "ok";
}

function worstStatus(hasValue: boolean, nSuspect: number, nDnf: number, nNa: number): CellStatus {
  if (hasValue) return nSuspect > 0 ? "suspect" : "ok";
  if (nDnf > 0) return "dnf";
  if (nNa > 0) return "not_applicable";
  return "ok";
}

function aggregateResources(entries: RawServerResult[], scenario: string): ResourceAgg | null {
  const stats: RawResourceStats[] = [];
  for (const sr of entries) {
    const rs = sr.resources?.[scenario];
    if (rs?.summary) stats.push(rs);
  }
  if (!stats.length) return null;

  const pick = (sel: (s: RawResourceStats) => number | null | undefined) =>
    stats.map(sel).filter(finite);

  const peak = pick((s) => s.summary?.peak_rss_bytes);
  const steady = pick((s) => s.summary?.steady_rss_bytes);
  const cpu = pick((s) => s.summary?.mean_cpu_pct);
  const gc = pick((s) => s.summary?.gc_pause_p99_ns);
  const gor = pick((s) => s.summary?.goroutine_hwm);
  const fd = pick((s) => s.summary?.fd_hwm);

  const out: ResourceAgg = {};
  out.peak_rss_bytes = peak.length ? { mean: r0(mean(peak)), max: r0(Math.max(...peak)), n: peak.length } : null;
  out.steady_rss_bytes = steady.length ? { mean: r0(mean(steady)), n: steady.length } : null;
  out.mean_cpu_pct = cpu.length ? { mean: r2(mean(cpu)), n: cpu.length } : null;
  out.gc_pause_p99_ns = gc.length ? { mean: r0(mean(gc)), n: gc.length } : null;
  out.goroutine_hwm = gor.length ? { mean: r0(mean(gor)), max: r0(Math.max(...gor)), n: gor.length } : null;
  out.fd_hwm = fd.length ? { mean: r0(mean(fd)), max: r0(Math.max(...fd)), n: fd.length } : null;

  const anything = Object.values(out).some((v) => v != null);
  return anything ? out : null;
}

function aggregateScenario(scenario: string, entries: RawServerResult[]): ScenarioMetrics {
  // status gate
  const admitted: RawServerResult[] = [];
  let nDnf = 0,
    nSuspect = 0,
    nNa = 0;
  for (const sr of entries) {
    const st = statusOf(sr, scenario);
    if (st === "not_applicable") {
      nNa++;
      continue;
    }
    if (st === "dnf") {
      nDnf++;
      continue;
    }
    if (st === "suspect") nSuspect++;
    admitted.push(sr);
  }

  const rps = admitted.map((sr) => sr.saturation_mode_rps?.[scenario]).filter(finite);
  const ratedP99 = admitted.map((sr) => sr.rated_mode_p99_at_target_rps?.[scenario]).filter(finite);
  const cpuP95 = admitted.map((sr) => sr.loadgen_cpu_p95?.[scenario]).filter(finite);
  const delta = admitted.map((sr) => sr.sent_vs_handled_delta_pct?.[scenario]).filter(finite);
  const connErr = admitted.map((sr) => sr.connect_errors?.[scenario]).filter(finite);

  // latency_at_slo: average per SLO key independently
  const sloAcc: Record<string, number[]> = {};
  for (const sr of admitted) {
    const slo = sr.latency_at_slo?.[scenario];
    if (!slo) continue;
    for (const [k, v] of Object.entries(slo)) {
      if (finite(v)) (sloAcc[k] ||= []).push(v);
    }
  }
  const latency_at_slo: Record<string, { mean: number; n: number }> = {};
  for (const [k, xs] of Object.entries(sloAcc)) {
    if (xs.length) latency_at_slo[k] = { mean: r0(mean(xs)), n: xs.length };
  }

  const metrics: ScenarioMetrics = {
    status: worstStatus(rps.length > 0, nSuspect, nDnf, nNa),
  };
  const sat = aggFull(rps, nDnf, nSuspect);
  if (sat) metrics.saturation_rps = sat;
  const rated = aggSimple(ratedP99);
  if (rated) metrics.rated_p99_ns = rated;
  if (Object.keys(latency_at_slo).length) metrics.latency_at_slo = latency_at_slo;
  const res = aggregateResources(admitted, scenario);
  if (res) metrics.resources = res;
  const cpu = aggSimple(cpuP95, r4);
  if (cpu) metrics.loadgen_cpu_p95 = cpu;
  const d = aggSimple(delta, r4);
  if (d) metrics.sent_vs_handled_delta_pct = d;
  const ce = aggSimple(connErr);
  if (ce) metrics.connect_errors = ce;
  return metrics;
}

// ---- time-series aggregation ----

interface RunSamples {
  ts: number[];
  rps: number[];
  p99: (number | null)[];
  errs: number[];
}

function collectRunSeries(cells: LoadedCell[], scenario: string, server: string): RunSamples[] {
  const out: RunSamples[] = [];
  for (const cell of cells) {
    const entry = cell.timeseries?.scenarios?.find(
      (e) => e.scenario === scenario && e.server === server,
    );
    if (!entry) continue;
    if (entry.runs && entry.runs.length) {
      for (const run of entry.runs) {
        if (!run.samples?.length) continue;
        out.push({
          ts: run.samples.map((s) => s.t_s),
          rps: run.samples.map((s) => s.rps),
          p99: run.samples.map((s) => (finite(s.p99_ms) ? s.p99_ms! : null)),
          errs: run.samples.map((s) => (finite(s.errors) ? s.errors! : 0)),
        });
      }
    } else if (entry.band && entry.band.length) {
      // Fall back to the per-run band means as a single synthetic series.
      out.push({
        ts: entry.band.map((b) => b.t_s),
        rps: entry.band.map((b) => b.rps.mean),
        p99: entry.band.map((b) => (finite(b.p99_ms?.mean) ? b.p99_ms.mean : null)),
        errs: entry.band.map((b) => (finite(b.errors?.mean) ? b.errors.mean : 0)),
      });
    }
  }
  return out;
}

function aggregateOneTimeseries(series: RunSamples[], opts: AggregateOpts): TimeseriesAgg | null {
  if (!series.length) return null;
  const lengths = series.map((s) => Math.max(...s.ts)).filter((x) => x > 0);
  if (!lengths.length) return null;
  const sortedLen = [...lengths].sort((a, b) => a - b);
  const lstar = quantileSorted(sortedLen, 0.5);
  if (lstar <= 0) return null;

  const kept = series.filter((s) => Math.max(...s.ts) >= opts.tsMinFraction * lstar);
  if (!kept.length) return null;

  const G = Math.max(1, Math.min(opts.tsMaxPoints, Math.ceil(lstar)));
  const binRps: number[][] = Array.from({ length: G }, () => []);
  const binP99: number[][] = Array.from({ length: G }, () => []);
  const binErr: number[][] = Array.from({ length: G }, () => []);

  for (const s of kept) {
    for (let i = 0; i < s.ts.length; i++) {
      const b = Math.min(G - 1, Math.max(0, Math.floor((s.ts[i] / lstar) * G)));
      if (finite(s.rps[i])) binRps[b].push(s.rps[i]);
      if (s.p99[i] != null) binP99[b].push(s.p99[i] as number);
      binErr[b].push(s.errs[i] ?? 0);
    }
  }

  const t_grid: number[] = [];
  const rpsMean: number[] = [], rpsP50: number[] = [], rpsP99: number[] = [], rpsMin: number[] = [], rpsMax: number[] = [];
  const p99Mean: number[] = [], p99Min: number[] = [], p99Max: number[] = [];
  const errMean: number[] = [], errMax: number[] = [];

  for (let b = 0; b < G; b++) {
    t_grid.push(r3(((b + 0.5) / G) * lstar));
    const rs = [...binRps[b]].sort((a, z) => a - z);
    rpsMean.push(rs.length ? r0(mean(rs)) : 0);
    rpsP50.push(rs.length ? r0(quantileSorted(rs, 0.5)) : 0);
    rpsP99.push(rs.length ? r0(quantileSorted(rs, 0.99)) : 0);
    rpsMin.push(rs.length ? r0(rs[0]) : 0);
    rpsMax.push(rs.length ? r0(rs[rs.length - 1]) : 0);
    const ps = [...binP99[b]].sort((a, z) => a - z);
    p99Mean.push(ps.length ? r3(mean(ps)) : 0);
    p99Min.push(ps.length ? r3(ps[0]) : 0);
    p99Max.push(ps.length ? r3(ps[ps.length - 1]) : 0);
    const es = binErr[b];
    errMean.push(es.length ? r2(mean(es)) : 0);
    errMax.push(es.length ? r0(Math.max(...es)) : 0);
  }

  return {
    t_grid,
    rps: { mean: rpsMean, p50: rpsP50, p99: rpsP99, min: rpsMin, max: rpsMax },
    p99_ms: { mean: p99Mean, min: p99Min, max: p99Max },
    errors: { mean: errMean, max: errMax },
    n_runs: kept.length,
    window_s: r3(lstar),
  };
}

// ---- orchestration ----

/** Aggregate all runs of a (version, arch). `cells` should be newest-date-first. */
export function aggregateVersionArch(
  version: string,
  arch: string,
  cells: LoadedCell[],
  runsExcluded: number,
  opts: AggregateOpts = DEFAULT_AGG_OPTS,
): VersionPayload {
  // Build per-server scan: union scenarios + per-scenario cell entries.
  const scan = new Map<string, ServerScan>();
  for (const cell of cells) {
    for (const sr of cell.summary.benchmarks) {
      const id = serverName(sr);
      let entry = scan.get(id);
      if (!entry) {
        entry = { category: sr.category || "", scenarios: new Map() };
        scan.set(id, entry);
      }
      if (!entry.category && sr.category) entry.category = sr.category;
      for (const scn of scenarioKeys(sr)) {
        (entry.scenarios.get(scn) || entry.scenarios.set(scn, []).get(scn)!).push(sr);
      }
    }
  }

  const servers: Record<string, ServerPayload> = {};
  const allScenarios = new Set<string>();
  let hasResources = false;

  for (const [id, sc] of scan) {
    const scenarios: Record<string, ScenarioMetrics> = {};
    for (const [scn, entries] of sc.scenarios) {
      const m = aggregateScenario(scn, entries);
      scenarios[scn] = m;
      allScenarios.add(scn);
      if (m.resources) hasResources = true;
    }
    servers[id] = { category: sc.category, scenarios };
  }

  // Time-series per (scenario, server).
  const timeseries: Record<string, TimeseriesAgg> = {};
  const anyTs = cells.some((c) => c.timeseries);
  if (anyTs) {
    for (const [id, sc] of scan) {
      for (const scn of sc.scenarios.keys()) {
        const series = collectRunSeries(cells, scn, id);
        const agg = aggregateOneTimeseries(series, opts);
        if (agg) timeseries[`${scn}|${id}`] = agg;
      }
    }
  }

  const headline = buildHeadline(servers);
  const dates = [...new Set(cells.map((c) => c.date))];
  const probe = cells[0];
  const cfg = probe?.summary.benchmark_config || probe?.env.benchmark_config || {};

  return {
    schema_version: "dashboard-version/1",
    version,
    arch,
    meta: {
      adapters: Object.keys(servers).length,
      scenarios: allScenarios.size,
      runs_included: cells.length,
      runs_excluded: runsExcluded,
      dates,
      has_timeseries: Object.keys(timeseries).length > 0,
      has_resources: hasResources,
      flags: [],
      warmup_ns: Number(cfg.warmup || 0),
      duration_ns: Number(cfg.duration || 0),
      loadgen_version: cfg.loadgen_version || probe?.env.loadgen_version || "",
      fabric: probe?.env.environment?.fabric || probe?.summary.environment?.fabric || "",
    },
    servers,
    headline,
    timeseries,
  };
}

function buildHeadline(servers: Record<string, ServerPayload>): VersionHeadline {
  const scenarioSet = new Set<string>();
  for (const sp of Object.values(servers)) {
    for (const [scn, m] of Object.entries(sp.scenarios)) {
      if (m.saturation_rps) scenarioSet.add(scn);
    }
  }
  const scenarios = [...scenarioSet].sort(scenarioCmp);

  const top_by_scenario: Record<string, { server: string; mean_rps: number }> = {};
  for (const scn of scenarios) {
    let best: { server: string; mean_rps: number } | null = null;
    for (const [id, sp] of Object.entries(servers)) {
      const v = sp.scenarios[scn]?.saturation_rps?.mean;
      if (!finite(v)) continue;
      if (!best || v > best.mean_rps) best = { server: id, mean_rps: v };
    }
    if (best) top_by_scenario[scn] = best;
  }

  const celeris: VersionHeadline["celeris"] = {
    saturation_rps: {},
    rated_p99_ns: {},
    latency_at_slo: {},
  };
  const celServers = Object.entries(servers).filter(([, sp]) => sp.category === CELERIS_CATEGORY);
  for (const scn of scenarios) {
    let best: { id: string; m: ScenarioMetrics } | null = null;
    for (const [id, sp] of celServers) {
      const v = sp.scenarios[scn]?.saturation_rps?.mean;
      if (!finite(v)) continue;
      if (!best || v > best.m.saturation_rps!.mean) best = { id, m: sp.scenarios[scn] };
    }
    if (!best) continue;
    celeris.saturation_rps[scn] = { server: best.id, mean: best.m.saturation_rps!.mean };
    if (best.m.rated_p99_ns) celeris.rated_p99_ns[scn] = best.m.rated_p99_ns.mean;
    if (best.m.latency_at_slo) {
      const flat: Record<string, number> = {};
      for (const [k, v] of Object.entries(best.m.latency_at_slo)) flat[k] = v.mean;
      celeris.latency_at_slo[scn] = flat;
    }
  }

  return { scenarios, top_by_scenario, celeris };
}
