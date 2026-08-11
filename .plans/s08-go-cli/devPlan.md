# s08 — the Go CLI: dev plan

> Ordered build for [`arch.md`](./arch.md): `packages/cli` (TypeScript, ~10.2k lines)
> becomes a single static Go binary, by strangler rather than rewrite.
>
> **Guiding constraint:** `smoke/contract.mjs` passes **61/61 at every commit**. It passes
> trivially on day one because everything delegates, and it must never be allowed to go
> red — a port measured by a suite that is sometimes broken is a port with no measurement.

---

## The number that decides the shape

```
imports of @bullmoose/* in packages/cli/src …… ZERO
npm dependencies ……………………………………………………… marked
```

The CLI already vendors scopes, calendar, contacts and MIME. **Go does not fork shared
code, because the fork already happened.** Read `arch.md` §2 before arguing the cost.

---

## Tasks (in dependency order)

### T1 — Conformance vectors, generated from TypeScript · *before any Go*

**Files:** `packages/cli/src/conformance.ts` (+ test), `conformance/*.json` (generated,
committed).

Three couplings stop being imports and become files both languages read (`arch.md` §5).
Generate them from the **live TypeScript**, never hand-write them — a hand-written vector
records what someone believed, which is the thing being checked.

- `conformance/login-key.json` — `(email, password) → key`. Include the cases that catch
  real mistakes: mixed-case email (the salt lower-cases), unicode password (encoding),
  empty password, a long password. `tools/login-key.mjs` already proves the shape of this
  test; it becomes the second consumer.
