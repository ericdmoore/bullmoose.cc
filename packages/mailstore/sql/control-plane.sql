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
  created_at    INTEGER NOT NULL
);

-- From-addresses an account may send as (JMAP Identity objects).
CREATE TABLE IF NOT EXISTS identities (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  email       TEXT NOT NULL,               -- must be on an active domain
  name        TEXT NOT NULL DEFAULT '',
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
  scopes        TEXT NOT NULL DEFAULT '["mail"]', -- JSON array
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
