import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKS,
  DATA,
  DOCS,
  DRIVERS,
  gapNumbers,
  loadNotes,
  loadTable,
  md,
  pagePath,
  PAGES,
  renderPage,
  scopePhrase,
  validate,
  type Table,
} from "./driver-types";

// The driver pages (postgres-types, redis-replies, memcached-behavior) hold
// tables generated from the data files celeris derives from its round-trip
// test matrix. These tests are the drift check: a page must equal a fresh
// render of its data, the data must be well formed, and the notes written by
// hand must still name rows that exist.

const notes = loadNotes();

for (const d of DRIVERS) {
  test(`${d}: the page is the fresh render of its data`, () => {
    const t = loadTable(d);
    const cur = readFileSync(pagePath(d), "utf8");
    expect(renderPage(d, cur, t, notes) === cur).toBe(true);
  });

  test(`${d}: data, notes and blocks agree`, () => {
    expect(validate(d, loadTable(d), notes)).toEqual([]);
  });

  test(`${d}: the page is linked from the drivers page`, () => {
    const slug = PAGES[d].replace(/\.md$/, "");
    expect(readFileSync(join(DOCS, "data-stores.md"), "utf8")).toContain(`](/docs/${slug})`);
  });

  test(`${d}: the page never prints an internal bug id`, () => {
    const t = loadTable(d);
    const page = readFileSync(pagePath(d), "utf8");
    for (const g of t.gaps) expect(page).not.toMatch(new RegExp(`\\b${g.id}\\b`));
  });

  test(`${d}: every row has a stable id and every gap a release`, () => {
    const t: Table = loadTable(d);
    for (const s of t.sections) {
      const ids = s.rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const g of t.gaps) expect(["v1.6.0", "v1.6.1"]).toContain(g.release);
  });
}

test("the pages carry exactly the blocks the renderer knows", () => {
  for (const d of DRIVERS) {
    const page = readFileSync(pagePath(d), "utf8");
    const found = [...page.matchAll(new RegExp(`<!-- driver-types:begin ${d} (\\S+) -->`, "g"))].map((m) => m[1]);
    expect(found).toEqual(BLOCKS[d]);
  }
});

test("the page files exist in the docs collection with a sidebar group", () => {
  for (const d of DRIVERS) {
    const p = join(DOCS, PAGES[d]);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toMatch(/^group: Data & Integration$/m);
  }
});

test("a gap fixed in the data disappears from the page", () => {
  // Drop the only failure of memcached's gets-empty row: the rendered page loses
  // the gap and the row turns to Yes.
  const t = loadTable("memcached");
  const row = t.sections[0].rows.find((r) => r.id === "gets-empty")!;
  row.works = ["Gets"];
  row.fails = [];
  t.gaps = [];
  const cur = readFileSync(pagePath("memcached"), "utf8");
  const next = renderPage("memcached", cur, t, notes);
  expect(next).not.toContain("cache miss");
  expect(next).toContain("| Gets on an empty value | Yes |");
});

test("gaps are numbered in order of first appearance", () => {
  const t = loadTable("postgres");
  const nums = [...gapNumbers(t).values()];
  expect(nums).toEqual(nums.map((_, i) => i + 1));
});

test("scope phrases", () => {
  expect(scopePhrase("postgres", ["pool/ext", "pool/nocache"])).toBe("with the native Pool, on queries with arguments");
  expect(scopePhrase("postgres", ["pool/ext", "pool/nocache", "sql/ext", "sql/nocache", "sql/prep"])).toBe(
    "on queries with arguments, including prepared statements",
  );
  expect(scopePhrase("postgres", ["pool/simple", "sql/simple"])).toBe("on queries without arguments");
  expect(scopePhrase("redis", ["resp2", "resp3"])).toBe("");
  expect(scopePhrase("redis", ["resp3"])).toBe("on RESP3");
  expect(scopePhrase("memcached", ["binary"])).toBe("with the binary protocol");
});

test("md escapes outside code spans and pipes everywhere", () => {
  expect(md("a *b* [c] `x|*y*` | d")).toBe("a \\*b\\* \\[c\\] `x\\|*y*` \\| d");
});

test("md keeps a backslash in a code span, and doubles one that sits before a pipe", () => {
  expect(md("`a\\r\\n`")).toBe("`a\\r\\n`");
  expect(md("`a\\|b`")).toBe("`a\\\\\\|b`");
  expect(md("`a|b`")).toBe("`a\\|b`");
});

test("the data files carry the schema version the renderer reads", () => {
  for (const d of DRIVERS) {
    expect(JSON.parse(readFileSync(join(DATA, `${d}.json`), "utf8")).version).toBe(1);
  }
});
