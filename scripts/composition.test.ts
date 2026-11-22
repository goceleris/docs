/**
 * Tie rule + composition.json/twin.json handling for cells composed from two
 * dispatches (probatorium tools/mergedocs). `bun test`.
 */
import { test, expect, describe } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateVersionArch } from "../src/lib/results/aggregate";
import { loadCell } from "../src/lib/results/load";
import { describeComposition, goTally, rivalMargin, standing } from "../src/lib/results/tie";
import type { RawComposition, VersionPayload } from "../src/lib/results/types";

function comp(over: Partial<RawComposition> = {}): RawComposition {
  return {
    schema: "composition/1",
    refusals_sha256: "x",
    arch: "x86_64",
    publish_date: "20261201",
    dispatches: {},
    gap_hours_between_dispatches: 33.2,
    reboot: { between_dispatches: false },
    tie_floor: 0.05,
    tie_margin_by_scenario: { quiet: 0.05, noisy: 0.12 },
    max_anchor_drift: 0.12,
    drift_warning: false,
    anchors: {},
    columns: { "celeris-a": "candidate", "fiber-h1": "candidate", "gin-h1": "peers", "echo-h1": "peers" },
    twin: { mode: "separate" },
    ...over,
  };
}

describe("rivalMargin", () => {
  test("same dispatch keeps the floor, the other dispatch takes the scenario margin", () => {
    const c = comp();
    expect(rivalMargin(c, "noisy", "fiber-h1")).toBe(0.05);
    expect(rivalMargin(c, "noisy", "gin-h1")).toBe(0.12);
    expect(rivalMargin(c, "quiet", "gin-h1")).toBe(0.05);
  });
  test("a column the composition does not list, or a scenario without a margin, takes the widest", () => {
    const c = comp();
    expect(rivalMargin(c, "quiet", "mystery")).toBe(0.05);
    expect(rivalMargin(c, "unseen", "gin-h1")).toBe(0.12);
  });
});

describe("standing", () => {
  const c = comp();
  test("legacy cell (no composition): strict maximum, never a tie", () => {
    expect(standing(null, "quiet", 101, [{ id: "gin-h1", v: 100 }])).toBe("ahead");
    expect(standing(undefined, "quiet", 100, [{ id: "gin-h1", v: 101 }])).toBe("behind");
  });
  test("other dispatch: ahead only beyond the scenario margin", () => {
    expect(standing(c, "noisy", 111, [{ id: "gin-h1", v: 100 }])).toBe("tie"); // +11% < 12%
    expect(standing(c, "noisy", 113, [{ id: "gin-h1", v: 100 }])).toBe("ahead");
    expect(standing(c, "quiet", 106, [{ id: "gin-h1", v: 100 }])).toBe("ahead"); // the quiet scenario is not decided by the noisy one
  });
  test("same dispatch keeps the 5% band even where the other dispatch has 12%", () => {
    expect(standing(c, "noisy", 106, [{ id: "fiber-h1", v: 100 }])).toBe("ahead");
    expect(standing(c, "noisy", 104, [{ id: "fiber-h1", v: 100 }])).toBe("tie");
  });
  test("must clear every rival with its own margin", () => {
    const rivals = [{ id: "fiber-h1", v: 100 }, { id: "gin-h1", v: 100 }];
    expect(standing(c, "noisy", 108, rivals)).toBe("tie"); // clears fiber (5%), not gin (12%)
    expect(standing(c, "noisy", 113, rivals)).toBe("ahead");
  });
  test("behind when a rival clears celeris by its margin", () => {
    expect(standing(c, "noisy", 100, [{ id: "gin-h1", v: 113 }])).toBe("behind");
    expect(standing(c, "noisy", 100, [{ id: "gin-h1", v: 110 }])).toBe("tie");
  });
});

