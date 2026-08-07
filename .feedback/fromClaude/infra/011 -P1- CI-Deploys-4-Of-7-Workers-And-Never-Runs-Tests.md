# 011 -P1- CI deploys 4 of 7 workers and never runs the test suite

**Subsystem:** cloud-infra · **Severity:** HIGH · **Fix class:** CHANGE-CODE

Two defects in the same file, both "CI silently does less than it appears to".

## A. `deploy-mail.yml` ships 4 of 7 workers

Seven workers have a `wrangler.jsonc`: `agent`, `anglebrackets`, `demo-keys`, `ingest`, `jmap`,
`provision`, `submit`. Verified.

`.github/workflows/deploy-mail.yml:22-41` deploys exactly **four**: submit, jmap, ingest, provision.
Grep for `agent|anglebrackets` across `.github/workflows/` returns nothing. The workflow's own
comment at `:20-21` narrates a 4-worker order **as if it were complete**.

But `docs/DEPLOY.md:152-153` presents this workflow as the automation of §2's 6-worker deploy.

**Why it bites:** `anglebrackets` owns the client-facing custom domain `dav.bullmoose.cc`
(`services/anglebrackets/wrangler.jsonc:10`). Once CI becomes the deploy path, DAV and the agent
runtime go stale against a moving `AccountDO`/D1 schema **with no signal** — the deploy is green.

## B. No workflow runs `npm test`

- `package.json:10` — `"test": "vitest run"`; `vitest.config.ts:9` collects `packages/**/*.test.ts`
  and `services/**/*.test.ts`.
- `.github/workflows/mail-typecheck.yml:27-28` runs `npm ci` + `npm run typecheck` **only**.
- `.github/workflows/deploy-mail.yml:17-18` typechecks, then **deploys to production**, without
  running a single test.
- `.github/workflows/coverage.yml:5-6` is `workflow_dispatch` and its own header says it "does NOT
  gate pushes or PRs."

A deploy workflow that skips the suite it ships with is the deficiency, independent of suite size —
and the suite currently includes the MCP auth-gate regression tests (`services/agent/src/mcp.test.ts`
cases 7–10) that guard a security boundary.

## C. Tests are excluded from the only gate that *does* run

`tsconfig.json:33` excludes `**/*.test.ts`. Since `npm run typecheck` is the sole CI gate, **type
errors in test files cannot fail anything** — and vitest does not typecheck.
