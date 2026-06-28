// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import mdx from "@astrojs/mdx";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";

// Canonical site URL drives sitemap, canonical links and Open Graph absolute
// URLs. Overridable via the SITE_URL env var (e.g. for preview deployments).
const SITE_URL = process.env.SITE_URL || "https://goceleris.dev";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  output: "static",
  trailingSlash: "ignore",
  // Prefetch internal links on hover/focus (and on touchstart for tap devices)
  // so the next page's HTML is already in cache by the time the user clicks.
  // Combined with the immutable caching of shared /_astro/* assets, navigation
  // only needs the new page's HTML — which is then already prefetched.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    mdx(),
    preact({ compat: false }),
    sitemap(),
  ],
  // Self-hosted, subset, woff2 — emitted at build time with metric-override
  // fallbacks (zero runtime JS, no third-party request). Exposed as CSS vars
  // consumed by --font-sans / --font-mono in tokens.css.
  experimental: {
    fonts: [
      {
        provider: fontProviders.google(),
        name: "Inter",
        cssVariable: "--font-inter",
        weights: [400, 600],
        styles: ["normal"],
        subsets: ["latin"],
        fallbacks: ["system-ui", "sans-serif"],
      },
      {
        provider: fontProviders.google(),
        name: "JetBrains Mono",
        cssVariable: "--font-jetbrains-mono",
        weights: [400, 500],
        styles: ["normal"],
        subsets: ["latin"],
        fallbacks: ["ui-monospace", "monospace"],
      },
    ],
  },
  markdown: {
    // Dual syntax themes: github-dark by default (the dark shell), github-light
    // under [data-theme="light"]. defaultColor:"dark" makes the dark theme the
    // inline default; CSS swaps to the light vars in light mode. Shiki runs at
    // build time, so highlighted code ships as plain HTML (zero client JS).
    shikiConfig: {
      themes: {
        dark: "github-dark-default",
        light: "github-light-default",
      },
      defaultColor: "dark",
      wrap: false,
    },
  },
  vite: {
    build: {
      // The dashboard island is the only meaningful JS bundle; keep chunks lean.
      assetsInlineLimit: 2048,
    },
  },
});
