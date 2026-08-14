// Migrations that a schema re-run CANNOT perform.
//
// `infra/bootstrap.mjs schemas` applies the two .sql files and calls itself
// idempotent because "every DDL is IF NOT EXISTS". That is true and it is the
// trap: `IF NOT EXISTS` is idempotent for CREATING and silently declines to
// UPGRADE. An existing database keeps its old column set, its old index
// definition, its old virtual-table flags — and says nothing.
//
// Every failure that has come out of this is silent and partial:
//
//   grants_tuple non-partial   revoke-then-re-grant is a no-op that still
//                              returns 200 with a grantId no row carries
//   emails_fts sans flag       delivery works, `Email/set destroy` throws
//                              `cannot DELETE from contentless fts5 table`
//   accounts.deleted_at        verifyBearer authenticates NOBODY
//
// Before this file the knowledge lived in three places that disagreed:
// docs/DEPLOY.md prose, comments inside the .sql files (the whole `identities`
// migration existed ONLY there and was absent from DEPLOY.md), and operator
// memory. One machine-readable list with an executable check each is the point.
//
// Shape of an entry:
//   id      stable slug, used in output and to skip work
//   why     one line; why this matters, in failure terms
//   blocks  "deploy" if workers break without it, else null
//   check   ONE SQL statement returning a column `n`. Applied iff n >= 1.
//           Written to run identically on D1 and node:sqlite — pragma
//           functions and sqlite_master only, no wrangler-specific output
//           parsing.
//   up      SQL statements to apply it, in order
//   absent  TEST ONLY. Statements that build a MINIMAL database in which this
//           migration is not yet applied — enough tables for `up` to run, and
//           nothing more. The round-trip test uses it to prove `check` reports
//           "missing" when it is missing, then flips after `up`.
//
//           This deliberately does NOT reverse the real schema with
//           `ALTER TABLE … DROP COLUMN`. That worked locally and failed in CI
//           with `incomplete input`: dropping a column makes SQLite re-parse
//           the table's whole stored CREATE, and older builds choke on it. A
//           test that passes on one SQLite and fails on another is not a test
//           of this repo. Building the absent case forward is version-proof.
//   needs   ids this one depends on. A REAL constraint, not documentation: the
//           partial `grants_tuple` references `grants.revoked_at`, so the index
//           cannot be built before the column exists, and the column cannot be
//           dropped while the index exists. Found by the round-trip test
//           failing (`no such column: revoked_at`), not by reading.

const hasColumn = (table, col) =>
  `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${col}'`;

const objectSqlContains = (type, name, needle) =>
  `SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = '${type}' AND name = '${name}' AND sql LIKE '%${needle}%'`;

const tableExists = (name) =>
  `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '${name}'`;

/** The 7 tables that carry s03.A provenance, and the 3 columns each. */
const PROVENANCE_TABLES = [
  "emails",
  "mailboxes",
  "address_books",
  "contact_cards",
  "calendars",
  "calendar_events",
  "file_nodes",
];
const PROVENANCE_COLUMNS = ["last_writer_principal", "last_writer_binding", "last_writer_invocation"];

