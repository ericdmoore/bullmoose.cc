import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { marked } from "marked";
import {
  accountLabel,
  defaultDbPath,
  isFileUrl,
  loadBootstrap,
  matchAccounts,
  openDb,
  pickAccount,
  requireSettings,
  selectAccounts,
  setConfig,
} from "./db.js";
import {
  EXIT,
  conflict,
  die,
  emitIds,
  emitJson,
  emitNdjson,
  installEpipeGuard,
  failSetError,
  notFound,
  note,
  out,
  outRaw,
  readInput,
  usage,
  warn,
} from "./io.js";
import { JmapClient } from "./jmap.js";
import { sync, syncAll } from "./sync.js";
import { processAssets } from "./assets.js";
import { buildMime } from "./mime.js";
import { pidPaths, readAlivePid, watch, writePid } from "./watch.js";
import { cmdAdmin } from "./admin.js";
import { cmdLogin, cmdToken } from "./tokens.js";
import { agentServe, loadAgentConfig } from "./agent.js";
import { cmdAgentInvoke } from "./agentInvoke.js";
import { cmdContacts } from "./contacts.js";
import { cmdCreds } from "./creds.js";
import { cmdCalendar } from "./calendar.js";
import { cmdMailbox } from "./mailbox.js";
import { appendHtmlSignature, appendTextSignature, cmdIdentity, type JmapIdentity } from "./identity.js";
import { cmdBlobs, cmdShare } from "./blobs.js";
import { cmdTriage } from "./triage.js";
import { findCommand, helpJson, renderCommand, renderMan, renderMarkdown, renderOverview } from "./help.js";


// §1.2, and it has to be the FIRST thing that happens: every line below is a
// write to a pipe that a `| head` may already have closed. `.plans/s05-cli-crud/
// arch.md` calls this the highest-leverage line in the whole plan.
installEpipeGuard();

/**
 * Kept as a function so `parseArgs`'s inference still produces the exact flag
 * types; hoisting the options object out to a `const` collapses them to
 * `string | boolean`. It exists as a function at all so the call can sit
 * inside a try/catch — see below.
 */
const parseCommandLine = () =>
  parseArgs({
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
      from: { type: "string" },
      principal: { type: "string" },
      blobs: { type: "string" },
      mailbox: { type: "string" },
      parent: { type: "string" },
      sort: { type: "string" },
      force: { type: "boolean", default: false },
      // Confirmation for the irreversible `admin` verbs (admin.ts IRREVERSIBLE).
      // Distinct from --force, which on `mailbox rm` means
      // onDestroyRemoveEmails rather than "yes, I mean it".
      yes: { type: "boolean", default: false },
      "include-deleted": { type: "boolean", default: false },
      book: { type: "string" },
      to: { type: "string", multiple: true },
      cc: { type: "string", multiple: true },
      bcc: { type: "string", multiple: true },
      subject: { type: "string" },
      file: { type: "string" },
      body: { type: "string" },
      expandMD: { type: "string", default: "no" },
      linkMax: { type: "string", default: "4" },
      linkTTL: { type: "string", default: "30" },
      // ---- identity (sVOL 006) ----
      text: { type: "string" },
      html: { type: "string" },
      clear: { type: "boolean", default: false },
      "reply-to": { type: "string" },
      identity: { type: "string" },
      config: { type: "string" },
      once: { type: "boolean", default: false },
      // ---- agent invoke (sVOL 007) ----
      email: { type: "string" },
      note: { type: "string" },
      until: { type: "string" },
      expires: { type: "string" },
      kind: { type: "string" },
      secret: { type: "string" },
      "secret-env": { type: "string" },
      meta: { type: "string" },
      "authorize-url": { type: "string" },
      "token-url": { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      "oauth-scopes": { type: "string" },
      port: { type: "string" },
      days: { type: "string" },
      // ---- calendar CRUD (sVOL 018) ----
      title: { type: "string" },
      start: { type: "string" },
      duration: { type: "string" },
      tz: { type: "string" },
      "all-day": { type: "boolean", default: false },
      rrule: { type: "string" },
      calendar: { type: "string" },
      occurrence: { type: "string" },
      ics: { type: "boolean", default: false },
      sla: { type: "string" },
      allow: { type: "string" },
      "reply-mode": { type: "string" },
      raw: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      exec: { type: "string" },
      daemon: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      stop: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      // ---- the I/O contract's own flags (arch.md §1.4 / §1.7 / §1.8) ----
      ids: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "if-state": { type: "string" },
      as: { type: "string" },
      // ---- triage verbs (sVOL 019): flag/seen/move/label/archive/junk/trash/rm ----
      add: { type: "string", multiple: true },
      remove: { type: "string", multiple: true },
      role: { type: "string" },
      unset: { type: "boolean", default: false },
      "no-sync": { type: "boolean", default: false },
      n: { type: "string", short: "n", default: "20" },
      help: { type: "boolean", short: "h", default: false },
      man: { type: "boolean", default: false },
      markdown: { type: "boolean", default: false },
    },
  });

