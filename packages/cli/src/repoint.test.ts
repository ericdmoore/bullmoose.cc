import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, openDb, setConfig, type Settings } from "./db.js";
import { errorMessage, exitCodeFor } from "./io.js";
import { cmdRepoint } from "./repoint.js";

/**
 * `bullmoose repoint` — the verb that did not exist, and the reason it now does.
 *
 * PR #201's live smoke found `~/.bullmoose/mail.db` still holding
 * `bullmoose-jmap.eric-d-moore.workers.dev`, a host that 404s on every path.
 * `base` was written once by `login`/`init` and nothing could write it again, so
 * the repairs on offer were "re-run init with a token you may not still have" or
 * "open the SQLite file by hand". Neither is a thing to tell a user.
 *
 * What the tests are really pinning is the ORDER: validate, then write. A verb
 * that repoints on request and discovers afterwards would turn one wrong base
 * into a different wrong base, which is worse than the failure it repairs.
 */

/** No SRV rung, and no real resolver: the ladder is tested in discover.test.ts. */
vi.mock("node:dns", () => ({
  promises: {
    resolveSrv: async () => {
      throw new Error("NXDOMAIN");
    },
  },
}));

const DEAD = "https://bullmoose-jmap.eric-d-moore.workers.dev";
const LIVE = "https://app.bullmoose.cc";
const ACCOUNT = "t_bullmoose__a_eric";

const IO = { json: false, ids: false, dryRun: false };

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "bm-repoint-")), "mail.db"));
  setConfig(db, "base", DEAD);
  setConfig(db, "token", "bm_device");
  setConfig(db, "accountId", ACCOUNT);
  return db;
}

const settings: Settings = {
  base: DEAD,
  token: "bm_device",
  accountId: ACCOUNT,
  accounts: [{ accountId: ACCOUNT, address: "eric@bullmoose.cc", name: "Eric" }],
};

/** The session resource, as the live server answers it for a good token. */
function session(accounts: Record<string, { name: string }>) {
  return new Response(
    JSON.stringify({ accounts, primaryAccounts: {}, apiUrl: `${LIVE}/api/jmap`, downloadUrl: "", username: "eric" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let asked: string[];
let stdout: string[];
let stderr: string[];
let reply: (url: string) => Response;

beforeEach(() => {
  asked = [];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (stdout.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => (stderr.push(String(c)), true));
  vi.stubGlobal("fetch", async (input: string) => {
    asked.push(String(input));
    return reply(String(input));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function repoint(db: ReturnType<typeof freshDb>, base?: string, json = false) {
  try {
    await cmdRepoint(db, settings, { ...IO, json, base });
    return null;
  } catch (err) {
    return { code: exitCodeFor(err), message: errorMessage(err) };
  }
}

describe("a device whose server moved keeps its credential", () => {
  it("rewrites the base and refreshes the account list, touching nothing else", async () => {
    const db = freshDb();
    reply = () => session({ [ACCOUNT]: { name: "Eric" } });

    expect(await repoint(db, LIVE)).toBeNull();
    expect(getConfig(db, "base")).toBe(LIVE);
    expect(getConfig(db, "token")).toBe("bm_device");
    expect(getConfig(db, "accountId")).toBe(ACCOUNT);
    expect(JSON.parse(getConfig(db, "accounts") ?? "[]")).toEqual([{ accountId: ACCOUNT, name: "Eric" }]);
    // The old and the new, so a scrollback says what happened.
    expect(stdout.join("")).toContain(DEAD);
    expect(stdout.join("")).toContain(LIVE);
  });

  it("validates the NEW base before writing — one round trip, to the session resource", async () => {
    const db = freshDb();
    reply = () => session({ [ACCOUNT]: { name: "Eric" } });
    await repoint(db, LIVE);
    expect(asked).toEqual([`${LIVE}/.well-known/jmap`]);
  });

  it("reports the move as data under --json", async () => {
    const db = freshDb();
    reply = () => session({ [ACCOUNT]: { name: "Eric" } });
    await repoint(db, LIVE, true);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ base: LIVE, previousBase: DEAD, changed: true });
  });

  it("is a no-op, and says so, when it is already there", async () => {
    const db = freshDb();
    reply = () => {
      throw new Error("a no-op repoint must not touch the network");
    };
    expect(await repoint(db, DEAD)).toBeNull();
    expect(asked).toEqual([]);
    expect(stderr.join("")).toContain("already pointed at");
  });
});

describe("and a wrong answer never replaces the old one", () => {
  it("leaves the stored base alone when the new URL is not a JMAP server", async () => {
    const db = freshDb();
    reply = () => new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });

    const failed = await repoint(db, "https://typo.example");
    expect(failed?.code).toBe(3);
    expect(getConfig(db, "base")).toBe(DEAD);
    // The 404 page is named, not pasted (jmap.ts session()).
    expect(failed?.message).toContain("text/html");
    expect(failed?.message).not.toContain("doctype");
  });

  it("tells a rejected token to log in rather than leaving it at 401", async () => {
    const db = freshDb();
    reply = () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    const failed = await repoint(db, LIVE);
    expect(failed?.code).toBe(4);
    expect(failed?.message).toContain("bullmoose login");
    expect(failed?.message).toContain("Nothing was changed");
    expect(getConfig(db, "base")).toBe(DEAD);
  });

  it("refuses a server that does not serve this account, and names what it has", async () => {
    const db = freshDb();
    reply = () => session({ t_other__a_someone: { name: "Someone Else" } });

    const failed = await repoint(db, LIVE);
    expect(failed?.code).toBe(3);
    expect(failed?.message).toContain("t_other__a_someone");
    expect(getConfig(db, "base")).toBe(DEAD);
  });
});

describe("with no --base it re-runs the discovery `login` would run", () => {
  it("adopts what autodiscovery says today, redirect and all", async () => {
    const db = freshDb();
    reply = (url) => {
      if (url.startsWith("https://cloudflare-dns.com/")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://bullmoose.cc/.well-known/jmap") {
        // What the live apex does: 302 to app., which node's fetch follows and
        // reports on `res.url`.
        const res = new Response(null, { status: 401 });
        Object.defineProperty(res, "url", { value: `${LIVE}/.well-known/jmap` });
        return res;
      }
      return session({ [ACCOUNT]: { name: "Eric" } });
    };

    expect(await repoint(db)).toBeNull();
    expect(getConfig(db, "base")).toBe(LIVE);
    expect(stderr.join("")).toContain("redirected the session resource here");
  });
});
