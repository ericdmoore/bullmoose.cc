# s18 — Notes and Annotations: two entities, one seam

> Promotes the design stub (`readme.md`, 2026-08-13) into a buildable plan, and reconciles it
> with the conception s20 T4 grew independently. Written 2026-08-17; **revised the same day**
> after Eric read the first cut and said the two things sound like _different types of
> entities_ — which they are. This plan builds two.

## The decision: two entities (resolved 2026-08-17)

The first cut of this plan tried to make one entity with nullable columns carry both "a private
note a human writes" and "an anchored margin-comment an agent makes about your mail." That was
the **exact shortcut the readme §1 warns against** — "a draft is just a note that's never
sent" — one level up: _these are shaped similarly, so make them one._ Applying the readme's own
discriminator (**does it have its own lifecycle and query needs?**) not against _Email_ but
against _each other_, they fail it — so they are two nouns, not one wearing a trench coat.

|              | **Note**                               | **Annotation**                                                 |
| ------------ | -------------------------------------- | -------------------------------------------------------------- |
| what it _is_ | a document **you author**              | a **claim about your mail** you adjudicate                     |
| anchor       | **none** — it stands alone             | **always** `{realm, objectId, span?}`                          |
| carries      | body, mentions                         | a **class**, a **confidence**, a **status** with a truth-value |
| verbs        | write, edit, @mention, share, federate | confirm, **correct**, dismiss, resolve                         |
| author       | a human                                | an **agent** (extraction) or a human (filing one)              |
| the loop     | edited forever                         | correction → training (labeled negatives, s12 Bayes shape)     |

The tell is the verbs. You don't _edit_ the agent's claim that you promised Bob the calc by
Friday — you **confirm it or say "not a commitment,"** and that correction is training data. A
Note you own; an Annotation you judge. It is also what Eric's **medium.com** metaphor already
encodes: a Medium _post_ and a _highlight-comment on someone's text_ are two objects with two
UIs. The metaphor separated them; so does this plan.

**The agent side does NOT fracture further** (resolved with Eric): a **Commitment** is _an
Annotation with `class: commitment`_, not its own entity. `commitment | decision | task` differ
only in _which view queries them_, and a view is a query, not a table. If commitments later grow
verbs of their own (snooze, mark-kept-vs-broken beyond the shared `status`), that is the moment
to split them out — not before.

### What the two share (plumbing, never semantics)

- the `@`-token **parser** — write-time, structured, once (readme §2). On a **Note** an
  `@mention` federates/shares; in an **Annotation**'s margin `@watch`/`@remind` arms a Watch.
  Same lexer, different dispatch.
- the **anchor shape** `{realm, objectId, span?}` — the Annotation reuses the proposal
  machinery's `{realm, objectId}` (`emitProposal`, `actionProposal.ts`), adding `span`.
- the **capability seam** — both `Note/*` and `Annotation/*` ride
  `urn:bullmoose:params:jmap:agent`. Two method families, one URN, no new plane, no new auth
  model (readme §1).

## What already exists (so the plan doesn't re-derive it)

- **The agent-offered Watch** (s20 T1↔T4, shipped) delivered T4's _behaviour_ — the agent
  notices a waiting-on and offers — as a **proposal**, deliberately without this substrate.
  When **A2** below lands, that detector's output becomes a `task`-class **Annotation** anchored
  to the sent message, whose offered action is the existing `watch-offer` proposal. The proposal
  is the _action_; the Annotation is the _commentary that faces it_. They compose.
- **`trigger_on`** is a live vocabulary (`action-button | mailbox-delivery | rule-hook |
schedule`); `mention` is the fifth (readme §2). Only `mailbox-delivery` is wired today, so
  `mention` dispatch is net-new (**N2**).
- **s11 T5 is starved for extraction cost history** — **A2** records cost per extraction, the
  same data that lets the Watch follow-up bodies stop being deferred.
- **Provenance** (`last_writer_principal` / `last_writer_binding`, s03.A T1) is the author split
  both entities reuse.

---

## The Annotation track · _higher value — it composes with shipped work and feeds s11 T5_

### A1 — The Annotation entity + `Annotation/*` JMAP · _the substrate_

**Files:** `packages/mailstore/sql/control-plane.sql` (new `annotations` table),
`services/jmap/src/methods/annotation.ts` (+ registry), `infra/migrations.mjs` (non-blocking,
the `watches`-table precedent).

```
id            TEXT PRIMARY KEY            -- an_<uuid>
account_id    TEXT NOT NULL REFERENCES accounts(id)
author_kind   TEXT NOT NULL              -- 'agent' | 'human'
author        TEXT NOT NULL              -- binding name, or principal login
anchor_json   TEXT NOT NULL              -- {realm, objectId, span?} — NEVER null (definitional)
class         TEXT NOT NULL              -- 'commitment' | 'decision' | 'task'
body          TEXT NOT NULL              -- the claim, in the soft register
confidence    REAL                       -- 0..1 (agent extractions); NULL when a human filed it
status        TEXT NOT NULL DEFAULT 'open' -- open | resolved (came true) | dismissed (the negative)
rationale     TEXT                       -- "why the agent thinks so"; NULL renders "not stated"
source_ref    TEXT                       -- the invocation/proposal that wrote it
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL
```

