-- Control plane: tenants, domains, principals, accounts, routing.
-- Small, low-write, source of truth. The route table is mirrored into KV
-- for the ingest hot path.

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,            -- t_<slug>
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  domain      TEXT PRIMARY KEY,            -- example.com
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  -- pending_dns → pending_ses → active → suspended
  status      TEXT NOT NULL DEFAULT 'pending_dns',
  cf_zone_id  TEXT,
  ses_identity_arn TEXT,
  created_at  INTEGER NOT NULL
);

-- An authenticated login. One principal may own several accounts
-- (e.g. alice@a.com and alice@b.com surfaced in one JMAP Session).
CREATE TABLE IF NOT EXISTS principals (
  id            TEXT PRIMARY KEY,          -- p_<uuid>
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  login_email   TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,          -- t_<tenant>__a_<uuid>
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  display_name  TEXT NOT NULL,
  shard         TEXT NOT NULL DEFAULT 'shard0',  -- data-plane D1 database
  created_at    INTEGER NOT NULL,
  -- Tombstone (sVOL 008). NULL = live; epoch ms = deleted.
  --
  -- `DELETE /accounts/{id}` is SOFT, and deliberately: an account's mail,
  -- calendars, contacts and R2 blobs live on `shard`, which the provision
  -- worker cannot reach. Dropping this row would strand every one of those
  -- rows unattributable — the id in `emails.account_id` would resolve to
  -- nothing. Delivery is what actually stops: the KV route key and the
  -- `routes` row go at tombstone time, so mail bounces 550 immediately.
  --
  -- Every RESOLUTION path filters `deleted_at IS NULL`, so live behaviour is
  -- identical while history survives (same bargain as s03.A T2's grant
  -- tombstones): auth-core `verifyBearer`, the jmap worker's /auth/login
  -- account list, the agent drain's accounts join, and provision's own
  -- `listAccounts` / `accountByAddress` / `accountWithTenant`.
  --
  -- ⚠️ No migration framework — this file is CREATE TABLE IF NOT EXISTS, so
  -- only a FRESH database picks this up. An EXISTING one needs, by hand,
  -- BEFORE deploying the workers (auth stops resolving without it):
  --   ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
  -- Precedent: contact_cards.dav_name (data-plane.sql). See docs/DEPLOY.md.
  deleted_at    INTEGER
);

-- From-addresses an account may send as (JMAP Identity objects).
--
-- Everything below `name` was added by sVOL 006 (`Identity/set`). This repo
-- has no migration framework — schema is applied by re-running these files
-- with CREATE TABLE IF NOT EXISTS (tools/README.md) — so new columns follow
-- the contact_cards.dav_name convention: declared here so fresh deploys are
-- correct, with the ALTER an operator must run on an EXISTING database
-- written beside them. Every one is nullable or defaulted, which is what
-- makes the ALTER safe on SQLite (it rewrites no rows and cannot fail on
-- existing data).
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  email       TEXT NOT NULL,               -- must be on an active domain
  name        TEXT NOT NULL DEFAULT '',
  -- RFC 8621 §6.1 Identity properties. replyTo/bcc are JSON EmailAddress[]
  -- (or NULL for "unset"), matching how the data plane already stores
  -- address lists — emails.from_json et al. Signatures are hints the CLIENT
  -- inserts when composing (§6.1: "a signature the client SHOULD insert"),
  -- so nothing on the relay path reads them. Existing DBs:
  --   ALTER TABLE identities ADD COLUMN reply_to_json TEXT;
  --   ALTER TABLE identities ADD COLUMN bcc_json TEXT;
  --   ALTER TABLE identities ADD COLUMN text_signature TEXT NOT NULL DEFAULT '';
  --   ALTER TABLE identities ADD COLUMN html_signature TEXT NOT NULL DEFAULT '';
  --   ALTER TABLE identities ADD COLUMN may_delete INTEGER NOT NULL DEFAULT 1;
  --   UPDATE identities SET may_delete = 0;   -- see below
  reply_to_json   TEXT,
  bcc_json        TEXT,
  text_signature  TEXT NOT NULL DEFAULT '',
  html_signature  TEXT NOT NULL DEFAULT '',
  -- 0 = the account's provisioned primary, which EmailSubmission/set needs
  -- to keep resolving; Identity/set refuses to destroy it. The DEFAULT is 1
  -- because user-added identities are the common case, but every row that
  -- already exists when this column lands was written by provisioning
  -- (services/provision) and is therefore a primary — hence the one-time
  -- UPDATE in the ALTER block above. Run it, or an operator's first
  -- `identity rm` can delete the only address the account can send from.
  may_delete      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, email)
);

