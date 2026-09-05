# Security Policy

This repository builds the **goceleris.dev** static site: documentation and the
benchmark dashboard. It contains no server code and no runtime — every page is
rendered at build time and served as plain HTML from Cloudflare Workers static
assets. The security surface is therefore the build pipeline, the published
content, and the small client-side dashboard island.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

1. **Preferred:** this repository's **Security** tab → **"Report a
   vulnerability"** (private vulnerability reporting is enabled):
   <https://github.com/goceleris/docs/security/advisories/new>
2. Email **security@goceleris.dev**

Please include a description of the issue, steps to reproduce, the potential
impact, and a suggested fix if you have one.

We will acknowledge your report within **72 hours** and keep you informed as we
triage and fix it.

## Scope

In scope for this repository:

- The site build pipeline (`scripts/`, `src/lib/results/`) and the way it
  ingests the committed `results/` benchmark cells
- Published content that could mislead users about Celeris's security posture
- The client-side dashboard island under `src/dashboard/`
- Static hosting configuration (`public/_headers`, `wrangler.jsonc`)

## The engine itself

Vulnerabilities in **Celeris** — the HTTP framework and its I/O engines that this
site documents — are handled by the celeris repository's policy, which also
lists the supported versions:
<https://github.com/goceleris/celeris/blob/main/SECURITY.md>
(<https://github.com/goceleris/celeris/security/policy>).

Issues in the load generator or the benchmark harness belong to
[loadgen](https://github.com/goceleris/loadgen/security/policy) and
[probatorium](https://github.com/goceleris/probatorium/security/policy)
respectively.
