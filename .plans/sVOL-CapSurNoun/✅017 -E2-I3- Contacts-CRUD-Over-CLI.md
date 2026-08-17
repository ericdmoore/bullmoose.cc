# 017 -E2-I3- Contacts CRUD over CLI

|                |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| **Kind**       | projection                                                               |
| **Effort**     | **E2** — one CLI module over live methods; no schema, no new JMAP method |
| **Impact**     | **I3** — unlocks _and_ human-verifiable                                  |
| **Owner**      | **`s05-cli-crud`** T2                                                    |
| **Depends on** | `016` (the I/O contract — strictly first)                                |
| **Status**     | ✅ done                                                                  |

## Cells covered

`AddressBook × CRUD × CLI` · `ContactCard × CRUD × CLI`

Today the grid reads `~R--` and `CR--`: books are created only implicitly by `contacts import`
(`contacts.ts:337`) and cards are create-only, dedup-by-uid, skip-existing
(`_context.md` §2 footnotes 8 and 10).

## Why these grades

**E2.** Several files in one package. `packages/cli/src/vcard.ts` already exists at **566
lines** carrying vCard ⇄ JSContact both ways, and `packages/contacts-core` sits behind it —
so this is wiring, not conversion work. No migration; the law in `readme.md` is satisfied
because the capability is complete on JMAP.

**I3, both factors.** _Unlocks_ — `s05/devPlan.md:104-108` sequences T2 into T5 (help/docs
regeneration), a named in-section dependency. _Human-verifiable_ — a person edits a card in
the CLI and watches it appear in Contacts.app over CardDAV, which is already read-write at
resource level.

## Owned by

**`s05` T2** (`s05/devPlan.md:29-40`): `contacts books list|create|rename|rm`,
`contacts create|edit|rm` accepting vCard/JSON on stdin with `-` and `--as`, and
`contacts export [--book]` as the deliberate inverse of `import`. The command → method table
is `s05/arch.md:102-108`. Done-when is the round-trip `import` → `export` → `import` with no
drift (`devPlan.md:37`), which is the cheapest correctness test available for
`contacts-core`.

**s05's "no server work" claim holds for T2.** Verified at HEAD (`8ba3fe3`):

- `AddressBook/set` — `services/jmap/src/methods/contacts.ts:116`
- `ContactCard/set` — `services/jmap/src/methods/contacts.ts:317`

Both live and registered. `AddressBook` has no `/query` (`_context.md` §2 footnote 7), but
s05 never needs one — `contacts books list` maps to `AddressBook/get` (`arch.md:102`), so
unit `012` is not a blocker here.

## What sVOL adds

Almost nothing — the owning section is sufficient. One constraint it does not name:

**`AddressBook/set` refuses delegated access.** `contacts.ts:117-121` throws `forbidden` —
_"only the account owner manages address books"_ — whenever `access.granted` is true. So
`contacts books create|rename|rm` works for the account owner and fails for any principal
reaching the account through a grant, including an agent. s05's table
(`arch.md:104`) lists these as plain "new" commands with no such caveat. It is correct
behaviour, not a bug; it just needs to be in the help text and in whatever test covers the
book lifecycle, or it will read as an auth misconfiguration the first time an agent hits it.

## Open questions / where this could be wrong

1. **The I3 is the weakest of the three CLI units.** Nothing in `_index.md` depends on `017`;
   the "unlocks" factor rests entirely on T5 _inside_ s05, which is a real named edge but a
   thin one. By the strict reading in `readme.md` ("a named dependency, not 'would be nice
   to have first'"), a reviewer could put this at I1. I kept I3 for consistency with `018`,
   which has the stronger case.
2. **The round-trip test may be weaker than it looks.** `import` → `export` → `import` with
   no drift proves `vcard.ts` is self-consistent; it does not prove it agrees with
   Contacts.app. Only a CardDAV read from a real client does that, and nothing in T2 asks
   for one.
3. **566 lines of `vcard.ts` have zero test coverage** — `packages/cli` is excluded from
   coverage entirely (`vitest.config.ts:25`) and has no test directory. The E2 grade assumes
   that conversion code is correct. If it is not, T2 discovers it.
4. **Nothing was run.** Both `file:line` refs were checked against the source at `8ba3fe3`;
   neither method was invoked.
