/** Horizontal bar ranking with celeris highlight, hover linking, and N/A/DNF chips. */
import type { CellStatus } from "@results/types";
import { adapterColor, adapterShort, isCeleris } from "../registry";
import { hovered } from "../state";
import { Crown, Warn } from "./Icons";

export interface BarItem {
  id: string;
  value: number | null;
  status: CellStatus;
  /** optional secondary text at the row end (e.g. Δ vs celeris). */
  note?: string;
}

interface Props {
  items: BarItem[];
  max: number;
  fmt: (n: number) => string;
  /** crown the top OK row. */
  crownTop?: boolean;
}

export function BarList({ items, max, fmt, crownTop = true }: Props) {
  const hov = hovered.value;
  let topId: string | null = null;
  if (crownTop) {
    for (const it of items) {
      if (it.value != null && (it.status === "ok" || it.status === "suspect")) {
        topId = it.id;
        break;
      }
    }
  }
  return (
    <div class="bars">
      {items.map((it) => {
        const cel = isCeleris(it.id);
        const color = adapterColor(it.id);
        const dim = hov != null && hov !== it.id;
        const pct = it.value != null && max > 0 ? Math.max(1, (it.value / max) * 100) : 0;
        const win = crownTop && it.id === topId;
        return (
          <div
            class={`bar-row${cel ? " celeris" : ""}${win ? " win" : ""}${dim ? " dim" : ""}`}
            onMouseEnter={() => (hovered.value = it.id)}
            onMouseLeave={() => (hovered.value = null)}
            title={adapterShort(it.id)}
          >
            <span class="bar-label">
              <span class="swatch" style={{ background: color }} />
              {win && <Crown s={12} style={{ color: "var(--accent)", flex: "none" }} />}
              {adapterShort(it.id)}
            </span>
            {it.value != null ? (
              <span class="bar-track">
                <span
                  class="bar-fill"
                  style={{
                    width: `${pct}%`,
                    background: cel
                      ? "linear-gradient(90deg, var(--accent-dim), var(--accent-bright))"
                      : `linear-gradient(90deg, color-mix(in oklch, ${color} 48%, transparent), ${color})`,
                    boxShadow: cel ? "0 0 14px var(--accent-glow)" : "none",
                  }}
                />
              </span>
            ) : (
              <span class="bar-track" style={{ background: "transparent" }}>
                <StatusChip status={it.status} />
              </span>
            )}
            <span class="bar-val">
              {it.value != null ? fmt(it.value) : ""}
              {it.note && <span style={{ color: "var(--text-faint)", marginLeft: 6 }}>{it.note}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function StatusChip({ status }: { status: CellStatus }) {
  if (status === "not_applicable") return <span class="chip na">N/A</span>;
  if (status === "dnf") return <span class="chip dnf">DNF</span>;
  if (status === "suspect")
    return (
      <span class="chip suspect" style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
        <Warn s={10} /> suspect
      </span>
    );
  return null;
}
