/**
 * Minimal ambient typings for the two Node builtins this package uses.
 *
 * The root tsconfig sets `types: ["@cloudflare/workers-types"]` and deliberately
 * does NOT pull in `@types/node` — Node's globals collide with workers-types,
 * which is exactly why `packages/cli` is typechecked by a separate config
 * (tsconfig.json:30-33). Declaring the two builtins by hand keeps this package
 * inside the workers-typed program without dragging those globals in, and keeps
 * the declared surface to precisely what is used: if a future edit reaches for
 * another `node:` API it fails to compile rather than silently widening the
 * environment for every other package.
 *
 * `node:sqlite` needs Node >= 22.13, where the `--experimental-sqlite` flag was
 * dropped (it was added flagged in 22.5). CI pins `node-version: 22`, which
 * resolves to the latest 22.x, so this is satisfied — but a pin to an exact
 * older 22.x would break `npm test` with a module-not-found, which is an
 * unobvious failure worth naming here rather than rediscovering.
 */

declare module "node:sqlite" {
  /** What node:sqlite will accept as a bound parameter. */
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...params: SQLInputValue[]): Array<Record<string, unknown>>;
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined;
    run(...params: SQLInputValue[]): StatementResultingChanges;
    setReadBigInts(enabled: boolean): void;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
