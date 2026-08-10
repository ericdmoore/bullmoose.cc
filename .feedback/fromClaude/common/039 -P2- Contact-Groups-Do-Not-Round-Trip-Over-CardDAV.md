# 039 -P2- Contact groups do not survive the CardDAV boundary, in either direction

**Subsystem:** common · **Severity:** MEDIUM (silent data divergence between surfaces) · **Fix class:** CHANGE-CODE

## The model, now settled

A group is a **ContactCard**, not an AddressBook and not a property on member cards,
distinguished by two JSContact properties: `kind: "group"` and `members: { "<uid>": true }`.
Confirmed three ways: the `kind`/`hasMember` filter conditions
(`services/jmap/src/methods/contacts.ts:1033-1049`), `hasMember` implemented as *"`$.members`
has this key"* (`packages/mailstore:1791-1794`), and `AddressBookRow` carrying no membership
at all (`packages/mailstore:154-164`).

**The keys are `uid`s, not JMAP ids** — RFC 9553 §2.1.5: *"Each key in the set is the uid
property value of the member"*, and a card with `members` MUST have `kind: "group"`. So
membership resolution needs a `uid`-filtered query and never a `/get`.

This was an open question across several sessions. It is now answered and should be recorded
in `sVOL 022`, which does not mention it.

## The defect

`packages/contacts-core` drops group membership on the way **in** and never writes it on the
way **out**:

- **In:** `cardFromBlock` has `case "KIND"` (`:447`) and **no `MEMBER` case**. Member lines
  fall through to `default: vCardProps.push(jcard(p))` (`:466`) — the verbatim tail.
- **Out:** `serializeVcard` emits neither `KIND` nor `MEMBER`. Its only kind-ish output is
  `X-ABSHOWAS:COMPANY` for `kind === "org"` (`:704`).
- The DAV worker serves **vCard 3.0** (`services/anglebrackets/src/dav.ts:339`), where
  Apple/CardDAV groups are `X-ADDRESSBOOKSERVER-KIND` / `-MEMBER`. Those strings appear
  **nowhere in the repository** outside a comment documenting this gap.
- `packages/cli/src/contacts.ts` carries an identical copy, so `export`/`import` lose it too.

## Consequence — two disjoint group models over one dataset

| made in | visible to JMAP `kind`/`hasMember` | visible in Apple Contacts |
|---|---|---|
| Apple Contacts / CardDAV | ❌ — survives only as opaque `vCardProps` | ✅ |
| the web UI or CLI | ✅ | ❌ |

Nothing is lost and nothing errors, which is what makes it bad: both surfaces look correct
in isolation and quietly disagree about what groups exist.

## Suggested fix

Converter work in `contacts-core`, not screen work — and it must be **both** directions or it
makes the divergence worse: parse `X-ADDRESSBOOKSERVER-KIND`/`-MEMBER` into
`kind`/`members`, and serialize them back. The vCard 3.0 spelling is the one that matters,
since that is what `dav.ts` serves. Note `MEMBER` values are `urn:uuid:<uid>` URIs, so the
mapping is not a bare string copy.

Found while building `/contacts` (s07 T3a), which does the JMAP-native thing and renders a
caveat naming this rather than inventing a shim.
