import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/**
 * A `D1Database` backed by an in-memory `node:sqlite`, seeded from the SAME
 * `.sql` files wrangler applies.
 *
 * This replaces five hand-rolled substring-routing fakes (mcp.test.ts,
 * authRoutes.test.ts, mintScopes.test.ts, submission.test.ts,
 * calendars.test.ts). Those routed a query to a fixture by matching a literal
 * fragment of the production SQL, which has three problems worth naming
 * because they are the reason this exists:
 *
 *  1. A catch-all branch answers any *unmatched* query with some fixture, so a
 *     test passes while the code under test reads the wrong table.
 *  2. `run()` pushes to an array that `all()` never consults, so a write
 *     followed by a read is not modelled at all. Round-trip assertions were
 *     impossible.
 *  3. Nine `Mailstore` write methods go through `db.batch()`; a fake without it
 *     does not fail an assertion, it throws `TypeError`.
 *
 * Real SQL fixes all three at once and cannot drift from the deployed schema,
 * which matters more here than it would elsewhere: this repo has no migration
 * framework (`tools/README.md:10-11`), so these files ARE the schema.
 *
 * Foreign keys are ENFORCED, as they are in D1 and as `node:sqlite` defaults.
 * Note where that does and does not bite: `control-plane.sql` declares
 * `REFERENCES` throughout, so `identities`, `tokens`, `credentials` and
 * `grants` really do need their tenant/principal/account rows — hence
 * `seedAccount()`, which makes that spine one line. `data-plane.sql` declares
 * NO foreign keys at all: every table there floats on a bare `account_id`, so
 * a mailbox or calendar_events fixture stands alone exactly as before. Pass
 * `{ foreignKeys: false }` for a control-plane fixture that is deliberately
 * partial.
 *
 * Known gaps, stated so nobody trusts them:
 *  - `node:sqlite` is not D1. `D1Meta` numbers other than `changes` /
 *    `last_row_id` are plausible fillers, and D1's session-consistency
 *    semantics are not modelled at all (`withSession` throws).
 *  - Both schema planes load into ONE database. Production has two (a
 *    control-plane D1 and a per-shard data-plane D1), so a join across the
 *    planes would work here and fail there. Nothing in the tree writes one,
 *    and every fake this replaces made the same simplification.
 */

const SQL_DIR = new URL("../../mailstore/sql/", import.meta.url);

/** The live schema, in dependency order. Same files `tools/` feeds wrangler. */
export const LIVE_SCHEMA = ["control-plane.sql", "data-plane.sql"] as const;

export interface FakeD1Options {
  /**
   * Schema files to load from `packages/mailstore/sql/`, or raw SQL to exec.
   * Defaults to the full live schema; both planes land in one database, which
   * is what every existing test already assumed and what the jmap worker's
   * single `DB` binding looks like from the method layer.
   */
  schema?: readonly string[];
  /** Extra SQL run after the schema — table fixtures, test-only tables. */
  setup?: string;
  /** Enforce `REFERENCES` clauses. On by default; see the note above. */
  foreignKeys?: boolean;
}

export interface RecordedWrite {
  sql: string;
  args: unknown[];
}

/**
 * Statements whose result is rows rather than a change count.
 *
 * `RETURNING` is included because a mutation carrying it yields rows, and rows
 * are what its caller wants. The cost is that `meta.changes` reads 0 for such a
 * statement, where D1 reports both — node:sqlite exposes rows and the change
 * count through different methods and there is no way to get both from one
 * execution. Nothing in the tree uses `RETURNING` today; if something starts
 * to and asserts on `meta.changes`, this is the line to revisit.
 */
const RETURNS_ROWS = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b|\bRETURNING\b/i;

const EMPTY_META = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

/**
 * D1 accepts a slightly wider set of bound values than `node:sqlite` does.
 * Normalize the two D1 tolerates and reject the rest loudly — a silent
 * coercion here would be a fake that lies about what deploys.
 */
