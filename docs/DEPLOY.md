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

It runs six phases — `resources → wire → schemas → migrate → secrets → deploy` —
and is the single source of truth for resource names, the schema list, the
deploy order, and the secret→worker matrix. Run one phase at a time by naming it
(`node infra/bootstrap.mjs secrets`). Sections 1–3 below document what each
phase does and the by-hand equivalent, if you'd rather drive it yourself.

**`schemas` creates; `migrate` upgrades.** They are separate phases because the
`.sql` files are all `CREATE … IF NOT EXISTS`, which is idempotent for _creating_
and silently declines to _upgrade_. An existing database keeps its old columns,
its old index definitions and its old virtual-table flags, and says nothing —
so every failure in this class is silent and partial:

| drift                                     | what you see                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `accounts.deleted_at` missing             | `verifyBearer` throws — **nobody authenticates**                                           |
| `grants.revoked_at` missing               | same, every grant lookup breaks                                                            |
| `grants_tuple` not partial                | revoke-then-re-grant is a no-op that still returns **200** with a `grantId` no row carries |
| `emails_fts` without `contentless_delete` | delivery works; `Email/set destroy` throws and rolls back                                  |

`infra/migrations.mjs` is the machine-readable list, each entry carrying an
executable `check`, so `migrate` skips what is already applied and **hard-stops**
if a check still fails after its DDL ran. `infra/migrations.test.ts` proves each
check bites by reversing the migration and asserting the check flips — a check
that returned "applied" unconditionally would be the same silent failure one
level up. The sub-sections below remain as the by-hand equivalent.

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

## 1. Create resources + wire ids (bootstrap: `resources` + `wire`)

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
database without the column those queries fail and _nothing authenticates_.
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

**Then rebuild `grants_tuple` — this one is NOT optional and NOT covered by a
schema re-run.** The index is `CREATE UNIQUE INDEX IF NOT EXISTS`, so an
existing database keeps its old **non-partial** definition and `IF NOT EXISTS`
silently declines to replace it. The tombstone then occupies the tuple forever,
which makes _revoke, then change your mind_ impossible:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --command "
  DROP INDEX IF EXISTS grants_tuple;
  CREATE UNIQUE INDEX grants_tuple
    ON grants (grantee_account_id, target_account_id,
               COALESCE(collection, ''), COALESCE(collection_id, ''))
    WHERE revoked_at IS NULL;"
```

Skipping this does not throw. `createGrant` inserts with `ON CONFLICT DO
NOTHING`, so re-granting a previously-revoked pair is a **silent no-op that
still returns 200** with a `grantId` no row carries — the operator is told
access was restored when it was not. Verified against the real index: insert →
tombstone → re-insert fails on `grants_tuple`; with the partial index the
re-insert succeeds while a genuinely-duplicate LIVE grant is still refused.

Do **not** apply the same shape to `bureau_grants_tuple`. That table's writer
upserts (`ON CONFLICT … DO UPDATE SET revoked_at = NULL`) and resurrects its own
tombstone; SQLite matches a conflict target against a unique index, so making
that one partial breaks every Bureau grant write.

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

### Upgrading an EXISTING database — `common/004` full-text search

`Email/query`'s `text` condition now matches an FTS5 index instead of scanning
with `LIKE`, and that index covers **message bodies**, which were previously
unsearchable past the 256-character preview. Two things have to happen on a
database that predates it, and **the second one is not optional** — an empty
index means search silently returns nothing, which is worse than the `LIKE` it
replaced.

**Step 1 — the table.** `emails_fts` has existed since the first schema, but
without `contentless_delete=1`, and `CREATE VIRTUAL TABLE IF NOT EXISTS` will
not upgrade it. Without that flag SQLite refuses to delete a row, so a
destroyed message could never leave the index. Drop and recreate it — there is
nothing to lose, because nothing ever wrote to it:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --command "
  DROP TABLE IF EXISTS emails_fts;
  CREATE VIRTUAL TABLE emails_fts USING fts5 (
    subject, from_text, to_text, body_text,
    content='', contentless_delete=1, tokenize='unicode61');
  CREATE TABLE IF NOT EXISTS emails_fts_map (
    docid      INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    email_id   TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS emails_fts_map_email
    ON emails_fts_map (account_id, email_id);
  DELETE FROM emails_fts_map;"
```

