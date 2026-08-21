# s36 — the extraction ladder

*"Right now I think I have to forward the email and tell someone else to start
working on it."* — Eric, 2026-08-21

That sentence is the whole brief. A tournament email arrives carrying three
dates, a conditional payment, and a coach's contact details. Every one of those
is work the reader now does by hand, or delegates by forwarding. The ladder is
the machine doing the forwarding-and-explaining part, and handing back
something to approve.

---

## What already exists

More than it feels like. Before designing anything, the parts on the ground:

| piece | where | what it already does |
|---|---|---|
| `extract` pipeline | `services/agent/src/extract.ts` | one model call per DELIVERED message, opt-in per binding, budget-bounded |
| deterministic pre-filter | `EXTRACT_CUES` | skips the model entirely for mail with no commitment-shaped language |
| annotations | `annotation.ts`, `AnnotationMargin.tsx` | claims anchored to an object, rendered in the margin, with verbs |
| proposals | `actionProposal.ts` | `verb-schedule` EXISTS and writes a calendar event when approved |
| the decision | `ActionProposal/set` | approve / decline / needsInfo / correct-dueAt |
| the capability wall | `lib/approvals/accounts.ts` | a watch-only account SEES proposals and cannot decide them |
| cost | `invocationCost`, `priceMicros` | real per-invocation cost stamped against the binding's budget |
| injection posture | `bouncerClassify`, `extract.ts` | the message is DATA TO ANALYZE, never instructions to obey |

Measured against the real email (`Fwd: U12G White - Tournament Details`,
3,039 chars):

```
EXTRACT_CUES match: 'we will'      → it already qualifies for extraction today
date-ish tokens:    11             → Aug 21, 8:40 AM, Saturday, 8:00 am, 7:30 am,
                                      3:30 pm, 3:00 pm, Sunday
```

So the email would already reach the model. The model would find commitments
and ignore every timestamp, because that is what it is asked for. **The gap is
not the pipeline. It is what the pipeline is looking for, and what the reader
can do with the answer.**

---

## The rungs

Each rung only runs on what the rung below it passed. This is not an
optimisation detail — it is what makes "on every email" affordable enough to
mean it.

**0 — the bouncer.** Already there. Nothing below runs on mail that did not
pass it, which is also the first line against a hostile sender paying for our
inference.

**1 — cues (free).** A regex widened to date and event shapes as well as
commitment shapes. Conservative about SKIPPING, as today: a missed date costs
nothing, a model call on every receipt costs money. This rung is pure CPU.

**2 — is it an event? (cheap).** A small model, one call, answering a narrow
question over the message: which of these date-ish spans is an event the owner
would want, and what are its fields. Not "summarise this email".