function payload(c: RawComposition | null): VersionPayload {
  const sat = (m: number) => ({ saturation_rps: { mean: m, min: m, max: m, stddev: 0, n: 1 } }) as never;
  return {
    schema_version: "dashboard-version/1",
    version: "v1.6.0",
    arch: "x86_64",
    meta: {} as never,
    servers: {
      "celeris-a": { category: "celeris", scenarios: { quiet: sat(106), noisy: sat(111), far: sat(200) } },
      "gin-h1": { category: "framework", scenarios: { quiet: sat(100), noisy: sat(100), far: sat(100) } },
    },
    headline: { scenarios: ["quiet", "noisy", "far"], top_by_scenario: {}, celeris: {} as never },
    timeseries: {},
    composition: c,
  };
}

describe("goTally", () => {
  const isCel = (id: string) => id.startsWith("celeris");
  const isGo = () => true;
  test("a single-dispatch payload is unchanged: strict wins, no ties", () => {
    const t = goTally(payload(null), isGo, isCel);
    expect([t.wins, t.ties, t.total]).toEqual([3, 0, 3]);
  });
  test("a composed payload: quiet wins, noisy is a tie, far wins", () => {
    const t = goTally(payload(comp()), isGo, isCel);
    expect([t.wins, t.ties, t.total]).toEqual([2, 1, 3]);
    expect(t.maxMargin.scn).toBe("far");
  });
});

describe("describeComposition", () => {
  test("states the gap, the drift, the margin range and the reboot", () => {
    const l = describeComposition(comp({ reboot: { between_dispatches: true, note: "REBOOTED" }, drift_warning: true })).join("\n");
    expect(l).toContain("33.2 h apart");
    expect(l).toContain("up to 12.0%");
    expect(l).toContain("5.0% to 12.0%");
    expect(l).toContain("REBOOTED");
    expect(l).toContain("more than 15%");
  });
});

describe("loading a composed cell", () => {
  const src = join(import.meta.dir, "..", "test", "fixtures", "cell");
  function cellDir(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "comp-"));
    const dir = join(root, "v1.4.14", "20260604", "x86_64");
    mkdirSync(dir, { recursive: true });
    cpSync(src, dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
    return root;
  }
  const names = () => JSON.parse(readFileSync(join(src, "summary.json"), "utf8")).benchmarks.map((b: { name: string }) => b.name) as string[];
  const expectCell = { version: "v1.4.14", date: "20260604", arch: "x86_64", runId: "run-1" };
  const opts = { minDurationNs: 0 };

  test("composition.json and twin.json ride along and reach the payload", () => {
    const columns = Object.fromEntries(names().map((n) => [n, "candidate"]));
    const twin = { twin_framework_version: "v1.5.11", rows: [] };
    const root = cellDir({ "composition.json": JSON.stringify(comp({ columns })), "twin.json": JSON.stringify(twin) });
    const r = loadCell(root, expectCell, opts);
    expect(r.errors).toEqual([]);
    expect(r.cell?.composition?.tie_margin_by_scenario.noisy).toBe(0.12);
    const p = aggregateVersionArch("v1.0.0", "x86_64", [r.cell!], 0);
    expect(p.composition?.schema).toBe("composition/1");
    expect(p.twin?.twin_framework_version).toBe("v1.5.11");
  });
  test("a cell without composition.json has none in its payload", () => {
    const r = loadCell(cellDir({}), expectCell, opts);
    expect(r.cell?.composition).toBeNull();
    const p = aggregateVersionArch("v1.0.0", "x86_64", [r.cell!], 0);
    expect("composition" in p).toBe(false);
  });
  test("a composition that is not this summary's is a validation error and is not applied", () => {
    const r = loadCell(cellDir({ "composition.json": JSON.stringify(comp()) }), expectCell, opts);
    expect(r.errors.join("\n")).toContain("does not match summary.json");
    expect(r.cell?.composition).toBeNull();
  });
  test("a malformed composition.json is a warning and the cell loads as single-dispatch", () => {
    const r = loadCell(cellDir({ "composition.json": "{not json" }), expectCell, opts);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toContain("composition.json parse failed");
    expect(r.cell?.composition).toBeNull();
  });
});
