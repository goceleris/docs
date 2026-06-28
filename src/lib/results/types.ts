/**
 * Types for the benchmark data layer.
 *
 * `Raw*` mirror what probatorium writes on disk (summary.json / timeseries.json.gz
 * / histograms.json.gz / env.json, schema 5.x). The non-Raw types are the compact
 * assets this repo's build step emits for the dashboard. The on-disk tree is the
 * single source of truth; everything else is derived at build time.
 */

// ----------------------------------------------------------------------------
// Raw on-disk shapes (probatorium output)
// ----------------------------------------------------------------------------

export type CellStatus = "ok" | "not_applicable" | "dnf" | "suspect";

export interface RawEnvironment {
  kernel_sysctls_applied?: string[];
  loadgen_host?: string;
  fabric?: string;
}

export interface RawBenchConfig {
  started_at?: string;
  finished_at?: string;
  runs?: number;
  duration?: number; // nanoseconds
  warmup?: number; // nanoseconds
  git_ref?: string;
  loadgen_version?: string;
  celeris_version?: string;
  scenarios_filter?: string;
  adapters_filter?: string;
}

export interface RawResourceSummary {
  peak_rss_bytes?: number | null;
  steady_rss_bytes?: number | null;
  mean_cpu_pct?: number | null;
  gc_pause_p99_ns?: number | null;
  goroutine_hwm?: number | null;
  fd_hwm?: number | null;
}

export interface RawResourceSeriesPoint {
  ts_unix: number;
  rss_bytes?: number | null;
  cpu_pct?: number | null;
  goroutines?: number | null;
  heap_inuse_bytes?: number | null;
  fd_count?: number | null;
}

export interface RawResourceStats {
  summary?: RawResourceSummary;
  series?: RawResourceSeriesPoint[];
}

export interface RawServerResult {
  /** Adapter id. Newer files use `name`; older used `server`. */
  name?: string;
  server?: string;
  category?: string;
  language?: string;
  language_version?: string;
  framework?: string;
  framework_version?: string;
  engine?: string;
  compile_options?: string[];
  saturation_mode_rps?: Record<string, number>;
  rated_mode_p99_at_target_rps?: Record<string, number>;
  latency_at_slo?: Record<string, Record<string, number>>;
  hdr_histogram_b64?: Record<string, string>;
  loadgen_cpu_p95?: Record<string, number>;
  sent_vs_handled_delta_pct?: Record<string, number>;
  connect_errors?: Record<string, number>;
  resources?: Record<string, RawResourceStats>;
  cell_statuses?: Record<string, CellStatus>;
  cell_run_statuses?: Record<string, CellStatus[]>;
}

export interface RawSummary {
  schema_version: string;
  host_arch_pair?: string;
  environment?: RawEnvironment;
  benchmark_config?: RawBenchConfig;
  benchmarks: RawServerResult[];
}

export interface RawEnv {
  schema_version: string;
  version?: string;
  arch?: string;
  date?: string;
  run_id?: string;
  git_sha?: string;
  celeris_version?: string;
  loadgen_version?: string;
  generated_at?: string;
  environment?: RawEnvironment;
  benchmark_config?: RawBenchConfig;
}

export interface RawBandStat {
  min: number;
  p50: number;
  p99: number;
  max: number;
  mean: number;
}

export interface RawSample {
  t_s: number;
  rps: number;
  p99_ms?: number;
  errors?: number;
}

export interface RawRunSeries {
  run: number;
  samples: RawSample[];
}

export interface RawBandPoint {
  t_s: number;
  rps: RawBandStat;
  p99_ms: RawBandStat;
  errors: RawBandStat;
}

export interface RawTimeseriesScenario {
  scenario: string;
  server: string;
  category?: string;
  runs: RawRunSeries[] | null;
  band: RawBandPoint[] | null;
}

export interface RawTimeseries {
  schema_version: string;
  generated_at?: string;
  scenarios: RawTimeseriesScenario[];
}

/** One loaded benchmark cell (a single version/date/arch/run). */
export interface LoadedCell {
  version: string;
  date: string;
  arch: string;
  runId: string;
  dir: string;
  summary: RawSummary;
  env: RawEnv;
  timeseries: RawTimeseries | null;
  durationNs: number;
  smoke: boolean;
}

// ----------------------------------------------------------------------------
// Emitted asset shapes (consumed by the dashboard)
// ----------------------------------------------------------------------------

/** Full aggregate of a metric across runs (mean + spread + counts). */
export interface Agg {
  mean: number;
  min: number;
  max: number;
  stddev: number;
  /** coefficient of variation (stddev/mean); null when mean is 0. */
  cv: number | null;
  n: number;
  n_dnf: number;
  n_suspect: number;
}

