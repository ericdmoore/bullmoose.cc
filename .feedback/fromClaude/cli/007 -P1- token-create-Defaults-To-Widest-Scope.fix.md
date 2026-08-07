# FIX — 007 -P1- `token create` defaults to the widest scope

## Proposal

**Least privilege by default.** Three options, in order of preference:

1. **Require `--scopes`.** No default; exit 2 with a usage error listing the vocabulary and a
   recommended set per client type. Most explicit, mildly annoying, and the annoyance is
   proportionate to what is being minted.
2. **Default to `read`.** Safe, and a read-only token is genuinely useful (sync, backup, search).
   Users who need write get told by the first failure.
3. Keep `["mail"]` but **print a warning to stderr** naming exactly what it grants. Weakest — a
   warning nobody reads is not a control — but it is the zero-friction option if (1)/(2) break
   existing flows.

I'd take **(1)** for `admin token create` (an operator action, explicitness is cheap) and **(2)** for
`bullmoose token create` (a user action, friction matters).

Either way this should land **with or after** `common/001`, not before — fixing the default while
`mail` still means "everything" only narrows the blast radius of new tokens, and leaves every
existing one wide.

## Docs to update in the same commit

- `docs/cli.md:120,128` — state the default explicitly in the synopsis.
- `docs/cli.md:123` — describe `mail` accurately. After `common/001` it is "the six mail verbs";
  until then it is "everything except admin", which is worth saying plainly because it is alarming.
- `docs/cli.md:137` — drop the redundant `mail,contacts,calendar` example; replace with a genuinely
  scoped one (`--scopes read,draft` for a mail client; `--scopes contacts` for a CardDAV-only
  device).
- `docs/cli.md:138` — the POP3 example should show an explicit narrow scope.

## Bread-crumbs

- Both call sites (`tokens.ts:101`, `admin.ts:232`) share the same shape — factor the default into
  one helper so they can't diverge.
- `services/provision/src/index.ts:467` has the same server-side default; changing only the CLI
  leaves the API wide. Decide whether the server should also refuse an unscoped mint.
- `scopesWithin` (`auth-core/src/index.ts:56-58`) governs self-service minting — check that a
  narrowed default doesn't break the CLI's own `token create` when run with a narrow parent token.
