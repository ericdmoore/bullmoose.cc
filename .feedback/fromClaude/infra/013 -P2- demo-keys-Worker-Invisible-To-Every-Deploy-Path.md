# 013 -P2- `demo-keys` worker is invisible to every deploy path

**Subsystem:** cloud-infra · **Severity:** MEDIUM-HIGH · **Fix class:** CHANGE-CODE + UPDATE-DOC

## The drift

Four documents describe a **six**-worker platform:

- `docs/DEPLOY.md:57` — bootstrap "writes them into all six `services/*/wrangler.jsonc` for you"
- `docs/DEPLOY.md:70-76` — a 6-worker deploy
- `services/README.md:3` — "six stateless Cloudflare Workers"
- `infra/README.md:27-28` — "all six `services/*/wrangler.jsonc` files"

There are **seven**. `demo-keys` exists, is committed, and is reachable from none of them:
`DEPLOY_ORDER` (`infra/bootstrap.mjs:49`) omits it, so `wire` (`:54`) never touches it and `deploy`
(`:300-307`) never ships it.

A repo-wide grep for `demo-keys|DEMO_KEYS|TURNSTILE` across `docs/`, `infra/`, `.github/`,
`README.md`, `package.json` returns **zero hits**. Its only documentation is
`services/demo-keys/README.md:27-63` — which is correct, but unreachable from any deploy entry point.

## It also ships two values that hard-fail a deploy

- `services/demo-keys/wrangler.jsonc:8` — `"id": "REPLACE_AFTER_wrangler_kv_create"`
- `:14` — `"TURNSTILE_SITEKEY": "REPLACE_WITH_TURNSTILE_SITEKEY"`

Nothing warns that these are intentional placeholders rather than a broken commit.

## Latent hazard worth fixing before it bites

`infra/bootstrap.mjs:149` rewrites **the first `"id"` after `"kv_namespaces"`**. `CONFIGS` is
currently an explicit list — but both `docs/DEPLOY.md:57` and `infra/README.md:27` describe it as the
glob `services/*/wrangler.jsonc`.

**If anyone makes the code match the doc**, `wire` will silently overwrite `demo-keys`' `DEMO_KEYS`
namespace id with the `ROUTES` id — and the public demo worker would then read and write the
production route table.

That is a doc/code mismatch that actively invites a dangerous "fix".

## Root cause

`README.md:99` says "Five stateless workers", `README.md:108` says "the six services", and there are
seven directories — three different counts, one of them inside a single file.
