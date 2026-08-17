# 038 -P2- `bullmoose vacation --if-state` is silently ignored

**Subsystem:** cli · **Severity:** MEDIUM (advertised guard that does not exist) · **Fix class:** CHANGE-CODE

## The claim

`packages/cli/src/main.ts:797-800` sends the optimistic-concurrency guard:

```ts
const res = await client.one("VacationResponse/set", {
  accountId: account.accountId,
  ...ifInState(),
  update: { singleton: patch },
});
```

Every other `Foo/set` in the CLI does the same thing and means it. `sVOL 024:96-99` states the
assumption directly: _"Both are `Foo/set` calls that honour the account state string, so thread
`state` into `ifInState`."_

## The defect

`services/jmap/src/methods/vacation.ts` **never mentions `ifInState`** — `grep` returns nothing.
The argument is accepted by the dispatcher and dropped on the floor. A caller who passes a stale
state string gets a successful write, not a `stateMismatch`.

## It is worse than an unread argument

The method reads `oldState` (`vacation.ts:34`) and re-reads `newState` (`:65`) but **commits no
`ChangeEntry`**, so nothing moves the account state between the two reads: `oldState === newState`
on every call.

So even if the comparison were added, the guard could not work. There is no state transition for a
concurrent writer to lose a race against, which means:

1. `VacationResponse` changes are invisible to `/changes` and to any client syncing on state.
2. Implementing `ifInState` here is not a one-line fix — it needs the write to participate in the
   changelog first, which is the same `commitChanges` choreography every other collection follows.

## Consequence

A user who runs `bullmoose vacation on --if-state <state>` believes they have a compare-and-set.
They have a plain overwrite. Last writer wins, silently. That is the failure mode optimistic
concurrency exists to prevent, dressed as the fix for it.

## Suggested fix

Two honest options, in order of cost:

1. **Reject the argument** — return `invalidArguments` when `ifInState` is present, and drop it
   from the CLI. Ugly, but it stops lying immediately and is a few lines.
2. **Make the write participate in the changelog** (bump ctag → `commitChanges` → newState), then
   compare `ifInState` like every other `Foo/set`. This is the right fix and it also closes the
   `/changes` invisibility above.

Do **not** simply add the comparison against the current implementation — with `oldState ===
newState` it would pass unconditionally, which is a guard that looks enforced and is not.

Found while building `/settings` (s07 T2), which deliberately omits `ifInState` on this one call
and says so on the page rather than advertising a protection the server does not provide.
