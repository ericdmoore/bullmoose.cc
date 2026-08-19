---
plan: s03.E-console
status: closed
closed_at: 2026-08-19
closing_pr: none   # docs-only — .plans/ lands straight on main. Written during the
                   # 2026-08-19 archive sweep; the build is #47, its read interface #100,
                   # and s26's #186 later absorbed the entry point.
acceptance: partial
residues: 2
reversals: 0
---

# s03.E — closing notes

s03.E set out to answer two questions on two screens — *"can Allen even do that?"* and
*"who could have messed up VendorsBook?"* — and the plan's most useful insight is that
they are **different questions in different directions**, so neither screen substitutes
for the other. Support tools organise per-person; security tools organise per-resource.

What it became was **the section that shipped a client for a server that did not exist,
and was right to.** JMAP has no noun for authorization state; `/mcp/analytics` was
worker-to-worker at the time; provision's `GET /grants` is one shared `ADMIN_TOKEN` over
the whole deployment and sVOL `015` had already refused to proxy it. So the console named
four endpoints it needed (`CONSOLE_ENDPOINTS`), rendered *which endpoint is missing* rather
than inventing contents, and shipped a `FakeConsoleClient` behind `?demo=1` so the whole
screen was drivable. Three days later #100 served them. That is the honest version of
"request rather than build": name the contract, refuse to fake it in the live path, and
make the gap legible.

The other thing worth recording is that this section's central rule is **enforced, not
documented.** "No secret ever transits the site backend" is a sentence anyone can write in
a plan; `origins.ts` makes it a thrown error, derives sensitivity from the request body
rather than trusting the caller, and `credentials.test.ts` sweeps every operation the
module offers through an instrumented `fetch` to prove it. That is the difference between
an invariant and an intention.

## Acceptance ledger

The five clauses from `readme.md`, verbatim, plus the three task **Done when** bullets.
`devPlan.md` already ticked all five on 2026-08-09; every row below was re-verified against
the source and against a live host on 2026-08-19.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| 1. "Both questions are answerable in one screen each" | ✅ met | two tabs in one island: `webmail/src/lib/console/perAgent.ts` (per-agent) and `perResource.ts` (per-resource), rendered by `webmail/src/components/AgentConsole.tsx`. #47 |
| 2. "The forensic view is **point-in-time correct** — a since-revoked grant still appears for the window it was live" | ✅ met | `webmail/src/lib/console/perResource.ts:51` — `liveAt()`, checking the tombstone first, then expiry, then birth — and `whoCould` filters on it at `:81`. Sharper than the clause asks: each audit row is matched against the authorization set **at that action's own timestamp**, not at the window's edge (`perResource.ts:24-27`). Driven in a browser at the time, not only asserted |
| 3. "Effective permissions are shown; no raw scope string is presented as if it were the whole truth" | ✅ met | `webmail/src/lib/console/scopes.ts:60-61` (`effectiveScopes`, a declared mirror of `introspectTools.effectiveScopes`) plus `:75` for what a list confers **without naming** — the `mail`-is-a-superset trap from `.feedback/…/common/001`. The mirror is not trusted: `scopes.test.ts:32` imports the **real** `hasScope` from `@bullmoose/auth-core` and asserts agreement across every pair that matters |
| 4. "No secret ever transits the site backend" | ✅ met, and enforced | `webmail/src/lib/console/origins.ts` is a single choke point. Sensitivity is derived from the body — `carriesSecret()` at `:149` over the declared `SECRET_FIELDS` at `:147` — never passed by the caller, and a secret-bearing request **throws** (`OriginRefusal`, `:82-110`) when the vault origin is absent, is the site's own origin, or the computed URL escapes it. `credentials.test.ts` instruments `fetch` across every operation and asserts nothing carrying credential material was addressed at the site origin. Belt and braces: the console page has zero `<form>` elements and the generated CSP carries `form-action 'none'` |
| 5. "The views read an s04-defined model rather than re-deriving policy" | ✅ met | `enforcement`, `bureau_grants` and the verb vocabulary all come from `s04-AgentOS/bureau.md` §5/§5.1/§5.2. Spend renders as *the ledger, not a budget* — the console displays no policy value it does not read from somewhere |
| T1 — "'can Allen send?' is answerable at a glance and correct — including the `mail`-is-a-superset case; no credential value is ever returned to the browser" | ✅ met | `perAgent.ts:295` assembles the dangerous-combination panel (`dangerousCombinations`, `scopes.ts:187` for the `send` predicate); the vault returns credential **references** only — `services/agent/src/vault.ts` docstring, *"a plaintext secret goes IN once … Nothing comes back"* |
| T2 — "an OAuth-based credential can be established entirely in the browser; a raw key never appears in a request to the site origin" | ⚠️ **half met** | the raw-key half is met and enforced (clause 4). The **OAuth half is not reachable**: `webmail/src/lib/console/credentials.ts:247` posts to `/vault/oauth/start`, and the agent worker serves no such route — `services/agent/src/index.ts:187` routes `/vault/credentials` and `/vault/credentials/*` and nothing else. **Live probe, 2026-08-19:** `POST https://mcp.bullmoose.cc/vault/oauth/start` → `404`. The devPlan flags it as *"the other unserved route"*; nothing has served it since. Carried forward |
| T3 — "a since-revoked grant still appears for the window in which it was live; an agent that acted on its **own** account is attributable (the case `grant_audit` alone misses — exactly why s03.A exists)" | ✅ met, with an honest hole rendered | first half is clause 2. Second half depends on s03.A's `last_writer_*`, which is populated for JMAP writes and NULL for DAV ones — so the console renders a `not-captured` **finding** (`perResource.ts:248`) and hatches the blank writer cells rather than leaving them empty. The right behaviour for a forensic tool: it reports the limits of its own evidence |

