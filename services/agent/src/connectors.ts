// Connectors — bullmoose as an MCP *client* (#4, the first two).
//
// Being an MCP server has been done since s01/s02. This is the other
// direction: an agent here reaching a service the human already uses. Eric
// picked Google Calendar and Notion first, and the pairing turned out to be
// the right diagnostic — they differ in exactly the way that exposed the
// missing runtime piece:
//
//   Notion            issues a static integration token → the Bureau's
//                     Class A `fetch` verb has handled this since s04 T3.
//   Google Calendar   only issues refresh tokens → needs `oauth_token`,
//                     which answered 501 until this same PR built it.
//
// ## The rule that makes a connector cheap
//
// A connector is DATA, not code: a provider entry names an origin, the
// credential kind it needs, and how to read its pagination. Every request
// goes through the Bureau, so a connector cannot:
//
//   - see the credential (the Bureau injects; the agent names a credRef),
//   - reach a host outside that credential's allowlist (§6, per hop),
//   - follow a redirect off-origin (invariant 4),
//   - exist at all without an operator's grant (`bureau_grants`).
//
// That is why adding provider #3 is an afternoon and why this file has no
// per-provider auth code: there is exactly one way to spend a credential
// here, and it is not in this file.

import type { Env } from "./models.js";

export interface Provider {
  id: string;
  label: string;
  /** The one origin its credential may reach. Mint-time `--allow` must
   *  match; the Bureau enforces, this documents. */
  origin: string;
  /** Which Bureau verb spends this provider's credential. */
  verb: "fetch" | "oauth_token";
  /** Headers every request needs beyond auth — Notion's API version is the
   *  reason this exists: omit it and every call 400s with a message about
   *  a version you did not know you had to pick. */
  headers?: Record<string, string>;
  /** The token endpoint an `oauth-refresh` credential must carry in meta.
   *  Recorded here so `connectors doctor` can say "this credential points
   *  somewhere else" instead of failing at spend time. */
  tokenUrl?: string;
}

export const PROVIDERS: Record<string, Provider> = {
  "google-calendar": {
    id: "google-calendar",
    label: "Google Calendar",
    origin: "https://www.googleapis.com",
    verb: "oauth_token",
    tokenUrl: "https://oauth2.googleapis.com/token",
  },
  notion: {
    id: "notion",
    label: "Notion",
    origin: "https://api.notion.com",
    verb: "fetch",
    // Notion pins behaviour to a DATE, and an unversioned request is
    // refused rather than defaulted. Pinning it here means the connector
    // breaks on a deliberate bump, never on Notion's own schedule.
    headers: { "Notion-Version": "2022-06-28" },
  },
};

export interface ConnectorRequest {
  /** The credential the operator sealed and NAMED IN THE BINDING's config —
   *  the Bureau re-reads that config and refuses a credRef it does not
   *  name, so an agent cannot spend a credential its own binding never
   *  declared. */
  credRef: string;
  /** The binding spending it. Not decoration: `binding-use` authorizes on
   *  (account, binding, credRef), so a connector call outside a binding
   *  context has nothing to authorize and is refused. */
  accountId: string;
  bindingId: string;
  /** Path + query only — the ORIGIN comes from the provider entry, so a
   *  caller cannot point a Notion credential at a different host even
   *  before the Bureau refuses it. */
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

export interface ConnectorResult {
  status: number;
  json: unknown;
}

/**
 * One call, through the Bureau. Returns the provider's response; refusals
 * come back as a status and a body the caller can render, because a
 * connector failing is ordinary (a revoked grant, an expired refresh
 * token) and must not read like the platform breaking.
 */
export async function callProvider(env: Env, providerId: string, req: ConnectorRequest): Promise<ConnectorResult> {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { status: 400, json: { error: `unknown provider "${providerId}"` } };
  }
  if (!env.BUREAU) {
    return { status: 501, json: { error: "no Bureau binding — connectors cannot spend a credential without it" } };
  }
  // The path is joined to the provider's own origin. A caller-supplied
  // absolute URL is refused rather than normalized: "https://evil/..." in a
  // path field is an attempt, not a typo.
  if (/^[a-z]+:\/\//i.test(req.path)) {
    return { status: 400, json: { error: "path must be a path, not an absolute URL" } };
  }
  const url = provider.origin + (req.path.startsWith("/") ? req.path : `/${req.path}`);

  // The SAME door the model calls use (`models.ts` → binding-use): the
  // Bureau authorizes on (account, binding, credRef), re-reads the
  // binding's own config to confirm it names this credential, and picks
  // the VERB from the grant. A connector cannot choose its own verb, which
  // is why `provider.verb` here is documentation of what the operator must
  // grant rather than something this code sends.
  const res = await env.BUREAU.fetch("https://bureau.internal/internal/bureau/binding-use", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify({
      accountId: req.accountId,
      bindingId: req.bindingId,
      credRef: req.credRef,
      request: {
        url,
        method: req.method ?? "GET",
        ...(provider.headers ? { headers: provider.headers } : {}),
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      },
    }),
  });
  const envelope = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: number;
    body?: string;
    bodyEncoding?: string;
    error?: string;
  };
  if (!res.ok || envelope.ok !== true) {
    // The Bureau's own words — "no live grant", "binding is disabled",
    // "destination … is not in the allowlist". Those are what an operator
    // needs, and none of them is ever a value.
    return { status: res.status, json: { error: envelope.error ?? `bureau refused (${res.status})` } };
  }
  if (envelope.bodyEncoding !== "text" || typeof envelope.body !== "string") {
    return { status: 502, json: { error: `${provider.label} returned a non-text body` } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.body);
  } catch {
    return { status: 502, json: { error: `${provider.label} returned a non-JSON body` } };
  }
  return { status: envelope.status ?? 200, json: parsed };
}
