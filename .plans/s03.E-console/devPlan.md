# s03.E — Agent console: dev plan

> Scope: [`readme.md`](./readme.md). Shared architecture:
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §6.
>
> ⚠️ **Do not start until s04's governance model is specified.** The other s03 slices
> have no such gate.

---

## T1 — Per-agent view — *"Can Allen even do that?"*

**Blocks:** webmail (s03.C shell) · `services/agent` vault API **[live]** ·
s04 policy read interface.

- Bindings and their config; MCP server list with credential **references** (vault
  names, never values — `mcp-auth.md` §7b).
- A2A grants held and granted, with expiry.
- Spend (the ledger + pricing cache already exist) and recent actions.
- **Effective** permission rendering, not raw scope chips (`readme.md` §Non-obvious).
- Dangerous-combination warnings.

**Done when:** "can Allen send?" is answerable at a glance and correct — including the
`mail`-is-a-superset case; no credential value is ever returned to the browser.

---

## T2 — Credential lifecycle

- Attach / rotate / revoke a credential reference against an agent.
- **OAuth initiation** in-browser (the safe case — refresh token exchanged
  server-to-server, never typed).
- Raw key entry: either bounce to the CLI, or a form that POSTs **directly** to the agent
  worker's `/vault/credentials` with the operator's bearer — never through the site
  backend.

**Done when:** an OAuth-based credential can be established entirely in the browser; a
raw key never appears in a request to the site origin. Assert the second with a test, not
a convention.

---

## T3 — Per-resource view — *"Who could have messed up VendorsBook?"*

**Blocks:** s03.A tombstones + provenance · `grant_audit`.

- **who *could***: the authorization set covering the resource, reconstructed
  **at a chosen time** (requires s03.A's tombstones).
- **who *did***: `grant_audit` joined with the record's `last_writer_*` provenance.
- Rendered side by side, with the gap called out.

**Done when:** a since-revoked grant still appears for the window in which it was live;
an agent that acted on its **own** account is attributable (the case `grant_audit` alone
misses — exactly why s03.A exists).

---

## Sequencing

```
s04 model specified ─┐
s03.A + s03.C ───────┴─▶ T1 per-agent ─▶ T2 credentials
                                        └─▶ T3 per-resource
```

T3 can proceed in parallel with T2; both need T1's shell.

## Risk

**Scope creep into s04.** The console is where "just add a budget field" feels natural
and is wrong. Mitigation: every policy value the console displays must come from the s04
interface — if there's nowhere to read it from, that's a signal to go define it in s04,
not to invent it here.
