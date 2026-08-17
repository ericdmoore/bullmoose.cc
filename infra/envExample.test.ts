import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — bootstrap is plain .mjs, deliberately outside the TS program
import { GENERATED, EXTERNAL } from "./bootstrap.mjs";

/**
 * `.env.example` is the committed, value-free shape of `.env`.
 *
 * It only earns its place if it is COMPLETE. An example missing a key is worse
 * than no example: someone fills in everything they can see, runs `secrets`,
 * and gets a "missing required" warning for a name they were never told about
 * — or worse, a silent skip. So this asserts the example lists every key
 * bootstrap actually knows, in both directions.
 */
const ROOT = resolve(import.meta.dirname, "..");
const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");

/** Keys the example declares, ignoring commentary. */
const declared = new Set(
  example
    .split("\n")
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l.trim())?.[1])
    .filter((k): k is string => Boolean(k)),
);

describe(".env.example covers every secret bootstrap knows", () => {
  it("declares every GENERATED key", () => {
    const missing = Object.keys(GENERATED).filter((k) => !declared.has(k));
    expect(missing, `.env.example is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares every EXTERNAL key", () => {
    const missing = Object.keys(EXTERNAL).filter((k) => !declared.has(k));
    expect(missing, `.env.example is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares nothing bootstrap does not know, except the local-convenience block", () => {
    // The reverse direction, which is the one that rots: a key deleted from
    // bootstrap lingers in the example and someone dutifully fills it in.
    const known = new Set([...Object.keys(GENERATED), ...Object.keys(EXTERNAL)]);
    const localOnly = new Set(["CLOUDFLARE_ACCOUNT_ID", "INGEST"]);
    const orphans = [...declared].filter((k) => !known.has(k) && !localOnly.has(k));
    expect(
      orphans,
      `not a bootstrap secret and not documented as local-only: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("holds no values — it is committed", () => {
    // The whole reason this file can be in git.
    const withValues = example.split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=.+/.test(l.trim()));
    expect(withValues, `.env.example must not carry values: ${withValues.join(" | ")}`).toEqual([]);
  });
});