**3 — the offer (structured).** What survives becomes an `ActionProposal`
carrying `verb-schedule`, pre-filled from the message — and, where the message
is thin, from a SEARCH over the mailbox (the previous tournament email, the
coach's earlier address). Prefill is evidence-gathering, not invention: every
field carries where it came from.

A rung the ladder deliberately does NOT have: nothing writes to the calendar
without a human. `verb-schedule` produces an offer; approval produces the event.

---

## Two surfaces, one machinery

**It is a second UI over the same data.** Both halves of that matter and they
pull in opposite directions.

*Second UI*: a genuinely different surface, designed as one, with its own
layout and its own idea of what the reader is doing. Not a re-skin of the
queue and not a shortcut into it.

*Same data*: there is exactly one proposal, one decision, one state. The
margin does not get a lighter copy, a local flag, or its own idea of what is
pending. If the two surfaces can ever disagree about whether something was
approved, the design is wrong.

|  | the queue (`/approvals`) | the margin (in the message) |
|---|---|---|
| the moment | "what needs me", batched, deliberately | "here, while I am reading this" |
| the context | the proposal, standing alone | the sentence that caused it, in place |
| what it is good at | clearing a backlog | judging a claim against its source |

Shared, and shared exactly once:

- **one proposal record.** The margin does not invent a lighter object. `+ Cal`
  in the margin is the same `ActionProposal` the queue lists.
- **one decision path** — `ActionProposal/set`. Approving in the margin and
  approving in the queue are the same write.
- **one capability wall.** `lib/approvals/accounts.ts` already refuses to offer
  `approve` on an account you can only watch. The margin asks the same function.
  A second surface that forgot this would be a privilege escalation with a nice
  animation.
- **one state.** Approve in the margin and the queue item is gone, because
  there was only ever one of them.

The margin's job is *judgment in context*; the queue's is *clearing what is
waiting*. Same record, different question being asked of the reader.

---

## The modelling change: span anchors

Annotations anchor to `(realm, objectId)` — a whole email. The design Eric drew
needs the date **highlighted where it appears**, which means anchoring to a
range inside the body.

Constraints that make this harder than an offset pair:

- the body is sanitised HTML, and the sanitiser rewrites it. An offset into the
  raw source does not survive into what is rendered.
- quoted trails, `maxBodyValueBytes` truncation and remote-image blocking all
  change lengths.
- the same message renders in the CLI, which has no DOM at all.

So the anchor should be **content-addressed, not positional**: the extracted
text plus enough surrounding context to locate it, and an occurrence index for
repeats. Re-anchoring is then a search in the rendered text, and a span that
cannot be found degrades to a whole-message annotation — the margin note still
appears, it simply is not highlighted. Never a crash, never a highlight over
the wrong sentence.

---

## Contingent commitments — the genuinely new part

> *If child is going (proxied via calendar addition) — you have to pay for
> registration (Venmo or Zelle) to coach.*

Nothing in the current model expresses this. It is not an annotation (not an
observation) and not a plain proposal (not independently actionable). It is a
**dependency between two proposals**: approving the calendar add is what makes
the payment real.

Design questions, unresolved and worth resolving deliberately:

- **Does the dependent become visible on approval, or is it visible-but-blocked
  from the start?** Hidden-until-triggered is tidier; visible-but-blocked is
  more honest — the reader sees the consequence before committing to the cause.
  Leaning honest.
- **What does declining the cause do to the dependent?** Withdraw it silently,
  or leave it as a decided-no with its reason?
- **How far does this go?** One edge is a feature; a general dependency graph is
  a workflow engine, and this should not quietly become one. Proposal: exactly
  one level, no chains, and revisit only with a second real example.
- **Payment is the sharpest edge in the product.** A proposal that says "pay the
  coach" must never be one approval away from moving money. The offer should
  end at a prepared, reviewable handoff — not a transfer.

---

## What this costs

Do not estimate it — **measure it**. `invocationCost` already stamps real cost
per invocation against the binding's budget, so a week with the binding on
answers this better than any arithmetic here.

For shape only, from the real email (~1,100 input tokens with the system
prompt, ~200 out), at ~100 emails/day with roughly a third tripping the cues —
about 900 calls a month, ~1M input and ~180K output tokens:

- a small Workers AI model: cents, and inside Cloudflare's free daily allocation
- a Haiku-class model: low single-digit dollars a month
- a Sonnet-class model: mid single-digit dollars a month

Treat those as orders of magnitude, not quotes. The ladder is what keeps it
there: rung 1 is free, rung 2 is small, and only what survives deserves a
better model.

---

## Order of work

1. **Widen the cues to dates and events.** Pure regex, no model, no UI. Lands
   alone and is measurable: how many messages newly qualify.
2. **Event extraction → `verb-schedule` proposal.** The verb and the approval
   path already exist; this is the extractor learning a second shape.
3. **Span anchors**, with whole-message fallback.
4. **The margin surface** — `+ Cal`, the prefilled popover, going through
   `ActionProposal/set` and `canDecide`.
5. **Contingent commitments**, only after 1–4 are real and only with the design
   questions above answered.

Signature → contact extraction is a sibling of 2 and can follow the same path
once it exists. It is not on the critical line.

---

## The test that matters

Not a unit test — a standing check on the real thing:

> Forward that tournament email to the mailbox with the ladder on. Two of the
> three dates should be offered. The offers should be approvable from the
> margin without leaving the message. Nothing should reach the calendar that
> was not approved. And the cost of the whole thing should be legible in the
> binding's ledger afterwards.

If any of those four is false, the rung that made it false is the work.
