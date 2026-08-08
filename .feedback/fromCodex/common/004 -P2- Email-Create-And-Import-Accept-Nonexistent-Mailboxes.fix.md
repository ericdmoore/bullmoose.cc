# FIX - 004 -P2- `Email/set` and `Email/import` accept nonexistent mailbox ids

## Proposal

Add a mailbox validation helper and call it before every write to `email_mailboxes`.

```ts
async function requireExistingMailboxes(store, accountId, mailboxIds) {
  const rows = await store.getMailboxes(accountId, mailboxIds);
  const found = new Set(rows.map((m) => m.id));
  const missing = mailboxIds.filter((id) => !found.has(id));
  if (missing.length) {
    throw new MethodError("invalidArguments", `unknown mailboxId(s): ${missing.join(", ")}`);
  }
}
```

Call sites:

- `createDraft`
- `importOne`
- `applyEmailPatch` when `mailboxIds` is touched
- any future copy/move helpers that call `replaceEmailSets`

## Data cleanup

Before enforcing this in production, add a diagnostic query:

```sql
SELECT em.account_id, em.email_id, em.mailbox_id
FROM email_mailboxes em
LEFT JOIN mailboxes m
  ON m.account_id = em.account_id AND m.id = em.mailbox_id
WHERE m.id IS NULL;
```

Then either move orphaned messages to Inbox or delete only the orphaned memberships if the message has at least one valid mailbox.

## Tests

Add tests for create/import/update with a missing mailbox id. Verify the operation fails and no partial row is inserted.
