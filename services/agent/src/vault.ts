import { hasScope, parseToken, verifyTokenSecret } from "@bullmoose/auth-core";
import type { Env } from "./models.js";

/**
 * Credential vault — the METADATA half (T3a split).
 *
 * Per-principal third-party secrets. This file owns everything about a
 * credential except the credential: names, kinds, `meta_json`, the mint-time
 * contract of bureau.md §5, and the `creds` HTTP surface. It owns no key.
 *
 * **The vault's master key is not bound to this worker.** It was MOVED to
 * `services/bureau`, not copied (arch.md open question 1, ratified 2026-08-09),
 * and `sealSecret` / `openSecret` / `vaultAad` moved with it — including
 * seal-on-mint, which is the part that would otherwise have dragged the key back
 * here. The agent worker therefore *cannot* unseal a credential: not by rule, by
 * platform. That is what makes the governing principle — *you can only compute
 * with what you have* — a guarantee rather than a convention.
 *
 * The key's name appears nowhere in this worker's source or config, which is the
 * form the guarantee takes that a reviewer can check in one command;
 * `vault.test.ts` runs that check so it cannot rot.
 *
 * What crosses the BUREAU service binding: a plaintext secret goes IN once, at
 * mint and at rotate, on its way to being sealed. Nothing comes back but an
 * acknowledgement. There is no route, here or there, that returns a value.
 *
 * Routes (bearer token, scope "vault"; "mail" covers it):
 *   PUT    /vault/credentials          {name, kind, secret, meta?, +mint-time fields}
 *   GET    /vault/credentials          → [{name, kind, allow, header, scope,
 *                                          enforcement, meta, …}] (no secrets)
 *   POST   /vault/credentials/{name}/rotate  {secret} → re-seal, same name/kind/meta
 *   DELETE /vault/credentials/{name}
 * Internal (x-internal-token):
 *   POST   /internal/vault/verify      {principalEmail, name} → {ok}
 *          (decrypt-and-discard health check — proxied to the Bureau, which is
 *           the only worker that can decrypt anything)
 *
 * Four kinds (bureau.md §4.1 types the Bureau's verbs to the credential kind):
 *   api-key       secret = the key                 → fetch
 *   oauth-refresh secret = the refresh token       → oauth_token, fetch
 *                 (meta carries token_url/client_id/scopes — the CLI runs the
 *                  browser+PKCE flow and uploads only the outcome)
 *   aws-sigv4     secret = the AWS secret key       → sign_sigv4, fetch
 *   hmac-key      secret = a purpose-scoped HMAC key → hmac_sha256
 *
 * Minting still does not AUTHORIZE anything (bureau.md §5.1): who may use a
 * credential is a separate `bureau_grants` record over `(principal, credRef,
 * verb)`, administered through `services/provision` and enforced by the Bureau.
 * Nothing here enforces the verb set, the destination allowlist, or egress
 * redaction — that is the Bureau runtime, s04 T3. This route mints and records
 * the contract (bureau.md §5). The mint-time fields ride in meta_json — no
 * schema change. Promote --allow to a typed, indexed column only when the proxy
 * exists and needs to query it.
 *
 *   allow        destination binding — origin or *.wildcard (§6). THE control.
 *   header       injection recipe, "Name: …{}…" (§5). Header-only (invariant 8).
 *   scope        actor | inbox | global — only `actor` today; inbox/global need
 *                the AAD re-seal (§9), DEFERRED, so they are refused with a
 *                "not yet" (sVOL 020).
 *   enforcement  federated | narrow | broad (§5.2) — WHO enforces the
 *                narrowing. `broad` (the default) means *only our code will,
 *                once the proxy exists*; surfaced so that is visible, not
 *                tribal knowledge.
 */

interface VaultPrincipal {
  principalId: string;
  email: string;
  scopes: string[];
}

/** The kinds a credential may be minted as. Each gates a Bureau verb set
 *  (bureau.md §4.1); widening this list widens the oracle surface, so the bar
 *  is high. `aws-sigv4` and `hmac-key` are new in sVOL 020. */
