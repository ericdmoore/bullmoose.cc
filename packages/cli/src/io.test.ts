import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT,
  JMAP_EXIT,
  exitCodeFor,
  exitCodeForHttpStatus,
  exitCodeForJmapType,
  inferType,
  isBrokenPipe,
  parseAs,
} from "./io.js";

/**
 * sVOL `016` — the CLI I/O contract (`.plans/s05-cli-crud/arch.md` §1).
 *
 * These cover the parts that are pure: the exit-code mapping, the `--as` /
 * content-sniffing rules, and the source-level discipline. The parts that are
 * NOT pure — what actually happens when the pipe closes, whether `--ids | xargs`
 * composes, whether a `--dry-run` really writes nothing — cannot be observed
 * from inside a process that is not being piped, and live in `contract.test.ts`,
 * which runs the built binary through a real shell.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

describe("§1.5 — the exit-code table", () => {
  /**
   * The table-driven test `s05/devPlan.md:25-26` asks for. `arch.md` gives the
   * six codes by meaning and stops; this enumerates the failure classes it left
   * unnamed, which is the gap sVOL `016` was filed on.
   */
  const CASES: Array<[string, number, string]> = [
    // conflict — the request was fine, the server's state refused it
    ["stateMismatch", EXIT.CONFLICT, "--if-state lost the race (invariant 6)"],
    ["alreadyExists", EXIT.CONFLICT, "the name is taken"],
    ["mailboxHasEmail", EXIT.CONFLICT, "rm a folder that still holds mail; --force resolves it"],
    ["mailboxHasChild", EXIT.CONFLICT, "rm a folder with children"],
    ["willDestroy", EXIT.CONFLICT, "the object is already scheduled for destruction"],
    ["cannotUnsend", EXIT.CONFLICT, "too late — it has gone out"],
    // not found
    ["notFound", EXIT.NOT_FOUND, "no such object"],
    ["blobNotFound", EXIT.NOT_FOUND, "no such blob"],
    ["accountNotFound", EXIT.NOT_FOUND, "no such account"],
    ["anchorNotFound", EXIT.NOT_FOUND, "the query anchor is gone"],
    // auth
    ["forbidden", EXIT.AUTH, "the token lacks the scope"],
    ["accountReadOnly", EXIT.AUTH, "read-only account — not a retypeable mistake"],
    // usage — retyping could fix it
    ["invalidArguments", EXIT.USAGE, "malformed request"],
    ["invalidProperties", EXIT.USAGE, "a property the server will not take"],
    ["invalidPatch", EXIT.USAGE, "a patch that does not apply"],
    ["singleton", EXIT.USAGE, "you asked to create/destroy a singleton"],
    ["tooLarge", EXIT.USAGE, "smaller input fixes it"],
    ["requestTooLarge", EXIT.USAGE, "fewer objects per call fixes it"],
    ["unknownMethod", EXIT.USAGE, "the server does not offer that method"],
    ["unknownCapability", EXIT.USAGE, "the server does not offer that capability"],
    ["unsupportedFilter", EXIT.USAGE, "that filter is not implemented"],
    ["unsupportedSort", EXIT.USAGE, "that sort is not implemented"],
    ["accountNotSupportedByMethod", EXIT.USAGE, "wrong account for the method"],
    ["tooManyKeywords", EXIT.USAGE, "fewer keywords fixes it"],
    ["invalidEmail", EXIT.USAGE, "the address does not parse"],
    // generic — nothing the caller can restate
    ["serverFail", EXIT.FAIL, "the server broke"],
    ["serverUnavailable", EXIT.FAIL, "transient"],
    ["overQuota", EXIT.FAIL, "no phrasing of the command fits under the quota"],
    ["rateLimit", EXIT.FAIL, "retry later, do not retype"],
    ["cannotCalculateChanges", EXIT.FAIL, "the changelog cannot answer; resync"],
  ];

  it.each(CASES)("%s → exit %i (%s)", (type, code) => {
    expect(exitCodeForJmapType(type)).toBe(code);
  });

  it("falls back to 1 for an error type nobody has mapped", () => {
    expect(exitCodeForJmapType("someFutureJmapError")).toBe(EXIT.FAIL);
    expect(exitCodeForJmapType(undefined)).toBe(EXIT.FAIL);
  });

  it("never maps anything to 0 — a failure that exits 0 is the worst outcome", () => {
    for (const code of Object.values(JMAP_EXIT)) expect(code).not.toBe(EXIT.OK);
  });

  it("maps HTTP status the same way, for the endpoints outside the JMAP envelope", () => {
    expect(exitCodeForHttpStatus(401)).toBe(EXIT.AUTH);
    expect(exitCodeForHttpStatus(403)).toBe(EXIT.AUTH);
    expect(exitCodeForHttpStatus(404)).toBe(EXIT.NOT_FOUND);
    expect(exitCodeForHttpStatus(409)).toBe(EXIT.CONFLICT);
    expect(exitCodeForHttpStatus(412)).toBe(EXIT.CONFLICT);
    expect(exitCodeForHttpStatus(400)).toBe(EXIT.USAGE);
    expect(exitCodeForHttpStatus(422)).toBe(EXIT.USAGE);
    expect(exitCodeForHttpStatus(500)).toBe(EXIT.FAIL);
    expect(exitCodeForHttpStatus(503)).toBe(EXIT.FAIL);
  });

  it("prefers the JMAP type over the HTTP status when an error carries both", () => {
    // A 409 that names `blob in use` is more specific than "some conflict";
    // a 200-shaped JMAP envelope carrying `forbidden` must still exit 4.
    const err = Object.assign(new Error("x"), { jmapType: "notFound", httpStatus: 409 });
    expect(exitCodeFor(err)).toBe(EXIT.NOT_FOUND);
  });

  it("honours an explicit CliError code, and defaults to 1 for a bare Error", () => {
    expect(exitCodeFor(new CliError("nope", EXIT.USAGE))).toBe(EXIT.USAGE);
    expect(exitCodeFor(new Error("boom"))).toBe(EXIT.FAIL);
    expect(exitCodeFor("a string")).toBe(EXIT.FAIL);
    expect(exitCodeFor(null)).toBe(EXIT.FAIL);
  });
});

