# 012 -P2- The documented "deploy order = binding graph" contradicts an actual binding

**Subsystem:** cloud-infra · **Severity:** MEDIUM-HIGH · **Fix class:** CHANGE-CODE + UPDATE-DOC

## The claim, made in four places

> "Deploy order **IS** the binding graph: submit has no deps; jmap declares the AccountDO; everything
> after binds it (or submit) cross-script."

`infra/bootstrap.mjs:47-48` · `docs/DEPLOY.md:67-76` · `services/README.md:20-22` ·
`infra/README.md:32-33`. `.github/workflows/deploy-mail.yml:20-21` describes ingest as only
"(binds AccountDO)".

## The contradiction

`services/ingest/wrangler.jsonc:28`:

```jsonc
"services": [{ "binding": "AGENT", "service": "bullmoose-agent" }]
```

But `DEPLOY_ORDER` (`infra/bootstrap.mjs:49`) is:

```js
["submit", "jmap", "ingest", "provision", "agent", "anglebrackets"];
```

`ingest` is index 2; `agent` is index 4. **On a clean account, the first `wrangler deploy` of
`ingest` names a script that does not exist yet.**

None of the four narrations mention this edge — they all assert the invariant that this violates.

## Uncertainty, flagged honestly

I did not verify whether the Cloudflare API **hard-rejects** a service binding to a non-existent
script or accepts a dangling one. Runtime is fail-soft either way: `services/ingest/src/index.ts:28`
types it `AGENT?: Fetcher` and `:97` does `if (!env.AGENT || !result.invocations) return`.

So the worst case is a failed _first_ deploy, not data loss. **The certain defect is that four
documents state a rationale that is factually incomplete** — and the stated rationale is exactly what
a reader would use to place a new worker in the order.

## The fix is free

`agent`'s own deps are `SUBMIT` (`services/agent/wrangler.jsonc:29`) and jmap's `AccountDO` (`:14`)
— both earlier in the list. So moving it costs nothing:

```
submit → jmap → agent → ingest → provision → anglebrackets
```
