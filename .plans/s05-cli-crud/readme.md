# s05 — CLI CRUD parity + Unix composition

> **What this is.** Close the gap between what the JMAP server already implements and
> what the CLI actually exposes — for **contacts**, **calendar**, and **creds** — and
> make the whole CLI compose properly with `|`, `head`, `less`, `xargs`, and stdin.
>
> **Status legend:** **[live]** — exists today, `file:line` cited. **[proposed]** — this plan.

---

## 1. Why this exists

Two different kinds of gap turned up when auditing the CLI's command surface, and only
one of them is real platform work:

| Class | Meaning | Example | Cost |
|---|---|---|---|
| **(a)** the server can't do it either | Files / FileNode | real design + build → **s03.B** |
| **(b)** the server *can*, the CLI doesn't expose it | `Calendar/set`, `CalendarEvent/set`, per-card contact CRUD | **cheap catch-up against a working server** |

**s05 is class (b).** The methods are implemented, tested, and reachable over JMAP
today — the CLI simply never calls them. That makes this the highest value-per-effort
work available: no new protocol, no new storage, no new security surface.

There's also a **posture** problem worth fixing in the same pass. The agent-first
audience drives the CLI (`readme` of s03 §2), and agents compose tools with pipes. A CLI
that can't be piped is a CLI agents use badly.

## 2. What's actually missing

| Realm | Read | Create | Update | Delete |
|---|---|---|---|---|
| **Contacts** | `list`, `show` **[live]** | `import` (bulk only) **[live]** | ❌ | ❌ |
| **Calendar** | `list`, `agenda` **[live]** | ❌ | ❌ | ❌ |
| **Creds** | `list` **[live]** | `set` / `oauth` **[live]** | ✓ (upsert) **[live]** | `rm` **[live]** |

- **Contacts** can be seeded in bulk but not edited one card at a time, and address books
  have no lifecycle commands.
- **Calendar is entirely read-only** — the CLI never issues a single `Calendar/set` or
  `CalendarEvent/set`, despite both being live server-side.
- **Creds** is nearly complete; what it lacks is *scoping* (see §4).

## 3. Unix composition — a first-class requirement, not polish

Current state, audited:

| Property | Today |
|---|---|
| stdin as input | **partially** — `send` body reads stdin, with a good stated rule: *"explicit flags beat implicit stdin"* (`main.ts:526-534`) **[live]** |
| `--json` | exists as a global flag **[live]**, but emits whole-array JSON, not line-per-record |
| **EPIPE handling** | ❌ **none** — `bullmoose log \| head` throws an unhandled error |
| stdout/stderr split | **inconsistent** — 101 `console.log` vs 62 `console.error`; progress correctly goes to stderr in `contacts.ts`, but the discipline isn't uniform |
| TTY / `NO_COLOR` detection | ❌ only `stdin.isTTY` is checked, never `stdout` |
| exit codes | generic 0/1 |

The EPIPE gap is the sharpest: piping any list command into `head` produces a Node
stack trace instead of clean output. That single fix makes half the composition story
work.

## 4. The creds scoping question — flagged, not assumed

The taxonomy floated **Global / PerActor / PerInbox** secrets. Worth knowing before
designing it: the vault is **per-principal by construction**. `vaultAad(principalId, name)`
binds the ciphertext to its principal, so a row copied to another principal *cannot be
opened* — that's the deliberate row-swap defense in `auth-core`.

So **PerActor exists today; Global and PerInbox do not**, and adding them is a
**crypto/schema change** (a new AAD scheme + migration), not a CLI flag. s05 exposes
what exists and **specifies** the scoping change; it does not implement a new AAD scheme
on the side.

## 5. Scope

**In:** contacts card + address-book CRUD · calendar + event CRUD · creds `show`/rotate ·
the Unix I/O contract applied across every command.

**Out:** mail triage verbs (`move`/`label`/`flag`/`archive` — same class-(b) gap, worth
its own slice) · Files (s03.B) · the Global/PerInbox AAD change (specified here, built
elsewhere) · webmail (s03.C).

## 6. Acceptance

1. Every CRUD operation the server exposes for contacts and calendar is reachable from
   the CLI.
2. `bullmoose <any-list> | head` exits cleanly — no EPIPE trace, anywhere.
3. `--json` on a collection emits **NDJSON**, one record per line, streamable into `jq`.
4. stdout carries **only** data; every prompt, progress bar, and warning goes to stderr.
5. Create/update commands accept stdin (vCard / iCal / JSON), preserving the existing
   "explicit flags beat implicit stdin" rule.
6. Exit codes distinguish usage / not-found / auth / conflict.
7. `npm test` green · `npm run typecheck` clean.

## 7. Why now

It's the cheapest real capability in the backlog: the server work is done, there's no new
security surface, and it directly serves the agent-first audience the whole arc depends
on. It also makes s03's webmail easier to validate — a complete CLI is a behavioural
reference to build the UI against.
