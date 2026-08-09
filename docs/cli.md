# bullmoose CLI

> the CLI for the bullmoose personal-data platform — mail, contacts, calendar, email-native agents, and operator admin, over JMAP

_Generated from the CLI's command spec (`packages/cli/src/help.ts`). Regenerate with `npm run -w @bullmoose/cli gen:docs`; do not edit by hand._

- Auth model: login stretches your password locally and stores a bearer token; device/app tokens (bm_…) are minted with `token create` and used by clients (JMAP, CalDAV/CardDAV, POP3/SMTP). The login password is never stored or sent raw.
- The database is the server's own data-plane schema — open it directly with `sqlite3` for anything the commands don't cover.
- Operator commands (`admin …`) wrap the provision worker and use separate credentials from a mail account.
- I/O contract — every command obeys it. **stdout carries records; stderr carries everything else**: progress, prompts, warnings, counts and summaries, tree decoration, "(none)" notices and hints. So `bullmoose log > /dev/null` shows the chrome and no records, and `2>/dev/null` shows the records and no chrome. A downstream reader closing the pipe (`| head`, quitting `less`) is not an error: the CLI exits 0 silently instead of printing a stack trace. Output is never paged, never coloured when stdout is not a terminal, and never coloured at all when $NO_COLOR is set. Where a command takes a file, `-` means stdin explicitly and a bare invocation reads stdin when it is not a terminal — but an explicit flag always beats implicit stdin.
- Exit codes are the branch points for scripts: 0 success · 1 generic failure · 2 usage error · 3 not found · 4 auth/forbidden · 5 conflict (an --if-state mismatch, or a precondition such as removing a mailbox that still holds mail). JMAP error types map onto them by rule: `stateMismatch`/`alreadyExists`/`mailboxHasEmail` → 5, `notFound`/`blobNotFound`/`accountNotFound` → 3, `forbidden`/`accountReadOnly` → 4, `invalidProperties`/`invalidArguments`/`tooLarge` → 2, and `serverFail`/`overQuota`/`rateLimit` → 1.

## Commands

