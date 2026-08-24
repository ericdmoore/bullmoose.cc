---
plan: s46-cloud-install
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the build was #330–#335
acceptance: partial     # T1–T6 built and unit/live-smoke verified; the
                        # second-account live proof is open — see residue
residues: 1
reversals: 0
---

# s46 — closing notes

Set out to close a one-layer gap — "you have the CLI and a CF token, and you
can stand up NOTHING" — and became six slices in one day: the stack as
checksummed downloads, a pure planner, a consenting applier, a bridge to the
mail path the stack already owned, and an update verb that is honestly an
alias. The design's best call survived contact intact: the installer
provisions the STACK and hands off to `admin init`; the mail path stayed
provision's (`admin domain add`), because building it twice would drift.

## Acceptance ledger

| Done-when (plan/status claims, verbatim) | verdict | evidence |
|---|---|---|
| "T1 publish `stack/<version>/` bundles + manifest from CI (checksummed, latest-last)" | ✅ met | #330 + #331; `stack/v0.1.0` live on dl.bullmoose.cc, `shasum --check` green |
| "T2 probe + plan, pure and read-only — testable like popcorn's plan_test.go" | ✅ met | #332; live smoke vs production: 8 workers reuse, Pages blocked naming the scope, DNS refused |
| "T3 apply, core resources (D1 + DDL, R2, workers/bindings/routes)" | ✅ met | #333; recording-fake contract: binding-graph order, account ids only, gates before first mutation |
| "T4 the mail path: DNS writes, routing walk, in/out verification" | ✅ met (as the bridge) | #334; workers.dev reconciliation, the admin-init hand-off, `cloud doctor` (4/5 green live vs production) |
| "T5 hand-off + the quickstart doc (three commands from zero to inbox)" | ✅ met | #335; receipt prints admin init/tenant/domain/doctor + webmail one-liner; docs/install-cloud.md |
| "T6 `cloud update`" | ✅ met | #335; alias made true by reconcile: kept secrets, probed ids, our-shaped DNS reuse |
| "Test on a second CF account EARLY (T3), not at the end" (risk register) | ❌ unmet | never ran — needs a token only Eric can mint; carried forward |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The second-account live proof: full install on a spare zone, delivered message in, DKIM-aligned out | needs a CF account/zone token only Eric can mint; everything up to the mutation gate is live-smoked read-only | #337 (label `residue`) |

## Reachability

- **Deployed?** the pipeline (release-stack.yml) and `stack/v0.1.0` are live;
  the verbs shipped in CLI v0.3.0 on dl.bullmoose.cc.
- **Migration applied?** none needed (the section ships migrations, it does
  not need one).
- **Switched on?** nothing gates it; `CLOUDFLARE_API_TOKEN` + `--zone` is the
  entire input surface.
- **Verified live?** read-only halves yes (plan + doctor against production,
  real API shapes); the mutating half only against recording fakes — that is
  exactly what #337 exists to close.

## Authority-surface delta

The installer holds the operator's own CF token (env → Bearer, never argv or
URL) and mints ADMIN_TOKEN / VAULT_MASTER_KEY / SHARE_SIGNING_KEY /
INTERNAL_TOKEN locally, landing them only as the operator's worker secrets —
the project sees nothing. No new scopes on bullmoose's side.

## Deviations from `devPlan.md`

- T4 became a BRIDGE (workers.dev reconciliation + hand-off + doctor) rather
  than DNS-writing machinery, on discovering provision's `addDomain` already
  is the mail path. Deliberate, and the plan's own one-layer rule demanded it.
- The webmail DEPLOYMENT stays one `npx wrangler pages deploy` command
  (receipt-printed, versioned): Pages direct upload is wrangler's file-hash
  protocol, and a Go reimplementation would drift.

## Reversals

None.

## Absorbed / donated

Built directly on s08 T7's release machinery (bucket, layout, latest-last)
and popcorn's plan/apply consent model — third instance of that shape.

## What grew stale during the build

- T3 shipped a re-run-rotates-secrets bug for two merges; #335 killed it
  (mint only when every holder is created; VAULT_MASTER_KEY rotation would
  have orphaned every sealed credential). Recorded so `cloud update` is
  never "simplified" back into it.
- The assumed DNS shapes: Worker custom domains write proxied `AAAA 100::`
  placeholders, not workers.dev CNAMEs — verified against production before
  the reuse rule shipped.

## Traps for the next section

- CF API 403s are FINDINGS, not errors: record the scope by name and keep
  walking; and diagnose a 403 as a TOKEN gap, never as the resource being
  absent — the confidently-wrong direction on both sides.
- Worker secrets are write-only. Any machinery that "re-applies" them is a
  rotation, whether it meant to be or not.
