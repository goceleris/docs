/** Thin Preact wrapper around uPlot: sizes to container, rebuilds on data change. */
import { useEffect, useRef } from "preact/hooks";
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

export default function UplotChart({ data, options }: UplotChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const w = Math.max(120, host.clientWidth);
    const h = Math.max(120, host.clientHeight);
    const u = new uPlot({ ...options, width: w, height: h } as uPlot.Options, data, host);
    plotRef.current = u;

    const ro = new ResizeObserver(() => {
      if (!host) return;
      u.setSize({ width: Math.max(120, host.clientWidth), height: Math.max(120, host.clientHeight) });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
    // Rebuild when the data identity or option identity changes.
  }, [data, options]);

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
