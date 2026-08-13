# Decline taxonomy — the directed no-signal

> Design note for **`s03.D` T5** (Promote repetition to policy) and any future learning loop.
> The current enum is `REJECT_REASONS = { wrongContent, wrongAction, notNow }`
> (`services/jmap/src/methods/actionProposal.ts:53`). This note revises it, and records the
> one rule a learning pipeline must not break.

## The principle: a reason earns its place only if it changes what the agent does next

`decline` alone is a weak signal — *bad*, with no direction. `decline: low-quality` is barely
better: still a magnitude. The value of a reason is **directional** — it says *in which way*
the proposal was wrong, and each direction implies a different correction. The test for any
reason is exactly that: **does it steer the policy differently?** If two reasons imply the
same fix, they are one reason. If a "reason" implies no fix at all, it is not feedback.

## The revised set

| reason / verb | what it means | what it steers | is it negative feedback? |
|---|---|---|---|
| **`wrongContent`** | right target, wrong output — the reply was bad, the event details off | fix **generation**, keep the trigger | yes (generation) |
| **`wrongAction`** | wrong target — it should not have proposed this *kind* of thing at all | fix **selection / policy** | yes (selection) — the loudest, and should be **rare** |
| **`unsafe`** | it leaked private info, or made a commitment on the human's behalf | a **hard** negative, weighted heavily, never tolerated repeated | yes (safety — categorically separate) |
| **`tookItMyself`** *(action, not a reject)* | the proposal was **correct**; the human just handled it personally (already exists: edit-in-queue before self-send) | near-neutral-to-**positive** on selection | **no** |
| ~~`defer`~~ *(retired 2026-08-13 — never built)* | correct proposal, wrong *time* | the capability lives as **editing `due_at`** on the approval row (s11 T1), not a verb; queue-hiding is a view concern | n/a — nothing is recorded |
| **`needsInfo`** *(action, not a reject)* | possibly right, **insufficiently justified** — "help me understand why you need this" | **rationale** quality; shifts the burden of proof to the proposer | **no** (neutral on selection; *repeated* = chronic under-justification, a config fix) |

### `wrongAction` is the most useful, and rarity is the point
A well-configured agent rarely proposes the wrong *kind* of thing — so when it does, that is a
**policy bug worth catching loudly**, not routine noise. Frequent `wrongAction` means the
binding's trigger or persona is miscalibrated, which is a config fix (`s10-agents`), not a
per-proposal correction. Its rarity is what makes each occurrence high-signal.

### `needsInfo` — the verb that protects least privilege

The feeling it encodes, verbatim from the design discussion: *"I'm not ardently opposed — but
it's pushing against some principle I'm holding. Help me better understand why exactly you
need to do XYZ."*

It is a **third axis**, not a variant of anything above:

- `approve`/`decline` — judgment **rendered**.
- `defer` — judgment correct, timing wrong. **Time** resolves it.
- `needsInfo` — judgment **cannot yet be rendered**; the missing input is **information**,
  and it is the *proposer's* to supply. Time will not fix a `needsInfo`; an answer will not
  fix a `defer`. Different missing input → different verb.

Why it is load-bearing and not a courtesy: **approval fatigue is the enemy of least
privilege.** A binary approve/decline queue under fatigue degrades toward rubber-stamping —
when declining feels obstructive and approving is one click, over-granting is the path of
least resistance. `needsInfo` makes under-justification cost the **agent** a round-trip
instead of costing the **human** a risk. The burden of proof moves to the proposer, which is
exactly where least privilege wants it. The verb's *existence* reduces over-granting even
when it is rarely used, because agents learn (as prompt context) that thin rationales bounce.

It is sharpest on **`grant-request`** (s10 T3): "let me email X" met with "why X?" — and a
challenged-then-approved grant carries the strongest possible *why* in the provenance chain
(s10 T2): question, justification, approval. An audit that answers "why can `photos@` email
bob@?" with a recorded challenge and its answer beats silent assent by a mile.

**Mechanics** (all fields already exist on the proposal row):
- The action carries a required, human-authored `question`.
- Status `pending` → `info-requested`: it leaves the human's queue and becomes an **agent
  invocation** (costed — chronic `needsInfo` rounds show up in $/approved-action).
