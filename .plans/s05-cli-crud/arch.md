# s05 — CLI CRUD parity: architecture

> Structure behind [`readme.md`](./readme.md), and the reasoning for
> [`devPlan.md`](./devPlan.md)'s ordering. The substantive design here is **§1, the I/O
> contract** — the CRUD mapping (§2–4) is largely mechanical once it's settled.

---

## 1. The Unix I/O contract

Every command obeys this. It is written first because it changes the shape of every
command added afterwards — retrofitting it later means touching all of them twice.

### 1.1 stdout is data; stderr is everything else

The single most important rule. Progress, prompts, warnings, and human chrome go to
**stderr**; only the requested records go to **stdout**. `contacts.ts:181` already does
this for its progress bar **[live]** — s05 makes it uniform.

Test: `bullmoose contacts list > /dev/null` should print progress but no records;
`2>/dev/null` should print records but no chrome.

### 1.2 EPIPE is not an error

Node throws `EPIPE` when a downstream reader closes early — so `bullmoose log | head`
currently produces a stack trace. Install once, at the entry point:

```js
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });
```

This is the highest-leverage line in the whole plan: it makes `| head`, `| less` (quit
early), and `| grep -m1` work everywhere at once.

### 1.3 `--json` means NDJSON for collections

One record per line, no wrapping array:

```
bullmoose contacts list --json | jq -r '.name'      # streams
bullmoose contacts list --json | wc -l              # counts
bullmoose contacts list --json | head -3            # truncates cleanly
```

A whole-array JSON blob defeats every line-oriented tool and can't stream. Single-object
commands (`show`) emit exactly one JSON object. `watch --json` already emits NDJSON
**[live]** — this generalizes its precedent.

### 1.4 stdin as an input source, with `-` explicit

`send` already reads its body from stdin and states the rule — *"explicit flags beat
implicit stdin"* (`main.ts:526`) **[live]**. Generalize it:

```
bullmoose contacts create < card.vcf          # implicit
cat card.vcf | bullmoose contacts create -    # explicit `-`
bullmoose calendar event create --ics - < e.ics
```

Content type is inferred (vCard / iCal / JSON) and overridable with `--as`.

### 1.5 Exit codes scripts can branch on

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic failure |
| 2 | usage error |
| 3 | not found |
| 4 | auth / forbidden |
| 5 | conflict (state mismatch — see §1.7) |

### 1.6 No TTY assumptions

Never invoke a pager — the user pipes to `less` themselves. Suppress decoration and
color when `process.stdout.isTTY` is false, and honour `NO_COLOR`. Keep text columns
stable so `awk`/`cut` work.

### 1.7 Concurrency-safe scripted writes

JMAP has optimistic concurrency built in. Expose it: `--if-state <state>` maps to
`ifInState`, so a scripted read-modify-write can't silently clobber a concurrent change,
and returns exit code **5** when it would. `--dry-run` on destructive commands.

### 1.8 Composition affordances

```
bullmoose contacts list --ids | xargs -n1 bullmoose contacts show   # bare-id output
```
`--ids` prints one identifier per line and nothing else — the `xargs` shape.

---

## 2. Contacts CRUD

Server-side **[live]**: `AddressBook/{get,set,changes}` ·
`ContactCard/{get,set,query,queryChanges,changes}`. Conversion logic already exists in
`packages/contacts-core` and the CLI's `vcard.ts` (vCard ⇄ JSContact) **[live]**.

| Command | Maps to | Status |
|---|---|---|
| `contacts books list` | `AddressBook/get` | new |
| `contacts books create/rename/rm <name>` | `AddressBook/set` | new |
| `contacts create [-]` | `ContactCard/set` create | new |
| `contacts edit <id> [-]` | `ContactCard/set` update | new |
| `contacts rm <id>` | `ContactCard/set` destroy | new |
| `contacts export [--book]` | `ContactCard/get` → vCard | new |
| `contacts list/show/import` | — | **[live]** |

`export` is deliberately the inverse of `import` — round-tripping a book through vCard
and back is the cheapest correctness test available, and it makes the CLI a backup tool
for free.

## 3. Calendar CRUD

Server-side **[live]**: `Calendar/{get,set,changes}` ·
`CalendarEvent/{get,set,query,queryChanges,changes}`. iCal conversion exists in
`packages/calendar-core/src/ical.ts` **[live]** — the CLI imports it rather than
reimplementing.

| Command | Maps to | Status |
|---|---|---|
| `calendar create/rename/rm` | `Calendar/set` | new |
| `calendar event create [--ics -]` | `CalendarEvent/set` create | new |
| `calendar event edit <id>` | `CalendarEvent/set` update | new |
| `calendar event rm <id>` | `CalendarEvent/set` destroy | new |
| `calendar export [--ics]` | `CalendarEvent/get` → iCal | new |
| `calendar list/agenda` | — | **[live]** |

**Recurrence caution.** `agenda` shows *expanded occurrences*, but a write targets the
**master event**, not an occurrence. Editing "next Tuesday's standup" must either patch
the master's recurrence overrides or be refused with a clear message — silently
rewriting the series is the failure mode to avoid. This is the one genuinely subtle
piece of the slice.

## 4. Creds

Existing **[live]**: `init`, `set`, `list`, `rm`, `oauth`. Additions:

| Command | Notes |
|---|---|
| `creds show <name>` | **metadata only** — the vault is write-only; a value is never returned |
| `creds rotate <name>` | re-seal under a new secret; same name, no re-attachment needed |

**Scoping (Global / PerActor / PerInbox) is specified, not built here.** `vaultAad(principalId, name)`
binds each row to its principal by construction (the row-swap defense). Global/PerInbox
require a new AAD scheme plus migration — real crypto work, not a flag. s05 documents
the requirement and leaves the change to its own slice.

---

## 5. Invariants

1. No command writes non-data to stdout.
2. No command dies on `EPIPE`.
3. `--json` on a collection is parseable line-by-line.
4. A `--dry-run` write performs zero mutations.
5. A vault value is never returned by any command, including `show`.
6. An `--if-state` mismatch fails with exit 5 and changes nothing.
7. Editing a recurring event never silently rewrites the series.
