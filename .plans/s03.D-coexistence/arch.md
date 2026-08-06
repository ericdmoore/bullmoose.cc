# s03.D — Co-existence: architecture

> Slice-specific structure. System-wide architecture lives in
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §4–5.

## 1. `ActionProposal` — a read model, not a second store

**Decision:** project over the existing `agent_invocations`; do **not** create a parallel
table.

The state machine (`pending → running → done → failed`), the optimistic claim, and the
SLA watchdog are all **[live]**. A second store would create two sources of truth about
"what is the agent doing" — and they would diverge the first time a runner died
mid-claim. So `ActionProposal` is a read model over invocations plus a proposal payload,
exposed as a first-class JMAP collection (`state` + `/changes` + `ifInState`) under
`urn:bullmoose:agent`, so webmail syncs it exactly like Email or FileNode.

```
ActionProposal {
  id, accountId
  agent        // binding name — Allen, Emily
  kind         "reply-draft" | "unsubscribe" | "create-event" | "start-thread"
               | "create-contact" | "organize-files" | "grant-request"
  tier         1 | 2 | 3                    // reversibility — §2
  subject      { realm, objectId }          // what it acts on
  payload      // kind-specific: draft blobId, event JSON, grant request…
  rationale    String                       // the "why" — always present
  evidence     [{ realm, objectId, note }]  // what it looked at
  status       pending | approved | rejected | held | expired
  createdAt, decidedAt, holdUntil
  decision     { by, reason, note }         // the no-thanks signal — §3
}
```

**Why `grant-request` shares the queue:** an agent asking for a permission and an agent
proposing a reply are the same interaction — *what, why, approve/deny*. Unifying them
means one review surface instead of two, and it means the graduation mechanism (§4) works
identically for permissions and for actions.

## 2. Tiers drive behaviour, not labels

`tier` is a property of `kind` and decides what the system is permitted to do:

| Tier | On approve | May graduate? |
|---|---|---|
| **1** reversible — move, label, classify, create contact, organize files | apply immediately, keep an undo handle | ✅ |
| **2** retractable — send reply, start thread, invite-bearing event | enter **hold tray** (`holdUntil`), then commit | ✅ but only *into the tray* |
| **3** irreversible — anything already outside, data already read | human click, every time | ❌ **never** |

**The guarantee is not the policy engine.** Agents lack the `send` scope, so tier-3
egress cannot be auto-committed even if a policy bug said otherwise
(`mcp-auth.md` §12 step 10). Policy is the UI's opinion; the capability wall is the
enforcement. Design accordingly — a policy bug must be a *nuisance*, not a breach.

## 3. Capturing the no-thanks signal

A rejection is the highest-signal data in the system — stronger than `ai-surface.md`'s
"moving a message out of a bucket is a labeled example." Capture the reason as a small
enum plus optional free text:

| Reason | Trains | Counts against the agent? |
|---|---|---|
| `wrongContent` | the drafter | yes |
| `wrongAction` | the classifier | yes |
| `notNow` | nothing — it's a snooze | **no** |

Conflating `notNow` with a real rejection would poison both the training signal and the
autonomy dial. Pure free-text is unusable as signal; pure canned loses the nuance —
hence both.

## 4. Policy: promote repetition, but s04 owns the semantics

The autonomy dial, `autoGrant` templates, and ingest rules are three faces of one thing:
a per-`kind` (optionally per-subject) rule saying *auto-approve within these bounds*.

**This slice detects repetition, offers the promotion, and writes through a narrow
interface. s04 owns what a policy means** — budgets, gatekeepers, enforcement. If this
slice starts inventing budget semantics, it has crossed into s04 and should stop.

Tier-3 kinds are never offered for promotion, at any repetition count.

## 5. Ownership & collision — surfacing, not building

The primitive exists: the optimistic `pending → running` claim **[live]**
(`services/agent/src/index.ts:116-122`) is already collision detection — first claimer
wins, others back off cleanly. Expose `assignee` + `claimedAt` on the thread projection
and webmail can render *"Allen is drafting"*. No new mechanism.

## 6. The brief: one artifact, two renderers

```
brief(accountId, day) ──┬── JMAP object → Today/Tomorrow UI (live)
                        └── MIME digest → Allen mails it (fallback renderer)
```

Computed server-side on the agent worker's existing `scheduled` hook **[live]**, stored
with an `asOf` stamp.

**Why not client-side:** if webmail assembled the brief itself, the mailed version would
drift and the two would disagree — and the email is the *only* rendering for a client
that can't show the native section. One artifact keeps them honest. The email is a
point-in-time snapshot and must say so; the UI is live.

## 7. Bulk is server-side

Query-filter-batch over thousands of items cannot round-trip through the client. This
needs an `urn:bullmoose:agent` method that applies an action to a **query**, with a
count-preview before commit, and tier-aware handling (undoable / held / refused).

## 8. Invariants this slice adds

1. A tier-3 proposal is never auto-committed — not by policy, not by bulk.
2. `notNow` never decrements an autonomy signal.
3. Every proposal carries a non-empty `rationale`.
4. The brief's two renderings derive from one stored artifact.
5. Proposal state never contradicts the underlying invocation — there is one source of
   truth.
