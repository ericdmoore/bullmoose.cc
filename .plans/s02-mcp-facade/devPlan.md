# s02 — Public MCP façade: dev plan

> **Status: T1–T6 LANDED and LIVE; T7 harness 51/51 against production** (2026-08-14,
> PRs #108 #110 #112 + the revocation PR). `mcp.bullmoose.cc` and `auth.bullmoose.cc` are
> deployed with custom domains; the full PKCE S256 dance runs headlessly end to end as the
> e2e principal (`e2e@bullmoose.cc`, "Chewbacca"), ending in a real `tools/call` — and, as
> of the revocation build, ending in a real DISCONNECT: `POST /revoke` on the AS (owner's
> `bm_` credential only, self-authenticated, safe on the public hostname) kills every
> token under the grant before the grant itself, mirrored to D1 in the same request, with
> `revoke_app` as the conversational console's face for it. What remains OPEN:
> - ~~**A real Claude client completing a `tools/call`**~~ **DONE, three times over**
>   (2026-08-14/15): claude.ai (CIMD, web redirect), Claude Code on the homelab box (DCR,
>   `127.0.0.1` paste-the-callback), and Claude Code on the laptop (CIMD, native
>   `localhost:<ephemeral>` loopback) all completed real tool calls — every redirect
>   policy and both client-identification methods proven by real clients. The first
>   client also found a real bug the 51-check harness could not (the era-detection fix,
>   PR #126): its fake legacy client omitted the header every real 2025 client sends —
>   T7's "no harness substitutes for a real client" rationale, demonstrated on its
>   author. First real use of the surface was agent fact-finding across agents: it
>   noticed an agent gone quiet, audited another agent's YoY claim against the raw
>   ledger, and flagged the front-matter steering channel — unprompted. **s02 is
>   functionally complete**; only the two decision sign-offs below remain.
> - **Decision 1** (all tools public vs. trimming introspection) — left permissive on the
>   fact-finding-across-agents rationale; needs Eric's sign-off.
> - **`Mcp-Method` REQUIRED vs. validated-when-present** — still flagged, not decided.
> - T3's "wrong-resource token rejected" is met by the provider pinning `resource` (a
>   cross-resource token cannot be minted here) plus unit tests on `audienceMatches` —
>   not by a live cross-resource presentation, which pinning makes impossible.
> - T4's "console renders the consent" is the conversational console (`who_can_access` /
>   `revoke_app`); the s03.E web view does not render `oauth_consents` yet.
>
> Build deltas from the first wave (2026-08-13), kept for the record:
> - **The `initialize` test inverted**, exactly as this plan predicted — `mcp.test.ts` 6
>   asserted the handshake was dead and now asserts it is alive and legacy. That inversion
>   is the signal T2 landed.
> - **T5 needed a dispatcher-level concept, not just a default.** `whoami` is the discovery
>   entry point, but the account gate ran *before* the tool, so the tool that tells you your
>   account ids could not be called without one. `ToolDef.accountless` (whoami only) skips
>   the token ∩ grant check while keeping the scope check. Without it, defaulting still
>   refuses on a two-account principal — the exact case where you most need whoami.
> - **The grant-reached fallback for the default is unreachable**, so it is not written:
>   `principal.ts:149` resolves grants only when the principal already owns an account,
>   because a grantee *is* an account. "Owns nothing" and "reaches nothing" are one state.
> - **`MCP_RESOURCE_URI` / `OAUTH_ISSUER` are stated in `wrangler.jsonc`, not derived.**
>   Deriving from the request origin is right for one hostname and wrong the moment the
>   worker answers on two — the `*.workers.dev` URL stays live, and a client discovering
>   `https://bullmoose-agent.<acct>.workers.dev/mcp` would authorize against a resource URI
>   nobody typed. The derivation survives as a dev fallback only.
> - **`Origin` is validated only when browser-shaped** (present, parseable, not `null`), and
>   absence is treated as "not a browser, therefore not the DNS-rebinding attack" — which is
>   what lets claude.ai's cloud egress through while the spec's MUST is still honoured.
> - **`auth.bullmoose.cc` IS the login** (Eric, 2026-08-13). `app.bullmoose.cc/login` was
>   always interim: it asks a human to paste a `bm_` token, which is a credential they had
>   to obtain some other way first. The AS takes email + password and the OAuth flow does
>   the translation into a system token — which is what an authorization server is *for*,
>   and why the interim door gets deleted (`s07` T7) rather than duplicated. The password
>   never reaches the server: the browser derives a `loginKey` (auth-core's client-side
>   600k-iteration PBKDF2) and the server compares one SHA-256, exactly as `/auth/login`
>   does — cheap by design, which is why the same `beginLoginAttempt` throttle applies.
>   `loginThrottle.ts` moved to `auth-core` for that; a shared security control reachable
>   from only one worker was the wrong shape.
> - **⚠️ Open decision — `Mcp-Method` is validated when present, NOT enforced as required.**
>   The spec says REQUIRED; enforcing it would break every existing caller including
>   `tools/e2e-*.mjs`, and contradicts this plan's own "byte-identical except the three
>   corrected codes" done-condition. Flagged rather than decided.
>
> Ordered build for making `bullmoose-mcp` connectable by a client that is **not ours** —
> claude.ai, Claude Desktop, Claude Code, Codex. Companion to [`readme.md`](./readme.md).
>
> **The trigger has fired.** `readme.md` gates this section on *"the first non-bullmoose
> client appears."* That is now the stated goal, so this plan is live.
>
> **Guiding constraint:** the front door and the consent record ship *together*. A public
> MCP endpoint whose grants are invisible to `s03.E`'s console is worse than no public
> endpoint, because the surface whose entire job is answering *"who can reach my mail"*
> would start lying by omission.

