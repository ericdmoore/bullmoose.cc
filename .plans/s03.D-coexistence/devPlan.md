# s03.D — Co-existence: dev plan

> Scope: [`readme.md`](./readme.md) · structure: [`arch.md`](./arch.md).
> **Depends on s03.A** (provenance) and **s03.C** (the shell these render in).

## Status — 2026-08-10

**Nothing built. Not blocked either** — both stated dependencies are done, so this is
unstarted by choice rather than by gate.

| Task | State | Evidence |
|---|---|---|
| **T1** — `urn:bullmoose:agent` capability + `ActionProposal` | ✅ **done** | side table `agent_proposals` 1:1 over `agent_invocations`; JMAP collection + producer + capability gate + migration. tier-3 wall = the `send` scope (`actionProposal.ts:257`). +17 tests |
| **T2–T5** | ❌ not started | gated on T1 |

The seam is already cut and empty: `webmail/src/components/AppShell.tsx:688` renders
`{agentSeam ? <aside class="agent-seam" aria-label="Agent" /> : null}` — an empty `<aside>`,
deliberately (`:682-687`). `s03.C` T4's capability gate is live and tested, so the shell
already behaves correctly for a plain client; what is missing is anything to put in the box.

**T1 is the whole gate.** Until an agent worker produces an `ActionProposal`, T2–T5 have no
input.

---

## T1 — `urn:bullmoose:agent` capability + `ActionProposal`

**Blocks:** `services/jmap` (new collection) · `services/agent` (producer) · AccountDO.

- The read model over `agent_invocations` (`arch.md` §1) as a JMAP collection with
  `state` / `/changes` / `ifInState`.
- The agent worker emits proposals — `kind`, `tier`, `subject`, `payload`, `rationale`,
  `evidence[]` — instead of writing directly for anything above tier 1.
- Capability advertised only when enabled, so s03.C's plain-client mode stays true.

**Done when:** an agent run yields a `pending` proposal with rationale + evidence;
approving a tier-1 applies it; a tier-3 cannot be applied without a human action;
`/changes` drives push.

---

## T2 — Approval queue UI + bulk

**Blocks:** webmail (s03.C shell) · a server-side batch method.

- Queue with grouping, per-item **why**, approve/reject/snooze.
- **Hold tray** for tier-2 (`holdUntil`), with yank-before-commit.
- **Query-filter-batch** with count-preview, executed server-side (`arch.md` §7).
- Rejection capture: `{wrongContent | wrongAction | notNow}` + optional note.

**Done when:** ~40 queued items are dispatchable in a couple of gestures; a held item is
yankable; `notNow` records as a snooze without decrementing the agent's signal.

---

## T3 — Thread ownership & collision

- Surface `assignee` / `claimedAt` from the existing claim **[live]** — "Allen is
  drafting", "handled by Emily, awaiting you".
- Human → agent invoke on a thread (`agent-integration.md` §C) — the direction that makes
  this multiplayer rather than a review console.

**Done when:** a claimed thread shows its holder live via push; invoking an agent from
the UI creates an invocation that the runtime picks up.

---

## T4 — The brief (Today / Tomorrow)

- Server-computed `brief(accountId, day)` on the agent worker's existing `scheduled`
  **[live]**, stored with `asOf`.
- Two renderers: JMAP object → Today/Tomorrow UI; MIME → Allen's digest.

**Done when:** both renderings come from one artifact and agree; the mailed copy is
stamped `asOf`; disabling the UI leaves the email working.

---

## T5 — Promote repetition to policy

> **Needed-detail:** [`decline-taxonomy.md`](./decline-taxonomy.md) — the directed no-signal
> (`wrongContent`/`wrongAction`/`unsafe` + the `tookItMyself`/`defer` non-feedback actions),
> and the pipeline invariant that `defer`/`tookItMyself` are NOT negative. Repetition of a
> reason feeds two DIFFERENT promotions — autonomy (repeated approve) vs scheduling (repeated
> `defer` → `s11-scheduling`) — and conflating them is the failure mode.

- Detect repetition (N approvals of one `kind`/subject; a bulk filter application) and
  offer the promotion: autonomy dial ▸ `autoGrant` template ▸ ingest rule.
- Write through a **narrow interface**; s04 owns the semantics (`arch.md` §4).
- Tier-3 kinds never offered.

**Done when:** the prompt fires on a real repetition; accepting writes policy via the
interface; a tier-3 kind is never offered at any count.

---

## Sequencing

```
s03.A + s03.C ─▶ T1 ActionProposal ─┬─▶ T2 queue + bulk
                                     ├─▶ T3 ownership
                                     ├─▶ T4 brief
                                     └─▶ T5 promotion
```

T1 is the gate; T2–T5 are largely parallel afterwards. **T5 last on purpose** — you
cannot detect meaningful repetition until real decisions have accumulated through T2.

## Verification

The honest test is not a passing suite — it's **a week of real mail**. Does the queue
shrink over time as promotions accumulate, or does it stay at 40/day? That's the
measurement that says whether the design works.

## Risk

**The queue becomes a second inbox.** This is the slice's defining failure mode. T5 is
the mitigation, which is why it must actually ship rather than being deferred as polish
— without it, nothing empties and the arc's premise quietly fails.
