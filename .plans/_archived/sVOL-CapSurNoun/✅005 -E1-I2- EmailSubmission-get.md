# 005 -E1-I2- `EmailSubmission/get`

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E1** — one method over an existing table, no schema change, no migration |
| **Impact** | **I2** — unlocks other work, **not** human-verifiable on completion |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Status** | **✅ done** — shipped as spec conformance only; see *Status note*, below |

## Cells covered

`EmailSubmission × Read × JMAP`

One cell. It closes a **registry inconsistency**: the server currently answers "which
submissions changed?" and has no method that answers "what is submission `es_…`?".

## Why these grades

**E1.** `readme.md:69` anchors E1 at "one file, no schema change, no new method, no new
dependency". This is one new registration in `services/jmap/src/methods/submission.ts` plus
one `SELECT` helper in `packages/mailstore/src/index.ts`, over a table that already exists
(`packages/mailstore/sql/data-plane.sql:266-276`) and rows that are already written
(`insertSubmission`, `packages/mailstore/src/index.ts:1750`). Strictly it is *two* files and it
*is* a new method, so it fails the anchor's literal wording — but so does `012`, which the
ledger also grades E1. The anchor's spirit is "no schema, no new semantics, no new dependency
edge", and that holds exactly. It is the smallest real unit in the volume.

**I2 — and this is the interesting half.** The rubric is two independent yes/no factors
(`readme.md:84-88`), and this unit is the clean case where they split.

*Unlocks other work: yes.* `EmailSubmission/changes` is registered (`submission.ts:23`) with no
`/get`. Any consumer that follows the standard JMAP sync loop — call `/changes`, then `/get`
the returned ids — **dead-ends on the second call**. That includes `packages/cli/src/sync.ts`,
which today does not mirror submissions at all, and it will include the sent-state column in
`021` (Email over WebUI). Anything that wants to display "did it send?" needs this method
first, and there is no route around it that does not read D1 directly.

*Human can verify: no.* `readme.md:92-94` judges this **on completion of this unit**, not
hypothetically once some future surface renders it, and `readme.md:96` is explicit that "`curl`
returning correct JSON is **not** human-verifiable. It is test-verifiable." On completion,
`EmailSubmission/get` returns correct JSON to nobody. No CLI command reads it, no DAV
collection maps to it, the WebUI does not exist. A non-engineer has no interface through which
to observe that this unit shipped.

**So why not bundle a CLI surface and make it `I3`?** That is the `readme.md:110` design rule,
and it is the right question — it is exactly what `004` and `006` do. It fails here for a
substantive reason, not a lazy one: **there is nothing worth printing.** Every submission row
is written with `undoStatus: "final"` (`submission.ts:169`, hardcoded at the one and only call
site) and nothing in the repo ever updates it. A `bullmoose sent` command built on this method
would print a list where the status column reads `final` on every row, forever. That is a
worse outcome than no command — it *looks* like delivery status and is a constant.

The design rule says *pair a capability with its cheapest human-visible surface*. Here the
cheapest human-visible surface is not cheap: it requires `006`-style status plumbing that does
not exist (see *What to build* → *the honest ceiling*). `I2` is the correct grade and the unit
should be sequenced as the cheap enabler it is — `_index.md` §3 puts it in wave 4, which is
right.

## What exists today

`registerSubmissionMethods` (`services/jmap/src/methods/submission.ts:21-26`, 183 lines total)
registers exactly two things:

```
EmailSubmission/set       submission.ts:22
EmailSubmission/changes   submission.ts:23   (proxyChanges → AccountDO changelog)
```

**`/set` is create-only, and says so structurally.** `args.create` is read at `:48`.
`args.update` and `args.destroy` appear nowhere in the file — I read all 183 lines. The
response block hardcodes the other four halves of the contract:

```
submission.ts:99    updated: {},
submission.ts:100   notUpdated: {},
submission.ts:101   destroyed: [],
submission.ts:102   notDestroyed: {},
```

**Creates *are* committed to the changelog.** `submission.ts:83-85` pushes
`{ collection: "EmailSubmission", created: createdIds }` and `:90` calls `commitChanges`
against the AccountDO. So `EmailSubmission/changes` genuinely reports ids — the choreography on
the write side is already correct. It is the read side that is missing. **A client is told
which ids changed and has no method to read them.**

**The row.** `data-plane.sql:266-276`:

