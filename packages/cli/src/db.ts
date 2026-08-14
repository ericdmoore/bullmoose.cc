import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { EXIT, fail, notFound, usage } from "./io.js";

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
    fail(`invalid file:// URL: ${fileUrl}`, EXIT.USAGE);
  }
  if (!existsSync(path)) notFound(`bootstrap file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Bootstrap;
  } catch (err) {
    fail(
      `bootstrap file is not valid JSON: ${path} (${err instanceof Error ? err.message : err})`,
      EXIT.USAGE,
    );
  }
}

/**
 * Local mailstore: the SAME SQLite schema as the server's D1 data plane
 * (packages/mailstore/sql/data-plane.sql), so local queries are the same
 * SQL you'd run server-side. On top of it, three CLI-only tables:
 * config, sync_state, and a populated FTS index (packages/cli/sql/local.sql).
 *
 * Both halves are FILES rather than string literals because a second CLI now
 * creates the same mirror: `cli-go` embeds a copy of each at build time (a
 * static binary cannot read a repo file at runtime) and byte-compares the two
 * in `cli-go/internal/store/schema_test.go`. A literal here would have made
 * that check a regex over TypeScript source instead of a byte comparison.
 */

/** Same directory depth from src/ (dev, type-stripped) and dist/ (built). */
const schemaFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

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

  // Column migrations for PRE-EXISTING local mirrors: the schema file
  // only CREATEs, so columns added later must be ALTERed in before the
  // file runs (its indexes may reference them). Errors mean "already
  // there" — exactly what we want.
  for (const migration of ["ALTER TABLE contact_cards ADD COLUMN dav_name TEXT"]) {
    try {
      db.exec(migration);
    } catch {
      /* column already present, or table not created yet */
    }
  }

  db.exec(schemaFile("../../mailstore/sql/data-plane.sql"));
  db.exec(schemaFile("../sql/local.sql"));
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
    usage("not configured — run: bullmoose login <email>  (or init --base/--token)");
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
  const matches = matchAccounts(settings, selector);
  if (matches.length > 0) return matches;
  notFound(
    `no account matches "${selector}"; have: ` +
      settings.accounts.map((a) => a.address ?? a.accountId).join(", "),
  );
}

/**
 * `selectAccounts` without the refusal: an unmatched selector is `[]`.
 *
 * For the one caller where a miss is not a mistake — `send --from` names an
 * ADDRESS, which may be another account of this login *or* an alias identity
 * inside the default one. Making the account lookup fatal there would break
 * sending from an alias, so the strict check moves to the identity instead.
 */
export function matchAccounts(settings: Settings, selector?: string): AccountRef[] {
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
  return all.filter(
    (a) =>
      a.address?.includes(selector) ||
      a.name?.toLowerCase().includes(selector.toLowerCase()) ||
      a.accountId.includes(selector),
  );
}

/**
 * The single-account resolver. `.feedback/fromClaude/cli/009`: `selectAccounts`
 * matches by SUBSTRING and returns a set, and half the CLI then took `[0]`
 * silently while the other half refused. `send` was in the silent half — so
 * `--account @bullmoose.cc` on a multi-account login picked a sender by
 * enumeration order, and sending from the wrong identity is the one outcome you
 * cannot undo.
 *
 * The rule, stated in the help text: **a selector that matches more than one
 * account is an error, not a choice.** `selectAccounts` stays as it is — it is
 * correct for the commands that legitimately fan out (`log`, `sync`, `watch`) —
 * and this is the wrapper for everything that needs exactly one.
 *
 * No match → 3 (not found, via `selectAccounts`); ambiguous → 2 (usage).
 */
export function pickAccount(settings: Settings, selector?: string): AccountRef {
  if (!selector) {
    const dflt = settings.accounts.find((a) => a.accountId === settings.accountId);
    return dflt ?? { accountId: settings.accountId };
  }
  const matches = selectAccounts(settings, selector);
  if (matches.length > 1) {
    usage(
      `--account "${selector}" matches ${matches.length} accounts; name one of:\n` +
        matches.map((a) => `  ${a.address ?? a.accountId}`).join("\n"),
    );
  }
  return matches[0]!;
}

/** `pickAccount`, when only the id is wanted. */
export function pickAccountId(settings: Settings, selector?: string): string {
  return pickAccount(settings, selector).accountId;
}

/** Short human label for an account (log columns, watch lines). */
export function accountLabel(a: AccountRef): string {
  return a.address ?? a.name ?? a.accountId.slice(-8);
}
