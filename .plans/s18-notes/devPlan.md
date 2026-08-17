# s18 — Notes: one substrate, two faces

> Promotes the design stub (`readme.md`, 2026-08-13) into a buildable plan, and reconciles
> it with the conception s20 T4 grew independently. Written 2026-08-17, after the
> agent-offered Watch (s20 T1↔T4) shipped its behaviour *without* this substrate and proved
> exactly where the substrate is — and is not — needed.

## The reconciliation (read this first)

Two documents describe a thing called "Note", and they are not the same thing:

| | **s18 readme** | **s20 T4 prose** |
|---|---|---|
| author | a **human** | an **agent** (an extraction) |
| anchor | **none** — it is its own document | **`(message-id, span)`** — it annotates a sentence |
| class | none — freeform | **`commitment \| decision \| task`** + confidence |
| lifecycle | edited forever | extracted, then a correction loop |
| the "mention" | `@alice@othermoose.cc` — federates (readme §3) | `@remind`/`@watch` — creates a Watch from the margin |

The temptation is two entities. **Resist it — they are one entity with nullable fields**, and
seeing that is the whole design. A Note is *an authored, mutable, addressable body of text
that MAY anchor to a span of another object and MAY carry a class.* The differences above are
columns, not types:

- `author` — a **principal** (human) or an **agent binding** (extraction). The provenance
  split the whole codebase already draws (`last_writer_principal` vs `last_writer_binding`,
  s03.A T1).
