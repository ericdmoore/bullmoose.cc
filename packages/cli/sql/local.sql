-- The CLI-only half of the local mirror's schema.
--
-- The mirror is `packages/mailstore/sql/data-plane.sql` (the SAME tables the
-- server's D1 data plane has, so a local query is the same SQL you would run
-- server-side) plus the three tables below, which exist only on a client.
--
-- THIS FILE IS READ BY BOTH CLIs. `packages/cli/src/db.ts` reads it at runtime;
-- `cli-go/internal/store` EMBEDS a copy at build time (a static binary cannot
-- read a repo file), and `cli-go/internal/store/schema_test.go` byte-compares
-- that copy against this file, so the two cannot drift silently. It is a file
-- rather than a string literal in db.ts precisely so that comparison is a byte
-- comparison rather than a regex over another language's source.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  account_id    TEXT PRIMARY KEY,
  email_state   TEXT,
  mailbox_state TEXT,
  last_sync     INTEGER
);
-- Unlike the server's placeholder FTS table, this one is populated at
-- sync time, so `bullmoose search` works offline.
CREATE VIRTUAL TABLE IF NOT EXISTS cli_fts USING fts5 (
  email_id UNINDEXED, subject, from_text, to_text, preview,
  tokenize='unicode61'
);
