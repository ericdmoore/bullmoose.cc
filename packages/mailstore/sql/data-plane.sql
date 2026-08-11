-- Data plane: one D1 database per shard (shard = tenant, or account-hash
-- within a large tenant). All tables carry account_id.
-- Raw RFC 5322 messages live in R2 at mail/{tenant}/{account}/blobs/{blobId};
-- only metadata lives here.

-- ============================================================================
-- Cross-realm provenance (s03.A T1) — the last_writer_* trio.
--
-- WHY. grant_audit only fires on *delegated* access (requireAccount writes it
-- when access is grant-reached), so an agent acting on its OWNER's account logs
-- nothing — "Emily's agent scrambled Emily's VendorsBook" produces zero audit
-- rows, exactly where you'd look first. These columns close that gap: every
-- mutable data-plane record carries who last wrote it, attributable to a
-- binding and an invocation when an agent acted.
--
--   last_writer_principal   -- acting login email; mirrors grant_audit.principal
--   last_writer_binding     -- agent binding name, when a binding acted (else NULL)
--   last_writer_invocation  -- agent_invocations.id, when applicable (else NULL)
--
-- Populated in the SHARED Mailstore write path (packages/mailstore insert/update
-- methods), never per JMAP method — a per-method implementation guarantees
-- silent drift. All three are NULLable so a null-provenance write (system paths,
-- pre-s03.A rows) is valid and the ALTER cannot fail on existing data.
--
-- NO MIGRATION FRAMEWORK (tools/README.md): this file is re-run as
-- CREATE TABLE IF NOT EXISTS, so only a FRESH database picks these up. An
-- EXISTING shard needs, by hand, BEFORE the workers that stamp them deploy
-- (precedent: contact_cards.dav_name below; full runbook: docs/DEPLOY.md):
--
--   ALTER TABLE emails          ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE emails          ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE emails          ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE mailboxes       ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE mailboxes       ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE mailboxes       ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE address_books   ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE address_books   ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE address_books   ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE contact_cards   ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE contact_cards   ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE contact_cards   ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE calendars       ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE calendars       ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE calendars       ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE calendar_events ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE calendar_events ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE calendar_events ADD COLUMN last_writer_invocation TEXT;
--   ALTER TABLE file_nodes      ADD COLUMN last_writer_principal  TEXT;
--   ALTER TABLE file_nodes      ADD COLUMN last_writer_binding    TEXT;
--   ALTER TABLE file_nodes      ADD COLUMN last_writer_invocation TEXT;
--
-- Order within the trio is irrelevant (independent NULL columns); the 21 ALTERs
-- have no cross-table ordering constraint. grants.revoked_at + grant_lifecycle
-- (s03.A T2) live in control-plane.sql with their own note.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  parent_id     TEXT,
  name          TEXT NOT NULL,
  role          TEXT,                      -- inbox|sent|drafts|trash|junk|archive
  sort_order    INTEGER NOT NULL DEFAULT 0,
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
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
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS emails_received ON emails (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS emails_thread   ON emails (account_id, thread_id);
CREATE INDEX IF NOT EXISTS emails_msgid    ON emails (account_id, message_id);

-- Full-text search backing Email/query's `text` filter (common/004).
--
-- Written by `Mailstore.insertEmail` and cleared by `Mailstore.destroyEmail`,
-- so every server write path — ingest, Email/set create, Email/import, the
-- agent worker — maintains it without knowing it exists.
--
-- `content=''` keeps this CONTENTLESS: only the inverted index is stored, not
-- a second copy of the body. That is the whole reason full bodies are
-- affordable here (see docs/architecture/capacity-and-scaling.md §1).
-- `contentless_delete=1` is what makes per-message removal possible at all —
-- without it SQLite refuses `DELETE FROM emails_fts`, and the only way to
-- retract a row would be to re-supply the exact original text, which lives in
-- R2 and not in D1. It requires SQLite >= 3.43 (D1 and node:sqlite both ship
-- newer). ⚠️ A pre-common/004 database has this table WITHOUT the flag, and the
-- `IF NOT EXISTS` below will not upgrade it — while `emails_fts_map` below IS
-- an ordinary CREATE TABLE and will appear. The two halves then disagree and
-- the failure is partial: delivery keeps working (INSERT is allowed on a
-- contentless table) but `Email/set destroy` throws "cannot DELETE from
-- contentless fts5 table" and rolls back. Migrate by hand FIRST — docs/DEPLOY.md,
-- "Upgrading an EXISTING database — common/004 full-text search".
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5 (
  subject, from_text, to_text, body_text,
  content='',            -- contentless: we only store the index
  contentless_delete=1,  -- ...but a message can still be un-indexed
  tokenize='unicode61'
);

-- rowid ↔ (account_id, email_id). A contentless FTS5 table returns NULL for
-- its own UNINDEXED columns, so the mapping cannot live inside `emails_fts`;
-- and an FTS5 rowid is an INTEGER while an email id is a TEXT uuid. This table
-- is the join, and `docid` is the only source of FTS rowids. AUTOINCREMENT is
-- deliberate: a reused rowid would silently attach one message's index entries
-- to another message's id.
CREATE TABLE IF NOT EXISTS emails_fts_map (
  docid      INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  email_id   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS emails_fts_map_email
  ON emails_fts_map (account_id, email_id);

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

-- ActionProposal (s03.D T1) — a READ MODEL over agent_invocations, NOT a
-- parallel store (arch.md §1). The invocation state machine
-- (pending→running→done→failed), its optimistic claim and its SLA watchdog are
-- the single source of truth for "what is the agent doing"; a second store would
-- diverge the first time a runner died mid-claim. So this 1:1 side table holds
-- ONLY the proposal-specific fields and `id` IS the invocation id it hangs off
-- (PRIMARY KEY (account_id, id), keyed the same) — `ActionProposal/*` projects
-- the JOIN. `agent` (binding) and the "what is it doing" status are read from
-- agent_invocations, never duplicated here (invariant §8.5: proposal state never
-- contradicts the invocation).
--
-- Two clocks that must NOT be conflated (s07 §T0/§T4):
--   expires_at  PRE-decision — how long until the human loses the chance to
--               decide. A `pending` proposal past it is what a sweep flips to
--               `expired` (services/agent scheduled hook).
--   hold_until  POST-approval — the tier-2 retraction window; how long an
--               approved-but-uncommitted action can still be yanked before it
--               becomes irreversible.
--
-- edited_payload_json is the load-bearing half of "the proposal is the source of
-- truth, a draft is a projection" (s07 §T4): a human edit is captured SEPARATELY
-- and NEVER overwrites payload_json, so the diff against the agent's original
-- survives — that is what lets a later score tell "approved clean" from
-- "approved after edit". Cost fields (tokens/cost/provider) are deliberately
-- absent — they are s07 T5's separate agent_invocations migration.
--
-- New table, so a plain schema re-run (CREATE TABLE IF NOT EXISTS) DOES create it
-- on an existing shard; it is still listed in infra/migrations.mjs
-- (agent-proposals-table) so `bootstrap migrate` accounts for it — precedent:
-- grant_lifecycle below in control-plane.sql.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id                   TEXT NOT NULL,     -- == agent_invocations.id (the 1:1 key)
  account_id           TEXT NOT NULL,
  kind                 TEXT NOT NULL,     -- reply-draft|unsubscribe|create-event|
                                          --   start-thread|create-contact|
                                          --   organize-files|grant-request
  tier                 INTEGER NOT NULL,  -- 1 reversible | 2 retractable | 3 irreversible
  subject_json         TEXT NOT NULL DEFAULT '{}',  -- { realm, objectId } — what it acts on
  payload_json         TEXT NOT NULL DEFAULT '{}',  -- kind-specific; the AGENT's version
  edited_payload_json  TEXT,              -- the HUMAN's edit; never overwrites payload_json
  rationale            TEXT NOT NULL,     -- the "why" — always present (invariant §8.3)
  evidence_json        TEXT NOT NULL DEFAULT '[]',  -- [{ realm, objectId, note }]
  status               TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|held|expired
  decision_json        TEXT,             -- { by, reason, note } — the no-thanks signal (§3)
  created_at           INTEGER NOT NULL,  -- epoch ms
  decided_at           INTEGER,
  hold_until           INTEGER,          -- tier-2 POST-approval retraction window
  expires_at           INTEGER,          -- PRE-decision deadline; sweep flips pending→expired
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS agent_proposals_status
  ON agent_proposals (account_id, status);
CREATE INDEX IF NOT EXISTS agent_proposals_expires
  ON agent_proposals (account_id, expires_at);

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
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
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
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
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
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
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
  last_writer_principal   TEXT,          -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
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

-- FileNode inodes (JMAP for Files, draft-ietf-jmap-filenode-14). The inode
-- metadata layer over the EXISTING blob path: content bytes stay in R2 at
-- mail/{tenant}/{account}/blobs/{blobId} (no new storage code); this table is
-- the tree. A blob referenced by a live FileNode is PINNED — handleBlobDelete
-- refuses to remove it (services/jmap/src/index.ts), which is the blob-pinning
-- invariant landing WITH the schema (s03.B/arch.md §3), not after.
--
-- node_type: 'file' (blob_id required) | 'directory' | 'symlink' (blob_id null).
-- The four timestamps are epoch ms; the JMAP layer emits them as UTCDate
-- strings. role is 'root'|'home'|'trash'|... (nullable; unconstrained in v1).
--
-- Sibling-name uniqueness is UNIQUE(account_id, parent_id, name). NOTE the
-- SQLite NULL caveat: two top-level nodes (parent_id NULL) with the same name do
-- NOT collide under this constraint, because NULLs compare distinct — so the
-- METHOD LAYER's onExists check is the primary enforcement (and the only one
-- that can do compareCaseInsensitively). This constraint is the backstop for
-- non-NULL parents.
CREATE TABLE IF NOT EXISTS file_nodes (
  id            TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  parent_id     TEXT,                      -- NULL = top level
  name          TEXT NOT NULL,
  node_type     TEXT NOT NULL,             -- file | directory | symlink
  blob_id       TEXT,                      -- key into R2; required for files
  size          INTEGER,                   -- bytes; files only
  type          TEXT,                      -- IANA media type; files only
  created       INTEGER NOT NULL,          -- epoch ms
  modified      INTEGER NOT NULL,          -- content last modified
  accessed      INTEGER NOT NULL,          -- last read
  changed       INTEGER NOT NULL,          -- metadata last changed
  executable    INTEGER NOT NULL DEFAULT 0,
  is_subscribed INTEGER NOT NULL DEFAULT 1,
  role          TEXT,
  last_writer_principal   TEXT,             -- provenance (s03.A T1) — see header
  last_writer_binding     TEXT,
  last_writer_invocation  TEXT,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, parent_id, name)
);
CREATE INDEX IF NOT EXISTS file_nodes_parent
  ON file_nodes (account_id, parent_id);
CREATE INDEX IF NOT EXISTS file_nodes_blob
  ON file_nodes (account_id, blob_id);
CREATE INDEX IF NOT EXISTS file_nodes_changed
  ON file_nodes (account_id, changed);

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
