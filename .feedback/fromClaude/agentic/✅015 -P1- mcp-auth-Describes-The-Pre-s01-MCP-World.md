# 015 -P1- `mcp-auth.md` still describes the pre-s01 MCP world

**Subsystem:** agentic-components · **Severity:** HIGH · **Fix class:** UPDATE-DOC

The MCP.2 port (`.plans/s01-stateless-MCP`, commits `c1cdc83`/`b8f1133`) landed the auth gate this
document spends five sections asking for. The document has not been updated, so it now describes a
system that no longer exists — and points the next build effort at a solved problem.

## §4 "Where we are today" is the most misleading paragraph in the subsystem

| Doc claim                                                                                                                                                 | Reality                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `:161` "has **no caller identity at all**"                                                                                                                | `mcp.ts:168-171` resolves a per-request bearer via `verifyBearer`                                  |
| `:166-168` "`accountId` as a **self-asserted argument** … no ownership check … Any holder of the platform secret can read **any** account's spend ledger" | `mcp.ts:257-261` runs `authorizeAccount(principal, accountId, "read", "mail")` and 403s on failure |
| `:169` "The handler threads no principal"                                                                                                                 | `mcp.ts:228,238` threads `Principal` into `handleToolCall`                                         |
| `:180-181` "identity (layer 2) and capability (layer 3) … **absent on MCP**"                                                                              | both live; `grant_audit` written at `:262-269`                                                     |

The cited `requireAccountId` moved to `mcp.ts:48-53` and is now a redundant inner check behind the
real gate.

## Every downstream status tag is now wrong

- `:206` "Three changes **[all proposed]**" — §6.1 and §6.2 are shipped
  (`packages/auth-core/src/principal.ts:100`; `mcp.ts:170,257,262`); §6.3's scope advice is followed
  (`"read"` + domain `"mail"`).
- `:705-707` §15 step 1 "**Close the MCP hole**" listed as the next thing to build — **it is done.**
- `:567` worked-example step 4 tagged `[new gate]`; `:581-582` "Step 4 is the MCP gate **that doesn't
  exist yet**". Meanwhile the §12 mermaid at `:613` already draws the correct flow — the document
  contradicts itself two screens apart.
- `:741-743` invariant 4 written as an aspiration; it is satisfied and regression-tested
  (`services/agent/src/mcp.test.ts:183-254`, cases 7–10).

## The missing half: MCP.2 is documented nowhere in `docs/`

No file under `docs/` mentions `2026-07-28`, `MCP-Protocol-Version`, `server/discover`, `ttlMs`, or
statelessness. The wire contract exists **only** in `.plans/s01-stateless-MCP/arch.md`.

Whoever builds the §15.3 tool-calling harness has no spec for the headers `mcp.ts:191-209` now
mandates.

## Still true, keep it

`:175-178` "the runtime runs no tools yet" remains accurate — `AgentConfig`
(`packages/cli/src/agent.ts:39-50`) has no `tools`/`mcpServers`, and `callModel` (`:234-284`) is a
single non-looping call.
