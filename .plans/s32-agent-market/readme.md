# s32 — The agent market · *how bullmoose makes money*

> **Status: CAPTURE ONLY.** Eric sketched this 2026-08-19 late; recorded verbatim
> in shape so the morning conversation starts from his words, not my paraphrase.
> Nothing here is decided. No build.

## The thesis

**An agent market.** Agents charge by the token for tasks. We host them. The
margin is **task value vs. token cost** — which makes model selection an economic
instrument, not just an engineering one (s26's frontier program and s29's
selection ladder become revenue levers, not curiosity). Plus **simple MCP
connectors and provisioning** as the other half of what is being sold.

## Bring your own domain — three on-ramps

The same install, three levels of hand-holding:

1. **Operator path** — install the CLI, download a Cloudflare token, run one
   command.
2. **Agent-assisted path** — copy-paste a block into Claude / ChatGPT / Cursor
   and let it do the setup. (Notably: the product's own thesis applied to its
   own installation.)
3. **Two-token path** — the user makes two CF tokens: one expiring in ~10 minutes
   with provisioning privileges (`tokenP`), one long-lived with runtime
   privileges (`tokenX`). They paste `tokenP` to us; they keep `tokenX`. We
   provision with the short-lived credential and it dies on its own.

Each ends with **a bullmoose install running on the customer's own Cloudflare
account, on their domain.**

> Eric's aside: *"perhaps one day we could abstract it to AWS too. Running on
> lambdas and deployed via CDK."* — a portability question, deliberately parked.

## shop.bullmoose.cc

From there, a customer **browses for agents that might help their org**. The
s28 full-SMB cast (`sales@`, and the rest) is the catalogue this shop sells.

## Why this is worth a real session, not a quick answer

Threads that touch existing plans, to raise in the morning rather than settle now:

- **Whose money buys the tokens?** s26 T4 BYOK already lets a tenant bring their
  own provider key (their guardrails, their bill). The market thesis implies the
  opposite default — we buy tokens, we mark up the task. Both can be true, but
  which is the DEFAULT decides pricing, and the honesty rules around cost
  (`NULL` ≠ `0`) become customer-facing accounting.
- **Margin needs a cost ledger that already exists.** s27 usage-and-spending is
  the unbuilt half of this business model; the frozen per-invocation costs
  (s07 T5) are its raw material.
- **"We host the agents" vs. "the install runs on their Cloudflare."** Those are
  different businesses — hosted service vs. distributed deployment we provision.
  The three on-ramps describe the second; the token margin describes the first.
  Possibly both, but the split needs naming.
- **A shop implies a trust boundary.** Third-party agents in a catalogue reach a
  customer's mail. s04's Bureau, the grant model, and the agent marker were built
  for exactly this and have never been asked to hold a stranger's code.
- **Provisioning is nearly there and not there.** s26 T5's onboarding audit
  (#213) closed 8 of 14 gaps; the sharpest remaining one is that a new human
  cannot change their own password. A market cannot onboard strangers through a
  door the operator must hold open.

## References
`.plans/s26-agent-config` (BYOK, frontier) · `.plans/s27-usage-and-spending` ·
`.plans/s28-full-SMB-cast` (the catalogue) · `.plans/s29-optimizations`
(selection ladder = margin) · `.plans/s04-AgentOS` (the trust boundary) ·
`docs/playbooks/onboarding-a-second-human.md` (#213).
