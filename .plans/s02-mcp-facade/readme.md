# s02 — Public bullmoose-MCP façade (+ legacy compat shim)

> **Status: LIVE — the trigger has fired.** Connecting claude.ai / Claude Code / Codex to
> the inbox is the stated goal, so this is no longer a deferred stub. See
> [`devPlan.md`](./devPlan.md) for the ordered build.
>
> **Trigger (mcp-auth §7a):** *"the first non-bullmoose client appears"* — claude.ai,
> Claude Desktop, a teammate's agent, another agent-native domain. Carrying OAuth
> complexity with no consumer is wasted surface, so this waited for a real one.
>
> ⚠️ **One claim below is wrong and `devPlan.md` reverses it** — see "Scope", the
> `initialize` bullet. It describes the compat shim as a courtesy during a 12-month
> offramp. In fact **claude.ai, Claude Desktop and Claude Code do not speak MCP.2 at all
> today** — Anthropic's connector docs list only the 2025-03-26 / 2025-06-18 / 2025-11-25
> auth specs, and the testing guide still documents the `initialize` handshake. So the
> legacy lane is not a deprecation courtesy to be dropped later; it is **the only lane any
> real client can currently use**, and it is on the critical path. Left in place rather
> than edited away, because the reasoning that produced the wrong version is worth seeing.

---

## What s01 did *not* cover (and why it lands here)

s01 ported the **internal** `mailstore-analytics` MCP to pure MCP.2 and closed the
mcp-auth §6 auth gap. It stayed internal because bullmoose owns both ends there. s02 is
the moment the client is **not** ours — which changes three things at once: the surface
(a façade over the whole JMAP capability set, not 4 analytics tools), the auth
(OAuth 2.1, not an internal bearer), and the compat posture (can't assume the client
speaks MCP.2 yet).

## Scope [proposed]

- **Public façade over the JMAP capability set** — an "MCP-shaped façade over the JMAP
  capability surface" (mcp-auth §7a). JMAP stays bullmoose's own tool surface; this
  re-expresses it as MCP for clients that only speak MCP.
- **OAuth 2.1 resource server** — `WWW-Authenticate: Bearer resource_metadata=…`,
  `.well-known/oauth-protected-resource`, PKCE, `auth-core` as the authorization
  server. Per-request auth (MCP.2 already mandates it).
- **CIMD** (Client ID Metadata Documents) as the registration path — MCP.2 deprecated
  DCR in its favor; `application_type` for localhost redirects (desktop/CLI clients).
  RFC 9207 `iss` validation; issuer-bound client credentials.
- **`initialize` compat shim** — MCP.2 core **plus** a thin legacy `initialize`
  responder so pre-MCP.2 third-party clients still connect during the **12-month**
  HTTP+SSE/handshake offramp. Cheap because the server is stateless anyway; dropped at
  offramp end.
- **MRTR / elicitation** — needed once tools require mid-call user input (approvals),
  unlike s01's read-only analytics.

## Reuse from s01

The `verifyBearer` + shared authz module (s01 T1), the per-request MCP.2 transport
handling, and the `requireAccount` ∩ grant + `grant_audit` gate all carry over. s02
adds the OAuth front door and the JMAP-method → MCP-tool projection on top.

## Build-vs-adopt — **decided at kickoff: split the difference**

s01 chose "extend the hand-roll" for a tiny internal surface. The decision here is
**adopt `@cloudflare/workers-oauth-provider` for the authorization server, keep the
hand-rolled tool surface.** Reasoning and the seam (`apiHandler` + `props`) are in
`devPlan.md`; the short version is that every OAuth primitive is missing — no clients
table, no authorization codes, no refresh concept, no consent record — while the tool
surface has a per-tool scope gate, `grant_audit` writes and 119 tests that
`createMcpHandler` would take with it.

Two notes that dated this section:

- **`createMcpHandler` is no longer Cloudflare's.** It graduated into the official MCP
  TypeScript SDK v2 (`@modelcontextprotocol/server@2.0.0`, a new package rather than a
  version bump). Cloudflare's `agents/mcp/server` is now a wrapper.
- **`McpAgent` is deprecated and feature-frozen**, and a Durable Object is no longer
  needed to speak MCP — a plain Worker is the recommended path, which is what this repo
  wants anyway.

## References

- `docs/architecture/mcp-auth.md` §7a (public server), §6 (auth), §15.7 (OAuth
  sequencing — "only when you expose an MCP server to a client that isn't yours").
- `.plans/s01-stateless-MCP/` — the internal port this builds on.
- MCP 2026-07-28 spec + SEP-2575 (see s01 `readme.md` references).
