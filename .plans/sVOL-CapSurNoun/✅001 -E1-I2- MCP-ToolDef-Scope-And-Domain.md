# 001 -E1-I2- MCP `ToolDef` scope + domain

| | |
|---|---|
| **Kind** | prerequisite |
| **Effort** | **E1** — one file (`services/agent/src/mcp.ts`), no schema change, no new method, no new dependency |
| **Impact** | **I2** — unlocks, not human-verifiable (a security gate; only a test can see it) |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Blocks** | `013` (Calendar + Contacts over MCP) · `014` (Email over MCP) · `015` (self-introspection over MCP) |
| **Status** | **✅ done** — `ToolDef` carries `scope` + `domain` per tool (`services/agent/src/mcp.ts:192-216`); the gate reads them. Unblocked 013/014/015. |

## Cells covered

**None.** This unit occupies no cell in the grid — it is the auth plane *beneath* the MCP
column, the same way `s01`'s wire contract sits under every cell (`readme.md` §*Relationship to
the sNN sections*).

It **gates** every cell those three units claim:

- `013` — `Calendar × CRUD × MCP`, `CalendarEvent × CRUD × MCP`, `AddressBook × CRUD × MCP`,
  `ContactCard × CRUD × MCP` (16 cells)
- `014` — `Email × CRUD × MCP` (4 cells)
- `015` — `Agents × R × MCP`, `Secrets × R × MCP` (2 cells)

22 cells gated. It builds none of them.

## Why these grades

**E1.** The change is a two-field addition to one interface plus one call-site edit, in one
file. `MethodDomain` is already re-exported through the import `mcp.ts` line 1 already makes
(`authorizeAccount, verifyBearer, type Principal` from `@bullmoose/auth-core/principal`), so
there is no new dependency. No table, no method, no migration. It is the smallest unit in the
volume that still matters.

**I2, both factors:**

- *Unlocks* — `013`, `014`, and `015` each name it as a hard dependency, and each is
  unbuildable-as-written without it (below). Named edge, not a preference.
- *Not human-verifiable* — the observable behaviour after this unit is **identical**. All four
  live tools are reads on mail; declaring `read`/`mail` explicitly changes nothing a person can
  see. Only a test asserting a refusal proves it works, and that test needs a tool that isn't a
  read on mail — see Open Questions #1, which is the sharpest problem in this unit.

## What exists today

`ToolDef` (`services/agent/src/mcp.ts:36-41`) is four fields:

```ts
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
}
```

No scope. No domain. `handleToolCall` (`:234`) therefore hardcodes the gate for **every** tool
at `:257`:

```ts
const decision = authorizeAccount(principal, accountId, "read", "mail");
```

Today that is correct-by-accident: `TOOLS` (`:55`) holds exactly four read-only analytics tools
— `spend_by_month` `:57`, `spend_by_vendor` `:82`, `top_senders` `:109`, `message_volume` `:136`
— and every one of them is a read against the mail data plane. The constant is right for the
whole tool table because the whole tool table is one shape.

**The moment a fifth tool is a write, the constant is a lie.** A `calendar_create_event` added
to `TOOLS` today is authorized as a `read` on `mail`: a token minted with `--scopes read` would
create calendar events, and a grant restricted to `collection: "AddressBook"` — which
`grantCoversDomain` (`packages/auth-core/src/principal.ts:209-214`) is written specifically to
confine to `contacts` — would satisfy a calendar write, because the domain argument says `mail`.
Nothing fails loudly. The tool runs.

### JMAP already solved this, per method

`requireAccount` (`services/jmap/src/methods/common.ts:26-56`) takes `scope` and
`domain: MethodDomain = "mail"` (`:30`) and forwards both to the same pure
`authorizeAccount` (`:36`). Every registered method declares its own pair at the call site:

