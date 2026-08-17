# FIX — 013 -P2- `demo-keys` invisible to every deploy path

## Decide first: is `demo-keys` in-platform or out-of-band?

Both are defensible, and the fix differs. It has a genuinely different trust boundary — a separate
`INTERNAL_TOKEN` value (`services/demo-keys/wrangler.jsonc:27-29`) and a public unauthenticated
surface — so keeping it separate is a real choice, not neglect.

**(a) Bring it in** — add to `DEPLOY_ORDER` and `CONFIGS` (`infra/bootstrap.mjs:49,54`), add a deploy
step to `.github/workflows/deploy-mail.yml`, add it to `docs/DEPLOY.md` §2. Then fix the counts.

**(b) Keep it out-of-band** — state that explicitly in `docs/DEPLOY.md` and `services/README.md`:
_"`demo-keys` is deployed separately (`npm run -w services/demo-keys deploy`) because it has its own
KV namespace, its own `INTERNAL_TOKEN`, and a public unauthenticated route. See its README."_

I lean **(b)** — the isolation is a feature — but it must be _said_, because silence reads as an
oversight and invites (a) being done carelessly.

## Regardless of the choice, do these three

1. **Fix the counts.** `README.md:99` ("Five"), `README.md:108` ("six"), `services/README.md:3`,
   `docs/DEPLOY.md:57`, `infra/README.md:27-28`. Better: say "the workers in `services/`" and stop
   hand-maintaining a number that has been wrong three different ways.

2. **Close the glob hazard.** `docs/DEPLOY.md:57` and `infra/README.md:27` describe `CONFIGS` as
   `services/*/wrangler.jsonc`; the code uses an explicit list. Make the **doc** match the code (not
   the reverse), and add a comment at `infra/bootstrap.mjs:54` explaining that `demo-keys` is
   deliberately excluded and **why** — the first-`"id"`-after-`kv_namespaces` rewrite at `:149` would
   clobber `DEMO_KEYS` with the `ROUTES` id.

3. **Annotate the placeholders.** A one-line comment beside
   `wrangler.jsonc:8,14` saying these are filled by the demo runbook, not by `bootstrap wire`.

## Bread-crumbs

- `services/demo-keys/README.md:27-63` is the accurate runbook — link to it from `docs/DEPLOY.md`
  rather than duplicating it.
- If you take (a), the deploy needs `TURNSTILE_SECRET` and a `demo-keys`-specific `INTERNAL_TOKEN` in
  CI secrets — see issue `014` on the incomplete secrets matrix.
- Related to `.plans/` history: this worker shipped in PR #6 and was never wired into the platform
  deploy — worth checking whether it is deployed in production at all today.