function toSqlValue(value: unknown, sql: string): SQLInputValue {
  if (value === null) return null;
  if (value === undefined) {
    // Real D1 refuses this (`D1_TYPE_ERROR: Type 'undefined' not supported`),
    // and it is the value most likely to arrive by accident — a row object
    // missing an optional key. Coercing it to NULL would let a test write a
    // clean row where production throws, which is the exact class of lie this
    // harness exists to stop.
    throw new TypeError(
      `fakeD1: cannot bind undefined — D1 rejects it (D1_TYPE_ERROR). Pass null explicitly.\n  in: ${sql}`,
    );
  }
  switch (typeof value) {
    case "boolean":
      return value ? 1 : 0;
    case "number":
    case "bigint":
    case "string":
      return value;
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(
    `fakeD1: cannot bind ${Object.prototype.toString.call(value)} (D1 would reject it too)\n  in: ${sql}`,
  );
}

/** node:sqlite may hand back null-prototype rows; hand on plain objects. */
const plain = <T>(row: Record<string, unknown>): T => ({ ...row }) as T;

class FakeStatement implements D1PreparedStatement {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    // D1's bind returns a NEW statement rather than mutating; batch() relies on
    // that, since the same prepared statement may be bound more than once.
    return new FakeStatement(this.db, this.sql, values);
  }

  /** The bound values, coerced for node:sqlite. Used by run/all and batch. */
  params(): SQLInputValue[] {
    return this.args.map((v) => toSqlValue(v, this.sql));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const row = this.db.statement(this.sql).get(...this.params());
    if (row === undefined) return null;
    if (colName === undefined) return plain<T>(row);
    if (!(colName in row)) {
      throw new Error(`fakeD1: no such column "${colName}" in result of: ${this.sql}`);
    }
    return row[colName] as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.db.statement(this.sql).all(...this.params());
    return {
      success: true,
      meta: { ...EMPTY_META, rows_read: rows.length },
      results: rows.map(plain<T>),
    };
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = this.db.statement(this.sql).all(...this.params());
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    const values = rows.map((r) => columns.map((c) => r[c]) as T);
    return options?.columnNames ? [columns, ...values] : values;
  }
}

export class FakeD1 implements D1Database {
  /**
   * Every `.run()` and every statement executed through `.batch()`, in order.
   *
   * Kept from the fakes this replaces: asserting on the exact SQL text or on
   * positional bind arguments is occasionally the point (calendars.test.ts
   * reads `start_at`/`end_at` straight out of the INSERT), and asserting a
   * NEGATIVE — "no grant_audit row was written" — reads better here than as a
   * COUNT(*). Both affordances are available; use whichever is honest.
   *
   * This records ATTEMPTS, not commits: a `batch()` that rolls back still
   * leaves its statements here. For "did this land", use `count()` / `query()`.
   */
  readonly writes: RecordedWrite[] = [];
  /** Every SQL string handed to `prepare()`, in order. */
  readonly queries: string[] = [];
  /** Escape hatch for arrange/assert. Prefer `seed()` / `query()`. */
  readonly sqlite: DatabaseSync;

  private readonly cache = new Map<string, StatementSync>();

  constructor(opts: FakeD1Options = {}) {
    this.sqlite = new DatabaseSync(":memory:");
    // node:sqlite turns these on for you; make the choice visible either way.
    this.sqlite.exec(`PRAGMA foreign_keys = ${opts.foreignKeys === false ? "OFF" : "ON"}`);
    for (const file of opts.schema ?? LIVE_SCHEMA) {
      this.sqlite.exec(readFileSync(new URL(file, SQL_DIR), "utf8"));
    }
    if (opts.setup) this.sqlite.exec(opts.setup);
  }

