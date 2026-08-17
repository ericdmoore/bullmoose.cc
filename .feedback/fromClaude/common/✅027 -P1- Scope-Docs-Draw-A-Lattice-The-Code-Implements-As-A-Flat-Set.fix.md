# FIX — 027 -P1- Lattice notation vs flat-set implementation

## Do the cheap half first, unconditionally

**Stop writing `<` in the vocabulary before anyone decides the semantics.** Whatever the
outcome, the current notation is wrong today and is what taught two agents the wrong model.
Replace it everywhere with something that states what the code does:

```
mail verbs (independent — none implies another):
  read · annotate · draft · move · send · delete
mail = a bundle of exactly those six
realms (independent): contacts · calendar · vault
control plane: admin
```

Sites: `packages/auth-core/src/index.ts`, `packages/auth-core/README.md`,
`packages/cli/src/help.ts` (regenerate `docs/cli.md` after — it is GENERATED), and any `docs/`
hit for `read < annotate`.

That is safe, reversible, and removes the trap while the real decision is pending.

## Then pick one, and test it before shipping

**My recommendation: option 2 — every write verb implies `read`.**

Reasoning: it fixes symptoms 1 and 3 with one rule; "you may change what you cannot see" is not
a capability anyone wants to grant deliberately; and it keeps `delete` from implying `send`,
which a total order would not. Option 1 is narrower but needs `hasScope` to take a domain,
which changes a signature with ~15 call sites. Option 3 is honest but pushes the cost onto
every operator granting a scope, forever.

Sketch:

```ts
const WRITE_VERBS: ReadonlySet<string> = new Set(["annotate", "draft", "move", "send", "delete"]);
const REALMS: ReadonlySet<string> = new Set(REALM_SCOPES);

export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  if (granted.includes("mail") && MAIL_COVERS.has(required)) return true;
  // A capability to change implies the capability to see.
  if (required === "read") {
    return granted.some((g) => WRITE_VERBS.has(g) || REALMS.has(g) || g === "mail");
  }
  return false;
}
```

Note `admin` deliberately does NOT imply `read` — it is control-plane only and gates nothing
today (`grep hasScope(…, "admin")` → nothing; the provision worker uses a shared
`ADMIN_TOKEN`).

## Bread-crumbs — read these before touching `hasScope`

- **This function has produced two downstream defects in one day.** `common/001` closed a
  wildcard hole and immediately created symptoms 1–3. Budget for a third; write the tests
  first this time.
- **`packages/auth-core/src/index.test.ts` already has the table.** Extend the
  `it.each([...REALM_SCOPES])` blocks rather than adding a parallel suite. The existing
  `mail → send` case at `principal.test.ts` must stay green.
- **Pin the _negative_ cases too**, or the next fix reopens the wildcard: `delete` must not
  imply `send`; `contacts` must not imply `calendar`; `admin` must not imply anything.
- **`scopesWithin` rides on `hasScope`**, so widening it also widens what a token may mint.
  `/auth/tokens` gates on `scopesWithin(requested, thisToken.scopes)` — check that a
  `move`-only token gaining implied `read` cannot now mint a `read` token it could not before.
  It can, and that is probably fine, but it should be a decision.
- **`matchingGrants` also rides on it** (`principal.ts`), so grants widen identically.
- After changing it, re-run the sVOL `015` test that pins symptom 1 — it asserts the _current_
  broken behaviour deliberately, so it should flip, and its comment needs rewriting rather than
  the assertion being deleted.

## Do not

- Do not implement a total order. `delete` implying `send` is the wrong answer and the notation
  that suggested it is the thing being removed.
- Do not fix this by adding `read` to every grant in the provisioning path. That hides the
  gap from operators who read the grant table and moves the surprise, rather than removing it.
