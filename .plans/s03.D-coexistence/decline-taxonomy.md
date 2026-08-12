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
| **`defer`** *(action, not a reject)* | correct proposal, wrong *time* — re-surface later | **scheduling**, not quality (see `s11-scheduling`) | **no** |

### `wrongAction` is the most useful, and rarity is the point
A well-configured agent rarely proposes the wrong *kind* of thing — so when it does, that is a
**policy bug worth catching loudly**, not routine noise. Frequent `wrongAction` means the
binding's trigger or persona is miscalibrated, which is a config fix (`s10-agents`), not a
per-proposal correction. Its rarity is what makes each occurrence high-signal.

### `notNow` is retired — it was a grab-bag
`notNow` conflated three different gradients under one label:
- *"I'll do it myself"* → **positive** on selection → now `tookItMyself`
- *"not due yet"* → **neutral**, a scheduling signal → now `defer`
- *"meh, later"* → weak negative → collapses into a real reject reason or a `defer`

Splitting it removes the ambiguity. What remained was never a *quality* judgment at all, which
is exactly why it read as confusing — the tell that it was mis-named.

## The rule a learning pipeline must not break

**`tookItMyself` and `defer` are NOT negative feedback.** If a pipeline trains on *every*
decline as a reject, it teaches the agent to stop proposing things the human actually **wanted**
proposed but chose to handle personally, or that were simply early. That is reward poisoning,
and the taxonomy is the only thing that prevents it — but only if the training side **excludes**
the two non-feedback actions from the negative signal. Write this into the loop as an
invariant, not a footnote.

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
- Repeated **`defer`** → not a policy signal about the agent; a *scheduling* signal that this
  work class is chronically early — feeds `s11-scheduling`, not the autonomy dial.

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