The trailing `DELETE FROM emails_fts_map` is what makes this safe to re-run: it
puts the map back in step with the table you just dropped, so every message
looks un-indexed again and the backfill below rebuilds from scratch.

⚠️ **Run it BEFORE deploying the workers, and do not skip it because delivery
still looks fine.** Skipping is nastier than it appears, because a plain schema
re-run creates `emails_fts_map` (a normal `CREATE TABLE`) while leaving
`emails_fts` on its old definition — so the two halves disagree and the failure
is _partial_:

| on an un-migrated database   |                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| inbound delivery             | **works** — the first index write for a message is an `INSERT`, which a contentless table allows                               |
| free-text search of new mail | works                                                                                                                          |
| **`Email/set destroy`**      | **fails**, `cannot DELETE from contentless fts5 table` — and the destroy batch is atomic, so the message is not deleted at all |
| **the backfill below**       | **fails**, same error, on the second pass over any message                                                                     |

Delivery keeping up while deletes throw is exactly the shape of failure that
gets diagnosed slowly. Migrate first.

**Step 2 — the backfill.** New mail is indexed as it is delivered; existing
mail is not. The `ingest` worker exposes a resumable one-shot for it, guarded
by the same `x-internal-token` as `/dev/inject`:

```sh
INGEST=https://<ingest-host>          # e.g. bullmoose-ingest.<subdomain>.workers.dev
TOKEN=$INTERNAL_TOKEN

# How much is left? (limit=0 reports and indexes nothing.)
curl -sX POST "$INGEST/admin/fts/backfill?limit=0" -H "x-internal-token: $TOKEN"

# Run it to completion. Each pass indexes the NEWEST unindexed mail first,
# so an interrupted run has still made recent mail searchable.
while :; do
  out=$(curl -sX POST "$INGEST/admin/fts/backfill?limit=25" -H "x-internal-token: $TOKEN")
  echo "$out"
  [ "$(printf '%s' "$out" | jq -r .remaining)" = "0" ] && break
  sleep 1
done
```

| param     | default               | meaning                                                      |
| --------- | --------------------- | ------------------------------------------------------------ |
| `limit`   | 25 deep / 200 shallow | messages per call; `0` = status only                         |
| `deep`    | `1`                   | re-read each raw message from R2 and index the **full body** |
| `account` | all                   | restrict to one `accountId`                                  |

`deep=1` costs one R2 GET plus one MIME parse per message, and CPU-per-invocation
is the tightest free-tier budget — hence the small default `limit`. If a pass
dies on CPU, lower it and re-run; nothing is lost, because the work queue is
"messages with no index row" and each pass only shrinks it.

`deep=0` is the fast path: pure D1, no R2, ~200/call. It indexes subject,
addresses and the 256-character preview, so you get the **scan → index**
speedup immediately but old bodies stay searchable only to 256 characters. A
reasonable sequence for a large mailbox is `deep=0` over everything first, then
`deep=1` — but note that a message already indexed shallowly is no longer in the
queue, so a later deep pass needs the map cleared again (step 1's
`DELETE FROM emails_fts_map`).

**Verify** — the count should equal the message count, and a body-only word
should now be findable:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote --command "
  SELECT (SELECT COUNT(*) FROM emails) AS messages,
         (SELECT COUNT(*) FROM emails_fts_map) AS indexed"
