import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface Settings {
  base: string;
  token: string;
  accountId: string;
}

export function requireSettings(db: DatabaseSync): Settings {
  const base = getConfig(db, "base");
  const token = getConfig(db, "token");
  const accountId = getConfig(db, "accountId");
  if (!base || !token || !accountId) {
    console.error("Not configured. Run: bullmoose init --base <url> --token <token>");
    process.exit(1);
  }
  return { base, token, accountId };
}
