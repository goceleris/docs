import type { ComponentChildren, JSX } from "preact";

interface PanelProps {
  title: string;
  sub?: string;
  actions?: ComponentChildren;
  nopad?: boolean;
  children: ComponentChildren;
  style?: JSX.CSSProperties;
}

export function Panel({ title, sub, actions, nopad, children, style }: PanelProps) {
  return (
    <section class="panel" style={style}>
      <header class="panel-head">
        <div>
          <div class="panel-title">{title}</div>
          {sub && <div class="panel-sub">{sub}</div>}
        </div>
        {actions}
      </header>
      <div class={`panel-body scroll-thin${nopad ? " nopad" : ""}`}>{children}</div>
    </section>
  );
}

export function CenterNote({ children }: { children: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="empty-card">{children}</div>
    </div>
  );
}
