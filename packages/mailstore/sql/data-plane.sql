-- Data plane: one D1 database per shard (shard = tenant, or account-hash
-- within a large tenant). All tables carry account_id.
-- Raw RFC 5322 messages live in R2 at mail/{tenant}/{account}/blobs/{blobId};
-- only metadata lives here.

CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  parent_id     TEXT,
  name          TEXT NOT NULL,
  role          TEXT,                      -- inbox|sent|drafts|trash|junk|archive
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_role
  ON mailboxes (account_id, role) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS emails (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  blob_id       TEXT NOT NULL,             -- content hash; key into R2
  thread_id     TEXT NOT NULL,
  message_id    TEXT,                      -- RFC 5322 Message-ID
  in_reply_to   TEXT,
  subject       TEXT NOT NULL DEFAULT '',
  from_json     TEXT NOT NULL DEFAULT '[]', -- JSON EmailAddress[]
  to_json       TEXT NOT NULL DEFAULT '[]',
  cc_json       TEXT NOT NULL DEFAULT '[]',
  bcc_json      TEXT NOT NULL DEFAULT '[]',
  preview       TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,          -- epoch ms
  has_attachment INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT NOT NULL DEFAULT '[]', -- JSON AttachmentMeta[]
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS emails_received ON emails (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS emails_thread   ON emails (account_id, thread_id);
CREATE INDEX IF NOT EXISTS emails_msgid    ON emails (account_id, message_id);

-- Full-text search backing Email/query text filters.
-- TODO: populate at ingest and swap the LIKE fallback in queryEmails for
-- an FTS MATCH once rowid<->email id mapping is in place.
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5 (
  subject, from_text, to_text, body_text,
  content='',            -- external-content: we only store the index
  tokenize='unicode61'
);

-- Email ↔ Mailbox membership (JMAP mailboxIds is a set).
CREATE TABLE IF NOT EXISTS email_mailboxes (
  account_id  TEXT NOT NULL,
  email_id    TEXT NOT NULL,
  mailbox_id  TEXT NOT NULL,
  PRIMARY KEY (account_id, email_id, mailbox_id)
);
CREATE INDEX IF NOT EXISTS email_mailboxes_mb
  ON email_mailboxes (account_id, mailbox_id);

-- JMAP keywords ($seen, $flagged, $draft, $answered, custom...).
CREATE TABLE IF NOT EXISTS email_keywords (
  account_id  TEXT NOT NULL,
  email_id    TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  PRIMARY KEY (account_id, email_id, keyword)
);

-- Armed responders (agent-integration.md §8): respond(template, wait,
-- cancelIf, suppression), armed at delivery, fired by the AccountDO alarm.
-- VacationResponse (RFC 8621 §8) is a facade over kind='vacation'.
CREATE TABLE IF NOT EXISTS responders (
  id               TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,             -- 'vacation' | 'watchdog'
  enabled          INTEGER NOT NULL DEFAULT 0,
  wait_seconds     INTEGER NOT NULL DEFAULT 0,
  cancel_if        TEXT NOT NULL DEFAULT 'never', -- 'never' | 'invocation-active'
  subject          TEXT,
  text_body        TEXT,
  from_date        INTEGER,                   -- vacation date range (epoch ms)
  to_date          INTEGER,
  suppress_seconds INTEGER NOT NULL DEFAULT 604800, -- once/sender/window
  PRIMARY KEY (account_id, id)
);

-- Per-sender suppression bookkeeping (RFC 3834 etiquette).
CREATE TABLE IF NOT EXISTS responder_log (
  account_id   TEXT NOT NULL,
  responder_id TEXT NOT NULL,
  sender       TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, responder_id, sender)
);

-- Agent bindings (agent-integration.md §2): which agents fire on delivery
-- to this account. sla_seconds set → a watchdog responder is armed per
-- delivery, canceled when the invocation is claimed.
CREATE TABLE IF NOT EXISTS agent_bindings (
  id           TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,                 -- matched by the runtime config
  trigger_on   TEXT NOT NULL DEFAULT 'mailbox-delivery',
  sla_seconds  INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- Cloud-runtime config: persona (L1), replyMode, allowedSenders,
  -- modelAliases/defaultModel (services/agent resolver), maxTokens.
  config_json  TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, id)
);

-- Agent invocations — a synced collection (the AccountDO changelog is
-- collection-agnostic). Pull-based: runtimes watch for pending work.
CREATE TABLE IF NOT EXISTS agent_invocations (
  id           TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  binding_id   TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  email_id     TEXT,                          -- primary context ref
  context_json TEXT NOT NULL DEFAULT '{}',
  result_json  TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  claimed_at   INTEGER,
  done_at      INTEGER,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS invocations_status
  ON agent_invocations (account_id, status);

-- JMAP EmailSubmission objects (RFC 8621 §7).
CREATE TABLE IF NOT EXISTS email_submissions (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  email_id      TEXT NOT NULL,
  identity_id   TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  undo_status   TEXT NOT NULL DEFAULT 'final', -- pending|final|canceled
  relay_message_id TEXT,
  send_at       INTEGER NOT NULL,          -- epoch ms
  PRIMARY KEY (account_id, id)
);
