/**
 * Adapter + scenario taxonomy.
 *
 * Scenario category/protocol are DERIVED from the id using rules anchored to
 * probatorium's naming (probatorium/scenarios/*.go). Adapter display names and
 * brand colors are an EDITORIAL overlay (concrete hex so they render identically
 * in CSS, SVG and canvas/uPlot). Anything not in the overlay still gets a sane
 * fallback (prettified id + language hue), so a new adapter appears automatically.
 */
import type {
  AdapterMeta,
  CategoryMeta,
  LanguageMeta,
  RawServerResult,
  ScenarioCategory,
  ScenarioMeta,
} from "./types";
import { CELERIS_CATEGORY } from "./walk";

export const LANGUAGES: Record<string, LanguageMeta> = {
  go: { id: "go", display: "Go", color: "#58a6ff" },
  rust: { id: "rust", display: "Rust", color: "#f59e0b" },
  cpp: { id: "cpp", display: "C++", color: "#a78bfa" },
  c: { id: "c", display: "C", color: "#f472b6" },
  python: { id: "python", display: "Python", color: "#3776ab" },
  csharp: { id: "csharp", display: "C#", color: "#9d4edd" },
  java: { id: "java", display: "Java / JVM", color: "#ef6c4d" },
  node: { id: "node", display: "Node.js", color: "#84cc16" },
  bun: { id: "bun", display: "Bun / TS", color: "#eab308" },
  zig: { id: "zig", display: "Zig", color: "#f7a41d" },
  celeris: { id: "celeris", display: "Celeris", color: "#7ee787" },
};

export const CATEGORY_META: Record<ScenarioCategory, CategoryMeta> = {
  static: { display: "Static", order: 1 },
  concurrency: { display: "Concurrency", order: 2 },
  chain: { display: "Chain / Middleware", order: 3 },
  driver: { display: "Driver", order: 4 },
  ws: { display: "WebSocket", order: 5 },
  sse: { display: "SSE", order: 6 },
  tls: { display: "TLS", order: 7 },
};

interface AdapterOverlay {
  display_name: string;
  short_name: string;
  color: string;
  retired?: boolean;
}

