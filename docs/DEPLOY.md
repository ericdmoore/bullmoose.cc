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

### Upgrading an EXISTING database — `accounts.deleted_at`

Both `.sql` files are `CREATE TABLE IF NOT EXISTS`, so re-running them does
**not** add a column to a table that already exists. There is no migration
framework; new columns are hand-run, once, in this order.

`sVOL 008` adds one:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "ALTER TABLE accounts ADD COLUMN deleted_at INTEGER"
```

**Run it BEFORE deploying the workers, not after.** `deleted_at IS NULL` is now
in the account-resolution path of `@bullmoose/auth-core` (`verifyBearer`), the
jmap worker's `/auth/login`, the agent drain and every provision read — on a
database without the column those queries fail and *nothing authenticates*.
Adding a nullable column to SQLite is a metadata-only operation: it does not
rewrite the table and it is safe to run while the workers are live, which is
why the order is "column first, deploy second" rather than a maintenance
window.

Idempotent enough to be safe to re-run blind — a second run errors with
`duplicate column name: deleted_at` and changes nothing. Verify with:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "SELECT COUNT(*) AS live FROM accounts WHERE deleted_at IS NULL"
```

### Upgrading an EXISTING database — `s03.A` provenance + grant tombstones

`s03.A` adds two more hand-run changes on the SAME rule: nullable columns, so
each ALTER is a metadata-only operation that rewrites no rows and is safe to run
while the workers are live. **Run all of them BEFORE deploying the workers.**

**T1 — cross-realm provenance.** Three `last_writer_*` columns on every mutable
data-plane record. The shared Mailstore write path stamps them on every
`*/set`, so a database without the columns fails every write once the new jmap
worker deploys. The 21 ALTERs have no ordering constraint among themselves
(independent nullable columns on seven tables):

```sh
for t in emails mailboxes address_books contact_cards calendars calendar_events file_nodes; do
  for c in last_writer_principal last_writer_binding last_writer_invocation; do
    npx wrangler d1 execute bullmoose-mail-shard0 --remote \
      --command "ALTER TABLE $t ADD COLUMN $c TEXT"
  done
done
```

Explicit form, if you prefer to paste the exact list (same 21 statements):

```sql
ALTER TABLE emails          ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE emails          ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE emails          ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE mailboxes       ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE mailboxes       ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE mailboxes       ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE address_books   ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE address_books   ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE address_books   ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE contact_cards   ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE contact_cards   ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE contact_cards   ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE calendars       ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE calendars       ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE calendars       ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE calendar_events ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE calendar_events ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE calendar_events ADD COLUMN last_writer_invocation TEXT;
ALTER TABLE file_nodes      ADD COLUMN last_writer_principal  TEXT;
ALTER TABLE file_nodes      ADD COLUMN last_writer_binding    TEXT;
ALTER TABLE file_nodes      ADD COLUMN last_writer_invocation TEXT;
```

**T2 — grant tombstones.** One column on `grants` plus one new table. The column
is what `@bullmoose/auth-core` (`verifyBearer`) now filters on (`revoked_at IS
NULL`), so — exactly like `deleted_at` — a database without it fails grant
resolution the moment the workers deploy. Run the column FIRST, then the table
(the table is a `CREATE TABLE IF NOT EXISTS`, so a plain schema re-run also
creates it; the explicit form is here so the whole change is in one place):

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "ALTER TABLE grants ADD COLUMN revoked_at INTEGER"
npx wrangler d1 execute bullmoose-mail-shard0 --remote --command "
  CREATE TABLE IF NOT EXISTS grant_lifecycle (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    grant_id TEXT NOT NULL,
    event    TEXT NOT NULL,
    at       INTEGER NOT NULL,
    actor    TEXT
  );
  CREATE INDEX IF NOT EXISTS grant_lifecycle_grant ON grant_lifecycle (grant_id, at);"
