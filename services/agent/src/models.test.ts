import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  callModel,
  invocationCost,
  priceMicros,
  rankByPrice,
  refreshPricing,
  type Env,
  type ModelCandidate,
} from "./models";

/**
 * Model routing money-paths: the `.feedback agentic/018` fix (a Workers AI
 * candidate could never hit the "provider/model"-keyed pricing cache, priced
 * to Infinity, and sorted the FREE route LAST), and s07 T5's cost capture —
 * `callModel` returning the usage it always received, and `invocationCost`
 * freezing micro-USD with the NULL-vs-0 split intact: 0 is "known free",
 * NULL is "undetermined", and the two must never collapse.
 */

const PRICING_KEY = "cache:modelsdev:slim";

// The exact mixed alias docs/architecture/ai-surface.md:76-77 tells people to
// build — the config that triggered 018.
const PAID: ModelCandidate = { provider: "gateway", model: "anthropic/claude-opus-4-8" };
const FREE: ModelCandidate = { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };

function seedPricing(
  env: Env,
  cache: {
    fetchedAt?: number;
    prices?: Record<string, number>;
    legs?: Record<string, { input: number; output: number }>;
  },
): Promise<void> {
  return env.ROUTES.put(
    PRICING_KEY,
    JSON.stringify({ fetchedAt: cache.fetchedAt ?? Date.now(), prices: cache.prices ?? {}, ...cache }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("rankByPrice — the free route sorts first (.feedback agentic/018)", () => {
  it("ranks workers-ai FIRST in a mixed alias, not last", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, { prices: { [PAID.model]: 48 } });
    // Paid route deliberately FIRST in config order: before the fix the
    // workers-ai candidate priced to Infinity and a stable sort kept this
    // exact order — the paid route tried first, the free one the fallback.
    const ranked = await rankByPrice(w.env, [PAID, FREE]);
    expect(ranked.map((c) => c.provider)).toEqual(["workers-ai", "gateway"]);
  });

  it("still sorts an unpriceable GATEWAY candidate last", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, { prices: { [PAID.model]: 48 } });
    const unknown: ModelCandidate = { provider: "gateway", model: "acme/unlisted" };
    const ranked = await rankByPrice(w.env, [unknown, PAID]);
    expect(ranked.map((c) => c.model)).toEqual([PAID.model, unknown.model]);
  });

  it("keeps config order when the cache is stale", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, { fetchedAt: Date.now() - 49 * 3600_000, prices: { [PAID.model]: 48 } });
    expect(await rankByPrice(w.env, [PAID, FREE])).toEqual([PAID, FREE]);
  });
});

describe("priceMicros — tokens × $/M IS micro-USD; only the round remains", () => {
  it.each([
    // tokensIn, tokensOut, $/M in, $/M out, expected micro-USD
    [1000, 500, 3, 15, 10_500], // 3000 + 7500 — the plain case
    [1, 1, 0.25, 1.25, 2], // 1.5 rounds up: Math.round, not truncation
    [123, 456, 0.4, 1.6, 779], // 49.2 + 729.6 = 778.8 → 779
    [0, 0, 3, 15, 0], // no tokens, no cost
    [10_000, 10_000, 0, 0, 0], // an explicitly-free model prices to an honest 0
  ])("(%i in, %i out) at ($%d, $%d)/M → %i µ$", (tin, tout, input, output, want) => {
    expect(priceMicros(tin, tout, { input, output })).toBe(want);
  });
});

