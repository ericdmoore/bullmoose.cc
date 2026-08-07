# FIX — 011 -P1- CI deploys 4 of 7 workers, never runs tests

## A. Add the missing deploy steps

Add `agent` and `anglebrackets` to `.github/workflows/deploy-mail.yml`, in the **corrected order**
(see issue `012` — `ingest` binds `AGENT`, so `agent` must precede it):

```
submit → jmap → agent → ingest → provision → anglebrackets
```

`demo-keys` is deliberately separate — see issue `013` before adding it.

**Better still: stop maintaining the order twice.** `infra/bootstrap.mjs:49` already holds
`DEPLOY_ORDER`. Have the workflow call the bootstrap's deploy path, or generate the steps from it, so
the list cannot drift again. Two hand-maintained copies is how this happened.

## B. Run the tests

```yaml
# mail-typecheck.yml — rename the job to "verify"
- run: npm ci
- run: npm run typecheck
- run: npm test          # ← add

# deploy-mail.yml — gate before the first deploy step
- run: npm run typecheck
- run: npm test          # ← add
```

The suite is ~19 tests and runs in well under a second, so there is no cost argument.

## C. Typecheck the tests

Drop `**/*.test.ts` from `tsconfig.json:33`. It was added so `tsc --noEmit` wouldn't choke on vitest
globals — if that resurfaces, add `"types": ["vitest/globals"]` or a `tsconfig.test.json` rather than
excluding them. Test code that doesn't typecheck is test code that silently stops testing.

**Also worth including in the vitest glob:** `infra/**/*.test.ts`. `infra/bootstrap.mjs:133-138`
documents `wireText` as "Pure + exported so it can be unit-tested without touching real files" — but
`vitest.config.ts:9` only includes `packages/**` and `services/**`, so the one function that rewrites
committed `wrangler.jsonc` files by regex is structurally unreachable by the runner.

## Bread-crumbs

- Deploying `agent`/`anglebrackets` for the first time via CI may surface first-deploy ordering
  issues (issue `012`) — do a manual deploy of each once before trusting the workflow.
- `coverage.yml` should stay manual (`workflow_dispatch`); that was a deliberate choice and is fine.
  This issue is about the *gating* workflows.