---

## The finding that reorders this plan

`readme.md` scopes the `initialize` compat shim as a *courtesy* — "a thin legacy responder
so pre-MCP.2 third-party clients still connect **during the 12-month offramp**", to be
"dropped at offramp end."

**That is backwards.** Anthropic's connector documentation lists the supported auth
specifications as **2025-03-26, 2025-06-18 and 2025-11-25**. `2026-07-28` is not among
them, and the testing guide still documents clients identifying themselves "in the MCP
`initialize` handshake via `clientInfo`". The same infrastructure backs claude.ai, Desktop,
mobile, Code and Cowork.

`services/agent/src/mcp.ts:48` sets `SUPPORTED_VERSIONS = ["2026-07-28"]`, single element,
and `initialize` falls to `default` → `-32601`/404 (`mcp.ts:320-321`, pinned by
`mcp.test.ts:234-244`).

So today **claude.ai cannot complete a handshake with this server at all.** The spec
explicitly blesses serving both: *"A dual-era server MAY serve both eras concurrently on the
same endpoint or process."*

### But MCP.2 stays the primary lane, and that is the right bet

The strategic call for this section is **build to 2026-07-28 and treat the legacy lane as a
deletable adapter** — not "support two protocols."

That is not optimism, it is where the repo already is: s01 did the hard part. `mcp.ts` is
already stateless, already per-request-authenticated, already has `server/discover`, already
mints no session ids. Anthropic have shipped the spec and say support is "rolling out across
Claude products soon." Building *toward* the old era would be the strange decision.

What makes the hedge cheap is that the two eras differ in almost nothing that costs us
anything:

| legacy needs | cost here |
|---|---|
| `initialize` → capabilities | return a canned object; **no session** |
| `notifications/initialized` | already 202 (`mcp.ts:267-269`) |
| `ping` → `{}` | three lines |
| header/`_meta` mirroring optional | one conditional |
| `clientCapabilities` optional | one conditional |
| HTTP+SSE, `Mcp-Session-Id`, resumability | **refused — never build these** |

That last row is the whole discipline. The expensive parts of the old era are exactly the
parts 2026-07-28 removed, and T2 does not build any of them: GET/DELETE stay `405`, a
session id is ignored rather than echoed, `Last-Event-ID` is ignored. What remains is an
adapter, not a second implementation.

