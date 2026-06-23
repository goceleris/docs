// @ts-check
import { defineConfig } from "astro/config";
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
  integrations: [
    mdx(),
    preact({ compat: false }),
    sitemap(),
  ],
  markdown: {
    // Dark "instrument" syntax theme to match the site shell. Shiki runs at
    // build time, so highlighted code ships as plain HTML (zero client JS).
    shikiConfig: {
      theme: "github-dark-default",
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
