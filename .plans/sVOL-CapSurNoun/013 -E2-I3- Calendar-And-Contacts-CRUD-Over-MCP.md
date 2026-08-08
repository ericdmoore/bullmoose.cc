# 013 -E2-I3- Calendar + Contacts CRUD over MCP

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E2** — several files in `services/agent`, no schema change, no migration |
| **Impact** | **I3** — unlocks *and* human-verifiable |
| **Owner** | `sVOL` |
| **Depends on** | `001` (ToolDef scope+domain) · `002` (fake-D1 `.batch()`) · `003` (recurrence, for recurring events only) |
| **Status** | todo |

## Cells covered

`Calendar × CRUD × MCP` · `CalendarEvent × CRUD × MCP` ·
`AddressBook × CRUD × MCP` · `ContactCard × CRUD × MCP`

16 cells — the entire Calendar and Contacts columns under MCP.

## Why these grades

**E2.** No new capability. `Calendar/set` (`calendars.ts:76`), `CalendarEvent/set` (`:199`),
`AddressBook/set` (`contacts.ts:116`), and `ContactCard/set` (`:317`) are all live, tested by
hand, and reachable. This unit adds tool definitions and a dispatch path — files inside
`services/agent`, nothing else. It is **not E1** because it touches the auth gate, adds a
dependency edge from `services/agent` to the JMAP method layer that does not exist today, and
needs real tests.

**I3, both factors:**
- *Unlocks* — it is the first write surface on MCP at all. `014` (Email over MCP) and `015`
  (introspection) inherit the tool-shape and dispatch decisions made here. Named dependency,
  not a preference.
- *Human-verifiable* — a person asks Claude to put something on the calendar, then opens
  Apple Calendar and sees it. No engineer required, no JSON read.

## What exists today

**The capability is complete.** Per `_context.md` §2, Calendar and Contacts have full CRUD on
both JMAP and DAV. This unit is pure projection and qualifies under the law in `readme.md`.

**The MCP surface has none of it.** `grep -i calendar services/agent/src/mcp.ts` returns zero
hits. `TOOLS` (`mcp.ts:55`) holds exactly four read-only analytics tools — `spend_by_month`
`:57`, `spend_by_vendor` `:82`, `top_senders` `:109`, `message_volume` `:136`.

**Two structural facts that shape the work:**

1. `ToolDef` (`mcp.ts:36-41`) has no scope or domain field, and `handleToolCall` hardcodes
   `authorizeAccount(principal, accountId, "read", "mail")` at `:257` — for *every* tool. A
   write tool added today would be authorized as a **read** on **mail**. That is why `001`
   is a hard dependency and not a cleanup.
2. All four existing tools query `env.DB` with **raw SQL**. `services/agent` does not depend
   on `Mailstore` or `calendar-core` at all.

## What to build

### Route through the JMAP method layer — not `Mailstore`, not SQL

This is the load-bearing decision. `_context.md` §3 has the full argument; the short version:

`Mailstore` is a thin data layer that does **not** maintain invariants — `insertCalendarEvents`
(`:1511`) is a bare INSERT. The choreography lives in `CalendarEvent/set`
(`calendars.ts:199-341`):

```
mutate → accumulate ctags → bumpCalendarCtags(:329) → commitCalendarEntries → changelog → newState
```

Skip any of it and the event lands in the table, reads back fine on a direct `get`, and is
**invisible to every incremental consumer**: stale `ctag` ⇒ CalDAV never re-syncs; no changelog
entry ⇒ `/changes` never reports it ⇒ the CLI mirror never sees it. It presents as a sync bug
and is actually a write-path bug — the expensive kind to chase.

So: MCP tools call the JMAP methods. Whether that is an in-process import or a service binding
is an open question (below).

### Tool set

Keep it small and JMAP-shaped. Resist inventing a parallel vocabulary — every tool should map
onto a method that already exists.