const VAULT_KINDS = ["api-key", "oauth-refresh", "aws-sigv4", "hmac-key"] as const;
type VaultKind = (typeof VAULT_KINDS)[number];

/** Which rung of the §5.2 ladder enforces the provider-side narrowing.
 *  `broad` = only our code does (once the proxy exists) — the honest default:
 *  assume the weakest until an operator records otherwise. */
const ENFORCEMENT_LEVELS = ["federated", "narrow", "broad"] as const;
type Enforcement = (typeof ENFORCEMENT_LEVELS)[number];

/** The mint-time fields fold into meta_json under these reserved keys, so the
 *  whole contract reaches the Bureau with the credential, and GET can surface
 *  them typed without a schema change. */
const RESERVED_META_KEYS = ["allow", "header", "scope", "enforcement"] as const;

/**
 * Normalize a destination-allowlist entry to a canonical origin, or null if it
 * is not one. This is bureau.md §6 at mint time: parse the URL and keep only
 * scheme+host+port; accept a wildcard host ONLY as an explicit leading `*.`
 * suffix (§6.4). A bare substring like "api.stripe.com" is coerced to the
 * https origin; garbage and non-http(s) schemes are rejected. Storing the
 * normalized form means every future reader compares the same string — the
 * "every reader parses it identically" risk sVOL 020 named for a JSON blob.
 */
