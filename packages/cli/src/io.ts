/**
 * The Unix I/O contract — `.plans/s05-cli-crud/arch.md` §1, sVOL unit `016`.
 *
 * Every command goes through this module. It is deliberately dependency-free
 * (nothing but `node:fs`) so that importing it can never have a side effect
 * beyond the one it advertises, and so the exit-code table can be unit-tested
 * without a database, a server, or a process.
 *
 * The eight clauses and where each one lives:
 *
 *   §1.1 stdout = data, stderr = everything else   `out` / `note` / `warn`
 *   §1.2 EPIPE is not an error                     `installEpipeGuard`
 *   §1.3 `--json` is NDJSON for collections        `emitJson` / `emitNdjson`
 *   §1.4 stdin as an input source, `-` explicit    `readSource` / `inferType`
 *   §1.5 exit codes scripts can branch on          `EXIT` / `exitCodeFor`
 *   §1.6 no TTY assumptions, honour NO_COLOR       `colorEnabled` / `dim`
 *   §1.7 concurrency-safe scripted writes          `EXIT.CONFLICT` + `--if-state`
 *   §1.8 composition affordances                   `emitIds`
 *
 * The discipline is asserted, not merely documented: `io.test.ts` greps the
 * package for `console.log` and fails if any module other than this one has
 * one. That is the only mechanism that survives the next fifty commands.
 */

import { readFileSync } from "node:fs";

/**
 * The contract's own flags, as every command module receives them. `main.ts`
 * builds one of these and spreads it into each module's options, so a new
 * clause in `arch.md` §1 lands here and in the modules that honour it rather
 * than in forty call sites.
 */
export interface IoOpts {
  /** §1.3 — NDJSON for collections, one object for `show`. */
  json: boolean;
  /** §1.8 — bare identifiers, one per line, and nothing else. */
  ids: boolean;
  /** §1.7 — resolve and report, mutate nothing. */
  dryRun: boolean;
  /** §1.7 — JMAP `ifInState`; a mismatch exits 5 and changes nothing. */
  ifState?: string;
  /** §1.4 — force the input content type instead of inferring it. */
  as?: string;
}

// ───────────────────────────── §1.5 exit codes ──────────────────────────────

/**
 * `arch.md` §1.5. The six codes are a public interface: a script branches on
 * them, so they may be added to but never redefined.
 */