```
calendar_list                 Calendar/get
calendar_create_event         CalendarEvent/set    (create)
calendar_update_event         CalendarEvent/set    (update)
calendar_delete_event         CalendarEvent/set    (destroy)
calendar_query_events         CalendarEvent/query + getOccurrences
contacts_list_books           AddressBook/get
contacts_search               ContactCard/query
contacts_create_card          ContactCard/set      (create)
contacts_update_card          ContactCard/set      (update)
contacts_delete_card          ContactCard/set      (destroy)
```

Per-tool scope and domain, from `001`. **Mirror the live JMAP convention exactly** — do not
invent a parallel vocabulary:

| tool | scope | domain |
|---|---|---|
| `calendar_list`, `calendar_query_events` | `read` | `calendar` |
| `calendar_create_event` · `_update_event` · `_delete_event` | `calendar` | `calendar` |
| `contacts_list_books`, `contacts_search` | `read` | `contacts` |
| `contacts_create_card` · `_update_card` · `_delete_card` | `contacts` | `contacts` |

Verified against the methods this unit projects: reads take `("read", "<domain>")`
(`calendars.ts:58,171,345,403` · `contacts.ts:70,255,530`) and **every write takes
`("<domain>", "<domain>")`** (`calendars.ts:77,200` · `contacts.ts:117,318`).

Note what that implies: **calendar and contacts do not use the mail scope lattice.** A single
scope named after the domain covers create, update, *and* delete. Only mail uses
`read < annotate < draft < move < send < delete` — `email.ts:230,495` take a bare `("draft")`
with no domain argument, defaulting to `mail`. Unit `014` inherits that lattice; this unit
must not.

⚠️ `common/001` (P1, open): `hasScope` treats `mail` as universal, so a `mail`-scoped token
already satisfies `calendar` and `contacts`. **These gates are weaker than they read** until
that lands. Declare them correctly anyway — the declaration is what `common/001`'s fix makes
real, and getting it wrong now means auditing every tool later.

### Single-instance events only, first

Recurring events wait for `003`. `common/003` (P1, open) is a live correctness bug:
`FREQ=YEARLY;BYMONTH=11;BYDAY=4TH` — Thanksgiving, **a shape Apple Calendar emits** — parses
clean and expands to the wrong dates, silently. With zero tests in `calendar-core`, the first
cross-surface disagreement on a repeating event sends you into the write path when the bug is
in the expander.

## Done when

1. Claude creates a single-instance event through MCP, and **three independent readers agree**:
   Codex over MCP, `bullmoose calendar agenda` (JMAP + occurrence expander), and a CalDAV
   `PROPFIND` from Apple Calendar. Two of those three already exist — this triangulation is
   nearly free and is the whole point.
2. The event's calendar shows a **bumped `ctag`** and the write appears in
   `CalendarEvent/changes`. This is the assertion that catches the raw-SQL shortcut; a direct
   `get` passing proves nothing.
3. A token holding only `read` is **refused** on `calendar_create_event` with `-32004`.
4. A token scoped to a different account cannot reach this account's calendar, and a
   grant-reached write lands a `grant_audit` row.
5. Contacts round-trip: create a card over MCP, see it in Contacts.app over CardDAV.

## Bread-crumbs

- `handleToolCall` is `mcp.ts:234`. The tool lookup is a linear scan at `:246`; `accountId` is
  required at `:250-253`; the `grant_audit` insert is `:263-268`, and the audit method name is
  written as `mcp:${tool.name}` at `:267`. The authorize call to change is `:257`.
- ⚠️ **Done-when #2 is not testable with unit `002` as currently scoped.** `storeFor` needs
  `env.BLOBS` (`common.ts:58`) and the changelog commit needs `env.ACCOUNT_DO`
  (`common.ts:62-63`), so asserting "the write appears in `CalendarEvent/changes`" requires a
  fake Durable Object as well as a fake D1. Either `002` widens or that assertion moves to a
  live `wrangler dev` smoke. Do not quietly drop it — it is the assertion that catches the
  skipped-choreography bug this whole unit is shaped around.