`acceptance: partial` is a stricter grade than the section gave itself, and the
difference is one clause. All five of `readme.md`'s numbered criteria hold. T2's
**Done when** has two halves and only one of them is reachable: a raw key never
touches the site origin, and an OAuth credential cannot be established in the
browser at all, because the route it posts to returns 404.

The four `grant_audit` caveats are mirrored **verbatim** from `introspectTools`'s
`ACCESS_LOG_LIMITATIONS`, and `caveats.test.ts:29-48` reads
`services/agent/src/introspectTools.ts` off disk to prove it — reword either side and the
test fails rather than the two surfaces telling users different things. `buildResourceView`
puts them on the view model, so a renderer cannot produce a who-did panel without them, and
an empty trail renders `emptyMeans` *in place of* the table.

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| **`POST /vault/oauth/start` and its callback are unserved.** The client half exists and is correct (`webmail/src/lib/console/credentials.ts:234-250`, with the redirect URI resolved through the same `secret`-sensitivity choke point); the server half was never written. Confirmed 404 against `mcp.bullmoose.cc`, 2026-08-19 | s03.E's own line was "renders and requests" — this is the one request `/console/*` did not satisfy, because it is a **write** flow on the vault origin rather than a read projection, so #100 was never going to cover it. Named also in sVOL's residue list; **both plans are now archived, so this note is the only remaining record** | **`#220`** (`residue`) — *"s03.E residue: POST /vault/oauth/start is unserved"*, filed by the archive process on 2026-08-19 for precisely this reason. Until it is served, "an OAuth credential can be established entirely in the browser" is a claim the repo cannot make |
| **`perResource.ts:171` matches a provenance writer to a grant by e-mail address** (`grantee.address === lastWriterPrincipal`), because `last_writer_principal` is a login e-mail while grants key on `accountId` | the read interface did not exist when the consumer was written, so the join used the only field both sides carried. The devPlan names it as a rough edge and says the read interface should return the writer's account id | `.plans/s22-operator-surface/control-plane-in-the-browser.md` §1 *"Where it lives"* — s22 already designs the `/console/*` extension and states *"Show provenance, not verdicts"* as a rule. The fix belongs in `services/jmap/src/console.ts`, not the UI. Also recorded in `.plans/_archived/s03.A-foundations/closingNotes.md`, since the mismatch originates in s03.A's column choice |

Two rough edges from the devPlan are **not** carried forward, because they are scope
limits rather than loose ends, and both are stated in the code: resource discovery is
whatever `/console/…/resources` returns (there is no cross-realm resource search), and the
`at` control is a single instant rather than a range, so *"who could have, at any point
last week?"* is a union query the UI does not express.

## Reachability

This is the one section in this set with an unusually clean answer, and it is worth
separating the three layers.

- **Deployed?** Three things, three ways. The UI is the webmail bundle on Cloudflare Pages
  (`app.bullmoose.cc`, `.github/workflows/deploy-app.yml`). The read interface is
  `services/jmap` — `/console/*` is claimed same-origin beside `/api/*`
  (`services/jmap/src/index.ts:166`, route `app.bullmoose.cc/console/*` at `services/jmap/wrangler.jsonc:32`), deployed by
  `deploy-mail.yml:71`, which is **manual-only**. The credential writes go direct to the
  agent worker's vault origin and never through the site backend, which is clause 4.
