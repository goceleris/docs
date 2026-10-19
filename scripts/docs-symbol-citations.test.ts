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
// A backticked line range after a .go path on the same line, e.g. `x.go:1-2`, `3-4`.
const CONTINUATION = /\.go[^\n]*`\d+-\d+`/;

const ALLOW: Record<string, number> = {};

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
		readFileSync(join(DOCS, f), "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (CONTINUATION.test(line)) hits.push(`${f}:${i + 1}`);
			});
	}
	expect(hits).toEqual([]);
});
