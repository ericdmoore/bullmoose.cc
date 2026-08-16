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

## Decisions — Eric, 2026-08-15

1. **Plus-tags: LINK, not merge.** *"In your tagged alias case link is fine."*
   Two records, marked related, distinction preserved.
2. **Phone: US default**, for now. A match that *depended* on that assumption
   still ranks below one between two already-`+`-prefixed numbers.
3. **Canonical form, with crm@ working toward conformance** — Eric's shape:
   *"Use a canonical form? And the CRM agent attempts to ensure conformance — or
   nudges human for more info to get to conformance."* Already half-built; see
   below.
4. **No auto-apply.** *"Not interested in auto apply yet."* crm@ proposes.

Still open: whether to bring in a postal dataset, or stay suffix-present-only
and accept missing some real duplicates. Missing a duplicate is cheap; merging
two people is not.

## Canonical form is already half-built

`packages/contacts-core/src/index.ts:326` already stores addresses as
**structured components** — `[{kind, value}]` over `locality`, region, postcode
and friends (RFC 9553 JSContact). So "conformance" is not a new concept to
invent: it is **populating the components instead of leaving a free-text
string**, and the canonical form is what those components already are.

- **Store both.** Raw as entered, plus the structured canonical. Never overwrite
  what a human typed — the raw is evidence, and a canonicalization that turns out
  wrong has to be walkable-back.
- **Match on canonical.** The three noise examples then fall out as a consequence
  rather than as three special cases.
- **Ambiguity becomes a question, not a guess.** `7547 Midbury` with no suffix is
  exactly where crm@ should ask rather than pick — the same needsInfo round the
  approvals flow already has.

## Linking needs `relatedTo` — the spec has it, we do not

RFC 9553 (JSContact) defines **`relatedTo`**, a map of UIDs to relation types.
That is the standards-native form of Apple's linked cards, and it is what
decision 1 needs.

**We do not implement it** — zero hits in `packages/contacts-core`. So linking is
a build item, but not an invention: the vocabulary exists and is registered.

## Auto-apply: the axis is reversibility, not risk

Eric raised the two obvious ways to gate auto-apply — a deterministic policy
engine, or an LLM self-assessment of risk — and then observed that *"if there are
checkpoints in the data, then even an agent who makes a terrible error could be
surrounded by supporting structure."*

That last observation is the load-bearing one, and **the architecture already
agrees with it.** `services/jmap/src/methods/actionProposal.ts:45`:

```
tier 1  reversible   → apply immediately, keep an undo handle
tier 2  retractable  → enter the hold tray, yank window
tier 3  irreversible → a human action every time
```

**Those are not risk levels. They are reversibility levels.** Nothing assesses
how dangerous a tier-1 action is; it applies immediately *because it can be
undone*.

Which reframes the choice. What decides safety is not how good the assessor is —
it is how contained the consequence is:

- **Reversible** → auto-apply freely. Safety comes from the undo. An LLM
  assessment is fine here precisely because being wrong is cheap.
- **Irreversible** → *neither* approach suffices. A deterministic policy that is
  wrong is exactly as unrecoverable as a model that is wrong. It needs a human,
  or it needs to be made reversible first.

**So the move for crm@ is not to pick an assessor — it is to remove the
irreversibility.** A merge implemented as tombstone-plus-link (which `relatedTo`
gives us anyway) is undoable in one operation. That makes it tier 1, where
auto-apply would be safe *by construction* rather than by judgment. Don't assess
the risk; delete it.

### Division of labour, where a judgment is genuinely needed

- **LLM for the part that requires judgment** — *"are these two records the same
  person?"* Irreducibly fuzzy, well suited to a model, and a wrong answer on a
  reversible merge costs one undo.
- **Deterministic for the consequence** — *"does this widen a governing book?"*
  is a set difference against `recipients_book_id`. Exact, instant, testable, and
  it does not get more accurate with a better model.

⚠️ The failure mode to avoid is asking the model that *proposed* a merge whether
that merge is risky. Those are two draws from one distribution, and they fail in
the **correlated** direction: the cases where it is most confidently wrong are
the ones it will rate lowest-risk. Same shape as the confused-deputy problem the
`bmi_` token arc exists to solve — assessor and proposer must not be the same
reasoning process.

### The best version is agent-authored policy

Eric's third framing — *"perhaps the agent could even help author a policy for
'these types of small changes are now auto approved'"* — is stronger than either
option, because of **what the human reviews**. Per-instance LLM assessment asks
you to trust a judgment you never see. Agent-authored policy asks you to review a
**rule, once**, after which it runs deterministically, auditably and diffably.
The model does what it is good at — noticing the pattern, drafting the rule — and
the ratified artifact is testable, versionable and revocable.

Per-instance assessment is easier to *build*. Its cost is deferred and
asymmetric: a past decision cannot be explained, the boundary cannot be
unit-tested, and it drifts silently when the model changes underneath it. A
policy file has a diff.

**Sequence that follows:** make merges reversible; keep everything proposal-only;
let crm@ accumulate candidate rules from what Eric approves; offer the policy
once a rule has evidence behind it. Auto-apply then arrives as something
ratified, not something switched on.
