# FIX — 025 -P3- Docs understate what is built

All three are single-edit changes. Do them in one commit; they share no code and cannot
conflict with each other.

## 1. `packages/cli/src/admin.ts`

- `:19` — `○ token` → `✓ token       create | list | revoke`
- `:21` — `○ agent` → `✓ agent       bind | list`
- `:280` — drop `agent` from the `designed (not yet built)` list; leave `route, identity,
  policy, share, suppression`.

Verify against the switch statement before editing rather than trusting this list — the whole
point of the issue is that the summary drifted from the implementation once already.

**Do not** regenerate `docs/cli.md` for this; `admin.ts`'s header is a source comment, not
part of the help registry. (`docs/cli.md` *is* generated — from `packages/cli/src/help.ts`,
per its own line 5 — but that is a different surface. See item 3 of `cli/010`.)

## 2. `packages/auth-core/src/index.ts:10-12` + `packages/auth-core/README.md:10-12`

Replace the vocabulary comment with something that states the two axes separately, because
conflating them is the actual trap:

```
 * Scope vocabulary (shared with agent grants). Two independent axes:
 *
 *   mail verbs:  read < annotate < draft < move < send < delete
 *                "mail" currently satisfies all of them — see common/001
 *   realm:       "contacts", "calendar", "vault"
 *                NOT ordered, NOT covered by the mail lattice
 *   control:     "admin" — control-plane only
 *
 * Sources of truth: GRANTABLE_SCOPES (services/provision/src/index.ts:505),
 * the user-facing list (packages/cli/src/help.ts:105), and the live call
 * sites (contacts.ts:117,318 · calendars.ts:77,200 · vault.ts:75).
 *
 * NB `MethodDomain` (principal.ts:207) is a DIFFERENT axis — which collection
 * a grant covers — and is correctly three-valued. Do not merge the two.
```

Adjust the "mail satisfies all of them" line to match reality once `common/001` lands; until
then it is accurate and should say so.

While here, consider whether `Scope` (`index.ts:47`) should be deleted or actually used.
Today it is a union that types nothing — `hasScope` takes `string` — so it provides false
assurance. Deleting it is honest; wiring it into `hasScope`'s signature is better but is a
code change and belongs with `common/001`, not here.

## 3. `common/022`'s fix file

Delete or rewrite `022.fix.md:62-63`. The issue file's own §"⚠️ Sequencing correction"
(`022.md:68-77`) has the current position; make the fix file agree rather than restating it.

**Process note worth raising separately:** this is a `.md`/`.fix.md` pair that drifted apart
because the issue was amended and the proposal was not. If that has happened once it will
happen again — `.feedback/readme.md` does not currently say to re-read the `.fix.md` when
amending an issue. One line there would prevent the class.

## Bread-crumbs

- No tests apply to any of the three.
- `npm run typecheck` still needs to pass — item 2 touches a `.ts` file, even if only comments.
- If `cli/010` is picked up first, fold item 1 into it and leave a pointer here rather than
  editing `admin.ts` twice.
