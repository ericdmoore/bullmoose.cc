# 026 -P3- Three more drifts, found while shipping the sVOL batch

**Subsystem:** common · **Severity:** LOW · **Fix class:** UPDATE-DOCS / CHANGE-CODE

Bundled like `cli/010` and `common/025`. All three verified against source at the time of
filing.

---

## 1. `.feedback/readme.md` tells you to run a file that does not exist — ✅ **CLOSED**

> **Shipped.** A root dispatcher won: there is now exactly one `.feedback/reindex.mjs`,
> and the five per-provider copies are deleted, so `readme.md`'s command is correct as
> written and there is nothing left to drift. It walks every `from*/` folder, takes the
> subsystem list from `config.yml` (fixing `021` in the same change — the two were not
> separable, as this issue predicted), and writes one `.feedback/_index.md`. Verified
> against real data: **21 open, 13 closed**, which is every ✅-prefixed file in the tree.
> `readme.md` now also states the ✅ convention (filename prefix, **no space**, on both
> the `.md` and the `.fix.md`), defines `-P{num}-` as priority, and records that issue
> numbers are one sequence per provider. See `common/021` for the full defect list.
>
> Side effect worth knowing: `fromComposer/`, `fromEric/` and `fromGrok/` contained
> *only* the duplicated script, so deleting it removed those (git cannot track empty
> directories). Any `from*/` folder is picked up automatically when recreated.

`readme.md:28`:

```bash
node .feedback/reindex.mjs
```

There is no `.feedback/reindex.mjs`. The script lives **per provider** — five copies:
`.feedback/{fromClaude,fromCodex,fromComposer,fromEric,fromGrok}/reindex.mjs`.

**Three separate agents hit this**, each having just marked an issue resolved and each
correctly concluding there was nothing to run. It is the last step of the documented process,
so it is hit every single time the process completes.

Fix: point the command at the provider directory, or add a root dispatcher that runs each.
Note `common/021` (open) already says the indexer's `isCategoryDir = name.startsWith("for")`
does not match this repo's `common`/`infra`/`cli` taxonomy — so the script it points at
wouldn't work anyway. Worth fixing together.

---

## 2. `Mailbox/get` reports a thread count it has not computed — ✅ **CLOSED**

> **Shipped — computed, not omitted.** `mailboxCounts` (`packages/mailstore/src/index.ts`)
> now returns all four counts from one aggregate: `COUNT(DISTINCT e.thread_id)` over a
> `LEFT JOIN emails`, plus the unread variant reusing the *same* `$seen` predicate string
> as `unreadEmails` so the two can never disagree on what unread means. No extra round
> trip; `emails_thread (account_id, thread_id)` already indexes it.
>
> The recommendation in the `.fix.md` was to omit. Overridden, because RFC 8621 §2 lists
> all four counts as **required** server-set Mailbox properties — omitting would have
> traded a wrong number for a missing one and left `services/agent/src/emailTools.ts`
> carrying a hand-written "these are not real thread counts, do not report them as
> threads" disclaimer in the `mailbox_list` tool description. That disclaimer is now
> deleted rather than reworded. Threading here is real (`resolveThreadId` joins replies
> by In-Reply-To), so the numbers genuinely diverge — this was not a distinction without
> a difference.
>
> `unreadThreads` counts threads with unread mail **in this mailbox**. RFC 8621 defines it
> thread-wide but pairs that with a Trash-exclusion refinement; implementing the clause
> without the refinement would let a thread whose only unread copy sits in Trash inflate
> the Inbox badge forever, which is worse than this. Filed as `common/029`.
>
> 6 new tests in `services/jmap/src/methods/mailbox.test.ts` (38 → 44), on fixtures where
> the thread count deliberately differs from the message count (5 emails / 3 threads,
> 3 unread emails / 2 unread threads). 3 of the 6 fail on the reverted source.

`services/jmap/src/methods/mailbox.ts`:

```ts
totalThreads: counts.totalEmails, // TODO: real thread counts
```

`totalThreads` and `unreadThreads` are advertised in the returned property list and are simply
the **email** counts. RFC 8621 §2 defines them as distinct.

Low severity today because no surface renders them — but that is exactly why it will survive
until a client believes it. The webmail slice (`s03.C`) plans a mailbox list, which is the
first consumer that would show a wrong number to a human.

Two honest options: compute `COUNT(DISTINCT thread_id)`, or **omit the properties** rather
than return a known-wrong value. Omission is defensible — a client can tell "absent" from
"wrong"; it cannot tell "wrong" from "right".

---

## 3. `PROPPATCH` is missing on every DAV resource — ✅ **CLOSED**

> **Shipped.** `PROPPATCH` on calendar and address-book collections, routed in the `handleDav`
> dispatcher ahead of `handleBook`/`handleCalendar`. Supports `displayname` → `name`,
> `{apple}calendar-color` → `color` (calendars only — `address_books` has no colour column),
> `{caldav}calendar-description` / `{carddav}addressbook-description` → `description`;
> everything else is `403 Forbidden` **per property** inside the 207, echoed under its own
> namespace. `<remove>` nulls a nullable column and is refused for `displayname`. Applies
> what it can rather than RFC 4918 §9.2's all-or-nothing, because Apple ships
> `calendar-order` in the same body as `displayname` and atomicity would mean no rename ever
> lands — see the handler comment. Full choreography (Mailstore → ctag bump →
> `commitChanges`) on any applied property, and none at all when every property is refused.
> Role/default collections rename freely, per sVOL `004`. 18 new tests in
> `services/anglebrackets/src/dav.test.ts` (29 → 47); all 18 fail on the reverted source.
>
> **Items 1 and 2 are now closed too** (see above), so this issue is `✅`-prefixed.

`grep -c PROPPATCH services/anglebrackets/src/dav.ts` → **0**.

Since sVOL `009`, a client can **create** and **delete** calendars and address books, but not
**rename or recolour** them. That is the `U` still absent from both DAV columns in
`.plans/sVOL-CapSurNoun/_index.md`.

The capability already exists underneath — `Calendar/set` and `AddressBook/set` both support
update. This is WebDAV verb plumbing, the same shape `009` did for MKCOL/MKCALENDAR, and
`009`'s handler layout is the template.

Apple Calendar sends `PROPPATCH` for a colour change or a rename, so today those silently do
nothing from the client's perspective — worse than a 405, because the client believes it
succeeded.

---

## Related

- `common/021` — the indexer taxonomy mismatch (item 1's sibling)
- `common/025` — the first doc-drift bundle
- `.plans/sVOL-CapSurNoun/009` — item 3 is its acknowledged follow-on
