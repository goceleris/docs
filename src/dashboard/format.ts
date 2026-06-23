/** Display formatting for dashboard metrics. */

export function fmtRps(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

export function fmtInt(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function nsToMs(ns: number | undefined | null): number | null {
  if (ns == null || !Number.isFinite(ns)) return null;
  return ns / 1_000_000;
}

export function fmtMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  return `${(ms * 1000).toFixed(0)} µs`;
}

export function fmtNsAsMs(ns: number | undefined | null): string {
  return fmtMs(nsToMs(ns));
}

export function fmtPct(p: number | undefined | null, dp = 1): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(dp)}%`;
}

/** Signed percentage delta of `a` vs `b` (e.g. celeris vs rival), like "+38%". */
export function fmtDelta(a: number, b: number): string {
  if (!b) return "—";
  const d = ((a - b) / b) * 100;
  const s = d >= 0 ? "+" : "";
  return `${s}${d.toFixed(0)}%`;
}

export function fmtDateCompact(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}