describe("invocationCost — NULL means undetermined, 0 means genuinely free", () => {
  it("workers-ai is 0 — the free allocation, even with no pricing cache at all", async () => {
    const w = fakeEnv();
    const cost = await invocationCost(w.env, FREE, { tokensIn: 9, tokensOut: 4 });
    expect(cost).toEqual({
      provider: "workers-ai",
      model: FREE.model,
      tokensIn: 9,
      tokensOut: 4,
      costMicros: 0,
    });
  });

  it("prices a gateway run per leg against the cached input/output prices", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, {
      prices: { [PAID.model]: 48 },
      legs: { [PAID.model]: { input: 3, output: 15 } },
    });
    const cost = await invocationCost(w.env, PAID, { tokensIn: 1000, tokensOut: 500 });
    expect(cost.costMicros).toBe(10_500);
  });

  it("an unpriceable model is NULL, never 0", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, { prices: {}, legs: {} });
    const cost = await invocationCost(w.env, PAID, { tokensIn: 1000, tokensOut: 500 });
    expect(cost.costMicros).toBeNull();
    expect(cost.tokensIn).toBe(1000); // the receipt survives even unpriced
  });

  it("usage the provider never reported is NULL tokens and NULL cost", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, { legs: { [PAID.model]: { input: 3, output: 15 } } });
    const cost = await invocationCost(w.env, PAID, undefined);
    expect(cost).toEqual({
      provider: "gateway",
      model: PAID.model,
      tokensIn: null,
      tokensOut: null,
      costMicros: null,
    });
  });

  it("a stale cache books no dollars — same freshness rule as ranking", async () => {
    const w = fakeEnv();
    await seedPricing(w.env, {
      fetchedAt: Date.now() - 49 * 3600_000,
      legs: { [PAID.model]: { input: 3, output: 15 } },
    });
    const cost = await invocationCost(w.env, PAID, { tokensIn: 10, tokensOut: 10 });
    expect(cost.costMicros).toBeNull();
  });
});

describe("callModel returns the usage each provider already sends", () => {
  const messages = [
    { role: "system" as const, content: "be brief" },
    { role: "user" as const, content: "hello there" },
  ];

  it("mock: deterministic pseudo-usage (chars in, chars out)", async () => {
    const w = fakeEnv();
    const { output, usage } = await callModel(w.env, { provider: "mock", model: "m" }, messages, 64);
    expect(usage).toEqual({
      tokensIn: "be brief".length + "hello there".length,
      tokensOut: output.length,
    });
  });

  it("workers-ai: maps the run() usage the old code discarded", async () => {
    const w = fakeEnv();
    w.env.AI = {
      run: async () => ({ response: "ok", usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    } as unknown as Ai;
    const { output, usage } = await callModel(w.env, FREE, messages, 64);
    expect(output).toBe("ok");
    expect(usage).toEqual({ tokensIn: 5, tokensOut: 7 });
  });

  it("gateway: maps the OpenAI-compat usage block", async () => {
    const w = fakeEnv();
    w.env.GATEWAY_COMPAT_URL = "https://gw.example/compat";
    w.env.GATEWAY_TOKEN = "tok";
    vi.stubGlobal("fetch", async () =>
      Response.json({
        choices: [{ message: { content: "reply text" } }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    );
    const { output, usage } = await callModel(w.env, PAID, messages, 64);
    expect(output).toBe("reply text");
    expect(usage).toEqual({ tokensIn: 12, tokensOut: 34 });
  });

  it("gateway: absent usage is undefined — NULL downstream, not zero", async () => {
    const w = fakeEnv();
    w.env.GATEWAY_COMPAT_URL = "https://gw.example/compat";
    w.env.GATEWAY_TOKEN = "tok";
    vi.stubGlobal("fetch", async () => Response.json({ choices: [{ message: { content: "x" } }] }));
    const { usage } = await callModel(w.env, PAID, messages, 64);
    expect(usage).toBeUndefined();
  });
});

describe("refreshPricing keeps the blend for ranking AND the legs for cost", () => {
  it("stores both from one models.dev fetch", async () => {
    const w = fakeEnv();
    vi.stubGlobal("fetch", async () =>
      Response.json({
        anthropic: { models: { "claude-opus-4-8": { cost: { input: 5, output: 25 } } } },
        freebie: { models: { gratis: { cost: { input: 0, output: 0 } } } },
      }),
    );
    expect(await refreshPricing(w.env)).toEqual({ models: 2 });
    const cache = (await w.env.ROUTES.get(PRICING_KEY, "json")) as {
      prices: Record<string, number>;
      legs: Record<string, { input: number; output: number }>;
    };
    expect(cache.prices["anthropic/claude-opus-4-8"]).toBe(80); // 5 + 3×25, the ranking blend
    expect(cache.legs["anthropic/claude-opus-4-8"]).toEqual({ input: 5, output: 25 });
    expect(cache.legs["freebie/gratis"]).toEqual({ input: 0, output: 0 });
  });
});