**Delete when:** a Claude client completes `server/discover` against this server without
first sending `initialize`. At that point remove `mcpLegacy.ts` and one dispatch branch —
which is why T2 must not touch the modern lane's behaviour at all beyond the three
conformance fixes below. If the shim ever starts leaking conditionals into `handleMcp`, that
is the signal it was built wrong.

**Skip T2 entirely if** the first client is one you control (a custom Codex integration, the
MCP SDK v2 client, anything built on `@modelcontextprotocol/client@2`). Those speak MCP.2
today, and then the legacy lane buys nothing. It is *only* required for claude.ai / Claude
Desktop / Claude Code as they ship right now.

> **Do not plan against a date, in either direction.** Anthropic's announcement says only
> "rolling out soon" — there is no published date for any Claude product, and no stated
> deprecation date for 2025-11-25. Build MCP.2, keep the adapter deletable, and let the
> observed handshake decide when it goes.

---

## Build vs adopt — decided: **adopt**

`readme.md` defers this ("Decide at s02 kickoff"). Deciding: adopt
**`@cloudflare/workers-oauth-provider`** for the authorization server, keep the hand-rolled
tool surface.

s01 chose "extend the hand-roll" for a tiny internal surface, and that was right. It is not
right here, because the audit found the OAuth primitives are **all** missing, not some:

| needed | exists today |
|---|---|
| client registration (`oauth_clients`, redirect URIs) | **nothing** — no table, no `client_id` anywhere |
| authorization codes (short-lived, single-use) | **nothing** |
| refresh tokens | **nothing** — `tokens.kind` has one live value, `'bearer'` |
| token expiry | column exists; **both self-service mint sites omit it** (`authRoutes.ts:106`, `:178`) |
| consent record | `grants` is account→account, both FKs `NOT NULL` — cannot express "principal P authorized client C" |
| PRM / AS metadata / JWKS | **nothing** |

`workers-oauth-provider` implements OAuth 2.1, PKCE (S256 default, plain rejected), RFC 9728
PRM served automatically at both well-known paths, RFC 9207 `iss` always on, RFC 8707
resource indicators, RFC 7009 revocation, CIMD against the exact draft the 2026-07-28 spec
pins, and stores every token and code **hashed**. Writing that by hand is a security-critical
project of its own with no bullmoose-specific content.

**What we do NOT adopt:** the MCP handler. `createMcpHandler` would replace `mcp.ts`
wholesale and take the per-tool `scope`/`domain` gate, the `grant_audit` writes and 119
tests with it. The seam is `OAuthProvider`'s `apiHandler` + `props`: the provider owns the
front door, hands us a validated principal, and `handleMcp` keeps doing exactly what it
does. Two token systems, deliberately — see T4.

---

## Tasks (in dependency order)

### T1 — The public route, and a 401 that teaches · *front door*

**Files:** `services/agent/wrangler.jsonc`, `services/agent/src/index.ts:56-72`, new
`services/agent/src/wellKnown.ts`.

- **Custom domain.** The agent worker declares no `routes` and no `custom_domain` — it is
  `workers.dev` only; `anglebrackets` (`dav.bullmoose.cc`) is the sole service in the repo
  with one. Add `mcp.bullmoose.cc`. The canonical resource URI is then
  `https://mcp.bullmoose.cc/mcp` — RFC 8707 requires scheme, forbids a fragment, and prefers
  no trailing slash.
- **Rename the path off `/analytics`.** Keep `/mcp/analytics` answering as an alias; nothing
  external pins it yet, but the e2e harness does. `serverInfo.name` stays
  `bullmoose-mailstore-analytics` — `mcp.ts:299-302` explains why, and that reasoning holds
  harder once clients really do pin it.
- **Lift the `x-internal-token` wrapper off `/mcp` only.** `/drain` and `/internal/*` keep
  it. This is a coarse network ACL, never the authentication — per-request bearer auth
  (`mcp.ts:251-254`) already stands alone and is tested to 401 without a bearer and `-32004`
  cross-account. Removing the wrapper weakens nothing; it stops requiring a secret only we
  hold.
