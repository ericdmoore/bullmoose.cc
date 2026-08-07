# FIX — 017 -P2- The two runtimes are not interchangeable

## Now: correct the docs (this is the urgent half)

The claim is a **safety** claim, not just an accuracy one — someone reading it will bind a mailbox
with `--allow` and believe the allowlist holds regardless of runtime.

1. `docs/architecture/agent-integration.md:61` — soften "identical contract and are interchangeable"
   to: *"both implement the same **claim protocol**; they do not currently honour the same binding
   config — see `docs/agents/README.md`."*
2. `docs/agents/README.md` — add an explicit block:

   > **What `bullmoose agent serve` does not honour.** The homelab runtime reads its own local
   > `AgentConfig` file, not the binding's `config_json`. It does **not** apply `allowedSenders`, the
   > RFC 3834 auto-sender skip, front-matter directives, or `replyMode` — it always drafts, using its
   > local persona and model. Run it only on mailboxes where those gates don't matter, or where you
   > are the only sender.

3. State the practical consequence: **don't run both runtimes against a binding whose gates you rely
   on**, because the claim race decides which gates apply.

## Later: converge the code

The right fix is to expose the binding config to whoever claims the invocation.

- Add `config_json` (or a safe projection of it) to `AgentInvocation/get`.
- Have `packages/cli/src/agent.ts` merge it over its local `AgentConfig`, with the **server's gates
  winning** — `allowedSenders`, `humanOriginated`, and `replyMode` are policy and should not be
  overridable by a local file. Persona/model can stay locally overridable; that is the legitimate
  reason the homelab runtime exists.
- Lift `humanOriginated` (`services/agent/src/index.ts:398-411`) and `parseFrontMatter` (`:355-367`)
  into a shared package so there is one implementation, not two.

**Sequencing note:** exposing `config_json` over JMAP means a binding's persona and allowlist become
readable by any principal that can read the invocation — check that against the grant model before
shipping. A projection (just the gates, not the prompt) may be the safer shape.

## Bread-crumbs

- `agent.ts:156` matches on `bindingName` only; after this change it should also verify the binding
  is `enabled`.
- The claim race itself is fine and well-designed (`services/agent/src/index.ts:116-122`) — this
  issue is only about what happens *after* the claim.
