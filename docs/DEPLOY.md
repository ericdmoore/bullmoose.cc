# Deploying bullmoose mail — first-light checklist

Goal: real inbound mail at `bullmoose.cc`, visible in `bullmoose watch`
within seconds; outbound via Cloudflare Email Service on day one (SES
graduates in later for full-fidelity sends).

## 0. Account prerequisites (human steps)

- [ ] Cloudflare **Workers Paid** plan ($5/mo — the only fixed cost)
- [ ] `bullmoose.cc` zone active on the Cloudflare account
- [ ] **CF API token #1 (provisioning)**: Zone.Zone:Read, Zone.DNS:Edit,
      Zone.Email Routing:Edit — for the provision worker
- [ ] *(outbound option A — recommended for day one)* Onboard the domain
      in **Email Service → Sending** (dashboard, beta) and mint
      **CF API token #2 (email sending)**
- [ ] *(outbound option B)* Start the **AWS SES production access
      request now** (~24h human review); create an IAM user scoped to
      `ses:SendRawEmail`
- [ ] `npm install && npm run typecheck` green locally

## 1. Create resources, paste ids

```sh
npx wrangler d1 create bullmoose-mail-shard0
npx wrangler r2 bucket create bullmoose-mail-blobs
npx wrangler kv namespace create ROUTES
```

Paste the returned `database_id` / KV `id` into all four
`services/*/wrangler.jsonc` (search `REPLACE_AFTER_`). Then schemas:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --file packages/mailstore/sql/data-plane.sql
npx wrangler d1 execute bullmoose-mail-shard0 --remote --file packages/mailstore/sql/control-plane.sql
```

## 2. Deploy (order matters — binding graph)

```sh
npm run -w services/submit    deploy   # 1. no dependencies
npm run -w services/jmap      deploy   # 2. declares AccountDO; binds SUBMIT
npm run -w services/ingest    deploy   # 3. binds AccountDO from jmap
npm run -w services/provision deploy   # 4. control plane
```

## 3. Secrets

| Secret | Worker | Value |
|---|---|---|
| `INTERNAL_TOKEN` | jmap **and** submit (same value) | `openssl rand -hex 24` |
| `SHARE_SIGNING_KEY` | jmap | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | provision | `openssl rand -hex 24` |
| `CF_API_TOKEN` | provision | token #1 |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | provision (+ submit for RELAY=ses) | IAM user |
| `CF_EMAIL_API_TOKEN` | submit (RELAY=cloudflare) | token #2 |

```sh
npx wrangler secret put INTERNAL_TOKEN -c services/jmap/wrangler.jsonc
# ... etc
```

**Do NOT set `DEV_BEARER_TOKEN` in production** — with it unset, auth
runs purely on the token table. For day-one outbound set submit's
`RELAY` var to `cloudflare` (or leave `ses` once production access
clears; `mock` if you want inbound-only first).

## 4. Onboard the domain + your account

```sh
bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token <ADMIN_TOKEN>
bullmoose admin tenant create t_bullmoose --name "Bullmoose"
bullmoose admin domain add bullmoose.cc --tenant t_bullmoose   # per-step report
bullmoose admin domain status bullmoose.cc                     # poll until active
bullmoose admin account create eric@bullmoose.cc --tenant t_bullmoose --name "Eric Moore"
bullmoose admin password eric@bullmoose.cc
```

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

## Troubleshooting

- 401 on everything → token table empty? `admin password` + `login` again;
  check `DEV_BEARER_TOKEN` is NOT set
- inbound not arriving → `admin domain status`; check Email Routing
  catch-all targets `bullmoose-ingest`; check the KV route exists
  (`route:bullmoose.cc:eric`)
- send 500 → submit worker RELAY/credentials mismatch (see secrets table)
- watch connects then silence → `/api/ws` needs the same origin as login
  `--base`; check worker logs (`wrangler tail bullmoose-jmap`)
