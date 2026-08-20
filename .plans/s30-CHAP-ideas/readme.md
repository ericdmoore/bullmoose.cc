# s30 — The Edit · *what the human changed, and why that is data*

**Status:** design note, nothing built. Written 2026-08-19 after Eric raised
[CHAP](https://github.com/BrightbeamAI/chap) (Collaborative Human-Agent
Protocol, BrightbeamAI) — *"feels very aligned (and very new)."*

It is aligned. This note is about the two ideas worth taking, the one thing
worth exporting, and the part we should not adopt.

## The convergence is real, and it is evidence

CHAP's core abstraction is an **envelope**: an agent's draft (artefact), the
human's **override** as an RFC 6902 JSON Patch, a **rationale**, and tags,
chained by content hash. That is `agent_proposals`, field for field:

| CHAP | bullmoose |
|---|---|
| artefact — the agent's draft | `payload_json` |
| override — the human's edit | `edited_payload_json` |
| rationale | `rationale` — `NOT NULL`, invariant §8.3 |
| decision provenance | `decision_json { by, reason, note }` |
| audit chain | `agent_invocations` + [[s23-activity]]'s eight sources |

`/approvals` already tells the user *"an edit is kept beside the agent's
original, so the difference is never lost."* That is CHAP's override
semantics, arrived at independently. And CHAP's framing of the problem —
reconstructing what happened six weeks later costs forty-five minutes and is
half guesswork — is s23's opening paragraph, written before anyone here had
read the spec.

Two teams reaching the same shape from different directions is the best
evidence available that the shape is right.

## 🔴 The gap CHAP names and we have open

CHAP splits an override into **intent-preserved** (refining the draft) versus
**substituting** (replacing it with a different action) — *"two different
failure modes [that] want different fixes."*

We do not make that distinction, and its absence has already cost us once.
`editedPayload`'s entire server-side validation is, today, at
`services/jmap/src/methods/actionProposal.ts:695`:

```ts
if (editedPayload !== undefined && (editedPayload === null || typeof editedPayload !== "object")) {
```

No key allowlist. The edited payload replaces the original wholesale for the
apply. So `to` was editable, and **the approve dialog was a recipient-rewrite
primitive**: an approver could retype the recipient and egress somewhere the
agent was never permitted to reach, with no agent misbehaviour involved. That
is fixed at the gate (`assertOutboundAllowed` before `SUBMIT.fetch`, #158) —
but it is fixed by a *guard someone remembered to call*, not by the data model
making the mistake unrepresentable.

"Refining" versus "substituting" is exactly the axis on which that hole is
visible in the schema instead of in a code review.

### And the difference is currently a RENDERING, not a record

`ApprovalsQueue.tsx:899` computes a diff at display time (`apq-diff`) so the
human can see what changed. Nothing stores it. The consequence is precise:
**you can look at one edit but you cannot ask a question about all of them.**
"Which agent gets edited most, and is it always the same field?" is
unanswerable today, and it is the single most useful supervision signal the
product could have — CHAP's tag argument is the same one: *"whatever you put
there is the dimension you will aggregate on three months from now."*

## What to take

**T1 — classify the override.** A discriminator on the proposal:
`refine` (the agent's action, adjusted) vs `substitute` (a different action
wearing the agent's approval). Cheap: one column plus a rule. `substitute`
should arguably demand more than `refine` does — it is closer to authoring
than to approving, and the tier ladder already knows how to express "this
needs more."

**T2 — store the edit as a patch, not a replacement.** RFC 6902 against
`payload_json`. Bigger change than T1 and the right direction: the diff stops
being derived-for-display and becomes queryable data, T1's classification
becomes checkable rather than self-declared, and a key allowlist becomes
expressible as "which paths may a patch touch" — which is the shape the
egress hole actually had.

**T3 — export CHAP from `/activity`, do not ingest it.** [[s23-activity]] v1
landed 2026-08-18 (#185) and already renders the authority chain per row. An
export is an interop surface with no schema commitment: we get "speaks the
standard" without betting the data model on a 0.2 draft.

## What NOT to take

**CHAP records; bullmoose constrains.** This is the important one. Our
approval path's safety property is not "the decision was logged" — it is that
a narrowed governing book *refuses the send*, fail-closed, re-derived against
the effective payload. CHAP gives auditability, not authority. Nothing in the
spec, as read, expresses *"this agent may not do that."*

The risk is not technical, it is rhetorical: a good audit chain is seductive
enough to become the safety story. That is the failure this repo keeps
catching in itself — s10's devPlan called the egress gap "mitigated" on a
premise that had quietly stopped being true. A log that makes misuse
*legible afterwards* must never be mistaken for a gate that makes it
*impossible*.

**Our tier model is richer.** Reversible / retractable / irreversible, with
hold trays and retraction windows, is a stronger claim than "record the
decision," and it has no CHAP equivalent. Reversibility is our safety axis;
we should not flatten it to fit someone else's envelope.

**The wire format.** JSON-RPC 2.0 onto a JMAP-native platform (RFC 8620/8621)
is an impedance mismatch — we already have a wire format and it is an IETF
standard. And v0.2 with 1.0 "awaited" is the oxfmt bet again: we watched a
0.63 formatter's defaults rewrite 1068 licensed files. A *spec* shifting under
you is worse than a tool, because the data outlives the code.

**The word "envelope."** `services/bureau/src/invocationEnvelope.ts` already
means a capability envelope, ANDed after the standing check. Reusing the term
for a record would collide exactly the way `ledger` already collides with
analyst@'s spend pipeline. If T1/T2 need a noun, it is not "envelope."

## Sequencing

T1 stands alone and should not wait for anything. T2 wants to land before any
policy-based approval rule exists ([[s23-activity]] argues that log-before-
rules ordering), because a rule that edits on your behalf makes "what changed
and was it a substitution" a question asked at machine rate. T3 is only worth
doing once someone outside actually wants the export.

## Open questions

1. **Does a `substitute` deserve its own tier bump?** My instinct is yes:
   substituting is authoring, and authoring under an agent's approval is the
   thing the recipient-rewrite hole exploited.
2. **Does CHAP express authority at all**, or is it purely descriptive? If
   purely descriptive it is a complement to [[s10-agents]], not a substitute,
   and the integration point is s23 rather than the proposal path. Worth
   reading `SPECIFICATION.md` properly before committing to T3.
3. **Is the patch the stored form, or a derived index?** Storing both the
   replacement and the patch is redundant but survives a bad patch
   implementation; storing only the patch is cleaner and less forgiving.
4. Do we want CHAP's **content-hash chaining** independently of the rest? It
   is the one structural idea here we have no analogue for.

## Related

- [[s10-agents]] — proposals, tiers, the governing book, the gate that refuses
- [[s23-activity]] — the record this would enrich; v1 landed #185
- [[s17-chief-of-staff]] — why the edit matters: delegation you can inspect
- `#158` — the egress hole this taxonomy would have made visible
