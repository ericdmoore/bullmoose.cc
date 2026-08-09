import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorMessage, exitCodeFor } from "./io.js";
import { cmdToken } from "./tokens.js";

// The call site, not just the helper. `token create` used to read
//   opts.scopes ? opts.scopes.split(",") : ["mail"]
// so `bullmoose token create --name popper` — the form the docs themselves
// showed — POSTed {"scopes":["mail"]} without the user ever naming a scope.
//
// So the assertion that matters is about the REQUEST: either the flag was
// given and the body carries exactly it, or no request happens at all.

// sVOL 016 note: failures used to be `console.error` + `process.exit(2)` inside
// the command. They now throw a typed error that main.ts maps to a code from
// the arch.md §1.5 table, so nothing below a command body calls process.exit
// and every failure reaches the same funnel. The assertions are unchanged —
// still exit 2, still zero round trips — only the observation point moved.

const settings = { base: "https://jmap.example.com", token: "bm_test" };
const db = null as unknown as DatabaseSync; // cmdToken never touches it

/** The contract flags, as main.ts threads them in. */
const IO = { json: false, ids: false, dryRun: false };

let posted: Array<{ url: string; body: unknown }>;
let failure: string;

beforeEach(() => {
  posted = [];
  failure = "";
  // The command writes through io.ts now, so silence the streams themselves.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(
      JSON.stringify({ token: "bm_new", tokenId: "tk_new", scopes: ["read"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run `token create` and report the exit code, or null if it completed. */
async function create(opts: { name?: string; scopes?: string }): Promise<number | null> {
  try {
    await cmdToken(db, settings, ["create"], { ...IO, ...opts });
    return null;
  } catch (e) {
    failure = errorMessage(e);
    return exitCodeFor(e);
  }
}

describe("bullmoose token create — --scopes is required", () => {
  it("exits 2 and mints NOTHING when --scopes is omitted", async () => {
    expect(await create({ name: "popper" })).toBe(2);
    expect(posted).toHaveLength(0); // the whole point: no silent ["mail"]
  });

  it("sends exactly the scopes given", async () => {
    expect(await create({ name: "popper", scopes: "read,move" })).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatchObject({ name: "popper", scopes: ["read", "move"] });
  });

  it("exits 2 on an unknown scope without a round trip", async () => {
    expect(await create({ name: "x", scopes: "read,snd" })).toBe(2);
    expect(posted).toHaveLength(0);
  });

  it("exits 2 on an empty --scopes rather than falling back", async () => {
    expect(await create({ name: "x", scopes: "" })).toBe(2);
    expect(posted).toHaveLength(0);
  });

  it("refuses `admin` from the self-service command", async () => {
    expect(await create({ name: "x", scopes: "admin" })).toBe(2);
    expect(posted).toHaveLength(0);
  });

  it("tells the user what the valid scopes are", async () => {
    await create({ name: "x" });
    expect(failure).toContain("--scopes is required");
    expect(failure).toContain("read");
    expect(failure).toContain("contacts");
  });
});

describe("token list / revoke are unaffected", () => {
  it("list needs no scopes", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      posted.push({ url: String(url), body: null });
      return new Response(JSON.stringify({ tokens: [] }), { status: 200 });
    });
    await cmdToken(db, settings, ["list"], { ...IO, json: true });
    expect(posted).toHaveLength(1);
  });
});
