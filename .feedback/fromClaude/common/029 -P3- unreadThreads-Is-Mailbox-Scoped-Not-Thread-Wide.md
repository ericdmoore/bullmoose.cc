# 029 -P3- `unreadThreads` is mailbox-scoped; RFC 8621 defines it thread-wide

**Subsystem:** common · **Severity:** LOW · **Fix class:** CHANGE-CODE

The acknowledged remainder of `common/026` item 2. Thread counts are now real
(`COUNT(DISTINCT thread_id)`), but `unreadThreads` implements a deliberately narrower
definition than the RFC's, and this records the gap so it isn't rediscovered.

## The gap

RFC 8621 §2:

> **unreadThreads**: the number of Threads where at least one Email in the Thread has
> neither the `$seen` nor the `$draft` keyword, **and** at least one Email in the Thread is
> in this Mailbox.

Note what that does _not_ say: the unread Email does not have to be the one in this
Mailbox. `mailboxCounts` currently counts threads with at least one unread email **in this
mailbox**, so it undercounts when a thread's unread message lives elsewhere — a read
original in Archive whose unread reply sits in Inbox leaves `Archive.unreadThreads` at 0
where the RFC says 1.

## Why it shipped that way

The thread-wide clause travels with a refinement in the same section: mail that exists
_only_ in Trash is excluded from other mailboxes' unread counts, and vice versa.
Implementing the clause **without** the refinement is strictly worse than the current
mailbox-scoped count for the mailbox list these numbers exist to feed — a thread whose only
unread copy sits in the Trash would inflate the Inbox badge forever, with no user action
able to clear it. So it was this or both, and both is a bigger piece of work than `026`
warranted.

## Fix

Both halves together, or leave it alone:

1. Thread-wide unread: replace the per-row predicate with an `EXISTS` over the thread —
   `emails_thread (account_id, thread_id)` already indexes the lookup.
2. Trash exclusion: needs the identity of the trash-role mailbox inside what is currently a
   self-contained per-mailbox aggregate. `mailboxes` has `role = 'trash'`, unique per
   account, so it is one extra join — but note `mailboxCounts` runs **once per mailbox** on
   `Mailbox/get` (a pre-existing N+1), so measure before adding a thread-wide scan to it.

Worth considering as one job with the N+1: a single grouped query returning counts for
every mailbox at once would make the thread-wide version affordable and is the natural
shape once a webmail mailbox list (`s03.C`) actually renders these.

## Related

- `common/026` item 2 — where thread counts became real
- `common/028` — the `$draft` half of the unread predicate, which this shares
