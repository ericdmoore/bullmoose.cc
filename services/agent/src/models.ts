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
  /** Master secret for the credential vault (auth-core sealSecret). */
  VAULT_MASTER_KEY?: string;
}

/** One route a model alias can resolve to. */
export interface ModelCandidate {
  provider: "workers-ai" | "gateway" | "mock";
  model: string;
}

/** agent_bindings.config_json — everything that makes a binding an agent. */
export interface BindingConfig {
  /** "reply" (default — Emily-style) or "ledger" (Allen-style). */
  pipeline?: "reply" | "ledger";
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

const PRICING_KEY = "cache:modelsdev:slim";
const PRICING_MAX_AGE_MS = 48 * 3600_000;

export async function callModel(
  env: Env,
  c: ModelCandidate,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  if (c.provider === "mock") {
    const body = messages[messages.length - 1]?.content ?? "";
    return `[mock markup of your draft]\n${body}\n---\n${body.trim()} (edited)`;
  }

  if (c.provider === "workers-ai") {
    if (!env.AI) throw new Error("Workers AI binding not configured");
    const out = (await env.AI.run(c.model as Parameters<Ai["run"]>[0], {
      messages,
      max_tokens: maxTokens,
    })) as { response?: unknown };
    if (out.response === undefined || out.response === null || out.response === "") {
      throw new Error("empty Workers AI response");
    }
    // When the model emits valid JSON, the runtime can hand back a parsed
    // object instead of text — normalize to a string for every caller.
    return typeof out.response === "string" ? out.response : JSON.stringify(out.response);
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
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty gateway response");
  return content;
}

/** Try each candidate in ranked order; first success wins. */
export async function callWithFallback(
  env: Env,
  candidates: ModelCandidate[],
  messages: ChatMessage[],
  maxTokens: number,
): Promise<{ output: string; used: ModelCandidate }> {
  const errors: string[] = [];
  for (const c of await rankByPrice(env, candidates)) {
    try {
      return { output: await callModel(env, c, messages, maxTokens), used: c };
    } catch (err) {
      errors.push(`${c.provider}/${c.model}: ${String(err).slice(0, 200)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

/** Slim pricing map: "provider/model" → blended $ per M tokens. */
interface PricingCache {
  fetchedAt: number;
  prices: Record<string, number>;
}

export async function rankByPrice(
  env: Env,
  candidates: ModelCandidate[],
): Promise<ModelCandidate[]> {
  if (candidates.length < 2) return candidates;
  const cache = await env.ROUTES.get<PricingCache>(PRICING_KEY, "json");
  if (!cache || Date.now() - cache.fetchedAt > PRICING_MAX_AGE_MS) return candidates;
  // Stable: unknown pricing sorts last, config order breaks ties.
  return candidates
    .map((c, i) => ({ c, i, price: cache.prices[c.model] ?? Number.POSITIVE_INFINITY }))
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
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const cost = model.cost;
      if (cost?.input === undefined && cost?.output === undefined) continue;
      prices[`${providerId}/${modelId}`] = (cost.input ?? 0) + 3 * (cost.output ?? 0);
    }
  }
  const cache: PricingCache = { fetchedAt: Date.now(), prices };
  await env.ROUTES.put(PRICING_KEY, JSON.stringify(cache));
  return { models: Object.keys(prices).length };
}
