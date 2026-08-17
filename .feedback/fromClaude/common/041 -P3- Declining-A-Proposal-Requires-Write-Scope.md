# 041 -P3- Declining an ActionProposal requires `draft` write scope

**Subsystem:** common · **Severity:** LOW (edge case: read-only reviewer) · **Fix class:** CHANGE-CODE

## The claim

`services/jmap/src/methods/actionProposal.ts:183` gates _every_ decision — approve **and
reject** — behind the same scope:

```ts
// Base gate: reviewing/deciding is a `draft`-tier mail action, the same …
const access = await requireAccount(ctx, args, "draft", "mail");
```

## The defect

Approving a proposal does something — it writes a card, holds a reply, eventually sends — so
requiring `draft` (a write verb) to approve is correct. **Rejecting does nothing but say
"no."** Requiring a write scope to record a refusal is backwards: a human with a read-only
token can _see_ what an agent proposes but cannot decline it, so their only options are
approve (which they also can't, lacking scope) or leave it pending until it expires.

Recording "no" should need less authority than "yes," not the same.

## Why it is P3, not higher

The approvals surface already requires the agent capability and is aimed at an account owner,
so a pure read-only reviewer is an edge case today. But it is exactly the shape that matters
for the multi-player premise — a delegate given read access to another account's mailbox
should be able to _decline_ on the owner's behalf without being handed write scope.

## Suggested fix

Split the gate: `reject` requires `read` (you must be able to see it to refuse it); `approve`
keeps `draft` (and tier-3 approve keeps the `send` gate at :257, unchanged). The reject path
already asserts `status must be "approved" or "rejected"` at :218 — branch the scope check on
which one before the write.

Found while building `/approvals` (s07 T4).