export const MIGRATIONS = [
  {
    id: "accounts-deleted-at",
    why: "verifyBearer filters `deleted_at IS NULL`; without the column grant resolution throws and NOBODY authenticates",
    blocks: "deploy",
    check: hasColumn("accounts", "deleted_at"),
    up: ["ALTER TABLE accounts ADD COLUMN deleted_at INTEGER"],
    absent: ["CREATE TABLE accounts (id TEXT PRIMARY KEY)"],
  },

  {
    id: "grants-revoked-at",
    why: "same shape as deleted_at — verifyBearer filters `revoked_at IS NULL`, so a missing column breaks every grant lookup",
    blocks: "deploy",
    check: hasColumn("grants", "revoked_at"),
    up: ["ALTER TABLE grants ADD COLUMN revoked_at INTEGER"],
    absent: ["CREATE TABLE grants (id TEXT PRIMARY KEY, grantee_account_id TEXT, target_account_id TEXT, collection TEXT, collection_id TEXT)"],
  },

  {
    id: "grant-lifecycle-table",
    why: "s03.A's append-only lifecycle log; a plain schema re-run DOES create this one, it is listed so the set is complete",
    blocks: null,
    check: tableExists("grant_lifecycle"),
    up: [
      `CREATE TABLE IF NOT EXISTS grant_lifecycle (
         id       INTEGER PRIMARY KEY AUTOINCREMENT,
         grant_id TEXT NOT NULL,
         event    TEXT NOT NULL,
         at       INTEGER NOT NULL,
         actor    TEXT
       )`,
      "CREATE INDEX IF NOT EXISTS grant_lifecycle_grant ON grant_lifecycle (grant_id, at)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "oauth-consents-table",
    why: "s02 T4's D1 mirror of OAuth grants; without it the console answers 'who can reach my mail' with silence for every connected client",
    // Non-blocking: nothing AUTHORIZES against this table (KV stays canonical),
    // so its absence degrades a human-facing answer rather than breaking a
    // request path. The AS's write is guarded, so a shard that predates this
    // migration keeps issuing tokens — it just cannot show them yet.
    blocks: null,
    check: tableExists("oauth_consents"),
    up: [
      `CREATE TABLE IF NOT EXISTS oauth_consents (
         id            TEXT PRIMARY KEY,
         principal_id  TEXT NOT NULL,
         client_id     TEXT NOT NULL,
         client_name   TEXT,
         redirect_host TEXT,
         scopes        TEXT NOT NULL,
         resource      TEXT,
         created_at    INTEGER NOT NULL,
         revoked_at    INTEGER
       )`,
      "CREATE INDEX IF NOT EXISTS oauth_consents_principal ON oauth_consents (principal_id, created_at)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "grants-tuple-partial",
    why: "a tombstoned grant occupies its tuple forever, so revoke-then-re-grant is a SILENT no-op that still returns 200 with a grantId no row carries",
    blocks: null,
    needs: ["grants-revoked-at"],
    check: objectSqlContains("index", "grants_tuple", "revoked_at IS NULL"),
    up: [
      "DROP INDEX IF EXISTS grants_tuple",
      `CREATE UNIQUE INDEX grants_tuple
         ON grants (grantee_account_id, target_account_id,
                    COALESCE(collection, ''), COALESCE(collection_id, ''))
         WHERE revoked_at IS NULL`,
    ],
    absent: [
      // The pre-s03.A world: the column exists (its own migration ran) but the
      // index is still the plain non-partial one, which is exactly the drift
      // `CREATE UNIQUE INDEX IF NOT EXISTS` will not repair.
      "CREATE TABLE grants (id TEXT PRIMARY KEY, grantee_account_id TEXT, target_account_id TEXT, collection TEXT, collection_id TEXT, revoked_at INTEGER)",
      `CREATE UNIQUE INDEX grants_tuple
         ON grants (grantee_account_id, target_account_id,
                    COALESCE(collection, ''), COALESCE(collection_id, ''))`,
    ],
  },

  {
    id: "identities-jmap-properties",
    why: "RFC 8621 §6.1 Identity properties. This migration existed ONLY as a comment inside control-plane.sql and was absent from docs/DEPLOY.md — an operator following the runbook would have missed it entirely",
    blocks: null,
    // may_delete is the last of the five, so it is the honest sentinel for
    // "did the whole group land".
    check: hasColumn("identities", "may_delete"),
    up: [
      "ALTER TABLE identities ADD COLUMN reply_to_json TEXT",
      "ALTER TABLE identities ADD COLUMN bcc_json TEXT",
      "ALTER TABLE identities ADD COLUMN text_signature TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE identities ADD COLUMN html_signature TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE identities ADD COLUMN may_delete INTEGER NOT NULL DEFAULT 1",
      // The DEFAULT is 1 for rows created from here on, but every identity that
      // already exists was provisioned by the platform and must not be
      // deletable by a client. Order matters: this UPDATE has to follow the
      // ADD COLUMN and precede any new identity being created.
      "UPDATE identities SET may_delete = 0",
    ],
    absent: ["CREATE TABLE identities (id TEXT PRIMARY KEY, account_id TEXT, email TEXT)"],
  },

  {
    id: "provenance-columns",
    why: "s03.A: who wrote this row. 21 columns across 7 tables; writes land NULL without them (see .feedback common/033)",
    blocks: null,
    // file_nodes is last in the apply order, so its last column is the sentinel.
    check: hasColumn("file_nodes", "last_writer_invocation"),
    up: PROVENANCE_TABLES.flatMap((t) =>
      PROVENANCE_COLUMNS.map((c) => `ALTER TABLE ${t} ADD COLUMN ${c} TEXT`),
    ),
    absent: PROVENANCE_TABLES.map((t) => `CREATE TABLE ${t} (id TEXT PRIMARY KEY)`),
  },

  {
    id: "emails-fts-contentless-delete",
    why: "without the flag SQLite REFUSES DELETE on a contentless table — delivery keeps working while `Email/set destroy` throws and rolls back, so the message is not deleted at all",
    blocks: null,
    check: objectSqlContains("table", "emails_fts", "contentless_delete"),
    up: [
      // Destroys the index, not the mail: bodies live in R2 and the backfill
      // rebuilds from there. Safe precisely because the table is contentless.
      "DROP TABLE IF EXISTS emails_fts",
      `CREATE VIRTUAL TABLE emails_fts USING fts5 (
         subject, from_text, to_text, body_text,
         content='', contentless_delete=1, tokenize='unicode61')`,
    ],
    absent: [
      // The pre-common/004 table: same columns, no contentless_delete. INSERT
      // works on this, DELETE does not — which is why the drift is silent.
      `CREATE VIRTUAL TABLE emails_fts USING fts5 (
         subject, from_text, to_text, body_text,
         content='', tokenize='unicode61')`,
    ],
  },

  {
    id: "agent-proposals-table",
    why: "s03.D T1's ActionProposal read model over agent_invocations; a plain schema re-run DOES create this one (CREATE TABLE IF NOT EXISTS), it is listed so `bootstrap migrate` accounts for the set and an existing shard is not left without it",
    blocks: null,
    check: tableExists("agent_proposals"),
    up: [
      `CREATE TABLE IF NOT EXISTS agent_proposals (
         id                   TEXT NOT NULL,
         account_id           TEXT NOT NULL,
         kind                 TEXT NOT NULL,
         tier                 INTEGER NOT NULL,
         subject_json         TEXT NOT NULL DEFAULT '{}',
         payload_json         TEXT NOT NULL DEFAULT '{}',
         edited_payload_json  TEXT,
         rationale            TEXT NOT NULL,
         evidence_json        TEXT NOT NULL DEFAULT '[]',
         status               TEXT NOT NULL DEFAULT 'pending',
         decision_json        TEXT,
         created_at           INTEGER NOT NULL,
         decided_at           INTEGER,
         hold_until           INTEGER,
         expires_at           INTEGER,
         question             TEXT,
         amendments_json      TEXT,
         expires_remaining_ms INTEGER,
         PRIMARY KEY (account_id, id)
       )`,
      "CREATE INDEX IF NOT EXISTS agent_proposals_status ON agent_proposals (account_id, status)",
      "CREATE INDEX IF NOT EXISTS agent_proposals_expires ON agent_proposals (account_id, expires_at)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "proposal-needsinfo-columns",
    why: "s10 T3: the needsInfo verb. ActionProposal/set names question/amendments_json/expires_remaining_ms in its info-requested UPDATE and the JOIN projection SELECTs them, so a worker deployed against a shard missing them fails every proposal read — not merely the new verb",
    blocks: "deploy",
    needs: ["agent-proposals-table"],
    // expires_remaining_ms is the last column applied, so it is the honest
    // sentinel for "did the whole group land" (precedent: invocation-cost-columns).
    check: hasColumn("agent_proposals", "expires_remaining_ms"),
    up: [
      "ALTER TABLE agent_proposals ADD COLUMN question TEXT",
      "ALTER TABLE agent_proposals ADD COLUMN amendments_json TEXT",
      "ALTER TABLE agent_proposals ADD COLUMN expires_remaining_ms INTEGER",
      // Deliberately no backfill: NULL amendments_json reads as "no Q&A rounds"
      // (the same empty-value degrade the projection applies to evidence_json).
    ],
    absent: [
      // The pre-s10 table: enough for the ALTERs to run, nothing more.
      "CREATE TABLE agent_proposals (id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY (account_id, id))",
    ],
  },

  {
    id: "invocation-cost-columns",
    why: "s07 T5: cost frozen at capture. The agent worker's finish() names these columns in its UPDATE, so a worker deployed against a database missing them fails EVERY invocation finalisation — not merely a dashboard reading NULL",
    blocks: "deploy",
    // cost_micros is the last column applied, so it is the honest sentinel
    // for "did the whole group land" (precedent: identities-jmap-properties).
    check: hasColumn("agent_invocations", "cost_micros"),
    up: [
      "ALTER TABLE agent_invocations ADD COLUMN provider TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN model TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN tokens_in INTEGER",
      "ALTER TABLE agent_invocations ADD COLUMN tokens_out INTEGER",
      "ALTER TABLE agent_invocations ADD COLUMN cost_micros INTEGER",
      // Deliberately no backfill: a pre-migration row's NULL is the truthful
      // value — "not recorded" — and the whole point of the NULL/0 split.
    ],
    absent: ["CREATE TABLE agent_invocations (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "emails-fts-map",
    why: "a contentless FTS5 table returns NULL for its own UNINDEXED columns, so the rowid↔email-id mapping cannot live inside emails_fts",
    blocks: null,
    check: tableExists("emails_fts_map"),
    up: [
      `CREATE TABLE IF NOT EXISTS emails_fts_map (
         docid      INTEGER PRIMARY KEY AUTOINCREMENT,
         account_id TEXT NOT NULL,
         email_id   TEXT NOT NULL
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "address-books-write-policy",
    why: "s10 T1: the per-book write policy the Mailstore chokepoint enforces. getAddressBooks and insertAddressBook name the column, so a worker deployed against a database missing it fails EVERY address-book read and create — not merely 'governance is off'",
    blocks: "deploy",
    check: hasColumn("address_books", "write_policy"),
    up: ["ALTER TABLE address_books ADD COLUMN write_policy TEXT NOT NULL DEFAULT 'open'"],
    absent: ["CREATE TABLE address_books (id TEXT PRIMARY KEY)"],
  },

  {
    id: "agent-bindings-recipients-book",
    why: "s10 T1: the outbound bound. The agent worker's send gate resolves recipients_book_id before every submit, so a worker deployed against a database missing it fails every send-mode/ledger invocation. NULL is the fail-closed value — an unbound binding cannot send — so no backfill",
    blocks: "deploy",
    check: hasColumn("agent_bindings", "recipients_book_id"),
    up: ["ALTER TABLE agent_bindings ADD COLUMN recipients_book_id TEXT"],
    absent: ["CREATE TABLE agent_bindings (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "book-membership-log-table",
    why: "s10 T2's append-only membership chain for governed address books; a plain schema re-run DOES create this one, it is listed so the set is complete (precedent: agent-proposals-table)",
    blocks: null,
    check: tableExists("book_membership_log"),
    up: [
      `CREATE TABLE IF NOT EXISTS book_membership_log (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         account_id      TEXT NOT NULL,
         book_id         TEXT NOT NULL,
         event           TEXT NOT NULL,
         address         TEXT NOT NULL,
         card_id         TEXT,
         uid             TEXT,
         actor           TEXT,
         via_proposal_id TEXT,
         at              INTEGER NOT NULL
       )`,
      "CREATE INDEX IF NOT EXISTS book_membership_log_book ON book_membership_log (account_id, book_id, id)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "binding-lifecycle-table",
    why: "s10 T4's append-only provenance chain for the BINDING (which governing book, changed by whom, when). PATCH /agent-bindings/{id} appends a row in the same batch as a book re-point, so a provision worker deployed against a database missing it fails every re-point — but only that one route, so it is not a deploy blocker: reads, creates, the kill switch and delete are all untouched",
    blocks: null,
    check: tableExists("binding_lifecycle"),
    up: [
      `CREATE TABLE IF NOT EXISTS binding_lifecycle (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         account_id      TEXT NOT NULL,
         binding_id      TEXT NOT NULL,
         event           TEXT NOT NULL,
         old_value       TEXT,
         new_value       TEXT,
         actor           TEXT,
         via_proposal_id TEXT,
         at              INTEGER NOT NULL
       )`,
      "CREATE INDEX IF NOT EXISTS binding_lifecycle_binding ON binding_lifecycle (account_id, binding_id, id)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "invocation-due-at",
    why: "s11 T1: the work's business deadline (third clock — distinct from expires_at and hold_until). Was a non-blocker in the T6 wave; since T2 the eligibility gate names due_at in EVERY claim statement's WHERE (jmap AgentInvocation/set and the agent worker's drain), so a worker deployed against a database missing it fails every claim and all agent mail stops",
    blocks: "deploy",
    check: hasColumn("agent_invocations", "due_at"),
    up: ["ALTER TABLE agent_invocations ADD COLUMN due_at INTEGER"],
    absent: ["CREATE TABLE agent_invocations (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "invocation-facet-columns",
    why: "s11 T6: the facet columns the claim gate reads. Was a non-blocker in the T6 wave (nothing hot read them); since T2 the gate names privacy and requires_json in every claim statement's WHERE, so a worker deployed first fails every claim. Ingest's stamp UPDATE still degrades to an unfaceted enqueue where they are missing, and NULL remains the DefaultCase — claimable exactly as today",
    blocks: "deploy",
    // requires_json is the last column applied, so it is the honest sentinel
    // for "did the whole group land" (precedent: invocation-cost-columns).
    check: hasColumn("agent_invocations", "requires_json"),
    up: [
      "ALTER TABLE agent_invocations ADD COLUMN privacy TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN sender_class TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN effort_prior TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN requires_json TEXT",
    ],
    absent: ["CREATE TABLE agent_invocations (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "invocation-claimant-columns",
    why: "s11 T2: the claim records the claimant's self-declared identity (trust-but-audit), and the gate's liveness inference reads claimant_free ('a free claim in the last 15 min = a free runtime is live'). Every T2 claim UPDATE SETs claimant_free, so a worker deployed against a database missing it fails every claim",
    blocks: "deploy",
    needs: ["invocation-due-at", "invocation-facet-columns"],
    // claimant_caps_json is the last column applied — the group sentinel.
    check: hasColumn("agent_invocations", "claimant_caps_json"),
    up: [
      "ALTER TABLE agent_invocations ADD COLUMN claimant_free INTEGER",
      "ALTER TABLE agent_invocations ADD COLUMN claimant_caps_json TEXT",
    ],
    absent: ["CREATE TABLE agent_invocations (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "invocation-alert-columns",
    why: "s11 T3: the overdue backstop's alert marker (pinned/unfit work past due_at — the 'not SILENTLY' half of the invariant). The agent worker's scheduled() sweep names alert_kind in its SELECT and its UPDATE, so a worker deployed against a database missing them throws in the cron hook and takes the retry-net drain down with it — the poke path survives, the sweeps do not",
    blocks: "deploy",
    needs: ["invocation-due-at"],
    // alert_at is the last column applied — the group sentinel (precedent:
    // invocation-cost-columns).
    check: hasColumn("agent_invocations", "alert_at"),
    up: [
      "ALTER TABLE agent_invocations ADD COLUMN alert_kind TEXT",
      "ALTER TABLE agent_invocations ADD COLUMN alert_at INTEGER",
    ],
    absent: ["CREATE TABLE agent_invocations (id TEXT NOT NULL, account_id TEXT NOT NULL)"],
  },

  {
    id: "budget-overage-table",
    why: "s11 T9: the approved, bounded budget overage a `budget-overrun` proposal grants. UNLIKE most new tables this IS a deploy blocker: the eligibility gate's budgetExhaustedSql names it in EVERY claim statement's WHERE (the effective ceiling is cap + SUM(amount_micros) for the period), so a jmap/agent worker deployed against a database missing it fails every claim and all agent mail stops — the same blast radius as invocation-claimant-columns, not the one-route failure a new table usually is",
    blocks: "deploy",
    check: tableExists("agent_budget_overages"),
    up: [
      `CREATE TABLE IF NOT EXISTS agent_budget_overages (
         account_id    TEXT NOT NULL,
         binding_id    TEXT NOT NULL,
         period_key    TEXT NOT NULL,
         amount_micros INTEGER NOT NULL,
         proposal_id   TEXT NOT NULL,
         approved_by   TEXT,
         approved_at   INTEGER NOT NULL,
         PRIMARY KEY (account_id, binding_id, period_key, proposal_id)
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "domain-deny-list-table",
    why: "s12 1-A: the industrial deny tier (bouncer@'s working data). A plain schema re-run DOES create it; NOT a deploy blocker because the ingest cascade fails OPEN — a shard missing the table reads as an empty deny list (logged) and every message flows as today",
    blocks: null,
    check: tableExists("domain_deny_list"),
    up: [
      `CREATE TABLE IF NOT EXISTS domain_deny_list (
         tenant_id TEXT NOT NULL,
         domain    TEXT NOT NULL,
         added_at  INTEGER NOT NULL,
         source    TEXT NOT NULL,
         evidence  TEXT,
         PRIMARY KEY (tenant_id, domain)
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "deny-counters-table",
    why: "s12 1-A: per-domain daily counters — the industrial tier's ONLY per-message write (counters, never chain rows). A plain schema re-run DOES create it; NOT a deploy blocker: a failed counter bump is logged and the edge reject still happens",
    blocks: null,
    check: tableExists("deny_counters"),
    up: [
      `CREATE TABLE IF NOT EXISTS deny_counters (
         domain TEXT NOT NULL,
         day    TEXT NOT NULL,
         count  INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (domain, day)
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "quarantine-events-table",
    why: "s12 1-A: the append-only quarantine chain (book_membership_log model). A plain schema re-run DOES create it; NOT a deploy blocker: the quarantine store writes chain row + message in ONE batch, so a shard missing the table fails that batch and ingest falls back to inbox delivery — today's behavior, logged",
    blocks: null,
    check: tableExists("quarantine_events"),
    up: [
      `CREATE TABLE IF NOT EXISTS quarantine_events (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         account_id     TEXT NOT NULL,
         event          TEXT NOT NULL,
         sender         TEXT NOT NULL,
         domain         TEXT NOT NULL,
         stage          TEXT NOT NULL,
         email_id       TEXT,
         actor          TEXT,
         via_message_id TEXT,
         at             INTEGER NOT NULL
       )`,
      "CREATE INDEX IF NOT EXISTS quarantine_events_account ON quarantine_events (account_id, id)",
      "CREATE INDEX IF NOT EXISTS quarantine_events_sender ON quarantine_events (account_id, sender, id)",
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "sieve-rules-table",
    why: "s12 2-C: cascade stage 3's per-account JSON ruleset (§17's 'JSON ruleset in D1' start). A plain schema re-run DOES create it; NOT a deploy blocker: the boundary reads fail OPEN — a shard missing the table reads as NO rules (logged) and every message passes stage 3 as today",
    blocks: null,
    check: tableExists("sieve_rules"),
    up: [
      `CREATE TABLE IF NOT EXISTS sieve_rules (
         account_id TEXT NOT NULL,
         rules_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (account_id)
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "bayes-state-table",
    why: "s12 2-C: cascade stage 4's per-account Bayes filter state (VOCAB_CAP-pruned JSON). A plain schema re-run DOES create it; NOT a deploy blocker: a missing/corrupt row loads as NULL and stage 4 skips (fail open) — DefaultCase delivery, said out loud",
    blocks: null,
    check: tableExists("bayes_state"),
    up: [
      `CREATE TABLE IF NOT EXISTS bayes_state (
         account_id TEXT NOT NULL,
         state_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (account_id)
       )`,
    ],
    absent: [], // an empty database: the table simply is not there
  },

  {
    id: "quarantined-mailbox-role",
    why: "s12: held mail moves from the INVENTED role 'quarantine' to the REGISTERED 'junk' (RFC 8621 / IANA — an unregistered role is rendered by a standards client as an ordinary folder with no spam handling), displayed 'Quarantined'. Renames existing Junk mailboxes to the one vocabulary and drops the empty wave-1 quarantine mailboxes. NOT a deploy blocker: every reader looks up role='junk', so a shard that has not run this simply has an extra empty folder. ⚠️ The delete is GUARDED on the mailbox being empty — nothing has ever been shunted, so it should always be — and if one DOES hold mail the check stays failing and the deploy stops rather than moving a human's mail blind",
    blocks: null,
    check:
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM mailboxes WHERE role = 'quarantine')
                     OR EXISTS (SELECT 1 FROM mailboxes WHERE role = 'junk' AND name = 'Junk')
                   THEN 0 ELSE 1 END AS n`,
    up: [
      // Only the DEFAULT name is repainted. A human who renamed their junk
      // folder chose that name, and a migration must not overrule a person.
      `UPDATE mailboxes SET name = 'Quarantined' WHERE role = 'junk' AND name = 'Junk'`,
      // Wave 1's second pile. Empty ones only: an account cannot hold two
      // rows with the same role (mailboxes_role is UNIQUE), so a non-empty
      // quarantine mailbox cannot simply be re-roled either — it needs a
      // human to decide where its mail goes, and leaving the check failing is
      // how this says so.
      `DELETE FROM mailboxes
        WHERE role = 'quarantine'
          AND id NOT IN (SELECT mailbox_id FROM email_mailboxes)`,
    ],
    absent: [
      `CREATE TABLE mailboxes (
         id         TEXT NOT NULL,
         account_id TEXT NOT NULL,
         name       TEXT NOT NULL,
         role       TEXT,
         PRIMARY KEY (account_id, id)
       )`,
      `CREATE TABLE email_mailboxes (
         account_id TEXT NOT NULL,
         email_id   TEXT NOT NULL,
         mailbox_id TEXT NOT NULL,
         PRIMARY KEY (account_id, email_id, mailbox_id)
       )`,
      // The wave-1 world: a Junk folder AND a second pile beside it.
      `INSERT INTO mailboxes (id, account_id, name, role)
       VALUES ('mb_junk', 'a_1', 'Junk', 'junk'),
              ('mb_quar', 'a_1', 'Quarantine', 'quarantine')`,
    ],
  },

  {
    id: "grant-lifecycle-via-proposal",
    why: "s10 T2: the WHY on the grant chain. provision's lifecycle writer names the column in its INSERT, so a provision worker deployed against a database missing it fails every grant mint and revoke",
    blocks: "deploy",
    needs: ["grant-lifecycle-table"],
    check: hasColumn("grant_lifecycle", "via_proposal_id"),
    up: ["ALTER TABLE grant_lifecycle ADD COLUMN via_proposal_id TEXT"],
    absent: [
      // The s03.A-era table: the log exists, the why column does not.
      `CREATE TABLE grant_lifecycle (
         id       INTEGER PRIMARY KEY AUTOINCREMENT,
         grant_id TEXT NOT NULL,
         event    TEXT NOT NULL,
         at       INTEGER NOT NULL,
         actor    TEXT
       )`,
    ],
  },
];

/**
 * Deliberately NOT a migration, recorded so the next person does not "fix" it.
 *
 * `bureau_grants_tuple` looks like it wants the same partial treatment as
 * `grants_tuple`. It must not get it. That table's writer upserts —
 * `ON CONFLICT (principal_id, cred_name, verb) DO UPDATE SET revoked_at = NULL`
 * — and resurrects its own tombstone, which is a different, equally correct
 * answer to the same problem. SQLite matches a conflict target against a unique
 * index, and a partial index needs its WHERE clause repeated in that target, so
 * making it partial breaks every Bureau grant write. (Learned by doing it: 14
 * tests failed to even prepare.)
 */
export const NOT_MIGRATIONS = ["bureau_grants_tuple stays non-partial — its writer upserts"];
