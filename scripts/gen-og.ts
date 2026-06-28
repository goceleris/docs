#!/usr/bin/env bun
/**
 * gen-og — render the default Open Graph image (1200×630) to public/og/default.png.
 * One-off; re-run if the brand changes. Committed as a static asset.
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="78%" cy="0%" r="80%">
      <stop offset="0%" stop-color="#7ee787" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#7ee787" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7ee787"/>
      <stop offset="100%" stop-color="#79c0ff"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#14181e"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(96,150)">
    <rect x="0" y="0" width="84" height="84" rx="22" fill="#222831" stroke="#3a424d" stroke-width="2"/>
    <g stroke="#7ee787" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M24 27 L40 43 L24 59" opacity="0.45"/>
      <path d="M38 27 L54 43 L38 59" opacity="0.72"/>
      <path d="M52 27 L68 43 L52 59"/>
    </g>
    <text x="108" y="62" font-family="Inter, Helvetica, Arial, sans-serif" font-size="64" font-weight="800" fill="#f4f6f8" letter-spacing="-2">celeris</text>
  </g>
  <text x="96" y="372" font-family="Inter, Helvetica, Arial, sans-serif" font-size="74" font-weight="800" fill="#f4f6f8" letter-spacing="-3">High-performance</text>
  <text x="96" y="456" font-family="Inter, Helvetica, Arial, sans-serif" font-size="74" font-weight="800" letter-spacing="-3">
    <tspan fill="#f4f6f8">HTTP for</tspan><tspan fill="url(#grad)" dx="22">Go</tspan><tspan fill="#7ee787">.</tspan>
  </text>
  <text x="96" y="540" font-family="Inter, Helvetica, Arial, sans-serif" font-size="30" font-weight="400" fill="#9aa4af">io_uring &amp; epoll engine · zero-allocation · cross-language benchmarks</text>
</svg>`;

mkdirSync(join(process.cwd(), "public", "og"), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(join(process.cwd(), "public", "og", "default.png"));
process.stderr.write("gen-og: wrote public/og/default.png\n");
