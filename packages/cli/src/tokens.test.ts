import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdToken } from "./tokens.js";

// The call site, not just the helper. `token create` used to read
//   opts.scopes ? opts.scopes.split(",") : ["mail"]
// so `bullmoose token create --name popper` — the form the docs themselves
// showed — POSTed {"scopes":["mail"]} without the user ever naming a scope.
//
// So the assertion that matters is about the REQUEST: either the flag was
// given and the body carries exactly it, or no request happens at all.

const settings = { base: "https://jmap.example.com", token: "bm_test" };
const db = null as unknown as DatabaseSync; // cmdToken never touches it

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let posted: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  posted = [];
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitError(Number(code ?? 0));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    await cmdToken(db, settings, ["create"], { ...opts, json: false });
    return null;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
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
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    await create({ name: "x" });
    const msg = errors.join("\n");
    expect(msg).toContain("--scopes is required");
    expect(msg).toContain("read");
    expect(msg).toContain("contacts");
  });
});

describe("token list / revoke are unaffected", () => {
  it("list needs no scopes", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      posted.push({ url: String(url), body: null });
      return new Response(JSON.stringify({ tokens: [] }), { status: 200 });
    });
    await cmdToken(db, settings, ["list"], { json: true });
    expect(posted).toHaveLength(1);
  });
});
