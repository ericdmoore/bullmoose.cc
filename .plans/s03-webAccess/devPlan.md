# s03 — Web Access: roadmap

> **This plan is sliced.** The work was too large for one dev plan (15 tasks, four
> phases), so each phase is now its own scoped plan folder with its own readme, dev
> plan, and — where there's slice-specific structure — its own architecture doc.
>
> This file is the **index and sequencing view**. The shared design context stays here:
> [`readme.md`](./readme.md) (the thinking) and [`arch.md`](./arch.md) (the system
> architecture, realm model, and invariants that span all slices).

---

## The slices

| Slice                                                | Scope                                                                    | Ships on its own                      | Gated on              |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- | --------------------- |
| **[s03.A — Foundations](../s03.A-foundations/)**     | cross-realm provenance · grant tombstones                                | _nothing user-visible_ — pure enabler | —                     |
| **[s03.B — Files](../s03.B-files/)**                 | `file_nodes` + blob pinning · `FileNode/*` · attachment sidestep         | **the attachment sidestep**, UI-free  | s03.A                 |
| **[s03.C — Webmail floor](../s03.C-webmail-floor/)** | shell + injected JMAP client · mail surfaces · Files browser             | **a usable mail client**              | s03.A, s03.B          |
| **[s03.D — Co-existence](../s03.D-coexistence/)**    | `ActionProposal` · approval queue + bulk · ownership · brief · promotion | **the multiplayer layer**             | s03.A, s03.C          |
| **[s03.E — Console](../s03.E-console/)**             | per-agent view · credential lifecycle · per-resource forensics           | **agent governance UI**               | s03.A, s03.C, **s04** |

## Sequencing

```
s03.A  foundations ──┬─▶ s03.B  files ──┐
  (blocks all)       │                  ├─▶ s03.C  webmail floor ──┬─▶ s03.D  co-existence
                     └──────────────────┘                          │
                                                                    └─▶ s03.E  console
                                                                          ▲
                                                        s04 governance model (specified)
```

- **s03.A first, always.** Provenance and tombstones are cheap now and impossible
  retroactively — every slice that writes data should land after it.
- **s03.B before s03.C.** Files is standards-backed, testable without a UI, and delivers
  the attachment win on its own; the browser then has something to browse.
- **The floor before the multiplayer layer.** s03.D's surfaces render inside s03.C's
  shell, and s03.C de-risks the arc's largest unknown (a real mail UI).
- **s03.E last.** It is the only slice gated on another plan.

## Why it's cut this way

**s03.A stands alone despite being only two tasks** — small in size, large in blast
radius (every mutable record, the shared write path in two workers). Bundled into a
feature diff, a cross-cutting schema change hides inside a bigger review.

**Each slice is a real milestone**, not a checkpoint: A unblocks and protects, B ships
the attachment sidestep, C ships a mail client, D ships the differentiator, E ships
governance. Any of them can be the stopping point without leaving the product broken.

## Arc-level acceptance

1. Files conforms to the pinned FileNode draft (minus `shareWith`), sidestep works both ways.
2. Webmail is a competent single-player mail client **without** `urn:bullmoose:agent`.
3. With it, a day's agent output is dispatchable in a few gestures — and the queue
   shrinks over time as repetition is promoted to policy.
4. Every invariant in [`arch.md`](./arch.md) §8 holds and is tested.
5. `npm test` green · `npm run typecheck` clean · coverage on new modules ≥ the s01 bar.

## Out of scope for the whole arc

Named-principal file sharing (`shareWith` / ACL "teams" epic) · public MCP façade +
OAuth (**s02**) · governance semantics: budgets, gatekeepers, policy engine (**s04**) ·
Bulwark conformance probe (its own work) · IMAP bridge · offline/local-first webmail.
