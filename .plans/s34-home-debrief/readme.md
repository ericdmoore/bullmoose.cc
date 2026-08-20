# s34 — Home as the house debrief · *what still needs you, and what the house spent*

> **Status: DESIGN.** Nothing built. Written 2026-08-20 from the conversation that
> revised s07 T0: `/` is still a **view** (not a nav section), but it is no longer
> "two stacks you arrive to decide on." It is a **debrief** — Needs you beside a
> **usage** wallet — and Looking ahead is **issues with time left to act**, not an
> agenda. The ordered build lives in this file until a `devPlan.md` is worth
> splitting off.

s07 T0 (`webmail/src/pages/index.astro`, `HomeView.tsx`, `lib/home/*`) shipped the
page that made this not a file manager: pending approvals, urgency-ordered, plus a
horizon of today/tomorrow's events, expiring decisions, and lapsing holds. That
page is still `/`. This section replaces **what it is for**.

## What it is

You open the house. Two bands:

1. **Needs you** — the things that still stop for a human, and the clocks that
   will stop *without* one if nobody moves.
2. **Wallet** — what the agents actually spent and burned, as a **time graph**
   you can switch, plus a few incident chips that hide at zero.

Empty is the healthy state for Needs you and for every chip. The wallet may still
show a quiet month of usage; that is information, not an alarm.

`/` remains **not a section**. `lib/app/sections.ts` does not grow a "Home" item.
The brand in the nav still lands here.

## What it is not

- **Not a dashboard of counts.** One chart, not five gauges. s07 was right to
  refuse a mall of unread / files / per-agent bars. It was wrong to treat *any*
  house-health pane as a betrayal of "you arrive to decide."
- **Not a budget vs target.** v1 is **usage**. Caps, remaining, "on track," and
  projected overage stay off the plot until observability makes a threshold
  *actionable*. There is no household `spendPerMonth` today — caps are per
  binding (`ConsoleBindingEconomics.budgetMicros`) — so a household cap line
  would be a number we invented.
- **Not a mini `/approvals`.** Home rows do not Approve / Edit / Decline.
  `HomeView.tsx` still does; this section removes that. Consent stays on
  `/approvals` (and anywhere else s20 T6 distributes it). The glance **deep-links**
  to the specific decision: `/approvals?p=<id>` already focuses it
  (`ApprovalsQueue.tsx` reads `?p=` once at init).
- **Not today's calendar.** A healthy day would fill an agenda stack. Looking
  ahead here is the opposite: **raise the problem while other people can still
  move.**
- **Not s27.** s27 is the platform ledger (by gateway, by task, p50/p90, invoices).
  This is the **human glance** over the same underlying rows. Do not duplicate
  FinOps tables on `/`.

## Locked (2026-08-20)

| decision | call |
|---|---|
| Wallet on home | yes — spend is top-of-mind house health, not a Settings afterthought |
| Chart | one plot, **radio** rail (exclusive). Checkboxes would overlay mixed units |
| Default metric | **$ spent** this UTC month (daily). Cumulative line is easier to read as a wallet than daily bars; pick one and keep it |
| Other rail rows | **Tokens** · **µ / tok** (realized: priced `cost_micros` / (in+out) tokens). Unpriced runs in the **caption**, never a cheap-looking dip |
| Tokens mix | series chips **under** Tokens: by agent (default) / by pipeline. Same y-axis, not extra rail rows |
| Budget / target | **later.** No cap line. Near-cap (80%) and projected overage stay off |
| Whose money | **household usage** — every binding on accounts the operator can already see. No account picker for a cap that does not exist |
| Approvals | **glance** + `/approvals?p=<id>` (held rows: also `c=held`, or the focus lands in the wrong collection) |
| Looking ahead | **issues with time left**, not events today/tomorrow |
| Waiting-on / commitments | **off this band** until they carry a clock (annotations have `body`, not `dueAt` — `webmail/src/lib/annotations/types.ts`) |
| Goal-contract dollars | **off the chart.** `lib/goals/contract.ts` `budgetLine` is not money promised to anyone |
| Sequencing | **chrome + chips now; do not draw a usage line until the daily rollup exists** |
| Chart kit | SVG polyline / area. No chart library. `brand-*`, not indigo. No Headless UI (CSP) |

