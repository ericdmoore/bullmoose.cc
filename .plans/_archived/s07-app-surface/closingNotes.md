---
plan: s07-app-surface
status: closed
closed_at: 2026-08-19
closing_pr: none          # docs-only; .plans/*.md lands straight on main
acceptance: partial       # T5's score and T6's shared query planner are unmet
residues: 2
reversals: 1
---

# s07 — closing notes

s07 set out to turn two disconnected pages into one product: a single origin
with eight realms, arranged around a home view that shows you what needs
deciding. All eight tasks landed. What the plan could not know is that s07
would stop being a *section* and become the **substrate** — nine later plans
(s10, s18, s20, s23, s24, s25, s26) shipped their surfaces into the shell s07
built, and the sections it drew are now navigation, not deliverables. The
`webmail/src/lib/` directory it opened with eleven entries has twenty-two.

Two things went differently from the design, and both are more interesting than
the ten pages. First, **Decision 1 was reversed in practice** — the interim
paste-a-token door faced the public internet for eight days before PKCE landed.
Second, the plan's most-quoted idea, the three-number agent score, is the one
piece that never rendered: its schema shipped, its per-run half shipped, and the
aggregate never got an owner until this archive gave it one. A section can ship
every task and still leave its headline unbuilt.

## Acceptance ledger

Only T0, T1, T5, T6 and T7 wrote **Done when** lines; T2, T3 and T4 shipped
against prose specs and are recorded below the rule.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T0 "a first-time visitor with mail, a calendar and one agent sees what needs them today without clicking anything" | ✅ met | `webmail/src/pages/index.astro` renders `lib/home/waiting.ts` (pending-only, urgency-ordered, capped at 5) + `lib/home/horizon.ts`; #84 |
| T0 "nothing on this page is a file browser" | ✅ met | `webmail/src/lib/app/sections.ts:16` puts `/files` deliberately last in the nav and `/` is a view, not a section (`index.astro:5-8`); #84 |
| T1 "the client is reachable at `/mail` against a real token" | ✅ met | live probe 2026-08-19: `GET https://app.bullmoose.cc/login` → 200, `GET /.well-known/jmap` → 401 (worker route answering, auth required). #56, deployed by `.github/workflows/deploy-app.yml` |
| T1 "a first-time visitor gets the token form and not demo data" | ✅ met | the silent demo fallback is gone — demo is reachable only by asking (`webmail/src/lib/app/client.ts:73-75`, `?demo=1`); bare no-token routes to `/login` |
| T1 "the token appears in no URL, no history entry, and no log" | ✅ met | `webmail/src/lib/app/tokenInUrl.test.ts:60-118` scans the populated surface for query-string builds, history pushes and navigable forms; `:157-182` drives the strip. Extended at T7 to the OAuth callback (`:184-200`) |
| T1 "Tighten `connect-src`" *(struck through in the plan itself)* | ❌ **unmet, and the plan says so** | `webmail/astro.config.mjs:64` is still `connect-src 'self' https: wss:`. The instruction assumed a fixed API origin; the base is runtime-configurable, so a build-time literal breaks every non-default deployment. Carried forward |
| T5 "the three numbers compute from real rows" | ❌ **unmet** | the *rows* exist — `infra/migrations.mjs:355-366` (`invocation-cost-columns`), costs frozen at completion, #86 — but nothing computes acceptance rate, cost-of-declined or cost-per-approved. No hit for any of the three anywhere in `webmail/`, `services/` or `packages/`. Carried forward |
| T5 "an agent with no recorded cost renders 'not recorded' rather than a flattering zero" | ✅ met | `webmail/src/lib/approvals/rows.ts:213-220` — `null` → "cost not recorded", `0` → "free", kept distinct; same rule in the dossier (`webmail/src/lib/agents/dossier.ts:277`, asserted `dossier.test.ts:295-297`); #178 put the µUSD figure on every approval row |
| T6 "one query returns results from three realms" | ✅ met | `webmail/src/lib/search/fanout.test.ts:23-42`; a dead realm fails alone (`:67-85`), which is the property that makes a fan-out honest; #83 |
| T6 "the scope note names what is indexed vs scanned **and what is not searched at all**" | ✅ met | `webmail/src/lib/search/scope.ts` — derived from the coverage declaration, not written as prose, so it cannot drift from `plan.ts`'s `REALMS` |
| T6 "the MCP `search` tool and the page share a code path" | ❌ **unmet** | there is no MCP `search` tool. The registered surface is still three separate tools — `email_query`, `contacts_search`, `calendar_query_events` (`services/agent/src/emailTools.ts`, `mcpNouns.ts`) — which is precisely the "a model must know to call three" problem the clause existed to fix. Carried forward |
| T6 "the response envelope declares its own coverage" | ✅ met | `webmail/src/lib/search/fanout.test.ts:43-54` — coverage rides the response, including `files` declared as *not searched*; adding an index later changes the data, not the shape |
| T7 "a user logs in without ever seeing a token" | ✅ met | PKCE S256 against `auth.bullmoose.cc`, `webmail/src/lib/app/oauth.ts`; callback params stripped in one `replaceState` (`tokenInUrl.test.ts:184-200`); #191, 2026-08-18 |
| T7 "the interim door is deleted" | ❌ **unmet — deliberately** | paste-a-token survives as the collapsed fallback inside the same island (`webmail/src/pages/login.astro:9-10`) for origins the AS cannot redirect back to. A conscious deviation, not an oversight; recorded below rather than quietly re-scoped |

