import { parseToken } from "@bullmoose/auth-core";
import { describe, expect, it } from "vitest";
import { TOKEN_SHAPE, checkApiBase, checkToken, isTokenShape } from "./login";

const GOOD = "bm_0123456789ab_" + "0123456789ab".repeat(4);

describe("TOKEN_SHAPE mirrors auth-core", () => {
  // The mirror is a copy of a regex in Worker code the browser cannot import
  // (login.ts explains why). This is the drift check: `parseToken` is the
  // function the SERVER actually gates on, so anything the two disagree about
  // is either a token the door rejects and the server would accept, or worse.
  // Both halves, both directions, at and around every boundary — a mirror
  // tested only at its centre is a mirror that can drift a digit at a time.
  const cases = [
    GOOD,
    "bm_0123456789ab_" + "f".repeat(48),
    "bm_0123456789AB_" + "f".repeat(48), // uppercase id
    "bm_0123456789ab_" + "F".repeat(48), // uppercase secret
    "bm_0123_" + "f".repeat(48), // short id
    "bm_0123456789abcd_" + "f".repeat(48), // long id
    "bm_0123456789ag_" + "f".repeat(48), // non-hex id
    "bm__" + "f".repeat(48), // empty id
    "bm_0123456789ab_", // empty secret
    "bm_0123456789ab_" + "f".repeat(47), // short secret
    "bm_0123456789ab_" + "f".repeat(49), // long secret
    "bm_0123456789ab_" + "g".repeat(48), // non-hex secret
    "bm_0123456789ab" + "f".repeat(48), // missing separator
    "tk_0123456789ab",
    "bm__",
    "",
    "not a token",
  ];

  for (const raw of cases) {
    it(`agrees on ${JSON.stringify(raw.slice(0, 24))}`, () => {
      expect(isTokenShape(raw)).toBe(parseToken(raw) !== null);
    });
  }

  it("accepts surrounding whitespace, exactly as parseToken does", () => {
    // Pasting from a terminal brings a newline with it more often than not,
    // and `parseToken` trims — so refusing here would reject a token the
    // server accepts.
    expect(isTokenShape(`  ${GOOD}\n`)).toBe(true);
    expect(parseToken(`  ${GOOD}\n`)).not.toBeNull();
  });

  it("is anchored at both ends", () => {
    expect(TOKEN_SHAPE.test(`x${GOOD}`)).toBe(false);
    expect(TOKEN_SHAPE.test(`${GOOD}x`)).toBe(false);
  });
});

describe("checkToken says what is wrong", () => {
  it("accepts a real token, trimmed", () => {
    const r = checkToken(` ${GOOD} `);
    expect(r).toEqual({ ok: true, token: GOOD });
  });

  it("names the tk_/bm_ confusion, which is the most likely paste", () => {
    // Every listing shows the id; the token itself is shown once. Someone
    // reaching for "my token" reaches for the thing they can still see.
    const r = checkToken("tk_0123456789ab");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/token id, not the token/);
  });

  it("asks for a token at all when the field is empty", () => {
    expect(checkToken("   ").ok).toBe(false);
  });

  it("says a partial paste is a partial paste, with both lengths", () => {
    const r = checkToken("bm_0123456789ab_abc");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/expected 12 hex characters then 48, got 12 then 3/);
  });

  it("distinguishes non-hex from wrong length", () => {
    const r = checkToken("bm_zzzzzzzzzzzz_" + "z".repeat(48));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/lowercase hex/);
  });

  it("refuses a string that is not a bullmoose token at all", () => {
    const r = checkToken("ghp_deadbeef");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/starts with bm_/);
  });

  it("counts underscores before lengths — bm_a_b_c is its own mistake", () => {
    const r = checkToken("bm_0123456789ab_dead_beef");
    expect(r.ok === false && r.error).toMatch(/exactly two underscores/);
  });
});

describe("checkApiBase", () => {
  it("accepts an https base and drops the trailing slash", () => {
    // FetchJmapClient appends to whatever it is given (JmapClient.ts:135), so
    // "…/" would build "…//.well-known/jmap".
    expect(checkApiBase("https://jmap.test/")).toEqual({ ok: true, base: "https://jmap.test" });
  });

  it("keeps a path prefix, unlike normalizeOrigin", () => {
    expect(checkApiBase("https://edge.test/bullmoose")).toEqual({
      ok: true,
      base: "https://edge.test/bullmoose",
    });
  });

  it("refuses relative, schemeless and non-http values", () => {
    for (const bad of ["/api", "jmap.test", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(checkApiBase(bad).ok, bad).toBe(false);
    }
  });

  it("refuses blank rather than storing an empty base", () => {
    // An empty stored base would collapse to this origin later, which is the
    // same silent misrouting `lib/console/origins.ts` refuses over.
    expect(checkApiBase("  ").ok).toBe(false);
  });
});
