---
plan: s06-codehygiene
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move
acceptance: partial     # three of four landed; perf/bench never did
residues: 1
reversals: 0
---

# s06 — closing notes

A four-item hygiene list (fmt, lint, coverage, perf/bench) that landed three
— and whose own status line once lied in the dangerous direction,
UNDERSTATING what had shipped ("that is how tooling gets built twice"; the
2026-08-19 correction is preserved in the readme). The CI spine it asked for
is now the repo's floor: one required `verify` check running typecheck, the
full suite, `gofmt -l`, `go vet`, `oxfmt --check` and `oxlint`, plus a real
PR-triggered coverage ratchet.

## Acceptance ledger

| Done-when (the four named items) | verdict | evidence |
|---|---|---|
| Fmt (TS formatter gate) | ✅ met | `oxfmt --check` in verify (mail-typecheck.yml:34-35); `.githooks/pre-commit` formats before a commit exists |
| Lint | ✅ met | `oxlint` in the same gate |
| Coverage ratchet ("codecov must go up") | ✅ met | `coverage-ratchet.mjs:307` exits non-zero on regression, `pull_request`-triggered; deliberate soft gate (red X, non-blocking) |
| Perf/bench testing | ❌ unmet | nothing implements it; carried forward |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| Perf/bench: benchmark suite / perf gate / trend tracking — scope undecided (Go micro-bench vs worker latency vs bundle budgets) | never started; the other three consumed the section | #338 (label `residue`) |

## Reachability

- **Deployed?** CI-plane only; `verify` is required by
  `.github/rulesets/main-tests-must-pass.json`.
- **Migration applied?** none needed.
- **Switched on?** yes — every PR runs the whole gate.
- **Verified live?** it blocks merges daily; the coverage ratchet's floor has
  been raised deliberately during the Go arcs (69 → 71).

## Authority-surface delta

None.

## Deviations from `devPlan.md`

The coverage gate is SOFT by decision (job id `coverage` shows a red X
without blocking) — a deviation from "must go up" as a hard rule, chosen so
a refactor that moves covered code between buckets does not wall a merge.

## Reversals

None.

## Absorbed / donated

The Go halves (gofmt/vet in verify) rode in with s08's arcs; the docs-only
main bypass that this archive move itself uses was settled alongside the
same ruleset work.

## What grew stale during the build

The section's own status — corrected 2026-08-19 after it under-reported
shipped work. The original line is preserved struck-through in the readme.

## Traps for the next section

A status line that understates is worse than one that overstates: the next
person builds the thing again. Audit against CI config, not against memory.
