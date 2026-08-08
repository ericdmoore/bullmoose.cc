# FIX - 005 -P2- Full resync erases local FTS rows for every account

## Proposal

Add `account_id UNINDEXED` to `cli_fts` and make all FTS maintenance account-scoped.

Schema migration:

- FTS virtual tables cannot be altered normally; create a new `cli_fts_v2`, populate from `emails`, drop old, rename or keep the new name.
- Simpler for local-only data: detect old schema and rebuild `cli_fts` from `emails`.

Code changes:

- `fullResync`: `DELETE FROM cli_fts WHERE account_id = ?`
- `upsertOne`: delete and insert by `(account_id, email_id)`
- `deleteEmail`: delete by `(account_id, email_id)`
- `cmdSearch`: join on both `e.account_id = f.account_id` and `e.id = f.email_id`

## Test

Build a small local DB with two accounts and two FTS rows. Run a full resync path for one account with fake JMAP responses, then assert the other account's FTS row remains searchable.

## Compatibility note

Since this is a local cache, a brute-force repair path is acceptable: rebuild `cli_fts` from the `emails` table on first open after the schema change.
