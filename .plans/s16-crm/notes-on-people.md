# crm@ harvest — notes on people

**Status: design, not built.** Eric, 2026-08-16.

## What this is

> _"So this is just asking for agent help with this process."_

Eric already keeps notes on people, on his phone, **when he is high in
discipline**. The agent's job is not to be cleverer than that practice. It is to
do it on the days the discipline is not there.

That framing sets the bar, and it is a low one on purpose: success is that the
agent writes the sentence Eric would have written. Not a profile, not an
inference engine, not a taxonomy.

## The core move: write down the thing that stays true

> _"People talk in terms of 'how old', but if you transform to rough DOB then
> you have a permanent fact. So often times it's just looking for these little
> transforms for fact writings."_

This is the mechanic, and it is one sentence: **find the invariant behind what
was said, and write that down instead.**

"My daughter is 3" is a derived, decaying fact. **Born ≈ 2023** is permanent.
Once the transform is done nothing decays at all — age is computed on demand,
forever, and there is no staleness arithmetic because there is no stale fact.

| what they said                         | what gets written      |
| -------------------------------------- | ---------------------- |
| "my daughter is 3"                     | `daughter born ≈ 2023` |
| "we just had our 10th anniversary"     | `married ≈ 2016`       |
| "I've been at Acme five years"         | `joined Acme ≈ 2021`   |
| "I turn 40 next month"                 | `born ≈ Sept 1986`     |
| "my son starts kindergarten this fall" | `son born ≈ 2021`      |

### Two properties that follow, and they are the argument for doing it this way

**Invariants look forward; observations only look back.** `daughter born ≈ 2023`
lets an agent notice _she turns 5 next month_. `daughter 3, as of two years ago`
can only ever be recalled. That is the difference between remembering and being
useful ahead of time — and it is most of the value.

**Invariants sharpen; observations only stale.** `born ≈ 2023`, plus a later
"her birthday's in March", refines to `≈ March 2023`. Evidence accumulates into
precision. A decaying fact only accumulates error.

### Where there is no invariant to find

Some statements have no constant underneath — "likes Thai food" is a preference
that may simply change. The transform still applies, one level down: **the
statement-event is itself invariant.** `said they like Thai, Mar 2026` stays
permanently true even if the preference does not.

So it is one rule, applied at whatever depth it lands:

> **Find the thing that will not change, and write _that_ down.**

Sometimes that is a birth year. Sometimes it is only "they said this, then."
Either way what gets stored never needs revisiting.

**This makes the harvest function's real work clear: it is not transcription, it
is noticing the transform.** Someone says a relative thing; the note records the
absolute one behind it. An agent that merely quotes the email has done the easy
half.

## The form of a note

Everything else about the shape is in Eric's own phone-note habit.

**Squishy — prose, not schema.** `dietary_preference: thai` would be wrong. A
schema requires anticipating every category worth remembering about a person, and
you cannot. It is also unnecessary: **the consumer is a model, so prose is a fine
encoding.** Structure is for readers that cannot read. (Same reasoning as
`help --json`: the flags needed a schema, the descriptions stayed English.)

**Hedges live in the sentence.** `≈` and "approx" do real work, in the prose
rather than in a `confidence` column — and they survive the transform cleanly,
because "born ≈ 2023" is an honest write when you genuinely do not know the
month, not an apology.

**Deliberately incomplete.** Eric's next question is _"how's your daughter —
what's her name again?"_ The note never held the name, and that is fine. The bar
is not a complete record; it is **enough to ask a good question.**

**Provenance, always.** Which message, and the verbatim where it matters. That is
what makes a note cheap to judge and cheap to overturn.

## How it gets used: incorporation, not reconfirmation

> _"Less about reconfirmation, more about incorporation within existing
> activities. So emails and calendar activities will hopefully be bolstered by
> the extra context."_

Notes are not a field anyone queries. They are **context at the point of
action** — drafting to Grace, or scheduling with Grace, pulls Grace's notes into
the prompt. Lunch lands somewhere Thai, or at least vegetarian, without anyone
having asked for that.

It is the same pattern as an LLM writing a memory, scoped to a contact rather
than a session — Eric's own analogy.

And the note is an **input to judgment, not a substitute for it**: the note plus
Eric's own life ("given my kids' experience") produces the Bluey question. The
agent's version of that is the same shape — note plus context, then a suggestion
a human sends.

## What crm@ actually does

1. **Notice** a fact worth keeping in a message — _"my daughter just turned 3."_
2. **Transform** it to the invariant behind it — `daughter born ≈ 2023` — or, if
   there is none, to the statement-event: `said X, Aug 2026`. This is the step
   that carries the value, and the step an agent can actually help with; steps
   1, 3 and 4 are bookkeeping.
3. **Link** the source thread, verbatim where the wording matters.
4. **Surface** it at the point of action — drafting or scheduling with that
   person — and, where the invariant permits, _ahead_ of it: she turns 5 next
   month.

## Sensitivity is Eric's read, not a system field

An early draft of this design proposed classifying facts by use-class
(actionable vs contextual). **Rejected**, on Eric's correction: he can discern
sensitivity from the material, and a classifier would be wrong constantly and
wrong invisibly.

What the system owes him instead is the material itself — the **verbatim**, the
**date**, and the **source thread** — so the judgment is cheap to make. That is
also why verbatim matters more than a normalized fact for this class: _"I'm not
really practicing anymore"_, _"I left the faith"_ and _"I'm not religious"_ are
three different sentences about three different relationships to a thing, and
`religion: none` destroys exactly the information that governs how — or whether
— you would ever raise it.

> **Normalize what identifies. Preserve verbatim what discloses.**

Canonical form is right for addresses and phone numbers, where the variation
carries no meaning. It is actively harmful here, where the variation _is_ the
meaning.

## The one risk that is actually new

A memory an LLM keeps changes what it says **to you**. These change what an agent
says **to third parties** — so a note can leak by being _used_, not by being
stored. "Picking somewhere vegetarian for Grace" discloses Grace's preference to
everyone on the thread. Trivial for food; not trivial for other things.

The containment already exists and is not new work: incorporation into a **draft
a human reads** is fine; incorporation into **unattended egress** is the
exposure. That is the line `replyMode` and the proposal tiers already draw.

## Failure mode, and why it is tolerable

A note Eric would not have written is a note he deletes in one second — and it is
plainly wrong _on its face_, because it is one sentence of plain language with a
date and a link. There is no scoring to audit and no schema to reverse-engineer.

Which is the argument for prose over structure a second time: the cheapest thing
to review is a sentence.

## Relationship to the other half

This is the **harvest** function. `dedupe.md` is the **janitorial** one — merging
duplicates, canonicalizing identifiers. They share a contact book and almost
nothing else:

|           | harvest                              | dedupe                    |
| --------- | ------------------------------------ | ------------------------- |
| operation | additive                             | destructive-ish (merge)   |
| form      | prose, anchored                      | canonical, structured     |
| risk      | disclosure by use                    | widening a governing book |
| bar       | the sentence Eric would have written | never merge two people    |
