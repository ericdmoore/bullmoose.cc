# s02 — Public bullmoose-MCP façade (+ legacy compat shim)

> **Status: deferred stub.** Scope carried forward from
> [`../s01-stateless-MCP/`](../s01-stateless-MCP/readme.md). Do **not** start until the
> trigger fires. This file exists so s01's forward-references resolve to a real folder.
>
> **Trigger (mcp-auth §7a):** *"the first non-bullmoose client appears"* — claude.ai,
> Claude Desktop, a teammate's agent, another agent-native domain. Carrying OAuth
> complexity with no consumer is wasted surface, so this waits for a real one.

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

## Build-vs-adopt (revisit here)

s01 chose "extend the hand-roll" for a tiny internal surface. s02 is where adopting
**Cloudflare `createMcpHandler` + `@modelcontextprotocol/server@2.0.0`** earns its
dependency: conformance, MRTR, cache semantics, OAuth via
`@cloudflare/workers-oauth-provider`, and future spec updates for free. Decide at s02
kickoff.

## References

- `docs/architecture/mcp-auth.md` §7a (public server), §6 (auth), §15.7 (OAuth
  sequencing — "only when you expose an MCP server to a client that isn't yours").
- `.plans/s01-stateless-MCP/` — the internal port this builds on.
- MCP 2026-07-28 spec + SEP-2575 (see s01 `readme.md` references).
