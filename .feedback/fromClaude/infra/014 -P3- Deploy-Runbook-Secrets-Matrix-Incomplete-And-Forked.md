# 014 -P3- Deploy runbook's secrets matrix is incomplete, and `infra/README.md` is a stale fork

**Subsystem:** cloud-infra · **Severity:** MEDIUM (one item is security-relevant) · **Fix class:** UPDATE-DOC

## A. The "full matrix" is not full

`docs/DEPLOY.md:89` says "The full matrix, by hand:" followed by a table at `:91-98`. Missing:

- **`VAULT_MASTER_KEY`** — no row, despite `:83-84` calling it one of "the four random secrets"
  bootstrap generates and `infra/bootstrap.mjs:62` installing it to `agent`. It survives only as an
  aside at `:78-79`.
- **`GATEWAY_TOKEN`** — `infra/bootstrap.mjs:72`, `services/agent/src/models.ts:83-89`.
- **`GATEWAY_COMPAT_URL`** — documented only in a comment at `services/agent/wrangler.jsonc:38`, set
  nowhere.
- **`TURNSTILE_SECRET`** — required by `demo-keys`, absent entirely (see issue `013`).

## B. The `INTERNAL_TOKEN` name collision is undocumented — and dangerous

The table's `INTERNAL_TOKEN` row reads "jmap, submit, ingest, agent (**same value**)".

But `services/demo-keys/src/index.ts:28` also reads `INTERNAL_TOKEN`, and per
`services/demo-keys/wrangler.jsonc:27-29` it is a **different value with a different trust boundary**
("The mail bridge on alpaca holds ONLY this").

A same-named secret with a deliberately different value, undocumented in the runbook, is exactly what
gets "helpfully" unified during a rotation — collapsing the demo worker's isolation into the platform
secret.

## C. `infra/README.md` contradicts `DEPLOY.md` on a security setting

- `docs/DEPLOY.md:105` — "**Do NOT set `DEV_BEARER_TOKEN` in production** — with it unset, auth runs
  purely on the token table." `infra/bootstrap.mjs:297` emits the same warning at runtime.
- `infra/README.md:46` — instructs `npx wrangler secret put DEV_BEARER_TOKEN -c services/jmap/wrangler.jsonc`
  as the **first line** of its secrets section, with no caveat.

Per `packages/auth-core/src/principal.ts:72-78`, that token is a single-string bypass onto a fixed
account/tenant.

`infra/README.md` is stale in two more ways: `:36-40` lists a 4-worker deploy (no `agent`, no
`anglebrackets`), and `:44-61` omits `SHARE_SIGNING_KEY` and `VAULT_MASTER_KEY` — all under a §1 that
declares `bootstrap.mjs` "the source of truth", undercutting its own framing.

**Two hand-maintained copies of the same runbook is the root cause of issues 011, 012, 013, and this
one.**
