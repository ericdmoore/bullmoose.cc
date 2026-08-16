# crm@ harvest — notes on people

**Status: design, not built.** Eric, 2026-08-16.

## What this is

> *"So this is just asking for agent help with this process."*

Eric already keeps notes on people, on his phone, **when he is high in
discipline**. The agent's job is not to be cleverer than that practice. It is to
do it on the days the discipline is not there.

That framing sets the bar, and it is a low one on purpose: success is that the
agent writes the sentence Eric would have written. Not a profile, not an
inference engine, not a taxonomy.

## The form, from Eric's own example

Someone mentions a three-year-old daughter. The note reads:

```
has daughter approx 3 year old as of 2026-08-16
```

Everything important about the design is already in that one line.

**It is anchored, not decayed.** The age is not stored as `3`. It is stored as an
observation *with the date it was made*, and the reader does the arithmetic —
two years on, she is about five, so you ask a five-year-old question. This is
the whole answer to half-life, and it needs no decay function, no confidence
score and no shelf-life field:

| note | how the anchor is read |
|---|---|
| `daughter approx 3 as of 2026-08` | evolves predictably — compute forward |
| `at Acme as of 2026-08` | the older it gets, the less you lean on it |
| `likes Thai as of 2026-08` | probably still true; the date says how stale |

One mechanism, three behaviours. **Anchor it and let the reader compute.**

**It is squishy — prose, not schema.** `dietary_preference: thai` would be wrong.
A schema requires anticipating every category worth remembering about a person,
and you cannot. And it is unnecessary: **the consumer is a model, so prose is a
fine encoding.** Structure is for readers that cannot read. (Same reasoning as
`help --json`: the flags needed a schema, the descriptions stayed English.)

**Hedges live in the sentence.** "approx" is doing real work, and it is doing it
in the prose rather than in a `confidence` column. Write it the way you would
write it for yourself.

**It is deliberately incomplete.** Eric's next question is *"how's your daughter —
what's her name again?"* The note never held the name, and that is fine. The bar
is not a complete record; it is **enough to ask a good question.**

## How it gets used: incorporation, not reconfirmation

> *"Less about reconfirmation, more about incorporation within existing
> activities. So emails and calendar activities will hopefully be bolstered by
> the extra context."*

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

1. Notice a durable fact in a message — *"my daughter just turned 3."*
2. Write the sentence, anchored, hedged, in plain language.
3. Link the source thread.
4. Surface it when next in contact with that person.

## Sensitivity is Eric's read, not a system field

An early draft of this design proposed classifying facts by use-class
(actionable vs contextual). **Rejected**, on Eric's correction: he can discern
sensitivity from the material, and a classifier would be wrong constantly and
wrong invisibly.

What the system owes him instead is the material itself — the **verbatim**, the
**date**, and the **source thread** — so the judgment is cheap to make. That is
also why verbatim matters more than a normalized fact for this class: *"I'm not
really practicing anymore"*, *"I left the faith"* and *"I'm not religious"* are
three different sentences about three different relationships to a thing, and
`religion: none` destroys exactly the information that governs how — or whether
— you would ever raise it.

> **Normalize what identifies. Preserve verbatim what discloses.**

Canonical form is right for addresses and phone numbers, where the variation
carries no meaning. It is actively harmful here, where the variation *is* the
meaning.

## The one risk that is actually new

A memory an LLM keeps changes what it says **to you**. These change what an agent
says **to third parties** — so a note can leak by being *used*, not by being
stored. "Picking somewhere vegetarian for Grace" discloses Grace's preference to
everyone on the thread. Trivial for food; not trivial for other things.

The containment already exists and is not new work: incorporation into a **draft
a human reads** is fine; incorporation into **unattended egress** is the
exposure. That is the line `replyMode` and the proposal tiers already draw.

## Failure mode, and why it is tolerable

A note Eric would not have written is a note he deletes in one second — and it is
plainly wrong *on its face*, because it is one sentence of plain language with a
date and a link. There is no scoring to audit and no schema to reverse-engineer.

Which is the argument for prose over structure a second time: the cheapest thing
to review is a sentence.

## Relationship to the other half

This is the **harvest** function. `dedupe.md` is the **janitorial** one — merging
duplicates, canonicalizing identifiers. They share a contact book and almost
nothing else:

|  | harvest | dedupe |
|---|---|---|
| operation | additive | destructive-ish (merge) |
| form | prose, anchored | canonical, structured |
| risk | disclosure by use | widening a governing book |
| bar | the sentence Eric would have written | never merge two people |