- **Replace the 404 with a 401 that points somewhere.** Today an unauthenticated request
  falls to `index.ts:78` → `404 bullmoose-agent`, deliberately opaque. That must become:

  ```http
  HTTP/1.1 401 Unauthorized
  WWW-Authenticate: Bearer error="invalid_token",
                    resource_metadata="https://mcp.bullmoose.cc/.well-known/oauth-protected-resource/mcp"
  ```

  **The 401 is load-bearing:** Anthropic's docs state Claude does not honour
  `WWW-Authenticate` on a 200, and that a `200 {isError:true}` is read as an application
  error and passed to the model — no auth prompt, ever.
- **Serve RFC 9728 PRM at BOTH paths** — `/.well-known/oauth-protected-resource/mcp` (path
  insertion, §3.1: the path is inserted between host and well-known suffix, not appended)
  and the root form. Clients probe path-suffixed first. Minimum body is `resource` +
  `authorization_servers`; MCP makes the latter mandatory on top of RFC 9728, which requires
  only `resource`. Add `bearer_methods_supported: ["header"]` and `scopes_supported`.
  ⚠️ `resource` **must equal the URL the user types into Claude, exactly**, path and all.
  ⚠️ Claude uses the **first** `authorization_servers` entry and does not fall back — list one.
- **`Origin`, not CORS.** claude.ai connects from Anthropic's cloud, not the user's browser,
  so CORS is irrelevant and the documented trap is *overly strict* `Origin` validation
  rejecting them. This collides head-on with the MCP spec's "servers **MUST** validate the
  `Origin` header to prevent DNS rebinding." Resolve deliberately: validate `Origin` only
  when present *and* browser-shaped, and allowlist Anthropic egress `160.79.104.0/21` — on
  the AS as well as the MCP server, since a WAF in front of the AS breaks the flow while the
  MCP endpoint looks fine.

**Done when:** `curl https://mcp.bullmoose.cc/mcp` with no credential returns 401 carrying a
`resource_metadata` URL that resolves to a valid PRM document naming our AS; the same
request with a valid `bm_` bearer still works; `/drain` and `/internal/*` still 404 without
the internal token.

### T2 — The legacy `initialize` adapter · *a hedge with a delete condition*

**Files:** `services/agent/src/mcp.ts`, new `services/agent/src/mcpLegacy.ts`.

Dual-era dispatch, decided by how the client opens (spec: a request carrying modern
per-request `_meta` is served statelessly; an `initialize` request selects legacy semantics).

- **`initialize` → a real response**, advertising `protocolVersion: "2025-11-25"`,
  `capabilities: { tools: {} }`, the same `serverInfo`. Accept
  `notifications/initialized` → 202. Accept `ping` → `{}`. None of this needs session state:
  the server is stateless either way, which is exactly why the shim is cheap.
- **Relax the two non-standard per-request requirements on the legacy lane.** Today
  `mcp.ts:274-292` requires the `MCP-Protocol-Version` header to be **byte-equal** to
  `params._meta[…protocolVersion]`, *and* requires `clientCapabilities` on every request. A
  2025-era client sends neither. On the legacy lane both must be optional. On the modern lane
  both stay mandatory — that is the spec.
- **Fix three conformance defects in the modern lane** (found while reading the spec against
  `mcp.ts`, all currently wrong):
  | condition | we return | spec says |
  |---|---|---|
  | header ≠ `_meta` version | `-32600` (`mcp.ts:279`) | **`-32020` HeaderMismatch** |
  | missing `clientCapabilities` | `-32602` (`mcp.ts:291`) | **`-32021` MissingRequiredClientCapability** |
  | `Mcp-Method` header | not read at all | **REQUIRED**, validate against body, `400`/`-32020` |
  `-32022` is already correct (`mcp.ts:51`).
- **Never implement HTTP+SSE.** It has been deprecated since 2025-03-26 and 2026-07-28
  removed the GET stream entirely. GET/DELETE on the endpoint → `405`. An `Mcp-Session-Id` on
  a request → **ignore it, and never mint or echo one**. `Last-Event-ID` → ignore.

