// T2 — credential lifecycle. Attach, rotate, revoke, and OAuth initiation.
//
// ── The rule this file exists to enforce ────────────────────────────────────
//
// `readme.md` §Non-obvious 3: *"No secret transits the site backend. Credential
// entry POSTs **directly** to the agent worker's `/vault/credentials`."*
// `devPlan.md` T2: *"Assert the second with a test, not a convention."*
//
// Two mechanisms, because a rule with one is a comment:
//
//   1. **Every request goes through `resolveTarget`** (`origins.ts`), which
//      REFUSES — throws, does not warn — to address a secret-bearing body at
//      the site's own origin, or at any origin when none is configured. There
//      is no code path in this module that reaches `fetch` without it.
//   2. **`credentials.test.ts` sweeps it behaviourally**: it drives every
//      operation this module offers through an instrumented `fetch`, and
//      asserts that no request whose body contains credential material was
//      ever addressed to the site origin — and, separately, that the guard
//      fires when the vault is misconfigured to be the site.
//
// ── And the flow that deliberately does NOT happen in the browser ───────────
//
// `readme.md`: *"OAuth flows are the WebUI's best case (nothing sensitive is
// typed); raw API keys are the one flow that bounces to the CLI."* So a raw key
// renders `bullmoose creds set` and stops. `directEntry` exists because
// `devPlan.md` allows the direct-POST form as the alternative, and because a
// rule you cannot exercise is a rule you cannot test — but it is opt-in, and the
// UI does not offer it by default.
//
// Nothing here can read a credential back. There is no such route: `enc_json` is
// written and read in exactly one worker (`services/bureau`), the master key is
// not bound to the worker this talks to, and no vault response carries a value
// (bureau.md invariant 1). "Reveal password" is not a missing feature.

import { resolveTarget, carriesSecret, type ConsoleOrigins } from "./origins";
import type { ConsoleCredential, CredentialKind, Enforcement } from "./types";

export interface VaultTransportOptions {
  origins: ConsoleOrigins;
  /** The operator's bearer — the same one `bullmoose creds set` would send. */
  token: string;
  fetch?: typeof fetch;
}

export interface MintSpec {
  name: string;
  kind: CredentialKind;
  /** Destination binding (bureau.md §6) — THE primary control. Fail closed. */
  allow?: string;
  /** Injection recipe, "Header-Name: …{}…". Derived from `kind` where obvious. */
  header?: string;
  /** Which rung of §5.2 enforces the narrowing. Defaults to the honest `broad`. */
  enforcement?: Enforcement;
  meta?: Record<string, unknown>;
}

export interface OAuthSpec extends MintSpec {
  kind: "oauth-refresh";
  /** The provider's authorization endpoint. */
  authorizeUrl: string;
  clientId: string;
  scopes: string[];
  /** The provider's token endpoint — the vault exchanges against it, not us. */
  tokenUrl: string;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Kinds whose entropy is a raw string a human would have to type or paste.
 * These bounce to the CLI (`readme.md`) — the intentionally CLI-only flow.
 */
export const RAW_KEY_KINDS: readonly CredentialKind[] = ["api-key", "aws-sigv4", "hmac-key"];

export const isRawKeyKind = (kind: CredentialKind): boolean => RAW_KEY_KINDS.includes(kind);

/**
 * The exact command to run instead. Deliberately does NOT include the secret in
 * any form: the CLI defaults to a hidden prompt and offers `--secret-env`,
 * because `--secret <value>` on argv lands in shell history and `ps`
 * (bureau.md §5, *Entropy intake hygiene*).
 */
export function cliCommandFor(spec: MintSpec): string {
  const parts = [`bullmoose creds set ${spec.name}`, `--kind ${spec.kind}`];
  if (spec.allow) parts.push(`--allow ${spec.allow}`);
  if (spec.header) parts.push(`--header ${JSON.stringify(spec.header)}`);
  parts.push(`--enforcement ${spec.enforcement ?? "broad"}`);
  return parts.join(" ") + "\n# you will be prompted for the secret — it never appears in argv";
}

export function rotateCommandFor(name: string): string {
  return `bullmoose creds rotate ${name}\n` + "# re-seals under the SAME name, so nothing downstream re-attaches";
}

// ── PKCE ────────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomB64Url = (n: number): string => {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return b64url(bytes);
};

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** RFC 7636 S256. The verifier is generated here and leaves for exactly one
 *  destination: the vault. It is never put in the URL, never in storage the site
 *  can read back, and never in a request to the site's own origin. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomB64Url(32);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)), state: randomB64Url(16) };
}

export interface OAuthStart {
  /** Where to send the browser. The provider's origin — not ours, not the site's. */
  authorizeUrl: string;
  state: string;
  /** The callback the provider will return to. Always the VAULT's origin. */
  redirectUri: string;
}

// ── the transport ───────────────────────────────────────────────────────────

/**
 * Every mutation the console can make to a credential. One class so there is
 * one place that talks to the vault, and one `send` so there is one place the
 * origin rule is applied.
 */
