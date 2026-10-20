import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Guard for goceleris/celeris#891 items 14 and 28 (the kernel floors and the
// release stamp). The io_uring engine refuses every kernel before 5.19, because
// its cancels use the IORING_ASYNC_CANCEL flags that release added (celeris
// internal/engine/iouring, requireAsyncCancelFlags, celeris#682, #872), so the
// io_uring floor is 5.19. The epoll floor is 5.10 as celeris README.md states it.
// introduction.md names the current release; it is RELEASE below from the v1.6.0
// tag on. Until that tag, the docs PR that changes these lines must not merge.
const ROOT = resolve(import.meta.dir, "..");
const DOCS = join(ROOT, "src", "content", "docs");
const RELEASE = "1.6.0";

function read(file: string): string {
	return readFileSync(file, "utf8");
}

function docPages(): string[] {
	return [
		"configuration.md",
		"core-concepts.md",
		"deployment.md",
		"engines.md",
		"getting-started.md",
		"introduction.md",
		"performance.md",
	];
}

const docs = Object.fromEntries(docPages().map((f) => [f, read(join(DOCS, f))]));
const astro = read(join(ROOT, "src", "pages", "index.astro"));

// Phrases that carried the old floors (io_uring 5.10+, epoll 3.10+, the 5.12
// tier sentence, and the LTS framing) or the old release stamp. Each one is the
// exact text that stood on origin/main when this guard was written.
const STALE: string[] = [
	"| Linux 5.10+",
	"(Linux 5.10+; needs",
	"Linux 3.10+",
	"3.10+",
	"(kernel 5.10+, richer",
	"Completion-based asynchronous I/O on Linux **5.10+**",
	"| `Base`       | 5.10+",
	"A 5.12",
	"Pre-5.10",
	"pre-5.10",
	"below 5.10",
	"LTS-stable baseline",
	"LTS-stable io_uring floor",
	"known-good 5.10+ kernel",
	"(≥5.10, ideally",
	"`io_uring` engine needs kernel **5.10+**",
	"only io_uring needs 5.10+",
	"Kernel 5.10+",
	"kernel is below 5.10",
	"v1.5.8",
	"`1.5.8`",
];

// Phrases that carry the v1.6.0 floors. Each must occur in the named page.
const PRESENT: [string, RegExp][] = [
	["configuration.md", /`celeris\.IOUring`\s*\|\s*Linux 5\.19\+/],
	["core-concepts.md", /`celeris\.IOUring` \| Linux 5\.19\+/],
	["engines.md", /\*\*IOUring\*\*\s*\|[^\n]*Linux 5\.19\+/],
	["engines.md", /on Linux \*\*5\.19\+\*\*/],
	["engines.md", /\| `Base`\s+\| 5\.19\+/],
	["engines.md", /known-good 5\.19\+ kernel/],
	["engines.md", /\(5\.19 or later, ideally 6\.0 or later/],
	["engines.md", /On a Linux kernel before 5\.19 io_uring is\s+not available/],
	["getting-started.md", /`io_uring` engine needs kernel \*\*5\.19\+\*\*; the `epoll` engine needs kernel \*\*5\.10\+\*\*/],
	["deployment.md", /\*\*Kernel 5\.19\+\*\*/],
	["deployment.md", /it needs Linux 5\.10\+ and works out of the\s+box/],
	["deployment.md", /The kernel is below 5\.19/],
	["performance.md", /\(Linux 5\.19\+; needs `RLIMIT_MEMLOCK`\)/],
	["introduction.md", /tiered \*\*io_uring\*\* engine \(kernel 5\.19\+/],
	["introduction.md", new RegExp(`\\*\\*\\[\`v${RELEASE.replaceAll(".", "\\.")}\`\\]`)],
	["introduction.md", new RegExp(`\\(currently \`${RELEASE.replaceAll(".", "\\.")}\`\\)`)],
];

// Every table row that names the io_uring engine and gives a Linux floor states 5.19+, and no 5.10.
// Feature-matrix rows (no `Linux` cell) are not floor claims and are not checked.
const IOURING_ROW = /^\|\s*(`(celeris\.)?IOUring`|\*\*IOUring\*\*)/;

test("every table row for the io_uring engine states the 5.19 floor", () => {
	const bad: string[] = [];
	for (const [file, text] of Object.entries(docs)) {
		for (const line of text.split("\n")) {
			if (IOURING_ROW.test(line) && line.includes("Linux") && (!line.includes("5.19+") || line.includes("5.10"))) {
				bad.push(`${file}: ${line.trim()}`);
			}
		}
	}
	expect(bad).toEqual([]);
});

test("no docs page carries a stale kernel floor or the old release stamp", () => {
	const hits: string[] = [];
	for (const [file, text] of Object.entries(docs)) {
		for (const phrase of STALE) {
			if (text.includes(phrase)) hits.push(`${file}: ${phrase}`);
		}
	}
	expect(hits).toEqual([]);
});

test("each docs page states the v1.6.0 io_uring floor and epoll floor where it names them", () => {
	const missing = PRESENT.filter(([file, re]) => !re.test(docs[file] ?? "")).map(([file, re]) => `${file}: ${re}`);
	expect(missing).toEqual([]);
});

test("index.astro engine cards: io_uring is Linux 5.19+ and epoll is Linux 5.10+", () => {
	expect(astro).toMatch(/name: "io_uring",\s*tag: "Linux 5\.19\+"/);
	expect(astro).toMatch(/name: "epoll",\s*tag: "Linux 5\.10\+"/);
	expect(astro).not.toMatch(/name: "io_uring",\s*tag: "Linux 5\.10\+"/);
	expect(astro).not.toMatch(/name: "epoll",\s*tag: "Linux 3\.10\+"/);
});

test("introduction.md states the release on both lines, and both name the same version", () => {
	const intro = docs["introduction.md"];
	expect(intro).toContain(`**[\`v${RELEASE}\`]`);
	expect(intro).toContain(`(currently \`${RELEASE}\`)`);
});
