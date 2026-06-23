/**
 * Data-layer tests (`bun test`). Covers aggregation/averaging semantics, status
 * gating, time-series combination, taxonomy derivation, comparators, and loading
 * the real preserved sample cell. Mirrors the rigor of the deleted selftest.mjs.
 */
import { test, expect, describe } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateVersionArch } from "../src/lib/results/aggregate";
import {
  scenarioCategory,
  scenarioProtocol,
  buildScenarioMeta,
  buildAdapterMeta,
} from "../src/lib/results/taxonomy";
import { versionCmpDesc, runCmp, listVersions, listRuns } from "../src/lib/results/walk";
import { isSmoke, loadCell } from "../src/lib/results/load";
import type { LoadedCell, RawServerResult, RawTimeseries } from "../src/lib/results/types";

function cell(benchmarks: RawServerResult[], opts: Partial<LoadedCell> = {}): LoadedCell {
  return {
    version: "v1.0.0",
    date: "20260101",
    arch: "x86_64",
    runId: "run-1",
    dir: "",
    summary: {
      schema_version: "5.4",
      host_arch_pair: "linux/amd64",
      benchmark_config: { duration: 120e9, warmup: 30e9, loadgen_version: "v1.4.8" },
      benchmarks,
    },
    env: { schema_version: "env/1", environment: { fabric: "3-host LACP 20G" } },
    timeseries: null,
    durationNs: 120e9,
    smoke: false,
    ...opts,
  };
}

function srv(name: string, rps: Record<string, number>, extra: Partial<RawServerResult> = {}): RawServerResult {
  return {
    name,
    category: name.startsWith("celeris") ? "celeris" : "go-net-http",
    language: "go",
    saturation_mode_rps: rps,
    ...extra,
  };
}

describe("aggregation", () => {
  test("averages saturation rps across runs with spread + counts", () => {
    const cells = [
      cell([srv("celeris-iouring-h1-async", { "get-json": 100 })]),
      cell([srv("celeris-iouring-h1-async", { "get-json": 200 })]),
      cell([srv("celeris-iouring-h1-async", { "get-json": 300 })]),
    ];
    const p = aggregateVersionArch("v1.0.0", "x86_64", cells, 0);
    const m = p.servers["celeris-iouring-h1-async"].scenarios["get-json"].saturation_rps!;
    expect(m.mean).toBe(200);
    expect(m.min).toBe(100);
    expect(m.max).toBe(300);
    expect(m.n).toBe(3);
    expect(m.stddev).toBe(82); // population stddev of [100,200,300] ≈ 81.6
    expect(p.servers["celeris-iouring-h1-async"].scenarios["get-json"].status).toBe("ok");
  });

  test("status gating: not_applicable excluded, dnf counted, suspect included", () => {
    const cells = [
      cell([srv("x", { s: 100 }, { cell_statuses: { s: "ok" } })]),
      cell([srv("x", { s: 999 }, { cell_statuses: { s: "not_applicable" } })]),
      cell([srv("x", { s: 50 }, { cell_statuses: { s: "dnf" } })]),
      cell([srv("x", { s: 140 }, { cell_statuses: { s: "suspect" } })]),
    ];
    const sc = aggregateVersionArch("v1.0.0", "x86_64", cells, 0).servers["x"].scenarios["s"];
    // mean over ok(100) + suspect(140) = 120; na & dnf excluded from value
    expect(sc.saturation_rps!.mean).toBe(120);
    expect(sc.saturation_rps!.n).toBe(2);
    expect(sc.saturation_rps!.n_dnf).toBe(1);
    expect(sc.saturation_rps!.n_suspect).toBe(1);
    expect(sc.status).toBe("suspect");
  });

  test("all-not_applicable yields status not_applicable and no value", () => {
    const cells = [cell([srv("x", {}, { cell_statuses: { s: "not_applicable" } })])];
    const sc = aggregateVersionArch("v1.0.0", "x86_64", cells, 0).servers["x"].scenarios["s"];
    expect(sc.saturation_rps).toBeUndefined();
    expect(sc.status).toBe("not_applicable");
  });

  test("latency_at_slo averaged per SLO key independently", () => {
    const cells = [
      cell([srv("x", { s: 1 }, { latency_at_slo: { s: { "10": 100, "1000": 400 } } })]),
      cell([srv("x", { s: 1 }, { latency_at_slo: { s: { "1000": 600 } } })]),
    ];
    const slo = aggregateVersionArch("v1.0.0", "x86_64", cells, 0).servers["x"].scenarios["s"].latency_at_slo!;
    expect(slo["10"]).toEqual({ mean: 100, n: 1 });
    expect(slo["1000"]).toEqual({ mean: 500, n: 2 });
  });

  test("headline picks per-scenario winner + best celeris", () => {
    const cells = [
      cell([
        srv("celeris-iouring-h1-async", { "get-json": 500 }),
        srv("celeris-epoll-h1-sync", { "get-json": 400 }),
        srv("fasthttp-h1", { "get-json": 600 }),
      ]),
    ];
    const h = aggregateVersionArch("v1.0.0", "x86_64", cells, 0).headline;
    expect(h.top_by_scenario["get-json"]).toEqual({ server: "fasthttp-h1", mean_rps: 600 });
    expect(h.celeris.saturation_rps["get-json"]).toEqual({ server: "celeris-iouring-h1-async", mean: 500 });
  });

  test("combines time-series across runs into a binned cross-run band", () => {
    const mkTs = (rpsBase: number): RawTimeseries => ({
      schema_version: "timeseries/1",
      scenarios: [
        {
          scenario: "get-json",
          server: "celeris-iouring-h1-async",
          runs: [
            {
              run: 1,
              samples: [1, 2, 3, 4].map((t) => ({ t_s: t, rps: rpsBase + t, p99_ms: 1.0, errors: 0 })),
            },
          ],
          band: null,
        },
      ],
    });
    const cells = [
      cell([srv("celeris-iouring-h1-async", { "get-json": 100 })], { timeseries: mkTs(100) }),
      cell([srv("celeris-iouring-h1-async", { "get-json": 100 })], { timeseries: mkTs(200) }),
    ];
    const p = aggregateVersionArch("v1.0.0", "x86_64", cells, 0);
    const ts = p.timeseries["get-json|celeris-iouring-h1-async"];
    expect(ts).toBeDefined();
    expect(ts.n_runs).toBe(2);
    expect(ts.window_s).toBe(4);
    expect(ts.t_grid.length).toBe(4);
    expect(p.meta.has_timeseries).toBe(true);
  });

  test("empty input yields a valid empty payload", () => {
    const p = aggregateVersionArch("v1.0.0", "x86_64", [], 0);
    expect(Object.keys(p.servers).length).toBe(0);
    expect(p.headline.scenarios.length).toBe(0);
    expect(p.meta.adapters).toBe(0);
  });
});

