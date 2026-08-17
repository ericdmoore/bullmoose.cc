# 027 -P1- The scope docs draw a lattice; the code implements a flat set

**Subsystem:** common (`packages/auth-core`) · **Severity:** HIGH (silent authorization gaps) · **Fix class:** DECIDE-THEN-CHANGE-CODE

## The mismatch

Every doc in the repo writes the scope vocabulary as an **ordered lattice**:

```
read < annotate < draft < move < send < delete
```

`packages/auth-core/src/index.ts`, `packages/auth-core/README.md`, `packages/cli/src/help.ts`,
and `docs/` all use that notation. `<` reads as *implies*.

`hasScope` implements **flat set membership**:

```ts
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return granted.includes("mail") && MAIL_COVERS.has(required);
}
```

Verified — nothing implies anything except via the `mail` bundle:

```
hasScope(["calendar"], "read")  = false
hasScope(["contacts"], "read")  = false
hasScope(["move"],     "read")  = false
hasScope(["delete"],   "send")  = false
```

This became load-bearing when `common/001` stopped `mail` being a wildcard. Before that, the
mismatch was invisible because almost every token held `mail` and `mail` satisfied everything.

## Symptom 1 — a `calendar` grant can WRITE the calendar but not READ it

- `Calendar/get` gates on `("read", "calendar")` — `services/jmap/src/methods/calendars.ts:58`
- `Calendar/set` gates on `("calendar", "calendar")` — `:77`

So a principal holding **exactly** `["calendar"]` — the scope named after its own domain, the
obvious thing to grant — can create, update and destroy events **it cannot list**.

Identical shape for contacts (`contacts.ts`). Found by sVOL `015`, which pinned the behaviour
in a test rather than working around it.

This is the scope `docs/agents/motivatingExamples.md` implies for `schedule@` and `travel@`.

## Symptom 2 — `move` does not imply `annotate`, so a bundled patch under-charged

`requiredScopesForEmailSet` computed `need.add(touchesMailboxes ? "move" : "annotate")`. A
single patch touching **both** `mailboxIds/*` and `keywords/*` charged only `move` — and since
`move` does not imply `annotate`, a move-scoped token could flip keywords for free by bundling
them into a move.

**Already fixed** (charge for every kind of change a patch makes, with a regression test), but
it is a symptom, not the disease. Found by sVOL `014`.

## Symptom 3 — a `move`-only token cannot resolve a role to a mailbox id

Because `move` does not imply `read`. sVOL `014` worked around it with an explicit
`mailboxId` path and a refusal that names the way out. Reasonable, and it should not have been
necessary.

## Why this is P1

Two independent agents hit it from opposite directions within one batch, and both initially
read the ordered notation as the contract. **The notation is actively teaching the wrong
model**, and the code fails *closed* in ways that look like bugs and *open* in ways nobody has
audited — `common/001` is only three commits old and its consequences are still surfacing.

## The decision this needs

**A total order is not the right model either.** `delete` implying `send` would be wrong: you
want to grant "may clean up" without granting "may mail strangers." So "fix the code to match
the docs" is not the answer — the docs describe something nobody actually wants.

Three candidates:

1. **Realm scopes imply `read` within their own domain.** `calendar` ⇒ `read` when the domain
   is `calendar`. Minimal, fixes symptom 1, leaves mail verbs independent. `hasScope` would
   need the domain, which it does not currently take.
2. **Every write verb implies `read`, full stop.** Fixes 1 and 3. Broader, and arguably right —
   you can hardly move what you cannot see.
3. **Keep the flat set and fix the docs.** Cheapest, honest, and makes every gate explicit —
   but then `Calendar/set` must also demand `read`, and every grant needs two scopes where
   operators expect one.

I have deliberately **not** picked. Closing `common/001` produced two downstream defects in a
day; the next change to this function should be a considered decision, not a fourth patch.

## Related

- `common/001` (✅ closed) — made `mail` a bundle instead of a wildcard. This is its aftershock.
- `fromCodex/003` (✅ closed) — the per-operation `Email/set` gate. Symptom 2 lived in its fix.
- `common/025` item 2 — the vocabulary comment that omits `contacts`/`calendar`/`vault`.
