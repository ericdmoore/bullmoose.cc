import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { marked } from "marked";
import {
  defaultDbPath,
  getConfig,
  isFileUrl,
  loadBootstrap,
  openDb,
  requireSettings,
  setConfig,
} from "./db.js";
import { JmapClient } from "./jmap.js";
import { sync } from "./sync.js";
import { processAssets } from "./assets.js";
import { buildMime } from "./mime.js";
import { pidPaths, readAlivePid, watch, writePid } from "./watch.js";
import { cmdAdmin } from "./admin.js";
import { cmdLogin, cmdToken } from "./tokens.js";

const HELP = `bullmoose — JMAP sync client with a local SQLite message log

Usage:
  bullmoose login <email> --base <url> [--name <device-name>]
                 (password via prompt, $BULLMOOSE_PASSWORD, or --password;
                  used once to mint this device's token — never stored)
  bullmoose init --base <url> --token <token> [--account <id>] [--offline]
                 (paste an existing token instead of logging in; --base
                  also accepts file:///path/to/bundle.json — a JSON
                  {base, token, accountId} bootstrap written by an
                  operator; --offline stores it without validating)
  bullmoose token create --name <n> [--scopes read,draft] | list | revoke <id>
  bullmoose sync [--blobs <dir>]
  bullmoose send --to <addr>[,<addr>] --subject <s> [--cc ..] [--bcc ..]
                 [--expandMD no|html] [--file <path>] [--body <text>]
                 [--identity <id-or-email>] [--linkMax <MiB>] [--linkTTL <days>]
                 (body from --file, else --body, else piped stdin)
  bullmoose read [emailId] [--raw] [--json]
                 (no id → most recent message)
  bullmoose watch [--json] [--exec <cmd>] [--daemon | --status | --stop]
                 push-triggered live sync: prints new mail as it arrives.
                 --json emits NDJSON events; --exec runs a shell command per
                 new message ({id} {from} {subject} {preview} placeholders);
                 --daemon detaches (prints PID; logs beside the db file)
  bullmoose log [-n <count>] [--mailbox <role-or-id>] [--json]
  bullmoose search <fts5-query> [--json]
  bullmoose show <emailId> [--json]
  bullmoose mailboxes [--json]
  bullmoose admin init --url <provision-url> --token <admin-token>
  bullmoose admin tenant  create <id> --name <n> | list
  bullmoose admin domain  add <domain> --tenant <t> | status <domain> | list
  bullmoose admin account create <local@domain> --tenant <t> [--name <n>] | list [--tenant <t>]
  bullmoose admin password <email>            set a principal's login password
  bullmoose admin token   create <email> --name <n> [--scopes read,draft,send]
                          | list [<email>] | revoke <id>    (agent/operator tokens)
                 (operator surface — wraps the provision worker; separate
                 credentials from the mail account. Planned nouns: route,
                 identity, policy, share, suppression, token, agent)

Options:
  --db <path>        SQLite database path (default: $BULLMOOSE_DB or ~/.bullmoose/mail.db)
  --expandMD html    treat the body as Markdown: rendered HTML becomes the
                     displayed body (raw Markdown rides along as the hidden
                     plain-text fallback). Local references are resolved
                     relative to --file's directory (or cwd for stdin):
                       images       → inlined as cid: parts
                       linked files → attached, link annotated
                       either, over --linkMax → uploaded to R2 and rewritten
                         to a signed link expiring after --linkTTL days
  --expandMD no      send the body as plain text as-is (default)
  --linkMax <MiB>    big-file threshold (default 4)
  --linkTTL <days>   share-link lifetime (default 30)

The database is the server's own data-plane schema — open it directly with
\`sqlite3\` for anything the commands don't cover.`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    base: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    tenant: { type: "string" },
    name: { type: "string" },
    password: { type: "string" },
    scopes: { type: "string" },
    account: { type: "string" },
    blobs: { type: "string" },
    mailbox: { type: "string" },
    to: { type: "string", multiple: true },
    cc: { type: "string", multiple: true },
    bcc: { type: "string", multiple: true },
    subject: { type: "string" },
    file: { type: "string" },
    body: { type: "string" },
    expandMD: { type: "string", default: "no" },
    linkMax: { type: "string", default: "4" },
    linkTTL: { type: "string", default: "30" },
    identity: { type: "string" },
    raw: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    exec: { type: "string" },
    daemon: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    stop: { type: "boolean", default: false },
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
    case "login":
      await cmdLogin(db, positionals[1], {
        base: opts.base,
        password: opts.password,
        name: opts.name,
        json: opts.json ?? false,
      });
      break;
    case "token":
      await cmdToken(db, requireSettings(db), positionals.slice(1), {
        name: opts.name,
        scopes: opts.scopes,
        json: opts.json ?? false,
      });
      break;
    case "sync":
      await cmdSync();
      break;
    case "send":
      await cmdSend();
      break;
    case "read":
      await cmdRead();
      break;
    case "watch":
      await cmdWatch();
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
    case "admin":
      await cmdAdmin(db, positionals.slice(1), {
        url: opts.url,
        token: opts.token,
        tenant: opts.tenant,
        name: opts.name,
        password: opts.password,
        scopes: opts.scopes,
        json: opts.json ?? false,
      });
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
  // A file:// base is a bootstrap bundle; explicit flags win over it.
  let base = opts.base;
  let token = opts.token;
  let account = opts.account;
  if (isFileUrl(base)) {
    const boot = loadBootstrap(base);
    base = boot.base ?? boot.url;
    token = opts.token ?? boot.token;
    account = opts.account ?? boot.accountId;
  }
  if (!base || !token) {
    console.error("init requires --base and --token (flags or bootstrap file)");
    process.exit(1);
  }

  if (opts.offline) {
    // Store without touching the network — for prepping machines before
    // they have connectivity. Needs an explicit accountId (no discovery).
    if (!account) {
      console.error("--offline requires an accountId (flag or bootstrap file)");
      process.exit(1);
    }
    setConfig(db, "base", base);
    setConfig(db, "token", token);
    setConfig(db, "accountId", account);
    console.log(`configured (offline, unvalidated): ${account} @ ${base}`);
    return;
  }

  const client = new JmapClient(base, token);
  const session = await client.session();

  const accountId = account ?? session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId || !session.accounts[accountId]) {
    console.error(
      `account ${accountId ?? "(none)"} not in session; available: ${Object.keys(session.accounts).join(", ")}`,
    );
    process.exit(1);
  }

  setConfig(db, "base", base);
  setConfig(db, "token", token);
  setConfig(db, "accountId", accountId);
  console.log(`configured: ${session.username} / ${accountId} @ ${base}`);
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

