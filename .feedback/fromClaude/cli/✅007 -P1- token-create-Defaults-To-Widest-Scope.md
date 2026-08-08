# 007 -P1- `token create` silently defaults to the widest possible scope

**Subsystem:** cli (`packages/cli/src/tokens.ts`, `admin.ts`) · **Severity:** HIGH · **Fix class:** CHANGE-CODE + UPDATE-DOC

Companion to `common/001` (the `hasScope` root cause). That issue is *why* `mail` is dangerous; this
one is *why every token gets it*.

## The defect

`packages/cli/src/tokens.ts:101`:

```ts
const scopes = opts.scopes ? opts.scopes.split(",").map(s => s.trim()) : ["mail"];
```

Same at `packages/cli/src/admin.ts:232` for `admin token create`.

`--scopes` is optional and undocumented as to its default, so the natural invocation mints the
broadest credential the system can express.

## The doc makes it worse

- `docs/cli.md:120,128` show `[--scopes read,draft,send]` as optional and **never state the default**.
- `docs/cli.md:123` describes the vocabulary as "… **mail (all verbs)**, contacts, calendar" — which
  reads as though `mail` ⊂ {mail verbs}. Per `common/001` it is not: `mail` satisfies everything
  except `admin`.
- The surrounding text urges "Scope them per device so a lost device can be revoked alone" — good
  advice immediately undercut by the default.
- `docs/cli.md:137`'s own example `--scopes mail,contacts,calendar` is **redundant** under current
  `hasScope` semantics, teaching a mental model the code doesn't implement.

## Concrete consequence

The doc's own POP3 example (`docs/cli.md:138`):

```sh
bullmoose token create --name popper
```

mints a credential with full read/write mail **plus contacts, calendar, and credential-vault write**
— pasted into a third-party client.
