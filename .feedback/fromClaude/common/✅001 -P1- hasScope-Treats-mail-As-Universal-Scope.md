# 001 -P1- `hasScope` treats `mail` as a universal scope

**Subsystem:** common (`packages/auth-core`) · **Severity:** HIGH (security) · **Fix class:** CHANGE-CODE + UPDATE-DOC

Three independent audit passes (common, cli, agentic) landed on this same root cause. Filing
once, with all three symptoms.

## The defect

`packages/auth-core/src/index.ts:50-53`:

```ts
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return required !== "admin" && granted.includes("mail");
}
```

`mail` satisfies **any** string except `admin` — including scopes invented later. Verified:

```
mail → vault     true      mail → send    true
mail → contacts  true      mail → delete  true
mail → calendar  true      mail → admin   false
```

## Why it bites: `mail` is the default everywhere

- `packages/mailstore/sql/control-plane.sql:68` — token default `'["mail"]'`
- `packages/cli/src/tokens.ts:101` and `packages/cli/src/admin.ts:232` — `opts.scopes ? … : ["mail"]`
- `services/provision/src/index.ts:467` — same default
- `docs/README.md:45,151` tells users to mint exactly `--scopes mail` for third-party clients

So **the app password pasted into Apple Mail can write the credential vault.**

## Symptoms observed

1. **Vault bypass** — `services/agent/src/vault.ts:75` gates on `hasScope(scopes, "vault")`, which any
   `mail` token passes. That endpoint holds third-party plaintext secrets.
2. **Contacts/calendar write** — `services/jmap/src/methods/contacts.ts:766` (`mayWrite`),
   `calendars.ts:77,200`, `services/anglebrackets/src/dav.ts:179,640`.
3. **Privilege escalation on mint** — `scopesWithin` (`index.ts:56-58`) inherits the hole, so a
   `["mail"]` token can mint a `["vault"]` token.

## Docs already contradict the code

- `packages/auth-core/README.md:10-12` and `src/index.ts:10-12` describe a closed 6-verb
  vocabulary where `"mail" = all of them` — but scopes live outside that union in production.
- `docs/architecture/mcp-auth.md:219-222` names this exact behaviour "the trap" — but only warns
  about it for *future* MCP scopes, not for the vault, which is the higher-value target.
- `docs/architecture/mcp-auth.md:197` states "Write-only HTTP API needs `vault` scope" as though it
  were a guarantee. It is not.
- `docs/cli.md:123` describes `mail` as "all verbs", understating it.

## Cross-references

`.plans/s04-AgentOS/bureau.md` §5.1 depends on scope checks being meaningful.