/** Editorial overlay. Colors grouped by language hue; celeris = the brand greens. */
const ADAPTER_OVERLAY: Record<string, AdapterOverlay> = {
  // Celeris engine variants — the brand greens (each engine a distinct shade).
  "celeris-iouring-h1-async": { display_name: "Celeris · io_uring H1 (async)", short_name: "Celeris io_uring", color: "#7ee787" },
  "celeris-iouring-h1-sync": { display_name: "Celeris · io_uring H1 (sync)", short_name: "Celeris io_uring sync", color: "#56d364" },
  "celeris-iouring-auto+upg-async": { display_name: "Celeris · io_uring auto+h2c (async)", short_name: "Celeris io_uring auto", color: "#46e0a0" },
  "celeris-epoll-h1-async": { display_name: "Celeris · epoll H1 (async)", short_name: "Celeris epoll", color: "#3fb950" },
  "celeris-epoll-h1-sync": { display_name: "Celeris · epoll H1 (sync)", short_name: "Celeris epoll sync", color: "#2ea043" },
  "celeris-epoll-auto+upg-async": { display_name: "Celeris · epoll auto+h2c (async)", short_name: "Celeris epoll auto", color: "#4ade80" },
  "celeris-adaptive-h1-async": { display_name: "Celeris · adaptive H1 (async)", short_name: "Celeris adaptive", color: "#6ee7b7" },
  "celeris-adaptive-auto+upg-async": { display_name: "Celeris · adaptive auto+h2c (async)", short_name: "Celeris adaptive auto", color: "#34d399" },
  "celeris-std-h1": { display_name: "Celeris · std H1", short_name: "Celeris std", color: "#238636" },

  // Go — net/http stdlib + routers (blues/cyans).
  "stdhttp-h1": { display_name: "net/http (H1)", short_name: "net/http", color: "#58a6ff" },
  "stdhttp-h2": { display_name: "net/http (h2c)", short_name: "net/http h2c", color: "#79c0ff" },
  "stdhttp-hybrid": { display_name: "net/http (hybrid)", short_name: "net/http hybrid", color: "#a5d6ff" },
  "gin-h1": { display_name: "Gin (H1)", short_name: "Gin", color: "#39c5cf" },
  "gin-h2": { display_name: "Gin (h2c)", short_name: "Gin h2c", color: "#56d4dd" },
  "echo-h1": { display_name: "Echo (H1)", short_name: "Echo", color: "#2dd4bf" },
  "echo-h2": { display_name: "Echo (h2c)", short_name: "Echo h2c", color: "#5eead4" },
  "chi-h1": { display_name: "chi (H1)", short_name: "chi", color: "#38bdf8" },
  "chi-h2": { display_name: "chi (h2c)", short_name: "chi h2c", color: "#7dd3fc" },
  "iris-h1": { display_name: "Iris (H1)", short_name: "Iris", color: "#818cf8" },
  "iris-h2": { display_name: "Iris (h2c)", short_name: "Iris h2c", color: "#a5b4fc" },
  "hertz-h1": { display_name: "Hertz (H1)", short_name: "Hertz", color: "#22d3ee" },
  "hertz-h2": { display_name: "Hertz (h2c)", short_name: "Hertz h2c", color: "#67e8f9" },
  "fasthttp-h1": { display_name: "fasthttp (H1)", short_name: "fasthttp", color: "#0ea5e9" },
  "fiber-h1": { display_name: "Fiber (H1)", short_name: "Fiber", color: "#0284c7" },
  "gnet-h1": { display_name: "gnet (H1)", short_name: "gnet", color: "#14b8a6" },
  "nbio-h1": { display_name: "nbio (H1)", short_name: "nbio", color: "#1f6feb" },
  "gorilla_ws": { display_name: "gorilla/websocket", short_name: "gorilla", color: "#2563eb" },

  // Rust (oranges/ambers).
  actix: { display_name: "Actix", short_name: "Actix", color: "#f97316" },
  axum: { display_name: "Axum", short_name: "Axum", color: "#f59e0b" },
  "axum-h2": { display_name: "Axum (h2c)", short_name: "Axum h2", color: "#fbbf24" },
  hyper: { display_name: "Hyper", short_name: "Hyper", color: "#ea580c" },
  "hyper-h2": { display_name: "Hyper (h2c)", short_name: "Hyper h2", color: "#fdba74" },
  ntex: { display_name: "ntex", short_name: "ntex", color: "#fb923c" },

  // C++ / C.
  drogon: { display_name: "Drogon (C++)", short_name: "Drogon", color: "#a78bfa" },
  lithium: { display_name: "Lithium (C++)", short_name: "Lithium", color: "#c4b5fd" },
  h2o: { display_name: "H2O (C)", short_name: "H2O", color: "#f472b6" },

  // Python.
  fastapi: { display_name: "FastAPI", short_name: "FastAPI", color: "#3776ab" },
  "fastapi-h2": { display_name: "FastAPI (h2c)", short_name: "FastAPI h2", color: "#5b8fc7" },
  starlette: { display_name: "Starlette", short_name: "Starlette", color: "#2b6cb0" },

  // C# / Java (JVM).
  aspnet: { display_name: "ASP.NET Core", short_name: "ASP.NET", color: "#9d4edd" },
  netty: { display_name: "Netty (Java)", short_name: "Netty", color: "#ef6c4d" },
  vertx: { display_name: "Vert.x (Java)", short_name: "Vert.x", color: "#ff8a65" },

  // Bun / TS.
  hono: { display_name: "Hono (Bun)", short_name: "Hono", color: "#eab308" },
  "hono-h2": { display_name: "Hono (Bun, h2c)", short_name: "Hono h2", color: "#facc15" },
  elysia: { display_name: "Elysia (Bun)", short_name: "Elysia", color: "#ca8a04" },
  "elysia-h2": { display_name: "Elysia (Bun, h2c)", short_name: "Elysia h2", color: "#d4a017" },
  bunraw: { display_name: "Bun (raw)", short_name: "Bun raw", color: "#fde047" },

  // Node.js.
  express: { display_name: "Express", short_name: "Express", color: "#84cc16" },
  fastify: { display_name: "Fastify", short_name: "Fastify", color: "#a3e635" },
  uws: { display_name: "uWebSockets.js", short_name: "uWS", color: "#4d7c0f" },

  // Retired.
  zig_zap: { display_name: "Zap (Zig)", short_name: "Zap", color: "#f7a41d", retired: true },
};

export function serverName(sr: RawServerResult): string {
  return sr.name || sr.server || "unknown";
}

// Low-level networking/HTTP libraries (NOT full web frameworks) and the stdlib —
// excluded when comparing Celeris to the "next-best full framework".
const LIB_IDS = new Set([
  "gnet-h1", "fasthttp-h1", "nbio-h1", "gorilla_ws",
  "hyper", "hyper-h2", "h2o", "lithium", "uws", "bunraw",
]);
const STDLIB_IDS = new Set(["stdhttp-h1", "stdhttp-h2", "stdhttp-hybrid"]);