| method | call site | scope | domain |
|---|---|---|---|
| `Calendar/get` | `calendars.ts:58` | `read` | `calendar` |
| `Calendar/set` | `calendars.ts:77` | **`calendar`** | `calendar` |
| `CalendarEvent/get` | `calendars.ts:171` | `read` | `calendar` |
| `CalendarEvent/set` | `calendars.ts:200` | **`calendar`** | `calendar` |
| `CalendarEvent/query` | `calendars.ts:345` | `read` | `calendar` |
| `CalendarEvent/getOccurrences` | `calendars.ts:403` | `read` | `calendar` |
| `AddressBook/set` | `contacts.ts:117` | **`contacts`** | `contacts` |
| `ContactCard/set` | `contacts.ts:318` | **`contacts`** | `contacts` |
| `Email/set`, `Email/import` | `email.ts:230,495` | `draft` | `mail` (default) |
| `EmailSubmission/set` | `submission.ts:38` | `send` | `mail` (default) |
| `AgentInvocation/set` | `agent.ts:79` | `draft` | `mail` (default) |
| `VacationResponse/set` | `vacation.ts:33` | `draft` | `mail` (default) |

MCP has 26 such declarations to mirror and currently has one constant.

⚠️ **Read the bolded rows.** Calendar and contact writes gate on scope **`calendar`** and
**`contacts`** — *not* `draft`. Those two strings are outside the vocabulary the module header
declares (`packages/auth-core/src/index.ts:10-12`: `read < annotate < draft < move < send <
delete ; "mail" = all of them`). The live code has already extended the vocabulary past its own
documentation. This matters for `013`, whose proposed scope table (`013:96-99`) assigns `draft`
to calendar and contact writes — that would make the MCP gate *narrower in name and different
in kind* from the JMAP gate on the same underlying method. **Mirror the JMAP call sites.** If
the vocabulary should be reformed, reform it in one place for both surfaces, not by having MCP
guess differently.

### The gate is weaker than it reads, and will stay so until `common/001` lands

`hasScope` (`packages/auth-core/src/index.ts:50-53`):

```ts
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return required !== "admin" && granted.includes("mail");
}
```

A `mail`-scoped token satisfies `calendar`, `contacts`, `vault`, `send`, `delete` — anything but
`admin`. `mail` is the default nearly everywhere it is minted
(`.feedback/fromClaude/common/001 -P1- hasScope-Treats-mail-As-Universal-Scope.md:29-32`).

So after this unit ships, a `calendar` declaration on `calendar_create_event` is **still
satisfied by any `mail` token**. The scope axis of the gate does approximately nothing until
`common/001` (P1, open) is fixed.

Two things survive that, and they are the reason to do this anyway:

1. **The domain axis works today.** `grantCoversDomain` (`principal.ts:209-214`) is an exact
   string match against `collection`, not routed through `hasScope`. A grant scoped to
   `collection: "AddressBook"` genuinely cannot satisfy `domain: "calendar"` — that check is
   live and correct right now, and today's hardcoded `"mail"` bypasses it on every MCP call.
2. **The declarations are what `common/001`'s fix makes real.** Getting them wrong now means
   re-auditing every tool later, at exactly the moment the gate starts biting.

State that honestly in the unit and in the code comment. Do not ship this and describe MCP as
scope-gated.

## What to build

### 1. Two required fields on `ToolDef`

```ts
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: string;          // "read" | "draft" | "send" | "calendar" | "contacts" | "delete" | …
  domain: MethodDomain;   // "mail" | "contacts" | "calendar"  — principal.ts:207
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
}
```

**Required, not optional-with-default.** An optional `scope?: string` defaulting to `"read"`
reproduces the exact bug this unit exists to remove: a new write tool that forgets to declare
gets `read`/`mail` silently. Required means `tsc` refuses to compile a tool that hasn't
answered the question. That is the entire mechanism — the fields are cheap, the compulsion is
the product.

`MethodDomain` is `"mail" | "contacts" | "calendar"` (`principal.ts:207`). It is exported from
the module `mcp.ts:1` already imports; add it to that import list.

### 2. Use them at the call site

`mcp.ts:257` becomes:

```ts
const decision = authorizeAccount(principal, accountId, tool.scope, tool.domain);
```

The four existing tools declare `scope: "read", domain: "mail"` — behaviour-preserving by
construction, which is why this is E1 and why the diff is reviewable in one screen.

### 3. Leave the audit method name alone, but know what it says

