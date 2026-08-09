import {
  hasScope,
  openSecret,
  parseToken,
  sealSecret,
  vaultAad,
  verifyTokenSecret,
  type SealedSecret,
} from "@bullmoose/auth-core";
import type { Env } from "./models.js";

/**
 * Credential vault (devPlan-handoff Phase 3, Q2 "build it right").
 *
 * Per-principal third-party secrets, envelope-encrypted with this
 * worker's VAULT_MASTER_KEY (HKDF per row + AES-256-GCM, AAD binds
 * principal+name — see auth-core). The API is WRITE-ONLY: a stored
 * secret is never returned by any route. When an agent pipeline needs a
 * credential it calls openVaultSecret() in-process and keeps the value
 * in memory only.
 *
 * Routes (bearer token, scope "vault"; "mail" covers it):
 *   PUT    /vault/credentials          {name, kind, secret, meta?, +mint-time fields}
 *   GET    /vault/credentials          → [{name, kind, allow, header, scope,
 *                                          enforcement, meta, …}] (no secrets)
 *   POST   /vault/credentials/{name}/rotate  {secret} → re-seal, same name/kind/meta
 *   DELETE /vault/credentials/{name}
 * Internal (x-internal-token):
 *   POST   /internal/vault/verify      {principalEmail, name} → {ok}
 *          (decrypt-and-discard health check; returns a boolean only)
 *
 * Four kinds (bureau.md §4.1 types the Bureau's verbs to the credential kind):
 *   api-key       secret = the key                 → fetch
 *   oauth-refresh secret = the refresh token       → oauth_token, fetch
 *                 (meta carries token_url/client_id/scopes — the CLI runs the
 *                  browser+PKCE flow and uploads only the outcome)
 *   aws-sigv4     secret = the AWS secret key       → sign_sigv4, fetch
 *   hmac-key      secret = a purpose-scoped HMAC key → hmac_sha256
 *
 * The Bureau (bureau.md) is a LATER task; nothing here enforces the verb set,
 * the destination allowlist, or egress redaction yet. This route mints and
 * records the contract (bureau.md §5). The mint-time fields ride in meta_json
 * — no schema change, so the unit stays E2 (sVOL 020). Promote --allow to a
 * typed, indexed column only when the proxy exists and needs to query it.
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

/** The mint-time fields fold into meta_json under these reserved keys, so
 *  `openVaultSecret`'s `meta` carries the whole contract to the future Bureau,
 *  and GET can surface them typed without a schema change. */
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

export async function handleVault(request: Request, env: Env): Promise<Response> {
  if (!env.VAULT_MASTER_KEY) return json({ error: "vault not configured" }, 501);
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
    // as unusable-by-design (invariant 5). NOTHING enforces yet — no proxy.
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

    const sealed = await sealSecret(
      env.VAULT_MASTER_KEY,
      body.secret,
      vaultAad(principal.principalId, body.name),
    );
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO vault_credentials (id, principal_id, name, kind, enc_json, meta_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (principal_id, name) DO UPDATE SET
         kind = excluded.kind, enc_json = excluded.enc_json,
         meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
    )
      .bind(
        `vc_${crypto.randomUUID()}`,
        principal.principalId,
        body.name,
        kind,
        JSON.stringify(sealed),
        JSON.stringify(meta),
        now,
        now,
      )
      .run();
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
    // re-attaches (bureau.md §5). Only enc_json + updated_at move.
    const existing = await env.DB.prepare(
      `SELECT kind FROM vault_credentials WHERE principal_id = ? AND name = ?`,
    )
      .bind(principal.principalId, name)
      .first<{ kind: string }>();
    if (!existing) return json({ error: "not found" }, 404);
    const sealed = await sealSecret(
      env.VAULT_MASTER_KEY,
      body.secret,
      vaultAad(principal.principalId, name),
    );
    await env.DB.prepare(
      `UPDATE vault_credentials SET enc_json = ?, updated_at = ?
       WHERE principal_id = ? AND name = ?`,
    )
      .bind(JSON.stringify(sealed), Date.now(), principal.principalId, name)
      .run();
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
 * Decrypt-and-discard health check (internal token only): proves a row
 * is present AND openable under the current master key, returning just
 * a boolean. The plaintext never leaves this function.
 */
export async function handleVaultVerify(request: Request, env: Env): Promise<Response> {
  if (!env.VAULT_MASTER_KEY) return json({ error: "vault not configured" }, 501);
  const body = (await request.json()) as { principalEmail?: string; name?: string };
  if (!body.principalEmail || !body.name) {
    return json({ error: "principalEmail and name required" }, 400);
  }
  const row = await env.DB.prepare(
    `SELECT v.enc_json, v.principal_id FROM vault_credentials v
     JOIN principals p ON p.id = v.principal_id
     WHERE p.login_email = ? AND v.name = ?`,
  )
    .bind(body.principalEmail.toLowerCase(), body.name)
    .first<{ enc_json: string; principal_id: string }>();
  if (!row) return json({ ok: false, reason: "not found" });
  try {
    await openSecret(
      env.VAULT_MASTER_KEY,
      JSON.parse(row.enc_json) as SealedSecret,
      vaultAad(row.principal_id, body.name),
    );
    return json({ ok: true });
  } catch {
    return json({ ok: false, reason: "cannot decrypt" });
  }
}

/**
 * In-worker credential access for agent pipelines. Callers MUST keep the
 * returned value in-process (headers to the external API, never logs,
 * never responses).
 */
export async function openVaultSecret(
  env: Env,
  principalId: string,
  name: string,
): Promise<{ kind: string; secret: string; meta: Record<string, unknown> } | null> {
  if (!env.VAULT_MASTER_KEY) return null;
  const row = await env.DB.prepare(
    `SELECT kind, enc_json, meta_json FROM vault_credentials
     WHERE principal_id = ? AND name = ?`,
  )
    .bind(principalId, name)
    .first<{ kind: string; enc_json: string; meta_json: string }>();
  if (!row) return null;
  const secret = await openSecret(
    env.VAULT_MASTER_KEY,
    JSON.parse(row.enc_json) as SealedSecret,
    vaultAad(principalId, name),
  );
  return { kind: row.kind, secret, meta: JSON.parse(row.meta_json) as Record<string, unknown> };
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
