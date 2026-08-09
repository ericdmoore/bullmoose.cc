/**
 * Single source of truth for the `bullmoose` CLI's help surface.
 *
 * The COMMANDS spec below drives, via the renderers at the bottom:
 *   - `bullmoose help` / `bullmoose --help`        → renderOverview()
 *   - `bullmoose help <cmd>` / `bullmoose <cmd> -h` → renderCommand()
 *   - `bullmoose help --json`                       → helpJson()   (agents)
 *   - `bullmoose help --man`                        → renderMan()  (→ man/bullmoose.1)
 *   - `bullmoose help --markdown`                   → renderMarkdown() (→ docs/cli.md)
 *
 * Edit commands HERE and regenerate the docs (`npm run -w @bullmoose/cli gen:docs`);
 * nothing drifts. Keep entries terse — agents parse the JSON, humans read the text.
 */

export const TAGLINE =
  "the CLI for the bullmoose personal-data platform — mail, contacts, calendar, email-native agents, and operator admin, over JMAP";

export interface Flag {
  flag: string; // e.g. "--to <addr>[,<addr>]"
  desc: string;
}
export interface Example {
  cmd: string;
  note?: string;
}
export interface SubCommand {
  name: string;
  synopsis: string;
  summary: string;
}
export interface Command {
  name: string;
  synopsis: string;
  summary: string;
  description?: string;
  subcommands?: SubCommand[];
  flags?: Flag[];
  examples?: Example[];
  seeAlso?: string[];
}

export const GLOBAL_OPTIONS: Flag[] = [
  { flag: "--db <path>", desc: "SQLite database path (default: $BULLMOOSE_DB or ~/.bullmoose/mail.db)" },
  {
    flag: "--account <sel>",
    desc:
      "account selector: accountId, address, @domain-suffix, name substring, or 'default'. " +
      "For commands that act on ONE account a selector matching several is an error, not a choice — " +
      "name one. Commands that legitimately fan out (log, search, sync, watch, mailboxes) still do.",
  },
  {
    flag: "--json",
    desc:
      "machine-readable output: NDJSON — one complete JSON value per line — for collections, " +
      "exactly one object for show-style commands. Never a wrapping array, so `| head`, `| wc -l` " +
      "and `| jq` all stream. (`help --json` dumps this whole spec.)",
  },
  {
    flag: "--ids",
    desc: "print bare identifiers, one per line, and nothing else — the `| xargs -n1` shape",
  },
  {
    flag: "--dry-run",
    desc:
      "on destructive commands (move, trash, rm/delete, mailbox rm, blobs rm, share revoke, " +
      "token revoke, creds rm, contacts import, vacation on|off, admin *revoke): resolve " +
      "everything, report what would happen, write nothing",
  },
  {
    flag: "--if-state <state>",
    desc:
      "optimistic concurrency for writes: passed to JMAP as ifInState. If the server has moved on, " +
      "the write is refused with exit 5 and nothing changes. The state to pass is printed by the " +
      "previous write (and is in its --json output as `state`).",
  },
  {
    flag: "--as <type>",
    desc: "force the input content type — vcard | ical | json | text (default: inferred from the bytes)",
  },
  { flag: "-h, --help", desc: "show help; `bullmoose <cmd> --help` shows help for one command" },
  { flag: "--man / --markdown", desc: "render the whole spec as a man page / Markdown (used to generate the docs)" },
];

/**
 * The exit-code table (`.plans/s05-cli-crud/arch.md` §1.5). Kept here as data
 * so `help --json` carries it: an agent scripting the CLI needs to know what
 * the numbers mean, and prose in a paragraph is not that.
 */
export const EXIT_CODES: Array<{ code: number; meaning: string; when: string }> = [
  { code: 0, meaning: "success", when: "the command did what it said" },
  { code: 1, meaning: "generic failure", when: "server error, quota, rate limit — nothing you can restate" },
  { code: 2, meaning: "usage error", when: "unknown flag or command, missing argument, ambiguous --account" },
  { code: 3, meaning: "not found", when: "no such message, mailbox, contact, account or blob" },
  { code: 4, meaning: "auth / forbidden", when: "the token is rejected or lacks the scope" },
  { code: 5, meaning: "conflict", when: "--if-state mismatch, or a precondition like a non-empty mailbox" },
];

export const NOTES = [
  "Auth model: login stretches your password locally and stores a bearer token; device/app tokens (bm_…) are minted with `token create` and used by clients (JMAP, CalDAV/CardDAV, POP3/SMTP). The login password is never stored or sent raw.",
  "The database is the server's own data-plane schema — open it directly with `sqlite3` for anything the commands don't cover.",
  "Operator commands (`admin …`) wrap the provision worker and use separate credentials from a mail account.",
  "I/O contract — every command obeys it. **stdout carries records; stderr carries everything else**: progress, prompts, warnings, counts and summaries, tree decoration, \"(none)\" notices and hints. So `bullmoose log > /dev/null` shows the chrome and no records, and `2>/dev/null` shows the records and no chrome. A downstream reader closing the pipe (`| head`, quitting `less`) is not an error: the CLI exits 0 silently instead of printing a stack trace. Output is never paged, never coloured when stdout is not a terminal, and never coloured at all when $NO_COLOR is set. Where a command takes a file, `-` means stdin explicitly and a bare invocation reads stdin when it is not a terminal — but an explicit flag always beats implicit stdin.",
  "Exit codes are the branch points for scripts: 0 success · 1 generic failure · 2 usage error · 3 not found · 4 auth/forbidden · 5 conflict (an --if-state mismatch, or a precondition such as removing a mailbox that still holds mail). JMAP error types map onto them by rule: `stateMismatch`/`alreadyExists`/`mailboxHasEmail` → 5, `notFound`/`blobNotFound`/`accountNotFound` → 3, `forbidden`/`accountReadOnly` → 4, `invalidProperties`/`invalidArguments`/`tooLarge` → 2, and `serverFail`/`overQuota`/`rateLimit` → 1.",
];