export const EXIT = {
  /** success */
  OK: 0,
  /** generic failure — nothing more specific applies, or the server broke */
  FAIL: 1,
  /** usage error — the command as typed cannot be valid */
  USAGE: 2,
  /** not found — the named thing does not exist */
  NOT_FOUND: 3,
  /** auth / forbidden — you are not allowed to do this */
  AUTH: 4,
  /** conflict — a precondition or state check refused the write (§1.7) */
  CONFLICT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * JMAP error type → exit code.
 *
 * `arch.md` §1.5 gives six codes by English meaning and `devPlan.md:19` says
 * "via a small typed error → code mapping" — and then neither states which JMAP
 * error is which. sVOL `016` flagged that as the missing half of the clause;
 * this table is it. Without it every command module invents its own mapping and
 * T1's done-when ("a table-driven test asserts the exit code for each failure
 * class") has no agreed list of classes.
 *
 * The rule that decides the hard cases:
 *
 *   2 (usage)     retyping the command could fix it — the request itself is wrong
 *   3 (not found) the named thing is absent
 *   4 (auth)      the caller is not permitted, and no retype changes that
 *   5 (conflict)  the request was well-formed and permitted, but the server's
 *                 state refused it — retry after re-reading, or pass --force
 *   1 (generic)   the caller can do nothing about it: server, quota, rate limit
 *
 * So `overQuota` is 1, not 2: no way of phrasing the command fixes it.
 * `tooLarge` is 2, because a smaller input does. `mailboxHasEmail` is 5 rather
 * than 2 because the command was right and the folder's contents refused it —
 * exactly the shape of `stateMismatch`, and `--force` is the resolution.
 *
 * Covers RFC 8620 §3.6.2 method-level errors, §5.3 SetError types, and the
 * RFC 8621 mail-specific SetErrors. Anything unlisted falls to 1.
 */
export const JMAP_EXIT: Readonly<Record<string, ExitCode>> = {
  // ---- method-level (RFC 8620 §3.6.2) ----
  accountNotFound: EXIT.NOT_FOUND,
  accountNotSupportedByMethod: EXIT.USAGE,
  accountReadOnly: EXIT.AUTH,
  anchorNotFound: EXIT.NOT_FOUND,
  cannotCalculateChanges: EXIT.FAIL,
  forbidden: EXIT.AUTH,
  invalidArguments: EXIT.USAGE,
  invalidResultReference: EXIT.USAGE,
  requestTooLarge: EXIT.USAGE,
  serverFail: EXIT.FAIL,
  serverPartialFail: EXIT.FAIL,
  serverUnavailable: EXIT.FAIL,
  stateMismatch: EXIT.CONFLICT,
  unknownCapability: EXIT.USAGE,
  unknownMethod: EXIT.USAGE,
  unsupportedFilter: EXIT.USAGE,
  unsupportedSort: EXIT.USAGE,

  // ---- request-level (RFC 8620 §3.6.1) ----
  notJSON: EXIT.USAGE,
  notRequest: EXIT.USAGE,
  limit: EXIT.FAIL,

  // ---- SetError (RFC 8620 §5.3) ----
  alreadyExists: EXIT.CONFLICT,
  invalidPatch: EXIT.USAGE,
  invalidProperties: EXIT.USAGE,
  notFound: EXIT.NOT_FOUND,
  overQuota: EXIT.FAIL,
  rateLimit: EXIT.FAIL,
  singleton: EXIT.USAGE,
  tooLarge: EXIT.USAGE,
  willDestroy: EXIT.CONFLICT,

  // ---- mail-specific SetError (RFC 8621) ----
  blobNotFound: EXIT.NOT_FOUND,
  cannotUnsend: EXIT.CONFLICT,
  invalidEmail: EXIT.USAGE,
  mailboxHasChild: EXIT.CONFLICT,
  mailboxHasEmail: EXIT.CONFLICT,
  addressBookHasContents: EXIT.CONFLICT,
  tooManyKeywords: EXIT.USAGE,
  tooManyMailboxes: EXIT.USAGE,
};

/** Same taxonomy, for the CLI's non-JMAP HTTP endpoints (`/auth`, `/api/…`). */
export function exitCodeForHttpStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 409 || status === 412 || status === 428) return EXIT.CONFLICT;
  if (status >= 400 && status < 500) return EXIT.USAGE;
  return EXIT.FAIL;
}

export function exitCodeForJmapType(type: string | undefined): ExitCode {
  if (!type) return EXIT.FAIL;
  return JMAP_EXIT[type] ?? EXIT.FAIL;
}

/** An error that already knows what the process should exit with. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT.FAIL) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * The single funnel every failure goes through. Precedence is deliberate: a
 * JMAP type we recognise is the most specific signal there is, an HTTP status
 * the next, and an explicit `CliError` code the CLI's own judgement.
 *
 * A type we do NOT recognise must not short-circuit to 1 while a perfectly good
 * status sits beside it: the non-JMAP endpoints answer refusals with their own
 * vocabulary (`blobInUse` on a 409), and reading that as "generic failure"
 * threw away the one thing the server was clear about.
 */
