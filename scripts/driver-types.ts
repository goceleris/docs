/**
 * driver-types — render the "supported types" tables of the driver pages from
 * the data files celeris generates from its round-trip test matrix
 * (src/data/driver-types/<driver>.json, produced by `TestSupportTable` in
 * celeris/test/conformance/<driver>; see SOURCE.json for the revision).
 *
 * The pages keep their own prose; only the blocks between
 *   <!-- driver-types:begin <driver> <block> -->
 *   <!-- driver-types:end <driver> <block> -->
 * are generated. `bun run driver-types` rewrites them, `bun run driver-types
 * --check` (and scripts/driver-types.test.ts) fails when a page differs from a
 * fresh render, so a page cannot say something the data does not.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const DATA = join(ROOT, "src", "data", "driver-types");
export const DOCS = join(ROOT, "src", "content", "docs");
export const DRIVERS = ["postgres", "redis", "memcached"] as const;
export type Driver = (typeof DRIVERS)[number];

export interface Failure {
  dest: string;
  gap: string;
  scope: string[];
}
export interface Row {
  id: string;
  label: string;
  returns?: string;
  works: string[];
  null?: string[];
  by_design?: string[];
  fails?: Failure[];
  covers?: string[];
}
export interface Section {
  id: string;
  title: string;
  rows: Row[];
}
export interface Gap {
  id: string;
  release: "v1.6.0" | "v1.6.1";
  summary: string;
  error?: string;
  fix?: string;
  issue?: string;
}
export interface Table {
  version: number;
  driver: string;
  regenerate: string;
  sections: Section[];
  gaps: Gap[];
}
/** notes.json: driver -> section id -> row id -> a plain sentence or two. */
export type Notes = Record<string, Record<string, Record<string, string>>>;

export const PAGES: Record<Driver, string> = {
  postgres: "postgres-types.md",
  redis: "redis-replies.md",
  memcached: "memcached-behavior.md",
};

/** The blocks of each page, in page order: a section id, or "gaps". */
export const BLOCKS: Record<Driver, string[]> = {
  postgres: ["column-types", "argument-kinds", "gaps"],
  redis: ["reply-types", "typed-helpers", "other", "gaps"],
  memcached: ["behaviour", "gaps"],
};

const HEADERS: Record<string, [string, string, string]> = {
  "postgres/column-types": ["Type", "How it is returned", "Notes and known gaps"],
  "postgres/argument-kinds": ["Go value you pass", "Works with these column types", "Notes and known gaps"],
  "redis/reply-types": ["Reply", "How `Do` returns it", "Notes and known gaps"],
  "redis/typed-helpers": ["Reply", "Helpers that return it", "Notes and known gaps"],
  "redis/other": ["Behavior", "What you get", "Notes and known gaps"],
  "memcached/behaviour": ["Behavior", "What you get", "Notes and known gaps"],
};

export function loadTable(driver: Driver, dir = DATA): Table {
  const t = JSON.parse(readFileSync(join(dir, `${driver}.json`), "utf8")) as Table;
  if (t.version !== 1) throw new Error(`${driver}.json: schema version ${t.version}, this script reads version 1`);
  if (t.driver !== driver) throw new Error(`${driver}.json: driver is ${t.driver}`);
  return t;
}

export function loadNotes(dir = DATA): Notes {
  return JSON.parse(readFileSync(join(dir, "notes.json"), "utf8")) as Notes;
}

// ---------------------------------------------------------------------------
// text helpers

/**
 * A pipe inside a code span still ends a table cell, so it is written \| there. A backslash
 * that sits right before such a pipe would escape it away, so those backslashes are doubled
 * first; every other backslash in a code span is literal and stays as it is.
 */
function escapeCodeSpan(part: string): string {
  return part.replace(/(\\*)\|/g, (_m, slashes: string) => `${slashes.replace(/\\/g, "\\\\")}\\|`);
}

/** Escape markdown outside backtick code spans, and pipes everywhere. */
export function md(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? escapeCodeSpan(part) : part.replace(/([\\*_\[\]<>|])/g, "\\$1")))
    .join("");
}

const code = (s: string) => "`" + s + "`";
const codeList = (xs: string[]) => xs.map(code).join(", ");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A Go value label that is one token (*string, time.Time, [16]byte) is a code span. */
function goLabel(l: string): string {
  return /^[A-Za-z0-9_.\[\]*()]+$/.test(l) ? code(l) : md(l);
}

