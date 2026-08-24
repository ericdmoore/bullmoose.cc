import {
  destinationAllowed,
  parseDestination,
  parseHeaderRecipe,
  readAllowlist,
  renderHeaderValue,
  type AllowEntry,
} from "./binding.js";
import type { Env } from "./models.js";
import { openCredential } from "./vault.js";

/**
 * **Class A — `bureau.fetch`** (bureau.md §3, §4). The one proxy verb, and the
 * only place in the system where a credential is applied to a request.
 *
 * §1's contract in one function: a NAME goes in, a RESULT comes back. The agent
 * composes a request; the Bureau decides whether it is legal, unseals the
 * credential in-process, puts it on the wire itself, and hands back only the
 * response. The caller never learns the value, never names it, and never names
 * the header it goes in.
 *
 * Class A is the strongest of the two classes precisely because the caller ends
 * up holding **nothing** — which is also why it is the right shape for
 * bearer-type credentials, the ones that cannot bind themselves (§3). A SigV4
 * signature is worthless replayed at `evil.com`; an API key is not, so the
 * binding has to be imposed from outside, here.
 *
 * Order of operations, and it is load-bearing:
 *
 *   1. parse and vet the destination           ← still holding nothing
 *   2. read the allowlist, fail closed         ← still holding nothing
 *   3. match scheme+host+port exactly (§6)     ← still holding nothing
 *   4. parse the header recipe                 ← still holding nothing
 *   5. UNSEAL                                  ← first moment a secret exists
 *   6. inject, send, re-check on every hop
 *   7. render the result through ONE seam
 *
 * Every refusal above step 5 costs a decryption that never happened, and the
 * secret's lifetime is the shortest window in which the work can be done.
 */

/** What the caller composes. Note what is NOT here: no header name, no
 *  allowlist, no transform. §2 — the Bureau implements the permutation, callers
 *  only name it. Anything on this interface is something an attacker who owns
 *  the agent's prompt also controls, so it is kept to the minimum a proxy needs. */
export interface FetchArgs {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}

/** The credential's identity and §5 contract, as `authorizeUse` handed them
 *  back. Metadata only — the secret is fetched here, not passed in. */
export interface CredentialRef {
  principalId: string;
  credRef: string;
  kind: string;
  meta: Record<string, unknown>;
}

/**
 * **The T4 seam.** Egress redaction (§7, invariant 7) is a chokepoint in this
 * response path and lands as a replacement for `passthrough` — it receives the
 * response text plus the exact list of values this request put on the wire, so
 * it can scrub against a precise value list rather than guessing.
 *
 * It is a parameter rather than an inline branch for the reason §7 gives:
 * "enforce by wiring, not rule". There is exactly one place a Bureau result
 * crosses back to a caller, and this is its only text-shaped exit.
 */
export type EgressFilter = (text: string, injected: readonly string[]) => string;

const passthrough: EgressFilter = (text) => text;

/** Hop-by-hop headers plus the ones the platform owns. Dropped from what the
 *  caller sends and from what the caller receives — forwarding them is
 *  meaningless at best and confusing at worst. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/** Bounded, because a redirect loop inside one allowlisted origin is still a
 *  loop, and the Bureau holds a secret for the duration. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface FetchVerbOptions {
  /** Injected so tests can drive a fake upstream, per devPrinciples' "clients
   *  are always passed in". Defaults to the platform's. */
  fetchImpl?: typeof fetch;
  /** T4 replaces this. */
  redact?: EgressFilter;
  /**
   * The already-unsealed secret to inject, INSTEAD of opening the named
   * credential (s04 T5, `oauth_token`).
   *
   * The OAuth verb has to spend a short-lived ACCESS token while the sealed
   * value is the long-lived REFRESH token — so it cannot let this function
   * unseal, and it must not grow a second proxy implementation either
   * (invariant 4's redirect discipline, the allowlist re-check per hop and
   * the single exit all live here and must have exactly one home). This is
   * the narrow seam that lets the one runtime serve both: everything else —
   * destination, allowlist, recipe, redaction — is unchanged.
   *
   * Bureau-internal by construction: `handle()` never reads it from a
   * request body, so no caller can supply a secret of their own.
   */
  secretOverride?: string;
}

