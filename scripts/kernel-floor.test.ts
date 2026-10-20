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
// The same file keeps the claims that review of the PR corrected: SQPOLL (no tier
// uses it, celeris#377), when Base and Optional run, what a low RLIMIT_MEMLOCK
// does to an explicit IOUring engine, and what Adaptive needs before it uses io_uring.
const ROOT = resolve(import.meta.dir, "..");
const DOCS = join(ROOT, "src", "content", "docs");
// RELEASE is the release stamp introduction.md must carry. It is deliberate that
// `bun test` fails after a version bump until this constant is edited too: the guard
// exists to force that edit, so the stamp and the text cannot drift apart. The epoll
// floor (5.10) is written in the PRESENT patterns and the header above; change them together.
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
	// Corrected after review: SQPOLL is never selected by any tier (celeris#377).
	"with SQPOLL and",
	"Adds SQPOLL and zero-copy send",
	"is consulted for SQPoll on some kernels",
	// Corrected after review: a healthy 6.x kernel runs the High strategy; Optional
	// needs 6.0+ AND a failed provided-buffers probe. Only that probe drops a tier.
	"a 6.0 or newer kernel adds",
	"only when a `High` feature probe fails",
	// Corrected after review: a low RLIMIT_MEMLOCK caps the workers (down to one); an
	// explicit IOUring engine fails only if not even one ring fits.
	"an explicit IOUring engine fails to start)",
	"an explicit `IOUring` engine fails to start instead",
	"under a forced `IOUring`\n  it fails to start",
	"io_uring setup\n  fails",
	// Corrected after review: Adaptive uses io_uring only from the 6.1+ fast tier
	// (or 6.10+), so "epoll below 5.19" understates where it stays on epoll.
	"Adaptive runs epoll on kernels below 5.19",
	"Adaptive runs epoll on them",
	"Adaptive runs\nepoll.",
	"Adaptive runs epoll there",
	// Corrected after review: the transparent fallback holds for Adaptive only.
	"must pass or Celeris transparently",
	"Celeris does **not** crash",
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
	["getting-started.md", /`io_uring` engine needs kernel \*\*5\.19\+\*\*; the `epoll` engine and `Adaptive` need kernel \*\*5\.10\+\*\*, and Adaptive uses io_uring only on a 6\.1\+ kernel/],
	["engines.md", /\*\*Adaptive\*\* \(default\) \| `celeris\.Adaptive`\s+\| Linux 5\.10\+/],
	["deployment.md", /\*\*Kernel 5\.19\+\*\*/],
	["deployment.md", /it needs Linux 5\.10\+ and works out of the\s+box/],
	["deployment.md", /The kernel is below 5\.19/],
	["performance.md", /\(Linux 5\.19\+; needs `RLIMIT_MEMLOCK`\)/],
	["introduction.md", /tiered \*\*io_uring\*\* engine \(kernel 5\.19\+, with zero-copy send\s+on 6\.0\+\)/],
	["engines.md", /Under Adaptive the\s+server runs epoll; an explicit `IOUring` engine returns the error/],
	["engines.md", /`Optional` is chosen only on 6\.0\+ when the\s+provided-buffers probe has failed/],
	["engines.md", /when the provided-buffers probe fails on a 5\.19 kernel/],
	["engines.md", /Adaptive uses io_uring only on a 6\.1\+ kernel/],
	["engines.md", /runs on fewer workers, down to one, and fails only when not even one ring fits/],
	["deployment.md", /runs on fewer workers, and fails only when not even one ring fits/],
	["deployment.md", /Under Adaptive, Celeris falls back to epoll; an explicit `IOUring` engine returns the error/],
	["getting-started.md", /Adaptive uses io_uring only on a 6\.1\+ kernel/],
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
	const tagOf = (name: string) => astro.match(new RegExp(`name: "${name}",\\s*tag: "([^"]+)"`))?.[1];
	expect(tagOf("io_uring")).toBe("Linux 5.19+");
	expect(tagOf("epoll")).toBe("Linux 5.10+");
});

test("introduction.md states the release on both lines, and both name the same version", () => {
	const intro = docs["introduction.md"];
	expect(intro).toContain(`**[\`v${RELEASE}\`]`);
	expect(intro).toContain(`(currently \`${RELEASE}\`)`);
});
