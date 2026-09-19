## Summary

What changes and why.

## Changes

-

## Test Plan

The `build` CI job runs these same steps, in this order:

- [ ] `bun install --frozen-lockfile`
- [ ] `bun run validate` (benchmark-cell gate: exits non-zero on a malformed cell instead of dropping it)
- [ ] `bun run build` (data layer, `astro build`, pagefind)
- [ ] `bun run check` (`astro check`: types and content schema)
- [ ] `bun test` (data layer)
- [ ] Looked at the affected pages locally (`bun run dev`, or `bun run demo` for fixture data)

Closes #
