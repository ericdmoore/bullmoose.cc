# FIX — 023 -P1- Agent kill switch unreachable

## Shape

Smallest possible change that makes the existing control operable. Do **not** fold this into
a general "agent binding CRUD" epic — the value is having a disable route *now*, and a
general update route is a bigger design (rename, retrigger, reconfigure all raise questions
this does not).

### 1. One route, one column

`services/provision/src/index.ts` — add beside the existing binding routes (`:94` create,
`:100` list):

```
POST /accounts/{accountId}/agent-bindings/{id}/disable   → enabled = 0
POST /accounts/{accountId}/agent-bindings/{id}/enable    → enabled = 1
```

Two explicit verbs rather than a general `PATCH {enabled}`. In an incident you want the
dangerous direction to be unambiguous in the audit log and impossible to typo into its
opposite.

Both are gated by `ADMIN_TOKEN` like every other provision route
(`services/provision/src/index.ts:47`).

### 2. CLI surface — this is what makes it usable at 3am

`packages/cli/src/admin.ts` already has `agent bind|list` (`:147`, `:174`). Add:

```
bullmoose admin agent disable <binding-id> --account <acct>
bullmoose admin agent enable  <binding-id> --account <acct>
```

Per `.plans/sVOL-CapSurNoun/readme.md`'s design rule, the CLI surface is what turns this from
`I2` (real but invisible) into `I3` (a human can actually do it). Ship them together.

Register in all three places the CLI requires: import + switch case in `packages/cli/src/main.ts`,
and a help entry in `packages/cli/src/help.ts`.

### 3. Make the drain observable

When the drain skips rows because `b.enabled = 0`, log a count. Otherwise "the agent stopped
working" and "the agent is disabled" look identical from the outside, and someone will spend
an hour on it.

## Bread-crumbs

- **Check whether disabling should also drain the queue.** `services/ingest/src/index.ts:169`
  filters on `enabled = 1` at *enqueue* time, so disabling stops new rows. But rows already
  `pending` stay pending forever — `services/agent/src/index.ts:110` filters them out too, so
  they are neither run nor cleaned up. Decide: leave them (resume on re-enable) or mark them
  cancelled. Leaving them is probably right, but it should be a decision, not an accident.
- `enabled` is `INTEGER` in SQLite (`data-plane.sql:104`); write `0`/`1`, not `false`/`true` —
  `services/provision/src/index.ts:191` passes a JS `true` which SQLite coerces, so match the
  existing style rather than introducing a second convention.
- **Do not reuse this route shape for `responders`.** `responders.enabled` has a real upsert
  path already (`services/provision/src/index.ts:647-651`); it is not in the same broken state.
- There is no test infrastructure for `services/provision` (repo-wide there are 3 test files,
  none covering it). The cheapest proving assertion is an integration one: create a binding,
  disable it, assert the ingest enqueue query returns zero rows for that account. `tools/e2e-grants.mjs`
  is the closest existing harness — note it is itself broken against MCP.2 (`agentic/016`).
- **Sequencing:** land this before `.plans/sVOL-CapSurNoun/007` (on-demand agent trigger).
  `_index.md` footnote 5 already records that edge.
