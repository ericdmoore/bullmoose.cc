---
plan: s02-mcp-facade
status: closed
closed_at: 2026-08-19
closing_pr: none   # docs-only — .plans/ lands straight on main. Written during the
                   # 2026-08-19 archive sweep; the build itself is #108 #110 #112 #122
                   # #126 #144 #145, and every claim below is re-verified against those.
acceptance: partial
residues: 2
reversals: 2
---

# s02 — closing notes

s02 set out to put an OAuth 2.1 front door on the MCP surface s01 had just built. What it
became was **the section that discovered the client population it was building for did not
speak the protocol it was building on.** The finding is in the devPlan's own §"The finding
that reorders this plan": Anthropic's connector docs list 2025-03-26, 2025-06-18 and
2025-11-25, and `SUPPORTED_VERSIONS` was a one-element array reading `["2026-07-28"]`. The
legacy `initialize` shim, scoped in `readme.md` as a deprecation courtesy to be dropped at
the end of a 12-month offramp, was in fact the only lane any real client could use, and it
went on the critical path. The plan left the wrong version in place above the right one and
labelled it — which is the correct thing to do with reasoning that was wrong for
instructive reasons, and it is the single most useful page in the folder.

The second thing s02 became is the section where **a real client found a bug a 51-check
conformance harness could not.** T7 said in advance that no harness substitutes for a real
client, gave the reason ("a self-written client shares your assumptions"), and was then
proved right on its own author: the harness's fake legacy client omitted the
`MCP-Protocol-Version` header that every real 2025 client sends, so era detection read
"header without `_meta` mirror" as a malformed modern request and answered claude.ai's
first `tools/list` with `-32020`. PR #126. The corrected discriminator, and the two-row
table of what each era actually sends, are now a comment at
`services/agent/src/mcp.ts:498-521` — the fix and its post-mortem in the same place.

## Acceptance ledger

The seven task **Done when** clauses, verbatim. s02 has no separate acceptance list; the
tasks are the gate.

