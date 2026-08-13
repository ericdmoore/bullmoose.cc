import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { __resetBoundaryBloomCache, rebuildBoundaryBloom } from "./boundary";
import { sweepGraduations } from "./graduationSweep";
import worker, { type Env } from "./index";

/**
 * The graduation sweep (s12 wave 2-C): expensive-stage reject counters +
 * rescue chain rows → graduationDue(DEFAULT_GRADUATION_POLICY: 10 rejects,
 * 0 rescues) → deny-list rows with source 'graduated' and their evidence —
 * and ONE bloom rebuild per sweep, never one per domain.
 *
 * Runs via the ingest worker's `scheduled` hook (the agent worker's cron
 * pattern); tested here by calling the sweep the hook calls.
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_grad";
const DOMAIN = "spamfarm.test";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

function scaffold(): FakeWorker {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT });
  return w;
}

const env = (w: FakeWorker) => ({ DB: w.env.DB, BLOBS: w.env.BLOBS, ROUTES: w.env.ROUTES });

/** N expensive-stage rejects for a domain: counters + one shunt chain row
 * (the chain is how the sweep resolves the domain's tenant). */
function seedRejects(w: FakeWorker, domain: string, n: number): void {
  w.db.seed("deny_counters", [
    { domain, day: "2026-08-12", count: Math.floor(n / 2) },
    { domain, day: "2026-08-13", count: n - Math.floor(n / 2) },
  ]);
  w.db.seed("quarantine_events", [
    {
      account_id: ACCOUNT,
      event: "shunted",
      sender: `bulk@${domain}`,
      domain,
      stage: "bayes@0.99",
      email_id: null,
      actor: null,
      via_message_id: null,
      at: 1000,
    },
  ]);
}

function seedRescue(w: FakeWorker, domain: string): void {
  w.db.seed("quarantine_events", [
    {
      account_id: ACCOUNT,
      event: "rescued",
      sender: `bulk@${domain}`,
      domain,
      stage: "bayes@0.99",
      email_id: null,
      actor: "eric@moore.coffee",
      via_message_id: null,
      at: 2000,
    },
  ]);
}

const denyRow = (w: FakeWorker, domain: string) =>
  w.db.query<{ tenant_id: string; source: string; evidence: string | null }>(
    `SELECT tenant_id, source, evidence FROM domain_deny_list WHERE domain = ?`,
    domain,
  )[0];

const bloomVersion = async (w: FakeWorker): Promise<number | null> =>
  (await w.env.ROUTES.get<{ version: number }>("boundary:bloom:current", "json"))?.version ?? null;

beforeEach(() => __resetBoundaryBloomCache());

describe("sweepGraduations", () => {
  it("graduates at minRejects with the evidence recorded, tenant from the chain", async () => {
    const w = scaffold();
    seedRejects(w, DOMAIN, 10); // DEFAULT_GRADUATION_POLICY.minRejects

    const out = await sweepGraduations(env(w));
    expect(out.graduated).toEqual([DOMAIN]);
    expect(out.bloomRebuilt).toBe(true);
    expect(denyRow(w, DOMAIN)).toEqual({
      tenant_id: TENANT,
      source: "graduated",
      evidence: "10×rejects, 0 rescues",
    });
  });

  it("below the threshold nothing graduates, and the bloom is not touched", async () => {
    const w = scaffold();
    seedRejects(w, DOMAIN, 9);
    const out = await sweepGraduations(env(w));
    expect(out).toEqual({ graduated: [], bloomRebuilt: false });
    expect(w.db.count("domain_deny_list")).toBe(0);
    expect(await bloomVersion(w)).toBeNull();
  });

  it("ONE rescue blocks graduation — end to end, not just in the pure policy", async () => {
    const w = scaffold();
    seedRejects(w, DOMAIN, 40); // volume must not out-shout the human
    seedRescue(w, DOMAIN);
    seedRejects(w, "other-farm.test", 12); // a control domain still graduates

    const out = await sweepGraduations(env(w));
    expect(out.graduated).toEqual(["other-farm.test"]);
    expect(denyRow(w, DOMAIN)).toBeUndefined();
    expect(denyRow(w, "other-farm.test")).toMatchObject({ source: "graduated" });
  });

  it("rebuilds the bloom ONCE per sweep even with several due domains", async () => {
    const w = scaffold();
    await rebuildBoundaryBloom(env(w)); // v1, empty
    expect(await bloomVersion(w)).toBe(1);
    seedRejects(w, DOMAIN, 15);
    seedRejects(w, "other-farm.test", 11);

    const out = await sweepGraduations(env(w));
    expect(out.graduated.sort()).toEqual(["other-farm.test", DOMAIN].sort());
    expect(await bloomVersion(w)).toBe(2); // exactly one rebuild for two adds
  });

  it("never repaints an existing entry: a 'feed' row keeps its source, no rebuild", async () => {
    const w = scaffold();
    w.db.seed("domain_deny_list", [
      { tenant_id: TENANT, domain: DOMAIN, added_at: 1, source: "feed", evidence: null },
    ]);
    seedRejects(w, DOMAIN, 50); // edge rejects keep bumping counters — fine

    const out = await sweepGraduations(env(w));
    expect(out).toEqual({ graduated: [], bloomRebuilt: false });
    expect(denyRow(w, DOMAIN)).toEqual({ tenant_id: TENANT, source: "feed", evidence: null });
    expect(await bloomVersion(w)).toBeNull(); // nothing added → nothing republished
  });

  it("a graduated domain's next message exits at the SMTP edge (the loop closes)", async () => {
    const w = scaffold();
    await w.env.ROUTES.put(
      "route:example.test:ada",
      JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
    );
    seedRejects(w, DOMAIN, 10);
    await sweepGraduations(env(w));

    const res = await worker.fetch(
      new Request(`https://ingest.test/dev/inject?from=bulk%40${DOMAIN}&to=ada@example.test`, {
        method: "POST",
        headers: { "x-internal-token": "internal-test-token" },
        body: "From: bulk@spamfarm.test\r\nSubject: x\r\n\r\nhi",
      }),
      { ...w.env, DEV_INJECT: "1" } as unknown as Env,
      ctx(),
    );
    const out = (await res.json()) as { rejected?: string };
    expect(out.rejected).toBe("550 5.7.1 sender address rejected");
  });

  it("fails open on a shard that predates the s12 tables", async () => {
    const w = scaffold();
    w.db.sqlite.exec("DROP TABLE deny_counters");
    expect(await sweepGraduations(env(w))).toEqual({ graduated: [], bloomRebuilt: false });
  });

  it("runs from the worker's scheduled hook (the agent worker's cron pattern)", async () => {
    const w = scaffold();
    seedRejects(w, DOMAIN, 10);
    await worker.scheduled!(
      {} as ScheduledController,
      w.env as unknown as Env,
      ctx(),
    );
    expect(denyRow(w, DOMAIN)).toMatchObject({ source: "graduated" });
  });
});
