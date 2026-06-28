/** Inline SVG icons (no emojis). currentColor-driven; size via the `s` prop. */
import type { JSX } from "preact";

interface IconProps {
  s?: number;
  class?: string;
  style?: JSX.CSSProperties;
}

export function Crown({ s = 13, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" class={c} style={style} aria-hidden="true">
      <path d="M3 8.5l4.2 3.1L12 4l4.8 7.6L21 8.5 19.3 19H4.7L3 8.5z" />
    </svg>
  );
}

export function Check({ s = 13, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class={c} style={style} aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function Warn({ s = 12, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={c} style={style} aria-hidden="true">
      <path d="M12 3.5 22 20H2L12 3.5z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Cross({ s = 12, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" class={c} style={style} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Sun({ s = 18, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class={c} style={style} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </svg>
  );
}

export function Moon({ s = 18, class: c, style }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" class={c} style={style} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