// parseArgs used to run bare at module scope, OUTSIDE the try/catch that
// formats every other error, so `bullmoose log --dry-run` answered with a raw
// ERR_PARSE_ARGS_UNKNOWN_OPTION and ten lines of Node internals
// (`.feedback/fromClaude/cli/010` item 2). An unknown flag is the textbook
// usage error: message on stderr, the overview on stderr, exit 2.
let parsed: ReturnType<typeof parseCommandLine>;
try {
  parsed = parseCommandLine();
} catch (err) {
  note(err instanceof Error ? err.message.split("\n")[0]! : String(err));
  note("");
  note(renderOverview());
  process.exit(EXIT.USAGE);
}
const opts = parsed.values;
const positionals = parsed.positionals;

const command = positionals[0];
if (command === "help" || opts.help || !command) {
  // `bullmoose help <cmd>` or `bullmoose <cmd> --help` → per-command help.
  // Help that was ASKED for is the requested data, so it goes to stdout;
  // help printed because the invocation was wrong is chrome, so it does not.
  const topic = command && command !== "help" ? command : positionals[1];
  if (opts.json) {
    outRaw(`${helpJson()}\n`);
    process.exit(EXIT.OK);
  }
  if (opts.man) {
    outRaw(renderMan());
    process.exit(EXIT.OK);
  }
  if (opts.markdown) {
    out(renderMarkdown());
    process.exit(EXIT.OK);
  }
  if (topic) {
    const c = findCommand(topic);
    if (!c) {
      note(`unknown command: ${topic}\n`);
      note(renderOverview());
      process.exit(EXIT.USAGE);
    }
    out(renderCommand(c));
    process.exit(EXIT.OK);
  }
  if (opts.help || command === "help") {
    out(renderOverview());
    process.exit(EXIT.OK);
  }
  note(renderOverview());
  process.exit(EXIT.USAGE);
}

/**
 * The contract flags, in the shape every command module takes. Threaded as one
 * object so adding a clause to `arch.md` §1 means touching this line and the
 * modules that honour it, not every call site in the switch below.
 */
const io = {
  json: opts.json ?? false,
  ids: opts.ids ?? false,
  dryRun: opts["dry-run"] ?? false,
  ifState: opts["if-state"],
  as: opts.as,
};

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
        scopes: opts.scopes,
        ...io,
      });
      break;
    case "discover":
      await cmdDiscover();
      break;
    case "token":
      await cmdToken(db, requireSettings(db), positionals.slice(1), {
        name: opts.name,
        scopes: opts.scopes,
        ...io,
      });
      break;
    case "sync":
      await cmdSync();
      break;
    case "accounts":
      cmdAccounts();
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
    case "vacation":
      await cmdVacation();
      break;
    case "agent":
      await cmdAgent();
      break;
    case "contacts":
      await cmdContacts(db, positionals.slice(1), {
        account: opts.account,
        book: opts.book,
        n: opts.n,
        force: opts.force ?? false,
        ...io,
      });
      break;
    case "calendar":
      await cmdCalendar(db, positionals.slice(1), {
        account: opts.account,
        days: opts.days,
        title: opts.title,
        start: opts.start,
        duration: opts.duration,
        tz: opts.tz,
        allDay: opts["all-day"],
        rrule: opts.rrule,
        calendar: opts.calendar,
        occurrence: opts.occurrence,
        ics: opts.ics,
        force: opts.force,
        ...io,
      });
      break;
    case "creds":
      await cmdCreds(db, positionals.slice(1), {
        url: opts.url,
        kind: opts.kind,
        secret: opts.secret,
        secretEnv: opts["secret-env"],
        meta: opts.meta,
        authorizeUrl: opts["authorize-url"],
        tokenUrl: opts["token-url"],
        clientId: opts["client-id"],
        clientSecret: opts["client-secret"],
        oauthScopes: opts["oauth-scopes"],
        port: opts.port,
        ...io,
      });
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
    case "mailbox":
      await cmdMailbox(db, positionals.slice(1), {
        account: opts.account,
        parent: opts.parent,
        sort: opts.sort,
        force: opts.force ?? false,
        ...io,
      });
      break;
    // ---- triage verbs (sVOL 019) ----
    case "flag":
    case "seen":
    case "move":
    case "label":
    case "archive":
    case "junk":
    case "trash":
    case "rm":
    case "delete":
      await cmdTriage(db, command, positionals.slice(1), {
        account: opts.account,
        add: opts.add,
        remove: opts.remove,
        role: opts.role,
        mailbox: opts.mailbox,
        force: opts.force ?? false,
        unset: opts.unset ?? false,
        noSync: opts["no-sync"] ?? false,
        ...io,
      });
      break;
    case "identity":
      await cmdIdentity(db, positionals.slice(1), {
        account: opts.account,
        name: opts.name,
        text: opts.text,
        html: opts.html,
        clear: opts.clear ?? false,
        "reply-to": opts["reply-to"],
        bcc: opts.bcc,
        ...io,
      });
      break;
    case "blobs":
      await cmdBlobs(db, positionals.slice(1), { account: opts.account, ...io });
      break;
    case "share":
      await cmdShare(db, positionals.slice(1), { account: opts.account, ...io });
      break;
    case "admin":
      await cmdAdmin(db, positionals.slice(1), {
        url: opts.url,
        token: opts.token,
        tenant: opts.tenant,
        name: opts.name,
        password: opts.password,
        scopes: opts.scopes,
        principal: opts.principal,
        sla: opts.sla,
        allow: opts.allow,
        replyMode: opts["reply-mode"],
        config: opts.config,
        book: opts.book,
        expires: opts.expires,
        account: opts.account,
        yes: opts.yes,
        includeDeleted: opts["include-deleted"],
        ...io,
      });
      break;
    default:
      note(`unknown command: ${command}\n`);
      note(renderOverview());
      process.exit(EXIT.USAGE);
  }
} catch (err) {
  // The single exit path. `die` maps the error to a code from the §1.5 table:
  // a JMAP error type first (so `stateMismatch` → 5 and `notFound` → 3), then
  // an HTTP status, then the CLI's own judgement, then 1.
  die(err);
}