export const COMMANDS: Command[] = [
  {
    // `help` was a real command with no spec entry: `bullmoose help help`
    // answered "unknown command: help" and exited 1, and it was missing from
    // `help --json`, which is what agents parse
    // (`.feedback/fromClaude/cli/010` item 3). `help.test.ts` now asserts the
    // registry and main.ts's switch cover exactly the same set.
    name: "help",
    synopsis: "bullmoose help [<command>] | --json | --man | --markdown",
    summary: "show help — for everything, one command, or as a machine-readable spec",
    description:
      "With no argument, the command overview. With a command name, that command's synopsis, flags and examples (`bullmoose <cmd> --help` is the same thing). `--json` dumps this entire spec — commands, subcommands, flags, examples, global options, the exit-code table and the I/O contract notes — and is what an agent should read rather than scraping the text. `--man` and `--markdown` render the same spec as a man page and as Markdown; `docs/cli.md` and `man/bullmoose.1` are generated from them by `npm run -w @bullmoose/cli gen:docs` and must never be hand-edited.",
    flags: [
      { flag: "--json", desc: "the whole command spec, machine-readable" },
      { flag: "--man", desc: "roff man page (→ man/bullmoose.1)" },
      { flag: "--markdown", desc: "Markdown reference (→ docs/cli.md)" },
    ],
    examples: [
      { cmd: "bullmoose help mailbox" },
      { cmd: "bullmoose help --json | jq -r '.commands[].name'", note: "what can this CLI do?" },
    ],
  },
  {
    name: "login",
    synopsis:
      "bullmoose login <email> [--base <url>] [--name <device-name>] [--password <pw>] [--scopes <a,b,c>]",
    summary: "log in and store a bearer token for this account",
    description:
      "Authenticates to a JMAP server. With no --base, the server is autodiscovered from the email domain via the _jmap._tcp SRV record / .well-known/jmap fallback (RFC 8620 §2.2). The password comes from the prompt, $BULLMOOSE_PASSWORD, or --password; it is stretched locally, used once, and never stored or sent raw. --scopes sets what the minted token may do and is OPTIONAL here — this is the one command that must work before you hold any token, so omitting it takes the server default of `mail` (the six mail verbs; no contacts, calendar or vault). `login` is also the only self-service way to WIDEN scope, because `token create` can only narrow the token it is called with.",
    flags: [
      { flag: "--base <url>", desc: "JMAP server base; skip to autodiscover from the email domain" },
      { flag: "--name <device-name>", desc: "label the minted token (shows in `token list`)" },
      { flag: "--password <pw>", desc: "password (else prompt or $BULLMOOSE_PASSWORD)" },
      {
        flag: "--scopes <a,b,c>",
        desc: "scopes for the minted token; omit for the server default (mail). Vocabulary (a flat set, not an ordering): read; the mail verbs annotate, draft, move, send, delete; the bundle mail; the realms contacts, calendar, vault, files. Any write implies read.",
      },
    ],
    examples: [
      { cmd: "bullmoose login you@example.com", note: "autodiscover the server, prompt for password" },
      { cmd: "bullmoose login you@example.com --base https://jmap.example.com --name laptop" },
      {
        cmd: "bullmoose login you@example.com --scopes mail,contacts,calendar,vault",
        note: "widen past the default (login is the only way)",
      },
    ],
    seeAlso: ["discover", "init", "token"],
  },
  {
    name: "discover",
    synopsis: "bullmoose discover <email-or-domain>",
    summary: "show what autodiscovery finds and probe the server",
    description:
      "Resolves the JMAP base for an email or domain (SRV _jmap._tcp, then .well-known/jmap), prints the method and base, and probes the session endpoint. Read-only; no auth.",
    examples: [{ cmd: "bullmoose discover example.com" }],
    seeAlso: ["login"],
  },
  {
    name: "init",
    synopsis: "bullmoose init --base <url> --token <token> [--account <id>] [--offline]",
    summary: "configure an account from an existing token (no password login)",
    description:
      "Pastes an existing token instead of logging in. --base also accepts file:///path/to/bundle.json — a {base, token, accountId} bootstrap written by an operator. --offline stores it without validating against the server.",
    flags: [
      { flag: "--base <url>", desc: "JMAP base, or file:// path to a bootstrap bundle" },
      { flag: "--token <token>", desc: "a bm_… bearer token" },
      { flag: "--account <id>", desc: "account id, if the token covers several" },
      { flag: "--offline", desc: "store without validating" },
    ],
    examples: [
      { cmd: "bullmoose init --base https://jmap.example.com --token bm_… --account t_home__a_you" },
      { cmd: "bullmoose init --base file:///tmp/bootstrap.json", note: "operator-written bundle" },
    ],
    seeAlso: ["login", "token"],
  },
  {
    name: "token",
    synopsis: "bullmoose token create --name <n> --scopes <a,b,c> | list | revoke <id>",
    summary: "mint / list / revoke device app-passwords for this account",
    description:
      "Device tokens (bm_…) are what clients authenticate with — never the login password. Scope them per device so a lost device can be revoked alone. --scopes is REQUIRED: there is no default, because the shortest command should not mint the widest credential. Vocabulary is a flat set, not an ordering: the base read; the mail verbs annotate, draft, move, send, delete; the bundle `mail`, which means exactly read + those five and nothing else; and the independent realms contacts, calendar, vault, files. The one implication is that any write implies read (you cannot change what you cannot see); nothing else implies anything — delete does not imply send, and one realm never implies another. A token can only ever be narrower than the one that minted it, so to widen, run `login` again with --scopes.",
    subcommands: [
      { name: "create", synopsis: "token create --name <n> --scopes <a,b,c>", summary: "mint a token (shown once)" },
      { name: "list", synopsis: "token list", summary: "list this account's tokens" },
      { name: "revoke", synopsis: "token revoke <id>", summary: "revoke one token by id" },
    ],
    examples: [
      { cmd: "bullmoose token create --name backup --scopes read", note: "read-only sync/archive" },
      {
        cmd: 'T=$(bullmoose token create --name ci --scopes read)',
        note: "the token is the only thing on stdout; the chrome goes to stderr",
      },
      { cmd: "bullmoose token create --name popper --scopes read,move", note: "POP3 via popcorn" },
      { cmd: "bullmoose token create --name laptop --scopes read,draft,send", note: "a mail client" },
      { cmd: "bullmoose token create --name macbook-contacts --scopes contacts", note: "CardDAV only" },
    ],
    seeAlso: ["login", "admin token"],
  },
  {
    name: "accounts",
    synopsis: "bullmoose accounts",
    summary: "list this login's accounts (★ = default; local counts shown)",
    seeAlso: ["login", "sync"],
  },
  {
    name: "sync",
    synopsis: "bullmoose sync [--blobs <dir>] [--account <sel>]",
    summary: "pull mail into the local SQLite log (all accounts by default)",
    description:
      "Default syncs ALL accounts: clean ones are detected in one batched round-trip and skipped; only dirty inboxes fully sync. --blobs downloads message blobs into a directory.",
    flags: [
      { flag: "--blobs <dir>", desc: "also download blobs into <dir>" },
      { flag: "--account <sel>", desc: "limit to one account" },
    ],
    examples: [{ cmd: "bullmoose sync" }, { cmd: "bullmoose sync --account @example.com --blobs ./blobs" }],
    seeAlso: ["watch", "log", "search"],
  },
  {
    name: "send",
    synopsis: "bullmoose send --to <addr>[,<addr>] --subject <s> [--cc ..] [--bcc ..] [--file <path> | --body <text>]",
    summary: "compose and send mail (Markdown → MIME, inline images, big-file links)",
    description:
      "Body comes from --file, else --body, else piped stdin. With --expandMD html the body is treated as Markdown: rendered HTML becomes the displayed body (raw Markdown rides along as the plain-text fallback), local images inline as cid: parts, linked files attach, and anything over --linkMax is uploaded to R2 and rewritten to a signed link expiring after --linkTTL days.",
    flags: [
      { flag: "--to / --cc / --bcc <addr>", desc: "recipients (repeatable or comma-separated)" },
      { flag: "--subject <s>", desc: "subject line" },
      { flag: "--file <path> / --body <text>", desc: "body source (else stdin)" },
      { flag: "--from <address>", desc: "select the sending account + identity" },
      { flag: "--identity <id-or-email>", desc: "pick a specific identity" },
      { flag: "--expandMD html|no", desc: "render Markdown to HTML (default: no)" },
      { flag: "--linkMax <MiB>", desc: "big-file threshold (default 4)" },
      { flag: "--linkTTL <days>", desc: "share-link lifetime (default 30)" },
    ],
    examples: [
      { cmd: 'echo "it lives" | bullmoose send --to a@b.com --subject "first light"' },
      { cmd: "bullmoose send --to a@b.com --subject Notes --file notes.md --expandMD html", note: "Markdown → HTML with inline assets" },
    ],
    seeAlso: ["read", "watch"],
  },
  {
    name: "read",
    synopsis: "bullmoose read [emailId] [--raw] [--json]",
    summary: "print a message (newest if no id)",
    flags: [
      { flag: "--raw", desc: "print the raw RFC 5322 source" },
      { flag: "--json", desc: "structured output" },
    ],
    examples: [{ cmd: "bullmoose read" }, { cmd: "bullmoose read <emailId> --raw" }],
    seeAlso: ["show", "log", "search"],
  },
  {
    name: "watch",
    synopsis: "bullmoose watch [--json] [--exec <cmd>] [--daemon | --status | --stop]",
    summary: "push-triggered live sync: print new mail as it arrives",
    description:
      "Holds a JMAP push channel and prints each new message. --json emits NDJSON events; --daemon detaches (prints a PID; logs beside the db file). --exec runs a shell command once per new message: the command is handed to `sh -c` verbatim and the message arrives in the environment as $BM_ID, $BM_ACCOUNT, $BM_FROM, $BM_SUBJECT and $BM_PREVIEW (preview truncated to 120 chars). Quote them — an inbound subject is attacker-controlled text, and unquoted it still word-splits inside your own command. BREAKING (was: substitution): the {id} {from} {subject} {preview} placeholders are no longer substituted — they were a shell-injection vector, since a stranger's subject line ended up parsed by your shell. A template still containing them gets a warning on stderr. The hook is fire-and-forget, gets no stdin, and under --json its stdout is redirected to stderr so it cannot corrupt the NDJSON stream.",
    flags: [
      { flag: "--json", desc: "emit NDJSON events" },
      {
        flag: "--exec <cmd>",
        desc: "run `sh -c <cmd>` per new message; fields arrive as $BM_ID $BM_ACCOUNT $BM_FROM $BM_SUBJECT $BM_PREVIEW",
      },
      { flag: "--daemon / --status / --stop", desc: "manage a detached watcher" },
    ],
    examples: [
      { cmd: "bullmoose watch" },
      {
        cmd: 'bullmoose watch --json --exec \'notify-send "$BM_FROM: $BM_SUBJECT"\'',
        note: "always quote $BM_* — the values come from whoever emailed you",
      },
    ],
    seeAlso: ["sync", "agent"],
  },
  {
    name: "vacation",
    synopsis: "bullmoose vacation on|off|status [--subject <s>] [--body <text>] [--until <date>]",
    summary: "manage the RFC 8621 vacation responder",
    description:
      "An armed auto-responder (wait=0) with RFC 3834 suppression — once per sender per 7 days. `status` shows the current state.",
    flags: [
      { flag: "--subject <s> / --body <text>", desc: "the auto-reply content" },
      { flag: "--until <date>", desc: "auto-disable date" },
    ],
    examples: [{ cmd: 'bullmoose vacation on --subject "Away" --body "Back Monday." --until 2026-07-15' }],
  },
  {
    name: "agent",
    synopsis: "bullmoose agent serve --config <agent.json> [--once] | invoke <binding> --email <id> | invocations [<status>] | rm <invId>",
    summary: "run the homelab agent runtime, and trigger agents on demand",
    description:
      "`serve` logs in as the bound account, watches the AgentInvocation queue over the same push channel as `watch`, claims pending work, and drafts replies in template mode. Providers: mock | anthropic | openai-compatible; API keys by env reference, never in the config. --once drains and exits (cron-friendly). The config's `binding` must match the server-side binding name (see `admin agent bind`).\n\n`invoke` (sVOL 007) is the on-demand trigger: it queues a pending invocation for a binding against an EXISTING message, and a runtime — your own `serve`, or the cloud runtime on its cron — picks it up over the changelog. This is how a human starts an agent on a thread rather than waiting for inbound mail. It runs on this account's own mail token, not the operator admin token. It REFUSES a binding that `admin agent disable` has turned off (the 008 kill switch): you cannot fire an agent whose off switch is pulled. `invocations` lists the queue (default: pending), and `rm` purges one — a running invocation is refused.",
    subcommands: [
      { name: "serve", synopsis: "agent serve --config <agent.json> [--once]", summary: "run the homelab runtime; claims the queue" },
      { name: "invoke", synopsis: "agent invoke <binding> --email <emailId> [--note <text>]", summary: "queue an invocation for a binding on a message (refused if the binding is disabled)" },
      { name: "invocations", synopsis: "agent invocations [pending|running|done|failed]", summary: "list the invocation queue (default: pending)" },
      { name: "rm", synopsis: "agent rm <invId>", summary: "purge an invocation (a running one is refused)" },
    ],
    flags: [
      { flag: "--config <agent.json>", desc: "serve: agent definition (binding, persona, model{provider,baseURL,apiKeyEnv})" },
      { flag: "--once", desc: "serve: drain the queue once and exit" },
      { flag: "--email <emailId>", desc: "invoke: the message the agent acts on (required)" },
      { flag: "--note <text>", desc: "invoke: a human note stored in the invocation context" },
    ],
    examples: [
      { cmd: "bullmoose agent serve --config hermes.json" },
      { cmd: "bullmoose agent serve --config hermes.json --once", note: "cron drain" },
      { cmd: "bullmoose agent invoke emily --email e_9f3c…", note: "start emily on an existing message" },
      { cmd: "bullmoose agent invocations", note: "what is queued right now" },
      { cmd: "bullmoose agent invocations --ids | xargs -n1 bullmoose agent rm", note: "clear the pending queue" },
    ],
    seeAlso: ["admin agent bind", "watch"],
  },
  {
    name: "contacts",
    synopsis: "bullmoose contacts import|list|show|books|create|edit|rm|export …",
    summary: "read and write the contacts core (vCard ⇄ JSContact)",
    description:
      "The full CRUD surface over the JSContact core. `import` is the idempotent bulk seed (dedup by uid); `create` makes one card without dedup; `export` is its inverse — vCard 3.0 on stdout, so `export | import` round-trips a book with no drift. Card writes need the `contacts` scope; because any write implies read (common/027), a `contacts` token also satisfies the read verbs, so one scope covers both listing and editing cards. `books create|rename|rm` manage address books and are OWNER-ONLY: the server refuses them on delegated (grant-reached) access with a clean exit 4, so an agent should edit cards, not books. All write verbs take --if-state (exit 5 on a stale state) and --dry-run.",
    subcommands: [
      { name: "import", synopsis: "contacts import [<file.vcf>|-] [--book <name-or-id>] [--as vcard] [--dry-run]", summary: "seed from a vCard export (idempotent; dedup by uid; missing --book created); reads stdin with no path, or with `-`" },
      { name: "list", synopsis: "contacts list [--book <name-or-id>] [-n <count>] [--json|--ids]", summary: "list cards" },
      { name: "show", synopsis: "contacts show <cardId> [--json]", summary: "show one card" },
      { name: "books", synopsis: "contacts books list | create <name> | rename <name-or-id> <new> | rm <name-or-id> [--force]", summary: "address-book lifecycle; create/rename/rm are owner-only (exit 4 on delegated access); rm of a non-empty book needs --force (else exit 5)" },
      { name: "create", synopsis: "contacts create [<file>|-] [--book <name-or-id>] [--as vcard|json] [--dry-run]", summary: "create card(s) from a vCard or JSON body — no dedup; reads stdin with no path, or with `-`" },
      { name: "edit", synopsis: "contacts edit <cardId> [<file>|-] [--book <name-or-id>] [--as vcard|json]", summary: "replace a card's content from a vCard or JSON body (JMAP patch semantics)" },
      { name: "rm", synopsis: "contacts rm <cardId> [--dry-run] [--if-state <s>]", summary: "delete a card; resolves the target first, so a bad id is exit 3" },
      { name: "export", synopsis: "contacts export [--book <name-or-id>] [--json|--ids]", summary: "the inverse of import — vCard 3.0 on stdout (or JSContact NDJSON under --json)" },
    ],
    examples: [
      { cmd: "bullmoose contacts import Contacts.vcf --book Personal", note: "export from macOS Contacts: File → Export → Export vCard…" },
      { cmd: "bullmoose contacts export --book Personal | bullmoose contacts import - --book Backup", note: "round-trip a book" },
      { cmd: "cat card.vcf | bullmoose contacts create - --book Personal", note: "`-` is explicit stdin" },
      { cmd: "echo '{\"name\":{\"full\":\"Ada\"}}' | bullmoose contacts create --as json" },
      { cmd: "bullmoose contacts export --json | jq -r .uid" },
      { cmd: "bullmoose contacts export --ids | xargs -n1 bullmoose contacts show" },
      { cmd: "bullmoose contacts books create Family --if-state \"$STATE\"" },
    ],
    seeAlso: ["calendar", "admin grant"],
  },
  {
    name: "calendar",
    synopsis: "bullmoose calendar list | agenda | create | rename | rm | event … | export",
    summary: "browse and edit the calendar core (JSCalendar; recurrence expanded server-side)",
    description:
      "Read verbs (`list`, `agenda`) and CRUD over the live JMAP methods. An event body may come from flags (--title/--start/--duration/--tz/--all-day/--rrule), a JSON JSCalendar object, or an iCalendar VEVENT on stdin (`-`) or a path; --as forces the type. Recurrence is master-only: `event edit` changes the whole series; single-occurrence editing (--occurrence) is not yet implemented and refuses cleanly. An --rrule the server's expander cannot expand faithfully (e.g. FREQ=YEARLY;BYDAY=4TH) is rejected up front, naming the part, rather than written wrong.",
    subcommands: [
      { name: "list", synopsis: "calendar list [--json] [--ids]", summary: "list calendars" },
      { name: "agenda", synopsis: "calendar agenda [--days <n>] [--json] [--ids]", summary: "upcoming occurrences, recurrence-expanded; --ids yields the event ids" },
      { name: "create", synopsis: "calendar create <name> [--dry-run] [--if-state <s>]", summary: "create a calendar" },
      { name: "rename", synopsis: "calendar rename <id-or-name> <new-name>", summary: "rename a calendar" },
      { name: "rm", synopsis: "calendar rm <id-or-name> [--force] [--dry-run]", summary: "delete a calendar; --force also removes its events" },
      { name: "event create", synopsis: "calendar event create [<file>|-] [--calendar <id-or-name>] [--title <t>] [--start <local>] [--duration <iso8601>] [--tz <iana>] [--all-day] [--rrule <RRULE>] [--as ical|json] [--dry-run]", summary: "create an event from flags, JSON, or iCal" },
      { name: "event edit", synopsis: "calendar event edit <id> [--title …] [--start …] [--rrule …] [<patch.json>|-] [--if-state <s>]", summary: "edit the whole series (the master)" },
      { name: "event rm", synopsis: "calendar event rm <id> [--dry-run]", summary: "delete an event" },
      { name: "export", synopsis: "calendar export [--ics] [--calendar <id-or-name>] [--json] [--ids]", summary: "dump events as iCalendar or NDJSON JSCalendar" },
    ],
    examples: [
      { cmd: "bullmoose calendar agenda --days 14" },
      { cmd: "bullmoose calendar create Work" },
      { cmd: "bullmoose calendar event create --title 'Standup' --start 2026-07-08T09:00:00 --duration PT15M --tz America/Chicago" },
      { cmd: "cat meeting.ics | bullmoose calendar event create - --calendar Work", note: "`-` is explicit stdin" },
      { cmd: "bullmoose calendar export --ics > backup.ics", note: "open in Apple Calendar to verify" },
      { cmd: "bullmoose calendar agenda --ids | xargs -n1 bullmoose calendar event rm --dry-run" },
    ],
    seeAlso: ["contacts"],
  },
  {
    name: "creds",
    synopsis: "bullmoose creds init | set <name> | list | show <name> | rotate <name> | rm <name> | oauth <name> …",
    summary: "manage the write-only, envelope-encrypted credential vault",
    description:
      "The vault stores third-party API keys, OAuth refresh tokens and signing keys for agents. It is WRITE-ONLY — secrets go in and are never returned (`show`/`list` are metadata only). Every credential carries the Bureau's mint-time contract (bureau.md §5): a `--kind` that gates which verbs may ever use it, and a `--allow` destination binding it fails closed without. NOTHING enforces the binding, verb set or redaction yet — the Bureau proxy is a later task; `--enforcement broad` records that only our code will, once it exists. `oauth` runs a browser + localhost PKCE flow and uploads only the refresh token.",
    subcommands: [
      { name: "init", synopsis: "creds init --url <agent-worker-url>", summary: "point the vault at the agent worker" },
      { name: "set", synopsis: "creds set <name> --kind <kind> --allow <origin> [--header \"Name: …{}…\"] [--scope actor] [--enforcement federated|narrow|broad] [--secret <s> | --secret-env VAR] [--meta k=v,…]", summary: "mint a credential with its §5 contract (else hidden prompt)" },
      { name: "list", synopsis: "creds list", summary: "list names, kinds and destination bindings (never values)" },
      { name: "show", synopsis: "creds show <name>", summary: "one credential's metadata — never the secret" },
      { name: "rotate", synopsis: "creds rotate <name> [--secret <s> | --secret-env VAR]", summary: "re-seal a new secret under the same name (refs unchanged)" },
      { name: "rm", synopsis: "creds rm <name>", summary: "remove a credential" },
      { name: "oauth", synopsis: "creds oauth <name> --authorize-url <u> --token-url <u> --client-id <id> [--client-secret <s>] [--oauth-scopes \"a b\"] [--allow <origin>] [--meta k=v,…] [--port <n>]", summary: "PKCE flow; uploads only the refresh token" },
    ],
    flags: [
      { flag: "--kind api-key|oauth-refresh|aws-sigv4|hmac-key", desc: "what the credential is; gates which Bureau verbs may ever use it (bureau.md §4.1)" },
      { flag: "--allow <origin>", desc: "destination binding — the primary control; an origin (https://host) or a *.wildcard. Required on `set`: fail closed (§6)" },
      { flag: "--header \"Name: …{}…\"", desc: "injection recipe; the {} is where the value goes. Header-only, never a query param. Defaults to Authorization: Bearer {} for api-key" },
      { flag: "--scope actor", desc: "who may open the row; only `actor` today — `inbox`/`global` need the AAD re-seal (§9), deferred" },
      { flag: "--enforcement federated|narrow|broad", desc: "which §5.2 rung enforces the narrowing; `broad` (default) = only our code will, once the proxy exists" },
      { flag: "--secret <s> / --secret-env VAR", desc: "the value, or the env var holding it (else a hidden prompt — never argv)" },
      { flag: "--meta k=v,…", desc: "free-form metadata stored beside the credential (also accepted on `oauth`)" },
      { flag: "--port <n>", desc: "localhost port for the `oauth` PKCE callback (default 8976)" },
      { flag: "--dry-run", desc: "on `rm`/`rotate`: report what would happen, write nothing" },
    ],
    examples: [
      { cmd: "bullmoose creds set stripe --kind api-key --allow https://api.stripe.com --secret-env STRIPE_KEY" },
      { cmd: "bullmoose creds set aws-mcp --kind aws-sigv4 --allow \"*.amazonaws.com\" --enforcement narrow --secret-env AWS_SECRET" },
      { cmd: "bullmoose creds oauth gcal --authorize-url … --token-url … --client-id … --port 9000" },
    ],
    seeAlso: ["agent"],
  },
  {
    name: "log",
    synopsis: "bullmoose log [-n <count>] [--mailbox <role-or-id>] [--account <sel>] [--json]",
    summary: "list messages from the local log",
    flags: [
      { flag: "-n <count>", desc: "how many (default 20)" },
      { flag: "--mailbox <role-or-id>", desc: "filter by mailbox (e.g. inbox, sent)" },
    ],
    examples: [
      { cmd: "bullmoose log -n 50 --mailbox inbox" },
      { cmd: "bullmoose log | head -3", note: "exits 0 silently — a closed pipe is not an error" },
      { cmd: "bullmoose log --json | jq -r .subject", note: "NDJSON: streams, one record per line" },
      { cmd: "bullmoose log --ids | xargs -n1 bullmoose show", note: "bare ids, the xargs shape" },
    ],
    seeAlso: ["search", "read", "sync"],
  },
  {
    name: "search",
    synopsis: "bullmoose search <fts5-query> [--account <sel>] [--json]",
    summary: "full-text search the local log (SQLite FTS5)",
    examples: [{ cmd: 'bullmoose search "invoice NEAR quote"' }],
    seeAlso: ["log", "read"],
  },
  {
    name: "show",
    synopsis: "bullmoose show <emailId> [--json]",
    summary: "show a message's metadata + structure",
    seeAlso: ["read"],
  },
  {
    name: "mailboxes",
    synopsis: "bullmoose mailboxes [--json]",
    summary: "list mailboxes for the selected account",
    description:
      "Reads the LOCAL mirror, so it shows what the last `sync` (or `mailbox` write) fetched. Use `mailbox` to create, rename, move or remove folders.",
    seeAlso: ["mailbox", "log", "sync"],
  },
  {
    name: "mailbox",
    synopsis: "bullmoose mailbox create <name> | rename <box> <new> | move <box> --parent <box|-> | rm <box> [--force]",
    summary: "create, rename, move and remove folders (over JMAP)",
    description:
      "Folder management via Mailbox/set. A <box> is an id, a role (inbox, sent, drafts, trash, junk, archive), or a name — names are matched case-insensitively and an ambiguous one is refused. Folders nest: --parent puts a new or existing folder under another, up to the server's advertised maxMailboxDepth (10), and --parent - moves one back to the top level. Names must be unique among siblings. Role folders may be renamed but never removed, and `rm` refuses a folder that still holds mail or has children — `--force` removes the mail with it, destroying any message that is in no other folder. Every verb refreshes the local mirror on success, so `bullmoose mailboxes` is current immediately without a full `sync`.",
    subcommands: [
      { name: "create", synopsis: "mailbox create <name> [--parent <box>] [--sort <n>]", summary: "make a folder" },
      { name: "rename", synopsis: "mailbox rename <box> <new-name>", summary: "rename a folder (roles may be renamed)" },
      { name: "move", synopsis: "mailbox move <box> --parent <box|->", summary: "reparent a folder ('-' = top level)" },
      { name: "rm", synopsis: "mailbox rm <box> [--force]", summary: "remove a folder; --force takes its mail too" },
    ],
    flags: [
      { flag: "--parent <box>", desc: "parent folder for create/move; '-' means top level" },
      { flag: "--sort <n>", desc: "sortOrder for create (unsigned integer, default 0)" },
      { flag: "--force", desc: "on rm: onDestroyRemoveEmails — remove the mail inside it too" },
      { flag: "--if-state <state>", desc: "refuse the write (exit 5) if the account has moved on since <state>" },
      { flag: "--dry-run", desc: "resolve the folder and report; write nothing" },
    ],
    examples: [
      { cmd: "bullmoose mailbox create Receipts" },
      { cmd: "bullmoose mailbox create 2026 --parent Receipts", note: "nest under an existing folder" },
      { cmd: "bullmoose mailbox rename Receipts Invoices" },
      { cmd: "bullmoose mailbox move Invoices --parent -", note: "back to the top level" },
      { cmd: "bullmoose mailbox rm Invoices --force" },
      { cmd: "bullmoose mailbox rm Invoices --dry-run", note: "resolves the name, writes nothing" },
      {
        cmd: "S=$(bullmoose mailbox create A --json | jq -r .state); bullmoose mailbox rename A B --if-state \"$S\"",
        note: "read-modify-write that cannot clobber a concurrent change: exit 5 if it would",
      },
    ],
    seeAlso: ["mailboxes", "sync", "log"],
  },
  {
    // ---- triage verbs (sVOL 019) ----
    name: "flag",
    synopsis: "bullmoose flag <id…> --add <keyword> [--remove <keyword>] [--if-state <s>]",
    summary: "set or clear message keywords (over JMAP)",
    description:
      "Adds and removes RFC 8621 keywords on one or more messages via Email/set. Keywords are a set: --add and --remove take system flags ($seen, $flagged, $answered, $forwarded, $draft) or custom labels, and both are repeatable. Quote system flags — $flagged is a shell variable unquoted. This is a keywords-only patch, so it needs the `annotate` scope alone (not `move` or `draft`). Ids come as arguments (the xargs shape) or on stdin, and stdout is the ids it changed, so verbs chain. The local mirror is reconciled on success unless --no-sync.",
    flags: [
      { flag: "--add <keyword>", desc: "keyword to set (repeatable); e.g. --add '$flagged'" },
      { flag: "--remove <keyword>", desc: "keyword to clear (repeatable); e.g. --remove '$seen'" },
      { flag: "--no-sync", desc: "skip reconciling the local mirror (batch, then sync once)" },
      { flag: "--if-state <state>", desc: "refuse (exit 5) if the account moved on since <state>" },
    ],
    examples: [
      { cmd: "bullmoose flag em_1 --add '$flagged'", note: "quote it — $flagged is a shell var" },
      { cmd: "bullmoose search important --ids | xargs bullmoose flag --add '$flagged'" },
    ],
    seeAlso: ["seen", "move", "log"],
  },
  {
    name: "seen",
    synopsis: "bullmoose seen <id…> [--unset]",
    summary: "mark messages read, or unread with --unset (sugar over flag $seen)",
    description:
      "Sugar for `flag --add '$seen'` (or `--remove` with --unset). `bullmoose read` does NOT mark a message read, so this is how a script or a human clears the unread dot. Ids come as arguments or on stdin.",
    flags: [{ flag: "--unset", desc: "mark UNread instead (clear $seen)" }],
    examples: [
      { cmd: "bullmoose log -n 200 --json | jq -r 'select(.seen==0) | .id' | xargs bullmoose seen" },
    ],
    seeAlso: ["flag", "read"],
  },
  {
    name: "move",
    synopsis: "bullmoose move <id…> --role <role> | --mailbox <id-or-name> [--if-state <s>]",
    summary: "move messages into exactly one mailbox (replaces the set)",
    description:
      "REPLACES a message's mailbox set with the single named target, via an Email/set mailboxIds patch (scope: `move`). --role names a seeded role folder (inbox, sent, drafts, trash, junk, archive); --mailbox names any folder by id or name. Contrast `label`, which ADDS or removes one mailbox without disturbing the others — getting this wrong is the classic mail-CLI bug. Ids come as arguments or on stdin; stdout is the ids it moved; the local mirror is reconciled unless --no-sync.",
    flags: [
      { flag: "--role <role>", desc: "target a seeded role folder (archive, junk, trash, inbox, …)" },
      { flag: "--mailbox <id-or-name>", desc: "target any folder by id or name" },
      { flag: "--no-sync", desc: "skip reconciling the local mirror" },
      { flag: "--if-state <state>", desc: "refuse (exit 5) if the account moved on since <state>" },
      { flag: "--dry-run", desc: "resolve the destination and report; write nothing" },
    ],
    examples: [
      { cmd: "bullmoose move em_1 --mailbox Receipts" },
      { cmd: "bullmoose search 'from:amazon' --ids | xargs bullmoose move --role archive" },
    ],
    seeAlso: ["archive", "label", "mailbox"],
  },
  {
    name: "label",
    synopsis: "bullmoose label <id…> --add <mailbox> [--remove <mailbox>]",
    summary: "add or remove one mailbox without disturbing the others",
    description:
      "JMAP's mailboxIds is a SET — a message can live in several folders — so `label` adds and removes individual mailboxes with a per-key patch (scope: `move`), leaving the rest in place. This is what you want when `move` (which replaces the whole set) would unfile the message. A --remove that would leave a message in NO mailbox is refused client-side, naming `move`, rather than surfacing a server invalidProperties. Both flags take an id or name and are repeatable.",
    flags: [
      { flag: "--add <mailbox>", desc: "mailbox (id or name) to add (repeatable)" },
      { flag: "--remove <mailbox>", desc: "mailbox to remove; refused if it would empty the set" },
      { flag: "--no-sync", desc: "skip reconciling the local mirror" },
    ],
    examples: [
      { cmd: "bullmoose label em_1 --add Receipts" },
      { cmd: "bullmoose search receipt --ids | xargs bullmoose label --add Receipts" },
    ],
    seeAlso: ["move", "mailbox"],
  },
  {
    name: "archive",
    synopsis: "bullmoose archive <id…> [--if-state <s>] [--dry-run]",
    summary: "move messages to the Archive folder (sugar over move --role archive)",
    description:
      "The most-used triage verb: move messages into the seeded `archive` role mailbox. Sugar for `move --role archive`. Ids come as arguments or on stdin; stdout is the ids archived, so it chains into the next verb.",
    examples: [
      { cmd: "bullmoose archive em_1 em_2" },
      { cmd: "bullmoose search 'from:amazon' --ids | xargs bullmoose archive" },
    ],
    seeAlso: ["move", "trash", "junk"],
  },
  {
    name: "junk",
    synopsis: "bullmoose junk <id…>",
    summary: "move messages to the Junk folder (sugar over move --role junk)",
    examples: [{ cmd: "bullmoose search spammy --ids | xargs bullmoose junk" }],
    seeAlso: ["move", "trash", "archive"],
  },
  {
    name: "trash",
    synopsis: "bullmoose trash <id…> [--dry-run]",
    summary: "move messages to Trash (sugar over move --role trash) — reversible, unlike rm",
    description:
      "Moves messages to the seeded `trash` role mailbox. This is what a human means by \"delete\": the message is recoverable from Trash. For a permanent, unrecoverable destroy use `rm --force`.",
    examples: [
      { cmd: "bullmoose search unsubscribe --ids | xargs bullmoose trash --dry-run", note: "rehearse the sweep" },
      { cmd: "bullmoose search unsubscribe --ids | xargs bullmoose trash", note: "then run it" },
    ],
    seeAlso: ["rm", "archive", "move"],
  },
  {
    name: "rm",
    synopsis: "bullmoose rm <id…> --force  |  --dry-run",
    summary: "PERMANENTLY destroy messages — hard delete, no Trash, no undo",
    description:
      "Destroys messages via Email/set destroy (scope: `delete`). This is a HARD delete: the rows are removed, the R2 blob is orphaned, there is no tombstone and NOTHING is recoverable. It is not Trash. Because of that it REFUSES without --force; use --dry-run to see exactly what it would destroy first. If you meant \"move to Trash\", use `bullmoose trash`. `delete` is an alias for this command.",
    flags: [
      { flag: "--force", desc: "required: confirm the permanent, unrecoverable destroy" },
      { flag: "--dry-run", desc: "list what would be destroyed; destroy nothing" },
      { flag: "--if-state <state>", desc: "refuse (exit 5) if the account moved on since <state>" },
      { flag: "--no-sync", desc: "skip reconciling the local mirror" },
    ],
    examples: [
      { cmd: "bullmoose search 'older_than:1y' --ids | xargs bullmoose rm --dry-run", note: "rehearse first" },
      { cmd: "bullmoose rm em_1 --force", note: "permanent; prefer `trash` unless you are sure" },
    ],
    seeAlso: ["trash", "archive"],
  },
  {
    name: "delete",
    synopsis: "bullmoose delete <id…> --force  |  --dry-run",
    summary: "alias for `rm` — PERMANENTLY destroy messages (no Trash, no undo)",
    description:
      "Identical to `bullmoose rm`: a hard, unrecoverable Email/set destroy that refuses without --force. See `bullmoose help rm`. To move to Trash reversibly, use `bullmoose trash`.",
    examples: [{ cmd: "bullmoose search 'older_than:1y' --ids | xargs bullmoose delete --dry-run" }],
    seeAlso: ["rm", "trash"],
  },
  {
    name: "blobs",
    synopsis: "bullmoose blobs list | rm <blobId> [--account <sel>] [--json]",
    summary: "see and remove the objects this account stores in R2",
    description:
      "Attachments and raw messages live in R2 under a per-account prefix. `list` is the only way to find out what is actually stored and how big it is — until it existed, nothing could answer that question while the storage was still billed. `rm` deletes ONE object and refuses (409) if it is still referenced: content-addressed blobs are shared, so the same bytes attached to two messages are one object, and deleting it because one message is gone would break the other. It also refuses while a live share link points at the blob — revoke the link first, so the recipient gets a clear refusal rather than a link that silently starts failing. This is explicit delete only; there is no garbage-collection sweep, deliberately (a sweep written before Files exists would delete FileNode-backed blobs).",
    subcommands: [
      { name: "list", synopsis: "blobs list", summary: "objects and sizes, largest first" },
      { name: "rm", synopsis: "blobs rm <blobId>", summary: "delete one object; refused if referenced" },
    ],
    flags: [{ flag: "--account <sel>", desc: "which account, when you have more than one" }],
    examples: [
      { cmd: "bullmoose blobs list" },
      { cmd: "bullmoose blobs rm b_9f3c… ", note: "refused while any message or share needs it" },
    ],
    seeAlso: ["share", "sync"],
  },
  {
    name: "share",
    synopsis: "bullmoose share list | revoke <shareId> [--account <sel>] [--json]",
    summary: "list and revoke the expiring public links this account has minted",
    description:
      "`bullmoose send` mints a public link for any attachment over --link-max, and those links used to be permanent for their whole TTL (up to 90 days) with no way to list or cancel them. `share list` shows every link the server still has a record of, live or revoked, with its expiry. `share revoke` is the kill switch: the link stops resolving and returns exactly the same refusal as a forged one, so nobody can probe which ids exist. Records are kept in KV and expire with the link they describe, so an expired link cleans itself up and `list` never grows without bound. Revocation is eventually consistent — allow up to a minute for it to take effect at every edge. To kill EVERY link for EVERY account at once, rotate the server's SHARE_SIGNING_KEY (see docs/DEPLOY.md); that is the break-glass, and its blast radius is total.",
    subcommands: [
      { name: "list", synopsis: "share list", summary: "every minted link, live ones first" },
      { name: "revoke", synopsis: "share revoke <shareId>", summary: "stop a link resolving" },
    ],
    flags: [{ flag: "--account <sel>", desc: "which account, when you have more than one" }],
    examples: [
      { cmd: "bullmoose share list" },
      { cmd: "bullmoose share revoke sh_4c1f…", note: "reload the link: it now refuses" },
    ],
    seeAlso: ["blobs", "send"],
  },
  {
    name: "identity",
    synopsis: "bullmoose identity list | show <id> | signature <id> [--text <file|->] | add <email> | rm <id>",
    summary: "send-as addresses and mail signatures (over JMAP)",
    description:
      "The addresses this account may put in From:, and the signature attached to each. An <id> is an identity id or its email address. `signature` reads the signature from --text (a file, or - for stdin), from --html for the HTML alternative, or from a bare pipe; --clear removes both. `send` inserts the signature itself, below the RFC 3676 \"-- \" separator, because RFC 8621 defines it as something the client inserts — a third-party JMAP client will not apply it. `add` refuses an address that is not on one of your tenant's active domains, and `rm` refuses the account's provisioned primary.",
    subcommands: [
      { name: "list", synopsis: "identity list", summary: "every send-as address (primary first)" },
      { name: "show", synopsis: "identity show <id-or-email>", summary: "one identity, with its signature" },
      { name: "signature", synopsis: "identity signature <id-or-email> [--text <file|->] [--html <file>] [--clear]", summary: "set or clear the signature" },
      { name: "add", synopsis: "identity add <email> [--name <n>] [--reply-to <addr>] [--bcc <addr>]", summary: "add a send-as address on an active domain" },
      { name: "rm", synopsis: "identity rm <id-or-email>", summary: "remove a send-as address (never the primary)" },
    ],
    flags: [
      { flag: "--text <file|->", desc: "plain-text signature source; - is stdin" },
      { flag: "--html <file|->", desc: "HTML signature source (a snippet, not a document)" },
      { flag: "--clear", desc: "on signature: remove both signatures" },
      { flag: "--name <n>", desc: "display name for add" },
      { flag: "--reply-to <addr>", desc: "Reply-To for mail sent from this identity" },
      { flag: "--bcc <addr>", desc: "silent Bcc for mail sent from this identity" },
      { flag: "--if-state <state>", desc: "refuse the write (exit 5) if the account has moved on since <state>" },
      { flag: "--dry-run", desc: "resolve the identity and report; write nothing" },
    ],
    examples: [
      { cmd: "bullmoose identity list" },
      { cmd: "bullmoose identity signature default --text ~/.signature" },
      { cmd: "printf 'Eric\\nbullmoose.cc\\n' | bullmoose identity signature default", note: "a bare pipe is the signature" },
      { cmd: "bullmoose send --to you@example.com --subject hi --body test", note: "the signature travels with it" },
      { cmd: "bullmoose identity add hello@example.com --name Sales" },
      { cmd: "bullmoose send --to a@b.com --identity hello@example.com --subject hi --body test" },
      { cmd: "bullmoose identity rm hello@example.com --dry-run", note: "resolves the address, writes nothing" },
    ],
    seeAlso: ["send", "vacation", "accounts"],
  },
  {
    name: "admin",
    synopsis: "bullmoose admin <noun> <verb> …",
    summary: "operator surface — wraps the provision worker (separate credentials)",
    description:
      "Onboarding and administration. `admin init` stores the provision URL + admin token; the rest manage tenants, domains, accounts, agent bindings, tokens, and grants. A tenant id (e.g. t_home) is a slug you choose — a namespace, not a secret.\n\nLifecycle verbs come in two flavours. REVERSIBLE ones — `agent disable|enable`, `domain suspend|resume`, both renames — just run. IRREVERSIBLE ones — `tenant delete`, `domain delete`, `account delete`, `agent unbind` — refuse without `--yes`; use `--dry-run` first to see what they would do.\n\n`agent disable` is the kill switch: both the ingest enqueue path and the agent drain gate on the binding's `enabled` column, so disabling stops an agent being invoked at all. Invocations already queued are HELD, not cancelled — the count is printed, and they resume on `enable`.\n\n`account delete` is a SOFT delete: it removes the delivery route (D1 row and the ingest KV key together, so mail bounces immediately) and tombstones the account so it stops authenticating, but the account's mail, calendars, contacts and blobs live in a different database and are retained. The command prints exactly what it kept.",
    subcommands: [
      { name: "init", synopsis: "admin init --url <provision-url> --token <admin-token>", summary: "configure the operator endpoint" },
      { name: "tenant", synopsis: "admin tenant create <id> --name <n> | list | rename <id> --name <n> | delete <id> --yes", summary: "manage tenants (namespaces)" },
      { name: "domain", synopsis: "admin domain add <domain> --tenant <t> | status <domain> | list | suspend <domain> | resume <domain> | delete <domain> --yes", summary: "wire a domain (Email Routing, SES identity, DKIM/DMARC); suspend stops mail reversibly, delete refuses while accounts remain" },
      { name: "account", synopsis: "admin account create <local@domain> --tenant <t> [--name <n>] [--principal <email>] | list [--tenant <t>] [--include-deleted] | rename <accountId> --name <n> | delete <accountId> --yes", summary: "create, rename and (soft) delete a mailbox account" },
      { name: "password", synopsis: "admin password <email>", summary: "set a principal's login password" },
      { name: "agent", synopsis: "admin agent bind <account-email> --name <binding> [--sla <s>] [--allow a@b,c@d] [--reply-mode send|draft] [--config <file.json>] | list <account-email> | disable <binding-id> | enable <binding-id> | unbind <binding-id> --yes", summary: "bind a cloud agent runtime to a mailbox — and disable it when it misbehaves" },
      { name: "token", synopsis: "admin token create <email> --name <n> --scopes <a,b,c> | list [<email>] | revoke <id>", summary: "mint operator/agent tokens for any account (--scopes required; only this command may mint `admin`)" },
      { name: "grant", synopsis: "admin grant create <grantee-email> <target-email> [--scopes read,contacts] [--book <id>] [--expires <days>] | list [<email>] | revoke <id>", summary: "cross-account delegation (effective rights = token ∩ grant)" },
    ],
    flags: [
      { flag: "--yes", desc: "confirm an irreversible verb (tenant/domain/account delete, agent unbind); nothing else needs it" },
      { flag: "--account <email>", desc: "on `agent disable|enable|unbind`, the binding's account — only needed if one binding id exists on more than one account" },
      { flag: "--include-deleted", desc: "on `account list`, also show tombstoned accounts (the forensic view; they are hidden by default)" },
    ],
    examples: [
      { cmd: 'bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token $ADMIN_TOKEN' },
      { cmd: 'bullmoose admin tenant create t_home --name "Home"' },
      { cmd: "bullmoose admin domain add example.com --tenant t_home" },
      { cmd: "bullmoose admin account create you@example.com --tenant t_home" },
      { cmd: "bullmoose admin agent bind editor@example.com --name editor --reply-mode draft --config docs/examples/editor-emily.config.json" },
      { cmd: "bullmoose admin agent disable bind_9f2c1a04", note: "the kill switch: no further invocations are enqueued or drained" },
      { cmd: "bullmoose admin agent list editor@example.com --ids | xargs -n1 bullmoose admin agent disable", note: "stop every agent on one mailbox" },
      { cmd: "bullmoose admin domain suspend exmaple.com", note: "mail bounces 550 immediately; `resume` puts it back, forwardTo and all" },
      { cmd: "bullmoose admin domain delete exmaple.com --dry-run", note: "the typo'd domain — check before you mean it" },
      { cmd: "bullmoose admin account delete t_home__a_3f2a1b9c --yes" },
      { cmd: "bullmoose admin token create hermes@example.com --name hermes-bridge --scopes read,send" },
      { cmd: "bullmoose admin grant create partner@example.com you@example.com --scopes read,contacts --book <bookId> --expires 365" },
    ],
    seeAlso: ["token", "agent"],
  },
];

