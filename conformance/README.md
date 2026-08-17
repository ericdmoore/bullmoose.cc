# conformance/ — vectors both languages read

Generated, committed JSON. **Do not hand-edit any `.json` in here**; run
`npm run gen:conformance` and review the diff.

## Why

`packages/cli` is being ported to Go (`.plans/s08-go-cli/`). Three things the CLI and
the TypeScript platform must agree about are enforced today only by code review, because
across languages there is no import for a compiler to check (`arch.md` §5):

| file              | pins                                                                        | a mismatch looks like                                                             |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `login-key.json`  | `deriveLoginKey` — `(email, password) → key`, plus the KDF parameters       | "wrong password" for a correct password                                           |
| `scopes.json`     | `hasScope` — every `(granted[], required) → bool` over the whole vocabulary | a token that looks minted and silently does nothing, or one that permits too much |
| `exit-codes.json` | `EXIT` and the whole `JMAP_EXIT` table                                      | every script that branches on `$?`                                                |

Each failure presents a long way from its cause, which is what makes a golden file worth
the bytes.

## How they are made

`vectors.ts` **calls the live TypeScript** — `@bullmoose/auth-core` for the first two,
`packages/cli/src/io.ts` for the third. Nothing here is transcribed: a hand-written vector
records what someone believed, which is the thing being checked.

That module is the one place that imports a workers-typed package and a Node-typed one
together, so no `tsc` program covers it and it runs only under vitest — see the comment in
`vitest.config.ts`.

```sh
npm run gen:conformance     # regenerate, then review the diff
npx vitest run conformance  # just check
```

`vectors.test.ts` regenerates in memory and compares **bytes**, so a change to the
TypeScript that these files no longer describe is a red build rather than a discovery
(the shape `infra/migrations.test.ts` and `infra/envExample.test.ts` already use). Keys are
sorted recursively so construction order cannot leak into the output and make the check
flap.

## Consumers

- **TypeScript:** `conformance/vectors.test.ts` (drift + sanity), and `tools/login-key.mjs`,
  which shares no code with `auth-core` and reproduces every login-key vector.
- **Go:** `cli-go/` will read these files directly — s08 T5 for the exit codes, T6 for
  `login` / `token create`. Nothing consumes them from Go yet; T1 exists so that when the
  port lands there is something to be checked against.

## Notes on the contents

- `login-key.json` records `iterations`, `saltLabel` and `keyBits` as well as the keys. A
  port that matches every key while stretching 10,000 times passes today and diverges the
  moment a vector is regenerated. Each vector also carries its `saltHex`, so a mismatch
  localises to the salt or to the stretch instead of to "login is broken".
- `scopes.json` is the **whole product** — 183 grant lists × 13 required scopes = 2,379
  cases — not a sample, matching `webmail/src/lib/console/scopes.test.ts`. Hence the file
  size; each case is one line.
- `exit-codes.json` records the fallbacks (`unlistedJmapType`, `absentJmapType`) as well as
  the table. "Anything unlisted falls to 1" is half the behaviour, and a port that
  defaulted to 2 would satisfy every listed row.
- The algorithm itself is **not** free to change — `arch.md` §5.1. The server never sees
  the password, and the derivation is a cross-client contract rather than a per-client
  choice.