// ---- commands ----------------------------------------------------------

async function cmdInit(): Promise<void> {
  // A file:// base is a bootstrap bundle; explicit flags win over it.
  // `--url` is accepted as an alias because it parses, is documented in
  // packages/cli/README.md, and used to be silently discarded — which failed
  // with "init requires --base" and no hint (.feedback/fromClaude/cli/010 §5).
  let base = opts.base ?? opts.url;
  let token = opts.token;
  let account = opts.account;
  if (isFileUrl(base)) {
    const boot = loadBootstrap(base);
    base = boot.base ?? boot.url;
    token = opts.token ?? boot.token;
    account = opts.account ?? boot.accountId;
  }
  if (!base || !token) usage("bullmoose init --base <url> --token <token>  (or a file:// bundle)");

  if (opts.offline) {
    // Store without touching the network — for prepping machines before
    // they have connectivity. Needs an explicit accountId (no discovery).
    if (!account) usage("--offline requires an accountId (flag or bootstrap file)");
    setConfig(db, "base", base);
    setConfig(db, "token", token);
    setConfig(db, "accountId", account);
    if (io.json) {
      emitJson({ base, accountId: account, validated: false });
      return;
    }
    out(`configured (offline, unvalidated): ${account} @ ${base}`);
    return;
  }

  const client = new JmapClient(base, token);
  const session = await client.session();

  const accountId = account ?? session.primaryAccounts["urn:ietf:params:jmap:mail"];
  if (!accountId || !session.accounts[accountId]) {
    notFound(
      `account ${accountId ?? "(none)"} not in session; available: ${Object.keys(session.accounts).join(", ")}`,
    );
  }

  const accounts = Object.entries(session.accounts).map(([id, a]) => ({
    accountId: id,
    name: (a as { name?: string }).name,
  }));
  setConfig(db, "base", base);
  setConfig(db, "token", token);
  setConfig(db, "accountId", accountId);
  setConfig(db, "accounts", JSON.stringify(accounts));
  if (io.json) {
    emitJson({ base, accountId, username: session.username, accounts, validated: true });
    return;
  }
  out(`configured: ${session.username} / ${accountId} @ ${base}`);
}

async function cmdSync(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);
  const accounts = selectAccounts(settings, opts.account);
  const results = await syncAll(db, client, accounts, { blobs: opts.blobs });
  let failures = 0;
  // Per-account lines are PROGRESS (arch.md §1.1 names it explicitly), so they
  // go to stderr; `--json` gives the same information as data on stdout.
  const records: Array<Record<string, unknown>> = [];
  for (const r of results) {
    const label = accountLabel(r.account).padEnd(28);
    if (r.clean) {
      records.push({ account: accountLabel(r.account), clean: true });
      note(`${label} clean (no changes)`);
    } else if (r.error) {
      records.push({ account: accountLabel(r.account), error: r.error });
      note(`${label} FAILED: ${r.error}`);
      failures++;
    } else if (r.stats) {
      records.push({ account: accountLabel(r.account), clean: false, ...r.stats });
      note(
        `${label} ${r.stats.mode} → state ${r.stats.newState}: ` +
          `+${r.stats.created} ~${r.stats.updated} -${r.stats.destroyed} ` +
          `(${r.stats.mailboxes} mailboxes)`,
      );
    }
  }
  if (io.json) emitNdjson(records);
  if (failures > 0) process.exit(EXIT.FAIL);
}

