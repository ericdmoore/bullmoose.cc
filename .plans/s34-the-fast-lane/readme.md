# s34 — The fast lane · *a delegate who can call the easy ones, and the evidence to widen her*

> **Status: DESIGN — from the 2026-08-20 conversation. Nothing built.**
> Depends on [[s30-the-edit]] T2 for its measurement layer, and inherits
> [[s31-rules-ladder]]'s rung-3 pattern wholesale.

## Where this came from

Eric, on why CJ exists at all:

> *"CJ NEEDS to be able to handle the easy things. That is arguably her main
> point. She's always awake and the simple things, or even small
> but-reversible-risks she can have some autonomy in making a call FAST. That
> is one of the reasons WHY she exists."*

And on how her authority should grow:

> *"When she starts — I will watch what she does — in the same way when you and
> I started I approved all your Actions. But now that we have proven we work
> well together, it's easier for me to let you run in your own auto-approve
> lane. I have the same hopes for CJ."*

**The latency IS the product.** A delegate who must wake the principal for
every small reversible thing is not staff; it is a pager with better prose.
Any design here that optimises purely for caution has removed the reason the
delegate exists. That is the failure this note is written against — not the
opposite one.

## The distinction that keeps this safe, taken from Eric's own account

Read the second quote again. Eric *watched*, formed a judgement, and **then**
widened the lane. The agent did not widen it. Nothing auto-promoted anyone when
a success rate crossed a threshold.

So: **the evidence accrues; the authority is given.** That is not a caveat on
the trust model — it *is* the trust model, described from the inside.

What [[s31-rules-ladder]] rung 3 rules out is not a delegate becoming
autonomous. It is a delegate becoming autonomous **without the principal
deciding she should** — on a rule nobody wrote, discovered afterwards. Its
words apply here unchanged: *graduated standing authority, **given, never
accrued**, rendered visibly, and revocable.*

Costs nothing at runtime. It is the whole difference between a delegate and a
drift.

## What already exists (verified, 2026-08-20)

