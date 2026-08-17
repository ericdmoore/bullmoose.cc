# s03.E — Agent console: dev plan

> Scope: [`readme.md`](./readme.md). Shared architecture:
> [`../s03-webAccess/arch.md`](../s03-webAccess/arch.md) §6.
>
> ~~⚠️ **Do not start until s04's governance model is specified.**~~ **Gate lifted
> 2026-08-09** — `s04-AgentOS/{arch,bureau,devPlan}.md` specify the model and T1/T2/T3a
> are built (mint-time contract, `bureau_grants`, the isolated Bureau worker).

---

## Status — updated 2026-08-09

| Task                          | State                             | Notes                                                                                                                                                                            |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 — per-agent**            | ✅ **done**                       | `lib/console/perAgent.ts` + `scopes.ts`. Bindings, credential _references_, A2A grants, Bureau grants, spend, recent actions, **effective** permissions, dangerous combinations. |
| **T2 — credential lifecycle** | ✅ **done** (one route requested) | `lib/console/credentials.ts` + `origins.ts`. Attach/rotate/revoke and OAuth initiation, all direct to the vault origin. Raw keys bounce to the CLI.                              |
| **T3 — per-resource**         | ✅ **done**                       | `lib/console/perResource.ts`. Point-in-time who-could beside who-did, with the gap rendered as findings.                                                                         |

Built in `webmail/` on the s03.C shell: `src/pages/console.astro` hosts one Preact
island (`components/AgentConsole.tsx`), and the shell's topbar grows an **Agents** link
behind `hasAgentCapability`. **128 new tests** (webmail 245 → 373; repo 1248 → 1376).

### Acceptance

1. ✅ **Both questions answerable in one screen each** — two tabs, each a full screen.
2. ✅ **Point-in-time correct** — a grant revoked 4 days ago still appears in the
   who-could set for an instant 6 days ago, marked _no longer live_; absent at _now_.
   Driven in a browser, not only asserted.
3. ✅ **Effective permissions shown** — every scope list renders `stored: … → allows: …`
   plus what it confers _without naming_. `scopes.test.ts` drives the REAL `hasScope`
   from `@bullmoose/auth-core` and asserts agreement across ~2 300 pairs.
4. ✅ **No secret transits the site backend** — asserted, not conventioned; see below.
5. ✅ **Reads an s04-defined model** — `enforcement`, `bureau_grants` and the verb
   vocabulary all come from `bureau.md` §5/§5.1/§5.2. Spend renders as _the ledger, not
   a budget_; nothing here invents a policy value.

### The one thing this slice requests rather than builds

The console reads **authorization state**, and JMAP has no noun for it —
`AgentInvocation/*` is the only agent-shaped method family. sVOL `015`'s introspection
tools answer these exact questions, but `/mcp/analytics` is gated on `x-internal-token`
(worker-to-worker), and provision's `GET /grants` is one shared `ADMIN_TOKEN` over the
whole deployment — `015` refused to proxy it and so does this.

So `HttpConsoleClient` names a browser-reachable projection of `015`'s own queries
(`CONSOLE_ENDPOINTS`), and until it is served the UI says _which endpoint is missing_
rather than inventing contents. **`GET /vault/credentials` is live and really called.**
`POST /vault/oauth/start` + its callback are the other unserved route.

### How T2's rule is enforced, not just documented

`origins.ts` is a single choke point every vault call passes through. Sensitivity is
**derived from the body** (a declared secret field), never passed by the caller, and a
secret-bearing request is **refused — thrown, not warned** — when the vault origin is
absent, is the site's own origin, or the computed URL escapes it.

`credentials.test.ts` sweeps every operation the module offers through an instrumented
`fetch` and asserts no request carrying credential material was addressed at the site
origin. Confirmed in a real browser too: with a live token and an https vault origin,
**every** console request went to the vault; the console page has **zero** `<form>`
elements and **zero** secret inputs, and the generated CSP carries `form-action 'none'`.

### The four `grant_audit` caveats, and the NULL-provenance gap