## The two bands

### Needs you

**Approvals (glance).** Pending only, most-urgent first, cap `HOME_APPROVALS_LIMIT`
(5) — reuse `lib/home/waiting.ts` and `orderQueue`. Each row is a link, not a
panel: verb, cost (`costLabel` — NULL ≠ 0), shrinking `expires in` when present,
`/approvals?p=<id>`. Overflow is "N more → `/approvals`".

**Looking ahead (issues, hide when empty).** v1 is the shrinking clocks we
already have, **without** `eventItems`:

- pending `expiresAt` — *how long until I lose the chance to decide*
- held `holdUntil` — *how long until this becomes irreversible*

Those two clocks must not be conflated. `lib/home/horizon.ts` already forks them
via `rowClocks`; keep that. Stop feeding calendar occurrences into this list.
`eventItems` can remain for `/calendar` or die unused — do not keep it on `/` as
a silent agenda.

A later **calendar agent** writes **into this same list** (new `HorizonKind`s:
overlap, travel-impossible, "you'll be late") instead of getting its own column.
That producer does not exist. Free/busy and iTIP were skipped
(`docs/devPlan-handoff.md`). Do not fake an empty-state that pretends a scan ran.

### Wallet

```
[x] $ spent     |                                        |
[ ] tokens      |            one plot, UTC month         |
[ ] µ / tok     |                                        |
                |________________________________________|
 oldest pending · last fails · key refused · cap exhausted
 (each hide-at-zero)
```

**Incident chips** sit **above** the plot. They are discrete; they are not rail
metrics.

| chip | show when | source already |
|---|---|---|
| **Oldest pending** | any `pending > 0`; **loud after 4h** | `ConsoleBindingLedger.oldestPendingAt` (`readLedgers` in `services/jmap/src/console.ts`) |
| **Latest fails** | last **5** `failed` this UTC month | dossier tail is only `INVOCATION_LIMIT` (25) recent rows, any status — **not** "last 5 fails this month." T1 may say "in recent invocations"; T2's rollup owns the honest month window |
| **Key refused** | a BYOK ref whose status is not `live` | `tenantByokView.refusing` (`webmail/src/lib/byok/status.ts`). Hide at zero. **Do not** alarm `onPlatformKey` — that is the default, including after an intentional detach |
| **Cap exhausted** | a binding whose **existing** `spendPerMonth` gate has already stopped paid work | `economicsView(…).state === "exhausted"` — the claim gate's arithmetic, not a household target. Hide at zero. This is the one budget fact v1 is allowed: a lock that **already fired** |

`enforcement: broad` is a security footnote on the dossier, not a wallet chip.

## What already exists (do not rebuild)

| piece | where | enough for |
|---|---|---|
| Pending glance selection | `lib/home/waiting.ts` | T0 approvals band |
| Expiring / hold items | `lib/home/horizon.ts` (`expiringItems`, `holdItems`) | T0 looking ahead, once `eventItems` is dropped from `lookingAhead()` |
| Deep link to a decision | `/approvals?p=<id>` (`ApprovalsQueue.tsx`) | T0; today home and horizon hrefs are often bare `/approvals` |
| Per-binding month spend, pending/failed, oldest pending | `readLedgers` — grouped SQL, UTC month via `budgetMonthStartMs` | T1 chips; **not** a daily series |
| Frozen per-run cost + model | `agent_invocations.cost_micros`, `model`; `readInvocations` already selects them | receipt on a row |
| Tokens on the row | `tokens_in`, `tokens_out` stamped at `finish()` (`services/agent/src/index.ts`) | T2; **not** on the console wire |
| NULL ≠ 0 cost | s07 T5; `costLabel`; `readSpend` excludes NULL | every money figure on this page |
| Grouping by pipeline × model | `frontierDigest.ts` `joinFrontier` (monthly **mail**, not a chart) | the honesty rules T2 must reuse (priced vs unpriced, NULL never summed as $0) |
| Binding pipeline | `ConsoleBindingConfig.pipeline` | join for tokens/taskType; invocations do not carry pipeline |
| Detached / refusing keys | `ProviderCredential/get` → `tenantByokView` | T1 key chip |
| Demo home | `lib/home/demoHome.ts` | fixtures for both bands |