```

**Capacity note.** The index adds roughly **0.6 KB per message** for an ordinary
2.3 KB body (measured; ~26% of body size) — call it 1.2 KB → ~1.8 KB per message
of D1. That moves the single-shard ceiling from ~300K messages to ~200K. See
`docs/architecture/capacity-and-scaling.md` §1. If you would rather not spend
it, run the backfill with `deep=0` and leave `bodyText` unindexed for history.

## 2. Deploy — order matters, binding graph (bootstrap: `deploy`)

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
> `bullmoose-agent`, so on a clean account the old order (ingest at 3, agent at 5) deploys ingest against a service that does not exist yet. It only ever
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
> put the _same value_ on bureau (a new random one cannot open the rows already
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

## 3. Secrets (bootstrap: `secrets`)

`bootstrap.mjs secrets` generates the four random secrets (`INTERNAL_TOKEN`,
`SHARE_SIGNING_KEY`, `ADMIN_TOKEN`, `VAULT_MASTER_KEY`) into `.env`

> **Renamed from `.env.deploy`.** One file, at the repo root — a second dotfile is a
> second place to look and a second thing to forget when moving machines. `bootstrap`
> still _reads_ `.env.deploy` if `.env` is absent, so an existing machine keeps working
> and, more importantly, does not read as "no secrets present" — which is the state the
> rotation guard turns into a refusal. Delete the old file once a run has written the new
> one. `.env.example` is the committed, value-free copy of the shape.
> (gitignored, `chmod 600`) once — re-runs reuse them, no silent rotation — and
> installs each to the workers that read it. Paste the external creds (CF/SES
> rows below) into `.env` first so they install in the same pass; missing
> required ones are reported and skipped, so you can add them and re-run. The
> full matrix, by hand:

| Secret                                        | Worker                                                    | Value                  |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `INTERNAL_TOKEN`                              | jmap, submit, ingest, agent (same value)                  | `openssl rand -hex 24` |
| `SHARE_SIGNING_KEY`                           | jmap                                                      | `openssl rand -hex 32` |
| `ADMIN_TOKEN`                                 | provision                                                 | `openssl rand -hex 24` |
| `CF_API_TOKEN`                                | provision                                                 | token #1               |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | provision + submit                                        | IAM user               |
| `CF_EMAIL_API_TOKEN`                          | submit — only if RELAY=cloudflare (requires Workers Paid) | CF sending token       |

```sh
npx wrangler secret put INTERNAL_TOKEN -c services/jmap/wrangler.jsonc
# ... etc
```

**Do NOT set `DEV_BEARER_TOKEN` in production** — with it unset, auth
runs purely on the token table. Submit's `RELAY` var: `ses` (default;
sandbox delivers to your verified inbox on day one) or `mock` for
inbound-only first.

### The app surface — `app.bullmoose.cc` (Pages + Worker routes, ONE origin)

`webmail/` deploys to a **second** Pages project, `bullmoose-app`, via
`.github/workflows/deploy-app.yml`. The API is **not** a separate host: five
Worker routes on `services/jmap` claim the API paths on the same name, and Pages
serves everything else. Worker routes take precedence over Pages on a shared
hostname, so the two coexist.

That is deliberate. `services/jmap` sends **no CORS headers and has no `OPTIONS`
handler**, so an app on `app.` talking to an API on `api.` would die at the
browser's preflight before reaching a single route. Same-origin removes the CORS
surface rather than adding one to get wrong — and no credential crosses an
origin boundary.

| path                                                               | served by               |
| ------------------------------------------------------------------ | ----------------------- |
| `/.well-known/jmap`, `/api/*`, `/auth/*`, `/share/*`, `/console/*` | `bullmoose-jmap` worker |
| everything else (`/`, `/login`, `/mail`, `/calendar`, …)           | `bullmoose-app` Pages   |

`/console/*` is the agent console's read interface (s03.E, `services/jmap/src/console.ts`).
It is here, and not on the worker that owns `/vault/credentials`, for the same
CORS reason: `services/agent` has no public route and sends no CORS headers, so
a browser cannot read anything there. **The `/agents` screen 404s into Pages
until this route is deployed** — it is a new pattern, so an existing deployment
needs `deploy-mail.yml` re-run before the console goes live.

⚠️ **A single `/api/*` route is not enough** and looks like it is. The client
opens on `/.well-known/jmap` and the login door posts to `/auth/login`; neither
is under `/api`. A missing route falls through to Pages and returns **404 HTML**,
which reads as "the app is broken" rather than "the route is missing".
`webmail/src/lib/app/sameOrigin.test.ts` asserts the route list and that no app
page or nav section collides with it.

**Order matters:** deploy the worker (`deploy-mail.yml`) **before** the Pages
project. Reverse it and `/api/*` 404s into Pages while the login page renders
perfectly — the most confusing possible failure.

One-time human steps:

1. Run `deploy-mail.yml` so the routes exist.
   ⚠️ A `routes` pattern with `zone_name` binds paths on a hostname that must
   **already resolve** through Cloudflare — it does **not** provision DNS. (That
   is `custom_domain: true`, which these are not.) Attaching the Pages custom
   domain in step 2 is what creates the record; until then every path on
   `app.bullmoose.cc` fails to connect at all, routes or no routes.
2. Run `deploy-app.yml` once — it creates the `bullmoose-app` Pages project by
   direct upload — then map `app.bullmoose.cc` to it in the Pages dashboard.
3. **No new token.** It reuses `BULLMOOSE_SITE_DEPLOY_TOKEN`; a token scoped
   _Account > Cloudflare Pages: Edit_ covers every Pages project in the account,
   so a second project needs no widening. If a run 403s, that assumption was
   wrong — widen that one token rather than minting another.

And before any of it, run the migrations — `accounts.deleted_at` and
`grants.revoked_at` are both in `verifyBearer`'s path, so a worker deployed
against a database missing either **authenticates nobody**:

```sh
node infra/bootstrap.mjs migrate --dry-run   # then drop --dry-run
```

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
is, and lives in `.env` (`grep ADMIN_TOKEN .env`).

Note: `domain add` wires Email Routing + catch-all→ingest + SES identity

- DKIM/MAIL FROM/DMARC. If skipping SES for now, expect the `ses:*`
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
   `BULLMOOSE_RUNTIME_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repo secrets exist
4. SES config set → SNS → `/webhooks/ses` for bounce/complaint
   suppression (when RELAY=ses)

### Runbook: revoking share links

`bullmoose send` mints an expiring public URL for any attachment over
`--link-max` (default 4 MB), signed with `SHARE_SIGNING_KEY` and valid for up
to 90 days. Three levers, escalating:

| Reach          | Command                            | Effect                                                         |
| -------------- | ---------------------------------- | -------------------------------------------------------------- |
| one link       | `bullmoose share revoke <shareId>` | that URL stops resolving                                       |
| audit first    | `bullmoose share list`             | every link the server still has a record of, live ones first   |
| **everything** | rotate `SHARE_SIGNING_KEY`         | **every link, every account, instantly and irreversibly dead** |

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

Share-link _records_ live in KV under `share:` in the `ROUTES` namespace and
expire with the link they describe, so nothing accumulates and there is no
sweeper to run. Rotating the key does not clear them; they age out on their
own, and `share list` will show links that the rotation has already killed
until they do. That is cosmetic, but know it before reading the output.

### Runbook: an address already routes somewhere

`admin account create` is idempotent. Re-running it for an address that already
has a mailbox returns the **existing** account (`created: false`) and touches
nothing — safe to re-run a bootstrap, safe to retry after a timeout.

It refuses, `409`, when the address routes somewhere that is _not_ that mailbox:
a forward/alias/catch-all row, another tenant's account, a target account that
no longer exists, or a `--principal` that disagrees with who owns the account.
The response carries `existingRoute` so you can see what is in the way. **The
409 means delivery was left exactly as it was** — that is the point of it.

Before this was enforced, a second create for one address built a second
account and repointed delivery onto it. If you are on a deployment that ran the
old code, the symptom is _"mail stopped arriving"_ with everything reporting
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
binding, not by its token — revoking the token stops it _acting_ while
`services/ingest` keeps enqueueing a `pending` invocation on every delivery.

```sh
bullmoose admin agent list <account-email>          # binding ids
bullmoose admin agent disable <binding-id>          # no --yes: this is the safe direction
```

Both the ingest enqueue path and the agent drain gate on `agent_bindings.enabled`,
so this stops new invocations being created _and_ stops queued ones running.
Invocations already queued are **held, not cancelled** — the count is printed,
and they resume on `bullmoose admin agent enable <binding-id>`. If they are
stale by the time you re-enable, clear them first:

```sh
npx wrangler d1 execute bullmoose-mail-shard0 --remote \
  --command "UPDATE agent_invocations SET status='failed', note='cleared by operator'
             WHERE binding_id='<binding-id>' AND status='pending'"
```

### Runbook: an agent's proposals are not reaching you (s10 T7)

Symptom: an agent produced a real `pending` proposal and `/approvals` (or
`bullmoose approvals`) says **"Nothing is waiting on you."**

Cause, if the agent was provisioned before this landed: an agent lives on its
own account under its own **principal**, and the queue can only show accounts
the logged-in principal reaches. Provisioning now mints a _supervisory grant_
back to the owner at create time (`read`+`draft`+`send`, whole-account — enough
to read the queue and decide it, including the tier-3 wall a `reply-draft`
hits; deliberately **not** the `mail` bundle, which would also carry
move/delete over the agent's mailbox). Agents created earlier have no such
grant. Both fixes are idempotent — running them twice writes nothing new.

```sh
A=https://bullmoose-provision.<subdomain>.workers.dev
H="Authorization: Bearer $BULLMOOSE_ADMIN_TOKEN"

# 1. what exists
curl -s -H "$H" "$A/agent-bindings" | jq '.bindings[] | {id, name, account_id}'

# 2. per binding — the owner is derived when the tenant has exactly ONE human
#    principal, otherwise name them. Ambiguous ownership is REFUSED (422), never
#    guessed: a grant invented for the wrong human is a disclosure, not a fix.
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d '{}' "$A/agent-bindings/<binding-id>/supervisor"
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"ownerEmail":"eric@bullmoose.cc"}' "$A/agent-bindings/<binding-id>/supervisor"

# 3. bouncer@ has no single owner — it answers to the household, so re-running
#    its own provisioning call grants every human principal (idempotent: the
#    account, book and binding are untouched, `created` comes back false).
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"tenantId":"<tenant>","domain":"bullmoose.cc"}' "$A/bouncer"

# 4. verify — and this is also how you REVOKE supervision later
curl -s -H "$H" "$A/grants?email=eric@bullmoose.cc" | jq '.grants'
curl -s -X DELETE -H "$H" "$A/grants/<grant-id>"     # takes effect next request
```

The response's `supervision` object is the authority on what happened:
`{granted, created, grantId, scopes, owner}` — or `{granted:false, reason}`,
which always names what to do next. A grant an operator **narrowed** by hand is
reported as-is and never silently widened by a re-run.

### GHA repo secrets

Set from a machine with `gh` authed to the repo (the remote sandbox's
GitHub proxy blocks the Actions-secrets API on purpose, so this step is
manual). Worker _runtime_ secrets (INTERNAL_TOKEN, SES runtime pair,
SHARE_SIGNING_KEY, …) live in Cloudflare via `wrangler secret put` and
survive redeploys — they do NOT need to be mirrored into GHA. Only the
deploy-time credentials do:

```sh
R=ericdmoore/bullmoose.cc
gh secret set BULLMOOSE_RUNTIME_TOKEN -R $R # runtime: Workers Scripts/D1/KV/R2:Edit + Zone>Workers Routes:Edit
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
