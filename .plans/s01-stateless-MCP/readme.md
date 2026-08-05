# s01 — Stateless MCP: exploration & readiness assessment

> **What this is.** A pre-plan: can bullmoose adopt the 2026-07-28 "stateless MCP"
> spec (call it **MCP.2**) as its *starting point* and skip the older, stateful,
> `initialize`-based protocol (**MCP.v1**)? Is the spec real, final, and backed by
> reference code? What does it cost us given where `services/agent/src/mcp.ts`
> already is?
>
> **Verdict up front:** ✅ **Go stateless-first** — the spec is `Final`, it's
> backed by Tier-1 SDKs and a Cloudflare-native handler, and our own MCP server is
> already 90% of the way there. ⚠️ **But "skip MCP.v1" needs one qualifier:** a
> *pure* MCP.2 server (no `initialize`) refuses every client that hasn't upgraded,
> and the spec is one week old. The right move is **stateless-core, split by
> surface** — pure MCP.2 where we own the client, a thin legacy shim where we don't.
>
> **Status legend:** **[live]** code exists (`file:line`); **[proposed]** design.

---

## 1. The question, precisely

The ask: start with **MCP.2** (2026-07-28, [SEP-2575][sep] — stateless) and *not*
build **MCP.v1** (the `initialize`-handshake / session model). Two sub-questions:

1. Is MCP.2 ready — final spec, reference implementations we can lean on?
2. Can we skip v1 without stranding the clients we care about?

Short answers: **(1) yes**; **(2) yes for surfaces we own, with a caveat for public
ones** — see §5.

---

## 2. What MCP.2 changes (the normative shift)

[SEP-2575][sep] is `Final`. The 2026-07-28 release is a **fundamental,
backward-incompatible** change — a new protocol version, not an add-on:

**Removed**
- `initialize` / `notifications/initialized` — the whole handshake. Version +
  capabilities now travel **per request**.
- `Mcp-Session-Id` — no session identifier, no sticky routing.
- `ping` (both directions), `logging/setLevel`, `roots/list`,
  `resources/subscribe`/`unsubscribe`.
- The server→client **HTTP GET / SSE** endpoint. All traffic is POST.
- Resumable streams (`Last-Event-ID`).

**Added / required**
- `MCP-Protocol-Version: 2026-07-28` header on **every** request, and it MUST match
  the `io.modelcontextprotocol/protocolVersion` in the payload `_meta` or the server
  returns `400`.
