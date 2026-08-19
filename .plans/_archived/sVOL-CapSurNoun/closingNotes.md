---
plan: sVOL-CapSurNoun
status: closed
closed_at: 2026-08-19    # self-declared closed 2026-08-17 at #159; this note is
                         # the archive gate catching up to that
closing_pr: 159          # sVOL: close the section — 25 shipped, 2 wontfix, and
                         # reconcile the bookkeeping (merged 2026-08-17)
acceptance: met          # every unit resolved; the matrix is not full, and says so
residues: 6
reversals: 3
---

# sVOL — closing notes

sVOL asked one question — *for every noun in bullmoose, on every surface we
expose, can you create, read, update and delete it?* — and answered it by
enumerating 98 noun-surface cells, grouping them into 27 buildable units, and
grinding through them over nine days. It closed the two columns it was built
around: **MCP went from 4 read-only analytics tools to 29** including its first
writes, and **the CLI filled in** across contacts, calendar and email triage.
`Mailbox` stopped being immutable. DAV became read-write at the collection
level. `FileNode` went from a proposed noun to a shipped one with a browser on
top of it.

But the section's own summary is more honest than that, and worth quoting: it
"closed the two columns it was built around and outlived its own framing of a
third." `readme.md` grades every WebUI cell `E4` because *"that stack doesn't
exist"*; `webmail/` now serves thirteen pages under `webmail/src/pages/`, eleven of them
realms in `webmail/src/lib/app/sections.ts`. The section left that sentence
standing as evidence rather than fixing it.

**What sVOL is actually remembered for is not the 25 units.** It is the closing
audit — the discovery that *zero units were outstanding and the section did not
know it*, and the diagnosis of why. That post-mortem is the most self-aware
document in this repo, it correctly named a failure mode that recurred one
sprint later in s24 and s25, and it is the reason `infra/archivedPlans.test.ts`
and this whole closing-note format exist. It is quoted below rather than
summarised, because summarising it would be the very thing it warns about.

## Acceptance ledger

sVOL is a ledger of record, not a devPlan, so it has no `Done-when` clauses. Its
acceptance surface is §4's coverage rule and the closing claim in `readme.md`;
both are quoted verbatim. The 25 units are checked here by spot-verification
against implementing code, not by re-reading the ledger — #159 states it checked
all 25 the same way and found every one real.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| §4: "Every non-`n/a` gap cell in §1 maps to at least one unit" | ⚠️ met with **one stated exception** | §4's own table carries the exception in plain sight: `AddressBook`/`Calendar` × C/U/D × MCP → "— (unfiled; `013` shipped Read only)". Carried forward. |
| `readme.md` §Closing: "**27 units: 25 shipped, 2 wontfix. Nothing is outstanding.**" | ✅ met | ledger `_index.md` §2; 25 filenames carry `✅`; `012` and `025` sit in `archived/` |
| "**`Mailbox` stopped being immutable.** `004` landed `Mailbox/set` plus CLI verbs" | ✅ met | `services/jmap/src/methods/mailbox.ts:75` registers `Mailbox/set` |
| "**The MCP column went from 4 read-only analytics tools to 29**, including MCP's first writes — `013` … `014` … `015`" | ✅ met (count now 30 — see below) | `services/agent/src/mcpNouns.ts` 10 tools (`:153`–`:572`, incl. `calendar_create_event`, `contacts_delete_card`), `emailTools.ts` 8 (`:261`–`:635`), `introspectTools.ts` 7 (`:808`–`:1131`), analytics 4 (`mcp.ts:280`), assembled at `mcp.ts:398-405` |
| "**The CLI column filled in** — `016` set the I/O contract, then `017`/`018`/`019`" | ✅ met | six §1 grid cells corrected at #159 with `file:line`; `_index.md` §1 now reads `CRUD` for Email/AddressBook/ContactCard/Calendar/CalendarEvent × CLI |
| "**DAV became read-write at the collection level** — `009` (`MKCALENDAR`, extended `MKCOL`, collection `DELETE`)" | ✅ met | `services/anglebrackets/src/dav.test.ts:8,183,200` exercises `MKCALENDAR` and collection creation against the implementation |
| "**`FileNode` went from a proposed noun to a shipped one** (`011`) with a browser on top of it (`021`)" | ✅ met | `FileNode/get` and `FileNode/set` both answer `ok` (`services/jmap/src/methods/filenode.test.ts:55,83`); `/files` renders (`webmail/src/components/FilesApp.tsx`) |
| `027`: register `Thread/changes` rather than leave it `unknownMethod` | ✅ met | `services/jmap/src/methods/thread.ts:28` throws `cannotCalculateChanges` — RFC 8620 §5.2's sanctioned answer, not an eternally-empty delta |
| `012` — "`AddressBook/query` + `Calendar/query`" | ✅ **wontfix, correctly** | neither method exists in RFC 9610 §2 or draft-jmap-calendars-27 §4; archived at `archived/012 -E1-I1- …md`. `_verify.sh`'s two absence assertions for it remain correct and untouched. |
| `025` — "GraphQL facade" | ✅ **wontfix, correctly** | JMAP already has batching, back-references and a sync cursor; archived at `archived/025 -E4-I2- …md`. But see the residue: `.feedback` still asks for the spike. |
| Implied by "nothing is outstanding": the section's own records agree with the tree | ❌ **unmet at the time, fixed at #159** | this is the post-mortem. 15 of 27 files missing `✅`, 10 Status lines wrong, a "BLOCKED" banner written after both units shipped, 6 grid cells understating, `_context.md` self-contradictory, every `_index.md:NN` reference stale, `_verify.sh` asserting 5 false things. |