function cmdAccounts(): void {
  const settings = requireSettings(db);
  if (io.ids) {
    emitIds(settings.accounts.map((a) => a.accountId));
    return;
  }
  const rows = settings.accounts.map((a) => {
    const state = db
      .prepare("SELECT email_state, last_sync FROM sync_state WHERE account_id = ?")
      .get(a.accountId) as { email_state: string | null; last_sync: number | null } | undefined;
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM emails WHERE account_id = ?")
      .get(a.accountId) as { n: number };
    return {
      accountId: a.accountId,
      address: a.address ?? null,
      name: a.name ?? null,
      isDefault: a.accountId === settings.accountId,
      messages: count.n,
      state: state?.email_state ?? null,
      lastSync: state?.last_sync ? new Date(state.last_sync).toISOString() : null,
    };
  });
  if (io.json) {
    emitNdjson(rows);
    return;
  }
  for (const r of rows) {
    const synced = r.lastSync ? `synced ${r.lastSync.slice(0, 16).replace("T", " ")}` : "never synced";
    const label = r.address ?? r.name ?? r.accountId.slice(-8);
    out(
      `${r.isDefault ? "★" : " "} ${label.padEnd(28)} ${String(r.messages).padStart(6)} msgs  ` +
        `state=${r.state ?? "-"}  ${synced}  (${r.accountId})`,
    );
  }
}

// ---- send --------------------------------------------------------------

