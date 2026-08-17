# s10 — the Agents area: configuration, not just a CRUD grid

> **Status: T1–T4 + T7 SHIPPED (code); T5 and T6 unbuilt.** `write_policy`, `book_membership_log`, the governing book and the Go `agents` command are live. T5 (WebUI config panel) and T6 (the score) are not. The "Known hardening gap" is CLOSED as of #158 — and its stated mitigation was unsound, because it assumed a proposal's recipient is fixed once minted.
> controls the config depends on that do not exist yet. The agent **activity** surface
> (queue, dossier, score) is mostly built elsewhere; this section deliberately does not
> re-own it.
>
> **This file is the needed-detail for:**
>
> - `s07` decisions **5** (fail-closed `allowedRecipients`) and **7** (typed config core vs
>   `config_json` blob), and T4's _"who will it respond to? — not bounded at all"_ row. Those
>   are open questions sitting in the app-surface plan where they do not belong; they belong
>   here.
> - `sVOL 023` (Agents-And-Secrets-Over-WebUI) — the WebUI half of this.
> - `s03.E` console — the activity ItemView this section links to rather than rebuilds.

---

## The one framing that changes everything: "agents" is two surfaces

Calling this "agent CRUD" pattern-matches to the noun-CRUD we did for contacts and calendar.
It half-fits, and the half it doesn't fit is the interesting half.

| surface                                 | shape                                                | already built?                                                                                    |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Configuration** — what an agent _is_  | CRUD over `agent_bindings` + `config_json`           | ❌ greenfield — this section                                                                      |
| **Activity** — what an agent is _doing_ | read-only dossier: pending / queue / history / score | 🟡 mostly: `/approvals` (queue, s07 T4) + `s03.E` console (`perAgent.ts`, permissions + warnings) |

**`show` is the tell.** "Show me how Allen is set up" and "show me what Allen has been
proposing, and whether it's worth its spend" are different views. Merging them is the mistake.
CRUD owns the first; the second is read-only and largely exists. So:

- CLI `agents show <name>` → **config**. Activity is `bullmoose approvals --agent <name>`
  (the Go command just built) plus a dossier that composes the console.
- WebUI `/agents/<id>` → the console's per-agent view (activity, built) **plus** a config
  panel (new). Not two pages — two panels, clearly labelled _what it is_ vs _what it's doing_.

## Where CRUD fits — the config skeleton

```
agents list             agent_bindings query
agents show <name>       the binding + its config core
agents edit <name>       replyMode, persona, model, enabled, the allowlists
agents create --kind K   NOT a blank insert — see gotcha 1
agents remove <name>     disable by default; tombstone with a flag — gotcha 3
agents enable|disable    the reversible switch (the `enabled` column, already live)
```

WebUI: ListView · ItemView(config panel + activity panel) · EditConfigView · Create(from a
kind) · Disable(reversible)/Remove(guarded). The user's outline, with the three corrections
below folded in.

## Three things that make it NOT vanilla CRUD

### 1. `create` is provisioning-from-a-kind, not a form POST

`analyst@`, `photos@`, `newsletters@` are genuinely different _shapes_
(`docs/agents/motivatingExamples.md`): `analyst@` is a digest pipeline with `digestTargets`;
`photos@` is **social** — CC-invited into event folders, receiving from arbitrary external
senders, joining _another account's_ `photos@`, syndicating outward. A blank `config_json`
editor cannot express that. `create` takes a **kind** (a template), and for a real agent it
also mints an identity/address and scopes — a provisioning flow, not an insert. Custom is a
kind too, but it is the exception, not the default.

### 2. The config must be honest about enforced-vs-advertised — and one row has no backing

This is the user's own "who can talk to it / who it responds to", and it is where the gap
bites:

| config row                   | field                   | status                                                     |
| ---------------------------- | ----------------------- | ---------------------------------------------------------- |
| what it can read / edit / do | scopes + grants         | ✅ the console renders this                                |
| **who can talk to it**       | `config.allowedSenders` | ✅ enforced (`services/agent/src/index.ts:209`)            |
| **who it responds to**       | `allowedRecipients`     | ❌ **does not exist** — 0 hits in `services/`, `packages/` |

