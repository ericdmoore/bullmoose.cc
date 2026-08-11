import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isLoginKey } from "@bullmoose/auth-core";
// @ts-expect-error — plain .mjs debugging aid, deliberately not part of the TS program
import { deriveLoginKey as toolDerive, LOGIN_SALT_LABEL as toolLabel } from "../tools/login-key.mjs";
import { FILES, buildVectors, type VectorFile } from "./vectors";

/**
 * The committed vectors are only worth anything if they are CURRENT. A stale
 * golden file is worse than none: the Go suite goes green against a rule the
 * TypeScript stopped following, and the disagreement surfaces later as "wrong
 * password" or "that token does nothing" — a long way from the cause.
 *
 * So drift is a red build. This regenerates from the live TypeScript and
 * compares bytes; `npm run gen:conformance` is the fix, and it runs this same
 * generator, so the writer and the check cannot themselves diverge.
 *
 * Modelled on `infra/migrations.test.ts` and `infra/envExample.test.ts`, which
 * guard committed artefacts the same way.
 */

const HERE = import.meta.dirname;

// Top-level await, not `beforeAll`: `npm run gen:conformance` writes through
// this same file, and the describe blocks below read the committed bytes while
// COLLECTING. A hook runs after collection, so on a first generation the reads
// would race the writes and fail on a file that is about to exist.
const generated = await buildVectors();
if (process.env.UPDATE_CONFORMANCE === "1") {
  for (const name of FILES) writeFileSync(resolve(HERE, name), generated[name]);
}

const committed = (name: VectorFile): string => {
  const path = resolve(HERE, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

/** The first line that differs, so a 2,379-case file does not print in full. */
function firstDrift(a: string, b: string): string {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      const clip = (s: string | undefined) => (s === undefined ? "<end of file>" : s.trim().slice(0, 160));
      return `line ${i + 1}\n  committed: ${clip(left[i])}\n  generated: ${clip(right[i])}`;
    }
  }
  return "identical line-by-line but not byte-identical — check the trailing newline";
}

describe("conformance vectors are regenerated from the live TypeScript", () => {
  it.each(FILES)("%s matches what the current source derives", (name) => {
    const have = committed(name);
    expect(have, `conformance/${name} is missing — run \`npm run gen:conformance\``).not.toBe("");
    expect(
      have === generated[name],
      `conformance/${name} is stale. Run \`npm run gen:conformance\` and review the diff — ` +
        `if it is unexpected, the TypeScript changed a cross-language contract.\n${firstDrift(have, generated[name])}`,
    ).toBe(true);
  });
});

// The guards below read the COMMITTED files, not the freshly generated ones.
// The check above already proves the two agree; asserting against the bytes on
// disk is what proves the artefact a Go test will actually open is sane, rather
// than proving the generator agrees with itself.

const parse = <T>(name: VectorFile): T => JSON.parse(committed(name)) as T;