- Per-request `clientCapabilities` in `_meta` (**required**); `clientInfo` (SHOULD,
  after PR #3002). "Servers **MUST NOT** infer capabilities from prior requests."
- `server/discover` RPC — servers **MUST** implement; clients **MAY** call it to
  learn `supportedVersions` + capabilities without a handshake.
- **MRTR** (multi-round-trip requests): elicitation/sampling/listRoots are embedded
  as an `IncompleteResult` (`resultType: "input_required"`); the client answers and
  **retries the original call**. No server-initiated requests.
- `subscriptions/listen` for opt-in change notifications (replaces the GET/SSE path
  and `resources/subscribe`).
- List results carry `ttlMs` + `cacheScope` so clients cache `tools/list` etc.
- **Routable headers** `Mcp-Method` / `Mcp-Name` so a gateway/WAF can route + meter
  without parsing JSON bodies.
- New errors: `UNSUPPORTED_PROTOCOL_VERSION` (-32022, → 400 with a `supported[]`
  list), `MISSING_REQUIRED_CLIENT_CAPABILITY` (-32021).

**Auth hardening** (matters for the public façade, mcp-auth §7a): per-request auth is
now mandatory ("Implementations **MUST** ensure authentication is not bypassed by the
removal of the initialization phase"); RFC 9207 `iss` validation; issuer-bound client
credentials; **CIMD** (Client ID Metadata Documents) replacing **DCR**;
`application_type` for localhost redirects (desktop/CLI).

**Deprecation:** legacy **HTTP+SSE (2024-11-05)** is formally deprecated with a
**12-month** offramp. Formal 12-month deprecation policy going forward.

---

## 3. Where bullmoose already is  [live]

`services/agent/src/mcp.ts` ("mailstore-analytics", 4 read-only tools) is **already
sessionless**: *"single response per request — we never open a stream"* (`mcp.ts:11`).
It is **not** MCP.2-conformant, but the gap is small and specific:

| MCP.2 requirement | mcp.ts today |
|---|---|
| No `initialize` / `ping` | **implements both** (`mcp.ts:171,177`) — pins `2025-06-18` (`:16`) |
| Per-request `MCP-Protocol-Version` header ↔ `_meta` | not checked |
| `server/discover` | absent |
| `ttlMs` on `tools/list` | absent |
| Per-request `clientCapabilities` | ignored |
| Stateless by construction | ✅ pure function over `(env, request)`, fresh `Response` each call |

Two happy consequences:

- **We're porting, not rewriting.** The JSON-RPC dispatch, tool registry, and
  notification→202 handling all stay; we add header/`_meta` validation +
  `server/discover` + `ttlMs`, and either drop or shim `initialize`.
- **We're immune to the one stateless footgun.** MCP SDK 1.26.0 shipped a breaking
  fix for stateless servers leaking one client's response to another when a server
  instance is *shared*. Our handler holds **no** cross-request mutable state, so that
  class of bug can't occur by construction.

The real liability isn't statelessness — it's the **auth gap** mcp-auth §4/§6 already
documents: self-asserted `accountId`, presence-check only (`requireAccountId`,
`mcp.ts:37-42`), one shared `x-internal-token`. **Any MCP.2 work must land the §6
fix in the same pass** — a stateless protocol makes per-request auth *mandatory*, so
this stops being optional.

---

## 4. Reference implementations — the answer

The SEP ships none (`Reference Implementation: // TODO`), but the **finalized spec**
is well-supported:

| Implementation | Fit for us | Notes |
|---|---|---|
| **Cloudflare `createMcpHandler`** ([docs][cf]) | 🟢 exact stack | Plain **stateless Worker, no Durable Object**. Uses `@modelcontextprotocol/server@2.0.0` + `agents/mcp/server`. MRTR + elicitation built in. "Spec from day zero." |
| **Official TS SDK** — `WebStandardStreamableHTTPServerTransport` | 🟢 portable | Web-standard `Request`/`Response`/`ReadableStream`; runs on Workers/Deno/Bun/Node18+. Tier-1. |
| Python / Go / C# SDKs | ⚪ n/a here | Tier-1, production. Rust beta. |
| AWS AgentCore Gateway | ⚪ reference only | Ships 2026-07-28 support. |

So "is there reference code for the open spec?" — **yes, multiple, including one that
runs on our exact substrate as a flat Worker.** That de-risks the build-vs-adopt
call in §6.

---

## 5. Can we skip MCP.v1? — the one real caveat

"Skip v1" is right in spirit and wrong if taken literally:

- ✅ **Skip the stateful machinery** — `Mcp-Session-Id`, sticky routing, session GC,
  resumable streams, and the legacy **HTTP+SSE** transport. Never build these. We
  never did.
- ⚠️ **Don't blindly drop `initialize`.** A pure-MCP.2 server returns
  *method-not-found* to any client that opens with `initialize` — which is **almost
  every deployed client today**, because 2026-07-28 is one week old. SDK support ≠
  shipped-client support.

The spec anticipates exactly this: *"a server that wishes to support both old and new
clients **MAY** … continue to implement the old `initialize` RPC … while also
exposing the new stateless RPCs."* For a stateless server that shim is nearly free —
`initialize` just returns server info, it creates no session.

**Recommended posture — split by who owns the client:**

| Surface | Consumer | Posture |
|---|---|---|
| **Internal** `mailstore-analytics` MCP | bullmoose's *own* agent harness (we build the client) | **Pure MCP.2.** No `initialize`, no shim. We upgrade both ends together. |
| **Public** bullmoose-MCP façade (mcp-auth §7a) | claude.ai, Claude Desktop, teammates' agents | **MCP.2 core + thin `initialize` compat shim**, dropped at the end of the 12-month offramp. |

This gives the user what they want — MCP.2 as the native model, zero investment in
stateful infrastructure — without stranding third-party clients on the surface where
that actually matters.

---

## 6. Judgment call: build vs adopt

Three ways to make `mcp.ts` MCP.2-conformant:

- **(C) Extend the hand-roll** — add header/`_meta` validation, `server/discover`,
  `ttlMs`, per-request auth; keep the 222-line surface. *Pro:* zero new deps, already
  wired to auth/vault/grants, stateless-by-construction, matches the repo ethos
  ("assemble from existing parts"). *Con:* we own conformance; MRTR is real work *if*
  we ever need elicitation.
- **(A) Adopt Cloudflare `createMcpHandler` + SDK v2** — conformance, MRTR, cache
  semantics, future spec updates for free; runs as a flat Worker; auth is validated
  upstream and passed via `getMcpAuthContext()` (fits our "authenticate at the door,
  thread the principal" model). *Con:* new deps (agents SDK, `@modelcontextprotocol/server`,
  zod); re-express tools as `registerTool`/Zod; less control.
- **(B) Official TS transport only** — middle ground; canonical conformance, still
  hand-wire auth. Heavier than (C), less batteries-included than (A).

**Recommendation:** **(C) for the internal server** — it's tiny, we own both ends, and
the §6 auth fix is the actual work. **Keep (A) in our pocket for the public façade**,
where MRTR, OAuth 2.1 / CIMD, and strict conformance earn their dependency.

---

## 7. Proposed scope for s01

**In:** port the *internal* `mailstore-analytics` MCP to **pure MCP.2** and land the
**mcp-auth §6** fix in the same pass (`verifyBearer` in `auth-core`; principal-scoped,
ownership-checked, audited `handleMcp`; drop self-asserted `accountId`). Add
`server/discover`, per-request version/capability validation, `ttlMs`. Remove
`initialize`/`ping`. No MRTR (no elicitation on read-only analytics).

**Out (→ s02):** the public bullmoose-MCP façade over JMAP + OAuth 2.1 resource
server + CIMD + the `initialize` compat shim. That's mcp-auth §7a and only needed
"when the first non-bullmoose client appears."

This mirrors mcp-auth §15 sequencing (close the MCP hole first) and keeps s01
self-contained, shippable, and security-positive.

---

## 8. Open decisions (need a call before devPlan/arch)

1. **Scope** — s01 = internal MCP.2 port + §6 auth fix only (recommended), or also
   stand up the public façade now?
2. **Build vs adopt** — extend the hand-roll (recommended for internal) vs adopt
   `createMcpHandler`?

Compat posture follows from #1: internal-first ⇒ pure MCP.2, no shim needed.

## 9. Readiness

- Spec: **Final**, backward-incompatible, reference-backed. ✅
- Our position: already sessionless; small conformance delta; the auth gap is the
  real work and we were going to do it anyway. ✅
- Risk: concentrated in **client compatibility on public surfaces** — deferred to s02
  by the scope split. ✅

**Ready to write `devPlan.md` + `arch.md` once §8 is decided.**

---

## References

- SEP-2575 "Make MCP Stateless" (`Final`): <https://modelcontextprotocol.io/seps/2575-stateless-mcp>
- 2026-07-28 spec release: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- Cloudflare `createMcpHandler`: <https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/>
- Simon Willison, "Stateless MCP": <https://simonwillison.net/2026/Jul/31/stateless-mcp/>
- Internal: `docs/architecture/mcp-auth.md` (§4 gap, §6 fix, §7 two directions, §15 sequencing); `services/agent/src/mcp.ts`.
