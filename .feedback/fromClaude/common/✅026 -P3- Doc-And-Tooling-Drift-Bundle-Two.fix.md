# FIX — 026 -P3- Doc and tooling drift, bundle two

Three independent items. 1 and 2 are small; 3 is a real slice and should probably be its own
commit.

## 1. `.feedback/readme.md` reindex path

Do **not** just fix the path — the script it points at is also broken (`common/021`:
`isCategoryDir = (name) => name.startsWith("for")` matches nothing in a repo whose folders are
`common`/`infra`/`cli`/`agentic`/`webUI`). Fixing the path alone yields a command that runs
and silently produces an `_index.md` claiming "0 open items", which is worse than a command
that errors.

Sequence: fix `021` first, then correct `readme.md:28` to whichever shape wins — either

```bash
node .feedback/fromClaude/reindex.mjs      # per provider
```

or a root dispatcher that iterates `from*/`. The five copies are currently identical; if a
dispatcher lands, delete four of them rather than leaving five to drift.

**Also worth one line in `readme.md`:** the process says to mark a shipped issue with `✅`, and
practice has settled on a filename prefix with **no space** (`✅001 -P1- …`). One agent used
`✅ 006` and it had to be normalized. Say which, so it stops being a coin flip.

## 2. `Mailbox/get` thread counts

**Recommendation: omit, don't guess.**

`totalThreads`/`unreadThreads` are optional in the response — a client can distinguish absent
from wrong, but cannot distinguish wrong from right. Returning `totalEmails` under a
`totalThreads` key is a lie the type system will not catch.

If you'd rather compute them, the `emails` table carries `thread_id`, so it is
`COUNT(DISTINCT thread_id)` alongside the existing counts — one extra aggregate in the same
query, not a new round trip. Check whether the unread variant needs
`WHERE json_extract(keywords,...)` to match how `unreadEmails` is already computed, and reuse
that predicate rather than writing a second one.

Either way, `services/jmap/src/methods/mailbox.test.ts` (from sVOL `004`) is the place to
assert it, and it already has fixtures with multiple emails.

## 3. DAV `PROPPATCH`

Scope it to what Apple actually sends, not to RFC 4918 in full:

| property                       | maps to                                          |
| ------------------------------ | ------------------------------------------------ |
| `displayname`                  | `Calendar/set` / `AddressBook/set` update `name` |
| `{apple}calendar-color`        | `Calendar/set` update `color`                    |
| `{caldav}calendar-description` | `Calendar/set` update `description`              |
| everything else                | `403 Forbidden` in the multistatus, per-property |

**The response shape is the part that is easy to get wrong.** `PROPPATCH` returns `207
Multi-Status` with a `<propstat>` per property and a status per `<propstat>` — a partial
success is normal and must not be reported as a whole-request failure. `dav.ts` already builds
multistatus responses for `PROPFIND`; reuse that builder rather than hand-rolling a second one.

**Bread-crumbs:**

- Route it exactly like `009` did: branch in the `handleDav` dispatcher **before**
  `requireBook`/`requireCalendar`, or the 404-before-405 trap `009` documented bites again.
- Bump the collection `ctag` and `commitChanges` on success — same choreography as every other
  DAV write in that file, which replicates it locally rather than calling the JMAP layer
  (anglebrackets binds only `ACCOUNT_DO` cross-script).
- `services/anglebrackets/src/dav.test.ts` (sVOL `009`) is the pattern; it has a local
  stateful fake and 29 tests to extend.
- Refuse `displayname` changes on a **role** calendar? No — `004` decided rename is allowed on
  role mailboxes because "role is the contract, name is a label". Match that, or explain why
  DAV differs.
- Update the DAV columns in `.plans/sVOL-CapSurNoun/_index.md` from `CR-D` to `CRUD` when it
  lands, and flip the matching `_verify.sh` assertion.
