---
plan: s42-go-native
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the ports ran #283–#303-era
                        # PRs, the burial (shared with s08) was #317
acceptance: met
residues: 0
reversals: 0
---

# s42 — closing notes

Set out to port the remaining Node commands under a new rule — stop imitating
Node where the imitation was the only reason a behaviour existed — and became
the arc that made the burial possible: share, vacation, identity, repoint,
discover, blobs, triage, creds, admin, all native, each with choreography
tables instead of byte-diff scaffolding.

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "Every remaining command ported under this section's rule" | ✅ met | registry.go entries share→admin; per-command choreography tests in cli-go/internal/cmd |
| "the registry flipped" | ✅ met | s43 step 7 carried the flip (deliberately alone in its PR) |
| "the Node CLI + `internal/delegate` REMOVED in one PR" | ✅ met | #317, same day, soak waived |
| "The contract suite retired with the delegation it measured" | ✅ met | conformance/vectors.ts generates only login-key + scopes; exit-codes.json frozen |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|

None.

## Reachability

- **Deployed?** shipped inside the released binary (v0.2.0 first all-native;
  v0.3.0 current).
- **Migration applied?** none needed.
- **Verified live?** `admin`/`creds` guard tests are the product; live smoke
  ran against production during the arc.

## Authority-surface delta

`admin`'s irreversible verbs demand `--yes` (with `--dry-run` exempt — a
preview that demands confirmation is one nobody uses); the kill switch
deliberately needs neither. Ported EXACTLY from Node: the guards are the
product.

## Deviations from `devPlan.md`

The section's whole premise WAS the deviation, stated up front: Node-shaped
behaviours that existed only to satisfy byte-diffing were dropped rather than
ported. Named divergences live per-command in the code.

## Reversals

None — but s42's rule superseded s08's original byte-identity doctrine for
everything ported after it, by Eric's explicit call.

## Absorbed / donated

The `agent` command belonged to this arc's scope and was donated whole to
[[s43-go-agent]] (a daemon is not a request-response port). s08 owned the
front door and the burial.

## What grew stale during the build

The contract suite's delegation counts, continuously — by design; they died
with the delegate.

## Traps for the next section

- zsh does not word-split unquoted `$args` — a probe loop passed ONE argument
  `"-n 100 --json"` and reported delegation that was not happening. The
  suite's own sequential trace was the honest instrument.
- `docker compose restart`-class lessons apply to test fixtures too: a
  `*net.TCPConn` whose last reference drops gets its fd closed by the
  finalizer mid-test (`runtime.KeepAlive` in the fleet tests).
