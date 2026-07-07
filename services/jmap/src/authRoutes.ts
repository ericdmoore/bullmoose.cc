import {
  hashLoginKey,
  isLoginKey,
  mintToken,
  scopesWithin,
  timingSafeEqualHex,
} from "@bullmoose/auth-core";
import type { Principal } from "./auth";
import type { Env } from "./index";

/**
 * Self-service auth endpoints on the jmap worker:
 *   POST   /auth/login        {email, loginKey, name?, scopes?} → token (once)
 *   GET    /auth/tokens       list own tokens (no secrets)
 *   POST   /auth/tokens       {name, scopes?} mint another (⊆ own scopes)
 *   DELETE /auth/tokens/{id}  revoke own
 *
 * loginKey is CLIENT-derived (PBKDF2 — see auth-core's contract): the
 * raw password never transits, and server verification is one SHA-256,
 * which fits the Workers Free 10ms CPU cap. Credentials exist only to
 * mint tokens; day-to-day calls are bearer-only.
 * TODO: rate-limit /auth/login; device-code flow.
 */

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    email?: string;
    loginKey?: string;
    name?: string;
    scopes?: string[];
  };
  if (!body.email || !isLoginKey(body.loginKey)) {
    return json({ error: "email and loginKey (client-derived; the CLI derives it) required" }, 400);
  }

  const principal = await env.DB.prepare(
    `SELECT p.id, p.login_email, c.pw_hash
     FROM principals p JOIN credentials c ON c.principal_id = p.id
     WHERE p.login_email = ?`,
  )
    .bind(body.email.toLowerCase())
    .first<{ id: string; login_email: string; pw_hash: string }>();
  // Same response for unknown user and wrong loginKey.
  if (!principal) return json({ error: "invalid credentials" }, 401);

  const ok = timingSafeEqualHex(await hashLoginKey(body.loginKey), principal.pw_hash);
  if (!ok) return json({ error: "invalid credentials" }, 401);

  const scopes = body.scopes ?? ["mail"];
  const minted = await mintToken();
  await env.DB.prepare(
    `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      minted.id,
      principal.id,
      minted.secretHash,
      body.name ?? "device",
      JSON.stringify(scopes),
      Date.now(),
    )
    .run();

  const { results: accounts } = await env.DB.prepare(
    `SELECT id, tenant_id, display_name FROM accounts WHERE principal_id = ?`,
  )
    .bind(principal.id)
    .all<{ id: string; tenant_id: string; display_name: string }>();

  return json({
    token: minted.token, // the one and only time it's visible
    tokenId: minted.id,
    username: principal.login_email,
    scopes,
    accounts: accounts.map((a) => ({ accountId: a.id, tenantId: a.tenant_id, name: a.display_name })),
  });
}

export async function handleTokens(
  request: Request,
  url: URL,
  env: Env,
  principal: Principal,
): Promise<Response> {
  // Resolve principal id from the login email (tokens are per-principal).
  const p = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(principal.username)
    .first<{ id: string }>();
  if (!p) return json({ error: "no principal row (dev token?)" }, 403);

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, scopes, created_at, expires_at, last_used_at
       FROM tokens WHERE principal_id = ? ORDER BY created_at`,
    )
      .bind(p.id)
      .all();
    return json({ tokens: results });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as { name?: string; scopes?: string[] };
    const scopes = body.scopes ?? ["mail"];
    // No privilege escalation: requested ⊆ what the minting token holds.
    if (!scopesWithin(scopes, principal.scopes)) {
      return json({ error: "requested scopes exceed this token's scopes" }, 403);
    }
    const minted = await mintToken();
    await env.DB.prepare(
      `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(minted.id, p.id, minted.secretHash, body.name ?? "token", JSON.stringify(scopes), Date.now())
      .run();
    return json({ token: minted.token, tokenId: minted.id, scopes });
  }

  if (request.method === "DELETE") {
    const id = url.pathname.split("/")[3];
    if (!id) return json({ error: "token id required" }, 400);
    const res = await env.DB.prepare(`DELETE FROM tokens WHERE id = ? AND principal_id = ?`)
      .bind(id, p.id)
      .run();
    return json({ revoked: (res.meta.changes ?? 0) > 0 });
  }

  return json({ error: "method not allowed" }, 405);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
