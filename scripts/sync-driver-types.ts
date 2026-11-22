#!/usr/bin/env bun
/**
 * sync-driver-types — copy the driver tables celeris generates from its
 * round-trip test matrix into src/data/driver-types/, and print the celeris
 * revision for SOURCE.json.
 *
 *   bun scripts/sync-driver-types.ts <path to a celeris checkout> [--check]
 *
 * --check compares instead of copying: it exits 1 when a file in this repo
 * differs from the one in the checkout (use it against celeris main before a
 * release). After a copy, run `bun run driver-types` to refresh the pages.
 */
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DRIVERS } from "./driver-types";

const args = process.argv.slice(2);
const celeris = args.find((a) => !a.startsWith("--"));
if (!celeris) {
  process.stderr.write("usage: bun scripts/sync-driver-types.ts <celeris checkout> [--check]\n");
  process.exit(2);
}
const check = args.includes("--check");
let differ = 0;
for (const d of DRIVERS) {
  const from = join(celeris, "test", "conformance", d, "testdata", "supported.json");
  const to = join(DATA, `${d}.json`);
  if (check) {
    if (readFileSync(from, "utf8") !== readFileSync(to, "utf8")) {
      process.stderr.write(`sync-driver-types: ${d}.json differs from ${from}\n`);
      differ++;
    }
  } else {
    copyFileSync(from, to);
    process.stderr.write(`sync-driver-types: copied ${from}\n`);
  }
}
process.exit(differ ? 1 : 0);
