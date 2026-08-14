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

### T1 — Watches · *the one new noun*

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

**Files:** new `packages/mailstore/sql/` side tables (the `agent_proposals` pattern: a
read model 1:1 over evidence, never a second store), an extractor pass in the agent
worker, home-view panels in `webmail/src/lib/home/`.

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

### T5 — Ask · *research over your own history*

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
loop needs the approvals/decline plumbing warm.

## Decisions needed

1. **Watch defaults** — the follow-up contract a bare star offers (+4 business days?
   draft-vs-notify?). *Recommendation: +4bd, draft — a draft in the queue costs nothing.*
2. **Extractor trigger** — every delivery, or batched in the cron sweep? *Recommendation:
   batched; the firehose-economics risk says start cheap and measure.*
3. **Does remind@ ship as a real provisioned agent or a routing alias into the Watch
   engine?** *Recommendation: alias first; promote if its conversational surface grows.*

## Out of scope

- The "Situation" durable object and any new grouping noun (readme: deferred until T4's
  views prove demand). Not "Thread," whatever it becomes.
- Gmail/Outlook connector mode (readme: company-sized, recorded tension).
- Monetization tiers; nav re-ordering (the shipped order is a tested claim — s07).
- Multi-human shared views (family Situations) — needs the grant model extended; after T4.
