# s01 — Stateless MCP: architecture

> Design for porting the **internal** `mailstore-analytics` MCP server to the
> 2026-07-28 stateless spec (**MCP.2**) and closing the mcp-auth §6 auth gap in the
> same pass. Companion to [`readme.md`](./readme.md) (why) and
> [`devPlan.md`](./devPlan.md) (steps). Grounded in `docs/architecture/mcp-auth.md`.
>
> **[live]** = exists (`file:line`); **[proposed]** = this plan.

---

## 1. Scope

**In.** `services/agent/src/mcp.ts` → pure MCP.2, principal-authenticated, per-tool
authorized, audited. **Out (→ s02):** the public JMAP façade, OAuth 2.1 / CIMD, the
`initialize` compat shim, MRTR/elicitation. This surface is consumed only by
bullmoose's own runtime, so we own both ends and can make a clean break.

Two changes travel together and neither ships alone:
- **Transport:** 2025-06-18-with-`initialize` → 2026-07-28 stateless.
- **Auth:** shared-secret + self-asserted `accountId` → per-request bearer ∩ grant.

The second is forced by the first: MCP.2 removes the handshake, so *"every request
must be independently authenticated and authorized"* (SEP-2575, Security
Implications). The auth gap stops being optional the moment the session is gone.

---

## 2. The wire contract [proposed]

One endpoint, `POST /mcp/analytics`, JSON-RPC 2.0, **one response per request, no
stream** (as today, `mcp.ts:11`).

**Request headers**
```
Authorization: Bearer bm_<id>_<secret>      # identity — NEW, mandatory
MCP-Protocol-Version: 2026-07-28            # mandatory; MUST equal _meta below
Mcp-Method: tools/call                      # routable (gateway/metering)
Mcp-Name: spend_by_month                    # required for tools/call
Content-Type: application/json
```

**Body** — JSON-RPC with per-request metadata:
```jsonc
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "spend_by_month",
    "arguments": { "accountId": "a_eric", "months": 6 },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",   // MUST match header
      "io.modelcontextprotocol/clientCapabilities": {},          // required
      "io.modelcontextprotocol/clientInfo": { "name": "bullmoose-harness", "version": "1" }
    } } }
```

**Server MUST**
- Reject header/`_meta` version mismatch → `400`.
- Reject unknown/unsupported version → `400`, JSON-RPC error `-32022`
  (`UNSUPPORTED_PROTOCOL_VERSION`) with `data.supported = ["2026-07-28"]`.
- Require `clientCapabilities` (never infer from prior requests — there are none).
- Implement `server/discover`; return `-32601` / `404` for unknown methods.
- Put `ttlMs` + `cacheScope` on `tools/list`.
- Answer notifications with `202`, no body.

**Removed vs today:** `initialize`, `notifications/initialized`, `ping`. No
`Mcp-Session-Id`, ever.

### Method set

| Method | Notes |
|---|---|
| `server/discover` | **MUST** — returns `supportedVersions:["2026-07-28"]`, `capabilities:{tools:{}}`, `serverInfo`, `instructions` |
| `tools/list` | as today + `ttlMs`/`cacheScope`; `tools` array unchanged |
| `tools/call` | as today + auth gate (§3); `Mcp-Name` MUST match `params.name` |
| *(notifications/\*)* | `202` |
| ~~`initialize`~~ ~~`ping`~~ | **removed** |

---

## 3. Auth model — the real work [proposed]

Today (`mcp-auth §4`, `mcp.ts:37-42`, `index.ts:56,68`): one shared `x-internal-token`
gates the route; each tool trusts a **self-asserted** `accountId`. Any holder of the
platform secret reads any account. MCP.2 makes this indefensible.

**Target flow, per request:**