function normalizeAllow(raw: string): string | null {
  const val = raw.trim().toLowerCase();
  if (!val) return null;
  // Wildcard suffix — an explicit widening. "*.host" or "scheme://*.host".
  const wild = /^(?:(https?):\/\/)?(\*\.[a-z0-9.-]+)$/.exec(val);
  if (wild) return `${wild[1] ?? "https"}://${wild[2]}`;
  try {
    const u = new URL(val.includes("://") ? val : `https://${val}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.hostname.includes("*")) return null;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return null;
  }
}

/** A header injection recipe must be "Header-Name: …{}…": a valid field name,
 *  a colon, and the `{}` slot the value lands in. Never a query parameter
 *  (invariant 8) — this shape can only produce a header. */
function normalizeHeader(raw: string): string | null {
  const val = raw.trim();
  if (!val.includes("{}")) return null;
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+:\s*\S/i.test(val)) return null;
  return val;
}

async function authenticateVault(request: Request, env: Env): Promise<VaultPrincipal | null> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const parsed = parseToken(header.slice(7));
  if (!parsed) return null;
  const row = await env.DB.prepare(
    `SELECT t.secret_hash, t.scopes, t.expires_at, t.principal_id, p.login_email
     FROM tokens t JOIN principals p ON p.id = t.principal_id
     WHERE t.id = ? AND t.kind = 'bearer'`,
  )
    .bind(parsed.id)
    .first<{
      secret_hash: string;
      scopes: string;
      expires_at: number | null;
      principal_id: string;
      login_email: string;
    }>();
  if (!row) return null;
  if (!(await verifyTokenSecret(parsed.secret, row.secret_hash))) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;
  return {
    principalId: row.principal_id,
    email: row.login_email,
    scopes: JSON.parse(row.scopes) as string[],
  };
}

/** Call the Bureau over the service binding. The only way this worker can get a
 *  secret sealed — and the only reason it ever holds a plaintext one, for the
 *  length of one request on its way in. */
function bureau(env: Env, path: string, body: unknown): Promise<Response> {
  return env.BUREAU.fetch(`https://bureau.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
}

export async function handleVault(request: Request, env: Env): Promise<Response> {
  // No Bureau, no vault. The agent worker has no fallback path here by design:
  // there is no master key to fall back TO.
  if (!env.BUREAU) return json({ error: "vault not configured" }, 501);
  const url = new URL(request.url);

  const principal = await authenticateVault(request, env);
  if (!principal) return json({ error: "unauthorized" }, 401);
  if (!hasScope(principal.scopes, "vault")) {
    return json({ error: 'token lacks the "vault" scope' }, 403);
  }

  if (request.method === "PUT" && url.pathname === "/vault/credentials") {
    const body = (await request.json()) as {
      name?: string;
      kind?: string;
      secret?: string;
      meta?: Record<string, unknown>;
      allow?: string;
      header?: string;
      scope?: string;
      enforcement?: string;
    };
    if (!body.name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.name)) {
      return json({ error: "name required (alnum . _ - up to 64 chars)" }, 400);
    }
    if (!VAULT_KINDS.includes(body.kind as VaultKind)) {
      return json({ error: `kind must be one of ${VAULT_KINDS.join(", ")}` }, 400);
    }
    const kind = body.kind as VaultKind;
    if (typeof body.secret !== "string" || body.secret.length === 0) {
      return json({ error: "secret required" }, 400);
    }

    // Mint-time contract (bureau.md §5). Fields fold into meta_json under
    // reserved keys; explicit fields win over anything in --meta.
    const meta: Record<string, unknown> = { ...(body.meta ?? {}) };

    // scope — actor only today. inbox/global need the AAD re-seal (§9), which
    // is deferred; refuse them with a "not yet" rather than silently narrowing.
    const scope = body.scope ?? "actor";
    if (scope !== "actor") {
      return json(
        {
          error:
            `scope "${scope}" is not yet supported — only "actor". Global/PerInbox ` +
            `require re-sealing every row under a new AAD (bureau.md §9), deferred.`,
        },
        400,
      );
    }
    meta.scope = "actor";

    // enforcement — WHO enforces the §5.2 narrowing. Default `broad` = assume
    // only our (future) code does, until an operator records otherwise.
    const enforcement = body.enforcement ?? "broad";
    if (!ENFORCEMENT_LEVELS.includes(enforcement as Enforcement)) {
      return json({ error: `enforcement must be one of ${ENFORCEMENT_LEVELS.join(", ")}` }, 400);
    }
    meta.enforcement = enforcement;

    // header — the injection recipe. Derive the obvious one for api-key (§5).
    if (body.header !== undefined) {
      const h = normalizeHeader(body.header);
      if (!h) {
        return json({ error: 'header must be "Header-Name: …{}…" (the {} is the value slot)' }, 400);
      }
      meta.header = h;
    } else if (kind === "api-key" && meta.header === undefined) {
      meta.header = "Authorization: Bearer {}";
    }

    // allow — destination binding, THE primary control (§6). Derive from the
    // OAuth issuer when not given (§5). We do NOT hard-require it here: the CLI
    // fails closed at the human boundary, and a row with no allow is recorded
    // as unusable-by-design (invariant 5) — services/bureau/src/binding.ts
    // refuses a credential with no allowlist rather than defaulting to allow-all.
    //
    // This IS enforced as of Bureau T3: binding.ts re-parses this stored value
    // on every use and matches by parsed origin, never by string compare. Note
    // it accepts `string | string[]` while this mint path only ever writes a
    // single string — see .feedback 035 for that seam.
    let allow = body.allow;
    if (!allow && kind === "oauth-refresh" && typeof meta.token_url === "string") {
      try {
        allow = new URL(meta.token_url).origin;
      } catch {
        /* leave unbound */
      }
    }
    if (allow) {
      const norm = normalizeAllow(allow);
      if (!norm) {
        return json(
          { error: `allow must be an origin (https://host[:port]) or wildcard (*.host); got ${allow}` },
          400,
        );
      }
      meta.allow = norm;
    }

    // Seal-on-mint happens in the Bureau, which also writes the row: `enc_json`
    // is touched by exactly one worker, and it is not this one.
    const sealed = await bureau(env, "/internal/bureau/seal", {
      mode: "mint",
      principalId: principal.principalId,
      name: body.name,
      kind,
      metaJson: JSON.stringify(meta),
      secret: body.secret,
    });
    if (!sealed.ok) {
      return json({ error: `bureau refused the seal (${sealed.status})` }, 502);
    }
    // Write-only: acknowledge with the (non-secret) contract, never the value.
    return json({
      ok: true,
      name: body.name,
      kind,
      allow: (meta.allow as string) ?? null,
      enforcement: meta.enforcement,
      bound: meta.allow !== undefined, // false ⇒ fail-closed, unusable by design
    });
  }

  if (request.method === "GET" && url.pathname === "/vault/credentials") {
    const { results } = await env.DB.prepare(
      `SELECT name, kind, meta_json, created_at, updated_at
       FROM vault_credentials WHERE principal_id = ? ORDER BY name`,
    )
      .bind(principal.principalId)
      .all<{ name: string; kind: string; meta_json: string; created_at: number; updated_at: number }>();
    return json({ credentials: results.map((r) => credentialView(r)) });
  }

  if (request.method === "POST" && /^\/vault\/credentials\/[^/]+\/rotate$/.test(url.pathname)) {
    const name = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = (await request.json()) as { secret?: string };
    if (typeof body.secret !== "string" || body.secret.length === 0) {
      return json({ error: "secret required" }, 400);
    }
    // Re-seal the NEW secret under the SAME name — so the AAD, kind, allowlist
    // and every other mint-time field are unchanged and nothing downstream
    // re-attaches (bureau.md §5). The Bureau moves enc_json + updated_at and
    // nothing else; `kind` is read here only to echo it back.
    const existing = await env.DB.prepare(
      `SELECT kind FROM vault_credentials WHERE principal_id = ? AND name = ?`,
    )
      .bind(principal.principalId, name)
      .first<{ kind: string }>();
    if (!existing) return json({ error: "not found" }, 404);
    const rotated = await bureau(env, "/internal/bureau/seal", {
      mode: "rotate",
      principalId: principal.principalId,
      name,
      secret: body.secret,
    });
    if (!rotated.ok) {
      return json({ error: `bureau refused the rotate (${rotated.status})` }, 502);
    }
    return json({ ok: true, name, kind: existing.kind, rotated: true });
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/vault/credentials/")) {
    const name = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const res = await env.DB.prepare(
      `DELETE FROM vault_credentials WHERE principal_id = ? AND name = ?`,
    )
      .bind(principal.principalId, name)
      .run();
    return json({ deleted: (res.meta.changes ?? 0) > 0 });
  }

  return json({ error: "not found" }, 404);
}

/**
 * Decrypt-and-discard health check (internal token only): proves a row is
 * present AND openable under the current master key, returning just a boolean.
 *
 * Kept as an agent route so `tools/e2e-grants.mjs` and any operator muscle
 * memory keep working, but it is now a pure PROXY — the decrypt happens in the
 * Bureau, because this worker has nothing to decrypt with.
 */
export async function handleVaultVerify(request: Request, env: Env): Promise<Response> {
  if (!env.BUREAU) return json({ error: "vault not configured" }, 501);
  const body = (await request.json()) as { principalEmail?: string; name?: string };
  if (!body.principalEmail || !body.name) {
    return json({ error: "principalEmail and name required" }, 400);
  }
  return bureau(env, "/internal/bureau/verify", body);
}

/**
 * The public (secret-free) view of a stored credential. Surfaces the mint-time
 * contract as typed fields for the console (s03.E), and returns the remaining
 * user meta with the reserved keys stripped so they are not shown twice.
 * NEVER touches enc_json — invariant 1: no read path returns a value.
 */
function credentialView(r: {
  name: string;
  kind: string;
  meta_json: string;
  created_at: number;
  updated_at: number;
}) {
  const meta = JSON.parse(r.meta_json) as Record<string, unknown>;
  const userMeta = { ...meta };
  for (const k of RESERVED_META_KEYS) delete userMeta[k];
  return {
    name: r.name,
    kind: r.kind,
    allow: (meta.allow as string | undefined) ?? null,
    header: (meta.header as string | undefined) ?? null,
    scope: (meta.scope as string | undefined) ?? "actor",
    enforcement: (meta.enforcement as string | undefined) ?? null,
    // false ⇒ no destination binding ⇒ fail-closed, unusable by design (§6).
    bound: meta.allow !== undefined,
    meta: userMeta,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
