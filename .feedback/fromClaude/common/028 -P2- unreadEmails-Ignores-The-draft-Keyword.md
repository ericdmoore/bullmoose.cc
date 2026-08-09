# 028 -P2- `unreadEmails` counts drafts, because it only filters `$seen`

**Subsystem:** common · **Severity:** MEDIUM · **Fix class:** CHANGE-CODE

Found while fixing `common/026` item 2 (thread counts), by reading RFC 8621 §2 rather than
trusting the existing predicate.

## The defect

RFC 8621 §2 defines the property as:

> **unreadEmails**: The number of Emails in this Mailbox that have neither the `$seen`
> keyword nor the `$draft` keyword.

`packages/mailstore/src/index.ts`, `mailboxCounts`, tests only `$seen`:

```sql
SUM(CASE WHEN NOT EXISTS (
  SELECT 1 FROM email_keywords k
  WHERE k.account_id = em.account_id
    AND k.email_id = em.email_id AND k.keyword = '$seen'
) THEN 1 ELSE 0 END) AS unread
```

So every draft is counted as unread mail. The Drafts mailbox — where by definition every
message carries `$draft` and essentially none carries `$seen` — reports an unread badge
equal to its entire contents, permanently, and there is no way for a user to clear it.

The same predicate now also feeds `unreadThreads` (shipped in `026`), deliberately reusing
the one string so the two cannot disagree. Fixing it here fixes both at once — which is
why this was filed rather than patched inline: changing it silently would have moved
`unreadEmails` for every consumer under cover of a thread-count change.

## Fix

Add the second clause to the shared `UNREAD` constant in `mailboxCounts`:

```sql
NOT EXISTS (
  SELECT 1 FROM email_keywords k
  WHERE k.account_id = em.account_id AND k.email_id = em.email_id
    AND k.keyword IN ('$seen', '$draft')
)
```

One-line change, and both counts follow. `$draft` is already a real keyword in this repo —
`Email/set` sets it and `EmailSubmission` dispatches on it — so this is not hypothetical.

## Verify

`services/jmap/src/methods/mailbox.test.ts` has the fixtures and a stateful fake whose
counts branch mirrors this SQL (it must be updated in step, or the test passes against
broken source). A seeded Drafts mailbox with two `$draft`, `$seen`-less emails should
report `unreadEmails: 0`, not `2`. Today it reports 2.
