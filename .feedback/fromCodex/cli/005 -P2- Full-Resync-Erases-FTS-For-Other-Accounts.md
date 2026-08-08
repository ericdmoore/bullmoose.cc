# 005 -P2- Full resync erases local FTS rows for every account

**Subsystem:** cli (`packages/cli/src/sync.ts`) · **Severity:** MEDIUM (multi-account data loss in local search) · **Fix class:** CHANGE-CODE + ADD-TEST

## The defect

`fullResync` is account-scoped for the main tables:

```ts
DELETE FROM emails WHERE account_id = ?
DELETE FROM email_mailboxes WHERE account_id = ?
DELETE FROM email_keywords WHERE account_id = ?
```

but then globally clears the FTS table at `packages/cli/src/sync.ts:260`:

```ts
db.exec("DELETE FROM cli_fts");
```

`cli_fts` has no `account_id` column (`packages/cli/src/db.ts:71-74`), only `email_id`.

## Why it bites

One login can cover many accounts. A full resync of account A deletes search rows for account B, while B's `emails` rows remain. After that, `bullmoose search --account B ...` silently misses B's already-synced mail until B happens to resync or update those messages.

The CLI README explicitly describes the local SQLite log as multi-account and offline-search capable.

## Secondary issue

Because `cli_fts` keys only by `email_id`, cross-account email id collisions would also be ambiguous in search joins. UUID collision is unlikely, but the schema should still model the actual composite identity: `(account_id, email_id)`.
