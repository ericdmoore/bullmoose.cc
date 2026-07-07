# @bullmoose/mailstore

The storage layer: one `Mailstore` class over D1 (metadata) + R2
(blobs), shared by every worker that reads or writes mail.

- **Blobs**: content-hash `blobId`s in R2 (`putBlob`/`getBlob`) — raw
  RFC 5322 messages and individual attachments
- **Emails**: `insertEmail`, `getEmailRow(s)`, `queryEmails` (filter
  operator tree with AND/OR/NOT recursion, LIKE-based text search),
  keyword/mailbox junctions, `destroyEmail`
- **Mailboxes**: `getMailboxes`, `ensureRoleMailbox`, counts
- **Threading**: `resolveThreadId` via In-Reply-To;
  `normalizeMessageId()` strips angle brackets — REQUIRED on every
  write path, or postal-mime ids (`<x@y>`) and Email/set ids (`x@y`)
  fork threads (regression-tested)
- **Identities / submissions**: `getIdentities`, `insertSubmission`

`sql/data-plane.sql` — per-account tables: emails, mailboxes,
junctions, FTS, responders, responder_log, agent_bindings (with
`config_json`), agent_invocations, email_submissions, spend_facts
(the analyst@ ledger).
`sql/control-plane.sql` — tenants, domains, principals, accounts,
identities, routes, credentials (client-side-KDF login keys), tokens.

Both planes share one D1 database (`bullmoose-mail-shard0`) for the
MVP; the schema split keeps a future shard-per-plane move mechanical.
