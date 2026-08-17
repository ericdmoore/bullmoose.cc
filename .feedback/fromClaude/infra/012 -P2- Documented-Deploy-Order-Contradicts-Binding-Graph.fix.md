# FIX — 012 -P2- Deploy order contradicts the binding graph

## Proposal

**1. Reorder** — `infra/bootstrap.mjs:49`:

```js
const DEPLOY_ORDER = ["submit", "jmap", "agent", "ingest", "provision", "anglebrackets"];
```

**2. Mirror it** in `.github/workflows/deploy-mail.yml` (which also needs the two missing workers —
issue `011`).

**3. Update the four narrations** — `infra/bootstrap.mjs:47-48`, `docs/DEPLOY.md:67-76`,
`services/README.md:20-22`, `infra/README.md:32-33` — and specifically note that **ingest binds
`AGENT`**, since the whole point of those paragraphs is to explain _why_ the order is what it is.
`deploy-mail.yml:20-21`'s comment should say "(binds AccountDO + AGENT)".

## The stronger fix: derive the order instead of asserting it

The claim "deploy order **is** the binding graph" is checkable. `wrangler.jsonc` files declare their
`services:` bindings, so the order can be **topologically sorted** rather than hand-maintained:

```js
// infra/bootstrap.mjs — sketch
const deps = readAllConfigs(); // worker → [bound script names]
const DEPLOY_ORDER = toposort(deps); // throws on a cycle
```

That turns a comment into an invariant, and it would have caught this. It also future-proofs the next
worker someone adds. `submit` deliberately declines a DO binding to avoid a cycle
(`services/submit/wrangler.jsonc:7-9`) — a toposort makes that constraint explicit rather than tribal.

If that's more than you want now, at minimum add a **test** asserting that for every worker, each
script it binds appears earlier in `DEPLOY_ORDER`. That's ~10 lines and closes the class.

## Bread-crumbs

- Verify the Cloudflare behaviour on a dangling service binding before assuming the reorder is
  cosmetic — if it hard-fails, this is currently blocking any clean-account bootstrap, which raises
  the severity.
- `infra/bootstrap.mjs:133-138` (`wireText`) is already shaped for unit testing but is outside the
  vitest glob — see issue `011` fix C; the toposort test would go in the same new file.
