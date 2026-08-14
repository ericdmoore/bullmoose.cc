# s15 — the CLI as a local MCP bridge

> **Status: design** (2026-08-13 discussion). Eric's question: *"does the CLI (+ its
> websocket) act as the bridge to offer the MCP auth etc for the working actor?"*
>
> **Today: no.** There is no MCP in either CLI. The only MCP surface that exists is
> `services/agent`'s `/mcp/analytics`, gated by `x-internal-token` — an internal,
> server-side surface no local client can reach. `s02` is building the *remote* front
> door (OAuth 2.1 + PRM). This section is the **other half**, and the two are
> complementary rather than competing.

## The core claim: two transports, two auth models, ONE tool surface

| | remote MCP (`s02`) | **local MCP (this section)** |
|---|---|---|
| client | claude.ai, hosted agents — cannot run local code | Claude Desktop / Code, Codex, Cursor — already on your machine |
| transport | HTTPS, streamable | **stdio** (`bullmoose mcp serve`) |
| auth | OAuth 2.1 + PKCE, PRM discovery, resource indicators | **none — the CLI is already authenticated** |
| reach | anywhere | LAN/tailnet, offline-capable |
| tier-3 tools | never (`agent-integration.md` §6) | **allowed — your hardware** |

**OAuth for a local client is ceremony solving a problem that does not exist.** There is
no third party, no redirect, no consent screen to render: the human already authenticated
this CLI with `bullmoose login`, and the scoped bearer sits in the local store. A local
MCP server's job is to *spend* that token, not to re-acquire one. The auth model is
"whoever can run this binary is whoever already logged in" — which is exactly the trust
boundary a desktop MCP client lives inside anyway.

So the answer to *"is the CLI the bridge for MCP auth?"* is: **it is the bridge that makes
MCP auth unnecessary for the actor sitting at the machine.**

## Why the websocket is the interesting half

Eric's instinct to name `watch` alongside MCP is the good part of the question. A
stdio MCP server that only answers tool calls is a *poller*. One that holds the
`watch` push channel is **live**:

- **Resources that update.** MCP resource subscriptions map onto the changes cursor we
  already push over WS — "new mail in Inbox" becomes an MCP notification rather than the
  client re-listing on a timer.
- **One connection, not N.** The tool surface and the event stream share the session's
  cursor, so an agent that acts and then observes sees its own effect in order (the
  `/changes` choreography, already load-bearing everywhere else).
- **This is the fleet-host shape again** (s11 T8): one local process, one login, a
  scoped grant, N things served. The daemon serves *invocations*; this serves *tools*.
  Same skeleton, different payload — and eventually the same process should do both.

## The tool surface is already built

Nothing here invents tools. `services/agent/src/mcpNouns.ts` + `mcp.ts` already define
calendar/contacts CRUD and the analytics reads; the s02 front door exposes them remotely.
Local MCP re-exposes **the same definitions** over stdio, translated to JMAP with the
CLI's token. If a tool exists in one transport and not the other, that is a bug, not a
feature — one registry, two doors.

## Security — three rules, none of them new

1. **Grants decide tool visibility, not tool execution** (`agent-integration.md` §4). The
   local server offers only the tools the CLI's token scopes permit — no `send` tool for a
   read-only token. Nothing to trick, because nothing unauthorized is in the array.
2. **A session may narrow, never widen.** An MCP session must not inherit `admin` merely
   because the token holds it: default to the mail/realm scopes and require an explicit
   opt-in flag for anything destructive or administrative. The client is untrusted-ish
   software running as you; the blast radius should be the *task*, not the *account*.
3. **The governed bound still applies.** A local `send` tool is an agent egress like any
   other — `outboundRefusal` (s10) gates it server-side, so a local MCP client cannot
   email outside the binding's book any more than a cloud runtime can. **The bridge adds a
   transport, never an authority.**

## Open questions

1. **Does `mcp serve` share a process with `agent serve`?** Both are "a local daemon
   holding a token and a socket". *Recommendation: separate commands, shared internals,
   and let them merge only if running both proves annoying.*
2. **Session scoping ergonomics** — a flag (`--scopes`), a prompt, or a per-client profile?
   *Recommendation: default-narrow + `--scopes`, since the client's config file is where a
   scope decision would otherwise get silently persisted.*
3. **Tool-definition sharing across languages.** The definitions live in TypeScript; a Go
   CLI serving them needs the same shapes. *Recommendation: generate them into the
   conformance contract (the pattern already exists for scopes/exit codes) rather than
   hand-mirroring — this is exactly the drift the contract suite was built to catch.*
4. **Which binary serves it** — Go or the Node CLI? *Recommendation: Go, once `watch` is
   native (in flight), because the whole point is one static binary with a socket.*

## References

- `.plans/s02-mcp-facade/` — the remote door (OAuth 2.1, PRM); this is its local sibling
- `docs/architecture/agent-integration.md` §4 (grants → tool visibility), §6 (runtimes,
  tier-3 hardware split)
- `services/agent/src/{mcp.ts,mcpNouns.ts}` — the tool registry both doors must share
- `.plans/s11-scheduling/jobs-and-facets.md` §4 — the fleet-host shape this mirrors
- `.plans/s08-go-cli/` — the port that makes a single-binary local server possible
