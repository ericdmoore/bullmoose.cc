---
plan: s37-your-own-box
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move; the build was #325 #326 #327 #329
acceptance: met
residues: 0
reversals: 0
---

# s37 — closing notes

Set out to make the machine you run bullmoose on visible from the app, and
turned out to be — as its own readme predicted — a JOIN, not a feature: a
named token already was a registered device, `bullmoose local` already found
the models; the only missing piece was one report path and the discipline to
render it honestly ("last seen" never "connected", "as of" never
"installed", zero reports → zero claims).

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "T1a: `Principal.tokenId`, `device_reports`, `DeviceReport/set` singleton-self + owner-only `/get`" | ✅ met | #325; `services/jmap/src/methods/deviceReport.ts` |
| "T2 surfaces: Explorer type, MCP `devices` tool, model entries grew `{id, kind}`" | ✅ met | #326; `services/agent/src/introspectTools.ts` (accountless, thin callJmap client — the drift guard refused a `FROM tokens` join and was right) |
| "T1b: reporters on `local setup`/`connect`/saved-host and daemon start; `--once` files nothing" | ✅ met | #327; `cli-go/internal/cmd/devicereport.go`, `agentserve.go` |
| "T2 settings: the reconcile view — enabled bindings' `@local/…` joined against reports" | ✅ met | #329; `webmail/src/lib/settings/devices.ts` + `SettingsDevicesSection.tsx` |
| "T3 needed no PR: the install command is docs/install-cli.md + dl.bullmoose.cc" | ✅ met | both live before the section closed |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|

None.

## Reachability

- **Deployed?** jmap + agent workers via deploy-mail.yml post-merge; webmail
  via deploy-app.yml; the reporters in released CLI v0.3.0.
- **Migration applied?** `device_reports` is CREATE IF NOT EXISTS in
  control-plane.sql — a schema re-run creates it; listed in migrations.mjs
  so the set stays complete.
- **Switched on?** nothing gates it; an old server answers `unknownMethod`,
  which every reader treats as feature detection, not an error.
- **Verified live?** the CLI reporter and the settings view were driven
  against fakes end-to-end; the production join renders whenever a v0.3.0
  CLI logs in.

## Authority-surface delta

`DeviceReport/set` writes only the singleton `self` — no argument can name
another token. Reads are owner-only (absence of `access.granted` = ownership;
agent principals excluded). Display-only by decision: nothing routes on
self-reports.

## Deviations from `devPlan.md`

The MCP `devices` tool was rewritten from a direct DB read to a thin
`callJmap` client mid-build because introspect's drift test refuses
`FROM tokens` in that module (secret_hash protection). The test was right;
the architecture is better for it.

## Reversals

None.

## Absorbed / donated

T1b fixed a live `runLocal` dispatch bug inherited from the s43 port (verb
read at `at(0)`, so `local setup`/`connect` never dispatched natively —
first caught by the reporter's own end-to-end tests).

## What grew stale during the build

The original readme's "both reporting surfaces live in the CLI being
retired" blocker — it died within a day of being written, and the status
header records the resolution.

## Traps for the next section

- `sourceIsGreppable` walks git-TRACKED files: a NUL byte in an untracked
  file passes the local run and fails CI on the committed truth. `git add`
  before the local guard run.
- Test-fake joins cross planes silently; production D1 does not. The fakes
  warn now — believe them.