| Done-when (verbatim) | verdict | evidence |
|---|---|---|
| T1 — "`curl https://mcp.bullmoose.cc/mcp` with no credential returns 401 carrying a `resource_metadata` URL that resolves to a valid PRM document naming our AS; the same request with a valid `bm_` bearer still works; `/drain` and `/internal/*` still 404 without the internal token" | ✅ met | **live probe, 2026-08-19:** `POST https://mcp.bullmoose.cc/mcp` → `401` with `www-authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp"`; that URL returns `{"resource":"https://mcp.bullmoose.cc/mcp","authorization_servers":["https://auth.bullmoose.cc"],…}`. Code: `services/agent/src/wellKnown.ts:114-129`, route at `services/agent/src/index.ts:136-139`; the internal-token wrapper survives at `index.ts:169`. #108 |
| T2 — "a stock 2025-11-25 client completes `initialize` → `tools/list` → `tools/call` end to end; the modern `_meta` lane is byte-identical to today except the three corrected codes; `mcp.test.ts:234-244` … is rewritten to assert it is *alive and legacy*" | ✅ met | `services/agent/src/mcpLegacy.ts`; dispatch at `services/agent/src/mcp.ts:482-490`; era discriminator at `:518`. The inversion is `services/agent/src/mcp.test.ts:239`, titled *"6. initialize is ALIVE and legacy (s02 T2 — this test inverted on purpose)"*. Full legacy round trip is test 30 (`mcp.test.ts:569`). Two of the three corrected codes are constants now — `HEADER_MISMATCH = -32020`, `MISSING_CLIENT_CAPABILITY = -32021` (`mcp.ts:119-124`), asserted by tests 40 and 41 |
| T2 rider — "`Mcp-Method` … **REQUIRED**, validate against body" | ⚠️ **decided down, not met as written** | validated-when-present only: `mcp.ts:539-542` and `:705-708` both guard on `header &&`. Signed off by Eric 2026-08-15 as **validated-when-present**, with the reason recorded in the devPlan status block: enforcing it would break every existing caller including our own harness, for an intermediary-routing benefit nothing here uses. The spec says REQUIRED; we do not comply, on purpose, and it is a two-line change if an intermediary ever appears |
| T3 — "`/.well-known/oauth-authorization-server` validates; a scripted PKCE S256 authorization-code flow yields an access token; that token is accepted by `/mcp` and a token minted for a *different* `resource` is rejected" | ✅ met, with one clause met by construction | **live probe, 2026-08-19:** `https://auth.bullmoose.cc/.well-known/oauth-authorization-server` returns `client_id_metadata_document_supported:true`, `"none"` in `token_endpoint_auth_methods_supported` (both required or CIMD is silently skipped), `code_challenge_methods_supported:["S256"]` with no `plain`, and `authorization_response_iss_parameter_supported:true`. The scripted dance is `tools/e2e-mcp-public.mjs`. The wrong-`resource` clause is met by the provider **pinning** `resource` so a cross-resource token cannot be minted here at all, plus unit tests on `audienceMatches` (`services/agent/src/oauthBridge.ts:116`, `oauthBridge.test.ts:12-17`) — not by a live cross-resource presentation, which pinning makes impossible. The plan says so itself |
| T4 — "consenting through claude.ai produces a row the console renders in the per-agent view; revoking in the console kills the OAuth token; a scope the token does not carry still yields `-32004` with the existing message" | ⚠️ **partial — the *conversational* console, not the web one** | the D1 mirror is real (`services/oauth/src/consentMirror.ts:52`, `oauth_consents` at `packages/mailstore/sql/control-plane.sql:246`) and `who_can_access` reads it (`services/agent/src/introspectTools.ts:186-205`); revocation is `POST /revoke` (`services/oauth/src/index.ts:98`, `revoke.ts`) with `revoke_app` as its conversational face (`services/agent/src/oauthBridge.ts:145`). **The webmail console renders none of it** — `grep -r consent webmail/src/lib/console services/jmap/src/console.ts` returns nothing. The devPlan's own status block admits this. Carried forward below |
| T5 — "a fresh client can call `whoami` with `{}`, learn its accounts, and every single-account principal can drive every tool without ever passing `accountId`" | ✅ met | `ToolDef.accountless` and the branch that skips the account gate while keeping the scope gate, `services/agent/src/mcp.ts:715-726`; server-side defaulting at `:729-742`. Tests 20–27 (`mcp.test.ts:405-560`), including 21 — the two-account refusal that **names** the accounts so the next call can succeed |
| T6 — "`tools/list` carries `scope`; the published set is explicit in code with a test asserting exactly which tools a public token can see" | ✅ met | `services/agent/src/mcp.ts:614-650` publishes `scope`, `domain` and `accountless`. Tests 50–52 (`mcp.test.ts:811-844`), of which 51 — *"the published scope is the one the gate actually enforces"* — is the one that matters: it makes the advertisement and the gate the same fact. Decision 1 (all tools public, introspection included) signed off by Eric 2026-08-15. The result cap that T6 also asked for is `capResult` (`mcp.ts:784-798`), tests 60–63 |
| T7 — "the harness passes, and a real Claude client has completed a `tools/call`" | ✅ met | `tools/e2e-mcp-public.mjs` carries exactly **51** `check()` calls (counted, `grep -c`), reported 51/51 against production 2026-08-14. Real clients: claude.ai (CIMD, web redirect), Claude Code on the homelab box (DCR, `127.0.0.1` paste-the-callback) and Claude Code on the laptop (CIMD, native loopback) — every redirect policy and both client-identification methods proven by a real client, 2026-08-14/15 |

`acceptance: partial` records the two ⚠️ rows and nothing worse: one clause was
consciously **decided down** by the owner (`Mcp-Method`) and one was met on a
different surface than the one it named (the consent record). Neither was dropped,
and both are written down here rather than in a PR body.

Both open decisions were signed off by Eric on **2026-08-15** and are recorded in the
devPlan status block: **all tools stay public**, and **`Mcp-Method` is validated when
present, not required.**

## Carried forward

