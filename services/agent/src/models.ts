/**
 * Model routing shared by the agent pipelines (reply, ledger): the worker
 * Env, binding config shape, alias→candidate resolution ranked by the
 * models.dev slim pricing cache, and the provider call itself.
 */

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace; // reused for the models.dev pricing cache
  SUBMIT: Fetcher;
  ACCOUNT_DO: DurableObjectNamespace;
  AI?: Ai;
  INTERNAL_TOKEN: string;
  /** AI Gateway OpenAI-compat endpoint, e.g. https://gateway.ai.cloudflare.com/v1/<acct>/bullmoose/compat */
  GATEWAY_COMPAT_URL?: string;
  GATEWAY_TOKEN?: string;
  /**
   * The Bureau (s04 T3a). There is deliberately NO master-key binding on this
   * worker: the credential vault's key was moved to `services/bureau`, so every
   * seal and every unseal is a hop across this binding and the agent worker
   * cannot decrypt anything on its own. See `vault.ts`.
   */
  BUREAU: Fetcher;
}

/** One route a model alias can resolve to. */
export interface ModelCandidate {
  provider: "workers-ai" | "gateway" | "mock";
  model: string;
}

/** agent_bindings.config_json — everything that makes a binding an agent. */
export interface BindingConfig {
  /** "reply" (default — Emily-style), "ledger" (Allen-style) or "bouncer"
   *  (s12 2-D — the boundary agent's conversational surface, bouncer.ts). */
  pipeline?: "reply" | "ledger" | "bouncer";
  persona?: string; // L1
  replyMode?: "send" | "draft";
  allowedSenders?: string[];
  defaultModel?: string;
  modelAliases?: Record<string, ModelCandidate[]>;
  maxTokens?: number;
  // ---- ledger pipeline ----
  /** Default digest recipient. */
  digestTo?: string;
  /** Plus-tag → digest recipient. The tag SELECTS; it never builds an address. */
  digestTargets?: Record<string, string>;
  /** Require an Authentication-Results spf/dkim pass before ledger writes (default true). */
  requireAuth?: boolean;
  /** Category vocabulary offered to the extractor. */
  categories?: string[];
  /** Data points needed before digests include the chart (default 10). */
  chartMinPoints?: number;
}

export type ChatMessage = { role: "system" | "user"; content: string };

/** Token counts as the provider reported them, when it reported them at all. */
export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/** What one model call produced. `usage` absent = the provider said nothing. */
export interface ModelResult {
  output: string;
  usage?: TokenUsage;
}

const PRICING_KEY = "cache:modelsdev:slim";
const PRICING_MAX_AGE_MS = 48 * 3600_000;

/**
 * Both providers report usage in the OpenAI shape ({prompt_tokens,
 * completion_tokens}) — the gateway because its compat endpoint IS OpenAI's
 * schema, Workers AI because its text-generation output mirrors it. Missing or
 * partial counts map to `undefined`, never to 0: absent usage must land as
 * NULL cost downstream (s07 T5), not as a flattering zero.
 */
function toUsage(u?: { prompt_tokens?: number; completion_tokens?: number }): TokenUsage | undefined {
  return typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number"
    ? { tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens }
    : undefined;
}