**Done when:** a stock 2025-11-25 client completes `initialize` → `tools/list` →
`tools/call` end to end; the modern `_meta` lane is byte-identical to today except the three
corrected codes; `mcp.test.ts:234-244` (which currently asserts `initialize` is *dead*) is
rewritten to assert it is *alive and legacy* — that test inverting is the signal this task
landed.

### T3 — OAuth 2.1 authorization server · *the front door proper*

**Files:** new `services/oauth/` (worker), `packages/mailstore/sql/control-plane.sql`,
`infra/bootstrap.mjs` (`DEPLOY_ORDER`, `GENERATED`), `infra/migrations.mjs`.

- **A separate worker.** Not `provision` (single shared `ADMIN_TOKEN`, no principal, wrong
  blast radius) and not `jmap` (hot path; an AS outage should not take mail down). It needs
  `OAUTH_KV` — the binding name is fixed by the library — plus
  `compatibility_flags: ["global_fetch_strictly_public"]`, without which the provider will
  **not** advertise CIMD support at all.
- **Advertise both CIMD signals or lose CIMD.** Claude selects CIMD only when the AS metadata
  carries **both** `client_id_metadata_document_supported: true` **and** `"none"` in
  `token_endpoint_auth_methods_supported`. Miss either and it silently falls back to DCR —
  which Anthropic themselves advise against, because DCR registers a fresh client on every
  connection. Keep DCR enabled as a backstop, deprecated-but-permitted.
- **Redirect URIs.** Register `https://claude.ai/api/mcp/auth_callback` (web, Desktop, mobile,
  Cowork). For Claude Code, accept `http://localhost/callback` **and**
  `http://127.0.0.1/callback` **with the port component ignored** — its CIMD declares no
  port. RFC 8252 §7.3 mandates port-agnostic matching for the IP-literal form; apply it to
  `localhost` too, which RFC 8252 §8.3 discourages but Claude Code requires.
- **Audience binding.** Honour the `resource` parameter and set `aud` to it. Sending
  `resource` is the client's obligation; *honouring* it is ours, and the spec is explicit
  that RFC 8707 protects against replay only "when the Authorization Server supports the
  capability." `handleMcp` must reject any token whose `aud` is not our canonical resource URI.
- **One canonical scope list.** The audit found **four** divergent copies: `TOKEN_SCOPES` /
  `SELF_SERVICE_SCOPES` (`auth-core/src/index.ts:133,149`), `GRANTABLE_SCOPES`
  (`provision/src/index.ts:1472`, which silently omits `vault` and `files`), the CLI mirror
  (`packages/cli/src/scopes.ts:17-27`), and the webmail mirror
  (`webmail/src/lib/console/scopes.ts:60-83`). An OAuth `scope` parameter needs exactly one.
  Make `auth-core` the source and have the rest assert against it — the CLI already has a
  drift test to copy.
- **Token lifetimes.** OAuth access tokens short (~1h) with refresh rotation. This is the
  first place in the system where a token genuinely expires: both self-service `bm_` mint
  sites omit `expires_at` entirely, so a `bm_` token today is a permanent credential.
  Refresh failures **must** return `invalid_grant` — Claude keys on that exact code.
- ⚠️ **Free-plan ceiling.** Workers KV allows **1,000 writes to distinct keys per day**, and
  every code, token issuance, refresh rotation and DCR registration is a write. Fine for
  personal use; the first thing to watch if this is ever shared. Another argument for CIMD
  over DCR.

**Done when:** `/.well-known/oauth-authorization-server` validates; a scripted PKCE S256
authorization-code flow yields an access token; that token is accepted by `/mcp` and a token
minted for a *different* `resource` is rejected.

### T4 — The principal bridge, and consent the console can see · *the trust seam*

**Files:** `services/oauth/src/consent.ts`, `services/agent/src/mcp.ts`,
`packages/mailstore/sql/control-plane.sql`, `webmail/src/lib/console/`.