describe("login-key.json", () => {
  interface LoginVector {
    name: string;
    email: string;
    password: string;
    saltHex: string;
    loginKey: string;
  }
  interface LoginFile {
    iterations: number;
    saltLabel: string;
    keyBits: number;
    vectors: LoginVector[];
  }
  const file = parse<LoginFile>("login-key.json");
  const byName = new Map(file.vectors.map((v) => [v.name, v]));

  it("records the parameters as well as the outputs", () => {
    // A port can match every key below while stretching 10k times, and would
    // pass until the day a vector is regenerated — see `arch.md` §5.1.
    expect(file.iterations).toBe(600_000);
    expect(file.saltLabel).toBe("bullmoose-login-v1:");
    expect(file.keyBits).toBe(256);
  });

  it("carries every case, each one a 256-bit hex key", () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(7);
    for (const v of file.vectors) {
      expect(isLoginKey(v.loginKey), `${v.name}: not a login key`).toBe(true);
      expect(v.saltHex, `${v.name}: salt`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("proves the lower-casing rule inside the vector set itself", () => {
    // The trap this whole file exists for: get the salt's `toLowerCase` wrong
    // and login fails silently, with a correct password. A Go suite reading
    // these two rows sees the rule without being told it.
    const basic = byName.get("basic");
    const mixed = byName.get("mixed-case-email");
    expect(mixed?.email).not.toBe(basic?.email);
    expect(mixed?.saltHex).toBe(basic?.saltHex);
    expect(mixed?.loginKey).toBe(basic?.loginKey);
  });

  it("is reproduced by tools/login-key.mjs, an independent implementation", async () => {
    // devPlan T1: the debugging aid "becomes the second consumer". It shares no
    // code with auth-core — it is plain Node with no imports, so it can run
    // before a build — which makes it the only thing here that can catch the
    // generator and `deriveLoginKey` being wrong in the same way.
    expect(toolLabel).toBe(file.saltLabel);
    for (const v of file.vectors) {
      expect(await toolDerive(v.email, v.password), `${v.name}`).toBe(v.loginKey);
    }
  }, 30_000);
});

describe("scopes.json", () => {
  interface ScopeFile {
    vocabulary: Record<string, string[]>;
    universe: string[];
    cases: { granted: string[]; required: string; ok: boolean }[];
  }
  const file = parse<ScopeFile>("scopes.json");

  it("is the whole product, not a sample", () => {
    // |lists| = 1 empty + |U| singletons + |U|² pairs; × |U| required.
    const u = file.universe.length;
    expect(file.cases.length).toBe((1 + u + u * u) * u);
    // Guards against the loop degenerating — the same bar
    // `webmail/src/lib/console/scopes.test.ts:49` sets on its in-memory version.
    expect(file.cases.length).toBeGreaterThan(2000);
  });

  it("carries the vocabulary the CLI mirrors, `admin` on the operator side only", () => {
    expect(file.vocabulary.selfServiceScopes).not.toContain("admin");
    expect(file.vocabulary.tokenScopes).toContain("admin");
    expect(file.universe).toContain("nonsense");
  });

  it("pins the rules a fresh implementation gets wrong", () => {
    // Not new assertions about `hasScope` — the byte check above covers that.
    // These say the emitted PRODUCT actually contains the interesting rows, so
    // a future change to the universe cannot quietly drop them.
    const ok = (granted: string[], required: string) =>
      file.cases.find(
        (c) =>
          c.granted.length === granted.length &&
          c.granted.every((g, i) => g === granted[i]) &&
          c.required === required,
      )?.ok;

    // common/001: `mail` is a bundle of the mail verbs, never a wildcard — and
    // `vault` holds third-party provider credentials.
    expect(ok(["mail"], "send")).toBe(true);
    expect(ok(["mail"], "vault")).toBe(false);
    expect(ok(["mail"], "admin")).toBe(false);
    // common/027: any write implies read, and stops there.
    expect(ok(["calendar"], "read")).toBe(true);
    expect(ok(["delete"], "read")).toBe(true);
    expect(ok(["delete"], "send")).toBe(false);
    // Fail closed on an unknown string unless it is held verbatim.
    expect(ok(["nonsense"], "read")).toBe(false);
    expect(ok(["nonsense"], "nonsense")).toBe(true);
    // An empty grant satisfies nothing.
    expect(ok([], "read")).toBe(false);
  });
});

describe("exit-codes.json", () => {
  interface ExitFile {
    exit: Record<string, number>;
    jmapType: Record<string, number>;
    unlistedJmapType: number;
    absentJmapType: number;
  }
  const file = parse<ExitFile>("exit-codes.json");

  it("carries all six codes and the whole JMAP table", () => {
    expect(Object.keys(file.exit).sort()).toEqual([
      "AUTH",
      "CONFLICT",
      "FAIL",
      "NOT_FOUND",
      "OK",
      "USAGE",
    ]);
    // RFC 8620 §3.6.1/§3.6.2/§5.3 plus the RFC 8621 mail SetErrors.
    expect(Object.keys(file.jmapType).length).toBeGreaterThan(30);
  });

  it("maps every JMAP type onto a code that exists", () => {
    const codes = new Set(Object.values(file.exit));
    for (const [type, code] of Object.entries(file.jmapType)) {
      expect(codes.has(code), `${type} → ${code} is not one of EXIT`).toBe(true);
    }
  });

  it("records the fallback, which is half the table's behaviour", () => {
    // "Anything unlisted falls to 1" (io.ts:96). A port that defaulted to 2
    // would satisfy every listed row and still be wrong.
    expect(file.unlistedJmapType).toBe(file.exit.FAIL);
    expect(file.absentJmapType).toBe(file.exit.FAIL);
  });
});