// ─────────────────────────────── renderers ──────────────────────────────────

const findCommand = (name: string): Command | undefined => COMMANDS.find((c) => c.name === name);
export { findCommand };

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const indent = (s: string, by = "  ") => s.split("\n").map((l) => (l ? by + l : l)).join("\n");

export function renderOverview(): string {
  const out: string[] = [];
  out.push(`bullmoose — ${TAGLINE}`);
  out.push("");
  out.push("Usage:");
  out.push("  bullmoose <command> [options]");
  out.push("  bullmoose help <command>       verbose help, flags, and examples for one command");
  out.push("  bullmoose <command> --help     (same)");
  out.push("  bullmoose help --json          the full command spec, machine-readable (for agents)");
  out.push("");
  out.push("Commands:");
  for (const c of COMMANDS) out.push(`  ${pad(c.name, 12)} ${c.summary}`);
  out.push("");
  out.push("Global options:");
  for (const f of GLOBAL_OPTIONS) out.push(indent(wrapHanging(f.flag, f.desc, 22, 78)));
  out.push("");
  out.push("Exit codes:");
  for (const e of EXIT_CODES) out.push(`  ${e.code}  ${pad(e.meaning, 18)} ${e.when}`);
  out.push("");
  out.push(`Run \`bullmoose help <command>\` for details. ${NOTES[1]}`);
  return out.join("\n");
}