## What does not exist (do not fake)

- A **daily bucket** API. `readInvocations` is `ORDER BY created_at DESC LIMIT 25`
  (`INVOCATION_LIMIT`). Client-side summing of that tail is not the month.
- `tokens_in` / `tokens_out` on `ConsoleInvocation` (`webmail/src/lib/console/types.ts`;
  `readInvocations` does not SELECT them). MCP `listInvocations` in
  `introspectTools.ts` omits them too (`INVOCATION_COLUMNS`).
- A **household** console route. Dossiers are per `accountId`. T1 may N-fetch
  `listAgents` + `agentDossier` (AgentsApp already does). T2 should be **one**
  projection, not 25×N rows in the browser.
- Double-book / drive-time / "time to adjust with other people." No calendar
  agent, no free/busy.
- Due dates on commitments or waiting-on.
- A chart primitive in webmail (grep: none).

## Chrome vs rollup

Two different builds. Mixing them is how a demo line becomes a production lie.

**Chrome** — everything true without a time series: the two bands, the radio
rail, an **empty** plot whose caption admits the series has not landed, the
incident chips from ledgers / BYOK / `economicsView`.

**Rollup** — one UTC-month series, one row per civil day (UTC, same clock as
`spendPerMonth` / `budgetMonthStartMs`):

```
day, spendMicros, tokensIn, tokensOut, pricedRuns, unpricedRuns,
failed, byBinding[], byPipeline[]
```

`spendMicros` sums **priced** `cost_micros` only (0 is free and counts; NULL
does not). `unpricedRuns` is a count, spoken in the caption. Pipeline comes from
the **binding**, not the invocation. Failed is a count of `status = 'failed'`
with `created_at` (or `done_at`) in that day — pick one clock and test it.

Until that payload exists, the plot is empty. Demo mode may draw a **labelled**
sample series (`?demo=1`); live mode must not.

## Doctrine this revises

s07 T0: `/` is not a section and **not a dashboard of counts**; two stacks;
Waiting Approvals act **inline**. Comments in `index.astro`, `HomeView.tsx`, and
`sections.ts` still say that. T0 of *this* section updates those comments in the
same commit as the markup, or they will keep winning code review.

s20: "the agent consumes the firehose; the human gets exceptions." Looking ahead
as issues (not agenda) is that rule applied to time. Approvals as glance+link is
s20 principle 6 (approval is an act, not a place) without turning `/` into a
second queue — the failure s03.D named.

s26 T1: spent-vs-remaining stays on the **dossier**. Home does not grow per-agent
spend bars. The exhausted chip is the only cap state that crosses onto `/`.

## Tasks

### T0 — Needs you · glance + shrinking clocks

**Files:** `HomeView.tsx`, `index.astro` (drop `.home-*` page CSS in favour of the
six-surface kit), `lib/home/horizon.ts`, `lib/home/waiting.ts` (hrefs),
`lib/home/demoHome.ts`, comments in `sections.ts`.

- Two-band layout (Needs you | Wallet). Wallet may be a labelled empty pane
  until T1.
- Approvals: pending glance, **no** `Panel` / `act` / edit / decline on this
  page. Rows link `/approvals?p=<id>`.
- Looking ahead: `lookingAhead()` stops calling `eventItems`. Keep expiring +
  hold. Deep-link held rows so `?c=` matches. Empty = omit the list, not
  "nothing…".
- Remove the waiting-on and commitments columns from `/` (queries stay in
  `lib/home/commitments.ts` for whoever still wants them; they are not this
  band).
- Do not invent a create-FAB for approvals.

