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

### Recurrence: the read model is already decided — s05 owns only the write side

**Settled, and built** (`docs/devPlan-handoff.md:67`): *"store master + recurrence rule;
**expand on demand** within a bounded window (cap the pre-compute)"* → **on-demand,
capped**. Concretely **[live]**:

- recurring events are **one row, never expanded to storage** (`capacity-and-scaling.md:23`)
- `expandOccurrences(event, {after, before, maxOccurrences})`, hard cap
  `MAX_OCCURRENCES = 1000` (`calendar-core/index.ts:51`); `CalendarEvent/getOccurrences`
  defaults to 200
- generation runs to the **window horizon or the cap, never the rule's natural end**
  (`index.ts:213-215`), so an unbounded `RRULE` terminates
- `RRULE` ⇄ JSCalendar round-trips both ways (`ruleToRrule` / `rruleToRule`), EXDATE and
  overrides as sibling VEVENTs with `RECURRENCE-ID`; `rruleToRule` returns `null` on an
  unsupported part rather than guessing

**So reading is solved.** What s05 must decide is only the **write** side, because
`agenda` shows expanded *occurrences* while a write targets the **master**. The data
model already supports per-occurrence patches (`recurrenceOverrides`, read at
`ical.ts:261` **[live]**), so this is a CLI-UX decision, not a platform one:

| Command | Effect |
|---|---|
| `calendar event edit <id>` | edits the **master** — whole series |
| `calendar event edit <id> --occurrence <recurrenceId>` | writes a `recurrenceOverrides` entry |
| bare edit against an *occurrence* id | **refuse**, with a message naming the two explicit forms |

"Refuse rather than guess" matches how `rruleToRule` already handles unsupported parts.
Silently rewriting a series is the failure mode to avoid.

## 4. Creds

Existing **[live]**: `init`, `set`, `list`, `rm`, `oauth`.

**The CLI is the ingestion path for secrets** — the only safe one, since plaintext must
never transit a web tier (`mcp-auth.md` §9). So s05 owns the mint-time surface defined in
[`../s04-AgentOS/bureau.md`](../s04-AgentOS/bureau.md) §5.

| Command / flag | Notes |
|---|---|
| `creds set --kind` | `api-key` \| `oauth-refresh` \| `aws-sigv4` \| `hmac-key` — **gates which Bureau verbs may use it**; the field people forget, and it is load-bearing |
| `creds set --allow` | destination allowlist. **Fail closed** — no allowlist, no injection |
| `creds set --header` | injection recipe (`"Authorization: Bearer {}"`). Header-only, never a query param |
| `creds set --scope` | `actor` today; `inbox`/`global` accepted-and-refused until the AAD change lands |
| `creds show <name>` | **metadata only** — the vault is write-only; a value is never returned |
| `creds rotate <name>` | re-seal under a new secret; same name, so nothing downstream re-attaches |

**Derive rather than type where possible:** `--header` usually follows from `--kind`, and
for OAuth credentials `--allow` can default to the issuer origin already in `meta`
(`token_url`) **[live]**.

**Not built here: the scoping itself.** `vaultAad(principalId, name)` binds each row to
its principal by construction (the row-swap defense) — which means **today the AAD does
double duty as access control**. Global/PerInbox let multiple principals open the same
row, so the crypto stops being the access control and an explicit authZ check plus a
re-seal migration are required. That is `bureau.md` §9's work; s05 only ships the flag so
the CLI surface doesn't change twice.

**Minting is not authorizing** (`bureau.md` §5.1): who may *use* a credential is a
separate grant over `(principal, credRef, verb)`, not a `creds set` field.

---

## 5. Invariants

1. No command writes non-data to stdout.
2. No command dies on `EPIPE`.
3. `--json` on a collection is parseable line-by-line.
4. A `--dry-run` write performs zero mutations.
5. A vault value is never returned by any command, including `show`.
6. An `--if-state` mismatch fails with exit 5 and changes nothing.
7. Editing a recurring event never silently rewrites the series.