export function renderCommand(cmd: string | Command): string {
  const c = typeof cmd === "string" ? findCommand(cmd) : cmd;
  if (!c) return `unknown command: ${String(cmd)}\n\n${renderOverview()}`;
  const out: string[] = [];
  out.push(`bullmoose ${c.name} — ${c.summary}`);
  out.push("");
  out.push("SYNOPSIS");
  out.push(indent(c.synopsis));
  if (c.description) {
    out.push("");
    out.push("DESCRIPTION");
    out.push(indent(wrap(c.description, 76)));
  }
  if (c.subcommands?.length) {
    out.push("");
    out.push("SUBCOMMANDS");
    for (const s of c.subcommands) {
      out.push(indent(`${s.name} — ${s.summary}`));
      out.push(indent(s.synopsis, "      "));
    }
  }
  if (c.flags?.length) {
    out.push("");
    out.push("FLAGS");
    for (const f of c.flags) out.push(indent(`${pad(f.flag, 26)} ${f.desc}`));
  }
  if (c.examples?.length) {
    out.push("");
    out.push("EXAMPLES");
    for (const e of c.examples) {
      out.push(indent(`$ ${e.cmd}`));
      if (e.note) out.push(indent(e.note, "      "));
    }
  }
  if (c.seeAlso?.length) {
    out.push("");
    out.push(`SEE ALSO: ${c.seeAlso.map((s) => `bullmoose help ${s}`).join(", ")}`);
  }
  return out.join("\n");
}

