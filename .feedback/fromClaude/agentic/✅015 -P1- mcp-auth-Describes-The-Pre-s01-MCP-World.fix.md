# FIX — 015 -P1- `mcp-auth.md` describes the pre-s01 MCP world

## Proposal

A retag pass plus one new section. The document's `[live]`/`[proposed]` convention is good — it just
needs applying to what shipped.

### 1. Rewrite §4 "Where we are today"

Replace the "no caller identity" framing with the current posture:

> **Baseline.** The analytics MCP authenticates **per request** (`verifyBearer`, `mcp.ts:170`) and
> authorizes each `tools/call` against the **target** account via `authorizeAccount` (token ∩ grant,
> `mcp.ts:257`), writing `grant_audit` on delegated reads (`:262`). The self-asserted `accountId` is
> gone. `x-internal-token` remains at the router (`index.ts:56,68`) as a coarse network ACL, not as
> identity.
>
> **The remaining gap:** the runtime still runs **no tools** — `AgentConfig`
> (`packages/cli/src/agent.ts:39-50`) has no `tools`/`mcpServers`, and `callModel` (`:234-284`) is a
> single non-looping call. So the tool-injection layer (§8) is still greenfield.

Keep `:175-178` — it is the part that is still true, and it is now the _whole_ of the gap.

### 2. Retag downstream

- `:206` → §6.1, §6.2 **[live]**; §6.3 **[live — follows the advice]**
- `:567` → `[live gate]`; **strike `:581-582`** entirely (it contradicts the mermaid at `:613`)
- `:741-743` → invariant 4 **[holds]**, citing `mcp.test.ts:183-254`
- `:705-707` §15 → **strike step 1**, promote step 2 (per-invocation minted tokens) to the head. §15
  is the build-order doc; leaving a solved item at the top misdirects the next effort.

### 3. Add the MCP.2 wire contract to §7a

This is the missing half and matters more than the retagging. §7a already discusses bullmoose-as-MCP-
server, so it is the natural home. Port from `.plans/s01-stateless-MCP/arch.md` §2:

- protocol `2026-07-28`; `MCP-Protocol-Version` header **must equal** `_meta` protocolVersion → 400
- per-request `clientCapabilities` required; unknown version → `-32022` with `supported[]`
- `server/discover` required; **no `initialize`, no `ping`**; `tools/list` carries `ttlMs`
- `Mcp-Name` must match `params.name`

Without this, the harness in §15.3 has no spec to build a client against.

## Bread-crumbs

- Also fix §5's reuse map — every `services/jmap/src/auth.ts:<line>` anchor is dangling now that the
  file is a 4-line re-export shim. Real homes: `packages/auth-core/src/principal.ts` —
  `verifyBearer:100`, grant resolution `:145-187`, `matchingGrants:217`, `grantCoversDomain:209`,
  `allowedBookIds:267`. Add an `authorizeAccount` (`:241`) row — it is the shared decision function
  and has no entry. `ai-surface.md:25-26`'s `principal.ts:130` is off by the same drift.
- `mcp-auth.md:192` should become `[live for jmap + mcp; vault outstanding]` — see issue `017`.
- Check `.plans/s01-stateless-MCP/readme.md` §3 for wording that can be lifted directly.