export async function runFetchVerb(
  env: Env,
  cred: CredentialRef,
  rawArgs: unknown,
  options: FetchVerbOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const redact = options.redact ?? passthrough;
  const args = (rawArgs ?? {}) as FetchArgs;

  // 1 — the destination, parsed and structurally vetted.
  const dest = parseDestination(args.url);
  if (!dest.ok) return refuse(400, dest.reason);

  // 2 — the binding itself. Invariant 5: no allowlist, no use.
  const allow = readAllowlist(cred.meta);
  if (!allow.ok) return refuse(403, `credential "${cred.credRef}": ${allow.reason}`);

  // 3 — §6, the primary control.
  if (!destinationAllowed(dest.url, allow.entries)) {
    return refuse(403, `destination ${dest.url.origin} is not in the allowlist for "${cred.credRef}"`);
  }

  // 4 — where the value goes. A credential with no recipe cannot be injected
  // header-only, and there is no other way to inject it (invariant 8), so this
  // is another fail-closed branch rather than a fallback to something clever.
  const recipe = parseHeaderRecipe(cred.meta.header);
  if (!recipe) {
    return refuse(403, `credential "${cred.credRef}" has no valid header injection recipe`);
  }

  const method = normalizeMethod(args.method);
  if (!method) return refuse(400, `unsupported method: ${String(args.method)}`);

  const callerHeaders = readCallerHeaders(args.headers, recipe.name);
  if (!callerHeaders.ok) return refuse(400, callerHeaders.reason);

  if (args.body !== undefined && typeof args.body !== "string") {
    return refuse(400, "body must be a string");
  }

  // 5 — the first moment a secret exists in this process. `secretOverride`
  // is the OAuth verb having already done the unsealing (and the exchange);
  // every other path opens the sealed value here.
  const secret = options.secretOverride ?? (await openCredential(env, cred.principalId, cred.credRef))?.secret;
  if (secret === undefined) return refuse(404, `no credential named ${cred.credRef}`);
  const headerValue = renderHeaderValue(recipe, secret);
  if (!headerValue) {
    return refuse(403, `credential "${cred.credRef}" does not render a valid header value`);
  }

  // 6 — send, following only redirects that keep the same origin, and
  // re-checking the allowlist at every hop.
  const sent = await send({
    fetchImpl,
    url: dest.url,
    method,
    headers: callerHeaders.headers,
    body: typeof args.body === "string" ? args.body : undefined,
    inject: { name: recipe.name, value: headerValue },
    entries: allow.entries,
  });
  if (!sent.ok) return refuse(sent.status, sent.reason);

  // 7 — the single exit. The secret is handed to the seam, not to the
  // caller: T4 needs to know what to scrub, and this is where it will.
  return renderResult(sent.response, [secret], sent.hops, redact);
}

interface SendPlan {
  fetchImpl: typeof fetch;
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
  inject: { name: string; value: string };
  entries: readonly AllowEntry[];
}

type SendOutcome = { ok: true; response: Response; hops: number } | { ok: false; status: 403 | 502; reason: string };

/**
 * **Invariant 4 — the sharp edge (§6.3).**
 *
 * `redirect: "manual"` is the whole point. Letting the platform follow a 302
 * would carry the injected header to wherever the upstream pointed, which is
 * bypass-by-trusted-server: an allowlisted host that has been compromised, or is
 * merely sloppy with an open redirect, becomes a credential exfiltration
 * endpoint and the allowlist never notices. This is the same reason `curl` drops
 * auth across hosts without `--location-trusted`.
 *
 * The rule implemented is the strict reading of invariant 4: **any origin change
 * ends the call.** Not "follow it without the header" — that would make the
 * Bureau a general-purpose relay that fetches attacker-chosen URLs on an agent's
 * behalf and returns the body, which is a different hole in the same wall. The
 * caller gets a refusal naming both origins, so a legitimate redirect is a
 * one-line `--allow` change by an operator rather than something the runtime
 * decides on its own.
 *
 * Same-origin hops are re-checked against the allowlist anyway. That check
 * cannot fail — the origin is unchanged and it passed a moment ago — and it is
 * there because a control that holds by argument is one refactor away from not
 * holding at all.
 */
