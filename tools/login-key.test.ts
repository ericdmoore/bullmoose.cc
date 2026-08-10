import { describe, expect, it } from "vitest";
import { deriveLoginKey as real, LOGIN_KEY_ITERATIONS, isLoginKey } from "@bullmoose/auth-core";
// @ts-expect-error — plain .mjs debugging aid, deliberately not part of the TS program
import { deriveLoginKey as tool, LOGIN_KEY_ITERATIONS as toolIters } from "./login-key.mjs";

/**
 * `tools/login-key.mjs` exists so a human can curl `/auth/login`, which takes a
 * client-derived key and never a password. A debugging aid that silently
 * disagrees with the real derivation is worse than none: it produces a valid-
 * SHAPED key, so the endpoint answers a plain 401 and the reader concludes
 * their credentials are wrong.
 */
describe("tools/login-key.mjs agrees with auth-core", () => {
  it("derives the same key for the same inputs", async () => {
    const [a, b] = await Promise.all([
      real("Eric@Bullmoose.CC", "correct horse battery staple"),
      tool("Eric@Bullmoose.CC", "correct horse battery staple"),
    ]);
    expect(b).toBe(a);
    expect(isLoginKey(b)).toBe(true);
  });

  it("lower-cases the email into the salt, exactly as the server does", async () => {
    // handleLogin lower-cases the email before lookup, so the salt must too or
    // a capitalised address derives a key that can never match what was stored.
    const [upper, lower] = await Promise.all([tool("ERIC@X.CC", "pw"), tool("eric@x.cc", "pw")]);
    expect(upper).toBe(lower);
  });

  it("carries the same iteration count — the cost IS the contract", async () => {
    expect(toolIters).toBe(LOGIN_KEY_ITERATIONS);
  });
});