// ---- send --------------------------------------------------------------

async function cmdSend(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);

  const to = splitAddresses(opts.to);
  const cc = splitAddresses(opts.cc);
  const bcc = splitAddresses(opts.bcc);
  if (to.length === 0) {
    console.error("send requires --to");
    process.exit(1);
  }
  const subject = opts.subject ?? "";
  const expand = opts.expandMD ?? "no";
  if (expand !== "no" && expand !== "html") {
    console.error(`--expandMD must be "no" or "html" (got "${expand}")`);
    process.exit(1);
  }

  const body = readBody();

  // Identity: --identity by id or email, else the first one.
  const idRes = await client.one("Identity/get", { accountId: settings.accountId, ids: null });
  const identities = idRes.list as Array<{ id: string; email: string; name: string }>;
  const identity = opts.identity
    ? identities.find((i) => i.id === opts.identity || i.email === opts.identity)
    : identities[0];
  if (!identity) {
    console.error(
      `identity ${opts.identity ?? "(default)"} not found; available: ${identities.map((i) => i.email).join(", ")}`,
    );
    process.exit(1);
  }

  // Role mailboxes for the draft → Sent dance.
  const mbRes = await client.one("Mailbox/get", { accountId: settings.accountId, ids: null });
  const mailboxes = mbRes.list as Array<{ id: string; role: string | null }>;
  const draftsId = mailboxes.find((m) => m.role === "drafts")?.id;
  const sentId = mailboxes.find((m) => m.role === "sent")?.id;
  if (!draftsId || !sentId) {
    console.error("account is missing a drafts/sent role mailbox");
    process.exit(1);
  }

  // 1. Create the draft.
  let draftId: string;
  let extras = "";

  if (expand === "html") {
    // Markdown mode: render, resolve local assets, build the MIME locally
    // (cid inline images / attachments / expiring big-file links need
    // multipart/related+mixed), then upload → Email/import into Drafts.
    const baseDir = opts.file ? dirname(resolve(opts.file)) : process.cwd();
    const linkMaxBytes = Math.max(0.1, Number(opts.linkMax) || 4) * 1024 * 1024;
    const ttlSeconds = Math.max(1, Number(opts.linkTTL) || 30) * 24 * 3600;

    const rendered = marked.parse(body, { async: false });
    const assets = await processAssets(body, rendered, baseDir, {
      linkMaxBytes,
      share: async (file) => {
        const { blobId } = await client.upload(settings.accountId, file.content, file.type);
        const { url } = await client.createShareLink(settings.accountId, blobId, {
          name: file.name,
          type: file.type,
          ttlSeconds,
        });
        return url;
      },
    });
    for (const w of assets.warnings) console.error(`warning: ${w}`);

    const raw = buildMime({
      from: [{ ...(identity.name ? { name: identity.name } : {}), email: identity.email }],
      to,
      ...(cc.length > 0 ? { cc } : {}),
      subject,
      messageId: `${crypto.randomUUID()}@${identity.email.split("@")[1] ?? "localhost"}`,
      date: new Date(),
      text: assets.text,
      html: assets.html,
      inline: assets.inline,
      attachments: assets.attachments,
    });

    const { blobId } = await client.upload(settings.accountId, raw, "message/rfc822");
    const impRes = await client.one("Email/import", {
      accountId: settings.accountId,
      emails: {
        d: { blobId, mailboxIds: { [draftsId]: true }, keywords: { $draft: true, $seen: true } },
      },
    });
    const imported = (impRes.created as Record<string, { id: string }> | undefined)?.d;
    if (!imported) {
      console.error(`draft import failed: ${JSON.stringify(impRes.notCreated)}`);
      process.exit(1);
    }
    draftId = imported.id;

    const bits = ["markdown→html"];
    if (assets.inline.length > 0) bits.push(`${assets.inline.length} inlined`);
    if (assets.attachments.length > 0) bits.push(`${assets.attachments.length} attached`);
    if (assets.linked.length > 0) {
      bits.push(`${assets.linked.length} linked (expires in ${opts.linkTTL}d)`);
    }
    extras = `, ${bits.join(", ")}`;
  } else {
    // Plain text: the server builds the MIME from bodyValues.
    const setRes = await client.one("Email/set", {
      accountId: settings.accountId,
      create: {
        d: {
          mailboxIds: { [draftsId]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ ...(identity.name ? { name: identity.name } : {}), email: identity.email }],
          to,
          ...(cc.length > 0 ? { cc } : {}),
          ...(bcc.length > 0 ? { bcc } : {}),
          subject,
          bodyValues: { t: { value: body } },
          textBody: [{ partId: "t", type: "text/plain" }],
        },
      },
    });
    const draft = (setRes.created as Record<string, { id: string }> | undefined)?.d;
    if (!draft) {
      console.error(`draft creation failed: ${JSON.stringify(setRes.notCreated)}`);
      process.exit(1);
    }
    draftId = draft.id;
  }

  // 2. Submit; on success the server moves it Drafts → Sent. The envelope
  // is explicit so bcc recipients (never written into the MIME) receive it.
  const rcptTo = [...to, ...cc, ...bcc].map((a) => ({ email: a.email }));
  const subRes = await client.one("EmailSubmission/set", {
    accountId: settings.accountId,
    create: {
      s: {
        emailId: draftId,
        identityId: identity.id,
        envelope: { mailFrom: { email: identity.email }, rcptTo },
      },
    },
    onSuccessUpdateEmail: {
      "#s": {
        [`mailboxIds/${draftsId}`]: null,
        [`mailboxIds/${sentId}`]: true,
        "keywords/$draft": null,
      },
    },
  });
  const submission = (subRes.created as Record<string, { id: string }> | undefined)?.s;
  if (!submission) {
    console.error(`submission failed: ${JSON.stringify(subRes.notCreated)}`);
    process.exit(1);
  }

  console.log(
    `sent ${draftId} to ${rcptTo.map((a) => a.email).join(", ")} ` +
      `(submission ${submission.id}${extras})`,
  );

  // Keep the local log current; best-effort.
  try {
    await sync(db, client, settings.accountId);
  } catch {
    /* next `bullmoose sync` catches up */
  }
}