- `conformance/scopes.json` — every `(granted[], required) → bool` pair over the full
  vocabulary. Emit the whole product, not a sample: `webmail/src/lib/console/scopes.test.ts`
  already does this against the real `hasScope` ("every singleton, every pair, plus the
  bundle cases") and is the model to copy.
  ⚠️ Do **not** copy `packages/cli/src/scopes.test.ts`'s mechanism — it reads
  `auth-core/src/index.ts` as **text** and regex-parses it, because the CLI cannot even
  `import type` from a workers-typed package. Generating this vector *replaces* that hack
  and is worth doing on its own merits.
- `conformance/exit-codes.json` — the whole `JMAP_EXIT` map plus `EXIT`.

**Done when:** a TS test regenerates each file and fails if the committed copy differs, so
drift is a red build rather than a discovery.

### T2 — The front door that delegates everything · *the seam*

**Files:** `cli-go/` (new), `cli-go/main.go`, `cli-go/internal/delegate/`.

- Parse argv only far enough to identify the subcommand. Everything else is opaque and
  forwarded verbatim — the Go binary must not "helpfully" normalise flags it does not own.
- `exec` the Node CLI with **inherited file descriptors** (`cmd.Stdin = os.Stdin`, same for
  out/err). Not pipes Go copies: that flips Node's `isatty`, changes colour and framing,
  and breaks the early-close/SIGPIPE cases. See `arch.md` §4.
- Propagate the child's exit code exactly. Forward SIGINT/SIGTERM.
- `BULLMOOSE_TRACE=1` prints `native` or `delegated` per invocation on **stderr**, so it
  cannot corrupt piped stdout.
- Discovery: `BULLMOOSE_NODE_CLI`, else a sibling path, else an error naming both.

**Done when:** `contract.mjs` pointed at the Go binary passes **61/61**, and
`BULLMOOSE_TRACE=1` shows every case as `delegated`. That second half is the real
assertion — without it a green run only proves the shim did not crash.

### T3 — Run the contract suite against both, in CI · *the ratchet*

**Files:** `packages/cli/smoke/contract.mjs`, `.github/workflows/mail-typecheck.yml`.

- Take the binary path from an env var, defaulting to the Node CLI so existing usage is
  unchanged.
- CI runs it twice: once against Node, once against Go. Both must be 61/61.
- Report the native/delegated split as the progress metric.

**Done when:** a PR that breaks either implementation fails `verify`.

### T4 — Port the security lessons as tests, before the code that could lose them

**Files:** `cli-go/internal/**/*_test.go`.

`arch.md` §6: the closed CLI findings are fixed in TypeScript the Go port will never read,
so a fresh implementation reintroduces them by default. Write these **first**, watch them
fail against a not-yet-written implementation, and only then build it:

- `✅cli/006` — `watch --exec` shell injection. Note the lesson is *"a blocklist was the
  wrong shape"*, so a test that only checks the old blocklist's entries misses the point:
  assert the argv is never handed to a shell at all.
- `✅cli/007` — `token create` must require explicit `--scopes`, never default wide.
- `✅cli/008` — `--json` honoured on every command that advertises it.
- `✅cli/009` — one account-resolution rule, applied identically everywhere.

**Done when:** each has a failing Go test naming its `.feedback` id.

### T5 — Port the I/O contract · *the foundation everything else sits on*

**Files:** `cli-go/internal/io/`.

`arch.md` §3: this is what `contract.mjs` actually tests, and the reason the suite is worth
inheriting. TTY detection, colour policy, `--json`, framing under pipes, early-close and
SIGPIPE handling, and the `EXIT`/`JMAP_EXIT` mapping from T1's vector.

**Done when:** the contract cases that exercise I/O run `native` and still pass 61/61.

### T6 — Port commands, cheapest and most-used first

**Files:** `cli-go/internal/cmd/`.

Suggested order — read-only before writes, and the two credential-shaped commands last so
T1's vectors are proven by then:

1. `whoami`, `mailbox list`, `search` (local mirror)
2. `email` read/triage
3. `contacts`, `calendar` — these carry the vendored codecs, so budget for them
4. `watch` (concurrency, and T4's injection case)
5. `login`, `token create` — the loginKey vector's real test

Each command flips one delegation to native; `contract.mjs` stays 61/61 throughout.

**Done when:** `BULLMOOSE_TRACE` reports zero `delegated` for the shipped set.

### T7 — Release · *the point of the exercise*

**Files:** `.github/workflows/release-cli.yml`, `docs/`.

- Cross-compile darwin/linux × arm64/amd64 (+ windows/amd64 if wanted). One job.
- Attach to a GitHub release; checksums.
- `~/bin/bullmoose` stops being a Node wrapper.
- **Delete the Node CLI only when the delegation count has been zero for a release**, not
  when it "feels done" — the trace metric is the criterion.

**Done when:** a machine with no Node runs `bullmoose whoami` against the live server.

---

## Sequencing

```
T1 vectors ─→ T2 delegating front door ─→ T3 CI ratchet ─┐
                                                          ├─→ T5 I/O ─→ T6 commands ─→ T7 release
                                          T4 security tests ┘
```

T1 before any Go: the vectors are what make a Go implementation checkable rather than
plausible. T4 before T6 for the same reason in a different direction — a test written
after the code tends to describe the code.

## Decisions needed

1. **`cli-go/` in this repo, or its own?** *Recommendation: this repo.* The conformance
   vectors are generated by the TS side, and a split repo turns "regenerate and both suites
   check it" into a release dance.
2. **Pure-Go SQLite (`modernc.org/sqlite`) or cgo (`mattn/go-sqlite3`)?**
   *Recommendation: pure Go.* cgo forfeits the effortless cross-compile, which is most of
   the reason for doing this at all. Revisit only if a measurement says so.
3. **Markdown rendering** currently uses `marked`. *Recommendation: the narrowest Go
   renderer that passes the existing help/format tests — or drop rich rendering in the CLI
   and keep it a webmail concern.*
4. **Does the Go binary keep the same local SQLite file, or its own?**
   *Recommendation: same file, same schema.* A user mid-migration should not lose their
   local mirror, and it keeps the two implementations comparable on identical state.

## Out of scope

- **Any other component.** Workers, JMAP methods, mailstore, webmail and every shared
  package stay TypeScript (`arch.md` §7).
- **Changing `deriveLoginKey`.** Free to change, and shouldn't be — `arch.md` §5.1.
- **`.feedback` `038`.** `vacation --if-state` is a server bug; language-independent.
