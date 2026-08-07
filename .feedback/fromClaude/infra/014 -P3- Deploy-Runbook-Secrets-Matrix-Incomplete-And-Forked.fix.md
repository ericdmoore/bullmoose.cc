# FIX — 014 -P3- Secrets matrix incomplete; `infra/README.md` a stale fork

## The structural fix: one runbook, not two

**Delete `infra/README.md` §2 and §3 and link to `docs/DEPLOY.md`.** That file already declares
`bootstrap.mjs` the source of truth in its §1 — it should keep §1 (what bootstrap does, how to run
it) and stop duplicating the runbook it says it defers to.

This single change removes the fork that produced four separate findings in this audit.

**If the duplication must stay**, at minimum delete `infra/README.md:46` today — it instructs setting
`DEV_BEARER_TOKEN` in production, which `docs/DEPLOY.md:105` and `bootstrap.mjs:297` both warn
against, and which is an auth bypass (`auth-core/src/principal.ts:72-78`). That line is the one
item here worth fixing immediately regardless of the larger cleanup.

## Complete the matrix

Add to `docs/DEPLOY.md:91-98`: `VAULT_MASTER_KEY` (agent), `GATEWAY_TOKEN` (agent),
`GATEWAY_COMPAT_URL` (agent, optional — and state that it is currently set nowhere),
`TURNSTILE_SECRET` (demo-keys).

**Call out the `INTERNAL_TOKEN` collision explicitly**, e.g.:

> ⚠️ `demo-keys` also reads `INTERNAL_TOKEN`, but it is a **different value on purpose** — the mail
> bridge holds only that one, and it must not be able to reach the platform workers. **Do not unify
> these during a rotation.**

That sentence is the whole point of the row; without it a future rotation quietly merges two trust
boundaries.

## A cheap guard worth adding

A preflight check (`tools/preflight.mjs` already exists and is referenced at `docs/DEPLOY.md:43`)
that greps each worker's source for `env.<NAME>` references and diffs against the documented matrix.
Then "undocumented secret" becomes a failing check instead of an audit finding.

## Bread-crumbs

- Verify `GATEWAY_COMPAT_URL` is genuinely optional before documenting it as such —
  `services/agent/src/models.ts:83-89` is the consumer to read.
- The four random secrets bootstrap generates (`bootstrap.mjs:62,72` and around `DEPLOY.md:83-84`)
  should be enumerated in one place; right now the count "four" is stated but the list is spread
  across three files.
