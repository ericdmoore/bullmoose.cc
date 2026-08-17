# @bullmoose/mailstore

The storage layer: one `Mailstore` class over D1 (metadata) + R2
(blobs), shared by every worker that reads or writes mail.

- **Blobs**: content-hash `blobId`s in R2 (`putBlob`/`getBlob`) — raw
  RFC 5322 messages and individual attachments
- **Emails**: `insertEmail`, `getEmailRow(s)`, `queryEmails` (filter
  operator tree with AND/OR/NOT recursion), keyword/mailbox junctions,
  `destroyEmail`
- **Full-text search** (`common/004`): `queryEmails`' `text` condition is
  an FTS5 `MATCH` over `emails_fts` — subject, addresses and **message
  bodies**. `insertEmail` writes the index row (pass `bodyText`;
  `preview` is the fallback), `destroyEmail` retracts it, and
  `ftsMatchQuery` quotes user input so FTS5 operators (`AND`, `NEAR`,
  `*`, `"`) stay literal. `subject`/`from`/`to` remain substring `LIKE`
  on their own columns. Retrofit an existing database with the ingest
  worker's `POST /admin/fts/backfill` (`docs/DEPLOY.md`).
- **Mailboxes**: `getMailboxes`, `ensureRoleMailbox`, counts
- **Threading**: `resolveThreadId` via In-Reply-To;
  `normalizeMessageId()` strips angle brackets — REQUIRED on every
  write path, or postal-mime ids (`<x@y>`) and Email/set ids (`x@y`)
  fork threads (regression-tested)
- **Identities / submissions**: `getIdentities`, `insertSubmission`,
  `getSubmissions` (LEFT JOINs `emails` for RFC 8621's `threadId`;
  `ids: []` means *nothing*, unlike `getMailboxes`)

`sql/data-plane.sql` — per-account tables: emails, mailboxes,
junctions, FTS, responders, responder_log, agent_bindings (with
`config_json`), agent_invocations, email_submissions, spend_facts
(the analyst@ ledger).
`sql/control-plane.sql` — tenants, domains, principals, accounts,
identities, routes, credentials (client-side-KDF login keys), tokens.

Both planes share one D1 database (`bullmoose-mail-shard0`) for the
MVP; the schema split keeps a future shard-per-plane move mechanical.
