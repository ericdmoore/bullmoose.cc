# 006 -P2- Stale agent claims are failed in D1 without a `StateChange`

**Subsystem:** agentic-components (`services/agent`) · **Severity:** MEDIUM (stuck watchers / stale agent UI) · **Fix class:** CHANGE-CODE + ADD-TEST

## The defect

Normal invocation completion goes through `finish`, which updates D1 and commits an `AgentInvocation` update to the AccountDO:

- `services/agent/src/index.ts:328-336`

The stale-claim sweep does only the D1 update:

```ts
UPDATE agent_invocations SET status = 'failed', note = 'stale: runner died mid-claim', done_at = ?
WHERE status = 'running' AND claimed_at < ?
```

See `services/agent/src/index.ts:339-345`. It never commits `AgentInvocation` updates for the rows it changed.

## Why it bites

`agent_invocations` is a synced collection. The docs say the AccountDO changelog is the source of push/changes for agent runtimes and clients. If the cron sweep marks a claim failed without a DO commit:

- `bullmoose agent serve` / UI watchers do not get a push
- `AgentInvocation/changes` clients stay stale
- the only way to observe the failure is a later unrelated state change or a direct query

## Secondary issue

The stale update is global (`WHERE status = 'running'`) and can affect many accounts at once. Fixing this requires grouping changed rows by `account_id` before committing.