`Annotation/get|query|set`. **`anchor_json` is NOT NULL** — an unanchored annotation is a
contradiction (this is T4's anti-Clippy "no comment without an object", now enforced by the
schema, not by prompt discipline). `query` filters by `class`, `status`, and `anchor.objectId` —
the person/time views (A4) are exactly these queries. A human `set` **corrects**: it does not
rewrite the agent's `body`, it writes a new `status` (`dismissed`) + a labeled
signal, so history survives (the s12 rescue→Bayes correction shape). Changes commit through
`commitChanges` on an `Annotation` collection, as `Watch/set` does.

**Done when:** an agent (via the bridge) writes an anchored, classed annotation at a confidence;
a human corrects it in one write that records the negative without erasing the claim; and an
`anchor`-less annotation is _refused_.

### A2 — The extraction pass · _where the Watch detector graduates, and s11 T5 gets fed_ — LANDED (2026-08-17)

> **Built as a PIPELINE, not a cron sweep** (`services/agent/src/extract.ts`, `pipeline: "extract"`).
> The plan first said "a cron pass beside sweepWaitingOn"; a pipeline is better, and it is the
> point where the firehose-economics risk actually gets managed. A binding pipeline is **opt-in**
> (runs only for an account that provisioned an extract binding — it spends nothing until turned
> on), runs **once per delivered message** with the cost **stamped by the ordinary finish() path**
> (→ the per-extraction history s11 T5 was starved for), and is **budget-bounded** by the binding's
> s11 budget — three bounds inherited free from the drain. On top, a **deterministic cue pre-filter**
> skips the model entirely for a message with no commitment-shaped language (a newsletter is a free
> no-op), and the model output is parsed **defensively** (garbage → nothing; the injection posture
> is bouncerClassify's — the message is evidence, never instructions). The `sweepWaitingOn` detector
> graduated: it now also writes a deterministic `task` Annotation (confidence NULL — it is certain,
> not estimated) anchored to the sent message. 9 new tests. **DEFERRED, and it is genuinely Eric's
> call**: `provisionExtractor` (which model menu, and turning it on for a real account — the spend
> decision). The capability is inert until then.

**Files:** `services/agent/src/extract.ts` (the pipeline) + dispatch in `index.ts`, the
`sweepWaitingOn` graduation, cost capture reusing the s07 T5 stamp.

Reads new/changed mail and writes anchored, classed annotations: a commitment you made ("I'll
send the calc Friday"), a decision, a task. **Cost recorded per extraction** — the
firehose-economics risk the readme names, and the history s11 T5 needs. **Corrections feed
back** (A1's negative-writing `set`). The `sweepWaitingOn` detector folds in here: a waiting-on
becomes a `task` Annotation anchored to the sent message, and the `watch-offer` proposal becomes
that annotation's offered action rather than a free-floating queue row.

**Done when:** an inbound "sounds like a promise" produces a `commitment` Annotation anchored to
the sentence, at a stated confidence, correctable in one click, and the shipped waiting-on
detector emits its `task` annotation instead of a bare proposal.

### A3 — Margin rendering · _the medium.com surface_

**Files:** `webmail/src/components/MessageView.tsx` (a gutter/rail — net-new; recon confirmed
none exists), a `lib/annotations/` presentation module, an `Annotation` island.

Anchors bind to the **original** message-id + span; mail immutability is what makes anchoring
tractable — the same promised sentence in every quoted reply renders a _reference_, never a
duplicate. Collapsed gutter markers by default; per-class visibility dials; a dismissal feeds
repetition→policy so a class the human keeps waving off quiets itself (T4). **The soft register
is the epistemics** — confidence is voice ("sounds like a thing to remember"), not a number on
screen; a NULL rationale renders **"Why: not stated,"** never invented.

**Done when:** reading a message shows its annotations in the margin, class-styled, each with a
one-click correct/dismiss that writes the A1 negative.

### A4 — The two views · _read models over annotations, uncertainty-first_

**Files:** `webmail/src/lib/home/` (the brief/home panels), a person-panel beside the open
message.

Two views, the two questions a chief of staff is _for_: **what am I waiting on?** and **what did
I promise?** Both are **queries over `annotations`** (by `class`, `status`, `anchor.objectId`) —
time-indexed (the s07 T0 brief), person-indexed (beside Bob's mail: "you told him $750; his load
calc is overdue"). Every row carries `status`, evidence objectIds, and confidence; the see-all
drill-down survives as overflow.

**Done when:** the home brief answers both questions from annotation queries, and the
person-panel renders the commitments and waits involving whoever's message is open.

---

## The Note track · _the readme's original arc — a private document that federates_

### N1 — The Note entity + `Note/*` JMAP

**Files:** `packages/mailstore/sql/control-plane.sql` (new `notes` table),
`services/jmap/src/methods/note.ts`.

A Note **fails four mail concepts** (no recipients, no threading, no envelope, immutable-once-sent)
and **needs two mail lacks** (mentions, inline editing) — a different noun (readme §1). Standalone,
**no anchor, no class** — that is the whole distinction from an Annotation. `Note/get|query|set`;
human edits bump `updated_at`; inline body first (Decision 3). Do **not** model it as a
never-sent draft — that leaks into Apple Mail's Drafts and wants an invented mailbox role,
precisely the `quarantine`-role mistake s12 spent a day undoing (readme §1).

**Done when:** a human writes a standalone note and edits it; it never appears in a mail folder.

### N2 — The `@mention` mechanic · _`@` as the fifth trigger_

**Files:** the shared `@`-token parser, `mention` as the fifth `trigger_on`, dispatch in the
agent worker.

Parse `@name@domain` **once at write time** into a structured mentioned-principal ref — never
re-scraped at fire time (readme §2). **Fire once per (note, mention) pair** — the idempotence
discipline this codebase now has three of (s11 T9 period marker, s12 screening marker, the
Watch/waiting-on dedup). Same-instance mentions resolve the principal and fire directly. The
same parser powers the Annotation margin's `@watch`/`@remind` create door (shared lexer, A-track
dispatch).

**Done when:** `@allen` in a note fires allen's binding once; `@remind by Friday` in a margin
annotation on a thread arms a Watch citing it.

### N3 — Federation · _mentions travel as email, because SMTP is the protocol we speak_

**Files:** outbound mention-stamping (the s12 outbound-stamping pattern), inbound
materialisation, the reply-above-the-line trimmer.

The readme §3 ladder, bottom-up: **reply-above-the-line (any client) → structured header + share
link (another bullmoose) → direct resolution (same instance)**. DKIM is the authentication,
already shipped (readme §3). **The §4 consent moment is load-bearing:** quoting a private note's
body into outbound mail IS the disclosure — stated in the UI before send, un-revocable. An
**agent** mentioning an external address is egress and hits the governing book (s10 T1) unchanged.

**Done when:** mentioning `@alice@othermoose.cc` sends a DKIM-signed mention mail; her
reply-above-the-line comes back as her comment; and the consent line appeared before it sent.

---

## Sequencing

```
A1 annotation ──┬── A2 extraction ──┬── A4 views
                └── A3 margin ───────┘
N1 note ─────────── N2 mentions ───── N3 federation
                         │
        (shared @-parser, built in N2, reused by A3's margin @watch)
```

The two tracks are **independent after their substrates**. Lead with **A1→A2**: A2 graduates the
shipped waiting-on detector into annotations _and_ unblocks s11 T5's cost history — the highest
leverage in the plan. A3/A4 are the rendering and the queries on top. The N-track is s18's
original heart and is fully deferrable — a single household is completely served by the A-track
without ever federating.

## Decisions

1. ~~One entity or two?~~ **RESOLVED (2026-08-17): two — Note + Annotation** (Eric). See the
   opening section; the verbs diverge and the readme's own discriminator says two.
2. ~~Does the agent side fracture by class?~~ **RESOLVED: no** — a Commitment is an Annotation
   with `class: commitment`. Split only if commitment-specific verbs appear.
3. **Class vocabulary, and who may set it** — is `commitment | decision | task` closed, and may a
   human _file_ one? _Recommendation: closed for v1; human-fileable — a human filing "this is a
   commitment" is the same correction loop, positive instead of negative._
4. **Inline vs blob body** (readme open-Q1). _Recommendation: inline first; a note that needs R2
   is a document, and `/files` already is one._
5. **Group mentions** (readme open-Q2). _Recommendation: forbid until the expansion is displayed
   — the s10 T1 transitive-widening hazard._

## Out of scope

- Any grouping noun above these ("Situation"/Topic) — s20 T6 territory, deferred until the views
  prove demand.
- Rich-text/CRDT collaborative editing of a Note body. Inline text, last-writer-wins on the human
  side; the federation comment thread (N3) is append-only, which sidesteps merge.

## References

- `readme.md` — the design stub this promotes (the Note, mentions, federation, access/consent)
- `.plans/s20-agent-native-ux/devPlan.md` T4 — the margin-commentary conception (the Annotation),
  and the shipped T1↔T4 agent-offered Watch the A-track composes with
- `services/agent/src/{watches,waitingOn}.ts` — the engine + detector A2 graduates
- `services/jmap/src/methods/{watch,actionProposal}.ts` — the CRUD + proposal-effect precedents
- `docs/architecture/agent-integration.md` — `trigger_on` vocabulary; §4 grants
- `.plans/s12-boundary/outbound-stamping.md` — the header-carries-a-pointer federation pattern
