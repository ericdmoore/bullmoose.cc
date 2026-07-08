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
 *   PUT    /vault/credentials          {name, kind, secret, meta?}
 *   GET    /vault/credentials          → [{name, kind, meta, …}] (no secrets)
 *   DELETE /vault/credentials/{name}
 * Internal (x-internal-token):
 *   POST   /internal/vault/verify      {principalEmail, name} → {ok}
 *          (decrypt-and-discard health check; returns a boolean only)
 *
 * Two shapes: kind "api-key" (secret = the key) and "oauth-refresh"
 * (secret = the refresh token; meta carries token_url/client_id/scopes
 * — the CLI runs the browser+PKCE flow and uploads only the outcome).
 */

interface VaultPrincipal {
  principalId: string;
  email: string;
  scopes: string[];
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
    };
    if (!body.name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.name)) {
      return json({ error: "name required (alnum . _ - up to 64 chars)" }, 400);
    }
    if (body.kind !== "api-key" && body.kind !== "oauth-refresh") {
      return json({ error: 'kind must be "api-key" or "oauth-refresh"' }, 400);
    }
    if (typeof body.secret !== "string" || body.secret.length === 0) {
      return json({ error: "secret required" }, 400);
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
        body.kind,
        JSON.stringify(sealed),
        JSON.stringify(body.meta ?? {}),
        now,
        now,
      )
      .run();
    // Write-only: acknowledge without echoing anything secret.
    return json({ ok: true, name: body.name, kind: body.kind });
  }

  if (request.method === "GET" && url.pathname === "/vault/credentials") {
    const { results } = await env.DB.prepare(
      `SELECT name, kind, meta_json, created_at, updated_at
       FROM vault_credentials WHERE principal_id = ? ORDER BY name`,
    )
      .bind(principal.principalId)
      .all<{ name: string; kind: string; meta_json: string; created_at: number; updated_at: number }>();
    return json({
      credentials: results.map((r) => ({
        name: r.name,
        kind: r.kind,
        meta: JSON.parse(r.meta_json) as Record<string, unknown>,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