export function helpJson(): string {
  return JSON.stringify(
    {
      name: "bullmoose",
      tagline: TAGLINE,
      notes: NOTES,
      globalOptions: GLOBAL_OPTIONS,
      exitCodes: EXIT_CODES,
      commands: COMMANDS,
    },
    null,
    2,
  );
}

/** `--flag   description`, wrapped with the description block hanging. */
function wrapHanging(label: string, desc: string, gutter: number, width: number): string {
  const body = wrap(desc, width - gutter).split("\n");
  const head = `${pad(label, gutter - 1)} ${body[0] ?? ""}`;
  return [head, ...body.slice(1).map((l) => " ".repeat(gutter) + l)].join("\n");
}

// ---- word wrap (shared by DESCRIPTION rendering) ----
function wrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// ---- roff man page ----
const roff = (s: string) => s.replace(/\\/g, "\\\\").replace(/-/g, "\\-").replace(/^([.'])/gm, "\\&$1");
export function renderMan(): string {
  const L: string[] = [];
  L.push(`.TH BULLMOOSE 1 "" "bullmoose" "User Commands"`);
  L.push(".SH NAME");
  L.push(`bullmoose \\- ${roff(TAGLINE)}`);
  L.push(".SH SYNOPSIS");
  L.push(".B bullmoose");
  L.push(".I command");
  L.push("[\\fIoptions\\fR]");
  L.push(".SH DESCRIPTION");
  for (const n of NOTES) {
    L.push(roff(n));
    L.push(".PP");
  }
  L.push(".SH COMMANDS");
  for (const c of COMMANDS) {
    L.push(".TP");
    L.push(`.B ${roff(c.name)}`);
    L.push(roff(c.summary));
  }
  L.push(".SH COMMAND DETAILS");
  for (const c of COMMANDS) {
    L.push(`.SS ${roff(c.name)}`);
    L.push(`.B Synopsis:`);
    L.push(".br");
    L.push(roff(c.synopsis));
    if (c.description) {
      L.push(".PP");
      L.push(roff(c.description));
    }
    if (c.subcommands?.length) {
      L.push(".PP");
      L.push(".B Subcommands:");
      for (const s of c.subcommands) {
        L.push(".TP");
        L.push(`.B ${roff(s.name)}`);
        L.push(`${roff(s.summary)} \\(em \\f[CR]${roff(s.synopsis)}\\fR`);
      }
    }
    if (c.flags?.length) {
      L.push(".PP");
      L.push(".B Flags:");
      for (const f of c.flags) {
        L.push(".TP");
        L.push(`.B ${roff(f.flag)}`);
        L.push(roff(f.desc));
      }
    }
    if (c.examples?.length) {
      L.push(".PP");
      L.push(".B Examples:");
      for (const e of c.examples) {
        L.push(".PP");
        L.push(`.EX`);
        L.push(roff(e.cmd));
        L.push(`.EE`);
        if (e.note) L.push(roff(e.note));
      }
    }
  }
  L.push(".SH GLOBAL OPTIONS");
  for (const f of GLOBAL_OPTIONS) {
    L.push(".TP");
    L.push(`.B ${roff(f.flag)}`);
    L.push(roff(f.desc));
  }
  L.push(".SH EXIT STATUS");
  for (const e of EXIT_CODES) {
    L.push(".TP");
    L.push(`.B ${e.code}`);
    L.push(roff(`${e.meaning} \u2014 ${e.when}`));
  }
  L.push(".SH FILES");
  L.push(".TP");
  L.push("~/.bullmoose/mail.db");
  L.push("Local SQLite message log (override with \\-\\-db or $BULLMOOSE_DB).");
  L.push(".SH SEE ALSO");
  L.push("Project docs: https://github.com/ericdmoore/bullmoose.cc");
  return L.join("\n") + "\n";
}

// ---- markdown reference (docs/cli.md) ----

/**
 * A literal `|` inside a table cell starts a new column, so `--expandMD
 * html|no` rendered as four cells in a two-column table
 * (`.feedback/fromClaude/cli/010` item 8). Escape it. Newlines would break the
 * row the same way, so they fold to spaces.
 */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export function renderMarkdown(): string {
  const M: string[] = [];
  M.push("# bullmoose CLI");
  M.push("");
  M.push(`> ${TAGLINE}`);
  M.push("");
  M.push("_Generated from the CLI's command spec (`packages/cli/src/help.ts`). Regenerate with `npm run -w @bullmoose/cli gen:docs`; do not edit by hand._");
  M.push("");
  for (const n of NOTES) M.push(`- ${n}`);
  M.push("");
  M.push("## Commands");
  M.push("");
  M.push("| command | what it does |");
  M.push("|---|---|");
  for (const c of COMMANDS) M.push(`| [\`${c.name}\`](#${c.name}) | ${cell(c.summary)} |`);
  M.push("");
  M.push("## Global options");
  M.push("");
  M.push("| flag | description |");
  M.push("|---|---|");
  for (const f of GLOBAL_OPTIONS) M.push(`| \`${cell(f.flag)}\` | ${cell(f.desc)} |`);
  M.push("");
  M.push("## Exit codes");
  M.push("");
  M.push("| code | meaning | when |");
  M.push("|---|---|---|");
  for (const e of EXIT_CODES) M.push(`| ${e.code} | ${cell(e.meaning)} | ${cell(e.when)} |`);
  M.push("");
  for (const c of COMMANDS) {
    M.push(`## ${c.name}`);
    M.push("");
    M.push(`${c.summary}`);
    M.push("");
    M.push("```");
    M.push(c.synopsis);
    M.push("```");
    if (c.description) {
      M.push("");
      M.push(c.description);
    }
    if (c.subcommands?.length) {
      M.push("");
      M.push("**Subcommands**");
      M.push("");
      for (const s of c.subcommands) M.push(`- **${s.name}** — ${s.summary}  \n  \`${s.synopsis}\``);
    }
    if (c.flags?.length) {
      M.push("");
      M.push("| flag | description |");
      M.push("|---|---|");
      for (const f of c.flags) M.push(`| \`${cell(f.flag)}\` | ${cell(f.desc)} |`);
    }
    if (c.examples?.length) {
      M.push("");
      M.push("**Examples**");
      M.push("");
      M.push("```sh");
      for (const e of c.examples) {
        M.push(e.cmd);
        if (e.note) M.push(`# ${e.note}`);
      }
      M.push("```");
    }
    if (c.seeAlso?.length) {
      M.push("");
      M.push(`See also: ${c.seeAlso.map((s) => `[\`${s}\`](#${s.split(" ")[0]})`).join(", ")}`);
    }
    M.push("");
  }
  return M.join("\n");
}
