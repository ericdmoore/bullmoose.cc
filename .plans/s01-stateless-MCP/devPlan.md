# s01 — Stateless MCP: dev plan

> Ordered build for the [`arch.md`](./arch.md) design: internal `mailstore-analytics`
> MCP → pure MCP.2 (2026-07-28) + mcp-auth §6 auth gate. No new runtime deps
> (extend the hand-roll). Companion to [`readme.md`](./readme.md).
>
> **Guiding constraint:** transport port and auth gate ship *together* — a stateless
> server with per-request auth missing is worse than what we have.

---

## Tasks (in dependency order)

### T1 — Lift the verifier + authz into shared code  ·  *foundation*
**Files:** `packages/auth-core/src/index.ts` (+ new `authz` module — D3), consumers
`services/jmap/src/auth.ts:44`, `services/agent/src/vault.ts:41`.

- Add `verifyBearer(db, raw) → { principalId, email, scopes, accounts } | null`:
  `parseToken` → `tokens ⋈ principals` join → `verifyTokenSecret` → assemble owned
  accounts. This is the dedupe of the two existing copies.
- Re-home `accountAccess`, `matchingGrants`, and `requireAccount`
  (`jmap/methods/common.ts:28-62`) into the shared module so the agent worker imports
  the *same* code (grant resolution `jmap/auth.ts:127-169`, `:199-206`).
- Repoint jmap + vault at the shared functions; delete the duplicates.

**Done when:** jmap typechecks + existing jmap auth tests pass against the lifted
functions (pure refactor, no behavior change).

### T2 — MCP.2 transport in `mcp.ts`  ·  *the port*
**File:** `services/agent/src/mcp.ts`.

- `PROTOCOL_VERSION` → `"2026-07-28"`; `SUPPORTED = ["2026-07-28"]`.
- Validate `MCP-Protocol-Version` header **and** that it equals
  `_meta["io.modelcontextprotocol/protocolVersion"]` → else `400`.
- Unknown version → JSON-RPC `-32022` + `data.supported`, HTTP `400`.
- Require `_meta` `clientCapabilities`; malformed/missing → `-32602`/`400`.
- Add `server/discover` → `{ supportedVersions, capabilities:{tools:{}}, serverInfo,
  instructions }`.
- `tools/list` result gains `ttlMs` + `cacheScope`.
- **Remove** `initialize`, `ping`, `notifications/initialized`. Keep notifications →
  `202`. Unknown method → `-32601`/`404`.
- Enforce `Mcp-Name` == `params.name` on `tools/call`.

**Done when:** conformance client (T4) passes transport cases; no `initialize` path
remains.

### T3 — Auth gate in `handleMcp`  ·  *close the §6 hole*
**Files:** `services/agent/src/mcp.ts`, `services/agent/src/index.ts:56,68`.

- `handleMcp` reads `Authorization: Bearer …` → `verifyBearer` (T1) → principal;
  `401` if absent/invalid.
- For each `tools/call`, replace `requireAccountId` (`mcp.ts:37-42`) with
  `authorizeAccount(principal, args.accountId, "read", "mail")` → owned: scope only;
  granted: token ∩ grant + `grant_audit` INSERT; neither: `forbidden`, **no rows**.
- Thread the principal into `run(env, args)` (signature gains `principal`/ctx).
- Router (`index.ts:68`): `/mcp/analytics` no longer *identified* by `x-internal-token`
  — bearer is identity (D2 decides whether the internal-token network gate stays).

**Done when:** a token scoped to `a_eric` reads `a_eric`; the same token reading
`a_stranger` is `forbidden` and returns zero data; a granted token reads the granted
account **and** writes one `grant_audit` row.

### T4 — Conformance + auth test client  ·  *verification*
**Files:** `services/agent/test/mcp.spec.ts` (vitest/miniflare) + a curl script in
this folder.

Cases (all must pass):
| # | Input | Expect |
|---|---|---|
| 1 | valid `server/discover` | 200, `supportedVersions:["2026-07-28"]` |
| 2 | `tools/list` | 200, tools + `ttlMs` |
| 3 | missing `MCP-Protocol-Version` header | 400 |
| 4 | header ≠ `_meta` version | 400 |
| 5 | version `"2025-06-18"` | 400, `-32022`, `supported:["2026-07-28"]` |
| 6 | `initialize` | `-32601` / 404 (proves v1 is gone) |
| 7 | no `Authorization` | 401 |
| 8 | bearer for `a_eric` reads `a_eric` | 200, rows |
| 9 | bearer for `a_eric` reads `a_stranger` (no grant) | forbidden, **no rows** |
| 10 | granted bearer reads granted account | 200 + one `grant_audit` row |

**Done when:** green in CI; runbook curl script reproduces 1–10 against `wrangler dev`.

---

## Acceptance criteria (s01 complete)

1. `/mcp/analytics` speaks **only** MCP.2; `initialize`/`ping` return method-not-found.
2. Every `tools/call` is bearer-authenticated and `requireAccount`-authorized, with
   `grant_audit` on delegated reads — `mcp-auth §16.4` holds.
3. No self-asserted `accountId` trust remains.
4. No new runtime dependency; `mcp.ts` still a bounded, read-only, parameterized-query
   surface.
5. `npm run typecheck` clean; T4 suite green.

---

## Sequencing & dependencies

```
T1 (lift verifyBearer+authz) ──▶ T3 (auth gate) ──▶ T4 (tests)
T2 (transport port) ───────────▶ T4
T1 and T2 are independent; T3 needs T1; T4 needs T2+T3.
```
Downstream (NOT s01): per-invocation minted tokens (`mcp-auth §15.2`) and the harness
tool-loop that actually calls this server (`§15.3`). s01's server is correct ahead of
them; T4's test client stands in for the harness.

---

## Decisions needed

- **D1** — advertise `["2026-07-28"]` only. *Proposed: yes (pure MCP.2).*
- **D2** — keep `x-internal-token` as a network ACL on `/mcp/analytics`, or drop it for
  bearer-only? *Proposed: keep as defence-in-depth; bearer is the authz.*
- **D3** — shared authz home: extend `@bullmoose/auth-core`, or a new
  `@bullmoose/authz` package? *Proposed: `auth-core` — it already owns tokens+scopes;
  avoid a new package until the surface grows.*

---

## Estimate

Small–medium. T1 is a mechanical dedupe over code that already exists; T2 is a bounded
edit to a 222-line file; T3 reuses `requireAccount` wholesale; T4 is the bulk of the
new lines. No new deps, no new infra. Risk is concentrated in T1 (touching shared auth
used by JMAP) — gated by the existing jmap auth tests.

---

## Out of scope → s02 (public façade)

Public bullmoose-MCP over the JMAP capability set; OAuth 2.1 resource server +
`.well-known/oauth-protected-resource` + `WWW-Authenticate` + PKCE + **CIMD**; the
`initialize` compat shim for pre-MCP.2 third-party clients (12-month offramp); MRTR/
elicitation. Trigger: "the first non-bullmoose client appears" (`mcp-auth §7a`).
