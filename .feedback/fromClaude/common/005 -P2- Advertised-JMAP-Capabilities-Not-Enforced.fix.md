# FIX — 005 -P2- Advertised JMAP capabilities not enforced

## Guiding rule

**Never substitute silently.** Both halves of this issue are cases where the server quietly does
something other than what was asked. An error the client can see is always better.

## A. Enforce the request limits in `dispatch`

`jmap-core` owns both the advertised numbers (`capabilities.ts:19-24`) and the dispatcher
(`dispatch.ts:31-61`), so it is the natural home — no worker needs to change.

```ts
// dispatch.ts, before the methodCalls loop
if (request.methodCalls.length > CORE_CAPABILITY.maxCallsInRequest) {
  return problem(RequestErrors.limit, 400, "maxCallsInRequest exceeded");
}
```

That finally uses `RequestErrors.limit` (`errors.ts:8`), which RFC 8620 §3.3 requires and which is
currently dead code.

`maxSizeRequest` belongs at the worker edge (`services/jmap/src/index.ts:102-120`) where the body is
read — check `Content-Length` before parsing, so an oversized body is rejected without buffering.

`maxObjectsInGet`/`maxObjectsInSet` are per-method and best enforced in the `*/get`/`*/set` helpers
rather than centrally — lower priority than the call count, which is the CPU-budget guard.

## B. Fix the sort mismatch — pick one direction

Two defensible options; **(1) is smaller and I'd take it first:**

1. **Drop `"to"` from the advertised list** (`capabilities.ts:45`). We don't index a `to` sort key,
   and sorting by recipient is a rare need in a mailbox view.
2. **Implement it** — needs a sortable column derived from `to_json`, which means a schema change
   and a backfill. Only worth it if a real client asks.

**Independently of that choice, stop substituting:**

```ts
// mailstore/src/index.ts:452
const col = SORT_COLUMNS[s.property];
if (!col) throw new MethodError("unsupportedSort", `cannot sort by "${s.property}"`);
```

`unsupportedSort` already exists at `errors.ts:27`. This is the actual defect — the advertised-list
mismatch is just what exposed it.

## Bread-crumbs

- Keep the advertised constants and the enforcement in the **same module** so they can't drift again.
  A test asserting "every value in `emailQuerySortOptions` has a `SORT_COLUMNS` entry" would have
  caught B and costs three lines.
- `packages/cli/src/sync.ts:97` is the in-repo consumer of `maxCallsInRequest` — good regression
  target once the limit is real.
- Check `services/anglebrackets` for its own query paths before making `unsupportedSort` throw; DAV
  may translate sorts differently.