```sql
CREATE TABLE IF NOT EXISTS email_submissions (
  id, account_id, email_id, identity_id, envelope_json,
  undo_status TEXT NOT NULL DEFAULT 'final',   -- pending|final|canceled
  relay_message_id TEXT,
  send_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
```

Written once by `Mailstore.insertSubmission` (`packages/mailstore/src/index.ts:1750`),
called from `submitOne` (`submission.ts:164-172`) with `undoStatus: "final"` (`:169`) and the
SES id returned by the submit worker (`:160`, from `services/submit/src/index.ts:100`).
**There is no read method on `Mailstore` at all** — grepping the 1912-line file for
`email_submissions` returns the interface at `:246` and the `INSERT` at `:1750-1753`, nothing
else.

**⚠️ The delivery signal that exists does not touch these rows.** `services/submit/src/index.ts`
has an SNS webhook, `handleSesEvent` (`:108`, routed at `:54`), which handles bounces and
complaints — and writes them to a **KV suppression list keyed by recipient address**
(`:129-137`, `env.ROUTES.put("suppress:<email>", "bounce"|"complaint")`). It never opens D1,
never sees an `accountId`, and never links a bounce back to the submission that caused it. The
only place the suppression list is read is the pre-send check at `services/submit/src/index.ts:64`,
surfacing as a `forbidden` "recipient(s) on suppression list" at `submission.ts:154-156`.

So the accurate statement of this unit's value is narrower than "delivery-status display": it
makes submissions **readable**. It does not make them **informative**. Fixing that is a
separate, larger unit (see open question 1).

## What to build

Register `EmailSubmission/get` in `registerSubmissionMethods` (`submission.ts:21`), per
RFC 8621 §7.1, in the shape every other `/get` in this repo already uses — `Identity/get`
(`identity.ts:5-40`) is the closest small model, `Mailbox/get` (`mailbox.ts:6-49`) the closest
structural one:

```
requireAccount(ctx, args, "read")                 // domain defaults to "mail"
ids = args.ids ?? undefined                        // null/undefined ⇒ all
rows = store.getSubmissions(accountId, ids)
{ accountId, state: await accountState(...), list, notFound }
```

Add `Mailstore.getSubmissions(accountId, ids?)` next to `insertSubmission`
(`packages/mailstore/src/index.ts:1748-1765`), mirroring `getMailboxes` (`:292-330`) for the
optional-ids-with-`IN`-markers pattern.

**Wire shape** (RFC 8621 §7.1 properties, mapped to the columns that exist):

| JMAP property | source |
|---|---|
| `id` | `id` |
| `identityId` | `identity_id` |
| `emailId` | `email_id` |
| `threadId` | join `emails.thread_id` on `email_id`, or omit — see below |
| `envelope` | `JSON.parse(envelope_json)` |
| `sendAt` | `new Date(send_at).toISOString()` — `/set` already returns it this way (`submission.ts:177`) |
| `undoStatus` | `undo_status` |
| `deliveryStatus` | `null` — nothing populates it (see *the honest ceiling*) |
| `dsnBlobIds`, `mdnBlobIds` | `[]` |

`threadId` is the one that costs a join. `Email/get` already resolves it, and a client holding
an `emailId` can ask. I would **omit the join and return `emailId` only**, and say so in the
method comment — but a spec-strict reviewer will disagree, and it is one `LEFT JOIN emails`.

**The honest ceiling.** Do not invent a `deliveryStatus`. Returning a fabricated
`{"<rcpt>": {delivered: "unknown", smtpReply: "", displayed: "unknown"}}` map is worse than
`null`: it is spec-legal, so nothing will ever flag it, and a future WebUI will render
"unknown" as if the server had checked. `null` is honest and forces the follow-up unit.

**Do not** add `/query` or `/queryChanges` here. RFC 8621 defines both, nothing needs them, and
`_context.md` §1 records that all four existing `queryChanges` stubs are deliberate throws
consistent with `canCalculateChanges: false`.

## Done when

1. `EmailSubmission/set` creating a submission, then `EmailSubmission/changes` with the
   pre-write state, then `EmailSubmission/get` on the returned ids, **round-trips**: the
   `/changes` ids all resolve, `notFound` is empty, and the `envelope` matches what was sent.
   This full loop is the assertion that matters — it is the exact sequence a conformant client
   runs and the exact sequence that dead-ends today.
