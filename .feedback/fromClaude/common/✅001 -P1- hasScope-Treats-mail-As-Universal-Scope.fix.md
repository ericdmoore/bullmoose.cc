# FIX — 001 -P1- `hasScope` treats `mail` as a universal scope

## Proposal

**Make `mail` expand to a closed set, and make unknown scopes deny-by-default.**

```ts
// packages/auth-core/src/index.ts
export const MAIL_SCOPES = ["read","annotate","draft","move","send","delete"] as const;
const MAIL_COVERS: ReadonlySet<string> = new Set(MAIL_SCOPES);

export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return MAIL_COVERS.has(required) && granted.includes("mail");
}
```

Effect: `mail` keeps covering the six mail verbs (its documented meaning), and stops silently
covering `vault`, `contacts`, `calendar`, and anything added in future. `scopesWithin` inherits the
fix for free.

## Migration — this is a breaking change for live tokens

Every existing `["mail"]` token loses contacts/calendar/vault access the moment this lands. That is
the *point*, but it will break working setups (Apple Mail via anglebrackets, the CLI's own contacts
commands) unless handled.

**Recommended sequence:**

1. Land the `hasScope` change behind a **grace list**: log-and-allow for `contacts`/`calendar` with a
   `console.warn` naming the token id, deny outright for `vault`. Vault is the one with real blast
   radius and has no legitimate `mail`-token consumer.
2. Add a one-shot migration/report: which live tokens actually exercised contacts/calendar (the
   `last_used_at` + `grant_audit` trail helps), then widen those tokens explicitly.
3. Flip contacts/calendar to deny once the grace log is quiet.

## Bread-crumbs for the implementer

- **Test first.** `packages/auth-core/src/principal.test.ts` already exercises scope logic
  (`'treats "mail" as a superset of every mail verb'`) — that test asserts the *current* behaviour
  for `send` and stays green. Add cases asserting `mail` does **not** cover `vault`/`contacts`/
  `calendar`, and they should fail before the change.
- **Call sites to re-check** after the change: `services/agent/src/vault.ts:75`,
  `services/jmap/src/methods/contacts.ts:766`, `calendars.ts:77,200`,
  `services/anglebrackets/src/dav.ts:179,640`.
- **Minting defaults** are a separate decision (see cli issue on `token create` defaulting to
  `mail`). Fixing `hasScope` alone still leaves "the default is the widest thing" — worth pairing.

## Docs to update in the same pass

- `packages/auth-core/README.md:10-12` — state the closed set explicitly.
- `docs/architecture/mcp-auth.md:197` — the vault-scope claim becomes true only after this fix;
  until then it is aspirational. §6.3's "trap" note can be shortened to point here.
- `docs/cli.md:123` — describe `mail` as "the six mail verbs", not "all verbs".