describe("§1.2 — EPIPE is not an error", () => {
  it("recognises the three ways a closed pipe surfaces in Node", () => {
    expect(isBrokenPipe({ code: "EPIPE" })).toBe(true);
    expect(isBrokenPipe({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
    expect(isBrokenPipe({ code: "ERR_STREAM_WRITE_AFTER_END" })).toBe(true);
  });

  it("does not swallow a real stream failure", () => {
    expect(isBrokenPipe({ code: "ENOSPC" })).toBe(false);
    expect(isBrokenPipe(new Error("boom"))).toBe(false);
    expect(isBrokenPipe(undefined)).toBe(false);
  });
});

describe("§1.4 — stdin as an input source", () => {
  it("sniffs vCard and iCalendar from their opening line, per RFC 6350/5545", () => {
    expect(inferType("BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD")).toBe("vcard");
    expect(inferType("begin:vcalendar\nEND:VCALENDAR")).toBe("ical");
  });

  it("tolerates a BOM and leading whitespace — exports have both", () => {
    expect(inferType("﻿BEGIN:VCARD\nEND:VCARD")).toBe("vcard");
    expect(inferType("\n\n  BEGIN:VCALENDAR\n")).toBe("ical");
  });

  it("recognises JSON from its first non-space byte", () => {
    expect(inferType('{"uid":"x"}')).toBe("json");
    expect(inferType("  [1,2]")).toBe("json");
  });

  it("calls anything else text rather than guessing", () => {
    expect(inferType("hello")).toBe("text");
    expect(inferType("")).toBe("text");
  });

  it("--as forces the type and accepts the obvious spellings", () => {
    expect(parseAs("vcard")).toBe("vcard");
    expect(parseAs("VCF")).toBe("vcard");
    expect(parseAs(" ics ")).toBe("ical");
    expect(parseAs(undefined)).toBeUndefined();
  });

  it("--as with junk is a usage error, not a silent fallback", () => {
    try {
      parseAs("yaml");
      expect.unreachable("parseAs should have thrown");
    } catch (err) {
      expect(exitCodeFor(err)).toBe(EXIT.USAGE);
      expect((err as Error).message).toContain("--as must be one of");
    }
  });
});

/**
 * §1.1, asserted rather than left to convention.
 *
 * `s05/devPlan.md` puts the stdout/stderr audit at 101 `console.log` sites and
 * says the discipline should be held by tests "rather than by convention".
 * A reviewer cannot re-audit every site on every PR; this can. `io.ts` owns the
 * two writes, so a `console.log` anywhere else is by construction a line whose
 * stream nobody chose.
 */
describe("§1.1 — the stdout/stderr discipline, enforced at the source", () => {
  const modules = readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "io.ts")
    .map((f) => [f, readFileSync(`${SRC}${f}`, "utf8")] as const);

  it("has modules to check (guards against the glob silently matching nothing)", () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  it.each(modules.map(([f]) => f))("%s writes through io.ts, not console", (file) => {
    const source = modules.find(([f]) => f === file)![1];
    const offenders = source
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\bconsole\.(log|error|warn|info|debug)\s*\(/.test(line));
    expect(
      offenders.map(([n, l]) => `${file}:${n}: ${l.trim()}`),
      "use out()/note()/warn() from io.ts so the stream is a decision, not an accident",
    ).toEqual([]);
  });

  it.each(modules.map(([f]) => f))("%s does not write to stdout behind io.ts's back", (file) => {
    // process.stdout.write is io.ts's own primitive; elsewhere it is a line
    // that bypassed the contract. (process.stderr.write is allowed: the hidden
    // password prompt in tokens.ts must not emit a newline.)
    const source = modules.find(([f]) => f === file)![1];
    expect(source).not.toMatch(/process\.stdout\.write\s*\(/);
  });

  it("never spawns a pager (§1.6 — the user pipes to less themselves)", () => {
    for (const [file, source] of modules) {
      expect(source, `${file} must not invoke a pager`).not.toMatch(
        /\b(PAGER|less -|\bmore\b\s*\()/,
      );
    }
  });
});