2. The `state` returned by `/get` equals the `newState` returned by the `/set` that created the
   row. This is the choreography check adapted to a read-only unit: `/set` commits through
   `commitChanges` (`submission.ts:90`), so a `/get` that computes its state any other way —
   or a row inserted by a future path that skips the commit — shows up as a mismatch here
   rather than as an unexplained client resync three months later.
3. `ids: null` returns every submission for the account and nothing from any other account.
4. A submission id from a different account is reported in `notFound`, not returned.
5. A token holding only `send` (not `read`) is refused. ⚠️ Note this is unenforceable for
   `mail`-scoped tokens until `common/001` lands — see bread-crumbs.

## Bread-crumbs

- The file is small: `services/jmap/src/methods/submission.ts` is 183 lines and the registry
  function is `:21-26`. Everything else in it is `submitOne` and the `onSuccessUpdateEmail`
  dance.
- `proxyChanges` (`common.ts:69-108`) already lists `"EmailSubmission"` in its collection union
  (`:76`) and routes it to the `"mail"` domain (`:83-88`). Nothing to change there.
- `/set` requires the `"send"` scope (`submission.ts:38`). `/get` should require `"read"`, the
  same as every other read method (`mailbox.ts:7`, `identity.ts:6`, `thread.ts:6`,
  `email.ts:65`).
- ⚠️ `common/001` (P1, open): `hasScope` (`packages/auth-core/src/index.ts:50-53`) treats
  `mail` as universal — it satisfies every required scope except `admin`. Done-when #5 only
  bites for narrowly-scoped tokens.
- `undoStatus` is a three-value enum in the DDL comment (`data-plane.sql:272`,
  `pending|final|canceled`) and only ever holds `final`. If a future unit adds delayed send,
  `maxDelayedSend: 0` in the session (`services/jmap/src/session.ts:49`) has to move too.
- Tests: this needs no `.batch()`, so it does **not** hard-depend on `002` — a `SELECT`-only
  fake-D1 covers it. It is the one write-adjacent unit in the volume that can be tested with
  the fake that already exists (`services/agent/src/mcp.test.ts:19-43`), if you are willing to
  extend its SQL-substring routing.

## Open questions / where this could be wrong

1. **The real unit here might be "wire SNS delivery events onto submissions", and this is its
   prerequisite.** `handleSesEvent` (`services/submit/src/index.ts:108-142`) receives bounce and
   complaint notifications and throws away everything except the recipient address. To populate
   `deliveryStatus` you would need to correlate on `relay_message_id` (stored at
   `data-plane.sql:273`, populated at `submission.ts:169`) — which means the submit worker
   needs a D1 binding and an AccountDO binding it deliberately does not have. The source
   comment at `services/submit/src/index.ts:96-99` says why: an AccountDO binding "would
   otherwise be circular with jmap's SUBMIT service binding". **That is a real architectural
   obstacle and I have not solved it.** If a reviewer thinks `005` should not ship without it,
   the answer is a new unit, not a bigger `005` — but I did not file that unit and I should
   have.
2. **Is "unlocks other work" actually satisfied?** `readme.md:89-90` demands a *named*
   dependency, not "would be nice first". My named consumers are `021` (Email over WebUI, whose
   sent-state column needs this) and a hypothetical submission mirror in `packages/cli/src/sync.ts`
   that nobody has filed. `021` is `E4` on a stack that does not exist. If a reviewer holds the
   hard line — the blocked unit must itself be real and buildable — **this collapses to `I0`**,
   and `I0` is a perfectly respectable grade for "fix a registry inconsistency". I graded `I2`
   because the JMAP contract is itself the consumer: registering `/changes` without `/get` is a
   promise the server does not keep, and the next client that isn't ours will find it. That is
   an argument about spec conformance dressed as an argument about dependencies, and it is the
   weakest reasoning in this file.
3. **`threadId`.** I recommend omitting it (see above). RFC 8621 §7.1 lists it as a property of
   the EmailSubmission object; a client that requests `properties: ["threadId"]` and gets
   nothing back is within its rights to complain. Cheap to add, easy to regret either way.
4. **Nothing was run** (`_context.md` §7). I have not confirmed that any submission row exists
   in a live database — `insertSubmission` is only reached after a successful SES relay
   (`submission.ts:141-160`), so if outbound has never succeeded against this deployment, the
   table is empty and the round-trip in done-when #1 has never been exercised end to end by
   anyone.

---

## Status note — what shipped, and the call that had to be made