-- Primary login credential (password → mints tokens; passkeys later).
CREATE TABLE IF NOT EXISTS credentials (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  pw_algo      TEXT NOT NULL DEFAULT 'client-pbkdf2-sha256-v1', -- future: client argon2id (WASM)
  pw_hash      TEXT NOT NULL,
  pw_salt      TEXT NOT NULL,
  pw_iters     INTEGER NOT NULL,          -- self-describing: verify uses the row's params
  updated_at   INTEGER NOT NULL
);

-- Scoped revocable bearer tokens: device tokens, agent tokens, admin
-- tokens — one table, one verification path. Plaintext secret is shown
-- once at mint; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,          -- tk_<hex>, embedded in bm_ string
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  kind          TEXT NOT NULL DEFAULT 'bearer',   -- future: 'pubkey'
  secret_hash   TEXT NOT NULL,
  name          TEXT NOT NULL,             -- "eric-laptop", "hermes-runtime"
  -- JSON array. Every code path supplies this explicitly (the workers now
  -- refuse a mint that omits it), so the column default only fires for a
  -- hand-written INSERT — exactly the case where failing narrow beats
  -- failing wide. It was '["mail"]', i.e. an ad-hoc row silently got a full
  -- mail credential. Existing databases keep their old default: this file
  -- is CREATE TABLE IF NOT EXISTS, so only fresh ones pick this up.
  scopes        TEXT NOT NULL DEFAULT '["read"]',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_principal ON tokens (principal_id);

-- Cross-account delegation + sharing (devPlan-handoff Phase 3). A grant
-- lets every token of the principal owning grantee_account_id act on
-- target_account_id, restricted to `scopes` — the SAME vocabulary as
-- token scopes (read/annotate/draft/move/send/delete/contacts), so one
-- scope system governs both — and optionally to a single collection
-- (e.g. one shared AddressBook: collection='AddressBook',
-- collection_id='ab_…'; NULL collection = the whole account, the
-- agent-delegation shape). Effective rights = token scopes ∩ grant
-- scopes. Owner/operator-minted only; every granted access is audited.
CREATE TABLE IF NOT EXISTS grants (
  id                  TEXT PRIMARY KEY,      -- g_<uuid>
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  grantee_account_id  TEXT NOT NULL REFERENCES accounts(id),
  target_account_id   TEXT NOT NULL REFERENCES accounts(id),
  scopes              TEXT NOT NULL,         -- JSON array
  collection          TEXT,                  -- NULL | 'AddressBook' (calendar later)
  collection_id       TEXT,
  created_by          TEXT NOT NULL,         -- minting principal id, or 'admin'
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,               -- epoch ms; NULL = no expiry
  -- Tombstone (s03.A T2). NULL = live; epoch ms = revoked. `008` deliberately
  -- left `grants` on hard-DELETE with a note that s03.A owns their lifecycle;
  -- this is that lifecycle. `revokeGrant` now SETs this instead of DELETEing, so
  -- "who could have done this last Tuesday?" stays answerable — a point-in-time
  -- query returns the historical set including since-revoked rows, and every
  -- RESOLUTION path filters `revoked_at IS NULL` (auth-core verifyBearer's grant
  -- load), so live behaviour is identical while history survives. Same bargain
  -- as accounts.deleted_at. The tenant-teardown cascade (deleteTenant) keeps its
  -- hard DELETE — the whole tenant is going away, so there is no history to keep.
  --
  -- NO migration framework — CREATE TABLE IF NOT EXISTS, so only a FRESH DB picks
  -- this up. An EXISTING one needs, by hand, BEFORE the workers deploy
  -- (precedent: contact_cards.dav_name in data-plane.sql; see docs/DEPLOY.md):
  --   ALTER TABLE grants ADD COLUMN revoked_at INTEGER;
  revoked_at          INTEGER
);
-- PARTIAL on `revoked_at IS NULL`, and it has to be. s03.A turned revocation
-- into a tombstone, so the row survives — and a plain unique index would let
-- that dead row occupy the tuple forever, making "revoke, then change your
-- mind" impossible. Worse than impossible, in fact: `createGrant` inserts with
-- `ON CONFLICT DO NOTHING`, so the re-grant is a silent no-op that still
-- returns 200 with a grantId no row carries. Verified against the real index
-- before this line was added — insert, tombstone, re-insert, constraint fails.
-- ⚠️ A database created before this changed has the NON-partial index and
-- `IF NOT EXISTS` will not replace it. DROP INDEX grants_tuple first —
-- docs/DEPLOY.md.
CREATE UNIQUE INDEX IF NOT EXISTS grants_tuple
  ON grants (grantee_account_id, target_account_id,
             COALESCE(collection, ''), COALESCE(collection_id, ''))
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS grants_target ON grants (target_account_id);

