# 026 -P3- Three more drifts, found while shipping the sVOL batch

**Subsystem:** common · **Severity:** LOW · **Fix class:** UPDATE-DOCS / CHANGE-CODE

Bundled like `cli/010` and `common/025`. All three verified against source at the time of
filing.

---

## 1. `.feedback/readme.md` tells you to run a file that does not exist

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

## 2. `Mailbox/get` reports a thread count it has not computed

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

## 3. `PROPPATCH` is missing on every DAV resource

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