**Shipped: spec conformance only.** `EmailSubmission/get` is registered and returns what the
row actually contains. Delivery status was **not** wired back from the relay. That was a
decision, not an omission, and the argument is below so a reviewer can attack it.

### Line numbers in this file predate several commits — corrected

The file was written against a 183-line `submission.ts`; it is 219 lines at the time this unit
was built (before this change) and the citations moved. Verified against source:

| Claim in this file | Was | Actually |
|---|---|---|
| `registerSubmissionMethods` | `:21-26` | `:23-28` |
| `EmailSubmission/set` registered | `:22` | `:24` |
| `EmailSubmission/changes` registered | `:23` | `:25-27` |
| `args.create` read | `:48` | `:50` |
| the four hardcoded response halves | `:99-102` | `:101-104` |
| changelog push + `commitChanges` | `:83-85`, `:90` | `:85-87`, `:92` |
| `submitOne` insert, `undoStatus: "final"` | `:164-172`, `:169` | `:186-194`, `:191` |
| `insertSubmission` | `mailstore/src/index.ts:1750` | `:1811` |
| `SubmissionRow` interface | `:246` | `:246` ✅ (unchanged) |
| `email_submissions` DDL | `data-plane.sql:266-276` | `:266-276` ✅ (unchanged) |
| SNS handler / KV suppression writes | `submit/src/index.ts:108`, `:129-137` | ✅ both exact |

**One substantive correction, and it matters to the follow-up unit.** Open question 1 says
populating `deliveryStatus` "means the submit worker needs a D1 binding and an AccountDO
binding it deliberately does not have." The submit worker **already has D1** — `Env.DB`
(`services/submit/src/index.ts:22`), used at `:71-72` to pull the draft blob. Only the
**AccountDO** binding is missing, and the source comment at `:96-99` is about that one alone.
The obstacle is real but it is one binding, not two.

**One bread-crumb has expired, in the unit's favour.** The ⚠️ on done-when #5 — "unenforceable
for `mail`-scoped tokens until `common/001` lands" — is stale. `common/001` is closed:
`hasScope` (`packages/auth-core/src/index.ts:72-75`) now treats `mail` as a bundle of exactly
the six mail verbs, not a wildcard. A `send`-only token really is refused by `/get`, and that
is now a passing test rather than a deferred hope.

### Why not wire real delivery status

The brief asked for this to be argued rather than assumed. Three obstacles, in increasing
order of how much they should worry you:

1. **There is no column.** `email_submissions` stores `undo_status` and `relay_message_id` and
   nothing else about outcome. Per-recipient `deliveryStatus` needs a new column on a deployed
   table, and this repo has no migration framework (`tools/README.md:10-11`). That is the
   literal `E3` anchor in `readme.md:75-79`. A unit that starts at `E1` and ends at `E3` is a
   different unit.
2. **The update would be invisible to `/changes`.** Even granting the column, the submit worker
   has no `ACCOUNT_DO` binding, so an SNS-driven `UPDATE` lands the row and skips
   `commitChanges` — precisely the failure `_context.md` §3 names, and precisely what this
   unit's own done-when #2 exists to catch. A delivery status that never appears in the
   changelog is a status no incremental client will ever see, which defeats the point of
   writing it. Fixing that means restructuring the binding graph (the circularity at
   `services/submit/src/index.ts:96-99`), which is architecture, not a `/get`.
3. **The webhook is unauthenticated.** `handleSesEvent` carries a live `TODO: verify the SNS
   message signature before trusting payloads` (`:106`). Today an unverified payload can add a
   KV suppression key — bad, and bounded. Wiring the same payload into per-submission delivery
   state would make attacker-controlled data render as *the server's own record of what
   happened to your mail*. Shipping that on top of an open webhook would be worse than the gap
   it closes.

So: **a separate unit, still unfiled.** Open question 1 says "I did not file that unit and I
should have" — that remains true, and this delivery does not change it. Sketch for whoever
files it: `E3`, `I1` (a human can eventually see "bounced" somewhere, and it unlocks the
`bullmoose sent` command this unit correctly refused to build) — SNS signature verification
first, then the column, then the binding topology.

### What `/get` returns, and why each value is honest

