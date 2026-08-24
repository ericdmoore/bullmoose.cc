/**
 * Model routing shared by the agent pipelines (reply, ledger): the worker
 * Env, binding config shape, alias→candidate resolution ranked by the
 * models.dev slim pricing cache, and the provider call itself.
 *
 * s26 T4 added the one thing that was platform-wide and should not have been:
 * **whose key pays.** A binding may name a Bureau-sealed credential, and then
 * the call authenticates as the TENANT — which is how their provider-side
 * guardrails (OpenRouter's privacy redaction, route allowlists, their own spend
 * caps) come to apply to their agents' traffic without this file knowing those
 * features exist. `credentialFor` holds the resolution order; `viaBureau` holds
 * the hop; `services/bureau/src/byok.ts` holds the authorization argument.
 */

export interface Env {
  /** Where deep links in mailed digests point. Optional; the hosted default. */
  WEBMAIL_ORIGIN?: string;
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
   * OpenRouter (s18 — the paid extractor route). An OpenAI-compatible
   * aggregator: one key reaches every hosted model by its `vendor/model` id
   * (e.g. `minimax/minimax-m3`). A dedicated provider rather than repointing
   * the dormant `gateway` — it names what it is and carries its OWN key, so a
   * future gateway user cannot surprise this route (and vice-versa). Set as a
   * Cloudflare secret: `wrangler secret put OPENROUTER_API_TOKEN`.
   */
  OPENROUTER_API_TOKEN?: string;
  /** Override the OpenRouter base (default https://openrouter.ai/api/v1). */
  OPENROUTER_BASE_URL?: string;
  /**
   * The Bureau (s04 T3a). There is deliberately NO master-key binding on this
   * worker: the credential vault's key was moved to `services/bureau`, so every
   * seal and every unseal is a hop across this binding and the agent worker
   * cannot decrypt anything on its own. See `vault.ts`.
   */
  BUREAU: Fetcher;
  /**
   * The OAuth authorization server (s02 T4). A service binding rather than an
   * `OAUTH_KV` namespace on this worker, deliberately and for the Bureau's
   * reason: this worker runs every MCP tool and reads untrusted email, so
   * binding the store of every issued credential to it would hand an attacker
   * who reaches this worker the token store. Validation is a hop instead.
   */
  OAUTH: Fetcher;
  /**
   * The canonical RFC 8707 resource URI this server answers for, e.g.
   * `https://mcp.bullmoose.cc/mcp` (s02 T1). Optional: it defaults to
   * `<request origin>/mcp`, which is right for every deployment that is
   * reached at the hostname it serves. Set it when a proxy rewrites the
   * origin, because the value MUST equal the URL the user typed into their
   * client exactly — a mismatch makes discovery fail with no useful error.
   */
  MCP_RESOURCE_URI?: string;
  /** The OAuth AS issuing tokens for this resource (s02 T3). Defaults to
   *  `auth.<registrable domain>`. Claude reads only the FIRST entry of
   *  `authorization_servers` and never falls back. */
  OAUTH_ISSUER?: string;
}

/** One route a model alias can resolve to. */
export interface ModelCandidate {
  provider: "workers-ai" | "gateway" | "openrouter" | "mock";
  model: string;
  /**
   * s26 T4 — BYOK. The Bureau credential (`vault_credentials.name`) this ROUTE
   * authenticates with, when the tenant brought their own provider key. Per
   * candidate rather than only per binding because an alias is a portfolio
   * across hosts: one menu may hold a tenant-keyed OpenRouter route and a
   * platform-keyed free Workers AI fallback, and the two must be able to
   * disagree. Absent ⇒ fall back to `BindingConfig.providerCredentials`, then
   * to the platform's env key — the order is in `credentialFor`.
   */
  credRef?: string;
}

/**
 * s26 T5a — frontier assignment. Deterministic per-invocation exploration over
 * an alias menu: with P(exploreRate), a non-primary candidate is rotated to
 * the front, so outcome labels (dismissals, edits, declines) accrue against
 * MORE than one model and Allen's price-quality frontier has data to join.
 * Deterministic by seed (the invocation id) so a retry explores identically —
 * an assignment is a fact about the invocation, not a coin flipped per run.
 * The fallback chain semantics are untouched: exploration reorders the menu,
 * it never shrinks it.
 */
export function chooseArm(
  candidates: ModelCandidate[],
  seed: string,
  exploreRate: number,
): { ordered: ModelCandidate[]; arm: "exploit" | "explore" } {
  if (candidates.length < 2 || exploreRate <= 0) return { ordered: candidates, arm: "exploit" };
  // FNV-1a over the seed — stable, dependency-free, spread enough for buckets.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const roll = (h % 1000) / 1000;
  if (roll >= exploreRate) return { ordered: candidates, arm: "exploit" };
  // Which alternate: a second hash bucket over the non-primary candidates.
  const alt = 1 + (Math.floor(h / 1000) % (candidates.length - 1));
  const ordered = [candidates[alt]!, ...candidates.slice(0, alt), ...candidates.slice(alt + 1)];
  return { ordered, arm: "explore" };
}