/** A PostgreSQL type with an optional parenthesised remark: `date` (BC, a year before 1). */
function typeLabel(l: string): string {
  const m = /^(\S+)( \(.*\))?$/.exec(l);
  return m ? code(m[1]) + (m[2] ? md(m[2]) : "") : md(l);
}

// ---------------------------------------------------------------------------
// scopes: the variants a failure applies to, in a user's words

const PG_FULL: Record<string, string[]> = {
  sql: ["simple", "ext", "nocache", "prep"],
  pool: ["simple", "ext", "nocache"],
};
const API_NAME: Record<string, string> = { sql: "database/sql", pool: "the native Pool" };

function pgProtocols(set: Set<string>): string {
  const parts: string[] = [];
  if (set.has("simple")) parts.push("queries without arguments");
  if (set.has("ext") && set.has("nocache")) parts.push("queries with arguments");
  else if (set.has("ext")) parts.push("queries with arguments (cached statements)");
  else if (set.has("nocache")) parts.push("queries with arguments when `auto_cache_statements` is off");
  if (set.has("prep")) parts.push("prepared statements");
  return parts.join(" and ");
}

export function scopePhrase(driver: Driver, scopes: string[]): string {
  if (driver === "postgres") {
    const byApi: Record<string, Set<string>> = {};
    for (const s of scopes) {
      const [api, proto] = s.split("/");
      (byApi[api] ??= new Set()).add(proto);
    }
    const apis = Object.keys(byApi).sort();
    // What each api's set is: every variant, every variant that has arguments, or something else.
    const kind = (a: string): "all" | "args" | "simple" | "other" => {
      const set = byApi[a];
      if (set.size === 1 && set.has("simple")) return "simple";
      const args = PG_FULL[a].filter((p) => p !== "simple");
      if (PG_FULL[a].every((p) => set.has(p))) return "all";
      if (!set.has("simple") && args.every((p) => set.has(p))) return "args";
      return "other";
    };
    const kinds = apis.map(kind);
    const sameKind = kinds.every((k) => k === kinds[0]);
    if (apis.length === 2 && sameKind && kinds[0] === "all") return "";
    if (apis.length === 2 && sameKind && kinds[0] === "simple") return "on queries without arguments";
    if (apis.length === 2 && sameKind && kinds[0] === "args") return "on queries with arguments, including prepared statements";
    return apis
      .map((a, i) => (kinds[i] === "all" ? `with ${API_NAME[a]}` : `with ${API_NAME[a]}, on ${pgProtocols(byApi[a])}`))
      .join("; ");
  }
  if (driver === "redis") {
    const names = scopes.filter((s) => s !== "all").map((s) => ({ resp2: "RESP2", resp3: "RESP3", linux: "Linux" })[s] ?? s);
    if (names.length === 2 && names.includes("RESP2") && names.includes("RESP3")) return "";
    return names.length ? `on ${names.join(" and ")}` : "";
  }
  const names = scopes.filter((s) => s !== "all").map((s) => `the ${s} protocol`);
  return names.length === 2 ? "" : names.length ? `with ${names[0]}` : "";
}

// ---------------------------------------------------------------------------
// gaps

const prUrl = (n: string) => `https://github.com/goceleris/celeris/pull/${n.replace(/^#/, "")}`;
const issueUrl = (n: string) => `https://github.com/goceleris/celeris/issues/${n.replace(/^#/, "")}`;

/** Gaps in order of first appearance in the page, numbered from 1. */
export function gapNumbers(t: Table): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of t.sections) {
    for (const r of s.rows) {
      for (const f of r.fails ?? []) {
        if (!m.has(f.gap)) m.set(f.gap, m.size + 1);
      }
    }
  }
  return m;
}

function gapStatus(g: Gap): string {
  if (g.release === "v1.6.0") {
    return g.fix
      ? `A fix is in review for v1.6.0: [${g.fix}](${prUrl(g.fix)})${g.issue ? ` (issue [${g.issue}](${issueUrl(g.issue)}))` : ""}.`
      : `A fix is planned for v1.6.0${g.issue ? ` (issue [${g.issue}](${issueUrl(g.issue)}))` : ""}.<!-- pending: no pull request linked yet -->`;
  }
  return g.issue
    ? `Known gap, tracked for v1.6.1 in [${g.issue}](${issueUrl(g.issue)}).`
    : `Known gap, tracked for v1.6.1.<!-- pending: no issue linked yet -->`;
}

