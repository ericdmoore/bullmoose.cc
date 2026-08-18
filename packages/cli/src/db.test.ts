import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotateStaleBase, openDb, setConfig } from "./db.js";
import { exitCodeFor } from "./io.js";
import type { JmapError } from "./jmap.js";

/**
 * The repair hint, at the one failure that has a repair.
 *
 * PR #201's live smoke found `~/.bullmoose/mail.db` still holding
 * `base = https://bullmoose-jmap.eric-d-moore.workers.dev`, a host that now
 * 404s on everything including `/.well-known/jmap`. The CLI's answer was
 * `session fetch failed: HTTP 404` — true, useless, and identical to the
 * message you get for a URL you mistyped one second ago. One of those two has
 * a stored row to fix and a command that fixes it.
 */

const DEAD = "https://bullmoose-jmap.eric-d-moore.workers.dev";

function dbWithBase(base: string) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "bm-db-")), "mail.db"));
  setConfig(db, "base", base);
  return db;
}

/** The error `JmapClient.session()` throws, with the fields it attaches. */
function sessionError(status: number, baseUrl?: string): JmapError {
  const err = new Error(`session fetch failed: HTTP ${status} not found`) as JmapError;
  err.httpStatus = status;
  if (baseUrl) err.baseUrl = baseUrl;
  return err;
}

describe("a 404 on the STORED base is reported as repairable", () => {
  it("names the dead host, the reason, and the command that repoints", () => {
    const db = dbWithBase(DEAD);
    const out = annotateStaleBase(sessionError(404, DEAD), db) as Error;
    expect(out.message).toContain(DEAD);
    expect(out.message).toContain("bullmoose repoint --base");
    // The distinction that makes it actionable rather than another retry.
    expect(out.message).toContain("gone, not down");
    // And somewhere concrete to point at, verified answering on 2026-08-18.
    expect(out.message).toContain("https://app.bullmoose.cc");
  });

  it("annotates only — the exit code still comes from the status", () => {
    const db = dbWithBase(DEAD);
    const err = sessionError(404, DEAD);
    expect(exitCodeFor(annotateStaleBase(err, db))).toBe(exitCodeFor(sessionError(404, DEAD)));
  });
});

describe("and stays quiet everywhere else", () => {
  it("leaves a 404 against a base the user just TYPED alone", () => {
    // `bullmoose init --base https://typo.example` — nothing stored is wrong,
    // so there is nothing to repoint and the hint would be misdirection.
    const db = dbWithBase(DEAD);
    const err = sessionError(404, "https://typo.example");
    expect((annotateStaleBase(err, db) as Error).message).toBe(err.message);
  });

  it("leaves 500s and 401s alone — those hosts are still JMAP servers", () => {
    const db = dbWithBase(DEAD);
    for (const status of [401, 403, 500, 502]) {
      const err = sessionError(status, DEAD);
      expect((annotateStaleBase(err, db) as Error).message).toBe(err.message);
    }
  });

  it("passes a non-Error through untouched", () => {
    const db = dbWithBase(DEAD);
    expect(annotateStaleBase("plain string", db)).toBe("plain string");
  });
});
