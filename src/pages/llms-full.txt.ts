import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

// /llms-full.txt — the entire user documentation concatenated as Markdown, so an
// LLM or agent can ingest the whole corpus in a single fetch. Built from the
// docs collection so it stays in sync with the site.

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

const rank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? 99 : i;
};

export const GET: APIRoute = async () => {
  const all = (await getCollection("docs")).filter((d: Doc) => !d.data.draft);
  const sorted = [...all].sort(
    (a: Doc, b: Doc) =>
      rank(a.data.group) - rank(b.data.group) ||
      a.data.order - b.data.order ||
      a.data.title.localeCompare(b.data.title),
  );

  const out: string[] = [];
  out.push("# Celeris — full documentation");
  out.push("");
  out.push(
    "> Celeris is a high-performance HTTP engine for Go (io_uring / epoll, with a standard-library fallback) that keeps a Gin/Echo-style routing and middleware API. This file concatenates the complete user documentation as Markdown for LLMs and agents.",
  );
  out.push("");
  out.push(`Source: ${SITE} · Benchmarks: ${SITE}/benchmarks · Methodology: ${SITE}/methodology`);
  out.push("");

  for (const d of sorted) {
    out.push("");
    out.push("---");
    out.push("");
    out.push(`# ${d.data.title}`);
    out.push("");
    if (d.data.description) {
      out.push(`> ${d.data.description}`);
      out.push("");
    }
    out.push(`Source: ${SITE}/docs/${d.id}`);
    out.push("");
    out.push((d.body ?? "").trim());
    out.push("");
  }

  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
