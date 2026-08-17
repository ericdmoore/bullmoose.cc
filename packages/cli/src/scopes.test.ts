import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAIL_SCOPES,
  REALM_SCOPES,
  SCOPE_SUGGESTIONS,
  SELF_SERVICE_SCOPES,
  TOKEN_SCOPES,
  parseScopeFlag,
  scopeHelp,
} from "./scopes.js";

// `--scopes` for every command that mints a token.
//
// The bug: `token create` and `admin token create` read
//   opts.scopes ? opts.scopes.split(",") : ["mail"]
// so the shortest invocation minted the widest credential — and that token
// is the one that gets pasted into third-party mail clients. `required`
// below is that missing word; `login` is the one caller that keeps
// `required: false`, because it must work before you hold any token.

describe("parseScopeFlag — required (token create, admin token create)", () => {
  it("refuses an omitted flag instead of defaulting", () => {
    const r = parseScopeFlag(undefined, SELF_SERVICE_SCOPES, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--scopes is required/);
  });

  it("never silently produces `mail`", () => {
    // The exact regression: any successful parse must trace to the input.
    const r = parseScopeFlag(undefined, SELF_SERVICE_SCOPES, true);
    expect(r.ok && r.scopes).toBeFalsy();
  });

  it("accepts an explicit list", () => {
    expect(parseScopeFlag("read,move", SELF_SERVICE_SCOPES, true)).toEqual({
      ok: true,
      scopes: ["read", "move"],
    });
  });

  it("tolerates whitespace around the commas", () => {
    expect(parseScopeFlag(" read , draft ,send ", SELF_SERVICE_SCOPES, true)).toEqual({
      ok: true,
      scopes: ["read", "draft", "send"],
    });
  });

  it("de-duplicates", () => {
    expect(parseScopeFlag("read,read,move", SELF_SERVICE_SCOPES, true)).toEqual({
      ok: true,
      scopes: ["read", "move"],
    });
  });

  it("rejects an explicitly empty value", () => {
    for (const raw of ["", "   ", ",", " , "]) {
      expect(parseScopeFlag(raw, SELF_SERVICE_SCOPES, true).ok).toBe(false);
    }
  });

  it("catches a typo locally rather than after a round trip", () => {
    const r = parseScopeFlag("read,snd", SELF_SERVICE_SCOPES, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("snd");
  });

  it("reports every unknown scope, once each", () => {
    const r = parseScopeFlag("nope,read,nope,zzz", SELF_SERVICE_SCOPES, true);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("nope, zzz");
  });
});

describe("parseScopeFlag — optional (login only)", () => {
  it("returns undefined for an omitted flag, so the server default applies", () => {
    // Bootstrap: a user with no token must be able to run `login` bare.
    expect(parseScopeFlag(undefined, SELF_SERVICE_SCOPES, false)).toEqual({
      ok: true,
      scopes: undefined,
    });
  });

  it('still rejects an empty value — `--scopes ""` is a typo either way', () => {
    expect(parseScopeFlag("", SELF_SERVICE_SCOPES, false).ok).toBe(false);
  });

  it("still validates the vocabulary when given", () => {
    expect(parseScopeFlag("vualt", SELF_SERVICE_SCOPES, false).ok).toBe(false);
  });

  it("permits widening to a realm — login is the only way to do it", () => {
    expect(parseScopeFlag("mail,contacts,calendar,vault", SELF_SERVICE_SCOPES, false)).toEqual({
      ok: true,
      scopes: ["mail", "contacts", "calendar", "vault"],
    });
  });
});

describe("vocabularies", () => {
  it("keeps `admin` out of the self-service list and in the operator one", () => {
    expect(parseScopeFlag("admin", SELF_SERVICE_SCOPES, true).ok).toBe(false);
    expect(parseScopeFlag("admin", TOKEN_SCOPES, true)).toEqual({ ok: true, scopes: ["admin"] });
  });

  it("accepts every mail verb, every realm, and the `mail` bundle", () => {
    for (const s of [...MAIL_SCOPES, ...REALM_SCOPES, "mail"]) {
      expect(parseScopeFlag(s, SELF_SERVICE_SCOPES, true)).toEqual({ ok: true, scopes: [s] });
    }
  });
});

describe("scopeHelp", () => {
  it("lists the vocabulary and at least one runnable suggestion", () => {
    const help = scopeHelp(SELF_SERVICE_SCOPES);
    expect(help).toContain("read");
    expect(help).toContain("--scopes");
  });

  it("hides suggestions the caller is not allowed to use", () => {
    expect(scopeHelp(["read"])).not.toContain("contacts");
  });

  it("every suggestion is itself valid for the operator vocabulary", () => {
    // A suggestion the parser would reject is worse than no suggestion.
    for (const s of SCOPE_SUGGESTIONS) {
      expect(parseScopeFlag(s.scopes, TOKEN_SCOPES, true).ok).toBe(true);
    }
  });
});

describe("drift guard vs @bullmoose/auth-core", () => {
  // scopes.ts MIRRORS the server vocabulary: the CLI compiles to plain Node
  // under dist/ and cannot import workspace TypeScript, and its tsconfig is
  // Node-typed, so it cannot even `import type` from a workers-typed package.
  //
  // So read the server's source and parse the four declarations out of it.
  // Crude, but it is the only check that actually fails when someone adds a
  // scope on one side — and it reads THIS checkout, not whatever
  // node_modules/@bullmoose happens to be symlinked to.
  const src = readFileSync(new URL("../../auth-core/src/index.ts", import.meta.url), "utf8");

  /** Resolve `export const NAME ... = [...A, "b"]`, following spreads. */
  function coreScopes(name: string, depth = 0): string[] {
    if (depth > 4) throw new Error(`${name}: spread chain too deep`);
    const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
    if (!m?.[1]) throw new Error(`could not find ${name} in auth-core/src/index.ts`);
    const out: string[] = [];
    for (const raw of m[1].split(",")) {
      const item = raw.trim();
      if (item === "") continue;
      const spread = /^\.\.\.([A-Z_]+)$/.exec(item);
      if (spread?.[1]) out.push(...coreScopes(spread[1], depth + 1));
      else out.push(item.replace(/^["']|["']$/g, ""));
    }
    return out;
  }

  it("parses the server source at all (guards the guard)", () => {
    expect(coreScopes("MAIL_SCOPES").length).toBeGreaterThan(0);
  });

  it("matches the server's mail verbs and realms exactly", () => {
    expect([...MAIL_SCOPES]).toEqual(coreScopes("MAIL_SCOPES"));
    expect([...REALM_SCOPES]).toEqual(coreScopes("REALM_SCOPES"));
  });

  it("matches the server's self-service and operator vocabularies", () => {
    expect([...SELF_SERVICE_SCOPES].sort()).toEqual(coreScopes("SELF_SERVICE_SCOPES").sort());
    expect([...TOKEN_SCOPES].sort()).toEqual(coreScopes("TOKEN_SCOPES").sort());
  });

  it("agrees that `admin` is operator-only", () => {
    expect(coreScopes("SELF_SERVICE_SCOPES")).not.toContain("admin");
    expect(coreScopes("TOKEN_SCOPES")).toContain("admin");
  });
});
