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
//   undo    TEST ONLY. Reverses `up` so the round-trip test can prove `check`
//           actually bites. Never run against a real database — several of
//           these destroy data.
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
    undo: ["ALTER TABLE accounts DROP COLUMN deleted_at"],
  },

  {
    id: "grants-revoked-at",
    why: "same shape as deleted_at — verifyBearer filters `revoked_at IS NULL`, so a missing column breaks every grant lookup",
    blocks: "deploy",
    check: hasColumn("grants", "revoked_at"),
    up: ["ALTER TABLE grants ADD COLUMN revoked_at INTEGER"],
    undo: ["ALTER TABLE grants DROP COLUMN revoked_at"],
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
    undo: ["DROP INDEX IF EXISTS grant_lifecycle_grant", "DROP TABLE IF EXISTS grant_lifecycle"],
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
    undo: [
      "DROP INDEX IF EXISTS grants_tuple",
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
    undo: [
      "ALTER TABLE identities DROP COLUMN may_delete",
      "ALTER TABLE identities DROP COLUMN html_signature",
      "ALTER TABLE identities DROP COLUMN text_signature",
      "ALTER TABLE identities DROP COLUMN bcc_json",
      "ALTER TABLE identities DROP COLUMN reply_to_json",
    ],
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
    undo: PROVENANCE_TABLES.flatMap((t) =>
      PROVENANCE_COLUMNS.map((c) => `ALTER TABLE ${t} DROP COLUMN ${c}`),
    ),
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
    undo: [
      "DROP TABLE IF EXISTS emails_fts",
      `CREATE VIRTUAL TABLE emails_fts USING fts5 (
         subject, from_text, to_text, body_text,
         content='', tokenize='unicode61')`,
    ],
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
    undo: ["DROP TABLE IF EXISTS emails_fts_map"],
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