`mcp.ts:267` writes `mcp:${tool.name}` into `grant_audit.method`:

```ts
.bind(decision.auditGrant.grantId, principal.username, accountId, `mcp:${tool.name}`, Date.now())
```

JMAP writes `${domain}:${scope}` in the same column (`common.ts:50`). The two surfaces already
disagree on what that column means, and this unit does not have to resolve it — but note that
`mcp:calendar_create_event` is strictly **more** informative than `calendar:calendar`, because
the tool name identifies the operation and the (domain, scope) pair no longer does once several
tools share a pair. Keep `mcp:${tool.name}`. Consider `mcp:${tool.name}` → unchanged, and
instead making JMAP's side more specific in a separate unit. Do not change both here.

### 4. The test, and the seam it needs

The gate is untestable as written: with four read-on-mail tools, `tool.scope` and the hardcoded
`"read"` produce identical output on every input. A test that asserts "a `read` token can call
`spend_by_month`" passes before and after the change.

Add an injection seam so a test can supply a tool table:

```ts
export async function handleMcp(request: Request, env: Env, tools: ToolDef[] = TOOLS)
```

threaded through to `handleToolCall`. This follows `.plans/devPrinciples.md` ("clients are
always passed in to functions - so that tests can pass in mocks/fakes") and costs one optional
parameter. The test then registers a fixture tool declaring `scope: "calendar", domain:
"calendar"` and asserts:

- a principal whose token scopes are `["read"]` is refused `-32004` / HTTP 403;
- a principal reaching the account through a grant with `collection: "AddressBook"` is refused
  on a `domain: "calendar"` tool and allowed on a `domain: "contacts"` tool — **this is the
  assertion that has real teeth today**, because it does not route through `hasScope`;
- the allowed grant path still writes one `grant_audit` row.

`mcp.test.ts:173-255` already has this shape with real `mintToken()` crypto; extend it. The
existing `fakeD1` (`mcp.test.ts:19-43`) is sufficient for these cases — none of them reach a
tool body, so `002` is **not** a dependency of this unit.

## Done when

1. `ToolDef` carries required `scope` and `domain`, and `tsc --noEmit` fails on a tool literal
   that omits either. (Verify by deleting a field and running `npm run typecheck`.)
2. `mcp.ts:257` reads `tool.scope, tool.domain`. `grep -n '"read", "mail"' services/agent/src/mcp.ts`
   returns nothing.
3. All four existing tools declare `read`/`mail`, and the ten existing cases in `mcp.test.ts`
   pass **unmodified** — this is the proof the change is behaviour-preserving.
4. A fixture tool declaring `domain: "calendar"` is refused for a principal whose only reach is
   an `AddressBook`-collection grant, and the same principal is allowed a `domain: "contacts"`
   tool. Both assert on the response code *and* on the absence/presence of the `grant_audit`
   write.
5. A source comment at the call site names `common/001` and states that the scope axis is
   advisory until it is fixed. If someone reads this gate in six months and believes it, that
   is a worse outcome than not having written it.

## Bread-crumbs

- `tools/list` projects only `{name, description, inputSchema}` (`mcp.ts:223`). The new fields
  are server-side and never cross the wire — no MCP protocol implication, no client change,
  nothing to negotiate.
- `server/discover`'s `instructions` string (`mcp.ts:217-219`) says *"Read-only analytics over
  the bullmoose message log and spend ledger."* It stops being true the moment `013` lands.
  Not this unit's job; `013` must not forget it.
- **`decision.access` is computed and thrown away.** `authorizeAccount` returns
  `{ok, access, auditGrant}` (`principal.ts:236-239`), and `handleToolCall` uses only `.ok` and
  `.auditGrant`. `access` carries `granted: GrantRef[]`, which is what `allowedBookIds`
  (`principal.ts:267-276`) needs to confine a contacts write to specific address books. Every
  write tool in `013` will want it. Passing `decision.access` into `tool.run` is a natural part
  of this unit if you want it to be — see Open Questions #3.
- The tool lookup is a linear scan (`mcp.ts:246`) over a four-element array. Fine now; `013`
  plus `014` plus `015` take it to ~20. Still fine. Don't pre-optimize it into a Map as part of
  this change — keep the diff to the gate.
- `services/agent/package.json` lists `@bullmoose/mailstore`, `@bullmoose/account-do`,
  `@bullmoose/mime` and `postal-mime` — but **not** `@bullmoose/auth-core`, which `mcp.ts:1` and
  `vault.ts:9` both import. It resolves through npm-workspace hoisting
  (`node_modules/@bullmoose/auth-core → packages/auth-core`). Undeclared dependency; harmless
  today, worth a one-line fix while you are in this file.
- `services/agent/src/vault.ts:41-67` (`authenticateVault`) still hand-rolls bearer verification instead of
  using `verifyBearer`, and gates on `hasScope(scopes, "vault")` (`vault.ts:75`) — which any
  `mail` token passes (`common/001` symptom 1). Out of scope here, but it is the other half of
  the same problem in the same worker, and `s01` T1 already owns it.

## Open questions / where this could be wrong

1. **The unit may not be independently verifiable, which would break its own `I2` premise.**
   `I2` requires "not human-verifiable" *and* "unlocks" — it does not require test-verifiable,
   but `readme.md`'s framing assumes a unit is *confirmable* somehow. With no non-read tool in
   the tree, the only honest test is against an injected fixture tool, which tests the
   mechanism rather than any shipped behaviour. A reviewer could reasonably say: fold `001`
   into `013`, where a real write tool exists and the gate can be tested for real. I kept it
   separate because `014` and `015` also depend on it and because a security gate merged into a
   feature PR is a gate that gets reviewed as a feature. **This is the most arguable call in
   the unit.**

2. **I am recommending scope strings that contradict `013`.** `013:96-99` proposes `draft` for
   calendar/contact writes and `delete` for deletes. The live JMAP methods use `calendar` and
   `contacts` for *both* create and destroy — `Calendar/set`, `CalendarEvent/set`,
   `AddressBook/set` and `ContactCard/set` each handle create, update and destroy behind a
   single scope check (`calendars.ts:77,200`; `contacts.ts:117,318`), so JMAP has **no separate
   delete scope on these nouns at all**. Mirroring JMAP means MCP also cannot distinguish
   create from delete by scope. That is a real loss of expressiveness and `013`'s table is the
   better design *in isolation* — but two surfaces disagreeing about what authorizes the same
   write is worse than either design. I chose consistency. Someone should decide this
   deliberately rather than let it fall out of whichever unit ships first.

3. **Whether `tool.run` should receive `access`/`principal` is arguably part of this unit.**
   Changing the `run` signature is a second edit to `ToolDef` in the same file — cheap now,
   annoying later once `013`/`014`/`015` have written tools against the old shape. But it is
   scope creep on a unit whose value is being small and obviously correct, and I cannot justify
   the field without a consumer. I left it out and flagged it. If `013` is being built
   immediately after, do both here.

4. **I did not verify the `-32004` / HTTP 403 pairing against any MCP client.** `mcp.ts:258-261`
   returns `rpcError(msg.id, -32004, detail, 403)`, and `mcp.test.ts:202-219` asserts status 403
   — but `-32004` is not a code I could locate in the MCP spec, and I did not check what an
   actual client does with a JSON-RPC error body delivered under a 403. `013`'s done-when #3
   asserts on `-32004` too. If that pairing is wrong, both units assert the wrong thing.

5. **Nothing was run.** Every claim above is read from source at the working tree. I did not
   deploy, did not issue an MCP request, and did not confirm that a grant with
   `collection: "AddressBook"` exists in any real database — the `grants` table shape is read
   from `verifyBearer` (`principal.ts:147-163`) and from the test fixture at
   `mcp.test.ts:225-234`, not from live data.

6. **Two citations in `_context.md` §4 are off by a line and I corrected them silently above.**
   `calendars.ts:344` is the `registry.register("CalendarEvent/query", …)` line; the
   `requireAccount(ctx, args, "read", "calendar")` it cites is at `:345`. This does not change
   any argument, but if a reviewer greps the cited line and finds a `register` call, that is
   why.
