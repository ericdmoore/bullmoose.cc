# 027 -E2-I0- `Thread/changes`

| | |
|---|---|
| **Kind** | capability |
| **Effort** | **E2** — two lines to register, several files to make it *true* |
| **Impact** | **I0** — not human-verifiable, unlocks nothing. Correct as graded. |
| **Owner** | `sVOL` |
| **Depends on** | — |
| **Status** | **✅ done** (closed 2026-08-14) — registered, not computed: `services/jmap/src/methods/thread.ts:24` answers `cannotCalculateChanges` instead of `unknownMethod`. Two lines, five tests. |

## Cells covered

`Thread × changes` — `_index.md:137`.

Not a CRUD cell. `Thread` is a derived noun with no independent CRUD by design
(`config.yml:19-22`, `_index.md:154`); `changes` is the only thing missing from it.

## What exists today

`Thread/get` is registered at `services/jmap/src/methods/thread.ts:5` and is the *only*
`Thread` method. It maps thread id → `emailIds` via `store.getThreadEmailIds`
(`thread.ts:16`). There is no `Thread/changes`, which RFC 8621 §3.2 defines.

Verified against the complete registry built at
`services/jmap/src/methods/index.ts:15-30` — 38 registered methods, enumerated in
`_context.md:51-64`.

> **Correction to the brief.** `Thread` is **not** the only noun whose `/changes` is
> missing. `Identity/changes` is also absent — `Identity/get` (`identity.ts:5`) is the
> only `Identity` method registered — and RFC 8621 §6.3 defines it. `VacationResponse`
> also has no `/changes`, but the spec defines none for it (§8 is a singleton with
> `get`/`set` only), so that one is not a gap. The `Identity` hole belongs with unit
> `006`, which is already adding `Identity/set`; adding `/changes` alongside it is
> near-free and should be folded in there rather than filed here.

**The registration itself is nearly free — and that is the trap.** `proxyChanges`
(`services/jmap/src/methods/common.ts:69-104`) is the shared `/changes` implementation,
and its `collection` union **already lists `"Thread"`** (`common.ts:75`). So
`registry.register("Thread/changes", (args, ctx) => proxyChanges(ctx, args, "Thread"))`
would compile and return a well-formed response today.

It would also be a lie. `grep -rn '"Thread"'` across the source tree (excluding
`.plans/`) returns **exactly one hit** — that union member at `common.ts:75`. Nothing
anywhere commits a `Thread` entry to the AccountDO changelog, and the DO filters strictly
by collection (`packages/account-do/src/index.ts:289`). A registered `Thread/changes`
would therefore return an eternally empty delta with an advancing `newState` — which is
**worse** than the current `unknownMethod`, because a client would believe it.

## Why these grades

**E2.** The real work is not the registration; it is emitting `Thread` changelog entries
from every path that changes thread membership — `Email/set`, `Email/import`, and inbound
delivery (`services/ingest/src/index.ts`). That is write choreography touching several
files inside `services/jmap` plus `services/ingest`, with no schema change and no
migration. E2 by the anchor (`readme.md:71`). It is not E3 only because the changelog is
already collection-generic (`ChangeEntry.collection: string`,
`packages/account-do/src/index.ts:26-31`) — no new table, no new contract, just more
writers.

**I0, both factors, and I agree with the ledger here:**

- *Not human-verifiable* — the output is a JSON delta with no surface on any client.
- *Unlocks nothing* — nothing in `_index.md` depends on it; no `sNN` section mentions
  `Thread/changes`.

This is the only `I0` in the volume (`_index.md:173`), and it is the honest grade rather
than a pessimistic one.

## The argument that this should never be built

**Threads are derived from Email, and every client already syncs Email.**

- Every `Email` object carries `threadId` — it is in the property allowlist
  (`services/jmap/src/methods/email.ts:27`) and in the `/get` mapping (`:108`).
- The CLI mirror requests `threadId` explicitly (`packages/cli/src/sync.ts:18`) and syncs
  via `Email/changes` (`sync.ts:103`, `:225`).

So a client that runs `Email/changes` → `Email/get` already holds the exact set of
changed thread ids, at **zero additional round trips**. `Thread/changes` would tell it
something it just computed. And a thread cannot change without one of its emails
changing — the derivation is total, not approximate.

The only client this would help is one that renders a threaded list and wants to know a
thread changed *without* fetching its emails. No such client exists here, and it is not
obvious one ever should: `Thread/get` returns only `emailIds`, so knowing a thread changed
without the emails tells you almost nothing renderable.

**What would change my mind:** a strict RFC 8621 conformance suite, or a third-party
client that hard-requires the method. Both are plausible one day; neither is true now.

## Done when *(if ever built)*

1. `Thread/changes` returns a real delta after a new message arrives in an existing
   thread, after a thread's last message is destroyed, and after an `Email/set` that
   changes nothing about threading (which must produce **no** thread entry).
2. Every path that mutates thread membership commits the entry — inbound delivery,
   `Email/import`, `Email/set` destroy. A missed writer is the whole failure mode and is
   invisible without a test per path.
3. The empty-delta case is distinguishable from the not-implemented case for a client
   that was written against today's behaviour.

## Open questions / where this could be wrong

1. **A near-neighbour defect is worse and is already filed elsewhere.**
   `EmailSubmission/changes` is registered with **no** `EmailSubmission/get`
   (`_context.md:108-111`) — a client is told which submission ids changed and has no
   method to read them. That is an actual broken contract, where the missing
   `Thread/changes` is merely an absence. It belongs to unit `005`. Worth naming here so
   nobody reads this file and concludes the `/changes` surface is otherwise clean.
2. **Registering the stub is tempting and should be resisted.** If someone wants the
   conformance checkbox, the only defensible cheap version is to register it and have it
   throw `cannotCalculateChanges` — the same pattern as the four `queryChanges` stubs
   (unit `026`). That is honest. Returning an empty delta is not.
3. **I did not check what real clients do.** As with `026`: if himalaya, Apple Mail, or
   Bulwark call `Thread/changes` and degrade badly on `unknownMethod`, the whole argument
   above flips. Cheap to find out, and it would settle this file permanently in one
   direction or the other.
4. **Nothing here was run.** All claims read from source, per `_context.md` §7.
