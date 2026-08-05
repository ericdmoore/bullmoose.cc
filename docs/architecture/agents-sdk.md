# Cloudflare Agents SDK — reject wholesale, cherry-pick patterns

Status: **design / decision.** Companion to
[`ai-surface.md`](ai-surface.md) and
[`agent-integration.md`](agent-integration.md). Concerns the `agents`
package (the `Agent` framework on Durable Objects), **not** AI Gateway or
Vectorize.

---

## 1. What the SDK is

A framework that puts a stateful AI agent inside a Durable Object and gives
you, batteries-included: an `Agent` base class with per-agent SQL state and
client state-sync, WebSocket handling, `this.schedule(when, method, data)`
for delayed/cron work, `AIChatAgent` + `useAgent()` React hooks for chat
UIs, MCP server/client helpers, and `routeAgentRequest` / `routeAgentEmail`
front doors. It is, precisely, *a framework for "agents are mailboxes with
a runtime attached."*

Which is our tagline. So the question isn't "is it good" — it's "does it
fit a runtime we already built to a different set of constraints."

## 2. Decision: reject the framework wholesale

Four reasons, each grounded in something we'd have to give up.

**It wants to own the DO; our DO is a sync engine, not an agent.**
`AccountDO` is a *collection-agnostic* commit/`/changes`/push spine —
mail, contacts, calendar, and agent queues all move through **one**
monotonic changelog ([`serverless-jmap.md`](serverless-jmap.md)). The
SDK's `Agent` DO is one-agent-centric and knows nothing of that spine.
Retrofitting `AccountDO` onto the SDK base class is a rewrite of our best
code against a class hierarchy built for a different job — and it would
fight the hand-tuned 10ms-CPU budget that
[`capacity-and-scaling.md`](capacity-and-scaling.md) exists to protect.

**Our runtime is queue-as-truth and claimable; the SDK's is DO-owned.**
The invocation queue is the `agent_invocations` D1 table: ingest inserts a
`pending` row and pokes `/drain`; the `*/5` cron sweep is the retry net;
*the row, not the poke, is the source of truth*
([`services/agent/src/index.ts:18‑24`](../../services/agent/src/index.ts)).
Optimistic `pending→running` claims let **a homelab CLI runner and the
cloud worker both serve one account** — whoever claims first wins. The
SDK's "the Agent DO is the agent" model quietly costs us that property.

**The security posture is ours, not the framework's.** The `L0` pin
([`index.ts:43‑48`](../../services/agent/src/index.ts)) treats email
content as untrusted data that is *never* instructions. The SDK's generic
tool-calling / human-in-the-loop gives us no such thing for free; we'd
re-impose it anyway, on top of an abstraction we now have to understand.

**It fails the composition test.** Per `ai-surface.md` §2, an adoptable
feature is a new *value on an axis*. The SDK isn't — it's a different
coordinate system that replaces the axes with its own lifecycle. That's
the definition of the thing `capability-roadmap.md` §1 warns makes the
architecture incoherent.

None of this is "NIH." Where Cloudflare ships a primitive that *composes*
— Gateway, Vectorize — we adopt it (`ai-surface.md`). The SDK is a
*framework*, and we already are one.

## 3. Cherry-pick: three patterns worth stealing

Adopt the ideas as patterns over primitives we already have (DO alarms,
MCP, our object model) — not by importing the package.

**A. Per-agent precise scheduling → sharpen the `trigger` axis.**
Today everything not poked waits on the blanket `*/5` sweep
(`index.ts:80‑83`). The SDK's `this.schedule()` is just ergonomics over DO
alarms — and we *already* run a per-account alarm for the SLA watchdog.
Extend that: schedule per-invocation retry backoff and per-binding digest
times as precise alarms, honoring `budgets.deadlineMs`
([`agent-integration.md`](agent-integration.md) §2). Keep the queue as
truth; the alarm becomes a *scheduled trigger value*, not a new owner of
state.

**B. `AIChatAgent` → a separate interactive surface, only when wanted.**
Our agents are email-native: async, mailbox-triggered, reply/digest out.
An interactive chat agent (streaming, state-synced to a browser) is a
genuinely different modality — a new `trigger`/`output` value. If we ever
want it, the clean shape is a **separate worker with its own DO class,
running beside `AccountDO`** (DO classes coexist per account) — the SDK
earns its keep *there*, for the chat face, without touching the mail-native
runtime. This is pattern **C** from `agent-integration.md` §1 ("UI
actions"), and it's the one place the framework is the right tool.

**C. MCP *client* helpers → agents that consume external tools.** We ship
an MCP *server* (analytics; `mcp.ts`). When agents should *call* outward
MCP tools, the SDK's client patterns are worth reading before we hand-roll
— borrow the shape, keep the `tools[mcpServerRef]` object model.

## 4. Non-goals & revisit triggers

- **Non-goal:** re-platforming `AccountDO` or the invocation queue onto the
  SDK. That's the crown jewel; it stays ours.
- **Revisit** the `AIChatAgent` decision when a webmail/native UI actually
  needs an interactive agent panel (pattern C) — at that point spin the
  separate chat worker, don't retrofit the mail runtime.
- **Revisit** the wholesale rejection only if the SDK grows a way to attach
  its lifecycle to an *external* state authority (our changelog) instead of
  owning state itself. Today it doesn't.