export async function callModel(
  env: Env,
  c: ModelCandidate,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ModelResult> {
  if (c.provider === "mock") {
    const body = messages[messages.length - 1]?.content ?? "";
    const output = `[mock markup of your draft]\n${body}\n---\n${body.trim()} (edited)`;
    // Deterministic pseudo-usage (chars in ≈ tokens in) so cost capture is
    // testable end-to-end without a provider.
    return {
      output,
      usage: {
        tokensIn: messages.reduce((n, m) => n + m.content.length, 0),
        tokensOut: output.length,
      },
    };
  }

  if (c.provider === "workers-ai") {
    if (!env.AI) throw new Error("Workers AI binding not configured");
    const out = (await env.AI.run(c.model as Parameters<Ai["run"]>[0], {
      messages,
      max_tokens: maxTokens,
    })) as {
      response?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (out.response === undefined || out.response === null || out.response === "") {
      throw new Error("empty Workers AI response");
    }
    // When the model emits valid JSON, the runtime can hand back a parsed
    // object instead of text — normalize to a string for every caller.
    return {
      output: typeof out.response === "string" ? out.response : JSON.stringify(out.response),
      usage: toUsage(out.usage),
    };
  }

  // gateway — AI Gateway's OpenAI-compatible endpoint; provider prefix in
  // the model string, provider keys stored in the gateway (BYOK).
  if (!env.GATEWAY_COMPAT_URL || !env.GATEWAY_TOKEN) {
    throw new Error("AI Gateway not configured (GATEWAY_COMPAT_URL / GATEWAY_TOKEN)");
  }
  const res = await fetch(`${env.GATEWAY_COMPAT_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GATEWAY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: c.model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty gateway response");
  return { output: content, usage: toUsage(data.usage) };
}

/** Try each candidate in ranked order; first success wins. */
export async function callWithFallback(
  env: Env,
  candidates: ModelCandidate[],
  messages: ChatMessage[],
  maxTokens: number,
): Promise<{ output: string; usage?: TokenUsage; used: ModelCandidate }> {
  const errors: string[] = [];
  for (const c of await rankByPrice(env, candidates)) {
    try {
      const { output, usage } = await callModel(env, c, messages, maxTokens);
      return { output, usage, used: c };
    } catch (err) {
      errors.push(`${c.provider}/${c.model}: ${String(err).slice(0, 200)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

/** One model's $ per M tokens, each direction its own price. */
interface PriceLegs {
  input: number;
  output: number;
}

/**
 * Slim pricing map, keyed "provider/model": `prices` is the blended figure
 * used for ranking; `legs` (s07 T5) keeps input/output separate so recorded
 * cost is computed per leg, not from the ranking blend. Optional because a
 * cache written before T5 lacks it — cost then lands NULL until the next
 * refresh, which is honest ("undetermined"), where a blended fallback would
 * quietly triple-charge the output leg.
 */
interface PricingCache {
  fetchedAt: number;
  prices: Record<string, number>;
  legs?: Record<string, PriceLegs>;
}

export async function rankByPrice(
  env: Env,
  candidates: ModelCandidate[],
): Promise<ModelCandidate[]> {
  if (candidates.length < 2) return candidates;
  const cache = await env.ROUTES.get<PricingCache>(PRICING_KEY, "json");
  if (!cache || Date.now() - cache.fetchedAt > PRICING_MAX_AGE_MS) return candidates;
  // Workers AI runs on the account's free allocation, and its `@cf/...` ids
  // can never equal a models.dev "provider/model" key, so a cache lookup is
  // Infinity forever — which sorted the FREE route last (.feedback
  // agentic/018, inverting every doc). Price it 0 by policy: "free" holds
  // within the allocation and is metered past it, so this encodes "prefer
  // the free tier", not a market price.
  const priceOf = (c: ModelCandidate) =>
    c.provider === "workers-ai" ? 0 : (cache.prices[c.model] ?? Number.POSITIVE_INFINITY);
  // Stable: unknown gateway pricing sorts last, config order breaks ties.
  return candidates
    .map((c, i) => ({ c, i, price: priceOf(c) }))
    .sort((a, b) => a.price - b.price || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Rebuild the slim pricing cache from models.dev. Input weighted 1:3
 * against output — agent replies are output-heavy.
 */
export async function refreshPricing(env: Env): Promise<{ models: number }> {
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) throw new Error(`models.dev ${res.status}`);
  const catalog = (await res.json()) as Record<
    string,
    { models?: Record<string, { cost?: { input?: number; output?: number } }> }
  >;
  const prices: Record<string, number> = {};
  const legs: Record<string, PriceLegs> = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const cost = model.cost;
      if (cost?.input === undefined && cost?.output === undefined) continue;
      prices[`${providerId}/${modelId}`] = (cost.input ?? 0) + 3 * (cost.output ?? 0);
      legs[`${providerId}/${modelId}`] = { input: cost.input ?? 0, output: cost.output ?? 0 };
    }
  }
  const cache: PricingCache = { fetchedAt: Date.now(), prices, legs };
  await env.ROUTES.put(PRICING_KEY, JSON.stringify(cache));
  return { models: Object.keys(prices).length };
}

// ---- invocation cost (s07 T5) ----------------------------------------

/**
 * What `finish()` stamps onto the invocation row when it completes. The cost
 * is FROZEN here — an accounting fact that must not drift when the pricing
 * map moves — and tokens/provider/model are kept beside it as the receipt.
 */
export interface InvocationCost {
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Micro-USD (1 USD = 1,000,000). 0 = genuinely free; null = undetermined. */
  costMicros: number | null;
}

/**
 * tokens × ($ per M tokens) = micro-USD exactly: the "per million" in the
 * price and the "millionth of a dollar" in micros cancel, so the only
 * arithmetic beyond two multiplies is the final round.
 */
export function priceMicros(tokensIn: number, tokensOut: number, legs: PriceLegs): number {
  return Math.round(tokensIn * legs.input + tokensOut * legs.output);
}

/**
 * The NULL-vs-0 split is the point (s07 T5): 0 means known and genuinely
 * free (Workers AI's allocation — the same policy `rankByPrice` sorts by);
 * null means undetermined — usage the provider never reported, or a model
 * the pricing cache cannot price — and must render "not recorded", never $0.
 */
export async function invocationCost(
  env: Env,
  used: ModelCandidate,
  usage: TokenUsage | undefined,
): Promise<InvocationCost> {
  const tokensIn = usage?.tokensIn ?? null;
  const tokensOut = usage?.tokensOut ?? null;
  const base = { provider: used.provider, model: used.model, tokensIn, tokensOut };
  if (used.provider === "workers-ai") return { ...base, costMicros: 0 };
  if (tokensIn === null || tokensOut === null) return { ...base, costMicros: null };
  // Same freshness rule as rankByPrice: a cache too stale to rank by is too
  // stale to book dollars against.
  const cache = await env.ROUTES.get<PricingCache>(PRICING_KEY, "json");
  const fresh = cache && Date.now() - cache.fetchedAt <= PRICING_MAX_AGE_MS;
  const legs = fresh ? cache.legs?.[used.model] : undefined;
  return { ...base, costMicros: legs ? priceMicros(tokensIn, tokensOut, legs) : null };
}
