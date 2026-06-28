/** Thin Preact wrapper around uPlot: builds once per structural change, updates
 *  data in place (cheap redraw) otherwise — so unrelated re-renders don't tear
 *  down and recreate the canvas. */
import { useEffect, useMemo, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface UplotChartProps {
  data: uPlot.AlignedData;
  options: Omit<uPlot.Options, "width" | "height">;
}

export function cssVar(name: string, fallback = "#888"): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * A signature of the parts of `options` that genuinely require a full rebuild
 * (series set + per-series styling, axes count, scales, legend). It deliberately
 * excludes the data and all function identities (axis formatters, scale ranges,
 * hooks) so that a fresh options object with the same shape — the norm on every
 * render — does NOT trigger a teardown. Pin/selection changes alter a series'
 * stroke/width, which IS captured here, so those still rebuild.
 */
function optionsSig(o: Omit<uPlot.Options, "width" | "height">): string {
  const series = (o.series ?? [])
    .map((s) => `${s.label ?? ""}|${String(s.stroke ?? "")}|${s.width ?? ""}|${s.fill ? 1 : 0}|${s.points?.show ? 1 : 0}`)
    .join(";");
  const axes = (o.axes ?? []).length;
  const scales = Object.keys(o.scales ?? {}).join(",");
  const legend = o.legend && (o.legend as { show?: boolean }).show ? 1 : 0;
  return `${series}#${axes}#${scales}#${legend}`;
}

export default function UplotChart({ data, options }: UplotChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const sig = useMemo(() => optionsSig(options), [options]);

  // Build once per structural change (and on mount); the canvas + ResizeObserver
  // survive data updates.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const size = () => ({ width: Math.max(120, host.clientWidth), height: Math.max(120, host.clientHeight) });
    const u = new uPlot({ ...options, ...size() } as uPlot.Options, data, host);
    plotRef.current = u;

    const ro = new ResizeObserver(() => u.setSize(size()));
    ro.observe(host);

    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
    // Intentionally keyed on the structural signature only — options/data are
    // read fresh inside but must not retrigger a rebuild on identity change.
  }, [sig]);

  // Cheap in-place data update — no teardown/recreate.
  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div class="chart-host" ref={hostRef} />;
}

/** Shared axis/grid styling for the dark instrument theme. */
export function axisDefaults(): Partial<uPlot.Axis> {
  const stroke = cssVar("--text-faint", "#7a7a7a");
  const grid = cssVar("--border", "rgba(255,255,255,0.08)");
  return {
    stroke,
    grid: { stroke: grid, width: 1 },
    ticks: { stroke: grid, width: 1, size: 4 },
    font: '11px ui-sans-serif, system-ui, sans-serif',
  };
}
