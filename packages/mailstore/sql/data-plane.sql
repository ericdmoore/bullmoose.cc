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

-- Spend facts — the ledger behind analyst@ (agent ledger pipeline).
-- One row per extracted receipt; SQL owns every aggregate. The dedup
-- hash (vendor|amount|date) makes re-forwarded receipts a no-op.
CREATE TABLE IF NOT EXISTS spend_facts (
  account_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  email_id     TEXT,                           -- provenance ref
  vendor       TEXT NOT NULL,                  -- normalized: "sparkling-pools"
  amount_cents INTEGER NOT NULL,               -- never floats
  currency     TEXT NOT NULL DEFAULT 'USD',
  txn_date     TEXT NOT NULL,                  -- YYYY-MM-DD
  period_month TEXT NOT NULL,                  -- YYYY-MM, precomputed for GROUP BY
  category     TEXT NOT NULL DEFAULT 'other',
  confidence   REAL NOT NULL DEFAULT 1,
  dedup_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, dedup_hash)
);

CREATE INDEX IF NOT EXISTS idx_spend_facts_date
  ON spend_facts (account_id, currency, txn_date);

-- Address books (JMAP Contacts, RFC 9610). `ctag` is a per-collection
-- counter bumped on ANY member change — CardDAV clients poll, and a
-- stable ctag makes an idle poll O(1) instead of O(N) PROPFIND
-- (capability-roadmap: cost-critical on the free tier). The JMAP
-- sync-token stays the AccountDO global state sequence; ctag is DAV-only.
CREATE TABLE IF NOT EXISTS address_books (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  ctag          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,          -- epoch ms
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS address_books_default
  ON address_books (account_id) WHERE is_default = 1;

-- Contact cards. card_json = the JSContact Card (RFC 9553), the lossless
-- source of truth (never lose data to the column model); the rest are
-- extracted columns for query/sort. One address book per card in v1
-- (matches CardDAV; the blob keeps full addressBookIds; junction table
-- later if ever needed). uid is unique per account per RFC 9610.
CREATE TABLE IF NOT EXISTS contact_cards (
  id              TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  address_book_id TEXT NOT NULL,
  uid             TEXT NOT NULL,
  card_json       TEXT NOT NULL,
  name_full       TEXT,
  -- CardDAV resource name (client-chosen filename minus .vcf on PUT).
  -- NULL → the card id serves as the resource name. Existing DBs:
  --   ALTER TABLE contact_cards ADD COLUMN dav_name TEXT;
  dav_name        TEXT,
  created_at      INTEGER NOT NULL,        -- epoch ms; mirrors card.created
  updated_at      INTEGER NOT NULL,        -- epoch ms; mirrors card.updated
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, uid)
);
CREATE INDEX IF NOT EXISTS contact_cards_dav
  ON contact_cards (account_id, address_book_id, dav_name);
CREATE INDEX IF NOT EXISTS contact_cards_book
  ON contact_cards (account_id, address_book_id);
CREATE INDEX IF NOT EXISTS contact_cards_updated
  ON contact_cards (account_id, updated_at);

-- Calendars (JSCalendar-on-JMAP, Phase 4) — the contacts pattern
-- verbatim: blob = source of truth, extracted columns for queries,
-- per-collection ctag for the Phase 5 CalDAV poll short-circuit.
CREATE TABLE IF NOT EXISTS calendars (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  ctag          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS calendars_default
  ON calendars (account_id) WHERE is_default = 1;

-- event_json = the JSCalendar Event (RFC 8984), lossless. start_at /
-- end_at index the event's OUTER span in UTC ms: first occurrence start
-- → last occurrence end, with NULL end for unbounded recurrences (reads
-- as +infinity in time-range queries). Recurrence expansion is always
-- on-demand and capped (calendar-core) — never pre-computed rows.
CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  calendar_id  TEXT NOT NULL,
  uid          TEXT NOT NULL,
  event_json   TEXT NOT NULL,
  title        TEXT,
  start_at     INTEGER,
  end_at       INTEGER,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  dav_name     TEXT,                    -- reserved for Phase 5 CalDAV
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, uid)
);
CREATE INDEX IF NOT EXISTS calendar_events_cal
  ON calendar_events (account_id, calendar_id);
CREATE INDEX IF NOT EXISTS calendar_events_span
  ON calendar_events (account_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_events_updated
  ON calendar_events (account_id, updated_at);

-- DAV tombstones: a sync-collection REPORT must answer "what was
-- deleted" with the RESOURCE NAME the client knows, but the AccountDO
-- changelog only carries ids. Every contact-card destroy (JMAP or DAV)
-- records one; pruned opportunistically after 30 days (past the DO log
-- window, a client is forced into a full resync anyway).
CREATE TABLE IF NOT EXISTS dav_tombstones (
  account_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,          -- address book id
  item_id       TEXT NOT NULL,          -- destroyed card id
  resource_name TEXT NOT NULL,          -- dav_name ?? id at delete time
  deleted_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);

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
