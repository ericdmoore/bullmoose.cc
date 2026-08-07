# s05 — CLI CRUD parity: dev plan

> Scope: [`readme.md`](./readme.md) · structure: [`arch.md`](./arch.md).
> No server work — every method this slice calls is already live.

---

## T1 — The I/O contract *(first, and not negotiable)*

**Blocks:** `packages/cli/bin/bullmoose.mjs` · `src/main.ts` · every command module.

Applied **before** new commands exist, so they're written to it rather than retrofitted:

- **EPIPE guard** at the entry point (`arch.md` §1.2) — one line, fixes `| head`
  everywhere.
- **stdout = data, stderr = chrome** — audit all 101 `console.log` sites; anything that
  isn't a record moves to stderr.
- **NDJSON** for every collection under `--json`; one object for `show`-style commands.
- **Exit-code table** (`arch.md` §1.5) via a small typed error → code mapping.
- **TTY/`NO_COLOR`** detection on `stdout`; never invoke a pager.
- **`--ids`** bare-identifier output mode.

**Done when:** `bullmoose log | head -3` exits 0 silently; `contacts list --json | jq -r .name`
streams; `contacts list > /dev/null` shows chrome but no records; `2>/dev/null` the
inverse; a table-driven test asserts the exit code for each failure class.

---

## T2 — Contacts CRUD

**Blocks:** `src/contacts.ts` · reuses `vcard.ts` + `packages/contacts-core` **[live]**.

- `contacts books list|create|rename|rm`
- `contacts create|edit|rm`, accepting vCard/JSON on stdin (`-`), `--as` to force type
- `contacts export [--book]` — the inverse of `import`

**Done when:** a book round-trips `import` → `export` → `import` with no drift (the
cheapest correctness test available); create/edit/rm work from both flags and stdin;
`--dry-run` mutates nothing.

---

## T3 — Calendar CRUD

**Blocks:** `src/calendar.ts` · reuses `packages/calendar-core/src/ical.ts` **[live]**.

- `calendar create|rename|rm`
- `calendar event create|edit|rm`, iCal or JSON via stdin
- `calendar export [--ics]`
- **Recurrence handling** (`arch.md` §3): a write targets the **master** event. Editing a
  single occurrence either patches recurrence overrides explicitly or is refused with a
  clear message — never a silent series rewrite.

**Done when:** an event round-trips iCal → JMAP → iCal; editing one occurrence of a
recurring series leaves the other occurrences untouched (asserted in a test, not assumed);
`agenda` reflects writes immediately.

---

## T4 — Creds

**Blocks:** `src/creds.ts`.

- `creds show <name>` — **metadata only**, never a value
- `creds rotate <name>` — re-seal under a new secret, same name

**Done when:** `show` returns kind/meta/timestamps and provably no secret material; a
rotated credential still opens under the vault's verify endpoint; a test asserts no
command path can return a plaintext value.

---

## T5 — Help + docs regeneration

**Blocks:** `src/help.ts` (550 lines, the structured command registry) · `workoutmd`-style
man output.

Every new command gets a registry entry with synopsis, flags, and **examples that
demonstrate composition** (`| jq`, `| xargs`, stdin). `help --json` stays complete — it's
the machine-readable spec agents read.

**Done when:** `bullmoose help --json` includes every new command and flag; `--man`
renders; no command exists without a help entry (assertable in a test).

---

## Sequencing

```
T1 I/O contract ─┬─▶ T2 contacts ─┐
                 ├─▶ T3 calendar ─┼─▶ T5 help/docs
                 └─▶ T4 creds ────┘
```

**T1 first, strictly.** It changes how output is written, so building T2–T4 before it
means writing every command twice. T2–T4 are mutually independent and parallelizable.

## Verification

Unit tests with an injected fake JMAP client (per `.plans/devPrinciples.md` — no network),
**plus a composition smoke script** that actually pipes:

```sh
bullmoose contacts list --json | jq -r .id | head -2 | xargs -n1 bullmoose contacts show
bullmoose log | head -5            # must exit 0, no trace
bullmoose calendar agenda | less   # quit early, no error
```

That script is the real acceptance signal — the contract in `arch.md` §1 is about
behaviour under pipes, which unit tests alone can't observe.

## Risk

- **T1 touches every command's output.** Mitigated by doing it first, when there are
  fewer commands to touch, and by asserting the discipline in tests rather than by
  convention.
- **T3's recurrence semantics** are the only genuinely subtle logic here. If it gets hard,
  ship create/delete plus whole-series edit, and defer single-occurrence editing — a
  clear refusal is a perfectly good v1.

## Out of scope

Mail triage verbs (`move`/`label`/`flag`/`archive` — same class-(b) gap, deserves its own
slice) · Files CLI surface (arrives with **s03.B**) · the Global/PerInbox vault AAD
change (specified in `readme.md` §4, built elsewhere).
