# s20 — agent-native UX: dev plan

> **Status: design.** Ordered build for the verbs-first reorg. Companion to
> [`readme.md`](./readme.md), which records what was adopted and rejected and why.
>
> **Gate: T0 is not owned here.** The supply side — s03.D T2–T5 — is what makes every
> screen below non-empty, and it stays owned by s03.D. This plan sequences *after* it on
> purpose: re-nouning a UI over an empty queue produces a prettier Gmail, which is the
> exact failure the conceptual-reorg docs diagnose.

## Tasks (in dependency order)

### T0 — The supply side · *owned by s03.D, named here as the gate*

s03.D T2 (approval queue UI + bulk), T4 (the brief), T5 (repetition→policy), plus enough
agents actually producing proposals that the queue has traffic (bouncer FN/FP conversations
already do; crm@ dedupe proposals — s16 — are the natural second source). **Do not start
T2 below until a normal week produces a double-digit proposal count.** The metric is crude
on purpose; it is a supply gauge, not a KPI.

One reading note for s03.D T2, from readme principle 6: the queue screen it builds is the
**index and bulk surface**, not the sole venue of consent. Proposals are portable — they
also render and resolve on the object they would modify (a pending contact-field change
on the contact card, T4's comment pattern) and inline in the flow that produced them
(T6's sketch redlining). The queue holds what the human did not naturally encounter.
In-place approval writes the identical ledger rows.

### T1 — Watches · *the one new noun* — ENGINE LANDED (2026-08-15) · remind@ DOOR LANDED (2026-08-16) · DRAFT-ON-FIRE LANDED (2026-08-18, #196: watch-followup composes via the extract idiom, template fallback, applies both payload formats — the hold-tray wedge is dead)

> **Wave 1 built**: the `watches` table + migration, `services/agent/src/watches.ts`
> (the cron sweep — deterministic `deadline` and `no-reply-from` conditions, fire→proposal,
> guarded no-double-fire, fail-open on a missing table), and `Watch/*` JMAP CRUD
> (arm/cancel/list; a client cannot write `fired` — only the cron may; cancel is armed-only).
> A `no-reply-from` watch EXPIRES CLEAN when the reply arrives — being answered is silence,
> which is the whole trustworthiness of the feature. 18 tests.
>
> **Wave 2, slice 1 — the `remind@` mail-native door (LANDED)**: `services/agent/src/remind.ts`.
> CC or write `remind@<your-domain>` with a deadline in plain words and a Watch is armed on
> YOUR account (resolved from the sender), then confirmed by reply; when it comes due the
> Wave-1 sweep fires it into your approvals. It is a **real provisioned agent account**
> (Decision 3, resolved), `POST /remind` in the provision worker — structurally a slimmer
> bouncer (allowedSenders + governing book = the household humans; **no** persona/model, and
> **no** supervisory grant, because a fired reminder is a proposal on the ASKER's account,
> not remind@'s). Deterministic and model-free: the deadline is read by the SAME conservative
> parser ingest stamps `due_at` with (`extractDueAt`, moved to `@bullmoose/scheduling` so both
> surfaces share one definition of "by Friday"), and a request it cannot pin gets a teaching
> reply, never a guessed time. v1 arms a `deadline`/`notify` watch (a pure, reversible
> reminder — nothing egresses); `no-reply-from` via remind@ and agent-composed follow-up
> bodies are later slices. 8 + 3 tests.
>
> **Wave 2, still open**: the star on-ramp in webmail, the CLI surface, and drafting the
> follow-up BODY at fire time (v1 carries the intent; a model-composed draft waits on cost
> history, s11 T5). The proposal a fired watch produces flows through the same approvals
> machinery as everything else, and — because a follow-up targets a third party — the
> respond-only rule correctly routes it to the queue rather than sending.

**Files:** `packages/mailstore/sql/control-plane.sql` (new `watches` table),
`services/agent/src/watches.ts` (evaluation in the existing cron sweep),
`services/jmap/src/methods/` (CRUD), webmail + CLI surfaces.

A Watch is `condition + deadline + action + escalation`, and it is deliberately built from
parts that already run: the agent worker's 5-minute cron (the same sweep that runs
`escalateOverdue`), `due_at` semantics from s11, and the proposal machinery for anything
the action wants to DO.

- **Conditions, v1: deterministic only.** `no-reply-from(sender, since)`,
  `deadline(at)`, `no-message-matching(query, by)`. An LLM-judged condition ("tell me if
  the shipment won't arrive by Friday") is v2, and it enters as a *classifier over new
  mail* feeding the same deterministic state machine — never a free-running loop.
- **Firing produces a PROPOSAL, not an action.** "Draft a friendly follow-up" lands in the
  approvals queue like any other agent work. A Watch whose action is pure notification
  (severity: FYI) may skip the queue; anything that would touch the world may not. The
  s03.D tier rules apply unchanged.
- **The star becomes an on-ramp:** starring a message offers "watch this?" with a default
  contract (reply-by +4 business days → draft follow-up). The star itself keeps working —
  conservative nouns.
- **remind@ (`.backlog/reminders.md`) is this feature's mail-native face**: FWD to
  remind@ = create a Watch by email. One engine, two doors.
- Watches are rows with owner, provenance, and a fired/cancelled lifecycle — auditable in
  the console like everything else.

**Done when:** "if Sergio hasn't replied by Wednesday, draft a follow-up" works end to
end — created from webmail, CLI, or a FWD to remind@; fires from the cron; the draft
appears in the approvals queue citing the Watch; the Watch shows as fired.

### T2 — Verbs on mail · *radical verbs, familiar surface*

**Files:** `webmail/src/components/MessageView.tsx` (action bar), `AppShell.tsx`,
`services/agent` (intent → proposal pipeline).

The message view grows agent verbs beside Reply/Forward: **Answer** (agent drafts from
context), **Schedule**, **Watch** (T1's on-ramp), **Bring X into this** (the agent decides
forward vs. summarize vs. CC — the doc's best verb), **Delegate** (hand to a named agent;
CJ when s17 lands). Every verb compiles to an `AgentInvocation` whose output is a
*proposal* — the verbs are new doors into existing machinery, not new machinery.

- Reply/Forward/the full composer remain untouched. Prose is the escape hatch and the
  precision tool; the docs are explicit that removing it would be ideology.
- **Done when:** each verb produces a correct proposal in the queue with the source
  message as evidence, and declining one feeds the s03.D decline taxonomy.

### T3 — Compose → Intent · *the front door of writing*

**Files:** `webmail/src/components/Composer.tsx`.

The composer gains an intent mode — *"What do you want to happen?"* — that routes free
text through the same pipeline as T2's verbs: recipients → context → tone → draft →
send-policy, surfacing as a draft proposal the human edits or approves. One text box, two
modes, the classic editor one keystroke away.

**Done when:** "ask Sergio whether he's comfortable with me selling assembled boards —
supportive tone, no big commitment" yields an editable draft proposal with recipient and
tone resolved from the address book and history.

### T4 — Extracted views: Waiting-on and Commitments · *read models, uncertainty-first*

> **The T1↔T4 seam — agent-offered Watches (Waiting-on) — LANDED (2026-08-17)**, and it
> is the answer to "where we're going we don't need stars" (Eric). A star made YOU the
> classifier: notice, flag, come back. The sweep now does the noticing. `sweepWaitingOn`
> (`services/agent/src/waitingOn.ts`) scans your Sent mail for a QUESTION you asked that
> has gone unanswered past a silence window and emits a tier-1 `watch-offer` proposal —
> *"you emailed Sergio 4 days ago and haven't heard back; watch it and draft a follow-up if
> it stays quiet?"* Approving arms an ordinary `no-reply-from` Watch (the `applyProposal`
> effect in `actionProposal.ts`, undo = cancel it), which the T1 sweep fires; a reply that
> lands first closes it clean. Deterministic (a literal `?`, no model), dedup'd to one offer
> per thread ever (a decline sticks), no-fault to decline. **Deliberately separated from the
> rest of T4**: the recon confirmed the s18 Note substrate (the anchored `(message-id, span)`
> margin comment) is entirely unbuilt, and the offer needs none of it — it renders in the
> existing approvals queue. What remains below (the ambient Waiting-on/Commitments PANELS
> and the in-margin commentary) is the s18-dependent rendering, and stays deferred. The
> "never even confirm — just watch" variant is this same detector with the offer step
> removed: a policy flip to graduate to once the offer has earned trust.

**Files:** the s18 Note entity (agent-authored, anchored — see below), an extractor pass
in the agent worker, home-view panels in `webmail/src/lib/home/`, a margin-commentary
rendering in the mail view.

**The rendering and the store are one object: agent-commentary** (Eric, 2026-08-14 —
medium.com-style margin comments, composed with the s18 notes sketch). An extraction is
an s18 **Note** authored by an agent, carrying an anchor `(original message-id, span)`,
a class (commitment | decision | task), status, and confidence. The brief and the
person-panel are QUERIES over the commentary, not separate stores; the gutter, filtered
and time-ordered, is the agent-log with a human-readable face.

Why the margin is the right surface:
  * **In-situ provenance** — the claim renders at its birthplace, anchored to the
    sentence that produced it. "What does the system think I promised?" stops being an
    audit query and becomes something you trip over while reading. This supersedes the
    see-all drill-down as the primary auditability answer (the drill-down survives as
    the panels' overflow).
  * **The soft register IS the epistemics** — "sounds like a thing to remember" offers;
    a structured chip asserts. Voice carries confidence. Marginalia is also the
    chief-of-staff metaphor's native form: notes in the margin of the handed-back memo.
  * **Replying in the margin closes two loops** — "that's not a promise" is the labeled
    correction; and via s18's mention mechanic, "@remind — follow up Friday" in a reply
    CREATES a Watch from the margin. The comment thread is the conversational surface
    for the object it annotates.

Two guards, named because each failure mode is fatal:
  * **No comment without an object.** Every comment is the visible face of a durable
    artifact (commitment, watch, decision, proposal). Free-floating agent observations
    are banned by construction, not by prompt discipline — this is the anti-Clippy rule.
    Collapsed gutter markers by default; per-class visibility dials; dismissals feed
    repetition→policy so a class the human keeps waving off quiets itself.
  * **Anchors bind to the ORIGINAL message.** Mail immutability makes anchoring
    tractable (unlike editable-doc annotation, where anchors rot) — but the same
    promised sentence appears in every quoted reply. One anchor on the original
    message-id + span; quoted copies render a reference, never a duplicate comment.

Two views only, chosen because they answer the two questions a chief of staff is FOR:
*what am I waiting on?* and *what did I promise?*

- Every row carries `status: explicit | implicit`, evidence message-ids, and confidence.
  **An empty rationale renders as "Why: not stated"** — never invented. The system may
  offer *"worth remembering why?"* exactly once.
- **Corrections feed the extractor.** "Not a commitment" is a labeled negative riding the
  same human-correction-wins loop as quarantine rescues → Bayes. Without this, a wrong
  extraction is permanent embarrassment; with it, it is training data.
- **Cost is recorded per extraction** (tokens, model, per-message), because the readme
  names firehose economics as the standing risk and s11 T5 is starved for exactly this
  history.
- Rendered where they are NEEDED, which is three indexes and no nav item (Eric's question,
  2026-08-14: do these deserve their own surface? — answered: they are ANSWERS, not
  places):
    * **time-indexed** — the s07 T0 home view / brief ("you promised Sergio by Friday");
    * **person-indexed** — a context panel beside the open message: reading Bob's mail
      shows the commitments and waits involving Bob ("you told him $750; his load calc is
      overdue"). This is the conceptual-reorg readme's own strongest passage, and it is a
      panel in the mail view, not a destination;
    * **question-indexed** — Ask (T5), with citations, for "why did we choose X?".
  One concession to auditability: each panel gets a "see all N" drill-down — the
  inspection view, same rationale as the access log ("what does the system THINK I
  promised?"), same tier as Mail → All Messages. If usage shows people living in that
  drill-down, that is the noun earning nav, and only then.
- Tasks get NO user-facing surface: an agent-doable task becomes a proposal (already in
  the queue); a human-only task lands in the brief. A standalone Tasks pane competes with
  every todo app the user already ignores — the trichotomy stays internal.
- Decisions (the third candidate view) is deferred until these two prove the pattern; its
  capture moment ("worth remembering why?") ships as an inline affordance regardless.

**Done when:** the home view shows Waiting-on and Commitments with evidence links; a
correction updates the row AND lands a training label; extraction cost is queryable.

### T5 — Ask · *research over your own history* — v1 LANDED (2026-08-18, #197: the Finder realm — sessions + refinement chips, mail-only, agent-refinement seam marked for T5b)

**Files:** `webmail/src/pages/search.astro` (mode toggle), a conversational surface over
the **existing MCP tool layer** (`services/agent/src/mcp.ts`).

Ask is the first *internal* client of the s02 MCP surface — the "agent fact-finding"
purpose it was built for, pointed at your own account. "What did Sergio originally say
about commercial use?" becomes tool calls (search, email_get_body, calendar) with cited
answers; every access is authorized and audited by the machinery that already exists.

- Keyword search stays one toggle away — same conservative-nouns rule as the composer.
- Answers cite message-ids; an answer that cannot cite says so.
- **Done when:** a natural-language question over real mail returns a cited answer whose
  every read appears in the access log.

### T6 — Goals: the delegation contract, with an approvable plan · *the Situation question, resolved*

**Files:** `services/agent/src/jobNode.ts` (plan-proposal interception),
`services/jmap` (goal CRUD as a thin face over `jobs` rows), webmail goal view,
`services/agent` (contract enforcement is already attenuation + budget).

Eric's reframing (2026-08-14): the durable object the conceptual-reorg called a
Situation/Thread is not a CONTAINER of related stuff (about-ness — the storage-first
instinct, deferred) but a CONTRACT with done-ness: a **Goal** that decomposes into a
tentative workflow — several emails, follow-up watches, solicited feedback, a compiled
summary — **with approval checkpoints along the way**. This is the docs' own Delegation
primitive (Goal / may / may not / escalate when / done when), plus the piece the docs
missed: **the workflow sketch is itself an approvable artifact.**

The substrate landed with s11 T7 (jobs DAG, planner node, monotonic attenuation,
aggregate budgets), whose design already commits the key sentence: *"side-effectful
leaves still exit via /approvals — a Job reorganizes work, never its egress."* What this
task adds on top:

- **The plan-approval checkpoint — the new class.** Today approvals gate egress; this
  gates EXECUTION: the planner's decomposition lands as a proposal whose payload is the
  task list. Approve → tasks are created. Edit → the human redlines the workflow, and
  the decline taxonomy learns from the redline. Cheap by construction: the planner
  already emits the task list (`jobNode.ts`); this intercepts output that exists.
  **And the approval is INLINE, not a queue round-trip** (readme principle 6): the
  sketch is redlined in the conversation where the goal was expressed, and an edit that
  leaves nothing unresolved IS the approval — no second "…and do you approve?" after a
  hand-edit. An edit that leaves open questions is the needsInfo cycle, back to the
  planner. Either way the SAME proposal/decision/provenance rows are written as if it
  had gone through the queue — the venue moves, the ledger does not.
- **The contract IS the authority envelope.** may/may-not/escalate/done-when compile to
  the machinery that already enforces them: allowed tools and recipients, monotonic
  attenuation (a sub-task can never exceed the goal — proven by test), aggregate budget,
  and escalation as a Watch on the job itself.
- **Checkpoints thin by CLASS, not globally.** Early, everything stops for approval —
  the sketch, each email, the summary. repetition→policy graduates classes
  ("scheduling emails to direct reports auto-send") per the trust ladder. The goal view
  renders which checkpoint classes are still manual, because silently-widening autonomy
  is the one failure the whole product exists to prevent.
- **Milestones are derived.** A goal's timeline = its proposals + margin comments
  (T4's second grouping axis), time-ordered. Job status stays a view over its tasks —
  never store what can be derived.
- Naming: **Goal** (working). Not "Situation" (container connotations, deferred), not
  "Thread" (banned — collision), and "Topic" undersells it: topics have about-ness,
  this has done-ness.

**Done when:** "get three structural engineers willing to evaluate the attic" can be
expressed as a goal with a $750 bound; the planner's sketch appears in the queue and is
edited before approval; the resulting emails each appear as proposals; a join node's
compiled summary appears as the final proposal; the goal view shows progress and which
checkpoint classes have graduated to auto.

## Sequencing

```
s03.D T2–T5 (supply) ──────────┐  ← the GATE: owned there, watched here
                               ├─→ T2 verbs ─→ T3 intent
T1 watches (independent) ──────┤
                               └─→ T4 extracted views ─→ (later: Decisions view,
T5 ask (independent of all) ───────────────────────────    maybe a grouping noun)
```

T1 and T5 are independent of the gate and of each other — either is a safe first slice.
T4 is the most speculative and rides behind the supply side deliberately: its correction
loop needs the approvals/decline plumbing warm. T6 rides last: it composes T1 (watches as
job nodes), T2's verbs (Delegate is its on-ramp), T4 (milestones), and the s11 T7 DAG —
and its plan-approval checkpoint is only meaningful once approving things is a habit.

## Decisions needed

1. **Watch defaults** — the follow-up contract a bare star offers (+4 business days?
   draft-vs-notify?). *Recommendation: +4bd, draft — a draft in the queue costs nothing.*
2. **Extractor trigger** — every delivery, or batched in the cron sweep? *Recommendation:
   batched; the firehose-economics risk says start cheap and measure.*
3. ~~**Does remind@ ship as a real provisioned agent or a routing alias into the Watch
   engine?**~~ **RESOLVED (2026-08-16): a real provisioned agent account.** The alias
   never actually saved work — the invocation still has to run *somewhere* to parse the
   deadline and write the watch, and a dedicated account is what makes ONLY mail sent to
   remind@ mint an invocation (a `+remind` tag on a human's own box would fire a pipeline
   on every message they receive). It also inherits bouncer's safety composition for free:
   `allowedSenders` + a governing book bound who may use it and who it may confirm to. The
   conversational surface can still grow later without a migration — the account is already
   there. See `provisionRemind` / `POST /remind`.

## Out of scope

- The "Situation" durable object and any new grouping noun (readme: deferred until T4's
  views prove demand). Not "Thread," whatever it becomes.
- Gmail/Outlook connector mode (readme: company-sized, recorded tension).
- Monetization tiers; nav re-ordering (the shipped order is a tested claim — s07).
- Multi-human shared views (family Situations) — needs the grant model extended; after T4.