async function cmdSend(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);

  // --from selects both the sending ACCOUNT (by address) and, below, the
  // identity within it. Falls back to --account, then the default.
  //
  // Ambiguity is refused rather than resolved to [0]
  // (.feedback/fromClaude/cli/009): this is the send path, and silently
  // choosing a sender is the one outcome that cannot be undone. A --from that
  // matches NO account is not an error here, though — it may name an alias
  // identity inside the default account, and the identity lookup below is the
  // strict check for that.
  const fromAccounts = opts.from ? matchAccounts(settings, opts.from) : [];
  if (fromAccounts.length > 1) {
    usage(
      `--from "${opts.from}" matches ${fromAccounts.length} accounts; ` +
        `name the sending account with --account`,
    );
  }
  const sendAccount = fromAccounts[0]?.accountId ?? pickAccount(settings, opts.account).accountId;

  const to = splitAddresses(opts.to);
  const cc = splitAddresses(opts.cc);
  const bcc = splitAddresses(opts.bcc);
  if (to.length === 0) usage("send requires --to");
  const subject = opts.subject ?? "";
  const expand = opts.expandMD ?? "no";
  if (expand !== "no" && expand !== "html") {
    usage(`--expandMD must be "no" or "html" (got "${expand}")`);
  }

  const body = readBody();

  // Identity: --identity by id or email, else the first one.
  const idRes = await client.one("Identity/get", { accountId: sendAccount, ids: null });
  const identities = idRes.list as JmapIdentity[];
  // Same rule as --account: an explicit selector that matches nothing is an
  // error. Only the absence of a selector falls back to the first identity.
  const identity = opts.identity
    ? identities.find((i) => i.id === opts.identity || i.email === opts.identity)
    : opts.from
      ? identities.find((i) => i.email === opts.from)
      : identities[0];
  if (!identity) {
    notFound(
      `identity ${opts.identity ?? opts.from ?? "(default)"} not found; available: ${identities.map((i) => i.email).join(", ")}`,
    );
  }

  // The signature is applied HERE, in the client, where the MIME is built —
  // RFC 8621 §6.1 defines textSignature as "a signature the client SHOULD
  // insert", and this repo's write path leaves no honest alternative:
  // `EmailSubmission/set` hands the submit worker an already-imported blob id,
  // and the worker relays those exact R2 bytes to SES without ever parsing
  // MIME. Injecting a signature there would mean the message in Sent — the one
  // `Email/get` returns — is not the message the recipient received.
  const signedBody = appendTextSignature(body, identity.textSignature ?? "");

  // Role mailboxes for the draft → Sent dance.
  const mbRes = await client.one("Mailbox/get", { accountId: sendAccount, ids: null });
  const mailboxes = mbRes.list as Array<{ id: string; role: string | null }>;
  const draftsId = mailboxes.find((m) => m.role === "drafts")?.id;
  const sentId = mailboxes.find((m) => m.role === "sent")?.id;
  if (!draftsId || !sentId) notFound("account is missing a drafts/sent role mailbox");

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
        const { blobId } = await client.upload(sendAccount, file.content, file.type);
        const { url } = await client.createShareLink(sendAccount, blobId, {
          name: file.name,
          type: file.type,
          ttlSeconds,
        });
        return url;
      },
    });
    for (const w of assets.warnings) warn(w);

    const raw = buildMime({
      from: [{ ...(identity.name ? { name: identity.name } : {}), email: identity.email }],
      to,
      ...(cc.length > 0 ? { cc } : {}),
      subject,
      messageId: `${crypto.randomUUID()}@${identity.email.split("@")[1] ?? "localhost"}`,
      date: new Date(),
      // Both alternatives carry it, or the signature appears in one half of a
      // multipart/alternative and not the other, depending on which part the
      // recipient's client renders.
      text: appendTextSignature(assets.text, identity.textSignature ?? ""),
      html: appendHtmlSignature(
        assets.html,
        identity.htmlSignature ?? "",
        identity.textSignature ?? "",
      ),
      inline: assets.inline,
      attachments: assets.attachments,
    });

    const { blobId } = await client.upload(sendAccount, raw, "message/rfc822");
    const impRes = await client.one("Email/import", {
      accountId: sendAccount,
      emails: {
        d: { blobId, mailboxIds: { [draftsId]: true }, keywords: { $draft: true, $seen: true } },
      },
    });
    const imported = (impRes.created as Record<string, { id: string }> | undefined)?.d;
    if (!imported) failSetError("draft import", (impRes.notCreated as Record<string, unknown>)?.d);
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
      accountId: sendAccount,
      create: {
        d: {
          mailboxIds: { [draftsId]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ ...(identity.name ? { name: identity.name } : {}), email: identity.email }],
          to,
          ...(cc.length > 0 ? { cc } : {}),
          ...(bcc.length > 0 ? { bcc } : {}),
          subject,
          bodyValues: { t: { value: signedBody } },
          textBody: [{ partId: "t", type: "text/plain" }],
        },
      },
    });
    const draft = (setRes.created as Record<string, { id: string }> | undefined)?.d;
    if (!draft) failSetError("draft creation", (setRes.notCreated as Record<string, unknown>)?.d);
    draftId = draft.id;
  }

  // 2. Submit; on success the server moves it Drafts → Sent. The envelope
  // is explicit so bcc recipients (never written into the MIME) receive it.
  const rcptTo = [...to, ...cc, ...bcc].map((a) => ({ email: a.email }));
  const subRes = await client.one("EmailSubmission/set", {
    accountId: sendAccount,
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
  if (!submission) failSetError("submission", (subRes.notCreated as Record<string, unknown>)?.s);

  if (io.json) {
    emitJson({
      emailId: draftId,
      submissionId: submission.id,
      identity: identity.email,
      to: rcptTo.map((a) => a.email),
    });
  } else {
    out(
      `sent ${draftId} to ${rcptTo.map((a) => a.email).join(", ")} ` +
        `(submission ${submission.id}${extras})`,
    );
  }

  // Keep the local log current; best-effort.
  try {
    await sync(db, client, sendAccount);
  } catch {
    /* next \`bullmoose sync\` catches up */
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
  // arch.md §1.4, and the rule this command already stated: explicit flags beat
  // implicit stdin — a script with stdin redirected to /dev/null must still be
  // able to use --body. `--file -` is explicit stdin.
  if (opts.body !== undefined) return opts.body;
  return readInput(opts.file, { required: true, what: "body" })!.text;
}

// ---- vacation --------------------------------------------------------------

async function cmdVacation(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);
  const account = pickAccount(settings, opts.account);
  const verb = positionals[1];

  if (verb === "status" || !verb) {
    const res = await client.one("VacationResponse/get", { accountId: account.accountId });
    const v = (res.list as Array<Record<string, unknown>>)[0] ?? {};
    if (io.json) {
      emitJson({ account: accountLabel(account), ...v });
      return;
    }
    out(
      `${accountLabel(account)}: ${v.isEnabled ? "ON" : "off"}` +
        (v.subject ? `  subject: ${String(v.subject)}` : "") +
        (v.toDate ? `  until: ${String(v.toDate)}` : ""),
    );
    return;
  }
  if (verb !== "on" && verb !== "off") {
    usage("bullmoose vacation on|off|status [--subject s] [--body text] [--until date]");
  }

  const patch: Record<string, unknown> = { isEnabled: verb === "on" };
  if (opts.subject) patch.subject = opts.subject;
  if (opts.body) patch.textBody = opts.body;
  if (opts.until) patch.toDate = new Date(opts.until).toISOString();
  if (io.dryRun) {
    note(`dry run: would set vacation ${verb.toUpperCase()} for ${accountLabel(account)}`);
    if (io.json) emitJson({ dryRun: true, account: accountLabel(account), ...patch });
    return;
  }
  const res = await client.one("VacationResponse/set", {
    accountId: account.accountId,
    ...ifInState(),
    update: { singleton: patch },
  });
  if (io.json) {
    emitJson({ account: accountLabel(account), state: res.newState ?? null, ...patch });
    return;
  }
  out(`vacation ${verb === "on" ? "ON" : "off"} for ${accountLabel(account)}`);
}

// ---- agent -----------------------------------------------------------------

async function cmdAgent(): Promise<void> {
  const verb = positionals[1];
  // On-demand trigger (sVOL 007): a separate module + JMAP path from `serve`.
  if (verb === "invoke" || verb === "invocations" || verb === "rm") {
    await cmdAgentInvoke(db, positionals.slice(1), {
      account: opts.account,
      email: opts.email,
      note: opts.note,
      ...io,
    });
    return;
  }
  if (verb !== "serve") {
    usage("bullmoose agent serve --config <agent.json> [--once] | invoke <binding> --email <id> | invocations | rm <invId>");
  }
  if (!opts.config) usage("agent serve requires --config <agent.json>");
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);
  await agentServe(db, client, settings, loadAgentConfig(opts.config), { once: opts.once });
}