/** Lighter aggregate (no status counts). */
export interface SimpleAgg {
  mean: number;
  min?: number;
  max?: number;
  stddev?: number;
  n: number;
}

export interface ResourceAgg {
  peak_rss_bytes?: { mean: number; max: number; n: number } | null;
  steady_rss_bytes?: { mean: number; n: number } | null;
  mean_cpu_pct?: { mean: number; n: number } | null;
  gc_pause_p99_ns?: { mean: number; n: number } | null;
  goroutine_hwm?: { mean: number; max: number; n: number } | null;
  fd_hwm?: { mean: number; max: number; n: number } | null;
}

export interface ScenarioMetrics {
  saturation_rps?: Agg;
  rated_p99_ns?: SimpleAgg;
  latency_at_slo?: Record<string, { mean: number; n: number }>;
  resources?: ResourceAgg | null;
  loadgen_cpu_p95?: SimpleAgg | null;
  sent_vs_handled_delta_pct?: SimpleAgg | null;
  connect_errors?: SimpleAgg | null;
  /** worst-of status across runs. */
  status: CellStatus;
}

export interface ServerPayload {
  category: string;
  scenarios: Record<string, ScenarioMetrics>;
}

export interface TimeseriesAgg {
  t_grid: number[];
  rps: { mean: number[]; p50: number[]; p99: number[]; min: number[]; max: number[] };
  p99_ms: { mean: number[]; min: number[]; max: number[] };
  errors: { mean: number[]; max: number[] };
  n_runs: number;
  window_s: number;
}

export interface VersionPayloadMeta {
  adapters: number;
  scenarios: number;
  runs_included: number;
  runs_excluded: number;
  dates: string[];
  has_timeseries: boolean;
  has_resources: boolean;
  flags: string[];
  warmup_ns: number;
  duration_ns: number;
  loadgen_version: string;
  fabric: string;
}

export interface VersionHeadline {
  scenarios: string[];
  top_by_scenario: Record<string, { server: string; mean_rps: number }>;
  celeris: {
    saturation_rps: Record<string, { server: string; mean: number }>;
    rated_p99_ns: Record<string, number>;
    latency_at_slo: Record<string, Record<string, number>>;
  };
}

export interface VersionPayload {
  schema_version: "dashboard-version/1";
  version: string;
  arch: string;
  meta: VersionPayloadMeta;
  servers: Record<string, ServerPayload>;
  headline: VersionHeadline;
  /** keyed "scenario|server". */
  timeseries: Record<string, TimeseriesAgg>;
}

// ---- Manifest ----

export interface ProvenanceEntry {
  date: string;
  run_id: string;
  arch: string;
  git_sha: string;
  duration_ns: number;
  disposition: string; // "included" | "excluded:smoke" | "excluded:invalid"
}

export interface ManifestArch {
  arch: string;
  asset: string;
  adapters: number;
  scenarios: number;
  runs_included: number;
  runs_excluded: number;
  dates: string[];
  has_timeseries: boolean;
  has_resources: boolean;
  bytes: number;
}

export interface ManifestVersion {
  version: string;
  latest_date: string;
  released_at: string;
  flags: string[];
  arches: ManifestArch[];
  provenance: ProvenanceEntry[];
}

export interface Manifest {
  schema_version: "dashboard-manifest/1";
  generated_at: string;
  default: { version: string; arch: string } | null;
  arches: string[];
  versions: ManifestVersion[];
}

// ---- Registries ----

export type ScenarioCategory =
  | "static"
  | "concurrency"
  | "driver"
  | "streaming"
  | "tls";

export interface AdapterMeta {
  id: string;
  display_name: string;
  short_name: string;
  category: string;
  language: string;
  language_version: string;
  framework: string;
  framework_version: string;
  engine: string;
  protocol: string;
  is_celeris: boolean;
  /** "framework" = full web framework; "lib"/"stdlib" = low-level/standard library. */
  kind: "framework" | "lib" | "stdlib" | "runtime";
  color: string;
  retired: boolean;
}

export interface LanguageMeta {
  id: string;
  display: string;
  color: string;
}

export interface CompetitorsRegistry {
  schema_version: "competitors/1";
  adapters: Record<string, AdapterMeta>;
  languages: Record<string, LanguageMeta>;
}

export interface ScenarioMeta {
  id: string;
  display_name: string;
  category: ScenarioCategory;
  protocol: string;
  payload_hint?: string;
  concurrency_hint?: string;
}

export interface CategoryMeta {
  display: string;
  order: number;
}

export interface ScenarioRegistry {
  schema_version: "scenarios/1";
  scenarios: Record<string, ScenarioMeta>;
  categories: Record<string, CategoryMeta>;
}
