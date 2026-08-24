---
plan: s08-go-cli
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the burial PR was #317
acceptance: met
residues: 0
reversals: 0
---

# s08 — closing notes

Set out to make the CLI one Go binary with no runtime; became a strangler-fig
port so complete it ended by deleting its own measuring instruments. The
delegate (native-or-Node routing) was the section's central machine, and the
section's last act was demolishing it: #317 removed `packages/cli` and
`internal/delegate` in one PR, with the three surviving duties (command
identification, help routing, the unknown-flag guard) moved to
`cli-go/internal/cmd/route.go` as native code.

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "T1–T7 shipped; the flip put every help-listed command native" | ✅ met | registry.go serves every help-listed command; contract suite retired with delegation |
| "the removal PR deleted `packages/cli` and `internal/delegate` together" | ✅ met | #317 (74 files); soak waived by Eric in as many words |
| "conformance/exit-codes.json is FROZEN as the exit-code contract" | ✅ met | pinned by `cli-go/internal/io/exit_test.go`; generation removed from conformance/vectors.ts |
| "Releases: v0.1.0, v0.2.0" | ✅ met | release-cli.yml; dl.bullmoose.cc/cli/ mirror (v0.3.0 followed post-close, adding s46's `cloud`) |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|

None. The trace metric, the contract suite and the soak all retired with the
things they measured.

## Reachability

- **Deployed?** Released binaries at dl.bullmoose.cc/cli (latest.txt → v0.3.0
  as of the archive move); GitHub Releases carry the same artifacts.
- **Migration applied?** none needed.
- **Switched on?** `~/bin/bullmoose` IS the Go binary on the one known install.
- **Verified live?** every release runs the binary's own `version` in CI and
  demands the tag back; fullmonty-style live upgrade exercised via popcorn's
  sibling pipeline.

## Authority-surface delta

None. The Go CLI holds exactly the tokens the Node CLI held; the flag guard's
refusals became native (exit 2, flag named) without widening anything.

## Deviations from `devPlan.md`

- The soak (T7's retirement criterion) was WAIVED by Eric — sole user — rather
  than run for a release. Recorded in the status and here so nobody hunts for
  soak telemetry that never existed.
- goldmark's rendered HTML deliberately does not claim byte-identity with
  marked (`send --expandMD`); the submission choreography stays exact.

## Reversals

None.

## Absorbed / donated

- s42 and s43 executed the bulk of the port under their own rules (share →
  admin, and the whole agent surface); s08 kept the front door, releases,
  and the burial. All three closed within two days of each other.

## What grew stale during the build

The devPlan under-reported itself by ~ten commits until 2026-08-17 (this
section had no readme, the only one that lacked one). The status header is
the corrected record.

## Traps for the next section

- A branch cut from a pre-squash base makes the PR CONFLICTING and GitHub
  dispatches NO workflows — it looks like slow CI, not a refusal (#317 hit
  this; rebase onto origin/main fixed it).
- ldflags `-X` is stringly wiring: unknown symbols are ignored SILENTLY, so
  the release smoke runs the built binary and demands the version back.