function adapterKind(id: string, isCeleris: boolean): AdapterMeta["kind"] {
  if (isCeleris) return "framework";
  if (STDLIB_IDS.has(id)) return "stdlib";
  if (LIB_IDS.has(id)) return "lib";
  return "framework";
}

function prettify(id: string): string {
  return id
    .replace(/[-_+]/g, " ")
    .replace(/\bh1\b/i, "H1")
    .replace(/\bh2c?\b/i, "h2c")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Adapter protocol family from the engine string. */
export function adapterProtocol(engine: string | undefined): string {
  const e = (engine || "").toLowerCase();
  if (e.includes("auto") || e.includes("hybrid")) return "auto";
  if (e.includes("h2")) return "h2c";
  return "h1";
}

export function buildAdapterMeta(sr: RawServerResult): AdapterMeta {
  const id = serverName(sr);
  const overlay = ADAPTER_OVERLAY[id];
  const language = (sr.language || "").toLowerCase() || "go";
  const isCeleris = sr.category === CELERIS_CATEGORY || id.startsWith("celeris");
  const langKey = isCeleris ? "celeris" : language;
  const fallbackColor = LANGUAGES[langKey]?.color || "#8b949e";
  return {
    id,
    display_name: overlay?.display_name || prettify(id),
    short_name: overlay?.short_name || prettify(id),
    category: sr.category || "",
    language,
    language_version: sr.language_version || "",
    framework: sr.framework || "",
    framework_version: sr.framework_version || "",
    engine: sr.engine || "",
    protocol: adapterProtocol(sr.engine),
    is_celeris: isCeleris,
    kind: adapterKind(id, isCeleris),
    color: overlay?.color || fallbackColor,
    retired: overlay?.retired || false,
  };
}

const CHAIN_PROFILES = ["api", "auth", "security", "fullstack"];

/** Scenario category from id (anchored to probatorium scenario naming). */
export function scenarioCategory(id: string): ScenarioCategory {
  if (id.startsWith("chain-")) return "chain";
  if (id.startsWith("driver-")) return "driver";
  if (id.startsWith("ws-")) return "ws";
  if (id.startsWith("sse-")) return "sse";
  if (id.startsWith("tls-")) return "tls";
  if (id.startsWith("auto-mix")) return "concurrency";
  if (/-\d+c$/.test(id)) return "concurrency"; // any -<N>c connection sweep
  return "static";
}

/** Connection count for a concurrency scenario (auto-mix sorts last); null otherwise. */
function concurrencyCount(id: string): number | null {
  if (id.startsWith("auto-mix")) return Number.MAX_SAFE_INTEGER;
  const m = /-(\d+)c$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Order scenarios by category, then within concurrency by connection count (1c, 128c, 256c …). */
export function scenarioCmp(a: string, b: string): number {
  const oa = CATEGORY_META[scenarioCategory(a)].order;
  const ob = CATEGORY_META[scenarioCategory(b)].order;
  if (oa !== ob) return oa - ob;
  const na = concurrencyCount(a);
  const nb = concurrencyCount(b);
  if (na != null && nb != null && na !== nb) return na - nb;
  return a.localeCompare(b);
}

export function scenarioProtocol(id: string): string {
  if (id.startsWith("tls-")) return "tls";
  if (id.startsWith("auto-mix")) return "mixed";
  if (/-h2$/.test(id)) return "h2c";
  return "h1";
}

function payloadHint(id: string): string | undefined {
  if (/-1m\b/.test(id)) return "1m";
  if (/-64k/.test(id)) return "64k";
  if (/-1k\b/.test(id)) return "1k";
  if (/-4k\b/.test(id)) return "4k";
  if (id.includes("json")) return "json";
  return undefined;
}

function concurrencyHint(id: string): string | undefined {
  const m = /-(1c|128c|1024c)$/.exec(id);
  return m ? m[1] : undefined;
}

export function buildScenarioMeta(id: string): ScenarioMeta {
  const category = scenarioCategory(id);
  const meta: ScenarioMeta = {
    id,
    display_name: prettify(id).replace(/\s+/g, " ").trim(),
    category,
    protocol: scenarioProtocol(id),
    payload_hint: payloadHint(id),
    concurrency_hint: concurrencyHint(id),
  };
  if (category === "chain") {
    const parts = id.split("-"); // chain-<profile>-<workload...>
    const profile = parts[1];
    if (CHAIN_PROFILES.includes(profile)) {
      meta.chain_profile = profile;
      meta.workload = parts.slice(2).join("-");
      meta.display_name = `Chain · ${profile} · ${prettify(meta.workload)}`;
    }
  }
  return meta;
}