**T2 `/settings`** (#57), **T3 `/contacts` + `/calendar`** (#58, #59) and
**T4 `/approvals`** (#83) wrote no Done-when clause. All three ship as pages
under `webmail/src/pages/` with their `lib/` directories, and T4's server
prerequisites both cleared: `ActionProposal` from s03.D T1 (#82) and the four
`/console/*` routes (`services/jmap/src/console.ts:362-370`, served by #100).
`/agents` was ⛔ at s07's writing and is now a full realm — donated, see below.

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The `connect-src` tightening | Marked in the plan itself as "NOT DONE, and cannot be done as written": the API base is runtime-configurable (`?api=`, the door's advanced field, a stored `bullmoose.apiBase`, `defaultBase()` falling back to page origin), so a build-time origin list breaks every non-default deployment. What is needed is a **decision** — re-specify the permitted origins now that `auth.bullmoose.cc` is in the dance, or record that the broad policy is intended and close it — not an edit | `#221` (label `residue`) — filed by the archive process 2026-08-19, unassigned |
| The three-number agent score (acceptance rate · cost of declined · cost per approved) | s07 T5 shipped the *facts* and stopped there; the aggregate needed a surface, and `/agents` was blocked at the time. s10 named it and explicitly declined to build it | `.plans/s10-agents/devPlan.md` **T6** — still open, in a live plan |

## Reachability

- **Deployed?** Yes, and it is the only surface in the repo CI ships
  automatically: `.github/workflows/deploy-app.yml` pushes `webmail/` to the
  `bullmoose-app` Pages project on every push to main touching `webmail/**` or
  `packages/jmap-core/**`.
- **Same-origin by design.** `services/jmap` owns
  `app.bullmoose.cc/{api/*, auth/*, .well-known/jmap, console/*, share/*}` via
  Worker routes; Pages serves the rest. The worker ships with
  `deploy-mail.yml`, **not** with `deploy-app.yml` — deploy the worker first or
  `/api/*` 404s into Pages and the app looks broken while the login page works
  (`deploy-app.yml:26-28`).
- **Migration applied?** One: `invocation-cost-columns` (T5,
  `infra/migrations.mjs:355`). Its `why` note is unusually blunt because the
  agent worker's `finish()` names those columns in its UPDATE — a worker
  deployed against a database missing them fails *every* invocation
  finalisation, not merely a dashboard reading NULL. Everything else in s07
  needed no schema change.
- **Switched on?** Yes. Public since T1, PKCE-fronted since #191.
- **Verified live?** Partially, and by me, today: `https://app.bullmoose.cc/login`
  answers 200 and `/.well-known/jmap` answers 401 from the Worker route, which
  proves the origin, the Pages deploy and the route split are all real. **I did
  not sign in**, so nothing past the door — the PKCE round trip, the queue, the
  eight realms — is verified live in this note.

## Authority-surface delta

- **The app became a public OAuth client.** PKCE S256, no secret, redirecting to
  `auth.bullmoose.cc` — the same authorization server built for MCP in s02 T3.
  One front door for claude.ai and for the human, which was the whole argument
  for folding T7 into s02 rather than building a bespoke webmail login.
- **The credential's lifetime changed shape.** A permanent `bm_` token in
  `localStorage` gave way to a short-lived access token plus refresh. Note the
  standing hazard the plan flagged and T7 did not close: `bm_` tokens
  themselves still never expire — neither self-service mint site writes
  `expires_at`.
- **No new scopes.** Every realm page reads through capabilities that already
  existed; `/agents` gates on `urn:bullmoose:params:jmap:agent` as `s03.E`
  defined it.
- **Sharing gained no home.** Grants are still created by `POST /grants` behind
  a deployment-wide `ADMIN_TOKEN`, and s03.E renders them read-only. The plan
  flagged this as "the largest unclaimed piece of the premise" and it remains
  unclaimed — it is s03.E/sVOL territory, not s07's, but it should not go
  unmentioned in the file that closes the surface plan.

## Deviations from `devPlan.md` / `arch.md`

- **T7 kept the interim door.** Specified as deletion, shipped as demotion —
  collapsed under "Advanced" (`webmail/src/pages/login.astro:9-10`). The reason
  is real: an AS cannot redirect back to an origin it does not know, and
  paste-a-token is the only path for those. But it means the plan's own risk —
  a credential-shaped text field on a public origin — is still on the page, and
  anyone reading "the interim door is deleted" would not expect to find it.
- **T1 built no deploy config; T7 was supposed to.** In practice the Pages
  project and workflow landed with the deployment work (#60) well before T7,
  which is the mechanical half of the Decision-1 reversal below.
- **The nav capability gate was never hydrated.** The plan asked T4 to decide
  between hydrating the nav and accepting the gate only inside the page. It
  accepted the latter by default: `sections.ts` is static, and `/agents` shows
  for sessions that lack the agent capability. The truth is told inside the
  page, not in the nav.
- **`/files` is in the nav.** The plan excluded it (blocked on s03.B T3);
  s03.B T3 landed (#106) and s03.C T3 built the browser (#109), so `/files`
  ships enabled — deliberately ordered last (`sections.ts:7,16`) on the "lead
  with files and you have built Drive" argument.

## Reversals

**One, and it is the section's own Decision 1.** The plan recommended
*"public, but only after T7 — the interim door should not face the internet."*
`app.bullmoose.cc` went public on 2026-08-10 (#60) with paste-a-token as the
only door; PKCE arrived 2026-08-18 (#191). For those eight days the interim
door was the live front door — exactly the posture Decision 1 refused. Nobody
should "restore" Decision 1 as a bug now: the reversal is settled, and the
lesson worth keeping is that a deploy workflow is a *policy* decision when the
login is interim, not a plumbing one.

## Absorbed / donated

- **Absorbed from s03.C:** T1 moved the shell, `JmapClient` and the sanitizer
  rather than rebuilding them (s03.C T1–T2, 374 tests).
- **Absorbed from s03.D:** T4's `/approvals` could not exist until
  `ActionProposal` did. s03.D T1 (#82) shipped the collection, `expiresAt` and
  edit-diff retention; s07 built only the surface. The plan's T0 warning that
  *"`expires in` has nothing to compute from today"* was answered there, and
  the three clocks stayed distinct (`webmail/src/lib/approvals/clocks.ts:7-9`).
- **Absorbed from s03.E:** the four `/console/*` routes T4 waited on, served by
  #100.
- **Donated → s10:** the activity-panel frame the score was meant to render
  into. s10 T6 names s07 T5 as its dependency and declines to build the score
  itself; that dependency is now satisfied and T6 is the only thing between the
  facts and the numbers.
- **Received back from s26:** `/agents`, which s07 shipped as ⛔. The realm's
  full quad-panel dossier is s26 T1 (#186) plus the economics and ledger
  projections it added to `console.ts`; s03.E's console survives inside it as
  the Governance collection (`webmail/src/pages/agents.astro:10-13`). **s26's
  own note should record that it closed s07's last blocked task.**
- **Received back from s24/s25:** the layout s07 drew was re-cut into the
  quad-panel IA (#171–#177) and made phone-first (#189, #194, #200, #205).
  `layouts/App.astro` survives only for the door; every realm now mounts
  `AppTw.astro`.

## What grew stale during the build

- **The status line's "Remaining" list.** It named T7, the `/agents` dossier
  and the three-number score. Two of the three are now done — T7 at #191 and
  the dossier at #186 — leaving the score alone, which is why it is the only
  one that needed re-homing.
- **s10 T6's premise.** It says the cost columns "do not exist yet, so the
  dossier shows no score today". The columns have existed since #86
  (2026-08-12). The dossier still shows no score, but for a different reason
  now: nothing was ever written to compute it. A reader taking that sentence at
  face value would go build the schema again.
- **T2's blocker claim** was already stale when written — `Identity/set` is
  registered at `services/jmap/src/methods/identity.ts:167`, and the plan says
  so. Worth repeating only because it is the same failure mode as s10 T6: a
  dependency note that outlives its dependency.
- **The domain map in T1.** Five hostnames were "in play"; all five are live,
  and `explore.bullmoose.cc` (s21) has since joined them — dark, behind a
  commented route.

## Traps for the next section

- **"Deployed" and "gated" are different decisions, and shipping the first
  silently makes the second.** Decision 1 was reversed by a deploy workflow, not
  by anyone re-reading Decision 1.
- **A capability whose schema lands is not a capability.** s07 T5's cost columns
  shipped, its per-run label shipped, and the aggregate that justified the whole
  task never did. If a task's deliverable is a *number a human reads*, the
  acceptance clause has to name the pixel, not the column.
- **Do not build a UI on top of routes that do not exist yet.** The plan says it
  outright — *"Do not start the screens before the routes; that is exactly how
  s03.E ended up demo-only"* — and following it is why T4 shipped working
  instead of shipping a demo.
- **A CSP directive that has to know your API origin cannot be a build-time
  literal if the origin is user-configurable.** Decide which one you want before
  writing either.
- **A screenshot harness will happily hand you a convincing fake browser.**
  s07's first screenshots (#166) found three real wrinkles; #209 later found the
  harness itself was the thing reporting "Loading…".
