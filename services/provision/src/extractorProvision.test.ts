import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

/**
 * POST /extractor (s18 A2) — turns the extraction pass on for ONE human
 * account. The binding lives on the account's OWN mailbox (it reads delivered
 * mail and writes Annotations back — it sends nothing), so there is no book, no
 * allowedSenders, no supervisory grant. Re-running SWAPS the model in place.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "family.test";
const TENANT = "t_fam";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  call: (path: string, body: Record<string, unknown>) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Family", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z1", created_at: 1 }]);
  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  };
  const call = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { db, kv, call };
}

async function seedHuman(h: Harness, localpart = "dad"): Promise<void> {
  const res = await h.call("/accounts", { tenantId: TENANT, domain: DOMAIN, localpart, displayName: localpart });
  expect(res.status).toBe(200);
}

const extractorBinding = (h: Harness) =>
  h.db.query<{ trigger_on: string; config_json: string; recipients_book_id: string | null; enabled: number }>(
    `SELECT trigger_on, config_json, recipients_book_id, enabled FROM agent_bindings WHERE name = 'extractor'`,
  );

describe("POST /extractor", () => {
  it("puts an extract binding on the human's OWN account, defaulting to the OpenRouter MiniMax route", async () => {
    const h = harness();
    await seedHuman(h);

    const res = await h.call("/extractor", { email: `dad@${DOMAIN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: boolean; bindingId: string; model: string };
    expect(body).toMatchObject({ ok: true, created: true, model: "openrouter/minimax/minimax-m3" });

    const rows = extractorBinding(h);
    expect(rows).toHaveLength(1);
    const b = rows[0]!;
    expect(b.trigger_on).toBe("mailbox-delivery"); // fires on the human's inbound mail
    expect(b.recipients_book_id).toBeNull(); // reply-less: it sends nothing
    const cfg = JSON.parse(b.config_json) as {
      pipeline: string;
      defaultModel: string;
      modelAliases: Record<string, Array<{ provider: string; model: string }>>;
    };
    expect(cfg.pipeline).toBe("extract");
    expect(cfg.defaultModel).toBe("extract");
    expect(cfg.modelAliases.extract).toEqual([{ provider: "openrouter", model: "minimax/minimax-m3" }]);
  });

  it("ships CAPPED by default ($2/month) — a paid pipeline is never uncapped", async () => {
    const h = harness();
    await seedHuman(h);
    await h.call("/extractor", { email: `dad@${DOMAIN}` });
    const cfg = JSON.parse(extractorBinding(h)[0]!.config_json) as { budgets: { spendPerMonth: number } };
    expect(cfg.budgets.spendPerMonth).toBe(2_000_000);
  });

  it("budgetMicros overrides the cap (0 = refuse all paid claims)", async () => {
    const h = harness();
    await seedHuman(h);
    await h.call("/extractor", { email: `dad@${DOMAIN}`, budgetMicros: 0 });
    const cfg = JSON.parse(extractorBinding(h)[0]!.config_json) as { budgets: { spendPerMonth: number } };
    expect(cfg.budgets.spendPerMonth).toBe(0);
  });

  it("accepts an explicit model/provider — shop around", async () => {
    const h = harness();
    await seedHuman(h);
    const res = await h.call("/extractor", {
      email: `dad@${DOMAIN}`,
      provider: "workers-ai",
      model: "@cf/qwen/qwen1.5-14b-chat-awq",
    });
    expect(res.status).toBe(200);
    const cfg = JSON.parse(extractorBinding(h)[0]!.config_json) as {
      modelAliases: Record<string, Array<{ provider: string; model: string }>>;
    };
    expect(cfg.modelAliases.extract).toEqual([{ provider: "workers-ai", model: "@cf/qwen/qwen1.5-14b-chat-awq" }]);
  });

  it("re-provisioning SWAPS the model in place, not a second binding", async () => {
    const h = harness();
    await seedHuman(h);
    await h.call("/extractor", { email: `dad@${DOMAIN}` }); // minimax
    const res = await h.call("/extractor", {
      email: `dad@${DOMAIN}`,
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: boolean }).updated).toBe(true);

    const rows = extractorBinding(h);
    expect(rows).toHaveLength(1); // one binding, ever
    const cfg = JSON.parse(rows[0]!.config_json) as {
      modelAliases: Record<string, Array<{ provider: string; model: string }>>;
    };
    expect(cfg.modelAliases.extract).toEqual([{ provider: "openrouter", model: "qwen/qwen-2.5-72b-instruct" }]);
  });

  it("exploreModels append to the menu and switch the frontier on (default rate 0.2)", async () => {
    const h = harness();
    await seedHuman(h);
    await h.call("/extractor", {
      email: `dad@${DOMAIN}`,
      exploreModels: [{ provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }],
    });
    const cfg = JSON.parse(extractorBinding(h)[0]!.config_json) as {
      modelAliases: Record<string, Array<{ provider: string; model: string }>>;
      frontier?: { exploreRate: number };
    };
    expect(cfg.modelAliases.extract).toHaveLength(2);
    expect(cfg.frontier?.exploreRate).toBe(0.2);
  });

  it("no exploreModels → no frontier block — assignment stays off by default", async () => {
    const h = harness();
    await seedHuman(h);
    await h.call("/extractor", { email: `dad@${DOMAIN}` });
    const cfg = JSON.parse(extractorBinding(h)[0]!.config_json) as { frontier?: unknown };
    expect(cfg.frontier).toBeUndefined();
  });

  it("404s for an unknown account — nothing to turn on", async () => {
    const h = harness();
    const res = await h.call("/extractor", { email: `ghost@${DOMAIN}` });
    expect(res.status).toBe(404);
    expect(extractorBinding(h)).toEqual([]);
  });

  it("400s without an email", async () => {
    const h = harness();
    const res = await h.call("/extractor", {});
    expect(res.status).toBe(400);
  });
});
