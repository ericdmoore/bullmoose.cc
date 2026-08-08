# 024 -E1-I1- HumanSettings over WebUI

| | |
|---|---|
| **Kind** | projection |
| **Effort** | **E1** — one file: a form over two methods. No schema, no new method, no new dependency. |
| **Impact** | **I1** — human-verifiable, unlocks nothing |
| **Owner** | **`sVOL`** — no `sNN` section has a settings screen |
| **Depends on** | **`006`** (`Identity/set`) · `021` (the `s03.C` shell) |
| **Status** | todo |

## Cells covered

`HumanSettings × Read × WebUI` · `HumanSettings × Update × WebUI`

The `HumanSettings` noun is two JMAP datatypes (`config.yml:51-53`): **`VacationResponse`**
and **`Identity`**. No create, no delete — both are effectively singletons.

## Why these grades

**E1.** Once `021`'s shell and `JmapClient` exist, this is a single settings route with
two form sections calling four methods, two of which already exist. It clears the E1
anchor (`readme.md:70`) exactly: one file, no schema change, no new method *in this unit*,
no new dependency. The new method (`Identity/set`) is `006`'s work, which is why `006` is
a dependency rather than part of this unit — that is the capability/projection law
(`readme.md:42`) applied literally.

**I1, both factors:**

- *Human-verifiable* — **and unusually strongly so.** The vacation responder is wired end
  to end, not just stored: `services/ingest/src/index.ts:206` arms delivery-triggered
  responders behind an RFC 3834 gate, reading the same `responders` table at `:254`
  (`services/ingest/README.md:20`, step 6), and the AccountDO owns the alarms that fire
  them (`packages/account-do/src/index.ts:105,143`). So the verification is: tick the box
  in a browser, mail the account from an outside address, receive the auto-reply. No
  engineer, no JSON.
- *Unlocks nothing* — nothing in `_index.md` depends on `024`, and no `sNN` section names
  it. It is a leaf.

## What exists today

**`VacationResponse` — complete, and reachable.**

| | Where |
|---|---|
| `VacationResponse/get` | `services/jmap/src/methods/vacation.ts:11` |
| `VacationResponse/set` | `:32` |
| singleton upsert into `responders` | `:50-60` — `INSERT … ON CONFLICT (account_id, id) DO UPDATE` |
| requires the singleton key | `:36-39` — throws `invalidArguments` when `args.update.singleton` is absent |

The id is `"singleton"` per RFC 8621 §8 (`vacation.ts:19`), and the whole datatype is a
facade over one row of the armed-responder primitive (`vacation.ts:4-9`).

> Note on a ref: `_context.md` and the brief for this unit place the singleton check at
> `vacation.ts:39`. The `if (!patch)` guard is `:37` and the `throw` is `:38`. Also,
> "rejects any key but `singleton`" overstates it — it requires `update.singleton` to be
> **present**; other keys in `update` are ignored rather than rejected, and `create` /
> `destroy` are never read at all.

**`Identity` — read-only, and the read is partly synthetic.**

`Identity/get` (`identity.ts:5`) is the only registered `Identity` method — confirmed
against the full 38-method registry (`services/jmap/src/methods/index.ts:15-30`);
`grep -r "Identity/set"` over the source tree returns zero hits. Worse for a settings
screen: when the `identities` table is empty, `Identity/get` **synthesizes**
`identity_default` from the principal (`identity.ts:12-16`), and every response hardcodes
`replyTo: null`, `bcc: null`, `textSignature: ""`, `htmlSignature: ""`, `mayDelete: false`
(`identity.ts:26-30`). Signatures and send-as are unreachable on every surface.

> Second ref correction: `_context.md:135` cites those hardcoded fields at
> `identity.ts:31-34`. They are at **`:26-29`** (`mayDelete` at `:30`).

**No settings surface is planned anywhere.**
`grep -rni "settings\|vacation\|signature" .plans/s03*/` returns three hits, none of them
a screen: two capability inventories (`s03-webAccess/arch.md:18`, `readme.md:136`, both
listing `VacationResponse/*` as **[live]**) and one prior-art note about Nextcloud's
"one settings store" (`readme.md:73`). Zero hits in `s03.C` and zero in `s03.E`. The arc
assumes settings exist and nobody builds them.

## What to build

One route in the `s03.C` shell, two sections:

| Section | Methods |
|---|---|
| **Out of office** | `VacationResponse/get` → form → `VacationResponse/set` with `update: { singleton: {…} }` |
| **Identity** | `Identity/get` → form (name, replyTo, bcc, signatures) → `Identity/set` (**`006`**) |

Both are `Foo/set` calls that honour the account state string, so thread `state` into
`ifInState` and get optimistic concurrency for free — the same pattern `013` and `022`
use.

## Done when

1. A person sets an out-of-office message in the browser, mails the account from an
   outside address, and receives the auto-reply. This is the whole unit's value: it is
   the first bullmoose feature a non-technical user can turn on and observe unaided.
2. Toggling it off stops the replies.
3. A signature set in the browser appears in a message sent from the browser **and** from
   `bullmoose send` — proving `Identity/set` writes the `identities` table rather than the
   synthesized default surviving underneath.

## Bread-crumbs

- **`VacationResponse.htmlBody` is permanently `null`.** `/get` hardcodes it (`vacation.ts:25`)
  and `/set` never reads `patch.htmlBody` — `next` is built from `isEnabled`, `subject`,
  `textBody`, `fromDate`, `toDate` only (`vacation.ts:42-48`). RFC 8621 §8.1 defines the
  field. A rich-text out-of-office editor would silently discard its output. Either keep
  the field plain-text in the UI, or file the server-side gap first. It is not in the
  ledger today.
- The date fields round-trip through `Date.parse` and fall back to the existing value on
  anything unparseable (`vacation.ts:97-104`) — an invalid date in a form field is
  swallowed, not rejected. Validate client-side or the user gets no feedback.
- `VacationResponse/set` requires the `draft` scope (`vacation.ts:33`), `/get` requires
  `read` (`:12`). ⚠️ `common/001` (P1, open): `hasScope` treats `mail` as universal, so
  these gates are weaker than they read (`_context.md` §4).
- The CLI already covers `HumanSettings × R/U` (`_index.md:26`, `-RU-`), so this unit has
  a working reference implementation to compare against, not just a spec.

## Open questions / where this could be wrong

1. **Is this really a unit, or a paragraph in `022`?** Both are small screens in the same
   shell. I kept them separate because the dependency sets differ — this one needs `006`
   and `022` does not — and a unit blocked on a capability should not drag an unblocked
   one with it. Arguable.
2. **`E1` is load-bearing on `006` landing `Identity/set` cleanly.** If `006` discovers
   the `identities` table needs columns for `replyTo`/`bcc`/signatures — likely, given
   `Identity/get` hardcodes them rather than selecting them — then `006` is E3 (migration
   cliff, `readme.md:75-78`) and this unit's schedule moves even though its own grade
   holds. Worth checking when `006` is picked up.
3. **Without `006`, half this screen is a read-only display of four permanently-empty
   fields**, which is arguably worse than not shipping it. If `021` lands long before
   `006`, ship the out-of-office section alone and leave Identity out; it is still `I1`
   and still passes *Done when* 1 and 2.
4. **Nothing here was run.** In particular I have not observed a vacation auto-reply
   actually being sent — the end-to-end claim in *Done when* 1 is read from
   `ingest/src/index.ts:206,254` and the AccountDO alarm handler, not from a delivered
   message. This is the same caveat as `_context.md` §7 and it matters more here than
   usual, because the whole impact grade rests on that path working.