function splitAddresses(values: string[] | undefined): Array<{ email: string }> {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

function readBody(): string {
  // Explicit flags beat implicit stdin — a script with stdin redirected
  // to /dev/null must still be able to use --body.
  if (opts.file) return readFileSync(opts.file, "utf8");
  if (opts.body !== undefined) return opts.body;
  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, "utf8");
    if (piped.length > 0) return piped;
  }
  console.error("no body: pipe stdin, or pass --file/--body");
  process.exit(1);
}

// ---- watch ---------------------------------------------------------------

async function cmdWatch(): Promise<void> {
  const dbPath = opts.db ?? defaultDbPath();
  const paths = pidPaths(dbPath);

  if (opts.stop) {
    const pid = readAlivePid(paths.pid);
    if (!pid) {
      console.log("no watcher running");
      return;
    }
    process.kill(pid, "SIGTERM");
    console.log(`stopped watcher (pid ${pid})`);
    return;
  }

  if (opts.status) {
    const pid = readAlivePid(paths.pid);
    console.log(pid ? `watcher running (pid ${pid}, log: ${paths.log})` : "no watcher running");
    return;
  }

  const settings = requireSettings(db);
  if (opts.account && opts.account !== settings.accountId) {
    console.error(`only the configured account (${settings.accountId}) is supported until multi-account lands`);
    process.exit(1);
  }

  // A --daemon parent writes the child's pid before the child boots, so
  // the child finds its OWN pid here — that's us, not a rival watcher.
  const running = readAlivePid(paths.pid);
  if (running && running !== process.pid) {
    console.error(`watcher already running (pid ${running}) — bullmoose watch --stop first`);
    process.exit(1);
  }

  if (opts.daemon) {
    // Re-exec ourselves detached, minus --daemon, with the db pinned.
    const { spawn } = await import("node:child_process");
    const { openSync } = await import("node:fs");
    const log = openSync(paths.log, "a", 0o600); // log lines carry senders/subjects
    const args = [process.argv[1] as string, "watch", "--db", dbPath];
    if (opts.json) args.push("--json");
    if (opts.exec) args.push("--exec", opts.exec);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    writePid(paths.pid, child.pid as number);
    console.log(`watch daemon started (pid ${child.pid}, log: ${paths.log})`);
    console.log(`stop with: bullmoose watch --stop`);
    return;
  }

  // Foreground. If we were spawned by --daemon, our pid is already in the
  // pidfile; claim it for cleanup-on-exit either way.
  writePid(paths.pid, process.pid);
  const client = new JmapClient(settings.base, settings.token);
  await watch(db, client, settings.accountId, settings.base, settings.token, {
    json: opts.json ?? false,
    exec: opts.exec,
    pidFile: paths.pid,
  });
}