/** agent_bindings.config_json — everything that makes a binding an agent. */
export interface BindingConfig {
  /** "reply" (default — Emily-style), "ledger" (Allen-style), "bouncer"
   *  (s12 2-D — the boundary agent's conversational surface, bouncer.ts),
   *  "remind" (s20 wave 2 — the remind@ mail-native Watches door, remind.ts) or
   *  "extract" (s18 A2 — the extraction pass: reads a delivered message and
   *  writes commitment/decision/task Annotations, extract.ts). */
  pipeline?: "reply" | "ledger" | "bouncer" | "remind" | "extract";
  persona?: string; // L1
  replyMode?: "send" | "draft";
  /**
   * s31 rung 3 — STANDING AUTHORITY, granted: when true, bouncer-composed
   * sieve-rule changes skip the pending tray and land pre-decided under the
   * grant (status 'held', the same 5-minute yank window an approval gets,
   * decision.by = "grant:rule-auto-apply"). Given by an explicit PATCH on
   * the binding, never accrued; absent = rung 2, every rule is a proposal.
   */
  ruleAutoApply?: boolean;
  allowedSenders?: string[];
  defaultModel?: string;
  modelAliases?: Record<string, ModelCandidate[]>;
  maxTokens?: number;
  /**
   * s26 T4 — BYOK: provider (host) → Bureau credential handle. The binding-wide
   * default every candidate on that host inherits unless it names its own
   * `credRef`. Written by `POST /provider-keys` (services/provision), read
   * here, and — crucially — re-read by the Bureau, which refuses a credential
   * this config does not name. Only `openrouter` and `gateway` mean anything:
   * `workers-ai` runs on the platform's own account binding and has no key to
   * bring.
   */
  providerCredentials?: Record<string, string>;
  /** s26 T5a — per-invocation exploration over the alias menu. OFF unless set;
   *  applied by pipelines that opt in (extract first — never a tier-3 producer). */
  frontier?: { exploreRate?: number };
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

/**
 * s26 T4 — who the invocation is, for the BYOK hop.
 *
 * Not derived from config, deliberately. The account and binding come from the
 * ROW being worked (`job.account_id`, `job.binding_id`), which is why the
 * Bureau can treat the pair as trustworthy: `config_json` may NAME a
 * credential, but only the runtime can say which tenant the call is for. See
 * `services/bureau/src/byok.ts` for what breaks if this comes from config —
 * short version: binding A could name tenant B's key.
 */
export interface ModelCallContext {
  /** `agent_invocations.account_id` — the tenant this work belongs to. */
  accountId: string;
  /** `agent_invocations.binding_id` — the agent whose config named the key. */
  bindingId: string;
  /** `BindingConfig.providerCredentials`, carried so a candidate that names no
   *  credential of its own can still inherit the binding's. */
  credentials?: Record<string, string>;
}

/**
 * One line for a pipeline to opt in: `modelCallContext(job, cfg)`.
 *
 * `job` is typed structurally (the row shape, not any pipeline's `Job`) so this
 * module goes on depending on nothing above it.
 */
export function modelCallContext(
  job: { account_id: string; binding_id: string },
  cfg: BindingConfig,
): ModelCallContext {
  return {
    accountId: job.account_id,
    bindingId: job.binding_id,
    ...(cfg.providerCredentials ? { credentials: cfg.providerCredentials } : {}),
  };
}

/**
 * **THE RESOLUTION ORDER** (s26 T4), and why it is this way round:
 *
 *   1. the candidate's own `credRef`      — the most specific thing anyone wrote
 *   2. the binding's `providerCredentials[provider]` — the tenant's default
 *   3. the platform's env key             — the FALLBACK, and only when 1 and 2
 *                                           both said nothing
 *
 * Specific-beats-general is the ordinary config rule. The load-bearing part is
 * the LAST step: env is reached only when **nobody named a credential**, never
 * when someone named one that failed to resolve. A missing, revoked, disabled
 * or refused credential RAISES — it does not quietly become "spend the
 * platform's key", which would bill the operator for a tenant's work and, worse,
 * run that tenant's mail through a provider account whose guardrails are not
 * theirs. Silence there defeats the whole point of BYOK: the guardrails ride
 * the key, so the wrong key is the wrong guardrails.
 *
 * Env stays the fallback rather than being removed because the homelab and
 * every single-tenant deployment are the common case: one operator, one
 * OpenRouter key, nothing sealed and nothing granted — no reason to run a
 * credential vault to send a prompt. BYOK is opt-in per binding, and the
 * platform key is what "opt-in" opts in FROM.
 */
export function credentialFor(c: ModelCandidate, ctx?: ModelCallContext): string | null {
  if (c.credRef) return c.credRef;
  return ctx?.credentials?.[c.provider] ?? null;
}

export async function callModel(
  env: Env,
  c: ModelCandidate,
  messages: ChatMessage[],
  maxTokens: number,
  ctx?: ModelCallContext,
): Promise<ModelResult> {
  // A credential can only be applied to a route that authenticates with one.
  // Workers AI runs on this worker's own account binding and `mock` runs
  // nowhere; a `credRef` on either is a config mistake, and a config mistake
  // about WHOSE KEY GETS SPENT is one to say out loud rather than ignore.
  if (c.credRef && (c.provider === "workers-ai" || c.provider === "mock")) {
    throw new Error(`candidate ${c.provider}/${c.model} names credential "${c.credRef}" but takes no key`);
  }

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

  // openrouter — a dedicated OpenAI-compatible route (s18). Same request shape
  // as the gateway below, its own key and base. OpenRouter asks (does not
  // require) an X-Title for its dashboard; we send one and nothing more.
  if (c.provider === "openrouter") {
    const base = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    return chat(env, c, ctx, {
      label: "openrouter",
      url: `${base}/chat/completions`,
      headers: { "content-type": "application/json", "x-title": "bullmoose" },
      body: JSON.stringify({ model: c.model, messages, max_tokens: maxTokens }),
      envToken: env.OPENROUTER_API_TOKEN,
      unconfigured: "OpenRouter not configured (OPENROUTER_API_TOKEN)",
    });
  }

  // gateway — AI Gateway's OpenAI-compatible endpoint; provider prefix in
  // the model string, provider keys stored in the gateway.
  //
  // Note the two different things called BYOK here. The gateway's own is
  // "provider keys stored in the CLOUDFLARE gateway" — the platform's account,
  // one set of keys for everyone. s26 T4's is per TENANT: their key, sealed in
  // the Bureau, carrying their provider-side guardrails. A `credRef` on a
  // gateway candidate replaces the gateway token on the wire, so the tenant's
  // own gateway credential is what authenticates.
  if (!env.GATEWAY_COMPAT_URL) {
    throw new Error("AI Gateway not configured (GATEWAY_COMPAT_URL / GATEWAY_TOKEN)");
  }
  return chat(env, c, ctx, {
    label: "gateway",
    url: `${env.GATEWAY_COMPAT_URL}/chat/completions`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: c.model, messages, max_tokens: maxTokens }),
    envToken: env.GATEWAY_TOKEN,
    unconfigured: "AI Gateway not configured (GATEWAY_COMPAT_URL / GATEWAY_TOKEN)",
  });
}