| what | why it did not ship | owner |
|---|---|---|
| The **webmail** console does not render `oauth_consents`. Connect claude.ai and the surface whose entire job is answering *"who can reach my mail"* shows nothing, unless you ask an agent | T4's guiding constraint ("the front door and the consent record ship together") was satisfied by the conversational console — `who_can_access` and `revoke_app` — which was enough to close the honesty gap, so the web view was never written. s03.E is archived and its `/console/*` projection has no consent shape (`services/jmap/src/console.ts` §"the wire shapes") | `.plans/s22-operator-surface/` **T1** (*"grants: read both directions"*) and **T2** (*"revoke where I am the target"*). s22's headline gap is, verbatim, *"nothing in a browser can answer 'who has access to my mail?'"* — and a connected third-party OAuth client is exactly that question. The surface already exists to hang it on: the Agents realm's Governance collection, where `AgentConsole` mounts (`webmail/src/pages/agents.astro:11-14`) |
| The legacy lane's **delete condition** is unmet and unwatched. Nothing polls for it | By design — it is a condition, not a task. But the condition is stated only in a file header, so it depends on someone re-reading that file at the right moment | `services/agent/src/mcpLegacy.ts:31-36` — *"When a Claude client completes `server/discover` … WITHOUT first sending `initialize`, delete this file and the one dispatch branch that calls it"* |

## Reachability

This is the section where "merged" and "reachable" came apart most visibly, and #145 is
the scar.

- **Deployed?** Two workers. `bullmoose-agent` serves `mcp.bullmoose.cc`
  (`services/agent/wrangler.jsonc:18`) and the new `bullmoose-oauth` serves
  `auth.bullmoose.cc` (`services/oauth/wrangler.jsonc:19`), both as Cloudflare custom
  domains. Both deploy from `.github/workflows/deploy-mail.yml` — **which is manual-only**,
  per its own header.
- **The oauth worker was in `bootstrap`'s order and in no CI step** until #145. The
  workflow now carries the reason inline (`deploy-mail.yml:77-82`): `agent` declares
  `OAUTH` as a service binding, and a service binding to a never-deployed worker fails the
  deploy that declares it. So the failure was loud rather than silent — but it was a
  *deploy* failure for a change that had merged green.
- **Migration applied?** Yes — `oauth-consents-table` (`infra/migrations.mjs:197`). The most
  recent `migrate.yml` run is **"Migrate — APPLY", success, 2026-08-19T02:58Z**. Note the
  two "DRY RUN (nothing applied)" runs immediately before it: `migrate.yml` defaulted to
  dry-run and went green while doing nothing, which #180 fixed by making APPLY the default
  and putting the mode in the run name.
- **Switched on?** Yes. No flags. `OAUTH_KV` is bound, `compatibility_flags:
  ["global_fetch_strictly_public"]` is set (`services/oauth/wrangler.jsonc:25`) — without
  it the provider will not advertise CIMD at all — and `MCP_RESOURCE_URI` / `OAUTH_ISSUER`
  are **stated** in `wrangler.jsonc` rather than derived from the request origin, because
  the `*.workers.dev` hostname stays live and a client discovering it would authorize
  against a resource URI nobody typed.
- **Verified live?** Yes, thoroughly, and re-verified during this sweep. 51/51 harness
  checks against production 2026-08-14; three real Claude clients completing real
  `tools/call`s 2026-08-14/15; and the four probes quoted in the ledger above, run
  2026-08-19. This is the best-verified section in the archive.

## Authority-surface delta

The largest *widening* in the repo's history, deliberately, and it is worth reading the
mitigations as carefully as the grant.

- **The `/mcp` route became public.** The `x-internal-token` network ACL came off
  (`services/agent/src/index.ts:112-124`), because a third-party client cannot hold a
  secret only we hold. The bearer was always the authentication; this removed a second
  lock on the same door.
