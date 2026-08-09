# Deploying bullmoose mail — first-light checklist

Goal: real inbound mail at `bullmoose.cc`, visible in `bullmoose watch`
within seconds; outbound via SES sandbox on day one.

**Plan: Cloudflare Workers FREE tier ($0/mo).** The stack fits it:
SQLite-backed Durable Objects (our AccountDO's flavor), D1, R2, KV, and
Email Routing all have free tiers, and auth uses client-side key
stretching so login fits the free plan's 10ms CPU cap. Known free-tier
edges: very large attachment ingest may occasionally trip the CPU cap,
and CF Email Service *sending* is unavailable (use SES — planned
anyway). If limits ever pinch, Workers Paid ($5/mo) is a zero-code
upgrade.

## The one command

After §0's human steps, the whole-machine deploy is one idempotent script:

```sh
node infra/bootstrap.mjs --dry-run   # preview every step; then drop --dry-run
```

It runs five phases — `resources → wire → schemas → secrets → deploy` — and is
the single source of truth for resource names, the schema list, the deploy
order, and the secret→worker matrix. Run one phase at a time by naming it
(`node infra/bootstrap.mjs secrets`). Sections 1–3 below document what each
phase does and the by-hand equivalent, if you'd rather drive it yourself.

## 0. Account prerequisites (human steps)

- [ ] `bullmoose.cc` zone active on the Cloudflare account (Workers Free OK)
- [ ] **CF API token #1 (provisioning)**: Zone.Zone:Read, Zone.DNS:Edit,
      Zone.Email Routing:Edit — for the provision worker
- [ ] **Outbound = SES sandbox** (free at this volume, full raw-MIME
      fidelity): create an IAM user scoped to `ses:SendRawEmail` (+
      `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`,
      `ses:PutEmailIdentityMailFromAttributes` for provisioning), and
      **verify your personal inbox** in SES → Verified identities so
      sandbox sends can reach it. Optionally start the production
      access request (~24h) to lift the recipient restriction.
- [ ] `npm install && npm run typecheck` green locally
- [ ] **Pre-flight** (read-only account readiness check):
      `CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_ZONE_ID=... node tools/preflight.mjs`
      — verifies zone/account/plan, flags existing MX records before the
      cutover, Email Routing state, workers.dev subdomain, and name
      collisions with the resources this runbook creates

## 1. Create resources + wire ids  (bootstrap: `resources` + `wire`)

```sh
npx wrangler d1 create bullmoose-mail-shard0
npx wrangler r2 bucket create bullmoose-mail-blobs
npx wrangler kv namespace create ROUTES
```

`bootstrap.mjs wire` reads these ids back from `wrangler … list` and writes
them into all six `services/*/wrangler.jsonc` for you — no hand-editing, and it
overwrites the repo's committed prod ids with yours. (By hand: paste the
returned `database_id` / KV `id` into each config.) Then schemas
(`bootstrap.mjs schemas`):

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --file packages/mailstore/sql/data-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --remote --file packages/mailstore/sql/control-plane.sql
```

## 2. Deploy — order matters, binding graph  (bootstrap: `deploy`)

```sh
npm run -w services/submit        deploy   # 1. no dependencies
npm run -w services/jmap          deploy   # 2. declares AccountDO; binds SUBMIT
npm run -w services/agent         deploy   # 3. binds SUBMIT + AccountDO from jmap
npm run -w services/ingest        deploy   # 4. binds AGENT -> agent, + AccountDO
npm run -w services/provision     deploy   # 5. control plane, no deps
npm run -w services/anglebrackets deploy   # 6. CardDAV/CalDAV face (binds AccountDO)
```

> **agent must precede ingest.** `services/ingest/wrangler.jsonc:28` binds
> `bullmoose-agent`, so on a clean account the old order (ingest at 3, agent at
> 5) deploys ingest against a service that does not exist yet. It only ever
> worked because agent already existed from a prior run. Corrected in
> `infra/bootstrap.mjs` `DEPLOY_ORDER` and `.github/workflows/deploy-mail.yml`
> — all three must stay in sync.

`services/demo-keys` is deliberately absent from this list, from
`DEPLOY_ORDER`, and from CI. Tracked as `.feedback/fromClaude/infra/013`.

Agent-worker extras: `wrangler secret put VAULT_MASTER_KEY -c
services/agent/wrangler.jsonc` (credential vault; `openssl rand -hex 32`).

## 3. Secrets  (bootstrap: `secrets`)

`bootstrap.mjs secrets` generates the four random secrets (`INTERNAL_TOKEN`,
`SHARE_SIGNING_KEY`, `ADMIN_TOKEN`, `VAULT_MASTER_KEY`) into `.env.deploy`
(gitignored, `chmod 600`) once — re-runs reuse them, no silent rotation — and
installs each to the workers that read it. Paste the external creds (CF/SES
rows below) into `.env.deploy` first so they install in the same pass; missing
required ones are reported and skipped, so you can add them and re-run. The
full matrix, by hand:

| Secret | Worker | Value |
|---|---|---|
| `INTERNAL_TOKEN` | jmap, submit, ingest, agent (same value) | `openssl rand -hex 24` |
| `SHARE_SIGNING_KEY` | jmap | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | provision | `openssl rand -hex 24` |
| `CF_API_TOKEN` | provision | token #1 |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | provision + submit | IAM user |
| `CF_EMAIL_API_TOKEN` | submit — only if RELAY=cloudflare (requires Workers Paid) | CF sending token |

```sh
npx wrangler secret put INTERNAL_TOKEN -c services/jmap/wrangler.jsonc
# ... etc
```

**Do NOT set `DEV_BEARER_TOKEN` in production** — with it unset, auth
runs purely on the token table. Submit's `RELAY` var: `ses` (default;
sandbox delivers to your verified inbox on day one) or `mock` for
inbound-only first.

## 4. Onboard the domain + your account

```sh
bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token <ADMIN_TOKEN>
bullmoose admin tenant create t_bullmoose --name "Bullmoose"
bullmoose admin domain add bullmoose.cc --tenant t_bullmoose   # per-step report
bullmoose admin domain status bullmoose.cc                     # poll until active
bullmoose admin account create eric@bullmoose.cc --tenant t_bullmoose --name "Eric Moore"
bullmoose admin password eric@bullmoose.cc
```

The tenant id (`t_bullmoose`) is a slug you choose — a namespace for an org or
family, reused by every `--tenant` flag; it is not a credential. `<ADMIN_TOKEN>`
is, and lives in `.env.deploy` (`grep ADMIN_TOKEN .env.deploy`).

Note: `domain add` wires Email Routing + catch-all→ingest + SES identity
+ DKIM/MAIL FROM/DMARC. If skipping SES for now, expect the `ses:*`
steps to report failures — re-run later; the Cloudflare steps are
idempotent.

## 5. First light

```sh
bullmoose login eric@bullmoose.cc --base https://bullmoose-jmap.<acct>.workers.dev
bullmoose watch                     # leave running