/** The gaps a table leaves without a pull request (v1.6.0) or an issue (v1.6.1): placeholders. */
export function pendingLinks(t: Table): string[] {
  return t.gaps
    .filter((g) => (g.release === "v1.6.0" ? !g.fix : !g.issue))
    .map((g) => `${t.driver}: ${g.id} (${g.release}) has no ${g.release === "v1.6.0" ? "pull request" : "issue"} linked`);
}

function renderGaps(t: Table): string {
  const nums = gapNumbers(t);
  const byNum = [...nums.entries()].sort((a, b) => a[1] - b[1]);
  const out: string[] = [];
  for (const [id, n] of byNum) {
    const g = t.gaps.find((x) => x.id === id);
    if (!g) throw new Error(`${t.driver}: gap ${id} has no entry`);
    let line = `${n}. <a id="gap-${n}"></a>${md(g.summary)}`;
    line += g.error ? ` The error is ${code(g.error)}.` : " There is no error: the value is wrong without a warning.";
    line += ` ${gapStatus(g)}`;
    out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// rows

function supported(r: Row, gaps: Map<string, Gap>): string {
  const fails = r.fails ?? [];
  if (fails.length === 0) return "Yes";
  const hasLater = fails.some((f) => gaps.get(f.gap)?.release === "v1.6.1");
  const hasEarly = fails.some((f) => gaps.get(f.gap)?.release === "v1.6.0");
  if (hasLater) {
    const base = r.works.length ? "Partly" : "No";
    return hasEarly ? `${base}, more with v1.6.0` : base;
  }
  return r.works.length ? "Yes, more with v1.6.0" : "With v1.6.0";
}

function renderRow(driver: Driver, sec: Section, r: Row, t: Table, notes: Notes): string {
  const gaps = new Map(t.gaps.map((g) => [g.id, g]));
  const nums = gapNumbers(t);
  const cells: string[] = [];
  // How it is returned / what works.
  const how: string[] = [];
  if (r.returns) how.push(md(r.returns));
  if (driver === "postgres" && sec.id === "argument-kinds") {
    how.push(r.works.length ? `Works with ${codeList(r.works)}` : "Not accepted today");
  } else if (driver === "redis" && sec.id === "typed-helpers") {
    how.push(r.works.length ? `Returns it: ${codeList(r.works)}` : "No helper returns it today");
    if (r.by_design?.length) how.push(`Returns an error on purpose: ${codeList(r.by_design)}`);
  } else if (driver === "redis" && sec.id === "reply-types") {
    // Every reply type is read with Do; the returns text says what it gives.
  } else if (r.works.length) {
    how.push(`${sec.id === "column-types" ? "Scan into" : "Methods"}: ${codeList(r.works)}`);
  }
  if (r.null?.length) how.push(`NULL: ${codeList(r.null)}`);
  // Notes: the row's own sentence, then one line per (gap, scope) group of failing destinations.
  const notesCell: string[] = [];
  const own = notes[driver]?.[sec.id]?.[r.id];
  if (own) notesCell.push(md(own));
  const groups = new Map<string, { dests: string[]; gap: string; scope: string[] }>();
  for (const f of r.fails ?? []) {
    const k = `${f.gap}|${f.scope.join(",")}`;
    const g = groups.get(k) ?? { dests: [], gap: f.gap, scope: f.scope };
    g.dests.push(f.dest);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const phrase = scopePhrase(driver, g.scope);
    const what = driver === "postgres" && sec.id === "argument-kinds" ? `Fails for ${codeList(g.dests)}` : `${codeList(g.dests)} ${plural(g.dests.length, "does", "do")} not work`;
    notesCell.push(`${what}${phrase ? ` ${phrase}` : ""} ([gap ${nums.get(g.gap)}](#gap-${nums.get(g.gap)})).`);
  }
  const lab = driver !== "postgres" ? md(r.label) : sec.id === "column-types" ? typeLabel(r.label) : goLabel(r.label);
  cells.push(lab, `${supported(r, gaps)}`, how.join("<br>"), notesCell.join("<br>"));
  // Columns: label | supported | how | notes -- header below adds "Supported".
  return `| ${cells.join(" | ")} |`;
}

function renderSection(driver: Driver, t: Table, sec: Section, notes: Notes): string {
  const h = HEADERS[`${driver}/${sec.id}`];
  if (!h) throw new Error(`no table header for ${driver}/${sec.id}`);
  const lines = [`| ${h[0]} | Supported | ${h[1]} | ${h[2]} |`, "| --- | --- | --- | --- |"];
  for (const r of sec.rows) lines.push(renderRow(driver, sec, r, t, notes));
  return lines.join("\n");
}

export function renderBlock(driver: Driver, block: string, t: Table, notes: Notes): string {
  if (block === "gaps") return renderGaps(t);
  const sec = t.sections.find((s) => s.id === block);
  if (!sec) throw new Error(`${driver}: no section ${block}`);
  return renderSection(driver, t, sec, notes);
}

// ---------------------------------------------------------------------------
// pages

const marker = (kind: "begin" | "end", driver: string, block: string) => `<!-- driver-types:${kind} ${driver} ${block} -->`;

/** The page text with every generated block replaced by a fresh render. */
export function renderPage(driver: Driver, page: string, t: Table, notes: Notes): string {
  let out = page;
  for (const block of BLOCKS[driver]) {
    const b = marker("begin", driver, block);
    const e = marker("end", driver, block);
    const i = out.indexOf(b);
    const j = out.indexOf(e);
    if (i < 0 || j < i) throw new Error(`${PAGES[driver]}: missing or misplaced markers for block ${block}`);
    out = `${out.slice(0, i + b.length)}\n${renderBlock(driver, block, t, notes)}\n${out.slice(j)}`;
  }
  return out;
}

export function pagePath(driver: Driver, dir = DOCS): string {
  return join(dir, PAGES[driver]);
}

/** Check that every note names a row that exists and every gap in the data is rendered. */
export function validate(driver: Driver, t: Table, notes: Notes): string[] {
  const errs: string[] = [];
  const n = notes[driver] ?? {};
  for (const [sec, rows] of Object.entries(n)) {
    const s = t.sections.find((x) => x.id === sec);
    if (!s) {
      errs.push(`notes: ${driver} has no section ${sec}`);
      continue;
    }
    for (const id of Object.keys(rows)) if (!s.rows.some((r) => r.id === id)) errs.push(`notes: ${driver}/${sec} has no row ${id}`);
  }
  const used = new Set(t.sections.flatMap((s) => s.rows.flatMap((r) => (r.fails ?? []).map((f) => f.gap))));
  for (const g of t.gaps) if (!used.has(g.id)) errs.push(`${driver}: gap ${g.id} is not used by any row`);
  for (const g of used) if (!t.gaps.some((x) => x.id === g)) errs.push(`${driver}: gap ${g} has no entry`);
  for (const s of t.sections) if (!BLOCKS[driver].includes(s.id)) errs.push(`${driver}: section ${s.id} has no block on the page`);
  return errs;
}

export function main(argv: string[]): number {
  const check = argv.includes("--check");
  let bad = 0;
  const notes = loadNotes();
  for (const d of DRIVERS) {
    const t = loadTable(d);
    for (const e of validate(d, t, notes)) {
      process.stderr.write(`driver-types: ${e}\n`);
      bad++;
    }
    const path = pagePath(d);
    const cur = readFileSync(path, "utf8");
    const next = renderPage(d, cur, t, notes);
    if (next !== cur) {
      if (check) {
        process.stderr.write(`driver-types: ${PAGES[d]} is out of date with src/data/driver-types/${d}.json; run \`bun run driver-types\`\n`);
        bad++;
      } else {
        writeFileSync(path, next);
        process.stderr.write(`driver-types: wrote ${PAGES[d]}\n`);
      }
    }
    for (const p of pendingLinks(t)) process.stderr.write(`driver-types: PENDING ${p}\n`);
  }
  if (argv.includes("--strict")) {
    for (const d of DRIVERS) {
      if (pendingLinks(loadTable(d)).length) bad++;
    }
  }
  return bad ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
