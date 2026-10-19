import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Ratchet for goceleris/celeris#891 items 8 and 10: docs cite celeris code by
// symbol (`celeris/<path>.go` (`Symbol`)), never by line number (`path.go:N`).
// ALLOW lists the pages that still carry line-number locators, with the exact
// number of locators each page still has. Each cleanup PR removes its pages
// from ALLOW; a page that reaches zero must be removed, and a count that drifts
// fails the test in either direction.
const DOCS = resolve(import.meta.dir, "..", "src", "content", "docs");
const LOCATOR = /\.go:\d+/g;
// Continuations of a .go locator that the locator count does not see. A page
// that cites a symbol must not keep the rest of an old multi-locator sentence:
//   - after a .go path on the same line: a backticked range or :N fragment
//     (`x.go:1-2`, `3-4`; `x.go` ... `:180`), or a comma list (x.go:1-2, 3-4);
//   - a range wrapped to the next line, with or without its opening backtick
//     (`x.go:1-2,` then `3-4`);
//   - a wrapped :N fragment on a line that follows a .go path (`:283`).
// A listen address such as `:8080` or `:0` is not a fragment: it is flagged
// only after a .go path on the same line, or when it opens a line that follows
// one (so reword a prose line that must start with a listen address).
const SAME_LINE = /\.go[^\n]*`(?::\d+(?:-\d+)?|\d+-\d+)`|\.go:\d+(?:-\d+)?,/;
const WRAPPED = /^\d+(?:-\d+)?`/;
const WRAPPED_AFTER_GO = /^[(\s]*`(?::\d+(?:-\d+)?|\d+-\d+)`/;

export function continuationLines(text: string): number[] {
	const lines = text.split("\n");
	const hits: number[] = [];
	lines.forEach((line, i) => {
		const prev = i > 0 ? lines[i - 1] : "";
		if (SAME_LINE.test(line) || WRAPPED.test(line) || (prev.includes(".go") && WRAPPED_AFTER_GO.test(line))) {
			hits.push(i + 1);
		}
	});
	return hits;
}

const ALLOW: Record<string, number> = {
	"binding-and-validation.md": 1,
	"context-api-reference.md": 1,
	"data-stores.md": 37,
	"deployment.md": 34,
	"engines.md": 20,
	"graceful-shutdown.md": 4,
	"middleware-auth.md": 1,
	"middleware-content.md": 25,
	"middleware-routing-helpers.md": 37,
	"middleware.md": 21,
	"net-http-interop.md": 16,
	"observability.md": 31,
	"performance.md": 36,
	"routing.md": 28,
	"sse.md": 26,
	"streaming.md": 15,
	"testing.md": 17,
};

function pages(): string[] {
	return readdirSync(DOCS).filter((f) => f.endsWith(".md") || f.endsWith(".mdx")).sort();
}

function locatorsIn(file: string): number {
	return (readFileSync(join(DOCS, file), "utf8").match(LOCATOR) ?? []).length;
}

test("no page outside ALLOW cites a celeris line number", () => {
	const offenders = pages().filter((f) => !(f in ALLOW) && locatorsIn(f) > 0);
	expect(offenders).toEqual([]);
});

test("each allowlisted page has exactly its recorded locator count", () => {
	const drift = Object.entries(ALLOW)
		.map(([f, n]) => [f, n, locatorsIn(f)] as const)
		.filter(([, want, got]) => want !== got);
	expect(drift).toEqual([]);
});

test("no page outside ALLOW carries a continuation range after a .go locator", () => {
	const hits: string[] = [];
	for (const f of pages().filter((p) => !(p in ALLOW))) {
		for (const n of continuationLines(readFileSync(join(DOCS, f), "utf8"))) hits.push(`${f}:${n}`);
	}
	expect(hits).toEqual([]);
});

// Negative controls for the detector itself: every leftover shape is flagged,
// and a listen address is not.
test("the continuation detector flags each leftover fragment shape", () => {
	const flagged = [
		"(`celeris/x/config.go` (`Config.A`) and `:180`):",
		"(`celeris/x/conn.go` (`Conn.ReadMessage`), `:411`).",
		"Source: `celeris/x/sse.go` (`New`), `:560-562`.",
		"see `celeris/x/config.go` (`Config`), `243-245`).",
		"`celeris/x/config.go` (`CLFConfig`),\n`:283`):",
		"`celeris/x/config.go` (`defaultEngine`),\n243-245`).",
		"`celeris/x/config.go` (`F`),\n`243-245`).",
		"x/config.go:13-19, 243-245",
	];
	for (const text of flagged) expect(continuationLines(text)).not.toEqual([]);
});

test("the continuation detector leaves listen addresses and plain prose alone", () => {
	const clean = [
		"An empty `Addr` becomes `:8080` (`celeris/internal/resource/config.go` (`Config.WithDefaults`)).",
		"- `:0` binds an OS-assigned ephemeral port.",
		"`celeris/x/config.go` (`CLFConfig`) and `celeris/x/config.go` (`JSONConfig`).",
	];
	const lonely = "`celeris/x/config.go` (`WithDefaults`):\n`0` falls through to the default branch.";
	expect(continuationLines(lonely)).toEqual([]);
	for (const text of clean) expect(continuationLines(text)).toEqual([]);
});