- The answer **appends** to `rationale`/`evidence` — never overwrites (the `editedPayload`
  discipline). The Q&A is part of the proposal forever.
- Re-surfaces in `/approvals` with the dialogue attached; `expiresAt` pauses while the ball
  is in the agent's court.
- One round per human action — the loop is human-paced by construction; an agent cannot spam
  re-answers into the queue.

**Naming:** `needsInfo` over "RFC" — RFC implies commentary from many parties; this is a
directed question with an owed answer. But the generalization RFC gestures at is real and
Space-shaped: a proposal *thread* where humans and other agents comment before a decision is
decision-first collaboration in its purest form. `needsInfo` is that thread's first, most
disciplined instance: exactly one question, exactly one owed answer, on the record.

### `notNow` is retired — it was a grab-bag
`notNow` conflated three different gradients under one label:
- *"I'll do it myself"* → **positive** on selection → now `tookItMyself`
- *"not due yet"* → **neutral**, a scheduling signal → now: edit `due_at` on the row (no verb)
- *"meh, later"* → weak negative → collapses into a real reject reason or a `defer`

Splitting it removes the ambiguity. What remained was never a *quality* judgment at all, which
is exactly why it read as confusing — the tell that it was mis-named.

## The rule a learning pipeline must not break

**`tookItMyself` and `needsInfo` are NOT negative feedback.** (And a corrected `due_at`
is not feedback at all — it is a field edit that records nothing.) If a pipeline trains
on *every* decline as a reject, it teaches the agent to stop proposing things the human
actually **wanted** proposed but chose to handle personally, that were simply early, or that
were right but under-explained. That is reward poisoning, and the taxonomy is the only thing
that prevents it — but only if the training side **excludes** the non-reject actions
from the negative signal. Write this into the loop as an invariant, not a footnote.

(`needsInfo` has one negative shadow, and it is not about selection: **repetition** of
`needsInfo` on one kind means the binding chronically under-justifies — a persona/template
fix in `s10-agents`, like repeated `wrongAction`. And repetition→policy applies: a question
the human keeps asking of one kind should be promoted *into that kind's proposal template*,
so the answer arrives front-loaded and the round-trip disappears.)

## The richest signal is not a decline reason at all

**Approve-after-edit** — the diff already retained (`editedPayload` never overwrites `payload`,
s03.D T1) — is a *labeled correction*: not "no, roughly why," but "yes, and here is exactly what
right looked like." It is the highest-information event in the system. Declines are the coarse
negative; the edit-diff is the precise one. A learning loop should weight the edit-diff above
any reject reason.

## How this feeds T5 (repetition → policy)

T5 promotes *repetition* to policy. The taxonomy makes "repetition" meaningful:
- Repeated **`wrongAction`** on one `kind`/subject → the agent keeps proposing something the
  human keeps refusing → the promotion is *"stop proposing this"* (an ingest rule / autonomy
  dial down).
- Repeated **`approve`** of one `kind`/subject → the s03.D T5 case as written → promote *toward*
  autonomy.
- Repeatedly **pushed-out `due_at`s** on one work class → not a policy signal about the
  agent; a *scheduling* signal that the class is chronically early — feeds `s11-scheduling`,
  not the autonomy dial. (Read from the due_at edit history, not from any verb.)

So the reason is not just per-proposal feedback; its **repetition** is the input to two
different promotions (autonomy vs scheduling), and mixing them up is the failure mode.

## Near-term: this is prompt context, not gradient training

Nobody fine-tunes a frontier model from one mailbox. The taxonomy pays off first as **prompt
context** — *"you proposed X; Eric declined it `wrongAction`; he does not want you doing that"*
is directly actionable with no training pipeline — and as **repetition→policy** above. The
gradient-training use is real but distant; retaining the reason and the diff is the requirement,
training is optional.

## References

- `services/jmap/src/methods/actionProposal.ts:53` — the enum's canonical home (to be revised)
- `webmail/src/lib/approvals/` — the decision surface (s07 T4)
- `.plans/s03.D-coexistence/devPlan.md` T5 — repetition → policy (this note's owner)
- `.plans/s11-scheduling/` — where `defer` becomes a real scheduling action
- `.plans/s10-agents/` — where frequent `wrongAction` is fixed (config), not per-proposal
