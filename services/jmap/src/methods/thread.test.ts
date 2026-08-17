import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerThreadMethods } from "./thread";
import type { RequestContext } from "./common";

/**
 * `Thread/changes` — sVOL 027.
 *
 * The unit was graded I0 ("may never be worth building") on the assumption that
 * building it meant COMPUTING thread deltas. It does not: RFC 8620 §5.2 lets a
 * server answer `cannotCalculateChanges`, and RFC 8621 §3.2 requires the method
 * to exist. So the cell is closed by the conformant answer, not by tracking
 * state nothing asks for.
 *
 * What these tests pin is that the three possible answers are NOT
 * interchangeable:
 *
 *   unknownMethod          — "this server does not speak RFC 8621 §3.2"; a
 *                            strict client may treat the session as broken.
 *   cannotCalculateChanges — "re-query instead"; a path every client already has.
 *   an empty delta         — a LIE the client cannot detect, and the one answer
 *                            that must never appear (filenode.ts:117's reasoning).
 */

const ACCOUNT = "t_bullmoose__a_thread";
const TENANT = "t_bullmoose";

function harness(scopes: string[] = ["read"]) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerThreadMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = (method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<Record<string, unknown>>;
  return { w, call };
}

/** The thrown MethodError's type, or the sentinel if it did not throw. */
async function errorType(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(did not throw)";
  } catch (err) {
    return (err as { type?: string }).type ?? String(err);
  }
}

describe("Thread/changes answers conformantly rather than being absent", () => {
  it("is REGISTERED — an absent method answers unknownMethod, which is a different claim", () => {
    const { call } = harness();
    void call;
    const registry = new MethodRegistry<RequestContext>();
    registerThreadMethods(registry);
    expect(registry.get("Thread/changes")).toBeTypeOf("function");
  });

  it("returns cannotCalculateChanges", async () => {
    const { call } = harness();
    expect(await errorType(call("Thread/changes", { accountId: ACCOUNT, sinceState: "0" }))).toBe(
      "cannotCalculateChanges",
    );
  });

  it("never returns an empty delta — the one answer a client cannot detect as false", async () => {
    const { call } = harness();
    const outcome = await call("Thread/changes", { accountId: ACCOUNT, sinceState: "0" }).catch(
      (e) => e as Record<string, unknown>,
    );
    expect(outcome).not.toHaveProperty("created");
    expect(outcome).not.toHaveProperty("updated");
    expect(outcome).not.toHaveProperty("destroyed");
  });

  it("gates on account access BEFORE deciding what to say", async () => {
    const { call } = harness();
    // Another account must not learn that this method would have said
    // cannotCalculateChanges — the gate runs first, so the answer differs.
    expect(await errorType(call("Thread/changes", { accountId: "t_other__a_nope", sinceState: "0" }))).not.toBe(
      "cannotCalculateChanges",
    );
  });

  it("refuses a principal without the read scope", async () => {
    const { call } = harness([]);
    expect(await errorType(call("Thread/changes", { accountId: ACCOUNT, sinceState: "0" }))).not.toBe(
      "cannotCalculateChanges",
    );
  });
});
