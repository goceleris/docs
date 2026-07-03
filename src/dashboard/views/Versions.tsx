import { useEffect, useState } from "preact/hooks";
import { arch, scenario, versionsList, warmAllVersions, cachedPayload, payload } from "../state";
import { Panel, CenterNote } from "../components/Panel";
import { celerisIds, scenarioName } from "../registry";
import { fmtRps } from "../format";

/* One line per Celeris engine family (best variant of each), tracing saturation
   RPS across releases. Distinct, theme-aware colors + a value/delta legend, so
   the per-engine evolution (e.g. a big adaptive jump) is legible at a glance. */
const FAMILY_DEFS = [
  { key: "iouring", label: "io_uring", color: "var(--vt-iouring)" },
  { key: "epoll", label: "epoll", color: "var(--vt-epoll)" },
  { key: "adaptive", label: "adaptive", color: "var(--vt-adaptive)" },
  { key: "std", label: "std", color: "var(--vt-std)" },
];

const pct = (a: number, b: number) => ((b - a) / a) * 100;
const fmtPct = (p: number) => (Math.abs(p) < 0.05 ? "±0%" : (p > 0 ? "+" : "−") + Math.abs(p).toFixed(1) + "%");
function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 1.2 ? 1.2 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return m * p;
}

export function Versions() {
  const [, force] = useState(0);
  useEffect(() => {
    void warmAllVersions().then(() => force((n) => n + 1));
  }, [arch.value]);
  void payload.value;

  const scn = scenario.value;
  const A = arch.value;
  const versions = [...versionsList.value].reverse(); // ascending, e.g. v1.5.5 → v1.5.6

  if (versions.length < 2) {
    return (
      <Panel title="Version trend">
        <CenterNote>
          <h2>Trend appears with a second version</h2>
          <p>Once another Celeris version is published, this charts throughput across releases.</p>
        </CenterNote>
      </Panel>
    );
  }

  const cels = celerisIds();
  const rpsOf = (id: string, vi: number) =>
    cachedPayload(versions[vi], A)?.servers[id]?.scenarios[scn]?.saturation_rps?.mean ?? null;
  const maxOf = (ids: string[], vi: number) => {
    const vals = ids.map((id) => rpsOf(id, vi)).filter((v): v is number => v != null && isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  };

  const families = FAMILY_DEFS.map((f) => ({
    ...f,
    ys: versions.map((_, vi) => maxOf(cels.filter((id) => id.includes(f.key)), vi)),
  })).filter((f) => f.ys.some((v) => v != null));

  const title = `Version trend · ${scenarioName(scn)}`;
  const sub = `best RPS per Celeris engine across releases · ${A}`;
  if (families.length === 0) {
    return (
      <Panel title={title} sub={sub}>
        <CenterNote>No Celeris data for this scenario across versions.</CenterNote>
      </Panel>
    );
  }

  // ---- geometry ----
  const W = 960;
  const H = 440;
  const pad = { l: 78, r: 184, t: 40, b: 48 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const n = versions.length;
  const latest = n - 1;
  const X = (vi: number) => pad.l + (n === 1 ? pw / 2 : (vi / (n - 1)) * pw);
  const yMax = niceMax(Math.max(...families.flatMap((f) => f.ys).filter((v): v is number => v != null)) * 1.06);
  const Y = (v: number) => pad.t + ph - (v / yMax) * ph;
  const ticks = [0, 1, 2, 3, 4].map((i) => (yMax / 4) * i);
  const linePath = (ys: (number | null)[]) =>
    ys.map((v, vi) => (v == null ? "" : `${vi === 0 ? "M" : "L"}${X(vi)},${Y(v)}`)).join(" ");
  const lx = pad.l + pw + 30;

  return (
    <Panel title={title} sub={sub}>
      <div style={{ height: "100%", minHeight: "360px", display: "flex" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
          {/* grid + axes */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} y1={Y(t)} x2={pad.l + pw} y2={Y(t)} stroke="var(--border)" stroke-width="1" opacity={t === 0 ? 0.9 : 0.4} />
              <text x={pad.l - 12} y={Y(t)} text-anchor="end" dominant-baseline="middle" font-family="var(--font-mono)" font-size="12.5" fill="var(--text-faint)">
                {fmtRps(t)}
              </text>
            </g>
          ))}
          {versions.map((v, vi) => (
            <text key={v} x={X(vi)} y={pad.t + ph + 27} text-anchor="middle" font-family="var(--font-mono)" font-size="13.5" font-weight="500" fill="var(--text-muted)">
              {v}
            </text>
          ))}

          {/* engine lines */}
          {families.map((f) => (
            <path key={f.key} d={linePath(f.ys)} fill="none" stroke={f.color} stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
          ))}
          {families.map((f) =>
            f.ys.map((v, vi) =>
              v == null ? null : <circle key={f.key + vi} cx={X(vi)} cy={Y(v)} r="4.6" fill="var(--surface-1)" stroke={f.color} stroke-width="2.8" />,
            ),
          )}

          {/* legend: swatch · engine · latest value · release delta */}
          {families.map((f, i) => {
            const fy = pad.t + 10 + i * 40;
            const a = f.ys.find((v) => v != null) ?? null;
            const b = f.ys[latest];
            const d = a != null && b != null ? pct(a, b) : null;
            const up = d != null && d >= 0.05;
            return (
              <g key={f.key}>
                <rect x={lx} y={fy} width="15" height="15" rx="3.5" fill={f.color} />
                <text x={lx + 24} y={fy + 7.5} dominant-baseline="middle" font-family="var(--font-mono)" font-size="13.5" fill="var(--text)">
                  {f.label}
                </text>
                <text x={lx + 24} y={fy + 26} dominant-baseline="middle" font-family="var(--font-mono)" font-size="12.5" fill="var(--text-muted)">
                  {b != null ? fmtRps(b) : "—"}
                  {d != null && (
                    <tspan dx="8" font-weight="700" fill={up ? "var(--accent-text)" : "var(--text-faint)"}>
                      {fmtPct(d)}
                    </tspan>
                  )}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </Panel>
  );
}
