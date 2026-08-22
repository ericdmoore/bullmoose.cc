import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerSieveMethods, sieveCapability } from "./sieve";
import type { RequestContext } from "./common";

// SieveScript/get (RFC 9661, s31 slice 1). The properties under test: a
// client with no rules sees ZERO scripts (not an invented empty one), the
// compiled blob is real and content-addressed, the state moves exactly when
// the rules move, and the capability claims only what the compiler emits.

const ACCOUNT = "t_bm__a_eric";
const TENANT = "t_bm";

function harness() {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  const registry = new MethodRegistry<RequestContext>();
  registerSieveMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  } as RequestContext;
  const get = (args: Record<string, unknown> = {}) =>
    registry.get("SieveScript/get")!({ accountId: ACCOUNT, ...args }, ctx) as Promise<Record<string, unknown>>;
  return { w, get };
}

const RULES = JSON.stringify([
  { id: "r1", all: [{ kind: "contains", field: "from", value: "noisy@example.com" }], action: "reject" },
]);

async function seedRules(w: ReturnType<typeof fakeEnv>, updatedAt = 1700000000000) {
  await w.env.DB.prepare(`INSERT INTO sieve_rules (account_id, rules_json, updated_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, RULES, updatedAt)
    .run();
}

describe("SieveScript/get", () => {
  it("1. no rules row means ZERO scripts — the truth, not an invented empty script", async () => {
    const { get } = harness();
    const res = await get();
    expect(res.list).toEqual([]);
    expect(res.notFound).toEqual([]);
  });

  it("2. the one script, active, with a real content-addressed blob", async () => {
    const { w, get } = harness();
    await seedRules(w);
    const res = await get();
    const list = res.list as Array<{ id: string; blobId: string; isActive: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("boundary");
    expect(list[0]!.isActive).toBe(true);
    // The blob exists and holds compiled Sieve, not JSON. Blobs are pure R2 —
    // there is no blobs table — at mail/{tenant}/{account}/blobs/{id}.
    expect(list[0]!.blobId).toMatch(/^b_[0-9a-f]{64}$/);
    const blob = await w.env.BLOBS.get(`mail/${TENANT}/${ACCOUNT}/blobs/${list[0]!.blobId}`);
    const text = await blob!.text();
    expect(text).toContain('require "fileinto";');
    expect(text).toContain('fileinto "Quarantined";');
    expect(text).toContain('address :all :contains "From" "noisy@example.com"');
  });

  it("3. re-reading lands on the SAME blob — deterministic compile, content-addressed store", async () => {
    const { w, get } = harness();
    await seedRules(w);
    const a = ((await get()).list as Array<{ blobId: string }>)[0]!.blobId;
    const b = ((await get()).list as Array<{ blobId: string }>)[0]!.blobId;
    expect(a).toBe(b);
  });

  it("4. the state IS the ruleset's updated_at — it moves exactly when rules move", async () => {
    const { w, get } = harness();
    await seedRules(w, 1111);
    expect((await get()).state).toBe("1111");
    await w.env.DB.prepare(`UPDATE sieve_rules SET updated_at = 2222 WHERE account_id = ?`).bind(ACCOUNT).run();
    expect((await get()).state).toBe("2222");
  });

  it("5. ids filtering: the known id answers, an unknown one lands in notFound", async () => {
    const { w, get } = harness();
    await seedRules(w);
    const res = await get({ ids: ["boundary", "nope"] });
    expect((res.list as unknown[]).length).toBe(1);
    expect(res.notFound).toEqual(["nope"]);
  });

  it("6. a corrupt rules row degrades to what the ENGINE runs — none", async () => {
    // listSieveRules degrades to no rules on garbage; the script must not
    // claim rules the boundary does not enforce.
    const { w, get } = harness();
    await w.env.DB.prepare(`INSERT INTO sieve_rules (account_id, rules_json, updated_at) VALUES (?, 'not json', 1)`)
      .bind(ACCOUNT)
      .run();
    const res = await get();
    const list = res.list as Array<{ blobId: string }>;
    expect(list).toHaveLength(1); // the row exists, so the script exists
    const text = await (await w.env.BLOBS.get(`mail/${TENANT}/${ACCOUNT}/blobs/${list[0]!.blobId}`))!.text();
    expect(text).not.toContain("if "); // no rules compiled
  });
});

describe("the capability claims only what is real", () => {
  it("10. sieveExtensions is exactly what compileSieve requires", () => {
    const cap = sieveCapability();
    expect(cap.sieveExtensions).toEqual(["fileinto"]);
  });

  it("11. no redirects, no notify, no external lists — because none exist", () => {
    const cap = sieveCapability();
    expect(cap.maxNumberRedirects).toBe(0);
    expect(cap.notificationMethods).toBeNull();
    expect(cap.externalLists).toBeNull();
    expect(cap.maxNumberScripts).toBe(1);
  });
});
