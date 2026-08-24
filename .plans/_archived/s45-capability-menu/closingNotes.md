---
plan: s45-capability-menu
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only; archived by 3e3ea4d, this note added by
                        # the gate that caught the move landing without one
acceptance: met
residues: 1
reversals: 0
---

# s45 — closing notes

Set out to give the scheduler more economic knowledge of a homelab than one
bit and three facets, and shipped as three slices in a day: @local
resolution (#323), the declared capability menu (#324), and the measured
receipt/latency columns (#328). The design's own concession — "param count
is a poor excuse for quality" — became the shape: declared facts plus
MEASURED quality, never a proxy number pretending to be one.

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "@local resolution" | ✅ met | #323 |
| "menu declaration" | ✅ met | #324, additive to s43's byte-pinned claimant shape, Go only, after the flip — exactly as sequenced |
| "measured receipt/latency" | ✅ met | #328 (the s45 slice-3 receipt reaching the columns) |
| "the aggregated per-(model, pipeline) table on `agents model`" | ❌ unmet | named an "open nicety" at close; raw columns all exist; carried forward |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| Aggregated per-(model, pipeline) rollup on `agents model` — display over data already recorded | a nicety; the section's value landed without it | #343 (label `residue`) |

## Reachability

- **Deployed?** rides the released CLI (v0.3.0) and the agent worker's
  normal deploys; the claimant-declaration extension is live in the fleet
  path.
- **Migration applied?** the receipt columns landed with their own PRs'
  schema story; nothing outstanding.
- **Verified live?** the measured columns fill wherever a daemon serves
  invocations; the archive move itself was a parallel session's, and this
  note was written by the gate that caught it landing without one.

## Authority-surface delta

None — capability declaration is scheduling metadata, not authority.

## Deviations / Reversals / Absorbed

Sequenced deliberately AFTER the s43 registry flip so invariant #3 (the
byte-exact claimant shape) held through the port; extended additively in Go
only, as planned. No reversals.

## Traps for the next section

An archive move must carry its closing note IN THE SAME COMMIT —
`archivedPlans.test.ts` fails every PR's merge ref until main is fixed, so
the gap punishes bystanders first.
