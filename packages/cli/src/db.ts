import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Bootstrap file support: anywhere the CLI takes a server URL, a
 * `file://` URL is accepted instead — the file is a JSON connection
 * bundle written by an operator (e.g. minted alongside an admin token)
 * and carried to the device out-of-band:
 *
 *   { "base": "https://mail.bullmoose.cc",   // or "url" for admin
 *     "token": "bm_...",
 *     "accountId": "t_..__a_.." }             // optional
 *
 * Explicit CLI flags always win over file contents.
 */
export interface Bootstrap {
  base?: string;
  url?: string;
  token?: string;
  accountId?: string;
}

export function isFileUrl(value: string | undefined): value is string {
  return !!value && value.startsWith("file:");
}

export function loadBootstrap(fileUrl: string): Bootstrap {
  let path: string;
  try {
    path = fileURLToPath(fileUrl);
  } catch {
    console.error(`invalid file:// URL: ${fileUrl}`);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`bootstrap file not found: ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Bootstrap;
  } catch (err) {
    console.error(`bootstrap file is not valid JSON: ${path} (${err instanceof Error ? err.message : err})`);
    process.exit(1);
  }
}

/**
 * Local mailstore: the SAME SQLite schema as the server's D1 data plane
 * (packages/mailstore/sql/data-plane.sql), so local queries are the same
 * SQL you'd run server-side. On top of it, three CLI-only tables:
 * config, sync_state, and a populated FTS index.
 */

const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  account_id    TEXT PRIMARY KEY,
  email_state   TEXT,
  mailbox_state TEXT,
  last_sync     INTEGER
);
-- Unlike the server's placeholder FTS table, this one is populated at
-- sync time, so \`bullmoose search\` works offline.
CREATE VIRTUAL TABLE IF NOT EXISTS cli_fts USING fts5 (
  email_id UNINDEXED, subject, from_text, to_text, preview,
  tokenize='unicode61'
);
`;

export function defaultDbPath(): string {
  return process.env.BULLMOOSE_DB ?? join(homedir(), ".bullmoose", "mail.db");
}

export function openDb(path: string): DatabaseSync {
  // The db holds the bearer token AND the synced mailbox — owner-only,
  // both the directory and the file (plus WAL sidecars once created).
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const preexisting = existsSync(path);
  const db = new DatabaseSync(path);
  if (!preexisting) {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(p, 0o600);
      } catch {
        /* sidecar may not exist yet */
      }
    }
  }
  db.exec("PRAGMA journal_mode = WAL");

  // Same directory depth from src/ (dev, type-stripped) and dist/ (built).
  const dataPlane = fileURLToPath(
    new URL("../../mailstore/sql/data-plane.sql", import.meta.url),
  );
  db.exec(readFileSync(dataPlane, "utf8"));
  db.exec(LOCAL_SCHEMA);
  return db;
}

export function getConfig(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

export interface AccountRef {
  accountId: string;
  tenantId?: string;
  name?: string;
  /** Primary email address (from login discovery); selection key. */
  address?: string;
}

export interface Settings {
  base: string;
  token: string;
  /** Default account (send/read targets when unspecified). */
  accountId: string;
  /** Every account this login can see. */
  accounts: AccountRef[];
}

export function requireSettings(db: DatabaseSync): Settings {
  const base = getConfig(db, "base");
  const token = getConfig(db, "token");
  const accountId = getConfig(db, "accountId");
  if (!base || !token || !accountId) {
    console.error("Not configured. Run: bullmoose login <email>  (or init --base/--token)");
    process.exit(1);
  }
  let accounts: AccountRef[] = [];
  try {
    accounts = JSON.parse(getConfig(db, "accounts") ?? "[]") as AccountRef[];
  } catch {
    /* legacy config */
  }
  if (accounts.length === 0) accounts = [{ accountId }];
  return { base, token, accountId, accounts };
}

/**
 * Resolve an --account selector to a set of accounts. Matching, in order:
 * undefined → all; "default" → the default; exact accountId; exact
 * address; "@suffix" → address domain suffix; else substring of
 * address/name/id.
 */
export function selectAccounts(settings: Settings, selector?: string): AccountRef[] {
  const all = settings.accounts;
  if (!selector) return all;
  if (selector === "default") {
    return all.filter((a) => a.accountId === settings.accountId);
  }
  const exact = all.filter((a) => a.accountId === selector || a.address === selector);
  if (exact.length > 0) return exact;
  if (selector.startsWith("@")) {
    const bySuffix = all.filter((a) => a.address?.endsWith(selector));
    if (bySuffix.length > 0) return bySuffix;
  }
  const fuzzy = all.filter(
    (a) =>
      a.address?.includes(selector) ||
      a.name?.toLowerCase().includes(selector.toLowerCase()) ||
      a.accountId.includes(selector),
  );
  if (fuzzy.length > 0) return fuzzy;
  console.error(
    `no account matches "${selector}"; have: ${all.map((a) => a.address ?? a.accountId).join(", ")}`,
  );
  process.exit(1);
}

/** Short human label for an account (log columns, watch lines). */
export function accountLabel(a: AccountRef): string {
  return a.address ?? a.name ?? a.accountId.slice(-8);
}