export function exitCodeFor(err: unknown): ExitCode {
  if (err instanceof CliError) return err.exitCode;
  const e = err as { jmapType?: string; httpStatus?: number; exitCode?: number } | null;
  if (e && typeof e === "object") {
    if (typeof e.jmapType === "string" && e.jmapType in JMAP_EXIT) {
      return JMAP_EXIT[e.jmapType]!;
    }
    if (typeof e.httpStatus === "number") return exitCodeForHttpStatus(e.httpStatus);
    if (typeof e.jmapType === "string") return exitCodeForJmapType(e.jmapType);
    if (typeof e.exitCode === "number") return e.exitCode as ExitCode;
  }
  return EXIT.FAIL;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ───────────────────────── §1.1 stdout is data ──────────────────────────────

/**
 * A record — the thing the user asked for. stdout, one line.
 *
 * The dividing line, stated once so command authors do not have to re-derive
 * it: **the results go to `out`, everything about producing them goes to
 * `note`.** List rows, shown objects, created ids, minted secrets and every
 * `--json` payload are results. Progress, prompts, warnings, counts and
 * summaries, tree decoration, "(none)" notices and follow-up hints are not.
 */
export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** Bytes straight to stdout — `read --raw`, `help --man`. No trailing newline. */
export function outRaw(chunk: string | Uint8Array): void {
  process.stdout.write(chunk);
}

/** Chrome: progress, summaries, decoration, hints. stderr. */
export function note(line = ""): void {
  process.stderr.write(`${line}\n`);
}

/** A warning. stderr, prefixed so it is greppable. */
export function warn(line: string): void {
  note(`warning: ${line}`);
}

// ─────────────────────────── §1.3 JSON is NDJSON ─────────────────────────────

/**
 * One JSON value, one line. Compact on purpose: under `--json` every line of
 * stdout is a complete JSON value, so `| head -3` truncates cleanly and
 * `| jq` streams instead of buffering. A pretty-printed blob defeats both.
 */
export function emitJson(value: unknown): void {
  out(JSON.stringify(value));
}

/** A collection: one record per line, no wrapping array (`arch.md` §1.3). */
export function emitNdjson(rows: Iterable<unknown>): void {
  for (const row of rows) emitJson(row);
}

// ──────────────────────── §1.8 composition affordances ───────────────────────

/**
 * `--ids`: one bare identifier per line and nothing else — the `xargs` shape.
 * Ids are printed verbatim, so an id containing whitespace would break the
 * contract; JMAP ids are `[A-Za-z0-9_-]` by RFC 8620 §1.2, so they cannot.
 */
export function emitIds(ids: Iterable<string>): void {
  for (const id of ids) out(id);
}

// ──────────────────────── §1.6 no TTY assumptions ────────────────────────────

/**
 * Colour is opt-out by environment and off by default when piped.
 *
 * Nothing here ever invokes a pager: the user pipes to `less` themselves, and a
 * CLI that spawns one steals the terminal from a script that has none.
 */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

/** Dim text, or the text unchanged where colour is not allowed. */
export function dim(text: string, stream: { isTTY?: boolean } = process.stderr): string {
  return colorEnabled(stream) ? `\u001b[2m${text}\u001b[0m` : text;
}

// ───────────────────────────── §1.2 EPIPE guard ──────────────────────────────

/**
 * "The highest-leverage line in the whole plan" (`arch.md` §1.2).
 *
 * `bullmoose log | head -3` closes the read end after three lines; the next
 * write raises EPIPE, and without this Node prints a ten-line stack trace and
 * exits non-zero. `| head`, `| grep -m1`, and quitting `less` early are all the
 * same event. Exiting 0 is correct: the downstream reader got what it asked
 * for, so nothing failed.
 *
 * Installed on both streams and on `uncaughtException`, because a write can
 * surface the error either as a stream event (pipes, the common case) or as a
 * synchronous throw (a closed file descriptor).
 */
export function installEpipeGuard(): void {
  const onStreamError = (err: unknown): void => {
    if (isBrokenPipe(err)) process.exit(EXIT.OK);
    // Not a broken pipe: we cannot trust the stream, so do not try to print
    // through it. Exit non-zero so the failure is visible to `set -e`.
    process.exit(EXIT.FAIL);
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
  process.on("uncaughtException", (err) => {
    if (isBrokenPipe(err)) process.exit(EXIT.OK);
    throw err;
  });
}

export function isBrokenPipe(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

// ────────────────────── §1.4 stdin as an input source ────────────────────────

/** Content types the CLI can be handed on stdin or in a file. */
export type InputType = "vcard" | "ical" | "json" | "text";

const AS_VALUES: Readonly<Record<string, InputType>> = {
  vcard: "vcard",
  vcf: "vcard",
  ical: "ical",
  ics: "ical",
  icalendar: "ical",
  json: "json",
  text: "text",
};

/** Validate `--as`; `undefined` means "infer". Throws a usage error on junk. */
export function parseAs(raw: string | undefined): InputType | undefined {
  if (raw === undefined) return undefined;
  const t = AS_VALUES[raw.trim().toLowerCase()];
  if (!t) {
    throw new CliError(
      `--as must be one of vcard, ical, json, text (got "${raw}")`,
      EXIT.USAGE,
    );
  }
  return t;
}

/**
 * Sniff the payload. vCard and iCalendar announce themselves on line 1
 * (RFC 6350 §6.1.1, RFC 5545 §3.4), and JSON is unambiguous from its first
 * non-space byte, so this needs no heuristics and cannot be fooled by content.
 */
export function inferType(text: string): InputType {
  const head = text.replace(/^\uFEFF/, "").trimStart();
  const upper = head.slice(0, 32).toUpperCase();
  if (upper.startsWith("BEGIN:VCARD")) return "vcard";
  if (upper.startsWith("BEGIN:VCALENDAR")) return "ical";
  const first = head[0];
  if (first === "{" || first === "[") return "json";
  return "text";
}

export interface Input {
  text: string;
  type: InputType;
  /** Where it came from, for error messages. */
  from: string;
}

/**
 * `arch.md` §1.4, generalizing the rule `send` already states at
 * `main.ts:552` — *explicit flags beat implicit stdin*.
 *
 *   readInput(undefined)   file argument absent → stdin if it is not a TTY
 *   readInput("-")         explicit stdin, even when stdin is a terminal
 *   readInput("card.vcf")  a path
 *
 * `as` forces the type; otherwise it is inferred from the bytes.
 */
export function readInput(
  source: string | undefined,
  opts: { as?: string; required?: boolean; what?: string } = {},
): Input | undefined {
  const forced = parseAs(opts.as);
  let text: string | undefined;
  let from: string;

  if (source === "-") {
    text = readFileSync(0, "utf8");
    from = "(stdin)";
  } else if (source !== undefined && source !== "") {
    text = readFileSync(source, "utf8");
    from = source;
  } else if (!process.stdin.isTTY) {
    const piped = readFileSync(0, "utf8");
    text = piped.length > 0 ? piped : undefined;
    from = "(stdin)";
  } else {
    from = "(none)";
  }

  if (text === undefined) {
    if (opts.required) {
      throw new CliError(
        `no ${opts.what ?? "input"}: pipe it on stdin, pass a path, or pass "-" for explicit stdin`,
        EXIT.USAGE,
      );
    }
    return undefined;
  }
  return { text, type: forced ?? inferType(text), from };
}

// ─────────────────────────────── failure helpers ─────────────────────────────

/** Abort with a message and an exit code from the §1.5 table. */
export function fail(message: string, code: ExitCode = EXIT.FAIL): never {
  throw new CliError(message, code);
}

/** A malformed invocation. Always exit 2. */
export function usage(line: string): never {
  throw new CliError(line.startsWith("usage:") ? line : `usage: ${line}`, EXIT.USAGE);
}

/** The named thing is not there. Always exit 3. */
export function notFound(message: string): never {
  throw new CliError(message, EXIT.NOT_FOUND);
}

/** A state/precondition refusal (`--if-state`, `mailboxHasEmail`). Exit 5. */
export function conflict(message: string): never {
  throw new CliError(message, EXIT.CONFLICT);
}

/**
 * A per-object SetError — the normal failure shape for `/set` methods, which
 * arrive inside `notCreated` / `notUpdated` / `notDestroyed` rather than as a
 * thrown method error. Same table, so `mailbox rm` on a non-empty folder exits
 * 5 whether the server reported it per-object or method-level.
 */
export function failSetError(verb: string, err: unknown): never {
  const e = (err ?? {}) as { type?: string; description?: string };
  const detail = e.description ? ` — ${e.description}` : "";
  throw new CliError(`${verb} failed: ${e.type ?? "unknown"}${detail}`, exitCodeForJmapType(e.type));
}

/** Print `error: …` on stderr and exit with the mapped code. The one exit path. */
export function die(err: unknown): never {
  note(`error: ${errorMessage(err)}`);
  process.exit(exitCodeFor(err));
}