/** One OpenAI-compatible chat-completions POST, for the two hosts that take a
 *  bearer. The shape is identical; only who authenticates it differs. */
interface ChatPost {
  /** What errors call this host — the string pipelines already grep for. */
  label: "openrouter" | "gateway";
  url: string;
  /** Everything but the credential. The Authorization header is added by
   *  whoever holds the key — this worker for env, the Bureau for BYOK — and is
   *  never composed here, so there is no line of code where both are possible. */
  headers: Record<string, string>;
  body: string;
  /** The platform's key. Step 3 of the resolution order, and only step 3. */
  envToken: string | undefined;
  unconfigured: string;
}

async function chat(
  env: Env,
  c: ModelCandidate,
  ctx: ModelCallContext | undefined,
  post: ChatPost,
): Promise<ModelResult> {
  const credRef = credentialFor(c, ctx);
  const { status, text } = credRef ? await viaBureau(env, ctx, credRef, post) : await viaPlatformKey(post);
  if (status < 200 || status >= 300) {
    // The upstream's own error text, truncated. Nothing this worker holds is
    // interpolated into it: on the BYOK path this worker never held the key,
    // and on the env path the key is not in the response.
    throw new Error(`${post.label} ${status}: ${text.slice(0, 200)}`);
  }
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`${post.label}: unparseable response body`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`empty ${post.label} response`);
  return { output: content, usage: toUsage(data.usage) };
}