export class CredentialVault {
  private readonly origins: ConsoleOrigins;
  private readonly token: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: VaultTransportOptions) {
    this.origins = opts.origins;
    this.token = opts.token;
    this.doFetch = (opts.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /**
   * The single choke point. Sensitivity is DERIVED from the body rather than
   * passed by the caller: bureau.md §7a's reasoning applied to our own code —
   * declaration beats sniffing, and a caller that could label its own request
   * "metadata" is a caller that can forget.
   */
  private async send(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sensitivity = carriesSecret(body) ? "secret" : "metadata";
    const url = resolveTarget(this.origins, path, sensitivity);
    const res = await this.doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text };
    }
    if (!res.ok) {
      throw new VaultError(String(parsed.error ?? `HTTP ${res.status}`), res.status);
    }
    return parsed;
  }

  /** LIVE: `GET /vault/credentials`. References only — the shape has no value field. */
  async list(): Promise<ConsoleCredential[]> {
    const body = await this.send("GET", "/vault/credentials");
    return (body.credentials ?? []) as ConsoleCredential[];
  }

  /**
   * LIVE: `PUT /vault/credentials`, direct to the vault origin with the
   * operator's bearer. This is the `devPlan.md` T2 alternative to the CLI
   * bounce, and the only path in the console that carries entropy.
   */
  async mintDirect(spec: MintSpec, secret: string): Promise<Record<string, unknown>> {
    if (!secret) throw new VaultError("secret required", 400);
    return this.send("PUT", "/vault/credentials", {
      name: spec.name,
      kind: spec.kind,
      secret,
      ...(spec.allow ? { allow: spec.allow } : {}),
      ...(spec.header ? { header: spec.header } : {}),
      enforcement: spec.enforcement ?? "broad",
      ...(spec.meta ? { meta: spec.meta } : {}),
    });
  }

  /** LIVE: `POST /vault/credentials/{name}/rotate`. Same name, same contract. */
  async rotate(name: string, secret: string): Promise<Record<string, unknown>> {
    if (!secret) throw new VaultError("secret required", 400);
    return this.send("POST", `/vault/credentials/${encodeURIComponent(name)}/rotate`, { secret });
  }

  /** LIVE: `DELETE /vault/credentials/{name}`. Carries no secret. */
  async revoke(name: string): Promise<boolean> {
    const body = await this.send("DELETE", `/vault/credentials/${encodeURIComponent(name)}`);
    return body.deleted === true;
  }

  /**
   * OAuth initiation — the WebUI's best case, because nothing sensitive is
   * typed at all.
   *
   * The verifier is POSTed **to the vault** (a secret-bearing request, so the
   * origin guard applies), the challenge goes in the URL, and the provider
   * returns to a callback on the **vault's** origin, which exchanges the code
   * for a refresh token server-to-server and seals it. The browser never holds
   * the refresh token and the site backend is not on the path at any step.
   *
   * ⚠️ `/vault/oauth/start` and the callback are the one part of this flow the
   * agent worker does not serve yet — the CLI runs browser+PKCE today and
   * uploads only the outcome (`vault.ts:41`). This is the console's request for
   * it, in the shape the rest of the file already proves safe; the UI surfaces
   * the 404 honestly rather than pretending the flow completed.
   */
  async beginOAuth(spec: OAuthSpec): Promise<OAuthStart> {
    const pkce = await createPkce();
    // The callback MUST be the vault's origin: it is where the code is
    // exchanged, and a redirect_uri on the site origin would put the
    // authorization code — a bearer for one exchange — through the site.
    const redirectUri = resolveTarget(this.origins, "/vault/oauth/callback", "secret");

    await this.send("POST", "/vault/oauth/start", {
      name: spec.name,
      kind: "oauth-refresh",
      code_verifier: pkce.verifier,
      state: pkce.state,
      redirect_uri: redirectUri,
      token_url: spec.tokenUrl,
      client_id: spec.clientId,
      ...(spec.allow ? { allow: spec.allow } : {}),
      enforcement: spec.enforcement ?? "broad",
      meta: { ...(spec.meta ?? {}), token_url: spec.tokenUrl, client_id: spec.clientId },
    });

    const url = new URL(spec.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", spec.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", spec.scopes.join(" "));
    url.searchParams.set("state", pkce.state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizeUrl: url.toString(), state: pkce.state, redirectUri };
  }
}

/**
 * What the UI should offer for a given kind — one place decides, so a new kind
 * cannot quietly acquire a secret field in the browser.
 */
export interface EntryPlan {
  route: "cli" | "oauth" | "direct";
  reason: string;
  command?: string;
}

export function entryPlan(kind: CredentialKind, spec?: MintSpec): EntryPlan {
  if (kind === "oauth-refresh") {
    return {
      route: "oauth",
      reason:
        "OAuth is the browser's best case: the refresh token is exchanged server-to-server and " +
        "nothing sensitive is ever typed into a form.",
    };
  }
  return {
    route: "cli",
    reason:
      "A raw key has to come from somewhere, and a browser form is the worst place for it to " +
      "pass through — clipboard, autofill, extensions, history. The CLI posts the same value to " +
      "the same vault endpoint from a hidden prompt, so this flow bounces there deliberately.",
    command: cliCommandFor(spec ?? { name: "<name>", kind }),
  };
}