// ---- discover ------------------------------------------------------------

async function cmdDiscover(): Promise<void> {
  const { resolveJmapBase, probeSession } = await import("./discover.js");
  let target = positionals[1];
  if (!target) usage("bullmoose discover <email-or-domain>");
  if (!target.includes("@")) target = `probe@${target}`;

  const found = await resolveJmapBase(target);
  const probe = await probeSession(found.base);
  if (io.json) {
    emitJson({ domain: found.domain, via: found.via, base: found.base, ok: probe.ok, detail: probe.detail });
  } else {
    out(`domain:  ${found.domain}`);
    out(`method:  ${found.via === "fallback" ? "no SRV record — well-known fallback" : `SRV _jmap._tcp (${found.via})`}`);
    out(`base:    ${found.base}`);
    out(`session: ${probe.ok ? "✓" : "✗"} ${probe.detail}`);
  }
  process.exit(probe.ok ? EXIT.OK : EXIT.FAIL);
}

// ---- watch ---------------------------------------------------------------

async function cmdWatch(): Promise<void> {
  const dbPath = opts.db ?? defaultDbPath();
  const paths = pidPaths(dbPath);

  if (opts.stop) {
    const pid = readAlivePid(paths.pid);
    if (!pid) {
      note("no watcher running");
      return;
    }
    process.kill(pid, "SIGTERM");
    if (io.json) emitJson({ stopped: true, pid });
    else out(`stopped watcher (pid ${pid})`);
    return;
  }

  if (opts.status) {
    const pid = readAlivePid(paths.pid);
    if (io.json) {
      emitJson({ running: pid !== null, pid, log: paths.log });
      return;
    }
    if (pid) out(`watcher running (pid ${pid}, log: ${paths.log})`);
    else note("no watcher running");
    return;
  }

  const settings = requireSettings(db);
  const watchAccounts = selectAccounts(settings, opts.account);

  // A --daemon parent writes the child's pid before the child boots, so
  // the child finds its OWN pid here — that's us, not a rival watcher.
  const running = readAlivePid(paths.pid);
  if (running && running !== process.pid) {
    conflict(`watcher already running (pid ${running}) — bullmoose watch --stop first`);
  }

  if (opts.daemon) {
    // Re-exec ourselves detached, minus --daemon, with the db pinned.
    const { spawn } = await import("node:child_process");
    const { openSync } = await import("node:fs");
    const log = openSync(paths.log, "a", 0o600); // log lines carry senders/subjects
    const args = [process.argv[1] as string, "watch", "--db", dbPath];
    if (opts.json) args.push("--json");
    if (opts.exec) args.push("--exec", opts.exec);
    if (opts.account) args.push("--account", opts.account);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    writePid(paths.pid, child.pid as number);
    if (io.json) {
      emitJson({ daemon: true, pid: child.pid, log: paths.log });
    } else {
      out(`watch daemon started (pid ${child.pid}, log: ${paths.log})`);
      note("stop with: bullmoose watch --stop");
    }
    return;
  }

  // Foreground. If we were spawned by --daemon, our pid is already in the
  // pidfile; claim it for cleanup-on-exit either way.
  writePid(paths.pid, process.pid);
  const client = new JmapClient(settings.base, settings.token);
  await watch(db, client, watchAccounts, settings.base, settings.token, {
    json: opts.json ?? false,
    exec: opts.exec,
    pidFile: paths.pid,
  });
}

// ---- read --------------------------------------------------------------

