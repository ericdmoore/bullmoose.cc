# 016 -P1- `e2e-grants.mjs` MCP section was not updated with the MCP.2 rewrite

**Subsystem:** agentic-components · **Severity:** HIGH · **Fix class:** CHANGE-CODE

## The defect

`tools/README.md:23` advertises `e2e-grants.mjs` as covering "Phase 3: sharing, delegation, vault,
**analytics MCP**".

`tools/e2e-grants.mjs:197-215` still speaks the **pre-s01 protocol**. Every one of its four MCP
assertions now fails:

| What the test sends                                 | What the server does now                  |
| --------------------------------------------------- | ----------------------------------------- |
| `x-internal-token` only, no `Authorization: Bearer` | **401** (`services/agent/src/mcp.ts:171`) |
| `method: "initialize"` (asserted at `:205`)         | **`-32601` / 404** (`mcp.ts:230`)         |
| no `MCP-Protocol-Version` header                    | **400** (`mcp.ts:193-209`)                |
| no `_meta` protocolVersion / clientCapabilities     | **400** (`mcp.ts:193-209`)                |

## Why this is HIGH

It is the **only integration-level proof** of the MCP surface. The new
`verifyBearer` → `authorizeAccount` → `grant_audit` path is currently covered _only_ by
`services/agent/src/mcp.test.ts`'s **fake D1** — never against a real worker with real D1, real
tokens, and real grants.

So the security-relevant part of the s01 work (cross-account denial, audit writes) has unit coverage
but no end-to-end verification, and the harness that would provide it is silently broken.

This is also the concrete instance of the gap I flagged when s01 landed: _"no live `wrangler dev`
smoke — verified via the conformance suite with a fake D1, not against a running worker."_

## Still valid

The `noTokenMcp` 404 check at `:216` still holds — an unauthenticated request should be rejected, and
is.