- Tools return `content: [{type:"text", text: JSON.stringify(result, null, 1)}]` (`:273-275`).
  Write tools should return the created/updated id and the **new state string**, so an agent
  can pass `ifInState` on a follow-up and get optimistic concurrency for free — all four `/set`
  methods already honour it (`contacts.ts:126,324`, `calendars.ts:84,204`).
- `CalendarEvent/set` does two-phase batch create with a uid-collision fallback
  (`calendars.ts:220`). Exactly one calendar per event is enforced (`singleCalendarId`,
  `:638-644`). `CalendarEvent/query` accepts only `inCalendar|uid|after|before|text|title`
  (`:351`) and sorts only on `start|updated|created` (`:712`) — do not expose filters the
  method will reject.
- `getOccurrences` (`:402`) is a **non-standard bullmoose extension**, not in the draft spec.
  Fine to expose; note it in the tool description so nobody assumes portability.
- `CalendarEvent/queryChanges` always throws `cannotCalculateChanges` (`:392`). Do not build a
  tool on it.
- Tests: `002` must land first — `Mailstore` calendar writes use `.batch()`
  (`insertCalendarEvents:1513`) and the only fake-D1 in the repo
  (`mcp.test.ts:19-43`, local and non-exported) does not implement it.
- `mcp.test.ts` already has the auth-gate test shape (10 cases, `:94-221`) with real
  `mintToken()` crypto. Extend it rather than starting fresh.

## Open questions / where this could be wrong

1. **In-process import vs service binding.** `services/agent` importing `services/jmap`'s
   method registry directly is simplest but couples two workers at build time; a service
   binding is cleaner and costs a hop plus a second auth pass. I lean **service binding** —
   it keeps the auth gate in one place and matches how `services/anglebrackets` already
   projects off shared state — but I have not measured the added latency inside an agent
   loop, and that could reverse it. **This is the single most consequential open call in the
   unit.**
2. **The write scope is coarse — and that limitation lands here first.**

   *Correction, recorded rather than deleted:* an earlier draft of this file proposed mapping
   calendar/contact writes onto the mail lattice (`draft` to create, `delete` to destroy) and
   listed "invent a per-domain vocabulary" as the costly alternative. **That was wrong.** The
   per-domain vocabulary already exists and is used consistently — `("calendar","calendar")`
   at `calendars.ts:77,200`, `("contacts","contacts")` at `contacts.ts:117,318`. The question
   was already settled in code; I proposed re-deciding it, and picked the losing side.

   The *real* question it exposes: **one scope covers create, update, and delete.** An agent
   granted `calendar` so it can add events can also destroy them, and no finer grant exists.
   `travel@` and `schedule@` in `docs/agents/motivatingExamples.md` both want
   create-without-delete. Fixing that means extending the scope vocabulary — out of scope for
   this unit, but this unit is what makes the gap load-bearing, because it is the first time
   an **agent** rather than a human holds these scopes.
3. **Tool granularity.** I split create/update/delete into separate tools rather than one
   `calendar_set` mirroring JMAP's `/set`. Separate tools give the model clearer affordances
   and let each carry its own scope — but they diverge from the JMAP shape, and a batching
   agent may want one call. Not certain this is right.
4. **`E2` assumes the JMAP methods are actually correct.** They have **zero test coverage**
   (`_context.md` §5). If `CalendarEvent/set` has latent bugs, this unit discovers them and
   becomes E3. Unmeasured risk.
5. **Nothing here was run.** All claims read from source. In particular I have not verified
   that a CalDAV `PROPFIND` from real Apple Calendar succeeds against this deployment — done-
   when #1 assumes it does, on the strength of `dav.ts` handlers alone.
