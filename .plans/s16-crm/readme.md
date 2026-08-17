# s16 — `crm@`: the agent that curates the address book

> **Status: designed, not built.** readme 2026-08-13; `dedupe.md` and `notes-on-people.md` (2026-08-15/16) specify the work — confidence tiers, the transform-to-invariant note form, and four named traps including a privilege escalation through governing books. Two written sub-designs, zero code.
> duplicates). Eric: _"`CRM@` should propose de-dupe actions. That is the bread-and-butter
> behavior of someone looking at contacts."_
>
> The framing is the whole point. Dedupe is **not a button** and **not a batch job** — it is
> what a colleague who looks after your contacts _notices and offers_. Tool-shaped answer:
> a "Find duplicates" screen you must remember to visit. Space-shaped answer: an agent that
> raises its hand.

## The tier this finally uses

`s10 T1` gave books three write policies, and the middle one has had no occupant:

| policy        | who writes                                          | for                                  |
| ------------- | --------------------------------------------------- | ------------------------------------ |
| `open`        | anyone with a grant                                 | an agent's own working books         |
| **`propose`** | **humans directly; AGENTS file proposals**          | **human-owned books — this section** |
| `governed`    | nobody but the owner; widening is a `grant-request` | allowlist books                      |

So `crm@` needs **no new authority mechanism**: it holds `contacts` scope, the human's book
is `propose`, and every write it wants becomes a reviewable row in `/approvals` — chained,
attributed, and editable before it lands. The chokepoint already refuses it any other path.

## Confidence tiers — the bouncer cascade, applied to identity

Dedupe has the same shape as spam: cheap-and-certain first, judgment only on the ambiguous
middle. **Do not start with a model.**

1. **Exact** — identical normalized email, or identical `uid`. Deterministic, no judgment.
   These can be **batched into ONE proposal** ("14 exact duplicates, merge all") because
   there is nothing per-pair to weigh.
2. **Strong** — same email local-part + same surname; or one card's email set is a subset of
   the other's and names agree. Still deterministic; batch by cluster, but show the pairs.
3. **Ambiguous** — similar names, no shared address ("Adam Ray" / "A. Ray"). This is the
   mid-band, and it is where a model may score — **as a classification**, never as an
   action. One proposal per cluster, because each is a real judgment.

⚠️ **Queue flood is the failure mode.** 3,559 cards could yield hundreds of pairs; one
proposal each would make `/approvals` useless — the same lesson s11 T9 learned about budget
asks. Batch by tier and cap per sweep.

## Merge is the interesting verb, and edit is where it pays

A merge destroys information: two cards become one, and some field loses. So:

- **The proposal carries the merged card as its payload**, and the human can **edit before
  approving** — the approve-after-edit diff the decline taxonomy calls the
  highest-information event in the system. "Yes, but keep _her_ phone number" is a labeled
  correction, not a rejection.
- **Rationale must say WHY these are the same** ("identical email"; "same surname, adjacent
  import batch"). `needsInfo` then works as designed: _"why do you think these are the same
  person?"_ is exactly the question, and it is answerable from the record.
- **Losers are tombstoned, not deleted**, and the membership chain records the merge — an
  undo needs the loser to still exist.
- **Never merge across books without saying so.** A card in a `governed` book merging with
  one in a personal book touches an allowlist; that is a widening-class act and must chain
  on both.

## Beyond dedupe — the rest of "bread and butter"

Named so the section is not mistaken for a one-verb agent; each is a _proposal_, never a
silent write:

- **Missing contact** — "you have exchanged 40 messages with this address and it is in no
  book." The most obviously useful and the cheapest to compute.
- **Enrichment** — a signature block carries a title/phone the card lacks; propose the
  addition with the message as evidence.
- **Staleness** — "no contact in 3 years"; propose archiving, never deleting.
- **Group suggestions** — recurring co-recipients look like a group.

## Open questions

1. **When does `crm@` run?** A sweep (cron), or on-change (a new card triggers a match
   against the book)? _Recommendation: on-change for the cheap exact tier — a duplicate is
   most fixable the moment it arrives — plus a periodic sweep for the rest._
2. **Does an import get special treatment?** 3,559 cards arrived in bulk and duplicates are
   an import artifact. _Recommendation: yes — a post-import pass is the highest-yield
   moment, and "these 14 arrived twice in the same import" is a rationale no fuzzy matcher
   can beat._
3. **Is `merge-contacts` a new proposal kind, or a shape of `create-contact`?**
   _Recommendation: new kind — the apply path is a merge+tombstone, not an insert, and the
   surfaces must render a diff rather than a card._
4. **Auto-approve for the exact tier?** Tempting at scale. _Recommendation: no, not at
   first. Let the queue prove the matcher's precision before spending the human's trust;
   revisit once the approve rate is measurable (s07 T5's score is the input)._

## References

- `.plans/s10-agents/devPlan.md` T1 — the `propose` policy this occupies; the chokepoint
- `.plans/s03.D-coexistence/decline-taxonomy.md` — approve-after-edit as the richest signal;
  `needsInfo` as the challenge verb
- `.plans/s12-boundary/readme.md` — the confidence cascade this mirrors (deterministic
  first, model only on the mid-band)
- `.plans/s11-scheduling/devPlan.md` T9 — the batching lesson (one ask, not N)
- `webmail/src/components/ContactsApp.tsx` — the surface a merge proposal must render into
