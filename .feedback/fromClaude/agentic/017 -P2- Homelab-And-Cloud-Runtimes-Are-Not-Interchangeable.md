# 017 -P2- The two agent runtimes are documented as interchangeable; they diverge materially

**Subsystem:** agentic-components · **Severity:** MEDIUM-HIGH · **Fix class:** UPDATE-DOC (+ CHANGE-CODE follow-up)

## The claim

- `docs/agents/README.md:4-8` — "a runtime (the cloud worker, **or** a homelab `bullmoose agent
serve`) claims the invocation … whoever claims first wins"
- `docs/architecture/agent-integration.md:61` — "A homelab hermes and a cloud Emily **implement the
  identical contract and are interchangeable**."

All of `docs/agents/README.md:28-45` (personas, front matter, `replyMode`, `allowedSenders`) is
written as though it applies to both.

## The reality

`packages/cli/src/agent.ts:144-230` reads only its **local** `AgentConfig` file and **never fetches
`agent_bindings.config_json`**. Compare:

| Behaviour                                | Cloud (`services/agent/src/index.ts`) | Homelab (`packages/cli/src/agent.ts`) |
| ---------------------------------------- | ------------------------------------- | ------------------------------------- |
| RFC 3834 auto-sender skip                | `:164` (`humanOriginated`)            | ❌ none                               |
| `allowedSenders` gate                    | `:168-171`                            | ❌ none                               |
| Front-matter parse (`model:`, `prompt:`) | `:173`                                | ❌ none                               |
| `replyMode` send vs draft                | `:273`                                | ❌ always drafts                      |
| Persona / model source                   | binding `config_json`                 | local file                            |

`agent.ts:156` matches on `bindingName` alone.

## Why it matters

For a mailbox bound with `--allow eric@ --reply-mode send`, **behaviour depends on which runtime wins
the claim race**: identity, persona, the sender allowlist, and the send/draft decision all change.

Concretely: a stranger emailing `editor@` is **silently dropped by the cloud path** and **burns
tokens on a reply from the homelab path**. The allowlist is a security control on one runtime and
absent on the other, for the same binding.

## Root cause

`AgentInvocation/get` doesn't expose the binding's `config_json`, so the homelab runtime has no way
to honour it even if it wanted to.