-- Append-only lifecycle log for grants (s03.A T2). One row per lifecycle
-- transition — the forensic record that survives even a hard tenant-teardown
-- delete of the grants row, exactly as grant_audit does. No FK to `grants` (like
-- grant_audit): the point is that history outlives the grant. `revoked_at` on
-- `grants` answers "is it live now?"; this answers "what happened to it, when,
-- and who did it?". Created rows are logged by createGrant; revocations by
-- revokeGrant. `expired` is reserved for a future expiry sweeper (nothing writes
-- it yet — expiry is currently computed at read time from `expires_at`).
--
-- This is a NEW table, so a fresh CREATE TABLE IF NOT EXISTS run creates it on
-- both fresh and existing databases (unlike an ADD COLUMN). See docs/DEPLOY.md.
CREATE TABLE IF NOT EXISTS grant_lifecycle (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id    TEXT NOT NULL,                 -- g_<uuid> (no FK — history outlives the grant)
  event       TEXT NOT NULL,                 -- 'created' | 'revoked' | 'expired'
  at          INTEGER NOT NULL,              -- epoch ms
  actor       TEXT,                          -- minting/revoking principal id, or 'admin'; NULL if unknown
  -- s10 T2 — the WHY. `actor` says who; this links the authorizing proposal
  -- (rationale, evidence, approver, edit-diff all ride on it, and it cannot be
  -- faked because it is the actual authorization record). NULL when no
  -- proposal was in scope (today's admin-plane writers); T3 fills it.
  -- Existing DBs: infra/migrations.mjs `grant-lifecycle-via-proposal`.
  via_proposal_id TEXT
);
CREATE INDEX IF NOT EXISTS grant_lifecycle_grant ON grant_lifecycle (grant_id, at);

-- Append-only audit of granted (cross-account) access: one row per
-- JMAP method call a grantee makes against a target account.
CREATE TABLE IF NOT EXISTS grant_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id    TEXT NOT NULL,
  principal   TEXT NOT NULL,                 -- acting login email
  account_id  TEXT NOT NULL,                 -- target account
  method      TEXT NOT NULL,                 -- scope:domain acted under
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grant_audit_account ON grant_audit (account_id, at);

-- Credential vault (Phase 3, Q2 "build it right"): per-principal
-- third-party secrets, envelope-encrypted with the agent worker's
-- master secret (see auth-core sealSecret: HKDF per row + AES-256-GCM,
-- AAD binds principal+name so rows can't be swapped). WRITE-ONLY API:
-- a stored secret is never returned; the agent worker decrypts
-- in-process when acting. meta_json is non-secret (provider, endpoints,
-- client_id, scopes). Named vault_credentials because `credentials`
-- already holds login-password rows.
--
-- The Bureau's mint-time contract (bureau.md §5, sVOL 020) rides in
-- meta_json under RESERVED keys rather than typed columns — deliberately,
-- so the unit stays E2 with no migration (this repo has no migration
-- framework; tools/README.md:10-11). Reserved keys:
--   allow        destination binding, normalized origin or *.wildcard (§6)
--   header       injection recipe "Name: …{}…" (§5), header-only (invariant 8)
--   scope        'actor' today; 'inbox'/'global' need the AAD re-seal (§9)
--   enforcement  'federated' | 'narrow' | 'broad' — who enforces §5.2's
--                narrowing ('broad' = only our code, once the proxy exists)
-- Promote `allow` to a typed, indexed column (an E3 ALTER) only when the
-- Bureau proxy exists and needs to query it — not before.
CREATE TABLE IF NOT EXISTS vault_credentials (
  id           TEXT PRIMARY KEY,             -- vc_<uuid>
  principal_id TEXT NOT NULL REFERENCES principals(id),
  name         TEXT NOT NULL,                -- "anthropic-api", "google-oauth"
  kind         TEXT NOT NULL,                -- 'api-key'|'oauth-refresh'|'aws-sigv4'|'hmac-key'
  enc_json     TEXT NOT NULL,                -- {v:1, iv, ct} base64 envelope
  meta_json    TEXT NOT NULL DEFAULT '{}',   -- non-secret; carries the §5 mint-time fields
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (principal_id, name)
);

-- Bureau grants (bureau.md §5.1, s04 T2): who may USE a credential, and for
-- WHICH verb. Deliberately NOT a mint-time field on vault_credentials — it is a
-- separate, revocable record over `(principal, credRef, verb)`:
--
--     p_allen may use `sign_sigv4` with `aws-mcp`
--
-- capability-shaped, never access-shaped ("p_allen may read aws-mcp"). Separate
-- from the credential row is the point: revoking a grant leaves the credential
-- and its sibling grants untouched.
--
-- ⚠️ Why its OWN table rather than `grants`. `grants` is account→account sharing:
-- `grantee_account_id` → `target_account_id`, plus a JMAP scope list and an
-- optional collection, and `verifyBearer` JOINs it to `accounts` to widen a
-- principal's reach. A Bureau grant has no target account, no scope list and no
-- collection — it names a credential by handle and exactly one verb. Overloading
-- `grants` would mean a nullable `target_account_id` on a `NOT NULL REFERENCES`
-- column and teaching `verifyBearer`'s hot join to skip a row shape it must never
-- resolve: a live authentication path made conditional to save one table. The
-- tombstone CONTRACT is what gets reused, not the table.
--
-- Tombstone (same bargain as `grants.revoked_at`, s03.A T2): revoke SETs
-- `revoked_at` rather than DELETEing, every resolution path filters
-- `revoked_at IS NULL`, and the row plus its `grant_lifecycle` history survive so
-- "who could have signed with this key last Tuesday?" stays answerable.
--
-- Re-granting a revoked tuple REINSTATES the row (`revoked_at = NULL`) and logs a
-- fresh 'created' event, rather than silently no-opping on the unique index the
-- way `grants`' `ON CONFLICT DO NOTHING` does. The forensic record lives in
-- `grant_lifecycle`, so reuse of the row costs no history.
--
-- `cred_name` is the public handle (`vault_credentials.name`), not the row id —
-- it is what agent configs carry (`credentialRef: "aws-mcp"`) and it survives a
-- rotate. Under today's `scope=actor` the credential resolves within the SAME
-- principal (the AAD binds principal+name), so `principal_id` identifies both the
-- grantee and the credential's owner; §9/T6's re-scope is what separates them.
--
-- NEW table, so `CREATE TABLE IF NOT EXISTS` creates it on fresh AND existing
-- databases (unlike an ADD COLUMN). See docs/DEPLOY.md.
CREATE TABLE IF NOT EXISTS bureau_grants (
  id           TEXT PRIMARY KEY,             -- bg_<uuid>
  principal_id TEXT NOT NULL REFERENCES principals(id),
  cred_name    TEXT NOT NULL,                -- credRef — vault_credentials.name
  verb         TEXT NOT NULL,                -- 'fetch'|'oauth_token'|'sign_sigv4'|'hmac_sha256'
  created_by   TEXT NOT NULL,                -- minting principal id, or 'admin'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,                      -- epoch ms; NULL = no expiry
  revoked_at   INTEGER                       -- tombstone; NULL = live
);
-- NOT partial, deliberately — unlike `grants_tuple` above, which is. The two
-- tables solve the revoke-then-re-grant problem differently and each index has
-- to match its own writer:
--
--   bureau_grants  upserts. `grantVerb` does ON CONFLICT (principal_id,
--                  cred_name, verb) DO UPDATE SET revoked_at = NULL, which
--                  RESURRECTS the tombstoned row. A partial index breaks that
--                  outright: SQLite matches a conflict target against a unique
--                  index, and a partial one needs its WHERE clause repeated in
--                  the target. (Learned by making this partial and watching 14
--                  tests fail to even prepare.)
--
--   grants         inserts with ON CONFLICT DO NOTHING and no resurrection
--                  path, so the tombstone would sit on the tuple forever.
--                  Hence the partial index there.
--
-- Resurrection also erases `revoked_at`, so the fact of the revocation lives
-- only in `grant_lifecycle`; the partial-index approach keeps the tombstone as
-- a row. Both are defensible. What is not defensible is one index shape
-- assumed to fit both writers.
CREATE UNIQUE INDEX IF NOT EXISTS bureau_grants_tuple
  ON bureau_grants (principal_id, cred_name, verb);
CREATE INDEX IF NOT EXISTS bureau_grants_cred ON bureau_grants (principal_id, cred_name);

-- Inbound address resolution. kind: 'mailbox' | 'alias' | 'forward' | 'catchall'
CREATE TABLE IF NOT EXISTS routes (
  domain      TEXT NOT NULL REFERENCES domains(domain),
  localpart   TEXT NOT NULL,               -- '*' for catch-all
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,               -- accountId | JSON array | external addr
  PRIMARY KEY (domain, localpart)
);
