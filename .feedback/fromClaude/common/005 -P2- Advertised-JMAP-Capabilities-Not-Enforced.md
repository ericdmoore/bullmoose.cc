# 005 -P2- Advertised JMAP capabilities are not enforced (limits + sort options)

**Subsystem:** common (`packages/jmap-core`) · **Severity:** MEDIUM · **Fix class:** CHANGE-CODE

Two instances of the same pattern: the session advertises a contract to clients that the server does
not hold itself to. Both violate RFC 8620 and both fail **silently**.

## A. `maxCallsInRequest` and friends are decorative

`packages/jmap-core/src/capabilities.ts:19-24` advertises:

```
maxSizeRequest: 10_000_000 · maxConcurrentRequests: 4 · maxCallsInRequest: 16
maxObjectsInGet: 500 · maxObjectsInSet: 500
```

But `dispatch` (`packages/jmap-core/src/dispatch.ts:31-61`) iterates **every** entry of
`request.methodCalls` with no count or size check, and `services/jmap/src/index.ts:102-120`
validates only JSON-ness, request shape, and `using`.

`RequestErrors.limit` (`packages/jmap-core/src/errors.ts:8`) — required by RFC 8620 §3.3 — has
**zero references repo-wide**.

Note our own client trusts the number: `packages/cli/src/sync.ts:97` chunks batches "at the server's
`maxCallsInRequest`". A less polite client has no such manners, and `maxCallsInRequest` is the only
stated guard on the free-tier 10ms CPU budget per batch.

## B. `Email/query` advertises a sort it cannot do — and silently reorders

`capabilities.ts:45` advertises `emailQuerySortOptions: ["receivedAt","size","from","to","subject"]`,
served live at `services/jmap/src/session.ts:63`.

But `packages/mailstore/src/index.ts:1848-1853` — `SORT_COLUMNS` has only `receivedAt`, `size`,
`subject`, `from`. The `EmailSort` type (`:93-96`) omits `"to"` entirely.

Worse, `:452` does:

```ts
SORT_COLUMNS[s.property] ?? "received_at"
```

So a client that asks to sort by `to` **gets a different order than it requested, with no error**.
`unsupportedSort` (`packages/jmap-core/src/errors.ts:27`) is defined and thrown nowhere.

Silent wrong-order is worse than a spec'd error: the client cannot detect it, and paginated results
become incoherent.