An "edit who it responds to" control has **nothing to write to**. That is the `photos@`
confused-deputy shape: a social agent emailing many people with no outbound bound. The
console already names the danger (`perAgent.ts:180`: _"no sender allowlist AND replyMode
send: anyone who can get a human-looking message …"_). **The config surface cannot truthfully
offer that control until `allowedRecipients` exists** — which is why T1 builds it before any
CRUD, and builds it **fail-closed** (unbound ⇒ cannot send), matching the Bureau's invariant
5 one realm over (`services/bureau/src/binding.ts`).

#### The bound is an address book — and that is a Space decision, not a convenience

`allowedRecipients` is **a contact book**, not a config array. Practically, it inherits CRUD
across JMAP, CardDAV, CLI, MCP and WebUI, stays inspectable in any CardDAV client, and gets
groups — expressiveness a flat list never has. But the deeper reason is the framing: _who an
agent may talk to_ is a **social fact**, and it belongs in the same artifact where the humans'
social facts already live. A permissions matrix in an admin panel would be the Drive-shaped
answer; a shared address book is the Space-shaped one. **We are not building Google Drive with
agents — we are building a collaboration Space for people and agents that happens to rhyme
with those features.** Reach-as-contacts is one of the places that distinction is load-bearing
rather than rhetorical.

**The hole it opens, and the fix.** If the book is the bound, then _writing a contact grants
send authority_ — and an agent holding `contacts` scope (which `photos@` legitimately needs)
can call `contacts_create_card` and widen its own reach. Control and controlled become the
same writable object. What makes it sneaky is that it does not look like a permission grant:
a reviewer auditing the agent sees `contacts: write` and thinks _address book_, not
_self-issued send authority_. So the governing book is **not writable by the agent it
governs** (T1, via the collection-scoped grants `allowedBookIds` already supports), the agent
**asks** for widening through the existing `grant-request` proposal (T3), and the ask leaves
an **append-only chain** whose _why_ is the proposal itself (T2). Those three are one arc.

### 3. `remove` is disable-vs-destroy

`enabled = 0` is reversible and already exists. Destroying a binding orphans its invocations
and proposals — the same problem grants solved with revoke-vs-tombstone, which the console
already distinguishes ("revoked" vs "deleted"). `remove` defaults to disable; an explicit
flag tombstones the binding while keeping the audit trail. It never silently strands the
proposals an agent authored.

## The structural rule: do not CRUD a blob

`config_json` is untyped — `persona`, `replyMode`, `allowedSenders`, `modelAliases`,
`maxTokens`, `pipeline`, and `analyst@`'s own `digestTargets` all share one namespace with no
schema. A form that edits an untyped blob is fragile, and `agents edit photos@` vs
`agents edit analyst@` would be editing different unvalidated shapes. The edit surface touches
a **small typed core** the console enforces uniformly — `allowedSenders`, `replyMode`,
`enabled`, plus a _reference_ to the governing book — and shows the agent-specific remainder
**read-only**. This is `s07` decision 7, resolved here: typed columns for the core, blob for
the tail, and the outbound bound is a book rather than a column at all.

## References

- `docs/agents/motivatingExamples.md` — `analyst@` / `photos@` / `newsletters@`, the kinds
- `services/agent/src/index.ts:209` — `allowedSenders` enforcement (inbound; the model for outbound)
- `services/bureau/src/binding.ts` — fail-closed destination binding, the outbound-bound model
- `packages/auth-core/src/principal.ts:345` — `allowedBookIds`, the collection-scoped grant
  that makes a not-agent-writable governing book expressible with no new machinery
- `services/jmap/src/methods/actionProposal.ts:481` — the `grant-request` branch the widening
  ask reuses ("the decision is recorded here; no local write")
- `packages/mailstore/sql/control-plane.sql:197` — `grant_lifecycle`, the append-only chain
  this copies (and whose missing _why_ T2 also fixes)
- `webmail/src/lib/console/perAgent.ts` — the activity ItemView this composes, and its warnings
- `.plans/s07-app-surface/devPlan.md` — decisions 5 & 7, T4 (this is their detail)
- `.plans/s03.E-console/` — the per-agent view (activity, built)
- `.plans/s04-AgentOS/` — agent credentials (Bureau), a create-flow may touch this