```

Each ALTER is idempotent-enough to re-run blind (a second run errors
`duplicate column name: …` and changes nothing). Verify the whole s03.A set:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "SELECT last_writer_principal FROM emails LIMIT 1"
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "SELECT COUNT(*) AS live_grants FROM grants WHERE revoked_at IS NULL"
```

### Upgrading an EXISTING database — `s04` Bureau grants

**T2 — mint ≠ authorize.** One new table, no ALTER. `bureau_grants` records who
may use which credential for which verb (`bureau.md` §5.1); it is separate from
`grants` on purpose (see the table's comment in `control-plane.sql`) and separate
from `vault_credentials` so that revoking a capability leaves the credential and
its sibling grants intact.

Because it is a `CREATE TABLE IF NOT EXISTS` and not an `ADD COLUMN`, a plain
schema re-run also creates it; the explicit form is here so the whole change is
in one place.

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --command "
  CREATE TABLE IF NOT EXISTS bureau_grants (
    id           TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    cred_name    TEXT NOT NULL,
    verb         TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    revoked_at   INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bureau_grants_tuple
    ON bureau_grants (principal_id, cred_name, verb);
  CREATE INDEX IF NOT EXISTS bureau_grants_cred ON bureau_grants (principal_id, cred_name);"
```

Verify:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "SELECT COUNT(*) AS live FROM bureau_grants WHERE revoked_at IS NULL"
```

No backfill. A credential minted before this table exists simply has no grants,
which means nothing may use it — fail-closed, and the correct default: the whole
point of T2 is that minting a credential never authorized anybody in the first
place. Grant explicitly, one verb at a time:

```sh
curl -sX POST https://<provision-host>/bureau-grants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"principalEmail":"allen@bullmoose.cc","credRef":"aws-mcp","verb":"sign_sigv4"}'
```

## 2. Deploy — order matters, binding graph  (bootstrap: `deploy`)

```sh
npm run -w services/submit        deploy   # 1. no dependencies
npm run -w services/jmap          deploy   # 2. declares AccountDO; binds SUBMIT
npm run -w services/bureau        deploy   # 3. holds VAULT_MASTER_KEY; no deps
npm run -w services/agent         deploy   # 4. binds SUBMIT + BUREAU + AccountDO
npm run -w services/ingest        deploy   # 5. binds AGENT -> agent, + AccountDO
npm run -w services/provision     deploy   # 6. control plane, no deps
npm run -w services/anglebrackets deploy   # 7. CardDAV/CalDAV face (binds AccountDO)
```

> **agent must precede ingest.** `services/ingest/wrangler.jsonc:28` binds
> `bullmoose-agent`, so on a clean account the old order (ingest at 3, agent at
> 5) deploys ingest against a service that does not exist yet. It only ever
> worked because agent already existed from a prior run. Corrected in
> `infra/bootstrap.mjs` `DEPLOY_ORDER` and `.github/workflows/deploy-mail.yml`
> — all three must stay in sync.

> **bureau must precede agent** — the same failure, one edge further up the
> graph. `services/agent/wrangler.jsonc` binds `BUREAU -> bullmoose-bureau`
> (s04 T3a), so deploying agent first fails against a service that does not
> exist. Same three files must stay in sync.

`services/demo-keys` is deliberately absent from this list, from
`DEPLOY_ORDER`, and from CI. Tracked as `.feedback/fromClaude/infra/013`.

Bureau-worker extras: `wrangler secret put VAULT_MASTER_KEY -c
services/bureau/wrangler.jsonc` (credential vault; `openssl rand -hex 32`).

> ⚠️ **The key MOVED; it was not copied.** Before s04 T3a this secret was bound
> to `services/agent`. It is now bound to `services/bureau` and to nothing else —
> that single fact is what makes "the agent worker cannot unseal a credential" a
> platform property rather than a coding convention. On an EXISTING deployment,
> put the *same value* on bureau (a new random one cannot open the rows already
> sealed), then delete it from agent:
>
> ```sh
> npx wrangler secret put VAULT_MASTER_KEY -c services/bureau/wrangler.jsonc   # paste the OLD value
> npx wrangler secret delete VAULT_MASTER_KEY -c services/agent/wrangler.jsonc
> ```
>
> Order matters: bureau first, or minting breaks between the two commands.
> Verify the move landed — the first command should list it, the second should
> not:
>
> ```sh
> npx wrangler secret list -c services/bureau/wrangler.jsonc
> npx wrangler secret list -c services/agent/wrangler.jsonc
> ```

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
`created: false` with `<GOOD_ACCOUNT_ID>`. The duplicate is inert once nothing
routes to it, and since `sVOL 008` it can be tombstoned properly — which drops
its route row and its KV key together, so you no longer have to keep the two in
step by hand:

```sh
bullmoose admin account delete <DUPLICATE_ACCOUNT_ID> --dry-run
bullmoose admin account delete <DUPLICATE_ACCOUNT_ID> --yes
bullmoose admin account list --include-deleted     # the tombstone is still readable
```

It is a **soft** delete: the messages the duplicate received stay on the shard,
because nothing in the platform can garbage-collect a data-plane account yet.
The command prints exactly what it retained. It also revokes, in the same call,
everything that could still reach the mailbox without going through the
tombstone — the KV route key and every `routes` row naming it, its public share
links, its queued agent invocations, and (only if the account was the
principal's last live one) that principal's tokens and password. That last one
matters more than it looks: `principals.login_email` is UNIQUE and
`admin account create` reuses a principal by email, so re-provisioning the same
address later re-attaches the same principal — without the revoke, an old token
would silently become a live credential for the new mailbox.

### Runbook: undo a mistyped domain

Teardown is inside-out, and each step refuses while the next one down still has
something live on it — so the order is forced rather than remembered:

```sh
bullmoose admin account list --tenant t_home        # find accounts on the typo
bullmoose admin account delete <accountId> --yes    # soft; frees the route
bullmoose admin domain delete exmaple.com --yes     # refuses while a LIVE account remains
bullmoose admin tenant delete t_home --yes          # only if the tenant is going too
```

`domain delete` unwinds the Cloudflare catch-all and the SES identity and
prints a `✓/✗` line per step, in the same shape `domain add` uses. It
deliberately does **not** delete DNS records (DKIM CNAMEs, MAIL FROM MX/SPF,
`_dmarc`, the `_jmap._tcp` SRV) or disable Email Routing for the zone — both are
reported as not-unwound rather than done silently, because the zone may carry
other rules and the records may have been hand-edited.

Tombstoned accounts do **not** block `domain delete` or `tenant delete`;
`tenant delete` is the terminal verb that purges them, along with their
principals, identities, tokens and credentials. The data plane (messages,
calendars, contacts, R2 blobs) is never touched by any of this — it is a
separate database, and nothing owns its teardown yet.

If you only want mail to stop and want it reversible, suspend instead:

```sh
bullmoose admin domain suspend exmaple.com   # route keys parked; mail bounces 550
bullmoose admin domain resume  exmaple.com   # restored, deliver-and-forward included
```

### Runbook: stop an agent, now

An agent that is replying wrongly, looping, or spending is stopped by its
binding, not by its token — revoking the token stops it *acting* while
`services/ingest` keeps enqueueing a `pending` invocation on every delivery.

```sh
bullmoose admin agent list <account-email>          # binding ids
bullmoose admin agent disable <binding-id>          # no --yes: this is the safe direction
```

Both the ingest enqueue path and the agent drain gate on `agent_bindings.enabled`,
so this stops new invocations being created *and* stops queued ones running.
Invocations already queued are **held, not cancelled** — the count is printed,
and they resume on `bullmoose admin agent enable <binding-id>`. If they are
stale by the time you re-enable, clear them first:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "UPDATE agent_invocations SET status='failed', note='cleared by operator'
             WHERE binding_id='<binding-id>' AND status='pending'"
```

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
