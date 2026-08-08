# FIX - 006 -P2- Stale agent claims are failed in D1 without a `StateChange`

## Proposal

Change `failStaleRunning` to select the stale rows first, then update and commit per account.

Sketch:

```ts
const stale = await env.DB.prepare(
  `SELECT account_id, id FROM agent_invocations
   WHERE status = 'running' AND claimed_at < ?`
).bind(cutoff).all();

// update by account/id, then:
for (const [accountId, ids] of groupByAccount(stale.results)) {
  await commitChanges(env.ACCOUNT_DO, accountId, [
    { collection: "AgentInvocation", updated: ids },
  ]);
}
```

Use bounded batches if the stale set can be large.

## Tests

Add a unit test around a fake DB + fake DO namespace:

- stale rows for two accounts are updated
- `commitChanges` is called once per account with the right ids
- no commit happens when there are no stale rows

## Operational note

The existing implementation already makes the D1 truth correct. This fix is about keeping the JMAP sync/push contract correct.
