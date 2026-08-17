# 025 -P3- Three places where the docs understate or contradict what is built

**Subsystem:** common · **Severity:** LOW (no runtime impact) · **Fix class:** UPDATE-DOCS

Bundled like `cli/010`: three unrelated one-liners, each cheap, none worth its own issue.
Common thread — **every one of them makes the system look less capable than it is**, which is
the direction of doc drift that costs the most, because it causes people to build things that
already exist.

---

## 1. `packages/cli/src/admin.ts` contradicts itself about `token` and `agent`

The header taxonomy (`:11-21`) marks both as designed-not-built:

```
 *   ○ token        app passwords / scoped agent tokens (needs auth service)
 *   ○ agent        register agents, grants, bindings (agent-integration.md §2)
```

Both are **implemented**, directly below in the same file:

|                            |                        |
| -------------------------- | ---------------------- |
| `token create/list/revoke` | `admin.ts:230-261`     |
| `agent bind/list`          | `admin.ts:147`, `:184` |

The file even disagrees with itself: the error message at `:279` lists
`token create/list/revoke` under **implemented**, while `:280` still lists `agent` under
_"designed (not yet built)"_.

So an operator reading the header concludes there is no way to mint a token from the CLI —
and there has been all along. Fix: move `token` and `agent` to `✓` at `:19`/`:21`, and drop
`agent` from the `:280` string.

---

## 2. `packages/auth-core/src/index.ts:10-12` omits two live scopes

```
 * Scope vocabulary (shared with agent grants):
 *   read < annotate < draft < move < send < delete ; "mail" = all of them
 *   "admin" is control-plane only.
```

`contacts` and `calendar` are missing, and both are real:

- passed as live scope arguments — `services/jmap/src/methods/contacts.ts:117,318`,
  `services/jmap/src/methods/calendars.ts:77,200`, `services/agent/src/vault.ts:75` (`vault`)
- documented **to users** at `packages/cli/src/help.ts:105`
- `contacts`/`calendar` are in `GRANTABLE_SCOPES` (`services/provision/src/index.ts:505-515`)

Same omission in `packages/auth-core/README.md:10-12`.

This is the load-bearing one of the three: it is the comment someone reads immediately before
adding a scope check, and it is wrong about which scopes exist. It is also adjacent to open
P1 `common/001` — anyone fixing `hasScope` will read this comment first.

Note `Scope` (`index.ts:47`) encodes the same closed set, but is never used as a parameter
type anywhere (`hasScope` takes `string`/`string[]`), so the union enforces nothing. Do **not**
conflate it with `MethodDomain` (`principal.ts:207`), which is a separate axis and correctly
three-valued.

---

## 3. `common/022`'s two files contradict each other on sequencing

`022 -P2- Spike-GraphQL-Resolver-Cost-On-D1-Workers.md:68-77` carries an explicit
⚠️ correction: the spike does **not** block `.plans/s03.C-webmail-floor`, because `mcp-auth.md`
§14.5 concluded the webmail case for GraphQL is weak.

The `.fix.md` was never updated. Its final bread-crumb (`022.fix.md:62-63`) still says to run
the spike **before** `s03.C` T1.

Anyone reading only the fix file would gate the largest slice in the whole `s03` arc on a
question that was already retired. Fix: delete or rewrite those two lines.

---

## Related

- `cli/010` — the existing CLI doc/help drift bundle. Item 1 here is the same class; consider
  merging if 010 is still open when this is picked up.
- `common/001` (P1, open) — item 2 is the comment that fix will be read against.
