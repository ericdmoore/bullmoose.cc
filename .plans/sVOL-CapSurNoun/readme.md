# sVOL — Capability × Surface × Noun

> **Status: CLOSED (#159, 2026-08-17).** 25 units shipped, 2 wontfix, none outstanding. Five residues are recorded in § Closing — they are real but are not units.

The volume of work implied by asking, for every **noun** in bullmoose, on every **surface**
we expose: _can you create, read, update, and delete it?_

This folder is a **ledger of record**, not a competing plan. It enumerates every cell. Cells
already owned by an existing `sNN` section point there instead of restating the work.

> ## ✅ CLOSED 2026-08-17 — 25 shipped, 2 wontfix, nothing outstanding
>
> Jump to **§ Closing** at the foot of this file for what the section delivered, what is
> genuinely still open (none of it a unit), and why the bookkeeping drifted so far from the
> work. The process notes below are kept as written; several are now historical — in
> particular the `E4` grade's _"stacks that do not exist yet (WebUI, GraphQL)"_ is half
> false, because the WebUI exists.

---

## Layout

```
_index.md      the exhaustive grid + the work-unit ledger    ← start here
_context.md    audited ground truth (what is actually built) ← read before reviewing
_verify.sh     the grid, as executable assertions            ← run it
config.yml     authoritative noun / surface / grade lists
readme.md      this file — process and rubrics

NNN -E{n}-I{n}- Work-Unit-Name.md    the pile
```

**`_verify.sh` is the grid's executable form.** `_context.md` §7 admits nothing here was ever
run; this closes that. It asserts both directions — present cells run, **absent cells are still
absent** — and the absences are the point. When someone lands `Mailbox/set`, the
`expected: unknownMethod` assertion fails, and _that failure is the signal to update the grid_.
It is designed to decay loudly rather than rot quietly.

```bash
BM_TOKEN=bm_… BM_ACCOUNT=acc_… ./_verify.sh      # run every assertion
./_verify.sh --list                              # show them (and their count), run nothing
./_verify.sh calendar                            # filter by label
```

Set `BM_RO_TOKEN` to a `read`-only token to enable the scope-gate suite, which is a live
regression test for `common/001` (P1): if a read-scoped token can call `CalendarEvent/set`,
the gate is open. Exit code = failure count.

One file in the pile = **one buildable work unit**, which may cover several cells. Cells are
not independently buildable (see _Why not one file per cell_, below), so the pile is grained
to what someone can actually pick up and finish. The exhaustive grid lives in `_index.md`.

Filenames mirror `.feedback`: `{NNN} -E{effort}-I{impact}- {Name-With-Dashes}.md`. Numbers
are identity — assigned once, never reused, never renumbered. Sequence lives in `_index.md`.

Mark a shipped unit with a leading ✅ in the filename, same as `.feedback`.

---

## The two work-kinds

The single most important distinction in this volume:

|                | Shape                                                                                                      | Cost driver               | Batches by  |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------- | ----------- |
| **Capability** | can the system do this _at all_ — schema, core logic, and the JMAP method that owns the write choreography | new tables, new semantics | **noun**    |
| **Projection** | expose a capability that already exists on one more surface                                                | mechanical mapping        | **surface** |

**The law: a projection unit may only contain cells whose capability already exists.**

This is `s05`'s class-(a) / class-(b) split (`.plans/s05-cli-crud/readme.md:18-19`) promoted
to a general rule. It is what keeps the grid from exploding: a cell's cost is _not a property
of the cell_.

> `Contacts × Update × CLI` — `ContactCard/set` and CardDAV PUT both already work. ~20 lines.
> `Mailbox × Create × CLI` — `Mailbox/set` **does not exist on any surface**. Not CLI work at all.
>
> Same row, same column, two orders of magnitude apart.

If a unit needs both, it is a **capability** unit and says so. Never file a projection unit
against a capability that isn't built — file the capability unit and let the projection
depend on it.

---

## Grades

Both grades are in the filename so the pile sorts and greps like `.feedback`.

### Effort — `E1`–`E4`

T-shirt sizes, **anchored to observable scope** rather than time, so they survive being wrong
about velocity.

|        | Size | Anchor                                                                                                                                              |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** | S    | One file. No schema change, no new method, no new dependency.                                                                                       |
| **E2** | M    | Several files inside one package/service. New methods over existing tables, or a new tool/command surface. No migration.                            |
| **E3** | L    | New table or column + migration, **or** new semantics that other code must respect (write choreography, auth gate, sync contract). Tests mandatory. |
| **E4** | XL   | New workspace, service, or protocol surface. Includes anything on a stack that does not exist yet (WebUI, GraphQL).                                 |

Note the migration cliff at E3: this repo has **no migration framework** — schema is applied
by re-running `CREATE TABLE IF NOT EXISTS` (`tools/README.md:10-11`). Adding a column to a
deployed table has no automated path. That is why E3 is a real step up from E2 and not a
matter of line count.

### Impact — `I0`–`I3`

Two independent factors, exactly as specified:

|                          | **unlocks other work** | **unlocks nothing** |
| ------------------------ | ---------------------- | ------------------- |
| **human can verify**     | **I3** — highest       | **I1**              |
| **not human-verifiable** | **I2**                 | **I0**              |

**"Unlocks other work"** — completing this unit removes a stated blocker from at least one
other unit or `sNN` section. Not "would be nice to have first"; a named dependency.

**"Human can verify"** — a non-engineer could confirm it works through a normal interface:
a mail client, Apple Calendar, a browser, or CLI output they can read. Judged **on completion
of this unit**, not hypothetically once some future surface renders it.

`curl` returning correct JSON is **not** human-verifiable. It is test-verifiable. This is a
deliberately harsh line, and it produces the right signal — it is why CalDAV work grades high
(you can point Apple Calendar at it) and why a JMAP method with no surface grades lower than
it feels.

### Impact is not priority

A blocker with `I2` still gets sequenced before the `I3` it unblocks. `_index.md` carries the
sequence; the grade describes the cell, not the calendar.

---

## Design rule that falls out of the rubric

**Pair a capability with its cheapest human-visible surface in the same unit.**

`Identity/set` alone is `I2` — real, invisible, verifiable only by test. `Identity/set` _plus_
the four-line CLI subcommand is `I3`, because now you can set a signature, send mail, and see
it. The second version is barely more work and worth a full grade more.

Where the cheapest human-visible surface is CLI or DAV, bundle it. Where it is WebUI, don't —
that stack doesn't exist and the bundle would become `E4`.

### Where the rule fails — read before sequencing

The pairing rule optimises for _visible_ wins, and this volume's **hard data flows are
concentrated in the low-graded units**, precisely because they are invisible. Grading them
low is correct under the rubric; **skipping their design is not.** The known cases, all
verified:

| Unit                        | Grade     | The flow that is actually hard                                                                                                                                                                                                                                                               |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `026` `queryChanges`        | E3 **I0** | The real sync design. And `s03.C`'s virtualized thread list is planned _on_ `Email/queryChanges` (`arch.md:57`) — a method that always throws (`email.ts:54`). T2 must build the re-query fallback or land this.                                                                             |
| `010` blob lifecycle        | E2 **I1** | Share links are **stateless HMAC** (`services/jmap/src/index.ts:185`) — nothing is recorded at mint. Enumeration is therefore exactly as impossible as revocation, and both need the same fix. `s03.B` T3 builds _on_ this path, so the gap widens with use.                                 |
| `005` `EmailSubmission/get` | E1 I2     | There is no delivery-status flow to expose. `undo_status` is written `'final'` once (`submission.ts:169`) and never updated; the SNS bounce handler writes a KV suppression list keyed by **recipient** (`services/submit/src/index.ts:129-137`) and never correlates on `relay_message_id`. |
| `027` `Thread/changes`      | E2 **I0** | `proxyChanges`' collection union **already includes `"Thread"`** (`common.ts:75`) — the only occurrence of that string in the tree. Registering the method today compiles and returns an eternally empty delta, which is _worse_ than `unknownMethod`.                                       |
| `008` admin lifecycle       | E2 **I1** | `agent_bindings.enabled` (`data-plane.sql:104`) is written `1` at creation and **never written again** — no route reaches it. Both drain paths filter on it (`agent/src/index.ts:110`, `ingest/src/index.ts:169`), so it _is_ the agent kill switch, just unreachable.                       |

That last row is the sharpest instance of the failure mode: **`007` (I3) hands a human an
on-demand agent trigger into a system whose off switch is unreachable, and the unit that
reconnects it grades `I1`.** Sequence `008`'s binding-disable route with `007`, not in wave 4.

**The rule for reviewers:** a low impact grade licenses _deferring_ a unit. It never licenses
designing the high-impact unit as though the deferred flow does not exist.

### Where the rubric is known to mislead

`004` (`Mailbox/set`) is the largest capability gap in the repo — the session already
advertises `maxMailboxDepth`, `mayCreateTopLevelMailbox`, `mayRename`, and `mayDelete` while
providing no method to act on any of them — and yet **no unit and no `sNN` section names it as
a blocker**, so the strict "unlocks" test grades it `I1`, below a CLI flag.

Left at `I3` pending a human call. The open question is whether "closes a glaring absence in
the flagship noun" deserves to be a third impact factor, or whether the honest answer is that
impact and priority genuinely diverge here and the sequence in `_index.md` should carry it
instead.

---

## Why not one file per cell

Considered and rejected. 14 nouns × 7 surfaces ≈ 98 noun-surface pairs; roughly half are
already built or genuinely N/A (`Thread × SMTP` is not a thing). More decisively: one
buildable slice routinely spans four cells that **must ship together** — the MCP tool surface
covers Calendar, Contacts, and Email at once, and splitting it into per-noun files would
describe three fake units none of which is independently shippable.

The exhaustive property is what the grid in `_index.md` is for. The pile is for work.

---

## Process

0. **If you are an agent working in a git worktree, sync it before anything else:**

   ```bash
   git fetch origin && git merge origin/main
   ```

   Worktrees branch from `main` at creation and go stale fast. One agent skipped this and
   silently reverted part of another commit — its change was correct against its own base and
   wrong against the branch. Confirm `npm test` is green _before_ you change anything, so a
   failure later is unambiguously yours.

   Related, and easy to miss: `vitest.config.ts` pins `@bullmoose/*` with `resolve.alias`.
   Without it, Node's upward `node_modules` lookup escapes the worktree and resolves workspace
   packages to the **parent checkout** — tests then exercise a different branch's source than
   `tsc` checks. If you touch that config, keep the aliases.

1. Read `_context.md` first. It is the audited state of the repo, with `file:line` evidence.
   **Do not re-derive it from the docs** — several plan docs are stale or overstate what
   exists, and _no existing plan records its own status_.

   Note the irony, and take the warning seriously: this volume's own `_context.md` went stale
   within one session of being written. It carries a "Changes since the original audit"
   banner for exactly that reason. **Check that banner's date against `git log` before
   trusting a number in it.**

2. Pick a unit from the `_index.md` ledger whose dependencies are met.
3. Build it. Update the unit file's **Status** line.
4. On commit, prefix the filename with ✅ and update `_index.md`.

### For reviewers (Codex, or a human)

Every unit file ends with **§ Open questions / where this could be wrong**. That section is
the point — it is where I record what I could not verify, what I inferred, and which calls
are genuinely arguable rather than settled.

Disagreements go in a sibling `NNN -E{n}-I{n}- Name.review.md`, mirroring `.feedback`'s
`.fix.md` pairing. Do not silently edit a unit file to remove a claim; leave the claim and
argue with it, so the reasoning survives.

**Highest-value review targets, in order:**

1. The grades. Effort anchors are checkable against the repo; impact grades are judgement
   calls and several are close to the line. Each file states its own reasoning.
2. The dependency edges in `_index.md`. A wrong edge changes the build order.
3. The capability/projection classification. If a unit is filed as projection and the
   capability is actually missing, that unit is unbuildable as written — this is the most
   damaging possible error in the ledger, and `_context.md` is the evidence to check it with.

---

## Relationship to the `sNN` sections

`sVOL` **does not supersede** any existing section, and deliberately does not cover
everything in `.plans/`. Roughly 60% of existing plan content is **off-matrix** — it has no
cell to live in:

| Section                 | Off-matrix content                   | Why it has no cell                                                   |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `s01-stateless-MCP`     | the MCP.2 wire contract              | protocol axis — under every cell                                     |
| `s03.A-foundations`     | provenance columns, grant tombstones | a plane _beneath_ every write path; no surface                       |
| `s03.D-coexistence`     | tier / approval semantics            | _mediates_ other nouns' writes                                       |
| `s04-AgentOS/bureau.md` | egress credential brokerage          | a 4th axis — outbound, third-party; no bullmoose noun on either side |

Those stay where they are. `sVOL` references them where they gate a cell.

---

## Closing — 2026-08-17

**This section is closed. 27 units: 25 shipped, 2 wontfix. Nothing is outstanding.**

Opened `784b38e` (2026-08-08), last unit closed 2026-08-14, bookkeeping reconciled 2026-08-17.
Nine days.

|                                           |                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shipped**                               | 25 — `001`–`011`, `013`–`024`, `026`, `027`                                                                                                                                                         |
| **Wontfix**                               | 2 — `012` (neither `/query` method exists in RFC 9610 §2 or draft-calendars-27 §4) and `025` (GraphQL: JMAP already has batching, back-references and a sync cursor). Both archived in `archived/`. |
| **Built by `sVOL`**                       | 18                                                                                                                                                                                                  |
| **Built elsewhere, pointed at from here** | 9 — `003`, `011`, `016`, `017`, `018`, `020`, `021`, `023`, `025`                                                                                                                                   |

### What it delivered

The volume was opened to answer one question — _for every noun, on every surface, can you
create, read, update and delete it?_ — and the honest summary is that it closed the two
columns it was built around and outlived its own framing of a third.

- **`Mailbox` stopped being immutable.** `004` landed `Mailbox/set` plus CLI verbs; the
  session had been advertising `mayRename`/`mayDelete` with no method behind them.
- **The MCP column went from 4 read-only analytics tools to 29**, including MCP's first
  writes — `013` (calendar + contacts), `014` (email read + triage, and deliberately **no
  send tool**), `015` (introspection). All routed through the JMAP method layer in-process,
  so DAV and the CLI mirror the same choreography rather than a second implementation.
- **The CLI column filled in** — `016` set the I/O contract, then `017`/`018`/`019` gave
  contacts, calendar and email triage full CRUD.
- **DAV became read-write at the collection level** — `009` (`MKCALENDAR`, extended `MKCOL`,
  collection `DELETE`) with `PROPPATCH` from `common/026`.
- **`FileNode` went from a proposed noun to a shipped one** (`011`) with a browser on top
  of it (`021`).
- **The WebUI stopped being hypothetical.** `readme.md` above still grades WebUI cells `E4`
  _"because the surfaces don't exist"_; `webmail/` now serves eight noun pages. That
  sentence is the single most-dated claim in this section and is left standing as evidence.

### What is genuinely still open — none of it a unit

The section is closable because every _unit_ is resolved, not because the matrix is full.
Five residues, all recorded where they live and none of them owned here:

1. **`Secrets × C/U × WebUI`** — `POST /vault/oauth/start` is still unserved. Half of this
   cell is an invariant, not a gap: raw-key create bounces to the CLI on purpose.
2. **`AddressBook`/`Calendar` collection C/U/D over MCP** — unfiled from the beginning, and
   §4 always said so.
3. **`021`'s visual confirmation** — the pages and their libs are tested; no human had
   looked at `/files`.
4. **Delivery status for `EmailSubmission`** — scoped and rejected as a separate `E3` in
   `005`, still unfiled, deliberately.
5. **`023`'s pre-ship ask** — `services/agent/src/vault.ts:124-131` still hand-rolls the
   `tokens ⋈ principals` join it was asked to fix first. It shipped anyway.

### The part worth learning from

**Zero units were outstanding, and the section did not know it.** The audit that closed this
found the work finished and the records wrong in every direction at once:

- **15 of 27 files never got their `✅`** (step 4a). Step 4b — updating `_index.md` — had
  mostly happened, so the two halves of one instruction diverged.
- **10 unit files still said `todo` or `deferred`** in their own Status line (step 3) while
  the ledger called them done.
- **`023` and `024` carried a "BLOCKED, not merely unstarted" banner** written _after_ both
  had shipped — `024` by four days, `023`'s server half by one.
- **Six grid cells understated what was built**, always in the direction of more work
  appearing to remain.
- **`_context.md` — the file step 1 calls ground truth — contradicted itself**, holding both
  _"there is no WebUI"_ and _"WebUI: a working mail client"_ four paragraphs apart. The
  commit that falsified the first added the second and deleted neither.
- **Every `_index.md:NN` line reference in a unit file is stale**, and most were stale
  before this pass — `_index.md` has been appended to a dozen times and every hand-written
  line number into it rotted silently. They are left alone rather than mass-corrected,
  because correcting them restarts the same clock. Cite section numbers, not line numbers,
  in a file you expect to grow.
- **`_verify.sh` asserted five things that were false.** It was built to _"decay loudly
  rather than rot quietly"_, and the assertions did decay correctly — but decay is only
  audible if something runs it, and nothing ever did. It needs a live `BM_TOKEN` against a
  deployed account and has no CI job.

The common cause is not laziness; it is that **every one of these records is updated by hand
by whoever shipped, and half these units were shipped by another section.** `024` closed as
`s07` T2 — that section's dev plan cites _"sVOL `024`"_ by number, correctly, and sVOL still
never learned. A cross-reference is only a link if something walks it.

**If this process is reused, the cheapest fix is not more discipline — it is making one of
these records derivable rather than asserted.** The filename `✅`, the ledger status column,
and the unit Status line are three hand-maintained copies of one fact.