  /** @internal Prepared-statement cache; node:sqlite compiles on prepare. */
  statement(sql: string): StatementSync {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      try {
        stmt = this.sqlite.prepare(sql);
      } catch (err) {
        // The old fakes answered an unrecognized query with a fixture. This is
        // the opposite bargain: an unrunnable query is a test bug, said loudly.
        throw new Error(`fakeD1: could not prepare\n${sql}\n  ${(err as Error).message}`);
      }
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * @internal Execute one statement.
   *
   * Branches on statement kind because node:sqlite splits what D1 unifies:
   * D1's `run()` and `all()` both return `results` AND `meta`, while
   * node:sqlite's `run()` returns only a change count and its `all()` returns
   * only rows. Getting this wrong in the read direction is a false negative —
   * `SELECT … .run()` on node:sqlite reports a STALE `changes: 1` from
   * sqlite3_changes, so a fake that always took the run() path would claim a
   * pure read wrote a row, and would drop the rows a `RETURNING` clause
   * produced.
   */
  runOne<T>(stmt: FakeStatement): D1Result<T> {
    const compiled = this.statement(stmt.sql);
    const params = stmt.params();
    if (RETURNS_ROWS.test(stmt.sql)) {
      const rows = compiled.all(...params);
      return {
        success: true,
        meta: { ...EMPTY_META, rows_read: rows.length },
        results: rows.map(plain<T>),
      };
    }
    const res = compiled.run(...params);
    return {
      success: true,
      meta: {
        ...EMPTY_META,
        changes: Number(res.changes),
        rows_written: Number(res.changes),
        last_row_id: Number(res.lastInsertRowid),
        changed_db: Number(res.changes) > 0,
      },
      results: [],
    };
  }

  /** @internal `.run()`: execute, and record it as a write. */
  execute<T>(stmt: FakeStatement): D1Result<T> {
    this.writes.push({ sql: stmt.sql, args: stmt.args });
    return this.runOne<T>(stmt);
  }

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query);
    return new FakeStatement(this, query);
  }

  /**
   * D1's `batch` is ATOMIC: the statements run in an implicit transaction and a
   * failure rolls back every one of them. A fake that executed sequentially
   * without a transaction would let a test pass on code that leaves a
   * half-written row in production, so the transaction is modelled.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const stmts = statements.map((s) => {
      if (!(s instanceof FakeStatement)) {
        throw new TypeError("fakeD1: batch() takes statements from this database's prepare()");
      }
      return s;
    });
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        this.writes.push({ sql: s.sql, args: s.args });
        return this.runOne<T>(s);
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      // SQLite may have already unwound the transaction itself (ON CONFLICT
      // ROLLBACK, SQLITE_FULL), in which case a bare ROLLBACK throws "cannot
      // rollback - no transaction is active". Letting that escape would
      // replace the real failure with a confusing one.
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        /* already unwound */
      }
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: query.split(";").filter((s) => s.trim().length > 0).length, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    // D1 sessions are a read-replica consistency feature with no in-process
    // analogue. Throwing is honest; silently returning `this` would make a
    // test claim it exercised sequential consistency when it did not.
    throw new Error("fakeD1: withSession() is not modelled (D1 read-replica sessions)");
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("fakeD1: dump() is not modelled (deprecated D1 alpha API)");
  }

  // ---- arrange / assert helpers --------------------------------------

  /**
   * Insert fixture rows. Column names are the object's keys, so a fixture is
   * the row — no INSERT to keep in sync with the schema.
   */
  seed(table: string, rows: Array<Record<string, unknown>>): this {
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      this.sqlite.prepare(sql).run(...cols.map((c) => toSqlValue(row[c], sql)));
    }
    return this;
  }

  /**
   * Seed the control-plane spine an account hangs off: tenant → principal →
   * account. Foreign keys are enforced, so `identities`, `tokens`, `grants`
   * and `credentials` all need these three rows to exist first — and forcing a
   * fixture to be coherent is the point, not an inconvenience: a test whose
   * account does not exist is testing a state the product cannot reach.
   *
   * Idempotent — call it once per account, in any order.
   */
  seedAccount(opts: {
    accountId: string;
    tenantId?: string;
    principalId?: string;
    loginEmail?: string;
    displayName?: string;
  }): this {
    const tenantId = opts.tenantId ?? "t_bm";
    const principalId = opts.principalId ?? `p_${opts.accountId}`;
    const loginEmail = opts.loginEmail ?? `${principalId}@bullmoose.cc`;
    const ignore = (sql: string, ...args: unknown[]) =>
      this.sqlite.prepare(sql).run(...args.map((v) => toSqlValue(v, sql)));

    ignore(
      `INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, 1)`,
      tenantId,
      tenantId,
    );
    ignore(
      `INSERT OR IGNORE INTO principals (id, tenant_id, login_email, created_at) VALUES (?, ?, ?, 1)`,
      principalId,
      tenantId,
      loginEmail,
    );
    ignore(
      `INSERT OR IGNORE INTO accounts (id, tenant_id, principal_id, display_name, created_at)
       VALUES (?, ?, ?, ?, 1)`,
      opts.accountId,
      tenantId,
      principalId,
      opts.displayName ?? "Test",
    );
    return this;
  }

  /** Read rows back synchronously, bypassing the D1 surface entirely. */
  query<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
    return this.sqlite
      .prepare(sql)
      .all(...args.map((v) => toSqlValue(v, sql)))
      .map(plain<T>);
  }

  /** `SELECT COUNT(*)` — the honest form of "nothing was written". */
  count(table: string, where = "1=1", ...args: unknown[]): number {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
      ...args,
    );
    return row[0]?.n ?? 0;
  }

  /**
   * Release the SQLite handle and its statement cache.
   *
   * Optional, and most tests correctly skip it: an `:memory:` database is a few
   * hundred KB of heap that dies with the process, and the whole suite builds
   * a few hundred of them in ~300ms. Reach for it in a test that builds
   * databases in a LOOP, where the peak matters. Safe to call with cached
   * statements outstanding.
   */
  close(): void {
    this.cache.clear();
    this.sqlite.close();
  }
}

/** A `D1Database` over an in-memory SQLite loaded with the live schema. */
export function fakeD1(opts: FakeD1Options = {}): FakeD1 {
  return new FakeD1(opts);
}
