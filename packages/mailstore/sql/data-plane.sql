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
  role          TEXT,                      -- inbox|sent|drafts|trash|junk|archive|quarantine
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
  -- s10 T1 — `allowedRecipients` as a governed address book: the outbound
  -- twin of config.allowedSenders, a TYPED column rather than a config_json
  -- key because the send path must resolve it server-side (a compromised
  -- agent must not even enumerate its own reach). NULL = no governing book =
  -- the binding CANNOT SEND (fail-closed, mirroring the Bureau's invariant 5
  -- in services/bureau/src/binding.ts — never default-allow).
  -- Existing DBs: infra/migrations.mjs `agent-bindings-recipients-book`.
  recipients_book_id TEXT,
  PRIMARY KEY (account_id, id)
);

-- s10 T4 — append-only lifecycle log for the BINDING itself, on the
-- grant_lifecycle model (control-plane.sql:197): no FK, because history has to
-- outlive the binding row a `--destroy` removes.
--
-- Why this is not a `book_membership_log` row, since that is the s10 T2 chain
-- for everything else about a governing book: that log's grain is
-- (book_id, address, added|removed) and its fold MUST reproduce the book's
-- current membership (`reconcileBookMembership` — divergence is an alarm, not a
-- log line). Re-pointing a binding at a different book changes no address in
-- either book, so there is no honest value for the NOT NULL `address` column;
-- and writing "removed" rows on the old book plus "added" rows on the new one
-- would make the fold disagree with both books and trip the reconciliation
-- invariant as a false tamper alarm. The membership chain answers "who is in
-- this book?"; this answers "which book governs this binding?" — two different
-- questions, so two logs rather than one overloaded grain.
--
-- One event today (`recipients-book-changed`), written by
-- `PATCH /agent-bindings/{id}` in the SAME db.batch as the UPDATE it describes.
-- old_value/new_value are the previous and next `recipients_book_id`; NULL on
-- either side is legible and load-bearing (NULL = unbound = cannot send).
-- `via_proposal_id` is the WHY, exactly as in grant_lifecycle: NULL for a
-- direct admin write, filled when a T3 proposal authorized the change.
--
-- New table, so a plain schema re-run creates it; listed in infra/migrations.mjs
-- (binding-lifecycle-table) so `bootstrap migrate` accounts for it.
CREATE TABLE IF NOT EXISTS binding_lifecycle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  binding_id      TEXT NOT NULL,             -- bind_xxxxxxxx (no FK — see above)
  event           TEXT NOT NULL,             -- 'recipients-book-changed'
  old_value       TEXT,                      -- previous recipients_book_id (NULL = was unbound)
  new_value       TEXT,                      -- next recipients_book_id (NULL = unbound ⇒ cannot send)
  actor           TEXT,                      -- acting principal, or 'admin' on the admin plane
  via_proposal_id TEXT,                      -- the WHY (s10 T2/T3); NULL for direct admin writes
  at              INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS binding_lifecycle_binding
  ON binding_lifecycle (account_id, binding_id, id);

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
  -- s07 T5 — what this invocation cost, frozen at capture by the drain's
  -- finish() and never recomputed from a later pricing map. cost_micros is
  -- micro-USD (1 USD = 1,000,000; integer, no float money). NULL vs 0 is
  -- load-bearing: 0 = known and genuinely free (Workers AI allocation);
  -- NULL = undetermined (unpriceable model, provider reported no usage,
  -- pre-migration row) and renders "not recorded", never $0.00. The token
  -- and provider/model columns are the receipt — they let the pricing
  -- formula be audited or refined later without touching the frozen answer.
  provider     TEXT,
  model        TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_micros  INTEGER,
  -- s11 T1 — the WORK's business deadline ("review this by Friday"), epoch ms.
  -- The THIRD clock, distinct from the two on agent_proposals: expires_at is
  -- the HUMAN's decide-by and hold_until the retraction window; due_at is when
  -- the work itself is due — the field the s11 eligibility gate (T2) will read.
  -- NULL = no known deadline = never-urgent (free-runtime-only, indefinitely).
  -- Stamped at the boundary by ingest's deterministic extraction (dueDate.ts),
  -- surfaced and correctable on the approval row (a proposal, never a hidden
  -- field — readme caution 3). Existing DBs: infra/migrations.mjs
  -- `invocation-due-at` — deliberately NOT a deploy blocker; every reader and
  -- writer degrades to "no deadline" on a shard that predates it.
  due_at       INTEGER,
  -- s11 T6 — facets: constraints the future claim gate reads, never
  -- prescriptions (jobs-and-facets.md §2). One author class per facet, nobody
  -- hand-authors per message; all NULL = DefaultCase = claimable exactly as
  -- today (facets tighten, never strand). Existing DBs: infra/migrations.mjs
  -- `invocation-facet-columns` — NOT a deploy blocker: nothing hot reads them
  -- yet (the mayClaim gate is s11 T2), and ingest's stamp UPDATE degrades to
  -- an unfaceted enqueue where they are missing.
  --   privacy       NULL | 'open' | 'internal' | 'pinned' — a CLASS, not a
  --                 score; composed max-wise against the binding's
  --                 config_json.privacyFloor at stamp time (the floor rule:
  --                 a stamp may raise, never lower below any implicated floor)
  --   sender_class  NULL | 'known' | 'unknown' | 'blocked' — the s12 boundary
  --                 agent (bouncer@) is its author; ingest has no sender
  --                 verdict today and leaves it NULL
  --   effort_prior  NULL | 'low' | 'med' | 'high' | 'max' — a prior that
  --                 seeds the cost estimate until per-kind history exists;
  --                 judged at the boundary (s12), NULL until then
  --   requires_json NULL or {"contextTokens"?: n, "vision"?: true,
  --                 "tools"?: true} — derived capability REQUIREMENTS
  --                 (capability, not model: requirements constrain, the
  --                 optimizer chooses); mechanical, stamped by ingest
  privacy       TEXT,
  sender_class  TEXT,
  effort_prior  TEXT,
  requires_json TEXT,
  -- s11 T2 — WHO claimed, as declared (trust-but-audit). The claim call
  -- carries a self-declared identity {isFree, capabilities?}; the claim
  -- UPDATE records it here. Both are FIT-shaped, never authority-shaped, so
  -- the gate trusts the declaration and the record is what lets the score
  -- audit a lie (a "free" claimant whose runs keep stamping cost_micros).
  --   claimant_free      1 = declared free (homelab/fleet host); 0 = paid or
  --                      undeclared (the conservative default); NULL = a
  --                      pre-T2 claim. Read back by the eligibility gate's
  --                      liveness inference: a claimant_free=1 claim within
  --                      the last 15 min = "a free runtime is live" (readme
  --                      decision 3, absence-inference).
  --   claimant_caps_json the declared capability vector ({vision?,
  --                      contextTokens?, tools?}), NULL if none declared.
  -- Existing DBs: infra/migrations.mjs `invocation-claimant-columns` — a
  -- DEPLOY BLOCKER: every T2 claim UPDATE SETs claimant_free and the gate's
  -- liveness subquery reads it, so a worker deployed first fails every claim.
  claimant_free      INTEGER,
  claimant_caps_json TEXT,
  -- s11 T3 — the overdue backstop's ALERT marker. The invariant the watchdog
  -- holds is "no invocation with a past due_at sits pending SILENTLY": past
  -- due, the cloud claims outside the policy gate (budget exhaustion is not
  -- allowed to strand work) — EXCEPT where it may not claim at all, and then
  -- the human is told instead. Two cases reach here:
  --   'overdue-pinned'  privacy = 'pinned' (devPlan decision 0: privacy beats
  --                     liveness; the work sits for a private runtime)
  --   'overdue-unfit'   the cloud's declared capability vector cannot satisfy
  --                     requires_json — claiming it would only fail
  -- This is deliberately NOT an ActionProposal: there is no decision to make
  -- and no action to approve, so a proposal row would be a second store of a
  -- fact the invocation already holds (arch.md §1's read-model rule). It is a
  -- marker: DURABLE (a row, not a log line), QUERYABLE (AgentInvocation/get
  -- projects it; AgentInvocation/query filters on it), and raised ONCE — the
  -- sweep's UPDATE guards on `alert_kind IS NULL`, so repeated sweeps over the
  -- same stuck row cannot storm. It is never cleared: that a deadline passed
  -- with nobody able to take the work is a FACT about this run, and it stays
  -- on the row after a homelab eventually claims it.
  alert_kind         TEXT,
  alert_at           INTEGER,
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
-- needsInfo (s10 T3, decline-taxonomy.md): the third verb. A human meets a
-- pending proposal with a required question instead of a verdict — status
-- 'pending' → 'info-requested', and the answer round runs as a NEW agent
-- invocation ('answer-info-request'), after which the row returns to
-- 'pending'. Three columns carry it, all following the edited_payload_json
-- discipline (append beside, never overwrite):
--   question             the human's CURRENT open question; NULL when no
--                        round is open. The full dialogue is amendments_json.
--   amendments_json      append-only Q&A rounds: [{question, answer, askedAt,
--                        answeredAt, askedBy}]. The agent's answer fills the
--                        LAST unanswered entry — rationale / evidence_json are
--                        the agent's originals and are never rewritten.
--   expires_remaining_ms the PAUSED pre-decision clock. needsInfo banks
--                        `expires_at - now` here and NULLs expires_at (the
--                        deadline must not lapse while the ball is in the
--                        agent's court); the answer restores
--                        `expires_at = now + this` and NULLs it back.
--                        NULL = not paused (or no deadline existed).
-- needsInfo is an ACTION, not a reject reason: it never writes decision_json,
-- so it can never be mistaken for negative feedback (the taxonomy's invariant:
-- tookItMyself/defer/needsInfo are excluded from the negative signal).
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
  status               TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|held|expired|info-requested
  decision_json        TEXT,             -- { by, reason, note } — the no-thanks signal (§3)
  created_at           INTEGER NOT NULL,  -- epoch ms
  decided_at           INTEGER,
  hold_until           INTEGER,          -- tier-2 POST-approval retraction window
  expires_at           INTEGER,          -- PRE-decision deadline; sweep flips pending→expired
  question             TEXT,             -- needsInfo: the open question (see header)
  amendments_json      TEXT,             -- needsInfo: append-only Q&A rounds
  expires_remaining_ms INTEGER,          -- needsInfo: the banked (paused) expiry window
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
  -- s10 T1 — per-book write policy, enforced ONCE at the Mailstore chokepoint
  -- (never per protocol; a fifth protocol added later must not bypass it):
  --   'open'     direct writes under ordinary grants (today's behavior)
  --   'propose'  humans write directly; AGENT writes are refused with a typed
  --              error telling them to file a proposal
  --   'governed' the full outbound bound: agent writes refused unless the
  --              write carries an approved proposal id; humans write through
  -- Existing DBs: infra/migrations.mjs `address-books-write-policy`.
  write_policy  TEXT NOT NULL DEFAULT 'open',
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

-- s10 T2 — append-only membership chain for policy != 'open' address books,
-- on the grant_lifecycle model (control-plane.sql): NO FK to contact_cards —
-- history outlives the card, and an unlogged remove would put a hole in the
-- chain exactly where someone would want one. One row per address a card
-- write adds to / removes from a book's effective membership, written by the
-- Mailstore chokepoint IN THE SAME db.batch as the card write (card + chain
-- commit together or neither — that atomicity is what kills dual-write
-- desync). `contact_cards.last_writer_*` shows only the LAST write; the
-- widen→send→narrow attack lives in the middle, which is why this is a chain
-- and why nothing compacts it (a cancelled add+remove pair is the record of a
-- window in which an agent could send). The fold over this log must reproduce
-- the book's current membership — `reconcileBookMembership` in
-- packages/mailstore is that invariant; divergence = a bug or a bypassed
-- write path, either way an alarm.
--
-- New table, so a plain schema re-run (CREATE TABLE IF NOT EXISTS) DOES
-- create it on an existing shard; listed in infra/migrations.mjs
-- (book-membership-log-table) so `bootstrap migrate` accounts for it —
-- precedent: agent_proposals above.
CREATE TABLE IF NOT EXISTS book_membership_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  book_id         TEXT NOT NULL,
  event           TEXT NOT NULL,             -- 'added' | 'removed'
  address         TEXT NOT NULL,             -- normalized (lowercased) email
  card_id         TEXT,                      -- the written card (no FK — see above)
  uid             TEXT,
  actor           TEXT,                      -- acting principal (login email)
  via_proposal_id TEXT,                      -- the WHY: the authorizing proposal (T3); NULL for direct human writes
  at              INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS book_membership_log_book
  ON book_membership_log (account_id, book_id, id);

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

-- ============================================================================
-- s12 wave 1-A — the boundary cascade's working data (.plans/s12-boundary).
--
-- Three stores, three audit fidelities (the readme's three-tiers table):
--   domain_deny_list   the industrial tier — bad-actor DOMAINS, bouncer@'s
--                      working data. Deliberately a plain table and NOT an
--                      address book: nothing social about 5k spam-farm
--                      domains, and nobody wants them in CardDAV.
--   deny_counters      the industrial tier's ONLY per-message write — a
--                      per-domain daily counter upsert. Never chain rows:
--                      an attacker must not be able to make us pay a D1
--                      chain INSERT per spam message.
--   quarantine_events  the append-only chain for everything with decision
--                      value: mid-band / personal-tier shunts, rescues,
--                      releases. book_membership_log model: no FK (history
--                      outlives the message), nothing compacts it.
--
-- All three are new tables, so a plain schema re-run DOES create them on an
-- existing shard; they are listed in infra/migrations.mjs (precedent:
-- agent-proposals-table) and are NOT deploy blockers — the boundary cascade
-- in services/ingest fails OPEN on a shard that lacks them (a missing
-- domain_deny_list reads as an empty deny list; a failed quarantine store
-- falls back to inbox delivery, logged).
-- ============================================================================

-- Tenant-scoped. `domain` is normalized: lowercase, no leading dot, no
-- trailing dot. `source` records who put it there; 'graduated' rows are the
-- graduation loop's policy-authorized writes and are the ONLY rows a
-- quarantine rescue demotes (the human correction always wins).
CREATE TABLE IF NOT EXISTS domain_deny_list (
  tenant_id TEXT NOT NULL,
  domain    TEXT NOT NULL,
  added_at  INTEGER NOT NULL,               -- epoch ms
  source    TEXT NOT NULL,                  -- 'feed' | 'graduated' | 'directive'
  evidence  TEXT,                           -- e.g. 'graduated: 20×bayes@0.99, 0 rescues'
  PRIMARY KEY (tenant_id, domain)
);

-- One cheap upsert per edge-rejected message; day is 'YYYY-MM-DD' (UTC).
-- Also the substrate for rejection-rate analytics (.backlog/bouncer-analytics).
CREATE TABLE IF NOT EXISTS deny_counters (
  domain TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, day)
);

-- The quarantine chain. `stage` names the firing cascade stage ('deny-list',
-- 'blocked-book:personal', 'auth:dmarc', 'sieve:<ruleId>', 'bayes@0.97') so
-- "why was this shunted?" is answerable by stage name, no archaeology.
-- email_id is the stored message when there is one (REJECT-STORE keeps the
-- message rescuable in the quarantine mailbox; REJECT-AT-EDGE stores nothing
-- and writes no chain row — counters only). actor carries the rescuing
-- principal; via_message_id cites the authenticated directive (s10 decision-5
-- pattern) when a conversation drove the event.
--
-- Events (s12 wave 2-C widened the vocabulary):
--   'shunted'   a rejection stage held the message ('llm:spam' when the
--               mid-band classifier confirmed a screened message)
--   'screened'  the Bayes MID-BAND held the message pending the classifier —
--               deliberately distinct from 'shunted': nothing has judged it
--               spam yet, the cascade is asking for the model's opinion
--   'rescued'   a HUMAN pulled it out (the correction that always wins)
--   'released'  the MACHINE let it through (classifier notSpam/unsure)
CREATE TABLE IF NOT EXISTS quarantine_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     TEXT NOT NULL,
  event          TEXT NOT NULL,             -- 'shunted' | 'screened' | 'rescued' | 'released'
  sender         TEXT NOT NULL,             -- normalized envelope sender
  domain         TEXT NOT NULL,             -- normalized sender domain
  stage          TEXT NOT NULL,             -- the firing stage (see above)
  email_id       TEXT,                      -- stored message, when there is one (no FK)
  actor          TEXT,                      -- rescuing principal (rescues have one)
  via_message_id TEXT,                      -- the authorizing directive's Message-ID
  at             INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS quarantine_events_account
  ON quarantine_events (account_id, id);
-- "Did I get mail from X in the last N days? Did you shunt it?" — the audit
-- query the chain exists to answer, so it gets its own index.
CREATE INDEX IF NOT EXISTS quarantine_events_sender
  ON quarantine_events (account_id, sender, id);

-- ============================================================================
-- s12 wave 2-C — the machine side's per-account state (.plans/s12-boundary).
--
--   sieve_rules  cascade stage 3's ruleset: ONE JSON document per account —
--                the serverless-jmap.md §17 "JSON ruleset in D1" start (the
--                synced-collection / ManageSieve story graduates later).
--                Validated against the SieveRule shape ON WRITE
--                (packages/mailstore putSieveRules refuses garbage); reads
--                fail open — a row that will not parse is NO rules, logged.
--   bayes_state  cascade stage 4's per-account filter: a JSON BayesState
--                (@bullmoose/boundary), pruned to VOCAB_CAP on every save.
--                A corrupt or oversized row loads as NULL and stage 4 skips
--                (fail open). Trained by quarantine rescues (ham), bouncer@
--                false-negative reports (spam, wave 2-D), and — only behind
--                the LLM_LABELS_TRAIN flag — classifier verdicts.
--
-- Both are new tables, so a plain schema re-run DOES create them; listed in
-- infra/migrations.mjs (sieve-rules-table, bayes-state-table) and NOT deploy
-- blockers — every read of them in the delivery path degrades to "no rules /
-- no state", which is DefaultCase behavior.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sieve_rules (
  account_id TEXT NOT NULL,
  rules_json TEXT NOT NULL,                  -- JSON array of SieveRule
  updated_at INTEGER NOT NULL,               -- epoch ms
  PRIMARY KEY (account_id)
);

CREATE TABLE IF NOT EXISTS bayes_state (
  account_id TEXT NOT NULL,
  state_json TEXT NOT NULL,                  -- JSON BayesState (VOCAB_CAP-pruned)
  updated_at INTEGER NOT NULL,               -- epoch ms
  PRIMARY KEY (account_id)
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
