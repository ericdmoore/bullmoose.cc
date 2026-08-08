# 020 -E2-I2- Creds mint-time fields

| | |
|---|---|
| **Kind** | filed as projection — **it is not** (see below) |
| **Effort** | **E2** only if the fields ride in `meta_json`; **E3** if they get typed columns |
| **Impact** | **I2** — unlocks, not human-verifiable |
| **Owner** | **`s05-cli-crud`** T4 + **`s04-AgentOS`** (`bureau.md` §5) |
| **Depends on** | the `s04` spec (`bureau.md` has **zero tasks**, `_context.md` §6) |
| **Status** | todo |

## Cells covered

`Secrets × Create × CLI` · `Secrets × Update × CLI`

`Secrets × Read` is **`n/a` by design**, not a gap — `bureau.md` invariant 1, no reveal
button. `creds show` returns metadata only.

## Why these grades

**E2, conditionally.** `src/creds.ts` plus vault routes is one package and one service. But
`--allow`/`--header`/`--scope` have nowhere to live without either a schema change (→ **E3**
by the migration-cliff rule, `readme.md:72`) or stuffing them into the existing untyped
`meta_json`. The ledger's E2 is only defensible under the `meta_json` route. Flagging rather
than renumbering.

**I2 is exactly right, and for a principled reason.** *Unlocks* — the Bureau cannot enforce
`--kind` or `--allow` if they were never minted, and s03.E's console reads them. *Not
human-verifiable* — the vault is write-only by construction, so there is no interface where a
non-engineer can see that a credential was minted correctly. The same invariant that makes
this safe makes it invisible.

## Owned by

**`s05` T4** (`s05/devPlan.md:62-84`) carries the CLI surface; **`s04-AgentOS/bureau.md` §5**
(`:124-159`) defines the contract, with §5.1 (`:161-173`) separating minting from authorizing
and §5.2 (`:175-256`) settling provider-side narrowness. s05's own framing at `arch.md:160-189`
and `readme.md:60-88`.

## What sVOL adds

**s05's headline claim — "No server work — every method this slice calls is already live"
(`s05/devPlan.md:4`) — is false for T4.** Three independent verifications at HEAD (`8ba3fe3`):

**(a) Two of the four `--kind` values cannot be minted.** `services/agent/src/vault.ts:89-91`
hard-rejects anything but the two it knows —
`if (body.kind !== "api-key" && body.kind !== "oauth-refresh") return json(…, 400)` — so
`--kind aws-sigv4|hmac-key` (`s05/arch.md:170`, `bureau.md:128`) is a 400 today. And `--kind`
is the field `bureau.md:141` calls load-bearing: it gates the verb set.

**(b) There is no `rotate`.** `vault.ts` has exactly three routes: `PUT /vault/credentials`
`:79`, `GET /vault/credentials` `:124`, `DELETE /vault/credentials/{name}` `:142`, then a 404
fallthrough at `:151`. Zero occurrences of "rotate" in the file. `creds rotate`
(`devPlan.md:78`, `arch.md:175`, `bureau.md:158`) has nothing to call. *Credit where due:* the
verify endpoint T4's done-when leans on (`devPlan.md:83`) **does** exist —
`handleVaultVerify`, decrypt-and-discard.

**(c) `--allow`, `--header` and `--scope` have no columns.** `vault_credentials`
(`packages/mailstore/sql/control-plane.sql:121-131` — the ref circulating as `:118` lands in
the comment block above it) is: `id, principal_id, name, kind, enc_json, meta_json,
created_at, updated_at`. Only untyped `meta_json`. The DDL comment at `:124` pins `kind` to
`'api-key' | 'oauth-refresh'`, matching (a). Fail-closed destination binding —
`bureau.md:140` calls `--allow` *the* primary control — cannot be queried or enforced from a
JSON blob without every reader parsing it identically.

**Recommendation: split T4 out of `s05`.** s05's premise is class (b), "the server *can*, the
CLI doesn't expose it" (`s05/readme.md:19-23`). T4 is class (a). It needs a vault kind
allowlist widened, a route added, and a storage decision made — none of which is CLI work,
and all of which belongs with the s04 spec that defines the fields. Leaving it inside s05
means the section's one true sentence is also its most quoted one.

**Also: the contract is already one flag behind.** `bureau.md:132` and `:143` add
`--enforcement federated | narrow | broad` — which rung of the §5.2 ladder enforces the
narrowing, with `broad` meaning *only our code does*, surfaced in the console "so that is
visible, not tribal knowledge". Neither `s05/arch.md:168-179` nor `devPlan.md:70-78` lists
it. If the point of shipping the flags early is that "the CLI surface doesn't change twice"
(`readme.md:88`), it is about to change twice.

## Open questions / where this could be wrong

1. **`meta_json` vs typed columns is the real decision here, and nobody has made it.** I lean
   typed for `--allow` (it is enforced on every egress request and wants an index) and
   `meta_json` for the rest — but that lands the unit at E3 and the ledger says E2. I did not
   resolve it; I recorded that it is unresolved.
2. **Splitting T4 out is my recommendation, not a finding.** The three verifications are
   facts; "therefore move it" is a judgement, and the counterargument — that the CLI is the
   only safe ingestion path (`mcp-auth.md` §9) so the surface belongs where the CLI work is —
   is decent.
3. **`creds show` is not blocked.** GET `:124` returns the whole collection with
   name/kind/meta/timestamps, so `show` is a client-side filter. I nearly filed it as a
   fourth missing route; it is not one.
4. **`s04` has no tasks at all** (`_context.md` §6), so "depends on the s04 spec" is a
   dependency on a document, not on work. That edge is softer than `_index.md` makes it look.
