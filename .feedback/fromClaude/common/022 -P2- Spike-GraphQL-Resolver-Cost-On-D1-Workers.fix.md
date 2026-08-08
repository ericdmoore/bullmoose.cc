# FIX — 022 -P2- Spike: GraphQL resolver cost on D1 + Workers

## Shape of the spike

**Timebox it, and do not merge it.** The deliverable is a number and a recommendation, not
a service.

### 1. Scaffold (throwaway)

A single Worker with a hand-rolled schema over **three** entities — `Email`, `ContactCard`,
`CalendarEvent`. No framework decision yet; use whatever is smallest that supports
resolvers and batching. Point it at the **existing `Mailstore`**, not a new data layer —
the whole question is whether the facade shape works.

### 2. Implement one traversal, twice

```
naive:   resolver per field, no batching     → establishes the N+1 baseline
batched: per-request DataLoader-style        → the real candidate
```

Batching on Workers: collect ids within a single resolution tick, issue one
`WHERE id IN (...)` per entity type. D1 supports batch statements — check whether
`env.DB.batch()` or a single `IN` clause performs better; they are not the same shape.

### 3. Measure

| Metric | Why |
|---|---|
| **D1 statements per query** | the real cost driver |
| **CPU ms** | the binding constraint (10ms tier limit informed `auth-core:60-66`) |
| wall-clock | secondary |
| same traversal as 3–4 JMAP calls | **the comparison that decides it** |

Run against a **seeded, realistic dataset** — a few thousand emails, not five. N+1 is
invisible at toy scale.

### 4. Decide, and write it down

Update `mcp-auth.md` §14.5 with the measurement and a verdict either way. A negative
result is a **good** outcome — it closes a question that keeps resurfacing, with a real
reason instead of a hand-wave.

## Bread-crumbs

- **Field-level authz must be in the spike**, at least for one field. If `@grantScoped`
  calling `authorizeAccount` per field turns out to be a per-row cost, that changes the
  answer — and it is the thing most likely to be discovered late. Resolve-then-filter is
  not an acceptable shortcut even in a spike, because it would measure the wrong thing.
- Reuse `services/anglebrackets` as the reference for projecting off `Mailstore` without a
  new data path (`dav.ts:106`).
- If the number is marginal rather than clearly good/bad, the fallback is §14's persisted-
  query option: fixed queries exposed as named tools — most of the traversal win, none of
  the arbitrary-shape resolver cost.
- **Sequencing:** do this before `.plans/s03.C-webmail-floor` T1, since that task builds
  the webmail's one JMAP client module and a GraphQL decision would change its shape.