# from Gmail/anywhere: send mail to eric@bullmoose.cc
# expect: ● line in watch within ~2s of delivery

bullmoose read                      # newest message, live body
echo "it lives" | bullmoose send --to <your-gmail> --subject "first light"
```

Outbound deliverability check: confirm the received message shows
SPF/DKIM/DMARC pass (Gmail: "show original").

## 6. Post-deploy hardening (in rough order)

1. Custom domains for the workers (`mail.bullmoose.cc` etc.) instead of
   workers.dev — then plant the `_jmap._tcp` SRV record (autodiscovery
   is next on the roadmap)
2. Spam gate at ingest (honor Email Routing verdict headers)
3. GHA deploy workflow (see `.github/workflows/deploy-mail.yml`) once
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets exist
4. SES config set → SNS → `/webhooks/ses` for bounce/complaint
   suppression (when RELAY=ses)

### Runbook: revoking share links

`bullmoose send` mints an expiring public URL for any attachment over
`--link-max` (default 4 MB), signed with `SHARE_SIGNING_KEY` and valid for up
to 90 days. Three levers, escalating:

| Reach | Command | Effect |
|---|---|---|
| one link | `bullmoose share revoke <shareId>` | that URL stops resolving |
| audit first | `bullmoose share list` | every link the server still has a record of, live ones first |
| **everything** | rotate `SHARE_SIGNING_KEY` | **every link, every account, instantly and irreversibly dead** |

```sh
# BREAK-GLASS — read the blast radius first.
openssl rand -hex 32 | npx wrangler secret put SHARE_SIGNING_KEY -c services/jmap/wrangler.jsonc
```

**Blast radius of the rotation: total.** Every link ever minted under the old
key fails signature verification the moment the new secret is live — other
accounts, other tenants, links you did not mean to kill, links a recipient is
mid-download on. There is no partial rotation and no undo; the only recovery
is putting the old value back, which un-revokes everything it killed. Reach for
`share revoke` first and keep this for "we do not know which link leaked".

Two things that are easy to get wrong:

- **Rotation is not automatic and never has been.** `bootstrap.mjs secrets`
  reuses existing values by design (§3), so a re-run does **not** rotate.
- **Per-link revocation is eventually consistent.** Records live in KV, so a
  revoke can take up to ~60s to reach every edge. The CLI says so on success.
  Key rotation has no such delay — it is a secret change, not a data read.

Share-link *records* live in KV under `share:` in the `ROUTES` namespace and
expire with the link they describe, so nothing accumulates and there is no
sweeper to run. Rotating the key does not clear them; they age out on their
own, and `share list` will show links that the rotation has already killed
until they do. That is cosmetic, but know it before reading the output.

### Runbook: an address already routes somewhere

`admin account create` is idempotent. Re-running it for an address that already
has a mailbox returns the **existing** account (`created: false`) and touches
nothing — safe to re-run a bootstrap, safe to retry after a timeout.

It refuses, `409`, when the address routes somewhere that is *not* that mailbox:
a forward/alias/catch-all row, another tenant's account, a target account that
no longer exists, or a `--principal` that disagrees with who owns the account.
The response carries `existingRoute` so you can see what is in the way. **The
409 means delivery was left exactly as it was** — that is the point of it.

Before this was enforced, a second create for one address built a second
account and repointed delivery onto it. If you are on a deployment that ran the
old code, the symptom is *"mail stopped arriving"* with everything reporting
healthy, and the fix is to point the route back:

```sh
bullmoose admin account list --tenant t_bullmoose   # two accounts, one address
```

The orphaned account still holds every message it received — nothing was
deleted. Repointing is one `routes` row plus the matching KV key, and **both**
must move together: ingest resolves delivery through the KV key alone, so D1
alone is not enough.

```sh
# 1. control plane (authoritative)
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "UPDATE routes SET target='<GOOD_ACCOUNT_ID>' WHERE domain='bullmoose.cc' AND localpart='eric'"