**Two token systems, deliberately.** `bm_` tokens stay for CLI, webmail and JMAP; OAuth
tokens are minted and stored by the provider in KV. They meet at one point: when consent is
granted we know the principal, and we put `principalId` into the provider's encrypted
`props`. `handleMcp` accepts *either* a `bm_` bearer (today's path, unchanged) or a
provider-validated principal from `props`. Everything downstream — `authorizeAccount`, the
per-tool `scope`/`domain` gate, `grant_audit` — is untouched.

This is what lets us adopt the AS without touching the token model, and it sidesteps every
"no refresh concept / no code store / tokens never expire" blocker in one move.

- **The consent screen is the product.** It must say what the scopes *do*, not name them.
  `s03.E` already built exactly this: `effectiveScopes` expands the `mail` bundle **through
  the real `hasScope`** so the explanation cannot drift from the gate, and the
  dangerous-combinations panel already knows that `send` + a live Bureau `fetch` grant is the
  readme's own exfiltration path. Reuse it; do not write a second vocabulary.
  ⚠️ Show the **redirect URI hostname** — the spec requires it, and CIMD cannot by itself
  prevent `localhost` impersonation.
- **Mirror the consent into D1.** The provider stores grants in KV. `s03.E`'s console reads
  D1. Left alone, a user who connects claude.ai sees *nothing* in the surface built to answer
  "who can reach my mail" — the exact failure `.feedback` 037 was about, one layer up. A new
  `oauth_consents` table (new table, not new columns on `grants`, whose two `NOT NULL`
  account FKs cannot express client consent) written on grant and on revoke, and a
  `who_can_access` branch that reads it.
- **`send` stays absent.** There is no send tool and that is an invariant, not an omission
  (`emailTools.ts:68-90`, pinned by `mcpTools.test.ts:124-128`). It gets *more* load-bearing
  the moment the caller is a third party, not less.

**Done when:** consenting through claude.ai produces a row the console renders in the
per-agent view; revoking in the console kills the OAuth token; a scope the token does not
carry still yields `-32004` with the existing message.

### T5 — `accountId`, the sleeper blocker · *usability, and it is not optional*

**Files:** `services/agent/src/mcp.ts:340-344`, `services/agent/src/introspectTools.ts:158`.

Every `tools/call` hard-requires an `accountId` argument (`mcp.ts:341-344` → `-32602`
"accountId is required"), and there is **no server-side default**. Even `whoami` requires one
(`introspectTools.ts:158-160`).

A third-party client has no way to learn a bullmoose account id — they are
`t_<tenant>__a_<uuid>`, they appear in no discovery document, and the tool that would tell
you needs one to answer. **A model will guess, fail, and give up.**

- Default `accountId` to the principal's single owned account when omitted; error only when
  the principal owns several, and *name them* in the error so the next call can succeed.
- `whoami` must work with no arguments. It is the discovery entry point.
- Keep the existing rejection of self-asserted account ids (`mcp.ts:347`) — defaulting is
  server-side resolution, never trusting a client-supplied id.

**Done when:** a fresh client can call `whoami` with `{}`, learn its accounts, and every
single-account principal can drive every tool without ever passing `accountId`.

### T6 — Third-party tool surface · *decide what a stranger sees*

**Files:** `services/agent/src/mcp.ts:312-317`, `mcpTools.test.ts`.

- **Publish `scope` in `tools/list`.** It is stripped today (`mcp.ts:314`), so a client
  cannot pre-filter to tools its token can actually use and learns only by eating a 403. For
  our own client that was fine; for a stranger it is a bad first impression and wasted turns.
- **Decide the public subset.** 29 tools is a lot to hand a stranger. The 7 introspection
  tools are arguably ours, not theirs. This is a judgement call, not a technical one —
  flagged in Decisions.
- **Tool-result caps are real:** ~150,000 characters (claude.ai/Desktop), ~25,000 tokens
  (Code). `email_get_body` on a large message can exceed that. Truncate with an explicit
  marker rather than being cut off mid-JSON.

**Done when:** `tools/list` carries `scope`; the published set is explicit in code with a
test asserting exactly which tools a public token can see.

### T7 — Conformance harness against a real client · *verification*

**Files:** `tools/e2e-mcp-public.mjs`, extending the shape of `tools/e2e-grants.mjs`.

- Drive the **full** OAuth dance headlessly: PRM discovery → AS metadata → CIMD → PKCE S256
  → code → token → `tools/call`. Assert RFC 9207 `iss` is present and correct.
- Assert both eras against the same endpoint: legacy `initialize` and modern `_meta`.
- Assert the refusals, which is where conformance actually bites: wrong `aud` rejected; a
  token for another resource rejected; `-32020` on header mismatch; missing PKCE refused.
- **Then connect claude.ai for real.** No harness substitutes for it, and the failure modes
  the docs warn about — a 10s discovery timeout, a 415 from a token endpoint that only reads
  JSON, `Origin` rejection — are all invisible to a self-written client that happens to make
  the same assumptions we did.

**Done when:** the harness passes, and a real Claude client has completed a `tools/call`.

---

## Sequencing & dependencies

```
T1 route + PRM ──┬─→ T3 OAuth AS ──→ T4 principal bridge + consent ──┬─→ T7 conformance
                 │                                                   │
T2 legacy lane ──┘                   T5 accountId ──────────────────-┤
                                     T6 tool surface ────────────────┘
```

- **T1 and T2 are independent and both unblock everything.** T2 has no dependency on OAuth at
  all — a legacy client with a `bm_` bearer works the moment T2 lands. That is the cheapest
  possible first proof that a real client can talk to this server.
- **T2 is the one task that may be skipped**, if the first client speaks MCP.2 (anything on
  `@modelcontextprotocol/client@2`). It is required only for Claude clients as they ship
  today, and it is designed to be deleted rather than maintained.
- **T5 is independent of all of it** and is worth doing first regardless: it improves our own
  client today and it is a hard blocker for any third party.
- T4 must not lag T3 into production. An OAuth grant invisible to the console is the failure
  this plan's guiding constraint exists to prevent.

## Decisions needed

1. **Which tools does a stranger get?** All 29, or mail+calendar+contacts minus the 7
   introspection tools? Introspection answers "who can reach my mail" — arguably a question
   for the owner's console, not for a connected agent. *Recommendation: publish all but
   `access_log`; being able to ask an agent "what have you been doing" is worth more than the
   marginal exposure, and every one of them is read-scoped.*
2. **Does `mcp.bullmoose.cc` serve the AS too, or a separate host?** Separate is cleaner for
   blast radius; same-host is one fewer certificate and one fewer thing to allowlist for
   Anthropic egress. *Recommendation: separate worker, `auth.bullmoose.cc`.*
3. **Keep `/mcp/analytics` as a permanent alias or sunset it?** Nothing external pins it yet.
   *Recommendation: keep it — it costs one line, and the e2e harness and four plan docs
   reference it.*
4. **Is `vault` ever an OAuth-grantable scope?** `GRANTABLE_SCOPES` already omits it, so
   account→account grants cannot confer it today. *Recommendation: keep it un-grantable —
   handing a third party the credential realm through a consent screen is not a thing to do
   by default.*

## Estimate

| task | size | note |
|---|---|---|
| T1 route + PRM + 401 | **S** | mostly config; the PRM document is small |
| T2 legacy adapter | **S–M** | ~30 lines of adapter; the M is the care needed not to leak conditionals into the modern lane |
| T3 OAuth AS | **L** | new worker, new binding, new deploy step — but adopted, not written |
| T4 bridge + consent + D1 mirror | **L** | the consent UI is real product work |
| T5 accountId | **S** | small, and independently valuable |
| T6 tool surface | **S** | one judgement call, then mechanical |
| T7 conformance | **M** | the OAuth dance headless is fiddly |

## Out of scope

- **Elicitation / URL mode.** MCP auth covers client→our server; URL-mode elicitation is for
  *our server → a third-party API*, and the spec is explicit that servers **MUST NOT** rely
  on it to authorize users for themselves. If bullmoose needs it later that is Bureau
  territory (`s04`), not this.
- **MRTR.** Only needed once a tool requires mid-call user input. No current tool does, and
  `requestState` would have to be HMAC'd and TTL'd as attacker-controlled input.
- **Sampling / roots / resource subscriptions.** Claude does not support them.
- **`client_credentials` / M2M.** Not supported by Claude: every connection requires user
  consent.
