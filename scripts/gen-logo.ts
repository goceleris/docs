#!/usr/bin/env bun
/**
 * gen-logo — export the Celeris mark as square PNGs + an SVG for reuse
 * (e.g. the GitHub org avatar), so the brand matches the site.
 *   public/brand/celeris-avatar.svg   (vector)
 *   public/brand/celeris-avatar-1024.png
 *   public/brand/celeris-avatar-512.png
 */
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Full-bleed square (no baked rounding, no transparent corners): GitHub applies
// its own corner radius and sizing, so the artwork must fill the entire canvas.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1b2128"/>
      <stop offset="100%" stop-color="#11151a"/>
    </linearGradient>
    <radialGradient id="glow" cx="74%" cy="18%" r="85%">
      <stop offset="0%" stop-color="#7ee787" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="#7ee787" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" fill="url(#bg)"/>
  <rect x="0" y="0" width="512" height="512" fill="url(#glow)"/>
  <g stroke="#7ee787" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M128 168 L216 256 L128 344" opacity="0.42"/>
    <path d="M212 168 L300 256 L212 344" opacity="0.72"/>
    <path d="M296 168 L384 256 L296 344"/>
  </g>
</svg>`;

const dir = join(process.cwd(), "public", "brand");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "celeris-avatar.svg"), svg);
await sharp(Buffer.from(svg)).resize(1024, 1024).png().toFile(join(dir, "celeris-avatar-1024.png"));
await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(join(dir, "celeris-avatar-512.png"));
process.stderr.write("gen-logo: wrote public/brand/celeris-avatar.{svg,-1024.png,-512.png}\n");