**Done when:** a visitor with pending + a near-expiry hold and a full calendar
sees decisions and clocks, **not** today's events; clicking a row opens that
proposal on `/approvals`; an unauthenticated visitor still redirects to `/login`.

### T1 — Wallet chrome (no line)

**Files:** `lib/home/` (pure chip/rail helpers + tests), `HomeView.tsx`,
`demoHome.ts`; read `listAgents` / dossiers / `ProviderCredential/get` the way
Agents/Settings already do.

- Radio rail: $ · Tokens · µ/tok. Selecting Tokens/µ/tok on an empty plot
  changes the caption, not invented data.
- Chips as in the table above. Hide at zero. Oldest pending loud after 4h.
- Household: union of ledgers the operator can read. If the console is
  unavailable, say so — do not wear demo numbers on a live session
  (`ConsoleUnavailable` posture).

**Done when:** chips match the same numbers the dossier would show for those
bindings; a house with no pending, no fails, no refusing keys, no exhausted cap
shows a quiet wallet rail and no chips; live mode never draws a usage polyline.

### T2 — Daily usage rollup

**Files:** agent/jmap console (one household-or-per-account projection — prefer
one route the home client can call per owned account, then sum in a tested
pure module), `webmail/src/lib/console/types.ts`, a fake for tests.

Reuse `joinFrontier`'s NULL-vs-0 rules. Do not COALESCE NULL `cost_micros` into
the spend series. Do not serve 200 raw invocations and call it a chart.

**Done when:** a month with priced, free (0), and unpriced runs renders three
distinguishable facts; tokens/taskType agrees with binding pipeline; a test
proves SUM of daily `spendMicros` equals SUM of priced `cost_micros` for
`done_at` in that UTC month (same arithmetic as `readLedgers.monthSpendMicros`,
or a documented, tested difference).

### T3 — Draw the line

**Files:** a small SVG in `webmail/src/components/` (or `lib/home/chart.ts` +
thin markup); tests for scales, empty month, single-day.

Bind the rail to T2. Tokens chips: by agent / by pipeline. µ/tok uses priced
runs only.

**Done when:** `?demo=1` and live agree on shape; live with no rollup still
refuses to draw (T1 caption); live with rollup can switch $ / tokens / µ/tok
without a reload of the house.

### T4 — Calendar issues producer · *deferred*

Not a UI task. A calendar agent (or a deterministic pass) that emits overlap /
travel-impossible / "late if you leave now" into the same Looking ahead list,
while there is still time to write to other people.

**Blocked on:** a calendar agent, travel-time or at least overlap detection,
and a clock on the finding. Free/busy is still skipped. Do not start T4 inside
T0 by putting events back on `/`.

**Done when:** a double-booked Tuesday appears on home as an issue with a
deep link to `/calendar`, and a conflict-free week omits the list.

## Out of scope (named so they do not sneak in)

- Household or per-agent **budget vs actuals** on the plot (s26 dossier; s27 later)
- Blended ranking price (the 1:3 input:output map in `models.ts` `refreshPricing`)
  as a displayed µ/tok — that blend is for **route ranking**, and the file
  already refuses it for recorded cost
- Storage / R2 quota, unread mail, auth-token inventory
- `info-requested` as a fourth column (optional later: a hide-at-zero chip to
  `/approvals?c=info`)
- Pulling Recharts / Headless UI Menu / indigo

## Related

- [[s07-app-surface]] T0 — the page this replaces; `/` is still a view
- [[s20-agent-native-ux]] — exceptions not firehose; approval is an act
- [[s23-activity]] — retrospective twin; fails chip drills toward this family, not a syslog
- [[s26-agent-config]] — dossier economics, ledgers, BYOK; home must not grow a second dossier
- [[s27-usage-and-spending]] — the deep ledger; this section is the glance
- `lib/home/horizon.ts` — two clocks
- `services/agent/src/frontierDigest.ts` — priced vs unpriced grouping
- `services/jmap/src/console.ts` `readLedgers` / `readInvocations` / `readSpend`