- **Migration applied?** None of its own. It consumes s03.A's `grants.revoked_at` and
  `last_writer_*` — so s03.E is only as correct as that migration, and `docs/DEPLOY.md:38`
  names what breaks if it was skipped.
- **Switched on?** Yes. The entry point is gated on `hasAgentCapability`
  (`webmail/src/components/AppShell.tsx:281`) rather than a flag or an unset secret, so it
  appears for a session whose account advertises the agent capability and is simply absent
  otherwise. No commented route, no unset host.
- **Verified live?** **Partly, and honestly.** Verified live at build time in a real
  browser: point-in-time correctness driven by revoking a grant and reloading; every
  console request confirmed to go to the vault origin with a live token and an https vault
  origin. Re-verified in this sweep only from outside the fence —
  `GET https://app.bullmoose.cc/console/agents` returns `401 {"error":"unauthorized"}`
  while an unrouted path like `/zzz-nope` returns the Pages fallback `200`, which proves
  the route is claimed and served but says nothing about what it renders. **The one thing
  verified live as broken is `POST /vault/oauth/start` → 404.**

## Authority-surface delta

s03.E moved no wall — the plan's own line is *"s03.E renders and requests; s04 decides and
enforces"* — but it added two things that behave like authority:

- **A refusal that is a security control, not an error path.** `OriginRefusal` is thrown,
  not warned, when a secret has nowhere safe to go. The failure mode being designed against
  is a misconfigured vault origin silently sending a credential to the site backend, so a
  broken console is the correct outcome.
- **A new browser-reachable read of authorization state**, served same-origin by
  `services/jmap` under the session's own bearer. Deliberately *not* a proxy: sVOL `015`
  refused to put provision's shared `ADMIN_TOKEN` behind a UI and so did this section. The
  console reads what the caller can already reach, through the credential the caller
  already holds.
- **No new scopes.** Every screen is gated by scopes that already existed.

## Deviations from `devPlan.md` / `arch.md`

