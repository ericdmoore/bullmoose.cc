---
plan: s03.C-webmail-floor
status: closed
closed_at: 2026-08-24
closing_pr: none        # docs-only archive move
acceptance: partial     # T1–T4 shipped and deployed; two T3 leftovers carried
residues: 1
reversals: 0
---

# s03.C — closing notes

Set out to build the floor everything later renders inside: Gmail-grade
single-player mail with zero agent features, so the approval queue, the
brief and the console would be surfaces WITHIN a real client rather than
demos beside one. That bet paid: every later surface (activity, console,
settings — including s37's devices reconcile) mounted into this shell.

## Acceptance ledger

| Done-when (status claims, verbatim) | verdict | evidence |
|---|---|---|
| "T1–T4 SHIPPED and deployed at app.bullmoose.cc" | ✅ met | live host; deploy-app.yml owns the pipeline (same-origin worker-routes design recorded there) |
| "T3 (the Files browser) is marked deferred below and is NOT — it shipped" | ✅ met | `webmail/src/components/FilesApp.tsx` (~910 lines); the devPlan's own ⏸ marker was the stale claim |
| "Outstanding from T3: copy-link via /api/share, and the large-attachment compose path" | ❌ unmet | nothing implements either; carried forward |

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| Files copy-link via `/api/share` + the large-attachment compose path (outbound expiring-link twin of ingest's sidestep) | T3 closed around the browser itself; both actions were follow-ons the floor never needed | #339 (label `residue`) |

## Reachability

- **Deployed?** app.bullmoose.cc via Cloudflare Pages (deploy-app.yml), the
  jmap worker owning `/api/*` routes on the same hostname.
- **Migration applied?** the mail-side schema predates this slice; none of
  its own.
- **Switched on?** yes — it is the daily client.
- **Verified live?** continuously, by use; browser E2E exists behind the
  sandbox-off harness (see the memory-lane notes on Helium+CDP).

## Authority-surface delta

None beyond what the jmap worker already enforced; the client renders inside
the session's grants.

## Deviations from `devPlan.md`

The devPlan still says T3 is "⏸ deferred" — it shipped. The readme's status
corrects it; recorded here so the ⏸ marker is never trusted over the code.

## Reversals

None.

## Absorbed / donated

Every subsequent web surface mounted into this shell (s23 activity, s03.E
console reads, s37 devices). The webmail typecheck gap (root `npx tsc`
excludes webmail entirely) was found during later work and is pinned by
`npm run typecheck` running the webmail project too.

## What grew stale during the build

The devPlan's own T3 marker, in the flattering-to-nobody direction: the
work existed and the plan said it did not.

## Traps for the next section

- `astro build` succeeding while the page renders empty is a real failure
  mode (CSP/hydration); the deploy workflow builds webmail on every run for
  exactly that reason.
- Two login bugs both showed `302 outcome=ok` in worker logs — a clean tail
  is not evidence the flow works; only the browser is.