/** Step 3 — the platform's own key, on the platform's own wire. */
async function viaPlatformKey(post: ChatPost): Promise<{ status: number; text: string }> {
  if (!post.envToken) throw new Error(post.unconfigured);
  const res = await fetch(post.url, {
    method: "POST",
    headers: { ...post.headers, authorization: `Bearer ${post.envToken}` },
    body: post.body,
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Steps 1–2 — **the tenant's key, which this worker never sees.**
 *
 * The request is handed to the Bureau, which authorizes `(principal, credRef,
 * fetch)`, checks the binding still names the credential and is still enabled,
 * matches the URL against the credential's destination allowlist, unseals,
 * injects the value as a HEADER, and returns only the response. So:
 *
 *   - the key is not in a variable here, request-scoped or otherwise — there is
 *     no route on the Bureau that returns one (`vault.ts`, invariant 1);
 *   - it cannot reach a log, a transcript, `result_json` or an error message,
 *     because the only strings that come back are a status, response headers
 *     and a body the upstream wrote;
 *   - and it cannot be spent anywhere but the origins the credential was sealed
 *     for, whatever URL this worker composes.
 *
 * Every failure here THROWS, and `callWithFallback` records the reason against
 * the invocation. That is the honest degradation the budget gate already has:
 * the work does not happen, the row says why, and nothing wedges. What must
 * never happen is a fall-through to `viaPlatformKey`, and the shape of this
 * function is the guarantee — the caller picked one path or the other before
 * either ran, and neither calls the other.
 */
async function viaBureau(
  env: Env,
  ctx: ModelCallContext | undefined,
  credRef: string,
  post: ChatPost,
): Promise<{ status: number; text: string }> {
  if (!ctx) {
    throw new Error(
      `${post.label}: credential "${credRef}" is named but this call carries no binding context ` +
        `(pass modelCallContext(job, cfg)) — refusing rather than spending the platform key`,
    );
  }
  if (!env.BUREAU) {
    throw new Error(`${post.label}: credential "${credRef}" needs the BUREAU binding, which is not configured`);
  }
  let res: Response;
  try {
    res = await env.BUREAU.fetch("https://bureau.internal/internal/bureau/binding-use", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
      body: JSON.stringify({
        accountId: ctx.accountId,
        bindingId: ctx.bindingId,
        credRef,
        request: { url: post.url, method: "POST", headers: post.headers, body: post.body },
      }),
    });
  } catch (err) {
    throw new Error(`${post.label}: bureau unreachable for credential "${credRef}": ${String(err).slice(0, 160)}`);
  }
  const envelope = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: number;
    body?: string;
    bodyEncoding?: string;
    error?: string;
  };
  if (!res.ok || envelope.ok !== true) {
    // A refusal names the credential and the Bureau's reason — "no live grant",
    // "binding is disabled", "destination … is not in the allowlist". Those are
    // the words an operator needs; none of them is ever a value.
    throw new Error(
      `${post.label}: bureau refused credential "${credRef}" (${res.status}): ` +
        `${String(envelope.error ?? "no reason given").slice(0, 200)}`,
    );
  }
  if (envelope.bodyEncoding !== "text") {
    throw new Error(`${post.label}: bureau returned a non-text body for credential "${credRef}"`);
  }
  return { status: envelope.status ?? 502, text: envelope.body ?? "" };
}

/**
 * Try each candidate in ranked order; first success wins.
 *
 * The BYOK guarantee is **per candidate** (s26 T4): a route that names a
 * credential never silently borrows the platform's key — it fails, and the menu
 * moves on to the NEXT route, which is a different decision an operator wrote
 * down. So a menu of `[byok-openrouter, workers-ai]` degrades to the free tier
 * when the tenant's key is revoked, and a menu of `[byok-openrouter,
 * plain-openrouter]` degrades to the platform key because that is literally
 * what its second line says. Binding-wide `providerCredentials` covers every
 * candidate on that host at once, which is the shape to prefer for exactly this
 * reason.
 *
 * When every candidate fails the joined reasons are thrown, and the pipeline
 * records them on the invocation — honest, not wedged.
 */
export async function callWithFallback(
  env: Env,
  candidates: ModelCandidate[],
  messages: ChatMessage[],
  maxTokens: number,
  ctx?: ModelCallContext,
): Promise<{ output: string; usage?: TokenUsage; used: ModelCandidate }> {
  const errors: string[] = [];
  for (const c of await rankByPrice(env, candidates)) {
    try {
      const { output, usage } = await callModel(env, c, messages, maxTokens, ctx);
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

export async function rankByPrice(env: Env, candidates: ModelCandidate[]): Promise<ModelCandidate[]> {
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
 *
 * **BYOK changes none of this** (s26 T4). Cost is computed from the usage the
 * provider reported and the model's price, and a tenant-keyed call reports the
 * same `usage` object through the Bureau hop as a platform-keyed one does. So a
 * BYOK run still books µUSD against its binding — the dossier's spend history
 * stays complete, and "who paid" is a separate question from "what did this
 * cost", which is the right way round: the tenant's own invoice is the other
 * half, and it lives at their provider.
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