- **The gate lifted early.** `devPlan.md` opens with a struck-through *"Do not start until
  s04's governance model is specified"*, lifted 2026-08-09 once `s04-AgentOS/{arch,bureau,
  devPlan}.md` specified the model and T1/T2/T3a were built. The gate did its job: clause 5
  is met because there was somewhere to read policy *from*.
- **The console diverges from `introspectTools` deliberately, and pins the divergence.**
  `ConsoleGrant.revokedAt` and `grantState()` read the tombstone **first**, while
  `introspectTools` at the time derived `live` from `expires_at` alone and reported a
  revoked grant as `live: true`. `perAgent.test.ts` pinned the divergence rather than
  waiting for the upstream fix. The fix landed in #48 nine hours after #47 merged, so the
  divergence is now agreement — but the pin is why the console was never wrong in the
  interval.
- **`?demo=1` and `FakeConsoleClient` are a deliberate second implementation.** The plan
  did not ask for them. They are what let "the read interface is unserved" be a *rendered
  sentence naming the missing endpoint* in the live path and a fully drivable screen in
  demo, rather than a blank page or, worse, plausible fake data on a real origin.
- **The `at` control is a single instant, not a range** — a scope limit, stated in the
  devPlan and unchanged.

## Reversals

None. s03.E overturned no earlier decision. It *reported* four deltas owned elsewhere
rather than patching them, which is the opposite behaviour and the one this repo wants:
`introspectTools`'s tombstone staleness, sVOL `023`'s grade, sVOL `023`'s note about
`vault.ts` hand-rolling bearer verification, and `common/033`'s NULL provenance.

## Absorbed / donated

**Absorbed:**

- **s03.A** — both halves. Without `grants.revoked_at` the forensic view cannot be
  point-in-time correct; without `last_writer_*` the *who did* panel has nothing to join
  the audit log to.
- **s03.C** — the shell the console mounts in.
- **s04** — the model it reads: `enforcement`, `bureau_grants`, the verb vocabulary.
- **sVOL `015`** — `CONSOLE_ENDPOINTS` is a browser-reachable projection of `015`'s own
  introspection queries, and `caveats.ts` mirrors its `ACCESS_LOG_LIMITATIONS` verbatim.
- **#100** — the read interface this section requested and did not build.
  `services/jmap/src/console.ts` names s03.E as its reason in its header, and the wire
  shapes are `webmail/src/lib/console/types.ts` mirrored server-side.

**Donated:**

- To **s02 T4** — the consent screen. s02 explicitly reused `effectiveScopes` (expanding
  the `mail` bundle through the real `hasScope` so the explanation cannot drift from the
  gate) and the dangerous-combinations panel, instead of writing a second vocabulary for
  the OAuth consent page.
- To **#48** — this section's reported delta 1 became that PR's second half, fixing
  `renderGrant().live`, the `grant_live` subquery and the two unfiltered grant queries in
  `services/agent/src/introspectTools.ts`. Verified fixed: `introspectTools.ts:302`
  (`const live = r.revoked_at === null && …`), `:337`, `:358` and the `grant_live`
  subquery at `:683` all filter the tombstone now, and `:750` explains what a revoked
  grant's audit rows mean.
- To **sVOL** — reported delta 2, the regrade of `023` from `I2` to `E4-I1`, was accepted:
  the file is now `.plans/_archived/sVOL-CapSurNoun/✅023 -E4-I1- Agents-And-Secrets-Over-WebUI.md`.
- To **s26 T1 (#186)** — this section's whole surface. See below.

## What grew stale during the build

- **`devPlan.md`'s "Rough edges" §1 — "the read interface is unserved, so the live path
  shows only credentials"** — stale since #100, three days after #47. `readme.md`'s status
  block was updated to say so; the devPlan's rough-edges list was not.
- **`src/pages/console.astro` no longer exists.** The devPlan says the island is hosted
  there and that the topbar grows an **Agents** link. Both facts moved: s07 T1 renamed the
  page as part of the eight-section app shell, and **s26 T1 (#186) absorbed the console
  into the Agents realm**, where it is now the Governance collection's *"Access console"*
  and `AgentConsole` mounts whole — *"s03.E's agent/credential console is NOT gone"*,
  `webmail/src/pages/agents.astro:11-14`. Unchanged in substance, unfindable by the path
  the plan gives.
- **Delta 1 (`introspectTools` tombstone staleness) is fixed** — #48, evidence above.
- **Delta 2 (sVOL `023` regrade) is done** — the file carries `E4-I1` and a ✅.
- **Delta 3 stands and has aged badly.** `services/agent/src/vault.ts:124-149` still
  hand-rolls the `tokens ⋈ principals` join instead of calling `verifyBearer`, and s03.E's
  point — that the console really does POST directly to `/vault/credentials`, so the
  duplicate is a second front door rather than untidiness — is now the *only* live record
  of it, since sVOL is archived. It is carried forward in
  `.plans/_archived/s01-stateless-MCP/closingNotes.md`, whose T1 was supposed to delete it.
- **Delta 4 (`common/033` is now user-visible) stands.** Still open. Fixing `033` removes
  findings from this screen, which is the outcome to aim for.
- **"128 new tests (webmail 245 → 373; repo 1248 → 1376)"** is a 2026-08-09 snapshot,
  useful only as the delta it records.

## Traps for the next section

- **Write the client against a contract and refuse to fake it in the live path.** Naming
  `CONSOLE_ENDPOINTS`, rendering *which* endpoint is missing, and confining the fake to
  `?demo=1` meant the missing server was a visible, addressable gap for three days instead
  of a blocker — and when it arrived, nothing had to be rewritten. The failure mode this
  avoids is demo data on a real origin, which s07 T1 had to remove elsewhere for exactly
  this reason.
- **A rule you can only document is a rule you cannot keep.** Sensitivity derived from the
  body, a single choke point, a thrown refusal, and a test that instruments `fetch` — four
  cheap mechanisms turn "no secret transits the site backend" from a convention into
  something that breaks the build when violated. Compare s03.A's provenance guard, which
  greps the helper and therefore cannot see a caller that supplies nothing.
- **Mirror a sentence, then test the mirror against its source on disk.** `caveats.test.ts`
  reads `introspectTools.ts` and fails if either side is reworded; `scopes.test.ts` imports
  the real `hasScope` and checks agreement pair by pair. Two surfaces telling a user
  different things about the same permission is the failure, and drift is silent without
  this.
- **When you find a bug you do not own, pin your divergence rather than waiting.** The
  console read the tombstone first while `introspectTools` still reported revoked grants as
  live, and `perAgent.test.ts` asserted the difference. The console was never wrong, the
  delta was reported with a named fix, and the fix landed in #48 the same night.
- **A screen can be absorbed into another realm without being deleted, and the plan will
  not say so.** s03.E's path is gone and its surface is intact. Grep for the component, not
  the route.
