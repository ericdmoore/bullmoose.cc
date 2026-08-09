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
  expires_at          INTEGER                -- epoch ms; NULL = no expiry
);
CREATE UNIQUE INDEX IF NOT EXISTS grants_tuple
  ON grants (grantee_account_id, target_account_id,
             COALESCE(collection, ''), COALESCE(collection_id, ''));
CREATE INDEX IF NOT EXISTS grants_target ON grants (target_account_id);

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
CREATE TABLE IF NOT EXISTS vault_credentials (
  id           TEXT PRIMARY KEY,             -- vc_<uuid>
  principal_id TEXT NOT NULL REFERENCES principals(id),
  name         TEXT NOT NULL,                -- "anthropic-api", "google-oauth"
  kind         TEXT NOT NULL,                -- 'api-key' | 'oauth-refresh'
  enc_json     TEXT NOT NULL,                -- {v:1, iv, ct} base64 envelope
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (principal_id, name)
);

-- Inbound address resolution. kind: 'mailbox' | 'alias' | 'forward' | 'catchall'
CREATE TABLE IF NOT EXISTS routes (
  domain      TEXT NOT NULL REFERENCES domains(domain),
  localpart   TEXT NOT NULL,               -- '*' for catch-all
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,               -- accountId | JSON array | external addr
  PRIMARY KEY (domain, localpart)
);