async function cmdRead(): Promise<void> {
  const settings = requireSettings(db);
  const client = new JmapClient(settings.base, settings.token);

  // Which account? Explicit --account wins; a given id is looked up in the
  // local db to find its owner; otherwise the default account.
  let accountId = pickAccount(settings, opts.account).accountId;

  // Explicit id, else the most recent message — queried live so this
  // works without a prior sync.
  let id = positionals[1];
  if (id && !opts.account) {
    const owner = db.prepare(`SELECT account_id FROM emails WHERE id = ?`).get(id) as
      | { account_id: string }
      | undefined;
    if (owner) accountId = owner.account_id;
  }
  if (!id) {
    const q = await client.one("Email/query", {
      accountId,
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 1,
    });
    id = (q.ids as string[])[0];
    if (!id) notFound("mailbox is empty — nothing to read");
  }

  if (opts.raw) {
    const meta = await client.one("Email/get", {
      accountId,
      ids: [id],
      properties: ["blobId"],
    });
    const blobId = (meta.list as Array<{ blobId: string }>)[0]?.blobId;
    if (!blobId) notFound(`${id} not found`);
    outRaw(await client.downloadBlob(accountId, blobId));
    return;
  }

  const res = await client.one("Email/get", {
    accountId,
    ids: [id],
    properties: ["id", "from", "to", "cc", "subject", "receivedAt", "bodyValues", "textBody"],
    fetchTextBodyValues: true,
  });
  const email = (res.list as Array<Record<string, unknown>>)[0];
  if (!email) notFound(`${id} not found`);

  const bodyValues = (email.bodyValues ?? {}) as Record<string, { value?: string }>;
  const text = Object.values(bodyValues)[0]?.value ?? "(no text body)";

  if (io.ids) {
    emitIds([String(email.id ?? id)]);
    return;
  }
  if (io.json) {
    // §1.3: `show`-shaped commands emit exactly ONE object, one line.
    emitJson({ ...email, body: text, bodyValues: undefined });
    return;
  }
  out(`From:    ${formatAddrs(email.from)}`);
  out(`To:      ${formatAddrs(email.to)}`);
  const ccList = formatAddrs(email.cc);
  if (ccList) out(`Cc:      ${ccList}`);
  out(`Subject: ${String(email.subject ?? "")}`);
  out(`Date:    ${String(email.receivedAt)}`);
  out("");
  out(text);
}

function formatAddrs(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as Array<{ name?: string | null; email: string }>)
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
}

interface LogRow {
  id: string;
  account_id: string;
  subject: string;
  from_json: string;
  preview: string;
  received_at: number;
  seen: number;
  mailboxes: string | null;
}

function cmdLog(): void {
  const settings = requireSettings(db);
  const selected = selectAccounts(settings, opts.account);
  const limit = Number(opts.n) || 20;

  const accountMarks = selected.map(() => "?").join(",");
  let mailboxClause = "";
  const params: Array<string | number> = selected.map((a) => a.accountId);
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
      `SELECT e.id, e.account_id, e.subject, e.from_json, e.preview, e.received_at,
         EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
                 AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
         (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
            JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
          WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
       FROM emails e
       WHERE e.account_id IN (${accountMarks}) ${mailboxClause}
       ORDER BY e.received_at DESC LIMIT ?`,
    )
    .all(...params) as unknown as LogRow[];

  printRows(rows, selected.length > 1);
}

