import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

// /llms.txt — a curated, LLM-friendly map of the site (https://llmstxt.org/).
// Generated from the docs collection at build time so it never drifts.

type Doc = CollectionEntry<"docs">;

const SITE = (import.meta.env.SITE ?? "https://goceleris.dev").replace(/\/$/, "");
const GROUP_ORDER = [
  "Getting Started",
  "Routing & Handlers",
  "Middleware",
  "Real-Time",
  "Data & Integration",
  "Reference",
  "Operations",
];

export const GET: APIRoute = async () => {
  const all = (await getCollection("docs")).filter((d: Doc) => !d.data.draft);
  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: all
      .filter((d: Doc) => d.data.group === name)
      .sort((a: Doc, b: Doc) => a.data.order - b.data.order),
  })).filter((g) => g.items.length > 0);

  const out: string[] = [];
  out.push("# Celeris");
  out.push("");
  out.push(
    "> Celeris is a high-performance HTTP engine for Go. It replaces the standard net/http server with its own asynchronous I/O core — io_uring or epoll on Linux, with an automatic standard-library fallback everywhere else — while keeping a routing and middleware API you already know from Gin and Echo.",
  );
  out.push("");
  out.push(
    "This is the goceleris.dev documentation site. Every page is plain, static HTML and crawling is welcome (see /robots.txt). For the entire documentation as one Markdown document, fetch " +
      `${SITE}/llms-full.txt.`,
  );
  out.push("");

  for (const g of groups) {
    out.push(`## ${g.name}`);
    out.push("");
    for (const it of g.items) {
      const desc = it.data.description ? `: ${it.data.description}` : "";
      out.push(`- [${it.data.title}](${SITE}/docs/${it.id})${desc}`);
    }
    out.push("");
  }

  out.push("## Benchmarks");
  out.push("");
  out.push(
    `- [Benchmarks dashboard](${SITE}/benchmarks): Interactive throughput, latency-at-SLO, tail latency, memory and CPU for Celeris vs competitor frameworks across languages, averaged over every cluster run per release.`,
  );
  out.push(
    `- [Methodology](${SITE}/methodology): How the benchmark numbers are produced — the cluster, the two run modes (saturation and rated), the signals measured, and the fairness rules.`,
  );
  out.push("");

  out.push("## Optional");
  out.push("");
  out.push(`- [Full documentation (one file)](${SITE}/llms-full.txt): Every doc page concatenated as Markdown.`);
  out.push(`- [Source — celeris](https://github.com/goceleris/celeris): The engine source on GitHub.`);
  out.push("");

  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