async function send(plan: SendPlan): Promise<SendOutcome> {
  let url = plan.url;
  let method = plan.method;
  let body = plan.body;

  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    if (!destinationAllowed(url, plan.entries)) {
      return {
        ok: false,
        status: 403,
        reason: `destination ${url.origin} is not in the allowlist`,
      };
    }

    const headers = new Headers(plan.headers);
    headers.set(plan.inject.name, plan.inject.value);

    let response: Response;
    try {
      response = await plan.fetchImpl(url.toString(), {
        method,
        headers,
        ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
        redirect: "manual",
      });
    } catch (err) {
      return { ok: false, status: 502, reason: `upstream request failed: ${errorText(err)}` };
    }

    const location = REDIRECT_STATUS.has(response.status) ? response.headers.get("location") : null;
    // A 3xx with no Location is not a redirect, it is just a response.
    if (location === null) return { ok: true, response, hops };

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return {
        ok: false,
        status: 502,
        reason: `upstream sent an unparseable Location: ${location}`,
      };
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      return { ok: false, status: 502, reason: `refusing a redirect to scheme ${next.protocol}` };
    }
    if (next.origin !== url.origin) {
      return {
        ok: false,
        status: 502,
        reason:
          `refusing to follow a redirect that changes origin (${url.origin} → ${next.origin}); ` +
          `the credential was not sent to ${next.origin}`,
      };
    }

    // 303 always, and 301/302 by long-standing practice, degrade to GET.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    url = next;
  }

  return { ok: false, status: 502, reason: `too many redirects (>${MAX_REDIRECTS})` };
}

/**
 * The result, and nothing else.
 *
 * Buffered rather than streamed — bureau.md open question 2 leaves that open,
 * and T4 has to read the body to scrub it, so a stream would have to be
 * collected here anyway.
 *
 * Text-ish bodies come back as text and are the ones the T4 filter sees;
 * everything else is base64 and passes through with header inspection only,
 * which is §7's own instruction ("stream binary through … or large file
 * responses break"). Decoding a PNG as UTF-8 to look for a secret would corrupt
 * the PNG and find nothing.
 *
 * `set-cookie` is dropped on the way out. A session cookie minted for the Bureau
 * by an allowlisted host is a bearer-shaped artifact the caller was never
 * granted and cannot legitimately replay, and handing it over would be invariant
 * 1 leaking through a side door.
 */
async function renderResult(
  upstream: Response,
  injected: readonly string[],
  hops: number,
  redact: EgressFilter,
): Promise<Response> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "set-cookie") return;
    headers[lower] = value;
  });

  const textish = isTextish(upstream.headers.get("content-type"));
  const buffer = await upstream.arrayBuffer();
  const body = textish ? redact(new TextDecoder().decode(buffer), injected) : base64(buffer);

  return json({
    ok: true,
    status: upstream.status,
    headers,
    body,
    bodyEncoding: textish ? "text" : "base64",
    redirects: hops,
  });
}

/** Absent or unknown content types are treated as text: the cost of scanning
 *  something that turns out to be binary is a mangled string in a response the
 *  caller asked for, and the cost of the reverse is T4 skipping a body it should
 *  have scrubbed. Bias toward scanning. */
function isTextish(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type) return true;
  if (type.startsWith("text/")) return true;
  if (type.endsWith("+json") || type.endsWith("+xml")) return true;
  return (
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded"
  );
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: spreading a large Uint8Array into String.fromCharCode overflows
  // the argument stack on real-world payloads.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function normalizeMethod(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "GET";
  if (typeof raw !== "string") return null;
  const method = raw.trim().toUpperCase();
  return METHODS.has(method) ? method : null;
}

/**
 * Caller headers, filtered.
 *
 * Naming the injected header is **refused, not stripped**. An agent that tries
 * to set `Authorization` on a credential whose recipe is `Authorization: Bearer
 * {}` is either confused or probing the injection, and both deserve an error
 * rather than a request that silently did something other than what was asked.
 * Stripping would also make an oracle out of the difference.
 */
function readCallerHeaders(
  raw: unknown,
  injectedName: string,
): { ok: true; headers: Headers } | { ok: false; reason: string } {
  const headers = new Headers();
  if (raw === undefined || raw === null) return { ok: true, headers };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "headers must be an object" };
  }
  const injected = injectedName.toLowerCase();
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = name.trim().toLowerCase();
    if (lower === injected) {
      return { ok: false, reason: `caller may not set the injected header "${injectedName}"` };
    }
    if (HOP_BY_HOP.has(lower)) continue;
    if (typeof value !== "string") {
      return { ok: false, reason: `header "${name}" must be a string` };
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      return { ok: false, reason: `header "${name}" contains a line break` };
    }
    try {
      headers.set(name, value);
    } catch {
      return { ok: false, reason: `invalid header: ${name}` };
    }
  }
  return { ok: true, headers };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Refusals carry a reason and never a value. Every string interpolated into one
 *  is a name, an origin or a status — the things an operator needs to widen a
 *  policy — and never anything read out of `enc_json`. */
function refuse(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