| command | what it does |
|---|---|
| [`help`](#help) | show help — for everything, one command, or as a machine-readable spec |
| [`login`](#login) | log in and store a bearer token for this account |
| [`discover`](#discover) | show what autodiscovery finds and probe the server |
| [`init`](#init) | configure an account from an existing token (no password login) |
| [`token`](#token) | mint / list / revoke device app-passwords for this account |
| [`accounts`](#accounts) | list this login's accounts (★ = default; local counts shown) |
| [`sync`](#sync) | pull mail into the local SQLite log (all accounts by default) |
| [`send`](#send) | compose and send mail (Markdown → MIME, inline images, big-file links) |
| [`read`](#read) | print a message (newest if no id) |
| [`watch`](#watch) | push-triggered live sync: print new mail as it arrives |
| [`vacation`](#vacation) | manage the RFC 8621 vacation responder |
| [`agent`](#agent) | run the homelab agent runtime (claims the AgentInvocation queue) |
| [`contacts`](#contacts) | import and browse the contacts core (vCard ⇄ JSContact) |
| [`calendar`](#calendar) | browse the calendar core (JSCalendar; recurrence expanded server-side) |
| [`creds`](#creds) | manage the write-only, envelope-encrypted credential vault |
| [`log`](#log) | list messages from the local log |
| [`search`](#search) | full-text search the local log (SQLite FTS5) |
| [`show`](#show) | show a message's metadata + structure |
| [`mailboxes`](#mailboxes) | list mailboxes for the selected account |
| [`mailbox`](#mailbox) | create, rename, move and remove folders (over JMAP) |
| [`blobs`](#blobs) | see and remove the objects this account stores in R2 |
| [`share`](#share) | list and revoke the expiring public links this account has minted |
| [`identity`](#identity) | send-as addresses and mail signatures (over JMAP) |
| [`admin`](#admin) | operator surface — wraps the provision worker (separate credentials) |

## Global options

| flag | description |
|---|---|
| `--db <path>` | SQLite database path (default: $BULLMOOSE_DB or ~/.bullmoose/mail.db) |
| `--account <sel>` | account selector: accountId, address, @domain-suffix, name substring, or 'default'. For commands that act on ONE account a selector matching several is an error, not a choice — name one. Commands that legitimately fan out (log, search, sync, watch, mailboxes) still do. |
| `--json` | machine-readable output: NDJSON — one complete JSON value per line — for collections, exactly one object for show-style commands. Never a wrapping array, so `\| head`, `\| wc -l` and `\| jq` all stream. (`help --json` dumps this whole spec.) |
| `--ids` | print bare identifiers, one per line, and nothing else — the `\| xargs -n1` shape |
| `--dry-run` | on destructive commands (mailbox rm, blobs rm, share revoke, token revoke, creds rm, contacts import, vacation on\|off, admin *revoke): resolve everything, report what would happen, write nothing |
| `--if-state <state>` | optimistic concurrency for writes: passed to JMAP as ifInState. If the server has moved on, the write is refused with exit 5 and nothing changes. The state to pass is printed by the previous write (and is in its --json output as `state`). |
| `--as <type>` | force the input content type — vcard \| ical \| json \| text (default: inferred from the bytes) |
| `-h, --help` | show help; `bullmoose <cmd> --help` shows help for one command |
| `--man / --markdown` | render the whole spec as a man page / Markdown (used to generate the docs) |

## Exit codes

| code | meaning | when |
|---|---|---|
| 0 | success | the command did what it said |
| 1 | generic failure | server error, quota, rate limit — nothing you can restate |
| 2 | usage error | unknown flag or command, missing argument, ambiguous --account |
| 3 | not found | no such message, mailbox, contact, account or blob |
| 4 | auth / forbidden | the token is rejected or lacks the scope |
| 5 | conflict | --if-state mismatch, or a precondition like a non-empty mailbox |

## help

show help — for everything, one command, or as a machine-readable spec

```
bullmoose help [<command>] | --json | --man | --markdown
```

With no argument, the command overview. With a command name, that command's synopsis, flags and examples (`bullmoose <cmd> --help` is the same thing). `--json` dumps this entire spec — commands, subcommands, flags, examples, global options, the exit-code table and the I/O contract notes — and is what an agent should read rather than scraping the text. `--man` and `--markdown` render the same spec as a man page and as Markdown; `docs/cli.md` and `man/bullmoose.1` are generated from them by `npm run -w @bullmoose/cli gen:docs` and must never be hand-edited.

| flag | description |
|---|---|
| `--json` | the whole command spec, machine-readable |
| `--man` | roff man page (→ man/bullmoose.1) |
| `--markdown` | Markdown reference (→ docs/cli.md) |

**Examples**

```sh
bullmoose help mailbox
bullmoose help --json | jq -r '.commands[].name'
# what can this CLI do?
```

## login

log in and store a bearer token for this account

```
bullmoose login <email> [--base <url>] [--name <device-name>] [--password <pw>] [--scopes <a,b,c>]
```

Authenticates to a JMAP server. With no --base, the server is autodiscovered from the email domain via the _jmap._tcp SRV record / .well-known/jmap fallback (RFC 8620 §2.2). The password comes from the prompt, $BULLMOOSE_PASSWORD, or --password; it is stretched locally, used once, and never stored or sent raw. --scopes sets what the minted token may do and is OPTIONAL here — this is the one command that must work before you hold any token, so omitting it takes the server default of `mail` (the six mail verbs; no contacts, calendar or vault). `login` is also the only self-service way to WIDEN scope, because `token create` can only narrow the token it is called with.

| flag | description |
|---|---|
| `--base <url>` | JMAP server base; skip to autodiscover from the email domain |
| `--name <device-name>` | label the minted token (shows in `token list`) |
| `--password <pw>` | password (else prompt or $BULLMOOSE_PASSWORD) |
| `--scopes <a,b,c>` | scopes for the minted token; omit for the server default (mail). Vocabulary: read, annotate, draft, move, send, delete, mail, contacts, calendar, vault |

**Examples**

```sh
bullmoose login you@example.com
# autodiscover the server, prompt for password
bullmoose login you@example.com --base https://jmap.example.com --name laptop
bullmoose login you@example.com --scopes mail,contacts,calendar,vault
# widen past the default (login is the only way)
```

See also: [`discover`](#discover), [`init`](#init), [`token`](#token)

## discover

show what autodiscovery finds and probe the server

```
bullmoose discover <email-or-domain>
```

Resolves the JMAP base for an email or domain (SRV _jmap._tcp, then .well-known/jmap), prints the method and base, and probes the session endpoint. Read-only; no auth.

**Examples**

```sh
bullmoose discover example.com
```

See also: [`login`](#login)

## init

configure an account from an existing token (no password login)

```
bullmoose init --base <url> --token <token> [--account <id>] [--offline]
```

Pastes an existing token instead of logging in. --base also accepts file:///path/to/bundle.json — a {base, token, accountId} bootstrap written by an operator. --offline stores it without validating against the server.

| flag | description |
|---|---|
| `--base <url>` | JMAP base, or file:// path to a bootstrap bundle |
| `--token <token>` | a bm_… bearer token |
| `--account <id>` | account id, if the token covers several |
| `--offline` | store without validating |

**Examples**

```sh
bullmoose init --base https://jmap.example.com --token bm_… --account t_home__a_you
bullmoose init --base file:///tmp/bootstrap.json
# operator-written bundle
```

See also: [`login`](#login), [`token`](#token)

## token

mint / list / revoke device app-passwords for this account

```
bullmoose token create --name <n> --scopes <a,b,c> | list | revoke <id>
```

Device tokens (bm_…) are what clients authenticate with — never the login password. Scope them per device so a lost device can be revoked alone. --scopes is REQUIRED: there is no default, because the shortest command should not mint the widest credential. Vocabulary: the mail verbs read, annotate, draft, move, send, delete; the bundle `mail`, which means exactly those six and nothing else; and the independent realms contacts, calendar, vault. A token can only ever be narrower than the one that minted it, so to widen, run `login` again with --scopes.

**Subcommands**

- **create** — mint a token (shown once)  
  `token create --name <n> --scopes <a,b,c>`
- **list** — list this account's tokens  
  `token list`
- **revoke** — revoke one token by id  
  `token revoke <id>`

**Examples**

```sh
bullmoose token create --name backup --scopes read
# read-only sync/archive
T=$(bullmoose token create --name ci --scopes read)
# the token is the only thing on stdout; the chrome goes to stderr
bullmoose token create --name popper --scopes read,move
# POP3 via popcorn
bullmoose token create --name laptop --scopes read,draft,send
# a mail client
bullmoose token create --name macbook-contacts --scopes contacts
# CardDAV only
```

See also: [`login`](#login), [`admin token`](#admin)

## accounts

list this login's accounts (★ = default; local counts shown)

```
bullmoose accounts
```

See also: [`login`](#login), [`sync`](#sync)

## sync

pull mail into the local SQLite log (all accounts by default)

```
bullmoose sync [--blobs <dir>] [--account <sel>]
```

Default syncs ALL accounts: clean ones are detected in one batched round-trip and skipped; only dirty inboxes fully sync. --blobs downloads message blobs into a directory.

| flag | description |
|---|---|
| `--blobs <dir>` | also download blobs into <dir> |
| `--account <sel>` | limit to one account |

**Examples**

```sh
bullmoose sync
bullmoose sync --account @example.com --blobs ./blobs
```

See also: [`watch`](#watch), [`log`](#log), [`search`](#search)

## send

compose and send mail (Markdown → MIME, inline images, big-file links)

```
bullmoose send --to <addr>[,<addr>] --subject <s> [--cc ..] [--bcc ..] [--file <path> | --body <text>]
```

Body comes from --file, else --body, else piped stdin. With --expandMD html the body is treated as Markdown: rendered HTML becomes the displayed body (raw Markdown rides along as the plain-text fallback), local images inline as cid: parts, linked files attach, and anything over --linkMax is uploaded to R2 and rewritten to a signed link expiring after --linkTTL days.

| flag | description |
|---|---|
| `--to / --cc / --bcc <addr>` | recipients (repeatable or comma-separated) |
| `--subject <s>` | subject line |
| `--file <path> / --body <text>` | body source (else stdin) |
| `--from <address>` | select the sending account + identity |
| `--identity <id-or-email>` | pick a specific identity |
| `--expandMD html\|no` | render Markdown to HTML (default: no) |
| `--linkMax <MiB>` | big-file threshold (default 4) |
| `--linkTTL <days>` | share-link lifetime (default 30) |

**Examples**

```sh
echo "it lives" | bullmoose send --to a@b.com --subject "first light"
bullmoose send --to a@b.com --subject Notes --file notes.md --expandMD html
# Markdown → HTML with inline assets
```

See also: [`read`](#read), [`watch`](#watch)

## read

print a message (newest if no id)

```
bullmoose read [emailId] [--raw] [--json]
```

| flag | description |
|---|---|
| `--raw` | print the raw RFC 5322 source |
| `--json` | structured output |

**Examples**

```sh
bullmoose read
bullmoose read <emailId> --raw
```

See also: [`show`](#show), [`log`](#log), [`search`](#search)

## watch

push-triggered live sync: print new mail as it arrives

```
bullmoose watch [--json] [--exec <cmd>] [--daemon | --status | --stop]
```

Holds a JMAP push channel and prints each new message. --json emits NDJSON events; --daemon detaches (prints a PID; logs beside the db file). --exec runs a shell command once per new message: the command is handed to `sh -c` verbatim and the message arrives in the environment as $BM_ID, $BM_ACCOUNT, $BM_FROM, $BM_SUBJECT and $BM_PREVIEW (preview truncated to 120 chars). Quote them — an inbound subject is attacker-controlled text, and unquoted it still word-splits inside your own command. BREAKING (was: substitution): the {id} {from} {subject} {preview} placeholders are no longer substituted — they were a shell-injection vector, since a stranger's subject line ended up parsed by your shell. A template still containing them gets a warning on stderr. The hook is fire-and-forget, gets no stdin, and under --json its stdout is redirected to stderr so it cannot corrupt the NDJSON stream.

| flag | description |
|---|---|
| `--json` | emit NDJSON events |
| `--exec <cmd>` | run `sh -c <cmd>` per new message; fields arrive as $BM_ID $BM_ACCOUNT $BM_FROM $BM_SUBJECT $BM_PREVIEW |
| `--daemon / --status / --stop` | manage a detached watcher |

**Examples**

```sh
bullmoose watch
bullmoose watch --json --exec 'notify-send "$BM_FROM: $BM_SUBJECT"'
# always quote $BM_* — the values come from whoever emailed you
```

See also: [`sync`](#sync), [`agent`](#agent)

## vacation

manage the RFC 8621 vacation responder

```
bullmoose vacation on|off|status [--subject <s>] [--body <text>] [--until <date>]
```

An armed auto-responder (wait=0) with RFC 3834 suppression — once per sender per 7 days. `status` shows the current state.

| flag | description |
|---|---|
| `--subject <s> / --body <text>` | the auto-reply content |
| `--until <date>` | auto-disable date |

**Examples**

```sh
bullmoose vacation on --subject "Away" --body "Back Monday." --until 2026-07-15
```

## agent

run the homelab agent runtime (claims the AgentInvocation queue)

```
bullmoose agent serve --config <agent.json> [--once]
```

Logs in as the bound account, watches the AgentInvocation queue over the same push channel as `watch`, claims pending work, and drafts replies in template mode. Providers: mock | anthropic | openai-compatible; API keys by env reference, never in the config. --once drains and exits (cron-friendly). The config's `binding` must match the server-side binding name (see `admin agent bind`).

| flag | description |
|---|---|
| `--config <agent.json>` | agent definition (binding, persona, model{provider,baseURL,apiKeyEnv}) |
| `--once` | drain the queue once and exit |

**Examples**

```sh
bullmoose agent serve --config hermes.json
bullmoose agent serve --config hermes.json --once
# cron drain
```

See also: [`admin agent bind`](#admin), [`watch`](#watch)

## contacts

import and browse the contacts core (vCard ⇄ JSContact)

```
bullmoose contacts import <file.vcf> | list | show <cardId>
```

**Subcommands**

- **import** — seed from a vCard export (idempotent; dedup by uid; missing --book created); reads stdin with no path, or with `-`  
  `contacts import [<file.vcf>|-] [--book <name-or-id>] [--as vcard] [--dry-run]`
- **list** — list cards  
  `contacts list [--book <name-or-id>] [-n <count>] [--json]`
- **show** — show one card  
  `contacts show <cardId> [--json]`

**Examples**

```sh
bullmoose contacts import Contacts.vcf --book Personal
# export from macOS Contacts: File → Export → Export vCard…
bullmoose contacts list --book Family -n 50
cat Contacts.vcf | bullmoose contacts import - --book Personal
# `-` is explicit stdin
bullmoose contacts list --ids | xargs -n1 bullmoose contacts show
```

See also: [`calendar`](#calendar), [`admin grant`](#admin)

## calendar

browse the calendar core (JSCalendar; recurrence expanded server-side)

```
bullmoose calendar list | agenda [--days <n>]
```

**Subcommands**

- **list** — list calendars  
  `calendar list [--json]`
- **agenda** — upcoming occurrences, recurrence-expanded  
  `calendar agenda [--days <n>] [--json]`

**Examples**

```sh
bullmoose calendar agenda --days 14
```

See also: [`contacts`](#contacts)

## creds

manage the write-only, envelope-encrypted credential vault

```
bullmoose creds init | set <name> | list | rm <name> | oauth <name> …
```

The vault stores third-party API keys and OAuth refresh tokens for agents. It is WRITE-ONLY — secrets go in and are never returned. `oauth` runs a browser + localhost PKCE flow and uploads only the refresh token.

**Subcommands**

- **init** — point the vault at the agent worker  
  `creds init --url <agent-worker-url>`
- **set** — store a secret (else hidden prompt)  
  `creds set <name> --kind api-key|oauth-refresh [--secret <s> | --secret-env VAR] [--meta k=v,…]`
- **list** — list credential names (not values)  
  `creds list`
- **rm** — remove a credential  
  `creds rm <name>`
- **oauth** — PKCE flow; uploads only the refresh token  
  `creds oauth <name> --authorize-url <u> --token-url <u> --client-id <id> [--client-secret <s>] [--oauth-scopes "a b"] [--meta k=v,…] [--port <n>]`

| flag | description |
|---|---|
| `--kind api-key\|oauth-refresh` | what the credential is; gates which verbs may ever use it |
| `--secret <s> / --secret-env VAR` | the value, or the env var holding it (else a hidden prompt — never argv) |
| `--meta k=v,…` | free-form metadata stored beside the credential (also accepted on `oauth`) |
| `--port <n>` | localhost port for the `oauth` PKCE callback (default 8976) |
| `--dry-run` | on `rm`: report what would be deleted, delete nothing |

**Examples**

```sh
bullmoose creds set openai --kind api-key --secret-env OPENAI_API_KEY
bullmoose creds oauth gcal --authorize-url … --token-url … --client-id … --port 9000
```

See also: [`agent`](#agent)

## log

list messages from the local log

```
bullmoose log [-n <count>] [--mailbox <role-or-id>] [--account <sel>] [--json]
```

| flag | description |
|---|---|
| `-n <count>` | how many (default 20) |
| `--mailbox <role-or-id>` | filter by mailbox (e.g. inbox, sent) |

**Examples**

```sh
bullmoose log -n 50 --mailbox inbox
bullmoose log | head -3
# exits 0 silently — a closed pipe is not an error
bullmoose log --json | jq -r .subject
# NDJSON: streams, one record per line
bullmoose log --ids | xargs -n1 bullmoose show
# bare ids, the xargs shape
```

See also: [`search`](#search), [`read`](#read), [`sync`](#sync)

## search

full-text search the local log (SQLite FTS5)

```
bullmoose search <fts5-query> [--account <sel>] [--json]
```

**Examples**

```sh
bullmoose search "invoice NEAR quote"
```

See also: [`log`](#log), [`read`](#read)

## show

show a message's metadata + structure

```
bullmoose show <emailId> [--json]
```

See also: [`read`](#read)

## mailboxes

list mailboxes for the selected account

```
bullmoose mailboxes [--json]
```

Reads the LOCAL mirror, so it shows what the last `sync` (or `mailbox` write) fetched. Use `mailbox` to create, rename, move or remove folders.

See also: [`mailbox`](#mailbox), [`log`](#log), [`sync`](#sync)

## mailbox

create, rename, move and remove folders (over JMAP)

```
bullmoose mailbox create <name> | rename <box> <new> | move <box> --parent <box|-> | rm <box> [--force]
```

Folder management via Mailbox/set. A <box> is an id, a role (inbox, sent, drafts, trash, junk, archive), or a name — names are matched case-insensitively and an ambiguous one is refused. Folders nest: --parent puts a new or existing folder under another, up to the server's advertised maxMailboxDepth (10), and --parent - moves one back to the top level. Names must be unique among siblings. Role folders may be renamed but never removed, and `rm` refuses a folder that still holds mail or has children — `--force` removes the mail with it, destroying any message that is in no other folder. Every verb refreshes the local mirror on success, so `bullmoose mailboxes` is current immediately without a full `sync`.

**Subcommands**

- **create** — make a folder  
  `mailbox create <name> [--parent <box>] [--sort <n>]`
- **rename** — rename a folder (roles may be renamed)  
  `mailbox rename <box> <new-name>`
- **move** — reparent a folder ('-' = top level)  
  `mailbox move <box> --parent <box|->`
- **rm** — remove a folder; --force takes its mail too  
  `mailbox rm <box> [--force]`

| flag | description |
|---|---|
| `--parent <box>` | parent folder for create/move; '-' means top level |
| `--sort <n>` | sortOrder for create (unsigned integer, default 0) |
| `--force` | on rm: onDestroyRemoveEmails — remove the mail inside it too |
| `--if-state <state>` | refuse the write (exit 5) if the account has moved on since <state> |
| `--dry-run` | resolve the folder and report; write nothing |

**Examples**

```sh
bullmoose mailbox create Receipts
bullmoose mailbox create 2026 --parent Receipts
# nest under an existing folder
bullmoose mailbox rename Receipts Invoices
bullmoose mailbox move Invoices --parent -
# back to the top level
bullmoose mailbox rm Invoices --force
bullmoose mailbox rm Invoices --dry-run
# resolves the name, writes nothing
S=$(bullmoose mailbox create A --json | jq -r .state); bullmoose mailbox rename A B --if-state "$S"
# read-modify-write that cannot clobber a concurrent change: exit 5 if it would
```

See also: [`mailboxes`](#mailboxes), [`sync`](#sync), [`log`](#log)

## blobs

see and remove the objects this account stores in R2

```
bullmoose blobs list | rm <blobId> [--account <sel>] [--json]
```

Attachments and raw messages live in R2 under a per-account prefix. `list` is the only way to find out what is actually stored and how big it is — until it existed, nothing could answer that question while the storage was still billed. `rm` deletes ONE object and refuses (409) if it is still referenced: content-addressed blobs are shared, so the same bytes attached to two messages are one object, and deleting it because one message is gone would break the other. It also refuses while a live share link points at the blob — revoke the link first, so the recipient gets a clear refusal rather than a link that silently starts failing. This is explicit delete only; there is no garbage-collection sweep, deliberately (a sweep written before Files exists would delete FileNode-backed blobs).

**Subcommands**

- **list** — objects and sizes, largest first  
  `blobs list`
- **rm** — delete one object; refused if referenced  
  `blobs rm <blobId>`

| flag | description |
|---|---|
| `--account <sel>` | which account, when you have more than one |

**Examples**

```sh
bullmoose blobs list
bullmoose blobs rm b_9f3c… 
# refused while any message or share needs it
```

See also: [`share`](#share), [`sync`](#sync)

## share

list and revoke the expiring public links this account has minted

```
bullmoose share list | revoke <shareId> [--account <sel>] [--json]
```

`bullmoose send` mints a public link for any attachment over --link-max, and those links used to be permanent for their whole TTL (up to 90 days) with no way to list or cancel them. `share list` shows every link the server still has a record of, live or revoked, with its expiry. `share revoke` is the kill switch: the link stops resolving and returns exactly the same refusal as a forged one, so nobody can probe which ids exist. Records are kept in KV and expire with the link they describe, so an expired link cleans itself up and `list` never grows without bound. Revocation is eventually consistent — allow up to a minute for it to take effect at every edge. To kill EVERY link for EVERY account at once, rotate the server's SHARE_SIGNING_KEY (see docs/DEPLOY.md); that is the break-glass, and its blast radius is total.

**Subcommands**

- **list** — every minted link, live ones first  
  `share list`
- **revoke** — stop a link resolving  
  `share revoke <shareId>`

| flag | description |
|---|---|
| `--account <sel>` | which account, when you have more than one |

**Examples**

```sh
bullmoose share list
bullmoose share revoke sh_4c1f…
# reload the link: it now refuses
```

See also: [`blobs`](#blobs), [`send`](#send)

## identity

send-as addresses and mail signatures (over JMAP)

```
bullmoose identity list | show <id> | signature <id> [--text <file|->] | add <email> | rm <id>
```

The addresses this account may put in From:, and the signature attached to each. An <id> is an identity id or its email address. `signature` reads the signature from --text (a file, or - for stdin), from --html for the HTML alternative, or from a bare pipe; --clear removes both. `send` inserts the signature itself, below the RFC 3676 "-- " separator, because RFC 8621 defines it as something the client inserts — a third-party JMAP client will not apply it. `add` refuses an address that is not on one of your tenant's active domains, and `rm` refuses the account's provisioned primary.

**Subcommands**

- **list** — every send-as address (primary first)  
  `identity list`
- **show** — one identity, with its signature  
  `identity show <id-or-email>`
- **signature** — set or clear the signature  
  `identity signature <id-or-email> [--text <file|->] [--html <file>] [--clear]`
- **add** — add a send-as address on an active domain  
  `identity add <email> [--name <n>] [--reply-to <addr>] [--bcc <addr>]`
- **rm** — remove a send-as address (never the primary)  
  `identity rm <id-or-email>`

| flag | description |
|---|---|
| `--text <file\|->` | plain-text signature source; - is stdin |
| `--html <file\|->` | HTML signature source (a snippet, not a document) |
| `--clear` | on signature: remove both signatures |
| `--name <n>` | display name for add |
| `--reply-to <addr>` | Reply-To for mail sent from this identity |
| `--bcc <addr>` | silent Bcc for mail sent from this identity |
| `--if-state <state>` | refuse the write (exit 5) if the account has moved on since <state> |
| `--dry-run` | resolve the identity and report; write nothing |

**Examples**

```sh
bullmoose identity list
bullmoose identity signature default --text ~/.signature
printf 'Eric\nbullmoose.cc\n' | bullmoose identity signature default
# a bare pipe is the signature
bullmoose send --to you@example.com --subject hi --body test
# the signature travels with it
bullmoose identity add hello@example.com --name Sales
bullmoose send --to a@b.com --identity hello@example.com --subject hi --body test
bullmoose identity rm hello@example.com --dry-run
# resolves the address, writes nothing
```

See also: [`send`](#send), [`vacation`](#vacation), [`accounts`](#accounts)

## admin

operator surface — wraps the provision worker (separate credentials)

```
bullmoose admin <noun> <verb> …
```

Onboarding and administration. `admin init` stores the provision URL + admin token; the rest manage tenants, domains, accounts, agent bindings, tokens, and grants. A tenant id (e.g. t_home) is a slug you choose — a namespace, not a secret.

**Subcommands**

- **init** — configure the operator endpoint  
  `admin init --url <provision-url> --token <admin-token>`
- **tenant** — manage tenants (namespaces)  
  `admin tenant create <id> --name <n> | list`
- **domain** — wire a domain (Email Routing, SES identity, DKIM/DMARC)  
  `admin domain add <domain> --tenant <t> | status <domain> | list`
- **account** — create a mailbox account  
  `admin account create <local@domain> --tenant <t> [--name <n>] [--principal <email>] | list [--tenant <t>]`
- **password** — set a principal's login password  
  `admin password <email>`
- **agent** — bind a cloud agent runtime to a mailbox  
  `admin agent bind <account-email> --name <binding> [--sla <s>] [--allow a@b,c@d] [--reply-mode send|draft] [--config <file.json>] | list <account-email>`
- **token** — mint operator/agent tokens for any account (--scopes required; only this command may mint `admin`)  
  `admin token create <email> --name <n> --scopes <a,b,c> | list [<email>] | revoke <id>`
- **grant** — cross-account delegation (effective rights = token ∩ grant)  
  `admin grant create <grantee-email> <target-email> [--scopes read,contacts] [--book <id>] [--expires <days>] | list [<email>] | revoke <id>`

**Examples**

```sh
bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token $ADMIN_TOKEN
bullmoose admin tenant create t_home --name "Home"
bullmoose admin domain add example.com --tenant t_home
bullmoose admin account create you@example.com --tenant t_home
bullmoose admin agent bind editor@example.com --name editor --reply-mode draft --config docs/examples/editor-emily.config.json
bullmoose admin token create hermes@example.com --name hermes-bridge --scopes read,send
bullmoose admin grant create partner@example.com you@example.com --scopes read,contacts --book <bookId> --expires 365
```

See also: [`token`](#token), [`agent`](#agent)