- **A second credential system now authenticates a principal.** OAuth access tokens are
  validated by the AS over a service binding and turned into a `Principal`
  (`services/agent/src/index.ts:150-160`). The invariant that makes this affordable is
  stated at `mcp.ts:408-419`: **two credential systems, one authorization path.**
  `authorizeAccount`, the per-tool scope/domain gate and `grant_audit` are unaware of
  which credential arrived. A failed AS hop **refuses** rather than falling through to the
  local check — the fail-open bug, named and closed in the same comment.
- **Tokens that actually expire, for the first time.** Both `bm_` self-service mint sites
  omit `expires_at`, so a `bm_` token is a permanent credential. OAuth access tokens are
  ~1h with refresh rotation.
- **`vault` and `admin` are not OAuth-grantable.** `OAUTH_SCOPES`
  (`packages/auth-core/src/index.ts:228-238`) lists nine scopes and neither is among them
  — decision 4, held. Handing a third party the credential realm through a consent screen
  is not a default.
- **`send` remains absent from the tool surface**, and s02 made that invariant *more*
  load-bearing rather than less, because the caller is now a stranger.
- **Refusals added:** `401` + `WWW-Authenticate` (a `200 {isError:true}` never triggers an
  auth prompt in Claude, so the status code is load-bearing); `403` on a browser-shaped
  `Origin` that is not allowed; `405` on GET/DELETE at `/mcp`, the HTTP+SSE transport we
  never implemented; `invalid_grant` on refresh failure, because Claude keys on that exact
  code.

## Deviations from `devPlan.md` / `arch.md`

- **`readme.md`'s framing of the legacy shim is inverted, and was left in place on
  purpose.** Read the ⚠️ block at the top of `readme.md` before the body.
- **The `initialize` shim is a hedge with a delete condition, not a 12-month offramp.**
  `mcpLegacy.ts` implements *none* of the expensive parts of the old era — no HTTP+SSE, no
  `Mcp-Session-Id`, no resumability. `initialize` is a canned object, not a session
  constructor, which is the whole reason the hedge cost an adapter rather than a second
  server. Test 33 pins it: *"NEVER mints or echoes a session id — the whole point of the
  hedge."*
- **`Mcp-Method` is not enforced** — see the ledger.
- **T5 needed a dispatcher-level concept, not a default.** `whoami` is the discovery entry
  point, but the account gate ran *before* the tool, so the tool that tells you your
  account ids could not be called without one. `ToolDef.accountless` was the fix. The
  plan's framing ("default the accountId") would have left the two-account principal — the
  case where you most need `whoami` — still refusing.
- **The grant-reached fallback for the default was not written, because it is
  unreachable.** `principal.ts` resolves grants only when the principal already owns an
  account, since a grantee *is* an account. "Owns nothing" and "reaches nothing" are one
  state. Test 23 asserts the refusal rather than the fallback.
- **`Origin` is validated only when browser-shaped.** Absence is read as "not a browser,
  therefore not the DNS-rebinding attack", which is what lets claude.ai's cloud egress
  through while the spec's MUST is still honoured.