```
POST /mcp/analytics  (Authorization: Bearer …)
  1. verifyBearer(DB, raw) → { principalId, email, scopes, accounts }   [lifted, §5]
        └ 401 if absent/invalid
  2. dispatch by method
  3. for tools/call:  authorizeAccount(principal, args.accountId, "read", "mail")
        ├ owned account → scope check only
        ├ granted       → token ∩ grant, domain-checked, + INSERT grant_audit
        └ neither       → forbidden (no rows leak)
  4. run the bounded query, return content
```

`authorizeAccount` is `requireAccount` (`services/jmap/src/methods/common.ts:28-62`)
re-homed so the agent worker can call it: `accountAccess` → `principalHasScope` →
`matchingGrants` → **write `grant_audit`** (identical INSERT to `common.ts:48-59`).
`accountId` stays an argument but becomes *authorized*, never *trusted*.

**Scope:** analytics reads the message log + spend ledger → require **`read`**. Mind
the trap (`mcp-auth §6.3`): `hasScope` treats `mail` as a superset of everything but
`admin` (`auth-core:50-53`), so a `mail` token already satisfies `read` — fine here;
only special-case if we later want a separable `analytics` scope.

**`x-internal-token`:** demoted from *identity* to an optional coarse **network ACL**
(defence-in-depth for an internal-only route). Identity + authorization now come from
the bearer. *(Decision D2 — keep it or drop it.)*

This makes `mcp-auth §16` invariant #4 ("MCP calls are principal-scoped") true.

---

## 4. Why stateless is safe & scalable here

- **Pure function.** `handleMcp` holds no cross-request state; each call gets a fresh
  `Response`. Any worker instance answers any request — the SEP-2575 scalability win,
  for free, because we were already sessionless.
- **Immune to the shared-instance leak.** SDK 1.26.0's stateless CVE (one client's
  response leaking to another via a shared server instance) can't occur — there is no
  shared instance to leak through.
- **Auth is per-request by construction**, which is exactly what MCP.2 demands.

---

## 5. Shared-code moves (enables the agent worker to enforce) [proposed]

The authz primitives live in the **jmap** worker; the MCP lives in the **agent**
worker. To enforce identically without a cross-worker hop, lift into shared code
(`mcp-auth §6.1`):

| Move | From | To |
|---|---|---|
| `verifyBearer(db, raw) → {principalId,email,scopes,accounts}` | dup'd `jmap/auth.ts:44` + `agent/vault.ts:41` | `@bullmoose/auth-core` (new export beside `parseToken`) |
| `accountAccess`, `matchingGrants`, `requireAccount` | `jmap/src/auth.ts` + `methods/common.ts` | a shared authz module both workers import |

Net: **one** bearer→principal→grant path, used by JMAP and MCP alike. Removes the
existing duplication as a bonus.

---

## 6. Client side (context, not in s01)

The consumer is the harness tool-loop (`mcp-auth §2`), which is **greenfield** — the
runtime "runs no tools yet" (`mcp-auth §4`; `index.ts` is template-mode reply only).
So s01 ships the **server** + a **conformance test client**; wiring the real harness
to mint a per-invocation token (`mcp-auth §15.2`) and drive `tools/call` is downstream
and out of scope. When it lands, its MCP client must be MCP.2-native: per-request
headers/`_meta`, `server/discover` instead of `initialize`, no session.

---

## 7. Invariants this establishes

- **§16.4** MCP calls resolve a principal via `verifyBearer` and authorize the target
  via `requireAccount` (token ∩ grant), writing `grant_audit`. No self-asserted
  `accountId`. ✅ after s01.
- **New:** per-request auth cannot be bypassed by the (now absent) init phase.
- **Unchanged & preserved:** no free-form SQL crosses the boundary (bounded,
  parameterized tools, `mcp.ts:6-8`); read-only surface.

---

## 8. Decisions (see devPlan §Decisions)

- **D1** protocol strings advertised: `["2026-07-28"]` only (pure MCP.2).
- **D2** keep `x-internal-token` as a network ACL, or drop it for bearer-only?
- **D3** where the shared authz module lives (`auth-core` vs a new `@bullmoose/authz`).
