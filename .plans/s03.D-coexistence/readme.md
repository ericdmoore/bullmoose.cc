# s03.D — Co-existence: the multiplayer layer

> **Slice of the s03 web-access arc.** Shared context:
> [`../s03-webAccess/readme.md`](../s03-webAccess/readme.md) ·
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §4–5.

## Why this exists

This is the slice where the product stops being a webmail and becomes **the thing the
arc is actually about**: a world where mail is triaged by helpers before you have to deal
with it at all.

Everything before it is table stakes — a mail client, a file store, attributable writes.
This is the differentiator, and it has no prior art to copy: shared-inbox products solved
human²; none of them solved human+agent.

## What it ships

- **Approval queue** — drafted replies, unsubscribes, events, threads, contacts, file
  organization, **and permission requests**, in one surface.
- **Ownership & collision** — "Allen is drafting", "handled by Emily, awaiting you".
- **Today / Tomorrow brief** — one server-computed artifact, rendered natively *and*
  mailed by Allen for clients that can't show it.
- **Promote-repetition-to-policy** prompts.

## The load-bearing ideas

**Promote repetition to policy** — the arc's through-line, and the mechanism by which
every queue empties itself:

| Repetition | Promoted to |
|---|---|
| approve the same unsubscribe 20× | raise the autonomy dial for that action class |
| approve the same A2A request 3× | write an `autoGrant` template |
| bulk-apply the same filter | create an ingest rule |

**Graduation eligibility = reversibility.** Tier 1 (reversible) may graduate; tier 2
(retractable) graduates only into a visible hold tray; **tier 3 (irreversible) never
graduates.** Policy is the UI's opinion — the capability wall is the guarantee, and
agents already lack `send`.

**The failure mode to design against:** if 40 items a day land in the queue, we moved the
work instead of removing it. Every feature here is justified by whether it shrinks the
queue.

## Depends on

**s03.A** (provenance) · **s03.C** (these surfaces render in that shell) ·
**s03.B** only for the file-organization proposal kind

## Blocks

Nothing. s03.E is independent of this slice (it depends on s04).

## Acceptance

1. An agent run produces a `pending` proposal carrying rationale **and** evidence.
2. A day's output (~40 items) is dispatchable in a couple of gestures.
3. A tier-2 approval lands in a hold tray and can still be yanked before commit.
4. A tier-3 proposal cannot be auto-committed — by policy *or* by bulk action.
5. `notNow` records as a snooze and does **not** decrement the agent's autonomy signal.
6. The brief's UI and email renderings come from one artifact and agree.

## Out of scope

Governance semantics — budgets, gatekeepers, the policy engine itself (**s04**; this
slice writes through a narrow interface) · the agent console (**s03.E**) · training or
fine-tuning on the captured signal (the capture is here; the use is later).