- **`auth.bullmoose.cc` became the login** (Eric, 2026-08-13) — a scope expansion the plan
  did not anticipate. `app.bullmoose.cc/login` asked a human to paste a `bm_` token they
  had to obtain some other way first; the AS takes email and password and does the
  translation, which is what an authorization server is for. `loginThrottle.ts` moved into
  `auth-core` in the same pass, because a shared security control reachable from one
  worker was the wrong shape. The interim door was deleted by s07 T7 (#191), not
  duplicated.

## Reversals

1. **s01 acceptance #1 — "`initialize`/`ping` return method-not-found" — reversed by T2.**
   Both answer now (`mcp.ts:482-490`). `mcp.test.ts:239` carries the inversion in its own
   title so nobody "fixes" it back. s01 was not wrong; s01 scoped a surface whose client
   we owned, and s02 changed who the client was.
2. **s01 decision D2 — keep `x-internal-token` as a network ACL on the MCP route —
   reversed by T1.** It came off `/mcp` and stays on `/drain` and `/internal/*`
   (`services/agent/src/index.ts:169`). Restoring it would make the public front door
   unreachable by every client it exists for.

## Absorbed / donated

**Absorbed from s01:** `verifyBearer`, the shared `authorizeAccount` decision, the MCP.2
transport and the `grant_audit` gate — all carried over unchanged, which is what let the
OAuth front door land without touching the token model.

**Absorbed from s03.E:** the consent screen's vocabulary. T4 explicitly reused
`effectiveScopes` — which expands the `mail` bundle through the *real* `hasScope` so the
explanation cannot drift from the gate — and the dangerous-combinations panel, rather than
writing a second vocabulary. `webmail/src/lib/console/scopes.ts:60-61`,
`scopes.test.ts:32` (~2,300 pairs checked against `@bullmoose/auth-core`'s real function).

**Donated:**

- To **s17**: the two-credential-systems-one-authorization-path shape at `mcp.ts:408-419`
  is what made a *third* credential (`bmi_` invocation tokens) land as a `Principal` and
  nowhere else.
- To **s07 T7 (#191)**: `auth.bullmoose.cc` is why the interim paste-a-token door could be
  deleted rather than maintained.
- To **`auth-core`**: #144 made the advertised OAuth scope list derive from one source and
  fail when it drifts. The audit that motivated it found **four** divergent copies of the
  scope list, one of which (`GRANTABLE_SCOPES`) silently omitted `vault` and `files`.

**Donated back to s01's folder:** the `readme.md` status note recording the reversal was
written by s02's author, not s01's. That is the pattern the archive index exists to make
routine.

## What grew stale during the build

- **`readme.md`'s scope bullet on the `initialize` shim** — stale before the first commit,
  labelled rather than deleted. See above.
- **`readme.md`'s build-vs-adopt section dated itself twice while being written.**
  `createMcpHandler` stopped being Cloudflare's (it graduated into
  `@modelcontextprotocol/server@2.0.0`; Cloudflare's `agents/mcp/server` is now a wrapper),
  and `McpAgent` was deprecated and feature-frozen. Both notes are in the file. The
  decision — adopt `@cloudflare/workers-oauth-provider` for the AS, keep the hand-rolled
  tool surface — survived both, because it was made on *what was missing* (no clients
  table, no authorization codes, no refresh concept, no consent record) rather than on
  which package was fashionable.
- **The devPlan's line numbers into `mcp.ts` are all wrong now.** It cites `mcp.ts:48`,
  `:274-292`, `:312-317`, `:340-344`. The file was ~350 lines then and is 850 now. The
  named constants and function names still resolve; the numbers do not.
- **T3's `GRANTABLE_SCOPES` finding is fixed** (#144) — the four copies are one source with
  a drift test.

## Traps for the next section

- **A conformance harness you wrote shares your assumptions.** T7 said this in advance and
  was proved right on itself within a day. If a spec has a client population, one real
  client is worth fifty-one self-authored checks — and the right move is to write both, in
  that order of *trust*, not that order of *effort*.
- **An error code is an API.** Answering a header mismatch with `-32600` instead of
  `-32020` is indistinguishable from a malformed body, and a client keys its retry on the
  code. Three of these were wrong on the modern lane before T2 read the spec against the
  file.
- **Envelope strictness that real clients do not share is a self-inflicted outage.** The
  era-detection bug and the `Mcp-Method` decision are the same lesson twice. Validate what
  disagreeing would break; refuse what nobody sends at your peril.
- **Two metadata flags, and missing either one silently downgrades you.** CIMD is selected
  only when the AS advertises `client_id_metadata_document_supported: true` **and** `"none"`
  in `token_endpoint_auth_methods_supported`. Miss one and Claude falls back to DCR without
  saying so — and DCR registers a fresh client on every connection, against a Workers KV
  free-plan ceiling of **1,000 writes to distinct keys per day**, every code, token, refresh
  and registration being a write. Nothing monitors that ceiling today.
- **A service binding is a deploy-order dependency, and CI will not infer it.**
  `services/oauth` merged and sat undeployed until #145; `agent` binds it, so the *agent's*
  deploy is what broke. Add the deploy step in the same PR as the binding.