## Carried forward

The section's own list of five, re-verified against the tree on 2026-08-19, plus
one this note found. Every one now has a home; before this pass, four of them had
none other than an archived folder.

| what | why it did not ship | owner |
|---|---|---|
| **`POST /vault/oauth/start` is unserved.** The vault can hold an `oauth-refresh` credential and the console will drive the whole PKCE dance, but there is no route to begin one. | Genuinely nobody's: it fell in the seam between `s03.E` (which built the console as a read surface) and sVOL (which classified it as another section's job). Verified still true: `services/agent/src/index.ts:182,187` routes only `/internal/vault/verify` and `/vault/credentials*`; `webmail/src/lib/console/credentials.ts:247` POSTs to it anyway and the UI surfaces the 404 honestly (`:234-238`). Both plans naming it are now archived. | **`#220`** (label `residue`) |
| **`AddressBook`/`Calendar` collection C/U/D over MCP** — an agent can create an *event* but not a *calendar*, a *card* but not an *address book*. | "Unfiled from the beginning, and §4 always said so." Verified: `services/agent/src/mcpNouns.ts:153` (`calendar_list`) and `:419` (`contacts_list_books`) are read-only; the ten noun tools contain no collection write. It is the one gap sVOL enumerated and then declined to file a unit for. | **`#227`** (label `residue`) |
| **`021`'s visual confirmation — no human has looked at `/files`.** | The pages and their libs are tested; a test is not a look. Still true: s25's 390 px responsive audit (#189) covered Mail, Contacts, Approvals, Agents and Activity — **Files was not among the five.** | **`#227`** (label `residue`) |
| **Delivery status for `EmailSubmission`.** `undo_status` is written once and never updated; the SNS bounce handler keys a KV suppression list by *recipient* and never correlates on `relay_message_id`. | Scoped and rejected as a separate `E3` inside `005`, deliberately, then never filed. `readme.md`'s own "where the rule fails" table flags it as one of the hard flows hidden behind a low grade. | **`#227`** (label `residue`) |
| **`023`'s pre-ship ask went unpaid.** It asked for the `tokens ⋈ principals` join to be factored out first; it shipped anyway. | Still hand-rolled at `services/agent/src/vault.ts:124-135` — `authenticateVault` opens its own `SELECT … FROM tokens t JOIN principals p ON p.id = t.principal_id`. A pre-ship condition that does not block the ship is a preference. | **`#227`** (label `residue`) — the same call site is named by `s01-stateless-MCP`'s closing note; merge if that lands its own issue |
| **`.feedback common/022` still asks for a GraphQL spike that `025` declined.** | `025` is wontfix and archived; `.feedback/fromClaude/common/022 -P2- Spike-GraphQL-Resolver-Cost-On-D1-Workers.md` carries no `✅` and `.feedback/_index.md:24` still lists it open. Two records, one decision, disagreeing — the section's own failure mode, surviving its own post-mortem. | `.feedback/fromClaude/common/022 -P2- Spike-GraphQL-Resolver-Cost-On-D1-Workers.md` — that file is the live record and the place to tick or wontfix |

## Reachability

sVOL is 27 units across five surfaces rather than one capability, so this is
stated per column.

- **Deployed?** Yes, everything that has a runtime. The jmap worker serves (`https://app.bullmoose.cc/.well-known/jmap` → **401**, probe 2026-08-19), which carries `Mailbox/set`, `Identity/set`, `FileNode/*`, `Thread/changes` and the `queryChanges` work. The webmail plane serves (`app.bullmoose.cc/mail/` → **200**). The agent worker carries the MCP tools; the anglebrackets worker carries DAV. The CLI ships as source, not a release — `s08-go-cli` T7 is the section that owes that, and it is still live.
- **Migration applied?** **Exactly one unit needed schema and it landed with its unit** — `006` (`Identity/set`). Everything else is methods over existing tables. Note the standing hazard `readme.md` names at the `E3` cliff: this repo has **no migration framework**; schema is applied by re-running `CREATE TABLE IF NOT EXISTS` (`tools/README.md:10-11`), so adding a column to a deployed table has no automated path. That is why `E3` is a real step up and not a line count.
- **Switched on?** Yes — nothing in sVOL sits behind a flag, a secret or a commented route. This is the section's quiet contrast with `s21`: everything sVOL built is reachable by anyone holding a token with the right scope, the moment it merged.
- **Verified live?** **No — and this is the section's sharpest self-criticism.** `_verify.sh` is the grid in executable form, built to "decay loudly rather than rot quietly", and it **has never been run**. It needs a live `BM_TOKEN` against a deployed account and has no CI job. #159 corrected five of its assertions by reading source and then shipped it un-run (`bash -n` clean, and that is all). It has already decayed again — see below.

## Authority-surface delta

Large, and mostly in one direction: **agents got hands.**

- **MCP's first writes.** Before `013`/`014`, MCP was four read-only analytics tools. It now carries create/update/delete for `CalendarEvent` and `ContactCard`, and email triage — keyword set, move, draft create, destroy (`services/agent/src/mcpNouns.ts`, `emailTools.ts`). Every one routes through the JMAP method layer in-process, so DAV and the CLI mirror the same choreography rather than a second implementation. **This is the single biggest expansion of what an agent can do to your mailbox in the repo's history.**
- **A refusal held inside that expansion.** `014` shipped email read + triage and **deliberately no send tool**. Named as a decision so it does not read as an omission.
- **A refusal that is permanent, not pending.** `Secrets × Read` is forbidden by `bureau.md` invariant 1 — there is no "reveal password" button. Marked `n/a` in the grid, never `todo`, which is the difference between a wall and a gap.
- **New admin lifecycle.** `008` gave `agent_bindings.enabled` a route. Before it, the column was written `1` at creation and never again while both drain paths filtered on it (`services/agent/src/index.ts`, `services/ingest/src/index.ts`) — the agent kill switch existed and was unreachable. `readme.md` calls this out as the rubric's sharpest failure: `007` (I3) handed a human an on-demand agent trigger into a system whose off switch was unreachable, and the unit that reconnected it graded `I1`.
- **DAV gained collection creation and deletion** (`009`) — `MKCALENDAR`, extended `MKCOL`, collection `DELETE`, plus `PROPPATCH` from `common/026`.
- **Introspection became browser-reachable** (`015` → `console.ts`), so `015`'s `x-internal-token` gate is no longer what stands between a human and the answers about their own grants.

## Deviations from `devPlan.md` / `arch.md`

- **`002` was widened after review** and the reason is the transferable part: "shared fake-D1 with `.batch()`" is necessary but not sufficient, because `storeFor` requires `env.BLOBS` (`services/jmap/src/methods/common.ts:58`) and the changelog commit requires `env.ACCOUNT_DO` (`:62-63`). Any acceptance criterion of the form *"…and the write appears in `Foo/changes`"* — the criterion that catches the skipped-choreography bug — is unwritable without both.
- **Two units were regraded on delivery**, not in advance: `008` E2→**E3** and I1→**I3**, `006` to **E3**. `003`'s `E2` is contested by its own file, which argues both sides and lets the grade stand.
- **`readme.md` records where its own rubric misleads, and did not fix it.** `004` (`Mailbox/set`) is the largest capability gap in the repo — the session advertises `maxMailboxDepth`, `mayCreateTopLevelMailbox`, `mayRename` and `mayDelete` with no method behind any of them — and because no unit names it as a blocker, the strict "unlocks other work" test grades it `I1`, below a CLI flag. Left at `I3` "pending a human call", with the open question stated rather than resolved. A rubric that documents its own blind spot is more useful than one that hides it.
- **The pairing rule ("pair a capability with its cheapest human-visible surface") was applied and then explicitly bounded.** `readme.md`'s "where the rule fails" table names five units whose hard data flows are hidden behind low grades, and states the reviewer rule: "a low impact grade licenses *deferring* a unit. It never licenses designing the high-impact unit as though the deferred flow does not exist."

## Reversals

- **sVOL reverses itself: the "023 and 024 are BLOCKED" banner is struck.** Written 2026-08-14, it blocked two units on an in-flight WebUI redesign. Both had already shipped — `024` as `s07` T2 at `f23ea39` (2026-08-10, four days earlier), `023`'s screens at `6f9be2d` (2026-08-09) and its four `/console/*` routes at `8813423` (2026-08-13, the day before). The banner even conceded *"`/console/*` serves"* and then blocked on a repaint. Struck at #159, with the original left visible under `~~strikethrough~~` rather than deleted.
- **`025` reverses `.feedback common/022`.** That item asks for a spike measuring GraphQL resolver cost on D1 + Workers; `025` declines the facade outright, on the grounds that JMAP already has batching, back-references and a sync cursor. The `.feedback` item was never ticked — see the residue.
- **`012` reverses its own premise.** Filed as a capability unit for `AddressBook/query` + `Calendar/query`, closed wontfix once the specs were read: neither method exists in RFC 9610 §2 or draft-jmap-calendars-27 §4. A unit can be wrong about whether the thing it wants is a thing.
- **`s01`'s decisions are *not* touched here** — that reversal belongs to `s02`. Named only because sVOL's grid sits next to both and is easy to blame.

## Absorbed / donated

sVOL is unusual in that **9 of its 27 units were built by other sections** and it
pointed at them rather than restating the work — which is also the mechanism that
produced its bookkeeping drift.

- **Built elsewhere, pointed at from here (9):** `003` (`.feedback common/003`), `011` (**s03.B**), `016`/`017`/`018` (**s05** T1–T3), `020` (**s05** T4 + **s04**), `021` (**s03.C**), `023` (**s03.E**), `025` (`.feedback common/022`). `024` closed as **s07 T2**.
- **Donated:** `004`'s `Mailbox/set` is what makes the mailbox tree in `webmail` and both CLIs meaningful; `013`/`014`/`015`'s MCP surface is the tool set every later agent sprint composes; `002`'s shared fake-D1 harness is the substrate the repo's tests still stand on.
- **Donated to `s03.E`, and this is the cross-plan closure that matters:** `POST /vault/oauth/start` was named as a residue in exactly two places, sVOL and `s03.E`, and **both were archived on 2026-08-19**. Without issue **#220** the only surviving record of an unserved endpoint would have been two closing notes inside an archive folder. Recorded in both closing notes and in the issue.
- **Donated to the archive process itself.** `infra/archivedPlans.test.ts`, `.plans/_closingNotes.template.md` and this file exist because of sVOL's post-mortem. The test's own header says so: "one audit found four loose ends that archiving had nearly deleted, two of which were recorded nowhere else."

## What grew stale during the build

The section's own catalogue is better than anything this note could add, so it is
reproduced in its own words:

- **15 of 27 files never got their `✅`** — step 4a. Step 4b (updating `_index.md`) had mostly happened, so the two halves of one instruction diverged.
- **10 unit files still said `todo` or `deferred`** in their own Status line while the ledger called them done.
- **`023` and `024` carried a "BLOCKED, not merely unstarted" banner** written *after* both had shipped — `024` by four days.
- **Six grid cells understated what was built**, always in the direction of more work appearing to remain.
- **`_context.md` — the file step 1 calls ground truth — contradicted itself**, holding both *"there is no WebUI"* and *"WebUI: a working mail client"* four paragraphs apart. "The commit that falsified the first added the second and deleted neither."
- **Every `_index.md:NN` line reference in a unit file is stale**, most of them before the pass began. Left alone rather than mass-corrected, "because correcting them restarts the same clock."
- **`_verify.sh` asserted five things that were false.** Built to "decay loudly rather than rot quietly", and it did decay correctly — "but decay is only audible if something runs it, and nothing ever did."

Two things this note adds, found on 2026-08-19:

- **`_verify.sh` has already decayed again, in the assertion #159 fixed.** Line 425 asserts `MCP tools/list returns 29 tools`, kept exact "because the count IS the grid fact". `TOOLS` (`services/agent/src/mcp.ts:398-405`) is **30**: 4 analytics + 10 noun + 8 email + 7 introspect + `REVOKE_APP_TOOL`. `visibleTools` returns `TOOLS` unfiltered for a principal with no invocation envelope (`mcp.ts:688-692`) — exactly the plain-human-token case the comment at `_verify.sh:423` describes. `revoke_app` landed at `efc38f0` on **2026-08-14, three days before** the pass that rewrote that line from 14 to 29. The assertion was stale on the day it was corrected, and nothing has run it since to say so.
- **`readme.md`'s `E4` anchor is still half false, deliberately.** *"Includes anything on a stack that does not exist yet (WebUI, GraphQL)"* — the WebUI now serves thirteen `.astro` pages. The section names this as "the single most-dated claim in this section and is left standing as evidence." That is a defensible choice, and the only reason it works is that the sentence next to it says so.

## Traps for the next section

- **The diagnosis, in the section's own words, because it earned it:**

  > The common cause is not laziness; it is that **every one of these records is
  > updated by hand by whoever shipped, and half these units were shipped by
  > another section.** `024` closed as `s07` T2 — that section's dev plan cites
  > *"sVOL `024`"* by number, correctly, and sVOL still never learned. **A
  > cross-reference is only a link if something walks it.**
  >
  > If this process is reused, **the cheapest fix is not more discipline — it is
  > making one of these records derivable rather than asserted.** The filename
  > `✅`, the ledger status column, and the unit Status line are three
  > hand-maintained copies of one fact.

  It was right, and it was right about the future too: one sprint later s24 cited
  `file:line` references into files that same sprint rewrote, and s25 shipped a
  `✅ LANDED` task containing a clause that had been split to another lane and
  never came back. The failure mode is not specific to a ledger of 27 units. It
  is what happens to any hand-maintained second copy of a fact.

- **Three hand-maintained copies of one fact will diverge; pick one and derive the rest.** Corollary, and the reason the archive now has a vitest gate: the copy that survives should be the one a machine can check.
- **A script written to decay loudly is silent until something runs it.** `_verify.sh` is a good artefact and a bad control. It has never executed, it needs a live token against production, and it has no CI job. Cost so far: five false assertions found by hand, plus a sixth introduced the same day. **If a check has no runner, it is documentation.**
- **Cite section numbers, not line numbers, in a file you expect to grow.** Every hand-written line number into `_index.md` rotted silently as it was appended to a dozen times.
- **Leave the wrong claim visible and argue with it.** sVOL struck its BLOCKED banner with `~~strikethrough~~` and wrote the correction underneath, and its review protocol forbids silently editing a claim out of a unit file. The reasoning survives, and so does the evidence that it was wrong — which is the only way a later reader can tell a correction from a rewrite.
- **A low impact grade licenses deferring a unit; it never licenses designing the high-impact one as though the deferred flow does not exist.** The `007`/`008` pairing — an on-demand agent trigger shipped into a system whose off switch was unreachable — is the concrete cost.
- **"Nothing is outstanding" and "the matrix is full" are different claims.** sVOL closed on the first while explicitly denying the second, and listed five things that were true and unowned. That distinction is the whole reason this template has both an *Acceptance ledger* and a *Carried forward*.
