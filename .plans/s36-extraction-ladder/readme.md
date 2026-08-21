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

**3 — reconcile, then offer (structured).** What survives is checked against
what we ALREADY HOLD (see below) and becomes an `ActionProposal` — create,
update-with-a-diff, or nothing — pre-filled from the message — and, where the message
is thin, from a SEARCH over the mailbox (the previous tournament email, the
coach's earlier address). Prefill is evidence-gathering, not invention: every
field carries where it came from.

**Nothing here is triggered.** All three rungs run on delivery, unconditionally,
for any account with the binding on. By the time the message is opened the
offers already exist — the reader arrives to a decision, not to a button that
starts some work. There is no "analyse this email" verb and there should never
be one.

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

## Reconcile before offering

Eric, extending the design: *"see if I already have the data — event in the
calendar and offer to update it or create it; contact in a book and then offer
an update or create."*

This is the difference between this and every add-to-calendar button that ever
shipped. Those extract and offer. They do not LOOK FIRST, which is why they
produce duplicates, and why people stop trusting them after the second one.

So rung 3 gets a step before it. For each extracted entity, read what we
already hold, and produce one of three outcomes:

| we hold | offer | why |
|---|---|---|
| nothing | **create** | the ordinary case |
| the same thing, unchanged | **nothing at all** | see below |
| the same thing, differing | **update, carrying a diff** | the interesting case |

**The middle row is the one that matters most, and it is the one that is easy
to get wrong.** A forwarded thread, a re-read, a reply quoting the original —
all of these re-present facts already on file. The correct output is SILENCE.
An offer that says "create the tournament event" when the tournament is already
in the calendar is worse than no feature: it trains the reader to dismiss
without reading, and once they do that the good offers die with the bad.

**The diff is what makes an update reviewable.** "Update this event" is not a
decision anyone can make. `start 8:00 am → 7:30 am` is. The proposal must
carry the field-level change, and the margin must render it, or approval is
just assent to something unseen.

### Matching, and what to do when it is unclear

- **Contact**: the email address is a strong key. A name is a weak one — two
  people share a name and the wrong merge is hard to notice and harder to
  undo. Phone sits in between.
- **Event**: there is no natural key. Title similarity, start proximity and
  participant overlap together, none alone.

Where the match is ambiguous — two plausible candidates, a near-miss on time —
the answer is **not to guess**. `needsInfo` already exists as a decision
outcome, and this is exactly what it is for: the offer asks rather than
asserts. A wrong create is a duplicate and annoying; a wrong UPDATE overwrites
something true with something less true, and the reader may never find out.
The asymmetry should make us conservative in one direction only.

### What this needs that does not exist

- `verb-schedule` is **create-only** today: one tentative, free-busy-free
  event, nothing invited. There is no update path.
- `create-contact` exists as an apply case; `update-contact` does not.
- Neither carries a diff, because neither has ever needed one.

### The authority this widens — say it out loud

To reconcile, the extractor must READ the calendar and the contact books. That
is a real widening of what a mail-reading pipeline can see, and it should be
granted deliberately rather than acquired quietly:

- **read only.** Reconciliation needs to know what exists. It never needs to
  write; the write still goes through a human approval, as before.
- scoped to the account whose mail triggered it, and attenuated like every
  other grant — a binding that can read contacts to avoid duplicating them
  must not thereby be able to enumerate them for anything else.

If that trade is not worth making, the fallback is honest and cheap: offer
create-only and accept the duplicates. It is worse, and it should be chosen
knowingly rather than arrived at by not noticing there was a choice.

---

## The manual button is a bug report

The obvious design is a `+ Cal` affordance beside every date, which opens a
prefilled popover. That is the wrong default, and it took Eric one sentence to
say why:

> *if I hit "schedule" that's fine — BUT it means the extraction pipeline was
> sub-par.*

So the shape inverts. **The reader approves; the reader does not initiate.**

- Where the extractor found an event, the margin shows an offer that ALREADY
  EXISTS, with approve / decline. That is the path, and it should be nearly
  every path.
- Where the extractor found a date but did not claim it as an event, `+ Cal` is
  the fallback — and pressing it is a **labelled negative**, recorded exactly
  the way `Not a real one` already is for annotations. The extractor missed
  something the owner wanted, and now we know which sentence.
- Where there was no date at all, there is nothing. We do not decorate prose
  with affordances on the chance the reader wanted one.

This is the anti-star principle applied to a second thing: manual filing is the
old world. The agent notices; the human does not file. A `+ Cal` button on
every date is a star by another name — it moves the noticing back onto the
person and calls it a feature.

**The metric this creates is the honest one.** Manual-schedule rate IS the
extractor's miss rate, measured on real mail rather than a fixture. It should
fall over time, and if it does not, rung 2 is the work. A design where the
button is the feature can never produce that number, because every use looks
like success.

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

## V1 and V2

**V1 — the ladder, and the two things it can be right about.**

1. **Cues widened** to date and event shapes. Pure regex, no model, no UI.
   Measurable on its own: how many messages newly qualify.
2. **Signature → contact, create OR update.** Leads, because it is the most
   likely to be RIGHT. The key is exact (an email address), detection is
   substantially deterministic — `quote.ts` already splits a trailing `-- `
   block, and beyond that convention a signature is definitionally the block
   that REPEATS across a sender's messages — and the fields are largely regex.
   A model is needed only for the messy middle: telling a job title from an
   org name. Needs an email filter on `Contact/query`, which does not exist
   (today: `inAddressBook`, `kind`, `uid`, booleans) and is small and useful
   beyond this feature.
3. **Event creation.** `verb-schedule` already lands. Create only.
4. **Proposal idempotency**, from the first commit — see below.
5. **The margin UI**, built LAST, when "what does a good offer look like" is
   evidence rather than a guess.

**V2 — the two hard things.**

- **Proposed merges** for events (contacts do not need this — see 2).
- **Contingent commitments.**

### Why contacts lead and events follow

Events are the flashier demo. Contacts are the one more likely to be right,
and the payoff is the sharper one: *"Coach Wallace's number changed, update
it?"* is a thing no other mail client offers, and it makes the product feel
like it is paying attention rather than generating work.

Note the asymmetry that puts event MERGE in V2 while contact merge is in V1: a
contact has a natural key and an event does not. Nothing about events is
harder except identity.

### Proposal idempotency is V1, and is not reconciliation

Keyed on thread plus normalized start, refuse to create a second proposal for
the same extracted thing. No calendar read, no matching, no new authority.

This is not an optimisation. Extraction runs per DELIVERED MESSAGE, and a
thread is many messages that quote each other — the tournament email is a
`Fwd:` carrying the schedule in quoted text. Two replies that quote it produce
three identical offers for one tournament, on day one, without anyone
forwarding anything. That is the "trains you to dismiss without reading"
failure arriving immediately, and it costs one comparison to prevent.

### Merges as a proposal, not a matcher (Eric's idea)

> *proposed-merges could just be a different LLM proposal — created if the
> event-creation LLM had the context that we already had similar data in the
> calendar.*

Better than the deterministic matcher this plan first sketched, and safe for a
reason worth stating: **a proposed merge is not a write.** The objection to
fuzzy matching was silent overwrite — but every update lands as a diff a human
approves, so the model asserting identity is making a CHECKED claim. The
asymmetry that made us conservative disappears once nothing destructive
happens without review.

Two guardrails:

- the proposal must **name which event** it merges into and **show the diff**.
  "This looks like an update" is not reviewable; `start 8:00 am → 7:30 am` is.
- it must be able to decline to decide. Two plausible candidates is
  `needsInfo`, which already exists — the offer asks instead of asserting.

And a hybrid that keeps the ladder's economics: **narrow deterministically,
judge with the model.** Something must choose which events go into the context
window, and "every event in the calendar" is not a plan. A time window around
the extracted date plus participant overlap picks a handful of candidates for
free; the model decides among them. Cheap filter, expensive judgment only on
what survives — the same shape as every other rung.

Where an exact key exists, no model is involved at all: an `.ics` attachment
carries a `UID`, and a contact has an address. Those merge deterministically
in V1.

---

## Order of work

See the V1/V2 split above. Span anchors sit between (3) and (5): the margin
cannot highlight a date it cannot re-find, and a span that will not re-anchor
degrades to a whole-message note rather than highlighting the wrong sentence.

An earlier draft of this plan put signature extraction "not on the critical
line". That was wrong, and the reason is worth keeping: it is MORE
deterministic than event extraction, not less, so it is the cheapest rung that
produces something the owner would miss if it stopped.

---

## The test that matters

Not a unit test — a standing check on the real thing:

> Forward that tournament email to the mailbox with the ladder on. WITHOUT
> pressing anything, two of the three dates should already be offered by the
> time the message is opened. The offers should be approvable from the margin
> without leaving the message. Nothing should reach the calendar that was not
> approved. And the cost of the whole thing should be legible in the binding's
> ledger afterwards.

Then forward it a SECOND time. Nothing new should be offered, because nothing
new is true — and that silence is the harder half of the feature.

If any of those is false, the rung that made it false is the work. And if the
third date has to be added by hand, that is not a failure of the test — it is
the test producing its most useful output.
