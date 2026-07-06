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
  pw_algo      TEXT NOT NULL DEFAULT 'pbkdf2-sha256', -- future: 'argon2id' (WASM)
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

-- Inbound address resolution. kind: 'mailbox' | 'alias' | 'forward' | 'catchall'
CREATE TABLE IF NOT EXISTS routes (
  domain      TEXT NOT NULL REFERENCES domains(domain),
  localpart   TEXT NOT NULL,               -- '*' for catch-all
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,               -- accountId | JSON array | external addr
  PRIMARY KEY (domain, localpart)
);