| property | value | why it is not a lie |
|---|---|---|
| `undoStatus` | **echoed from the column** | Only ever `'final'` today — and `'final'` is *true*. The row is inserted only after the relay accepted (`submission.ts` `submitOne`), and `maxDelayedSend` is 0, so the send genuinely cannot be undone. RFC 8621 §7 defines `undoStatus` as a claim about **cancelability**, not delivery. Echoing rather than hardcoding also means a future `pending`/`canceled` reads back with no change here. |
| `deliveryStatus` | **`null`** | The unit file's own argument, and it is right: a synthesized `{"<rcpt>": {delivered: "unknown", …}}` is spec-legal, so nothing would ever flag it, and a future surface would render "unknown" as though the server had checked. `null` is what RFC 8621 §7 prescribes when the information is unavailable. **Pinned by test** so a later patch cannot quietly upgrade it to a confident lie. |
| `dsnBlobIds`, `mdnBlobIds` | `[]` | Nothing ingests DSNs or MDNs. Empty is accurate, not a placeholder. |
| `relayMessageId` | **not exposed** | Not an RFC 8621 property. It is the correlation key the follow-up unit needs, and no client has a use for it. |

### Open question 3 (`threadId`) — resolved AGAINST the file's own recommendation

The file recommends omitting the join and returning `emailId` only. Shipped **with** the
`LEFT JOIN emails`, and the claim is left standing above rather than edited out, per
`readme.md`'s rule. The reasoning that changed the call: this unit is being justified *purely*
as spec conformance — that is the whole of its `I2` argument in open question 2 — and omitting
a property RFC 8621 §7.1 lists while pleading conformance is inconsistent. The join is on
`emails`' primary key, so it costs one index seek per row, and `LEFT` means a submission whose
email was since destroyed reads back with `threadId: null` instead of disappearing. Tested
both ways.

### Deviations from *What to build*, and one latent bug not propagated

- `properties` is honoured (`id` always included), following `ContactCard/get` rather than
  `Identity/get`. Free, and it lets a client that only wants `undoStatus` skip the join-shaped
  payload.
- The envelope is **re-inflated**, not echoed. The row stores the flattened relay shape
  (`{mailFrom: string, rcptTo: string[]}`); RFC 8621 §7 puts `EmailSubmissionAddress` objects
  on the wire, which is also the shape `/set` accepts. Returning the stored shape would break
  read → re-submit. There is a test that literally round-trips `/get`'s envelope back into
  `/set`.
- **`ids: []` returns nothing.** `getMailboxes`, the pattern this was told to mirror, branches
  on `ids && ids.length > 0` — so an explicitly empty `ids` array falls through to "return
  everything". `getSubmissions` branches on `ids` alone. Mirroring the quirk would have made
  `/get` with `ids: []` dump the whole account. Not fixed in `getMailboxes` (out of scope, and
  four callers), but flagged here and in that method's doc comment.

### Done-when — all five, with the caveat lifted

| # | criterion | how |
|---|---|---|
| 1 | `/set` → `/changes` → `/get` round-trips; ids resolve, `notFound` empty, envelope matches | ✅ the first test in the `/get` suite, driven end to end through the **real** `AccountDO` |
| 2 | `/get`'s `state` equals the `newState` from the creating `/set` | ✅ and asserts `!= oldState`, so it cannot pass by both being stale |
| 3 | `ids: null` returns every submission for the account and nothing from another | ✅ two assertions, plus an `ids: []` case the criterion did not anticipate |
| 4 | a foreign submission id lands in `notFound` | ✅ |
| 5 | a `send`-only token is refused | ✅ **no longer caveated** — `common/001` is closed. The test also proves the same token *can* `/set`, so it is a read gate rather than an account gate |

### Grade after delivery — `I2` stands, and the file's reasoning is intact

`E1` held: two source files, no schema change, no migration, no new dependency — ~95 lines of
executable source (`getSubmissions`, the method, the row→JMAP mapper), plus about as much again
in comments, most of it explaining why `deliveryStatus` is null. `I2` held for
exactly the reason the file gives — on completion, `/get` returns correct JSON to nobody. No
CLI command reads it, no DAV collection maps to it, the WebUI does not exist. The unit shipped
and a non-engineer cannot tell.

That is not a complaint about the rubric; it is the rubric working. This unit remains the
volume's clean teaching case for the two-factor grade splitting, and open question 2 — that
"the JMAP contract is itself the consumer" is *"an argument about spec conformance dressed as
an argument about dependencies, and it is the weakest reasoning in this file"* — is still the
most honest sentence in it. Nothing about building the unit made that argument stronger. A
reviewer who collapses this to `I0` has a case.
