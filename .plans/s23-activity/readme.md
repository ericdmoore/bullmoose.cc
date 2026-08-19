# s23 — Activity · *what happened in my name while I wasn't looking*

**Status:** v1 LANDED 2026-08-18 (#185) — the `/activity` realm (quad-panel, decided-without-you
grouping, authority chain rendered per row). This note remains the design source for v2
(deeper provenance, policy-rule links). Originally written 2026-08-17 from Eric's ask:

> *"We may also need an AgentActivityLog — especially for things that I did not
> directly touch (delegated approval to CJ, or policy-based-approval rule, etc).
> That would be a new top-level nav section."*

## What it is

**The retrospective twin of `/approvals`.** Approvals asks *what needs me?*
Activity answers *what was decided without me, and on whose authority?*

That is the question a chief of staff creates by existing. Delegation is the
product working — the whole point is that you do not touch everything. But
delegation without a record is just a gap in what you know about your own
affairs, and it is the specific gap that makes people distrust an agent they
otherwise want.

## The substrate already exists — this is a read model, not a new table

The audit trail is written today, spread across eight tables. Nothing here
proposes new writes for the delegation case:

| source | what it records | Eric's example |
|---|---|---|
| `agent_invocations` | every agent run — `agent_proposals` is already **a read model over it** (data-plane.sql:431) | the agent acted |
| `agent_proposals.decision_json` | `{ by, reason, note }` — **the deciding principal** | *approved by CJ, not me* |
| `grant_audit`, `grant_lifecycle` | grant issued, narrowed, revoked | *delegated approval to CJ* |
| `binding_lifecycle` | binding enabled, disabled, rebound | |
| `book_membership_log` | governing-book changes | who an agent may write to |
| `responder_log` | automated replies sent | mail sent with no human in the loop |
| `agent_budget_overages.approved_by` | who authorised an overrun | |
| `quarantine_events`, `email_submissions` | shunts, and actual egress | |

**The key fact, verified rather than assumed:** `actionProposal.ts:1406` writes
`decision_json = { by: ctx.principal.username }` on every decision. So *"did I
approve this, or did CJ?"* is **already answerable from data on disk**. This
section is a view, and the repo's own architecture note is the precedent —
proposals are a read model over invocations, and *"if a hot path ever hurts,
materialize THEN, with the reconcile test materialization owes."*

## What does NOT exist

**Policy-based approval rules.** Grepped for it; there is no auto-approval
anywhere. Every approval today is a human clicking a row.

This matters for sequencing, and it cuts both ways:

- The log is **cheap now** (a read model) and worth having on its own.
- The log becomes **mandatory** the moment a rule can approve while you sleep.
  A rule that acts and leaves no legible trace is the tier-3 mistake of this
  whole design, and it is the failure this repo keeps finding in itself: a
  safety story resting on a premise ("a human saw it") that quietly stopped
  being true.

So: **build the log before the rules, never after.** If the rules land first
there is a window where the system acts on its own and the only record is a
`decision_json` nobody renders.

## Nav placement — and why that is an argument, not a detail

`lib/app/sections.ts` is explicit that the ORDER IS A CLAIM, and
`sections.test.ts` asserts it. Today:

```
approvals, agents    what needs me, and who is asking
calendar             what is about to happen
mail, contacts       the correspondence and the people in it
files                storage, deliberately NOT the front
search, settings     tools over the above
```

**Proposed: `approvals, agents, activity, …`** — the first cluster becomes
*what needs me · who is asking · what already happened*. Activity is
accountability, the same family as approvals, and it reads wrong anywhere
else: after `calendar` it looks like history-of-time; next to `settings` it
looks like a debug log, which is exactly the wrong frame for the record of
what was done in your name.

Open: whether it is `activity`, `record`, or `ledger`. **Not `audit`** — audit
is what you do to someone. And `ledger` already means the analyst@ spend
pipeline, so it would collide.

## Design stance

**Anti-star applies.** The human does not file, tag, or curate this. It is
generated wholly from events already written. There is no "mark as reviewed"
toggle — if a row needs attention it should be a proposal in `/approvals`,
not a chore in a log.

**Legibility over completeness.** Eight tables' worth of events dumped in one
stream is a syslog. The organising question is *whose authority did this run
on?* — mine, a delegate's, a standing rule's, or the agent's own binding. That
grouping is the product; the timestamp ordering is not.

**One honest omission up front:** these events live in *both* planes
(`grant_audit` is control-plane, `agent_invocations` is data-plane) and the
data plane is sharded per account. A single ordered feed across both is a
fan-in with no shared clock. First cut should be per-account and say so,
rather than implying a global ordering it cannot honour.

## Open questions for Eric

1. **Scope of "activity"** — only things you did NOT touch, or everything with
   your own decisions included? (Mine reads better as a filter over one feed
   than as two different pages.)
2. **Does it need to be actionable** — can you revoke a delegation or disable a
   rule *from* the log, or is it read-only and the doing happens in settings?
3. **Retention.** These tables grow forever. Does activity show all of it, or a
   window with an explicit "older than N" boundary?
4. `activity` vs `record` for the section id.

## Related

- [[s10-agents]] — proposals, bindings, the governing book
- [[s17-chief-of-staff]] — the delegation framing this serves
- [[s22-operator-surface]] — the operator's read of the control plane
- `.plans/s20-agent-native-ux` — the surface conventions this must not violate
