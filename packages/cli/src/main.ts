import { parseArgs } from "node:util";
import { defaultDbPath, getConfig, openDb, requireSettings, setConfig } from "./db.js";
import { JmapClient } from "./jmap.js";
import { sync } from "./sync.js";

const HELP = `bullmoose — JMAP sync client with a local SQLite message log

Usage:
  bullmoose init --base <url> --token <token> [--account <id>]
  bullmoose sync [--blobs <dir>]
  bullmoose log [-n <count>] [--mailbox <role-or-id>] [--json]
  bullmoose search <fts5-query> [--json]
  bullmoose show <emailId> [--json]
  bullmoose mailboxes [--json]

Options:
  --db <path>   SQLite database path (default: $BULLMOOSE_DB or ~/.bullmoose/mail.db)

The database is the server's own data-plane schema — open it directly with
\`sqlite3\` for anything the commands don't cover.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    base: { type: "string" },
    token: { type: "string" },
    account: { type: "string" },
    blobs: { type: "string" },
    mailbox: { type: "string" },
    json: { type: "boolean", default: false },
    n: { type: "string", short: "n", default: "20" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];
if (opts.help || !command) {
  console.log(HELP);
  process.exit(command ? 0 : 1);
}

const db = openDb(opts.db ?? defaultDbPath());

try {
  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "sync":
      await cmdSync();
      break;
    case "log":
      cmdLog();
      break;
    case "search":
      cmdSearch();
      break;
    case "show":
      await cmdShow();
      break;
    case "mailboxes":
      cmdMailboxes();
      break;
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ---- commands ----------------------------------------------------------

async function cmdInit(): Promise<void> {
  if (!opts.base || !opts.token) {
    console.error("init requires --base and --token");
    process.exit(1);
  }
  const client = new JmapClient(opts.base, opts.token);
  const session = await client.session();

  const accountId =
    opts.account ?? session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId || !session.accounts[accountId]) {
    console.error(
      `account ${accountId ?? "(none)"} not in session; available: ${Object.keys(session.accounts).join(", ")}`,
    );
    process.exit(1);
  }

  setConfig(db, "base", opts.base);
  setConfig(db, "token", opts.token);
  setConfig(db, "accountId", accountId);
  console.log(`configured: ${session.username} / ${accountId} @ ${opts.base}`);
}

async function cmdSync(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);
  const stats = await sync(db, client, settings.accountId, { blobs: opts.blobs });
  console.log(
    `${stats.mode} sync → state ${stats.newState}: ` +
      `+${stats.created} ~${stats.updated} -${stats.destroyed} ` +
      `(${stats.mailboxes} mailboxes)`,
  );
}

interface LogRow {
  id: string;
  subject: string;
  from_json: string;
  preview: string;
  received_at: number;
  seen: number;
  mailboxes: string | null;
}

function cmdLog(): void {
  const settings = requireSettings(db);
  const limit = Number(opts.n) || 20;

  let mailboxClause = "";
  const params: Array<string | number> = [settings.accountId];
  if (opts.mailbox) {
    mailboxClause = `AND EXISTS (
      SELECT 1 FROM email_mailboxes em JOIN mailboxes m
        ON m.account_id = em.account_id AND m.id = em.mailbox_id
      WHERE em.account_id = e.account_id AND em.email_id = e.id
        AND (m.role = ? OR m.id = ?))`;
    params.push(opts.mailbox, opts.mailbox);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT e.id, e.subject, e.from_json, e.preview, e.received_at,
         EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
                 AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
         (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
            JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
          WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
       FROM emails e
       WHERE e.account_id = ? ${mailboxClause}
       ORDER BY e.received_at DESC LIMIT ?`,
    )
    .all(...params) as unknown as LogRow[];

  printRows(rows);
}

function cmdSearch(): void {
  const settings = requireSettings(db);
  const query = positionals.slice(1).join(" ");
  if (!query) {
    console.error("search requires a query");
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT e.id, e.subject, e.from_json, e.preview, e.received_at,
         EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
                 AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
         (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
            JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
          WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
       FROM cli_fts f JOIN emails e ON e.id = f.email_id
       WHERE e.account_id = ? AND cli_fts MATCH ?
       ORDER BY rank LIMIT 50`,
    )
    .all(settings.accountId, query) as unknown as LogRow[];

  printRows(rows);
}

async function cmdShow(): Promise<void> {
  const settings = requireSettings(db);
  const id = positionals[1];
  if (!id) {
    console.error("show requires an emailId");
    process.exit(1);
  }

  const row = db
    .prepare(`SELECT * FROM emails WHERE account_id = ? AND id = ?`)
    .get(settings.accountId, id) as Record<string, unknown> | undefined;
  if (!row) {
    console.error(`${id} not in local db (run: bullmoose sync)`);
    process.exit(1);
  }

  // Body is fetched live — the local log stores metadata + preview.
  const client = new JmapClient(settings.base, settings.token);
  const res = await client.one("Email/get", {
    accountId: settings.accountId,
    ids: [id],
    properties: ["bodyValues", "textBody"],
    fetchTextBodyValues: true,
  });
  const email = (res.list as Array<Record<string, unknown>>)[0];
  const bodyValues = (email?.bodyValues ?? {}) as Record<string, { value?: string }>;
  const text = Object.values(bodyValues)[0]?.value ?? "(no text body)";

  if (opts.json) {
    console.log(JSON.stringify({ ...row, body: text }, null, 2));
    return;
  }
  const from = (JSON.parse(row.from_json as string) as Array<{ name?: string; email: string }>)
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
  console.log(`From:    ${from}`);
  console.log(`Subject: ${row.subject}`);
  console.log(`Date:    ${new Date(row.received_at as number).toISOString()}`);
  console.log("");
  console.log(text);
}

function cmdMailboxes(): void {
  const settings = requireSettings(db);
  const rows = db
    .prepare(
      `SELECT m.id, m.name, m.role,
         (SELECT COUNT(*) FROM email_mailboxes em
          WHERE em.account_id = m.account_id AND em.mailbox_id = m.id) AS total
       FROM mailboxes m WHERE m.account_id = ? ORDER BY m.sort_order, m.name`,
    )
    .all(settings.accountId) as unknown as Array<{
    id: string;
    name: string;
    role: string | null;
    total: number;
  }>;

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    console.log(`${(r.role ?? "-").padEnd(8)} ${String(r.total).padStart(5)}  ${r.name}  (${r.id})`);
  }
}

function printRows(rows: LogRow[]): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({ ...r, from: JSON.parse(r.from_json), from_json: undefined })),
        null,
        2,
      ),
    );
    return;
  }
  if (rows.length === 0) {
    console.log("(no messages)");
    return;
  }
  for (const r of rows) {
    const from = (JSON.parse(r.from_json) as Array<{ name?: string; email: string }>)
      .map((a) => a.name ?? a.email)
      .join(", ");
    const date = new Date(r.received_at).toISOString().slice(0, 16).replace("T", " ");
    const unread = r.seen ? " " : "●";
    console.log(
      `${unread} ${date}  ${from.padEnd(24).slice(0, 24)}  ${(r.subject || "(no subject)").slice(0, 48).padEnd(48)}  [${r.mailboxes ?? ""}]  ${r.id}`,
    );
  }
}
