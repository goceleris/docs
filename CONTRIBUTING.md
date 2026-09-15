# Contributing

Thanks for helping improve the Celeris documentation and benchmark dashboard.
This repository is the source of [goceleris.dev](https://goceleris.dev).

## Running the site locally

Requires [Bun](https://bun.sh) `>= 1.3.0` (see `engines` in `package.json`).

```sh
bun install --frozen-lockfile
bun run dev      # build:data, then astro dev at http://localhost:4321
bun run demo     # same, against a synthesized demo dataset
```

Before opening a pull request, run what CI runs:

```sh
bun run validate # benchmark-cell gate: every committed results/ cell
bun run build    # build:data -> astro build -> pagefind
bun run check    # astro check (types + content schema); needs build:data first
bun test         # data-layer tests
```

`bun run validate` opens every committed `results/` cell without emitting
anything and exits non-zero if one is malformed. It is the benchmark-data
gate, and it is the one check the plain build cannot be: `bun run build` is
deliberately lenient (a bad cell is warned about, excluded and the build still
succeeds) so that one corrupt cell never takes the deploy down. It runs in the
`build` CI job and again in `Sync Benchmarks` when the publisher pushes a run.

Documentation pages live in `src/content/docs/**/*.{md,mdx}` and are validated
against the frontmatter schema described in the [README](README.md#content-structure).

## Pull-request flow

1. Fork (or branch, if you have write access) from `main`. Branch names follow
   `docs/<slug>`, `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
2. Keep one topic per pull request and use a conventional commit prefix
   (`docs:`, `feat:`, `fix:`, `chore:`, `ci:`, `deps:`) with a body that
   explains *why*.
3. Do not touch dependency versions in a content PR; Dependabot proposes those.
   `typescript` is pinned exactly to `6.0.3` on purpose (`@astrojs/check`
   breaks on TypeScript 7) — do not bump it by hand.
4. Do not edit `results/` by hand. Benchmark cells are committed by the
   probatorium publisher, and `src/data/generated/` and `public/data/` are
   gitignored build outputs.

## Merge rule

`main` is protected. A pull request merges only when:

- the `build` CI job is green (install, build, `astro check`, tests), and
- a code owner (see `.github/CODEOWNERS`) has approved it.

Every push to `main` is deployed automatically by Cloudflare Workers Builds, so
a merged PR is live within minutes — make sure the site builds and looks right
locally before merging.

## Security

Never report a vulnerability in a public issue; see [SECURITY.md](SECURITY.md).
