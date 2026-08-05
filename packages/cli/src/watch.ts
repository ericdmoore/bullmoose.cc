import type { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
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
      if (opts.exec && event === "created") runHook(opts.exec, row, from);
    }
  }

  function runHook(template: string, row: WatchRow, from: string): void {
    const cmd = template
      .replaceAll("{id}", row.id)
      .replaceAll("{from}", shellSafe(from))
      .replaceAll("{subject}", shellSafe(row.subject))
      .replaceAll("{preview}", shellSafe(row.preview.slice(0, 120)));
    const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
    child.on("error", (err) => status(`--exec failed: ${err.message}`));
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

function shellSafe(s: string): string {
  return s.replaceAll(/[`$\\"']/g, "");
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