# 2. the ingest fast path — omit this and mail keeps landing in the wrong account
npx wrangler kv key put -c services/provision/wrangler.jsonc --remote \
  --binding=ROUTES 'route:bullmoose.cc:eric' \
  '{"kind":"mailbox","accountId":"<GOOD_ACCOUNT_ID>","tenantId":"t_bullmoose"}'
```

(One D1 today — `bullmoose-mail-shard0` holds both the control and data planes,
per §2. If the control plane is ever split out, step 1 moves with `routes`.)

Verify with `admin account create` for the same address: it should now come back
`created: false` with `<GOOD_ACCOUNT_ID>`. There is **no `DELETE /accounts`**
(`.plans/sVOL-CapSurNoun/008`), so the duplicate account stays until that lands;
it is inert once nothing routes to it.

### GHA repo secrets

Set from a machine with `gh` authed to the repo (the remote sandbox's
GitHub proxy blocks the Actions-secrets API on purpose, so this step is
manual). Worker *runtime* secrets (INTERNAL_TOKEN, SES runtime pair,
SHARE_SIGNING_KEY, …) live in Cloudflare via `wrangler secret put` and
survive redeploys — they do NOT need to be mirrored into GHA. Only the
deploy-time credentials do:

```sh
R=ericdmoore/bullmoose.cc
gh secret set CLOUDFLARE_API_TOKEN  -R $R   # the *deploy* token (Workers Scripts/D1/KV/R2:Edit)
gh secret set CLOUDFLARE_ACCOUNT_ID -R $R   # cf473a1c1e6f51585477ccf5216ae636

# optional — only if GHA scripts will call the provision admin API
# or manage SES identities from CI:
gh secret set BULLMOOSE_ADMIN_TOKEN     -R $R
gh secret set SES_DEPLOY_ACCESS_KEY_ID  -R $R
gh secret set SES_DEPLOY_SECRET_KEY     -R $R
```

Each `gh secret set` with no value flag prompts on stdin, so tokens
never land in shell history.

## Troubleshooting

- 401 on everything → token table empty? `admin password` + `login` again;
  check `DEV_BEARER_TOKEN` is NOT set
- inbound not arriving → `admin domain status`; check Email Routing
  catch-all targets `bullmoose-ingest`; check the KV route exists
  (`route:bullmoose.cc:eric`)
- send 500 → submit worker RELAY/credentials mismatch (see secrets table)
- watch connects then silence → `/api/ws` needs the same origin as login
  `--base`; check worker logs (`wrangler tail bullmoose-jmap`)