- `anchor` — **nullable** `{realm, objectId, span?}`. NULL ⇒ a standalone note (the readme's
  private memo). Present ⇒ margin commentary (T4's extraction). The shape generalises T4's
  message-only anchor to the `{realm, objectId}` the proposal machinery already speaks.
- `class` — **nullable** `commitment | decision | task`. Absent on a human's freeform note;
  set on an agent's extraction (and settable by a human who wants to file one).
- `confidence` + `status` — the extraction's epistemics and correction state; NULL on a
  hand-written note, which is simply *true because you wrote it*.

**The one invariant that keeps this honest is per-author, not per-type:** an
**agent-authored note MUST anchor** (T4's anti-Clippy rule — "no comment without an object"),
while a **human-authored note need not** (it IS the object). Enforced at the write, not by
prompt discipline. This is why one table works: the guard is a `CHECK`-shaped rule over two
columns, not a reason to fork the noun.

Everything below builds this one entity, face by face. The faces ship in dependency order;
neither the readme's federation nor T4's rendering is on the critical path to the substrate.

---

## What already exists (so the plan doesn't re-derive it)

- **The Watch engine + the agent-offered Watch** (s20 T1, T1↔T4) shipped the *behaviour* T4
  is about — the agent notices a waiting-on and offers — as a **proposal**, deliberately
  without Notes. When T3 below lands, that detector's output becomes an anchored **Note**
  (class `task`) whose offered action is the existing `watch-offer` proposal. The proposal is
  the *action*; the Note is the *commentary that faces it*. They compose; neither replaces
  the other.
- **`trigger_on`** is a live vocabulary (`action-button | mailbox-delivery | rule-hook |
  schedule`); `mention` is the fifth (readme §2). Only `mailbox-delivery` is wired today
  (`services/ingest`), so `mention` is net-new dispatch.
- **`{realm, objectId}`** is the proposal subject/evidence shape (`emitProposal`,
  `actionProposal.ts`) — the anchor reuses it, adding an optional `span`.
- **The vendor capability** `urn:bullmoose:params:jmap:agent` already carries `Watch/*`,
  `ActionProposal`, `AgentInvocation`; `Note/*` rides the same seam. No new plane, no new
  auth model (readme §1).
- **s11 T5 is starved for extraction cost history** — T3 records cost per extraction, which
  is the data that also lets the Watch follow-up bodies stop being deferred.

---

## Tasks (in dependency order)

### T1 — The Note entity + `Note/*` JMAP · *the substrate*

**Files:** `packages/mailstore/sql/*.sql` (new `notes` table), `services/jmap/src/methods/note.ts`
(+ registry), `infra/migrations.mjs` (non-blocking, the `watches`-table precedent).

The `notes` table, control-plane (it is account-scoped agent plumbing, like `watches`):

```
id            TEXT PRIMARY KEY            -- n_<uuid>
account_id    TEXT NOT NULL REFERENCES accounts(id)
author_kind   TEXT NOT NULL              -- 'human' | 'agent'
author        TEXT NOT NULL              -- principal login, or binding name
body          TEXT NOT NULL              -- inline first (open-Q1); a blob path is a later column
anchor_json   TEXT                       -- NULL | {realm, objectId, span?}
class         TEXT                       -- NULL | 'commitment' | 'decision' | 'task'
confidence    REAL                       -- NULL | 0..1 (agent extractions only)
status        TEXT NOT NULL DEFAULT 'open' -- open | resolved | retracted | corrected
source_ref    TEXT                       -- provenance: the invocation/proposal that wrote it
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL
```

`Note/get|query|set` under the agent URN. `set` enforces **the invariant**: `author_kind='agent'`
⇒ `anchor_json` present; a human note may be either. Human edits bump `updated_at` (edited
forever, readme §1); an agent may not rewrite a human's note and vice-versa (the provenance
line). `query` filters by `class`, `status`, `anchor.objectId` (the person/time panels are
these queries — T4). Changes commit through `commitChanges` on a `Note` collection, exactly as
`Watch/set` does.

**Done when:** a human can `Note/set` a standalone note and edit it; an agent (via the bridge)
can write an anchored, classed note; and an unanchored agent note is *refused*, not stored.

### T2 — The anchor + margin rendering · *T4's face*

**Files:** `webmail/src/components/MessageView.tsx` (a gutter/rail — net-new, recon confirmed
none exists), a `lib/notes/` presentation module, a `Note` island.

Anchors bind to the **original** message-id + span; mail immutability is what makes this
tractable (readme's implicit premise, T4's second guard) — the same promised sentence in every
quoted reply renders a *reference*, never a duplicate. Collapsed gutter markers by default;
per-class visibility dials; a dismissal feeds repetition→policy so a class the human keeps
waving off quiets itself (T4). **The soft register is the epistemics** — an agent note reads as
"sounds like a thing to remember", a human note asserts; confidence is voice, not a number on
screen.

**Done when:** reading a message shows its anchored notes in the margin, class-styled, and an
empty rationale renders "Why: not stated" — never invented (T4).

### T3 — The extraction pass · *agent-authored notes, and where the Watch detector graduates*

**Files:** an extractor in `services/agent/src/` (a new cron pass beside `sweepWaitingOn`), a
`Note`-writing helper, cost capture reusing the s07 T5 stamp.

The pass reads new/changed mail and writes anchored, classed notes: a commitment you made
("I'll send the calc Friday"), a decision, a task. **Cost is recorded per extraction** — the
firehose-economics risk the readme names, and the history s11 T5 needs. **Corrections feed
back**: "not a commitment" is a labeled negative on the human-correction-wins loop (quarantine
rescues → Bayes, s12). The `sweepWaitingOn` detector folds in here: a waiting-on becomes a
`task`-class Note anchored to the sent message, and the `watch-offer` proposal becomes the
Note's offered action rather than a free-floating queue row.

**Done when:** an inbound "sounds like a promise" produces a `commitment` Note anchored to the
sentence, at a stated confidence, correctable in one click, and the correction is stored as
training data — not lost.

### T4 — The two views · *read models over the notes, uncertainty-first*

**Files:** `webmail/src/lib/home/` (the brief/home panels), a person-panel beside the open
message.

Two views only, because they are the two questions a chief of staff is *for*: **what am I
waiting on?** and **what did I promise?** Both are **queries over the notes table**, not new
stores — time-indexed (the s07 T0 brief), person-indexed (the panel beside Bob's mail:
"you told him $750; his load calc is overdue"). Every row carries `status`, evidence
objectIds, and confidence; the see-all drill-down survives as overflow.

**Done when:** the home brief answers both questions from note queries, and the person-panel
renders the commitments and waits involving whoever's message is open.

### T5 — The mention mechanic · *`@` as a trigger, and create-from-margin*

**Files:** mention parsing at `Note/set`, `mention` as the fifth `trigger_on`, dispatch in the
agent worker.

Parse `@name@domain` **once at write time** into a structured mentioned-principal ref — never
re-scraped at fire time (readme §2). **Fire once per (note, mention) pair** — the idempotence
discipline this codebase now has three of (s11 T9 period marker, s12 screening marker, the
Watch/waiting-on dedup). Same-instance mentions resolve the principal and fire directly. This
is also the margin's create door: `@watch`/`@remind` in a note anchored to a thread arms a
Watch from the margin (the door the s20 T4 prose promised, now real).

**Done when:** `@allen` in a note fires allen's binding once; `@remind by Friday` in a margin
note on a thread arms a Watch citing it.

### T6 — Federation · *mentions travel as email, because SMTP is the protocol we speak*

**Files:** outbound mention-stamping (the s12 outbound-stamping pattern), inbound
materialisation, the reply-above-the-line trimmer.

The readme §3 ladder, bottom-up: **reply-above-the-line (any client) → structured header +
share link (another bullmoose) → direct resolution (same instance)**. DKIM is the
authentication, already shipped (readme §3). **The §4 consent moment is load-bearing and not
optional**: quoting a private note's body into outbound mail IS the disclosure, stated in the
UI before send, un-revocable. An **agent** mentioning an external address is egress and hits
the governing book (s10 T1) unchanged — an agent cannot `@`-mention past its allowlist.

**Done when:** mentioning `@alice@othermoose.cc` sends a DKIM-signed mention mail; Alice's
reply-above-the-line comes back as her comment; and the consent line appeared before it sent.

---

## Sequencing

```
T1 substrate ──┬── T2 margin rendering ──┐
               ├── T3 extraction ─────────┼── T4 views
               └── T5 mentions ──────────┐│
                                         └┴── T6 federation
```

T1 gates everything. T2 (rendering) and T3 (extraction) are independent faces on T1 and can go
in either order — **T3 first** is the higher-value slice, because it turns the shipped
Watch-detector's proposals into anchored commentary and starts feeding s11 T5 cost history.
T4's views are queries, cheap once T3 populates the table. T5/T6 are the readme's federation
arc and ride last — the product is fully useful to a single household without them.

## Decisions needed

1. **The reconciliation itself** — one entity with nullable anchor/class (this plan's premise),
   or two? *Recommendation: one. The per-author invariant is the only real difference and it is
   a write-time check, not a schema fork. If a reviewer wants two, the cost is a second `Note/*`
   surface and a duplicated federation story for no capability gained.*
2. **Class vocabulary, and who may set it** — is `commitment | decision | task` closed? May a
   human file a note under a class, or is class an agent-extraction-only field? *Recommendation:
   closed for v1; human-settable (a human filing "this is a commitment" is the same correction
   loop, positive instead of negative).*
3. **Inline vs blob body** (readme open-Q1). *Recommendation: inline first; a note that needs R2
   is a document, and `/files` already is one.*
4. **Group mentions** (readme open-Q2). *Recommendation: forbid until the expansion is displayed
   — the s10 T1 transitive-widening hazard.*

## Out of scope

- Any grouping noun above the Note ("Situation"/Topic) — s20 T6 territory, deferred until the
  views prove demand.
- Rich-text/CRDT collaborative editing of a note body. Inline text, last-writer-wins on the
  human side; the federation comment thread (T6) is append-only, which sidesteps merge.

## References

- `readme.md` — the design stub this promotes (federation, mentions, access/consent)
- `.plans/s20-agent-native-ux/devPlan.md` T4 — the margin-commentary conception, and the
  shipped T1↔T4 agent-offered Watch this composes with
- `services/agent/src/{watches,waitingOn}.ts` — the engine + detector T3 graduates
- `services/jmap/src/methods/{watch,actionProposal}.ts` — the CRUD + proposal-effect precedents
- `docs/architecture/agent-integration.md` — `trigger_on` vocabulary; §4 grants
- `.plans/s12-boundary/outbound-stamping.md` — the header-carries-a-pointer federation pattern