`caveats.ts` mirrors `015`'s `ACCESS_LOG_LIMITATIONS` **verbatim**, and
`caveats.test.ts` reads `introspectTools.ts` off disk to prove it — reword either side
and the test fails rather than the two surfaces telling users different things.
`buildResourceView` puts them on the view model, so a renderer cannot produce a who-did
panel without them; an empty trail renders `emptyMeans` _in place of_ the table.
`common/033`'s NULL provenance renders as a `not-captured` **finding**, and blank writer
cells are hatched and labelled _not captured_, never left blank.

---

## T1 — Per-agent view — _"Can Allen even do that?"_

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

## T3 — Per-resource view — _"Who could have messed up VendorsBook?"_

**Blocks:** s03.A tombstones + provenance · `grant_audit`.

- **who _could_**: the authorization set covering the resource, reconstructed
  **at a chosen time** (requires s03.A's tombstones).
- **who _did_**: `grant_audit` joined with the record's `last_writer_*` provenance.
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

---

## Deltas found while building (owned elsewhere — reported, not patched)

1. **`services/agent/src/introspectTools.ts` is stale since `s03.A` landed tombstones,
   in two places that now report the opposite of the truth.** Its own comment still says
   _"`revokeGrant` is a hard `DELETE FROM grants` and `s03.A`'s tombstones do not
   exist"_; `provision/src/index.ts:1594` has since made revocation
   `UPDATE grants SET revoked_at = ?`.
   - `renderGrant().live` is computed from `expires_at` alone (`:234`), so `my_access`
     and `who_can_access` report a **revoked grant as `live: true`**.
   - `readAccessLog()` derives `grant_live` from
     `SELECT COUNT(*) FROM grants WHERE id = ?` (`:596`), which now counts the
     tombstoned row — so access under a since-revoked grant renders as
     `grantStatus: "live"`, and its `note` (_"Revocation is a hard DELETE with no
     tombstone"_) is no longer true.
   - Neither `grantsAsGrantee` nor `grantsAsTarget` filters `revoked_at IS NULL`.

   The console diverges deliberately (`ConsoleGrant.revokedAt`; `grantState()` reads the
   tombstone **first**) and `perAgent.test.ts` pins it. The fix upstream is small — add
   `g.revoked_at` to `GRANT_COLUMNS`, derive `live` from it, and change the
   `grant_live` subquery to `WHERE g.id = ? AND g.revoked_at IS NULL`.

2. **`sVOL 023` should be regraded `E4-I1` and its filename/index updated.** Its own
   _Open questions_ §1 argues this and the ledger still says `I2`; this slice is now
   built and human-verifiable in a browser (revoke a grant, reload, watch the answer
   change), and nothing depends on it. `_context.md` / `_verify.sh` deliberately not
   edited here.

3. **`023`'s note that `services/agent/src/vault.ts:41-66` hand-rolls bearer
   verification still stands**, and now matters more: the console really does POST
   directly to `/vault/credentials`, so that duplicate `tokens ⋈ principals` join is a
   second front door rather than untidiness. Unchanged by this slice.

4. **`common/033` is now user-visible** rather than latent — the forensic view renders
   a `not-captured` finding for every DAV-written record. Fixing `033` removes findings
   from this screen, which is the outcome to aim for.

## Rough edges

- **The read interface is unserved**, so the live path shows only credentials until
  someone builds `/console/*`. `FakeConsoleClient` + `?demo=1` make the whole screen
  drivable meanwhile.
- **`whoDid` matches a provenance writer to a grant by e-mail address**
  (`grantee.address`), because `last_writer_principal` is a login email while grants key
  on `accountId`. Fine today; if two accounts ever share an address it is wrong, and the
  read interface should return the writer's account id.
- **Resource discovery is whatever `/console/…/resources` returns.** There is no
  cross-realm resource search yet; the picker lists what the server offers.
- **The `at` control is a single instant**, not a range. "Who could have, at any point
  last week?" is a union query the UI does not yet express.
