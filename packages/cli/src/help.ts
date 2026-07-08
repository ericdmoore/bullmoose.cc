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
  { flag: "--account <sel>", desc: "account selector: accountId, address, @domain-suffix, name substring, or 'default'" },
  { flag: "--json", desc: "machine-readable output where supported (and `help --json` dumps this whole spec)" },
  { flag: "-h, --help", desc: "show help; `bullmoose <cmd> --help` shows help for one command" },
];

export const NOTES = [
  "Auth model: login stretches your password locally and stores a bearer token; device/app tokens (bm_…) are minted with `token create` and used by clients (JMAP, CalDAV/CardDAV, POP3/SMTP). The login password is never stored or sent raw.",
  "The database is the server's own data-plane schema — open it directly with `sqlite3` for anything the commands don't cover.",
  "Operator commands (`admin …`) wrap the provision worker and use separate credentials from a mail account.",
];

export const COMMANDS: Command[] = [
  {
    name: "login",
    synopsis: "bullmoose login <email> [--base <url>] [--name <device-name>] [--password <pw>]",
    summary: "log in and store a bearer token for this account",
    description:
      "Authenticates to a JMAP server. With no --base, the server is autodiscovered from the email domain via the _jmap._tcp SRV record / .well-known/jmap fallback (RFC 8620 §2.2). The password comes from the prompt, $BULLMOOSE_PASSWORD, or --password; it is stretched locally, used once, and never stored or sent raw.",
    flags: [
      { flag: "--base <url>", desc: "JMAP server base; skip to autodiscover from the email domain" },
      { flag: "--name <device-name>", desc: "label the minted token (shows in `token list`)" },
      { flag: "--password <pw>", desc: "password (else prompt or $BULLMOOSE_PASSWORD)" },
    ],
    examples: [
      { cmd: "bullmoose login you@example.com", note: "autodiscover the server, prompt for password" },
      { cmd: "bullmoose login you@example.com --base https://jmap.example.com --name laptop" },
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
    synopsis: "bullmoose token create --name <n> [--scopes read,draft,send] | list | revoke <id>",
    summary: "mint / list / revoke device app-passwords for this account",
    description:
      "Device tokens (bm_…) are what clients authenticate with — never the login password. Scope them per device so a lost device can be revoked alone. Scope vocabulary: read, annotate, draft, move, send, delete, mail (all verbs), contacts, calendar.",
    subcommands: [
      { name: "create", synopsis: "token create --name <n> [--scopes read,draft,send]", summary: "mint a token (shown once)" },
      { name: "list", synopsis: "token list", summary: "list this account's tokens" },
      { name: "revoke", synopsis: "token revoke <id>", summary: "revoke one token by id" },
    ],
    examples: [
      { cmd: "bullmoose token create --name iphone --scopes mail,contacts,calendar" },
      { cmd: "bullmoose token create --name popper --scopes read,move", note: "POP3 via popcorn" },
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
      "Holds a JMAP push channel and prints each new message. --json emits NDJSON events; --exec runs a shell command per new message with {id} {from} {subject} {preview} placeholders; --daemon detaches (prints a PID; logs beside the db file).",
    flags: [
      { flag: "--json", desc: "emit NDJSON events" },
      { flag: "--exec <cmd>", desc: "run per message ({id} {from} {subject} {preview})" },
      { flag: "--daemon / --status / --stop", desc: "manage a detached watcher" },
    ],
    examples: [
      { cmd: "bullmoose watch" },
      { cmd: 'bullmoose watch --json --exec \'notify-send "{from}: {subject}"\'' },
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
    synopsis: "bullmoose agent serve --config <agent.json> [--once]",
    summary: "run the homelab agent runtime (claims the AgentInvocation queue)",
    description:
      "Logs in as the bound account, watches the AgentInvocation queue over the same push channel as `watch`, claims pending work, and drafts replies in template mode. Providers: mock | anthropic | openai-compatible; API keys by env reference, never in the config. --once drains and exits (cron-friendly). The config's `binding` must match the server-side binding name (see `admin agent bind`).",
    flags: [
      { flag: "--config <agent.json>", desc: "agent definition (binding, persona, model{provider,baseURL,apiKeyEnv})" },
      { flag: "--once", desc: "drain the queue once and exit" },
    ],
    examples: [
      { cmd: "bullmoose agent serve --config hermes.json" },
      { cmd: "bullmoose agent serve --config hermes.json --once", note: "cron drain" },
    ],
    seeAlso: ["admin agent bind", "watch"],
  },
  {
    name: "contacts",
    synopsis: "bullmoose contacts import <file.vcf> | list | show <cardId>",
    summary: "import and browse the contacts core (vCard ⇄ JSContact)",
    subcommands: [
      { name: "import", synopsis: "contacts import <file.vcf> [--book <name-or-id>] [--account <sel>]", summary: "seed from a vCard export (idempotent; dedup by uid; missing --book created)" },
      { name: "list", synopsis: "contacts list [--book <name-or-id>] [-n <count>] [--json]", summary: "list cards" },
      { name: "show", synopsis: "contacts show <cardId> [--json]", summary: "show one card" },
    ],
    examples: [
      { cmd: "bullmoose contacts import Contacts.vcf --book Personal", note: "export from macOS Contacts: File → Export → Export vCard…" },
      { cmd: "bullmoose contacts list --book Family -n 50" },
    ],
    seeAlso: ["calendar", "admin grant"],
  },
  {
    name: "calendar",
    synopsis: "bullmoose calendar list | agenda [--days <n>]",
    summary: "browse the calendar core (JSCalendar; recurrence expanded server-side)",
    subcommands: [
      { name: "list", synopsis: "calendar list [--json]", summary: "list calendars" },
      { name: "agenda", synopsis: "calendar agenda [--days <n>] [--json]", summary: "upcoming occurrences, recurrence-expanded" },
    ],
    examples: [{ cmd: "bullmoose calendar agenda --days 14" }],
    seeAlso: ["contacts"],
  },
  {
    name: "creds",
    synopsis: "bullmoose creds init | set <name> | list | rm <name> | oauth <name> …",
    summary: "manage the write-only, envelope-encrypted credential vault",
    description:
      "The vault stores third-party API keys and OAuth refresh tokens for agents. It is WRITE-ONLY — secrets go in and are never returned. `oauth` runs a browser + localhost PKCE flow and uploads only the refresh token.",
    subcommands: [
      { name: "init", synopsis: "creds init --url <agent-worker-url>", summary: "point the vault at the agent worker" },
      { name: "set", synopsis: "creds set <name> --kind api-key|oauth-refresh [--secret <s> | --secret-env VAR] [--meta k=v,…]", summary: "store a secret (else hidden prompt)" },
      { name: "list", synopsis: "creds list", summary: "list credential names (not values)" },
      { name: "rm", synopsis: "creds rm <name>", summary: "remove a credential" },
      { name: "oauth", synopsis: "creds oauth <name> --authorize-url <u> --token-url <u> --client-id <id> [--client-secret <s>] [--oauth-scopes \"a b\"]", summary: "PKCE flow; uploads only the refresh token" },
    ],
    examples: [
      { cmd: "bullmoose creds set openai --kind api-key --secret-env OPENAI_API_KEY" },
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
    examples: [{ cmd: "bullmoose log -n 50 --mailbox inbox" }],
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
    seeAlso: ["log"],
  },
  {
    name: "admin",
    synopsis: "bullmoose admin <noun> <verb> …",
    summary: "operator surface — wraps the provision worker (separate credentials)",
    description:
      "Onboarding and administration. `admin init` stores the provision URL + admin token; the rest manage tenants, domains, accounts, agent bindings, tokens, and grants. A tenant id (e.g. t_home) is a slug you choose — a namespace, not a secret.",
    subcommands: [
      { name: "init", synopsis: "admin init --url <provision-url> --token <admin-token>", summary: "configure the operator endpoint" },
      { name: "tenant", synopsis: "admin tenant create <id> --name <n> | list", summary: "manage tenants (namespaces)" },
      { name: "domain", synopsis: "admin domain add <domain> --tenant <t> | status <domain> | list", summary: "wire a domain (Email Routing, SES identity, DKIM/DMARC)" },
      { name: "account", synopsis: "admin account create <local@domain> --tenant <t> [--name <n>] [--principal <email>] | list [--tenant <t>]", summary: "create a mailbox account" },
      { name: "password", synopsis: "admin password <email>", summary: "set a principal's login password" },
      { name: "agent", synopsis: "admin agent bind <account-email> --name <binding> [--sla <s>] [--allow a@b,c@d] [--reply-mode send|draft] [--config <file.json>] | list <account-email>", summary: "bind a cloud agent runtime to a mailbox" },
      { name: "token", synopsis: "admin token create <email> --name <n> [--scopes …] | list [<email>] | revoke <id>", summary: "mint operator/agent tokens for any account" },
      { name: "grant", synopsis: "admin grant create <grantee-email> <target-email> [--scopes read,contacts] [--book <id>] [--expires <days>] | list [<email>] | revoke <id>", summary: "cross-account delegation (effective rights = token ∩ grant)" },
    ],
    examples: [
      { cmd: 'bullmoose admin init --url https://bullmoose-provision.<acct>.workers.dev --token $ADMIN_TOKEN' },
      { cmd: 'bullmoose admin tenant create t_home --name "Home"' },
      { cmd: "bullmoose admin domain add example.com --tenant t_home" },
      { cmd: "bullmoose admin account create you@example.com --tenant t_home" },
      { cmd: "bullmoose admin agent bind editor@example.com --name editor --reply-mode draft --config docs/examples/editor-emily.config.json" },
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
  for (const f of GLOBAL_OPTIONS) out.push(`  ${pad(f.flag, 18)} ${f.desc}`);
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
    { name: "bullmoose", tagline: TAGLINE, notes: NOTES, globalOptions: GLOBAL_OPTIONS, commands: COMMANDS },
    null,
    2,
  );
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
  L.push(".SH FILES");
  L.push(".TP");
  L.push("~/.bullmoose/mail.db");
  L.push("Local SQLite message log (override with \\-\\-db or $BULLMOOSE_DB).");
  L.push(".SH SEE ALSO");
  L.push("Project docs: https://github.com/ericdmoore/bullmoose.cc");
  return L.join("\n") + "\n";
}

// ---- markdown reference (docs/cli.md) ----
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
  for (const c of COMMANDS) M.push(`| [\`${c.name}\`](#${c.name}) | ${c.summary} |`);
  M.push("");
  M.push("## Global options");
  M.push("");
  M.push("| flag | description |");
  M.push("|---|---|");
  for (const f of GLOBAL_OPTIONS) M.push(`| \`${f.flag}\` | ${f.desc} |`);
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
      for (const f of c.flags) M.push(`| \`${f.flag}\` | ${f.desc} |`);
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
