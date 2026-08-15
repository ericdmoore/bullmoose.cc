# crm@ dedupe — identity resolution over noisy identifiers

**Status: design, not built.** Written 2026-08-15 from Eric's spec, with the
traps that spec would hit made explicit. Three of them are correctness, one is a
privilege escalation.

## The ask, in Eric's words

> Any time I make a change to any contact — single change or batch change — it
> invokes a systematic review of the changes, looking for duplications and merge
> strategies on universal identifiers: email, phone, and physical address. Each
> of those allows increasing levels of noise and still semantically resolve.

With the worked examples:

```
1) ericdmoore@gmail.com == eric.d.moore@gmail.com == ericdmoore+1@gmail.com
2) 9729898592 == 19729898592 == +19729898592 == +1 (972) 989-8592
3) 7547 Midbury Dallas TX 75230
   == 7547 Midbury Dr. Dallas TX 75230
   == 7547 Midbury Drive. Dallas Texas 75230
   == 7547 Midbury Dr, Dallas, TX 75230
```

"Increasing levels of noise and still semantically resolve" is the right frame,
and it implies the thing the design has to get right: **this is a confidence
gradient, not an equality test.** Everything below follows from taking that
literally.

---

## ⚠️ Trap 1 — example (1) is a Gmail policy, not a mail rule

`ericdmoore@gmail.com == eric.d.moore@gmail.com` is **true at Gmail and false
almost everywhere else.**

RFC 5321 §2.3.11 makes the local-part opaque to everyone except the destination
server: `a.b@example.com` and `ab@example.com` are, in general, **two different
mailboxes belonging to two different people.** Dot-insensitivity is something
Google chose. Fastmail, Proton, self-hosted Postfix and most corporate mail do
not do it.

So a normalizer that strips dots universally will **silently merge distinct
people**, and the failure is invisible — you get one contact where there were
two, and the evidence that there were ever two is gone.

**Therefore:** dot-stripping is gated on a **provider table**, not applied
globally. `gmail.com` and `googlemail.com` strip; everything else does not,
unless someone adds it deliberately with a reason. The table is data, and its
default is "dots are significant".

### And plus-tags are a convention that often carries meaning

RFC 5233 subaddressing is widely supported but not universal, and some providers
treat `+` as an ordinary local-part character. Worse for this feature: a plus-tag
is frequently **deliberately distinct**. `eric+netflix@` exists precisely so it
can be told apart from `eric+bank@`. Collapsing them destroys information the
user created on purpose.

**Therefore:** plus-tag stripping proposes a *link*, never an automatic merge,
and the proposal states which tag it dropped so a human can say "no, those are
separate on purpose."

## ⚠️ Trap 2 — a bare phone number is only `+1` if you assume a region

`9729898592 → +19729898592` requires a default region. That is a real assumption,
not a normalization, and it is wrong for anyone with international contacts.

**Therefore:** E.164 normalization takes a configured default region, and any
match that *depended* on that assumption records it on the proposal — "matched
assuming US" — so the assumption is visible at the moment someone approves it.
A match between two already-`+`-prefixed numbers carries no such caveat and is
strictly stronger evidence.

## ⚠️ Trap 3 — addresses cannot be canonicalized reliably without reference data

Two of the transforms in example (3) are tractable with a lookup table: suffix
(`Dr` / `Dr.` / `Drive`), state (`TX` / `Texas`), and punctuation or whitespace
noise. Those are safe.

The remaining one is not. `7547 Midbury` vs `7547 Midbury Dr` **drops the suffix
entirely** — and "Midbury Dr" and "Midbury Ln" can both exist in the same city.
Treating a missing suffix as a wildcard makes two different streets collide.

Real canonicalization is a USPS/postal-dataset problem, and we do not have that
dataset.

**Therefore:** address matching is the **weakest** tier by construction. A
suffix-present match is decent evidence; a suffix-absent match is a *hint* that
needs corroboration from another axis, never a merge on its own.

## 🔴 Trap 4 — a merge can widen an agent's outbound allowlist

This is the one that makes dedupe a security surface rather than a tidiness
feature.

`agent_bindings.recipients_book_id` names the **governing book** that bounds who
an agent may email (`services/agent/src/outbound.ts`), and `NULL` there means
*cannot send at all* — the book is an allowlist, fail-closed.

So: **merging contact X (in the governing book) with contact Y (not in it) can
carry Y's addresses into the allowlist.** An agent that could not email Y a
minute ago now can, and nothing about the merge looks like a permission change.
That is precisely the self-grant shape s10 closed for direct book edits — and
dedupe is a side door into the same room.

**Therefore, non-negotiable:** a merge that changes the *effective membership* of
any governing book is a **book-membership change** and goes through the existing
chain — an `ActionProposal`, a `book_membership_log` row with `via_proposal_id`,
and the same human approval any other widening needs. crm@ **proposes**; it never
applies a widening merge on its own authority. A merge that provably cannot widen
any governing book (both records already in the book, or the book governs no
binding) is a different and much cheaper case, and worth detecting so the common
path stays quiet.

---

## Shape that follows

**Confidence tiers, not a boolean.** Each axis emits evidence with a strength,
ordered by how much noise it tolerated to match:

| tier | example | disposition |
|---|---|---|
| **exact** | byte-identical `+1` E.164; identical normalized email at a provider whose rules we know | propose merge, high confidence |
| **canonical** | phone matched via default region; email dot-stripped at Gmail; address with suffix present | propose merge, record the assumption |
| **fuzzy** | address with suffix absent; plus-tag collapse | propose **link**, not merge — needs corroboration or a human |

Two independent fuzzy axes agreeing is stronger than one canonical axis alone;
that combination rule should be explicit and tested rather than emergent.

**Merges are proposals, and proposals are reversible.** A merge destroys the fact
that there were two records. Either it is a tombstone-plus-link (reversible) or
it is human-approved (deliberate). The architecture already has `ActionProposal`,
tiering and a hold tray; dedupe should ride those rather than invent a parallel
path.

**Trigger: coalesce, and stop the loop.** "Any contact change invokes a review"
has two hazards. A batch change must coalesce into **one** review, not N — the
natural key is the write, not the record. And the review's own output is a
contact change, which would trigger another review: the same loop the
hermes-bullmoose bridge guards with `Auto-Submitted`. crm@'s own writes must be
marked so it does not review itself forever.

**Provenance.** Every merge records what matched, on which axis, at which tier,
and which assumption it depended on. "These two are the same person" is a claim,
and a claim without its evidence cannot be audited or undone intelligently.

---

## Open questions for Eric

1. **Plus-tags: merge or link?** They are often deliberately distinct. My
   inclination is link-never-merge, but you may use them as pure aliases.
2. **Default phone region** — US? And should a match that depended on the
   assumption rank below one between two `+`-prefixed numbers? (I think yes.)
3. **Is there an address dataset you would want to use**, or do we stay in the
   "suffix-present only" tier and accept that some real duplicates are missed?
   Missing a duplicate is cheap; merging two people is not.
4. **Should crm@ ever auto-apply a merge**, even an exact-tier one that provably
   cannot widen a governing book? The safe default is no.