describe("taxonomy", () => {
  test("scenario category derivation", () => {
    expect(scenarioCategory("get-json")).toBe("static");
    expect(scenarioCategory("churn-close")).toBe("static");
    expect(scenarioCategory("get-json-1c")).toBe("concurrency");
    expect(scenarioCategory("get-simple-1024c")).toBe("concurrency");
    expect(scenarioCategory("auto-mix-111")).toBe("concurrency");
    expect(scenarioCategory("chain-api-get-json")).toBe("chain");
    expect(scenarioCategory("driver-pg-read")).toBe("driver");
    expect(scenarioCategory("ws-echo")).toBe("ws");
    expect(scenarioCategory("sse-fanout-128")).toBe("sse");
    expect(scenarioCategory("tls-get-json")).toBe("tls");
  });

  test("scenario protocol derivation", () => {
    expect(scenarioProtocol("get-json")).toBe("h1");
    expect(scenarioProtocol("get-json-64k-h2")).toBe("h2c");
    expect(scenarioProtocol("auto-mix-111")).toBe("mixed");
    expect(scenarioProtocol("tls-get-json")).toBe("tls");
  });

  test("chain scenario meta parses profile + workload", () => {
    const m = buildScenarioMeta("chain-fullstack-post-4k");
    expect(m.category).toBe("chain");
    expect(m.chain_profile).toBe("fullstack");
    expect(m.workload).toBe("post-4k");
  });

  test("adapter meta flags celeris + assigns a color", () => {
    const a = buildAdapterMeta({ name: "celeris-iouring-h1-async", category: "celeris", language: "go", engine: "iouring-h1-async" });
    expect(a.is_celeris).toBe(true);
    expect(a.protocol).toBe("h1");
    expect(a.color).toMatch(/^#/);
    const b = buildAdapterMeta({ name: "axum", category: "rust-tower", language: "rust", engine: "h1" });
    expect(b.is_celeris).toBe(false);
    expect(b.language).toBe("rust");
  });
});

describe("comparators + smoke", () => {
  test("versionCmpDesc newest first; releases ahead of prereleases", () => {
    expect([...["v1.4.15", "v1.5.0", "v1.4.2"].sort(versionCmpDesc)]).toEqual(["v1.5.0", "v1.4.15", "v1.4.2"]);
    expect(versionCmpDesc("v1.5.0", "v1.5.0-rc1")).toBeLessThan(0);
  });
  test("runCmp orders numeric then variant", () => {
    expect(["run-2", "run-1-rated", "run-1", "run-10"].sort(runCmp)).toEqual([
      "run-1",
      "run-1-rated",
      "run-2",
      "run-10",
    ]);
  });
  test("isSmoke threshold", () => {
    expect(isSmoke(5e9, 30e9)).toBe(true);
    expect(isSmoke(120e9, 30e9)).toBe(false);
    expect(isSmoke(0, 30e9)).toBe(false);
  });
});

describe("loader (real preserved sample)", () => {
  const fixture = join(import.meta.dir, "..", "test", "fixtures", "sample-cell");

  test("loads + validates the real 31-adapter schema-5.3 sample", () => {
    if (!existsSync(join(fixture, "summary.json"))) return; // fixture optional
    const tmp = mkdtempSync(join(tmpdir(), "celeris-data-"));
    try {
      const cellDir = join(tmp, "results", "v1.4.15", "20260610", "x86_64");
      mkdirSync(cellDir, { recursive: true });
      for (const f of ["summary.json", "env.json", "timeseries.json.gz", "histograms.json.gz"]) {
        copyFileSync(join(fixture, f), join(cellDir, f));
      }
      const root = join(tmp, "results");
      expect(listVersions(root)).toEqual(["v1.4.15"]);
      expect(listRuns(root, "v1.4.15", "20260610", "x86_64")).toEqual(["run-1"]);
      const { cell: c, errors } = loadCell(
        root,
        { version: "v1.4.15", date: "20260610", arch: "x86_64", runId: "run-1" },
        { minDurationNs: 30e9 },
      );
      expect(errors).toEqual([]);
      expect(c).not.toBeNull();
      expect(c!.summary.benchmarks.length).toBe(31);
      expect(c!.timeseries).not.toBeNull();
      // It's a 5s smoke run.
      expect(c!.smoke).toBe(true);
      // Aggregate it anyway (include smoke) and confirm a celeris headline appears.
      const p = aggregateVersionArch("v1.4.15", "x86_64", [c!], 0);
      expect(p.meta.adapters).toBe(31);
      expect(Object.keys(p.headline.celeris.saturation_rps).length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("multi-run averaging over a synthesized tree", () => {
    if (!existsSync(join(fixture, "summary.json"))) return;
    const tmp = mkdtempSync(join(tmpdir(), "celeris-multi-"));
    try {
      const base = JSON.parse(readFileSync(join(fixture, "summary.json"), "utf8"));
      const root = join(tmp, "results");
      for (const k of [1, 2, 3]) {
        // Multi-run publishes put every run in its own run-N/ subdir.
        const dir = join(root, "v1.4.15", "20260610", "x86_64", `run-${k}`);
        mkdirSync(dir, { recursive: true });
        // bump every saturation rps by k so the mean is predictable-ish
        const summary = JSON.parse(JSON.stringify(base));
        summary.benchmark_config.duration = 120e9; // full run, not smoke
        writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
        const env = JSON.parse(readFileSync(join(fixture, "env.json"), "utf8"));
        env.run_id = `run-${k}`;
        env.benchmark_config.duration = 120e9;
        writeFileSync(join(dir, "env.json"), JSON.stringify(env));
        copyFileSync(join(fixture, "timeseries.json.gz"), join(dir, "timeseries.json.gz"));
        copyFileSync(join(fixture, "histograms.json.gz"), join(dir, "histograms.json.gz"));
      }
      expect(listRuns(root, "v1.4.15", "20260610", "x86_64")).toEqual(["run-1", "run-2", "run-3"]);
      const cells = ["run-1", "run-2", "run-3"].map(
        (runId) =>
          loadCell(root, { version: "v1.4.15", date: "20260610", arch: "x86_64", runId }, { minDurationNs: 30e9 }).cell!,
      );
      expect(cells.every((c) => c && !c.smoke)).toBe(true);
      const p = aggregateVersionArch("v1.4.15", "x86_64", cells, 0);
      // any celeris scenario should now reflect n=3
      const cel = p.servers["celeris-iouring-h1-async"];
      const someScenario = Object.values(cel.scenarios).find((s) => s.saturation_rps);
      expect(someScenario?.saturation_rps?.n).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