function cmdSearch(): void {
  const settings = requireSettings(db);
  const query = positionals.slice(1).join(" ");
  if (!query) usage("bullmoose search <fts5-query> [--account <sel>] [--json|--ids]");

  const selected = selectAccounts(settings, opts.account);
  const accountMarks = selected.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.id, e.account_id, e.subject, e.from_json, e.preview, e.received_at,
         EXISTS (SELECT 1 FROM email_keywords k WHERE k.account_id = e.account_id
                 AND k.email_id = e.id AND k.keyword = '$seen') AS seen,
         (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
            JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
          WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
       FROM cli_fts f JOIN emails e ON e.id = f.email_id
       WHERE e.account_id IN (${accountMarks}) AND cli_fts MATCH ?
       ORDER BY rank LIMIT 50`,
    )
    .all(...selected.map((a) => a.accountId), query) as unknown as LogRow[];

  printRows(rows, selected.length > 1);
}

async function cmdShow(): Promise<void> {
  const settings = requireSettings(db);
  const id = positionals[1];
  if (!id) usage("bullmoose show <emailId> [--json]");

  // `show` used to bind `account_id = settings.accountId` and ignore --account
  // entirely (.feedback/fromClaude/cli/009 §A). `log` fans out across every
  // account by default, so feeding it an id from a non-default account got
  // "not in local db (run: bullmoose sync)" — which was simply false. Resolve
  // the same way `read` does: look the id up across the accounts the selector
  // allows, then bind.
  const allowed = selectAccounts(settings, opts.account);
  const marks = allowed.map(() => "?").join(",");
  const row = db
    .prepare(`SELECT * FROM emails WHERE id = ? AND account_id IN (${marks})`)
    .get(id, ...allowed.map((a) => a.accountId)) as Record<string, unknown> | undefined;
  if (!row) {
    // Distinguish "no such id" from "that id belongs to an account you did not
    // select" — the second is a different mistake and deserves a different fix.
    const elsewhere = db.prepare(`SELECT account_id FROM emails WHERE id = ?`).get(id) as
      | { account_id: string }
      | undefined;
    if (elsewhere) {
      notFound(
        `${id} belongs to ${accountLabel(
          settings.accounts.find((a) => a.accountId === elsewhere.account_id) ?? {
            accountId: elsewhere.account_id,
          },
        )}, which --account "${opts.account}" did not select`,
      );
    }
    notFound(`${id} not in local db (run: bullmoose sync)`);
  }
  const accountId = String(row.account_id);

  // Body is fetched live — the local log stores metadata + preview.
  const client = new JmapClient(settings.base, settings.token);
  const res = await client.one("Email/get", {
    accountId,
    ids: [id],
    properties: ["bodyValues", "textBody"],
    fetchTextBodyValues: true,
  });
  const email = (res.list as Array<Record<string, unknown>>)[0];
  const bodyValues = (email?.bodyValues ?? {}) as Record<string, { value?: string }>;
  const text = Object.values(bodyValues)[0]?.value ?? "(no text body)";

  if (io.ids) {
    emitIds([id]);
    return;
  }
  if (io.json) {
    emitJson({ ...row, body: text });
    return;
  }
  const from = (JSON.parse(row.from_json as string) as Array<{ name?: string; email: string }>)
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
  out(`From:    ${from}`);
  out(`Subject: ${String(row.subject)}`);
  out(`Date:    ${new Date(row.received_at as number).toISOString()}`);
  out("");
  out(text);
}

function cmdMailboxes(): void {
  const settings = requireSettings(db);
  const selected = selectAccounts(settings, opts.account);
  const all: Array<Record<string, unknown>> = [];
  for (const account of selected) {
    const rows = db
      .prepare(
        `SELECT m.id, m.name, m.role,
           (SELECT COUNT(*) FROM email_mailboxes em
            WHERE em.account_id = m.account_id AND em.mailbox_id = m.id) AS total
         FROM mailboxes m WHERE m.account_id = ? ORDER BY m.sort_order, m.name`,
      )
      .all(account.accountId) as unknown as Array<{
      id: string;
      name: string;
      role: string | null;
      total: number;
    }>;
    if (io.json || io.ids) {
      all.push(...rows.map((r) => ({ ...r, account: accountLabel(account) })));
      continue;
    }
    // A `# account` banner is decoration, not a record: it would otherwise
    // land in the middle of a stream that `awk` is reading column-wise.
    if (selected.length > 1) note(`# ${accountLabel(account)}`);
    for (const r of rows) {
      out(`${(r.role ?? "-").padEnd(8)} ${String(r.total).padStart(5)}  ${r.name}  (${r.id})`);
    }
  }
  if (io.ids) emitIds(all.map((r) => String(r.id)));
  else if (io.json) emitNdjson(all);
}

function printRows(rows: LogRow[], showAccount = false): void {
  const settings = requireSettings(db);
  const labelFor = (id: string) =>
    accountLabel(settings.accounts.find((a) => a.accountId === id) ?? { accountId: id });
  // §1.8 first: --ids is the `| xargs` shape and outranks every other format.
  if (io.ids) {
    emitIds(rows.map((r) => r.id));
    return;
  }
  if (io.json) {
    // §1.3: one record per line, no wrapping array — so `| head -3` truncates
    // cleanly and `| jq -r .id` streams instead of buffering the whole page.
    emitNdjson(rows.map((r) => ({ ...r, from: JSON.parse(r.from_json), from_json: undefined })));
    return;
  }
  if (rows.length === 0) {
    // Not a record. `bullmoose log | wc -l` on an empty log must say 0.
    note("(no messages)");
    return;
  }
  for (const r of rows) {
    const from = (JSON.parse(r.from_json) as Array<{ name?: string; email: string }>)
      .map((a) => a.name ?? a.email)
      .join(", ");
    const date = new Date(r.received_at).toISOString().slice(0, 16).replace("T", " ");
    const unread = r.seen ? " " : "●";
    const acct = showAccount ? `${labelFor(r.account_id).padEnd(24).slice(0, 24)}  ` : "";
    out(
      `${unread} ${date}  ${acct}${from.padEnd(24).slice(0, 24)}  ${(r.subject || "(no subject)").slice(0, 48).padEnd(48)}  [${r.mailboxes ?? ""}]  ${r.id}`,
    );
  }
}

/**
 * §1.7 — `--if-state <state>` maps straight onto JMAP's `ifInState`, so a
 * scripted read-modify-write cannot silently clobber a concurrent change. The
 * server answers a mismatch with a method-level `stateMismatch`, which
 * `io.exitCodeFor` turns into exit 5, and nothing is written.
 *
 * `arch.md` made this invariant 6 and then no task in `s05/devPlan.md` owned
 * it; sVOL `016` picked it up. It is the one clause that cannot be retrofitted
 * cheaply, because it changes every write command's signature.
 */
function ifInState(): Record<string, string> {
  return io.ifState ? { ifInState: io.ifState } : {};
}
