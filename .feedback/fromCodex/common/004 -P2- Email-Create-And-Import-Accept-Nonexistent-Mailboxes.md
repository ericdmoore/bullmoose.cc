# 004 -P2- `Email/set` and `Email/import` accept nonexistent mailbox ids

**Subsystem:** common (`services/jmap` + `packages/mailstore`) · **Severity:** MEDIUM (data integrity / sync correctness) · **Fix class:** CHANGE-CODE + ADD-TEST

## The defect

Both draft creation and raw import accept client-provided `mailboxIds` and write them directly:

- `services/jmap/src/methods/email.ts:406-413` extracts ids for `Email/set create`
- `email.ts:455-472` inserts the email with those ids
- `email.ts:540-545` extracts ids for `Email/import`
- `packages/mailstore/src/index.ts:591-596` writes each mailbox id into `email_mailboxes`

There is no validation that the mailboxes exist for the account. The schema also has no foreign key on `email_mailboxes`.

## Why it bites

An invalid mailbox id creates an email that exists but is not reachable through normal mailbox-based views. Mailbox counts and local sync can also get contradictory state: the AccountDO changelog announces mailbox updates for ids that `Mailbox/get` will never return.

This is easy to trigger accidentally from third-party JMAP clients if their cached mailbox id is stale, and malicious clients can use it to create hidden or confusing rows.

## Additional place to check

`applyEmailPatch` accepts `mailboxIds/<id>` additions and full replacements (`email.ts:347-369`) and ultimately calls `replaceEmailSets`, which also writes ids directly at `packages/mailstore/src/index.ts:619-624`.

## Expected behavior

Unknown mailbox ids should produce a SetError for the affected create/update/import item, before writing the email or replacing mailbox membership.
