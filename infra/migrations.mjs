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
         PRIMARY KEY (account_id, id)
       )`,
      "CREATE INDEX IF NOT EXISTS agent_proposals_status ON agent_proposals (account_id, status)",
      "CREATE INDEX IF NOT EXISTS agent_proposals_expires ON agent_proposals (account_id, expires_at)",
    ],
    absent: [], // an empty database: the table simply is not there
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