| capability | where |
|---|---|
| An agent can ASK the queue for capability | proposal kinds `budget-overrun`, `floor-request` — an agent at a limit files a proposal instead of failing or self-granting |
| The "can't decide yet" cycle | `status='info-requested'` + `question` + `amendments_json` (append-only rounds) + `expires_remaining_ms` — **the expiry clock banks while waiting**, so asking does not burn the window. data-plane.sql:607 calls it *"the third verb"* |
| Risk stratification | tiers 1/2/3 — reversible / retractable / irreversible — plus the hold tray |
| Delegation | supervisory grants; `decision_json = { by: ctx.principal.username }` (actionProposal.ts:2152) records who actually decided |
| The record | `/activity` shipped 2026-08-18 (#185): decided-without-you grouping, authority chain per row |

**Eric's step 3 is already built.** The needsInfo → answer → re-decide cycle
needs no new machinery.

And [[s23-activity]]'s sequencing argument — *build the log before the rules,
never after* — is now **satisfied**. The log landed first. This is on time, not
early.

## What does not exist

**1. No agent can decide anything.** Grepped again today: there is no
auto-approval anywhere in `services/` or `packages/`. Every approval is a human
clicking a row. CJ approving or declining — even the most trivial tier-1 item —
has no implementation at all. This is the gap.

**2. No decider-of-record.** The subtle one. The queue is a *set*, not an
*assignment*: nothing on a proposal says whose call it is. Consequences:

- *"CJ looked and could not decide"* is **indistinguishable from** *"nobody has
  looked yet."*
- CJ escalating to the human is not a transition — the row never changes hands,
  because it never had hands.
- `/activity` cannot render *"escalated by CJ, and here is why she was stuck"*,
  because no hand-off event exists to render.

The spine of the whole flow is a **change of decider**, and that is the column
the schema does not have.

**3. No aggregate performance signal.** See T1 below — and [[s30-the-edit]].

## The build

### T1 — the proving lane

CJ decides at full speed, and for a bounded period her decision is recorded as
*what she would have done* while the item still routes to the human. The
principal sees her call and their own, side by side.

This is Eric's own process — watch, then widen — except **generated
deliberately in days rather than incidentally over months**, and it yields the
concrete artifact the grant conversation needs: *here are 200 decisions, here
is where she and you diverged, and here is the shape of the disagreement.*

The divergences are the product of this rung, not the agreements.

### T2 — the lane itself, scoped by reversibility

Eric said *"small but-reversible-risks."* That is **tier 1** — the schema
already stratifies exactly the way the instinct does. So the lane is not new
machinery; it is a scope on a delegate: **which tiers, for which kinds, under
which book.** Tier 1 for CJ on day one is a defensible default and is
expressible with what exists.

**Bounded by attenuation, which is not extra caution but the existing rule.**
`nodeAuthority.test.ts:332` — *"CROSS-BINDING chains fold to the NARROWEST
binding they pass through."* CJ approving Allen's grant request is CJ widening
*someone else's* authority, so it must be bounded by her own. A delegate who
can grant what she does not hold is a privilege-escalation ladder wearing a
chief-of-staff hat. This is what keeps a fast lane from becoming one.

### T3 — the decline surface

A quiet *approve* and a quiet *decline* fail differently. A quiet approve
widens what happened, and the log catches it. A quiet decline means Allen is
blocked and **nothing appears anywhere except an absence** — the more insidious
failure, and the one that turns a delegate into a silent bottleneck on her own
principal's agents.

Per-item notification is just a slower pager and defeats T2. The right
property is weaker and better: **no decline is invisible in aggregate.** The
principal must never have to wonder whether CJ has been quietly blocking
something for a week.

### T4 — decider-of-record and escalation

The missing column, plus the transition that uses it. Escalation carries CJ's
*reasoning* — the trade-offs that stalled her — because a re-queued item with
no rationale is strictly worse than one that was never triaged: it costs the
human the read AND tells them nothing.

## Dependency worth stating plainly

**[[s30-the-edit]] T2 is the measurement layer for this section.** What made
Eric comfortable widening the lane was watching work over time. The product
cannot currently produce that evidence: the diff on an edited proposal is
computed **for display only** (`ApprovalsQueue.tsx:899`) and never stored, so
*"which agent gets edited most, and always in the same field?"* is unanswerable.

That question is precisely the instrument for deciding whether CJ has earned a
wider lane. Without it, the grant is decided on vibes — which worked once, for
one agent, and does not scale to a staff of them.

## Open questions

1. **Does the proving lane end on a date, a count, or a judgement?** A count is
   measurable and gameable; a judgement is honest and never happens. Leaning
   count-as-trigger, judgement-as-decision.
2. **What is CJ's risk estimate made of?** [[s33-assurance-ladder]] supplies
   *how sure are we who is asking*, which is one input, not the whole of it.
3. **Can CJ escalate to another delegate**, or only upward to a human? Delegate
   chains are where attenuation stops being obvious.
4. **What happens to the fast lane when CJ is wrong once?** A single bad call
   should not silently revoke the grant — nor should it be ignored. Probably a
   proposal: *"this went badly; narrow the lane?"*
5. Is the proving lane **per delegate** or **per (delegate, kind)**? The latter
   is more honest — being good at unsubscribes says nothing about grants.

## Related

- [[s30-the-edit]] — the measurement this needs; T2 is a hard dependency
- [[s31-rules-ladder]] — rung 3 is this pattern, for filtering rules
- [[s33-assurance-ladder]] — one input to the risk estimate
- [[s23-activity]] — the log, landed #185; its ordering argument is satisfied
- [[s17-chief-of-staff]] — why a delegate exists at all
- [[s10-agents]] — tiers, bindings, the governing book, attenuation
