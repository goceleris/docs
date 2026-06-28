#!/usr/bin/env bun
/**
 * regroup-docs — rewrite each doc's `group:` and `order:` frontmatter to the
 * curated information architecture. Idempotent; only touches those two lines.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(process.cwd(), "src", "content", "docs");

// slug -> [group, order]
const IA: Record<string, [string, number]> = {
  // Getting Started
  introduction: ["Getting Started", 1],
  "getting-started": ["Getting Started", 2],
  "core-concepts": ["Getting Started", 3],
  // Routing & Handlers
  routing: ["Routing & Handlers", 1],
  "request-handling": ["Routing & Handlers", 2],
  "binding-and-validation": ["Routing & Handlers", 3],
  responses: ["Routing & Handlers", 4],
  "error-handling": ["Routing & Handlers", 5],
  "static-files": ["Routing & Handlers", 6],
  // Middleware
  middleware: ["Middleware", 1],
  "middleware-security": ["Middleware", 2],
  "middleware-auth": ["Middleware", 3],
  "middleware-traffic": ["Middleware", 4],
  "middleware-content": ["Middleware", 5],
  "middleware-routing-helpers": ["Middleware", 6],
  // Real-Time
  streaming: ["Real-Time", 1],
  sse: ["Real-Time", 2],
  websocket: ["Real-Time", 3],
  // Data & Integration
  "data-stores": ["Data & Integration", 1],
  "net-http-interop": ["Data & Integration", 2],
  // Reference
  configuration: ["Reference", 1],
  engines: ["Reference", 2],
  "context-api-reference": ["Reference", 3],
  // Operations
  deployment: ["Operations", 1],
  "graceful-shutdown": ["Operations", 2],
  observability: ["Operations", 3],
  performance: ["Operations", 4],
  testing: ["Operations", 5],
};

let changed = 0;
const missing: string[] = [];
for (const file of readdirSync(DOCS)) {
  if (!file.endsWith(".md")) continue;
  const slug = file.replace(/\.md$/, "");
  const ia = IA[slug];
  if (!ia) {
    missing.push(slug);
    continue;
  }
  const [group, order] = ia;
  const path = join(DOCS, file);
  let src = readFileSync(path, "utf8");
  // Only operate inside the first frontmatter block.
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!m) {
    missing.push(`${slug} (no frontmatter)`);
    continue;
  }
  let fm = m[1];
  fm = /^group:/m.test(fm) ? fm.replace(/^group:.*$/m, `group: ${group}`) : `${fm}\ngroup: ${group}`;
  fm = /^order:/m.test(fm) ? fm.replace(/^order:.*$/m, `order: ${order}`) : `${fm}\norder: ${order}`;
  const next = src.replace(m[0], `---\n${fm}\n---`);
  if (next !== src) {
    writeFileSync(path, next);
    changed++;
  }
}

process.stderr.write(`regroup-docs: updated ${changed} file(s)\n`);
if (missing.length) process.stderr.write(`regroup-docs: WARN unmapped: ${missing.join(", ")}\n`);