// ---- read --------------------------------------------------------------

async function cmdRead(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);

  // Explicit id, else the most recent message — queried live so this
  // works without a prior sync.
  let id = positionals[1];
  if (!id) {
    const q = await client.one("Email/query", {
      accountId: settings.accountId,
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 1,
    });
    id = (q.ids as string[])[0];
    if (!id) {
      console.error("(mailbox is empty)");
      process.exit(1);
    }
  }

  if (opts.raw) {
    const meta = await client.one("Email/get", {
      accountId: settings.accountId,
      ids: [id],
      properties: ["blobId"],
    });
    const blobId = (meta.list as Array<{ blobId: string }>)[0]?.blobId;
    if (!blobId) {
      console.error(`${id} not found`);
      process.exit(1);
    }
    process.stdout.write(await client.downloadBlob(settings.accountId, blobId));
    return;
  }

  const res = await client.one("Email/get", {
    accountId: settings.accountId,
    ids: [id],
    properties: ["id", "from", "to", "cc", "subject", "receivedAt", "bodyValues", "textBody"],
    fetchTextBodyValues: true,
  });
  const email = (res.list as Array<Record<string, unknown>>)[0];
  if (!email) {
    console.error(`${id} not found`);
    process.exit(1);
  }

  const bodyValues = (email.bodyValues ?? {}) as Record<string, { value?: string }>;
  const text = Object.values(bodyValues)[0]?.value ?? "(no text body)";

  if (opts.json) {
    console.log(JSON.stringify({ ...email, body: text, bodyValues: undefined }, null, 2));
    return;
  }
  console.log(`From:    ${formatAddrs(email.from)}`);
  console.log(`To:      ${formatAddrs(email.to)}`);
  const ccList = formatAddrs(email.cc);
  if (ccList) console.log(`Cc:      ${ccList}`);
  console.log(`Subject: ${email.subject ?? ""}`);
  console.log(`Date:    ${email.receivedAt}`);
  console.log("");
  console.log(text);
}

function formatAddrs(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as Array<{ name?: string | null; email: string }>)
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
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
