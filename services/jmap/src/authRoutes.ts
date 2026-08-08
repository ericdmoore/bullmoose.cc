import {
  hashLoginKey,
  isLoginKey,
  mintToken,
  scopesWithin,
  timingSafeEqualHex,
} from "@bullmoose/auth-core";
import type { Principal } from "./auth";
import type { Env } from "./index";
import { beginLoginAttempt } from "./loginThrottle";

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
 *
 * Because verification is that cheap, /auth/login is throttled: see
 * loginThrottle.ts for the windows and why they live in KV. The gate
 * runs BEFORE the credential lookup and before hashLoginKey — a
 * throttle that only takes effect after the work it is meant to
 * conserve is decoration.
 * TODO: device-code flow.
 */

/** The one 401 this endpoint may emit. Unknown user, wrong key and
 *  throttled-email must be byte-identical, or the difference is an
 *  account-existence oracle. */
const INVALID_CREDENTIALS = { error: "invalid credentials" };

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

  const email = body.email.toLowerCase();
  // cf-connecting-ip is set by the edge on every real request; "unknown"
  // only shows up in local dev, where sharing one bucket is harmless.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const attempt = await beginLoginAttempt(env.ROUTES, email, ip);

  // Refuse the caller, not the account: this 429 is identical for every
  // email, so it says nothing about which of them exist.
  if (attempt.block === "ip") {
    return json({ error: "too many login attempts" }, 429, {
      "retry-after": String(attempt.retryAfterSeconds),
    });
  }
  // Email window tripped: still the plain 401, and still counted against
  // the IP — but no D1 read and no hash, which is the whole point.
  if (attempt.block === "email") {
    await attempt.fail();
    return json(INVALID_CREDENTIALS, 401);
  }

  const principal = await env.DB.prepare(
    `SELECT p.id, p.login_email, c.pw_hash
     FROM principals p JOIN credentials c ON c.principal_id = p.id
     WHERE p.login_email = ?`,
  )
    .bind(email)
    .first<{ id: string; login_email: string; pw_hash: string }>();
  // Same response for unknown user and wrong loginKey — and the same
  // counted failure, so the windows trip at the same count either way.
  if (!principal) {
    await attempt.fail();
    return json(INVALID_CREDENTIALS, 401);
  }

  const ok = timingSafeEqualHex(await hashLoginKey(body.loginKey), principal.pw_hash);
  if (!ok) {
    await attempt.fail();
    return json(INVALID_CREDENTIALS, 401);
  }
  await attempt.succeed();

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
    `SELECT a.id, a.tenant_id, a.display_name,
       (SELECT i.email FROM identities i WHERE i.account_id = a.id LIMIT 1) AS address
     FROM accounts a WHERE a.principal_id = ? ORDER BY a.created_at`,
  )
    .bind(principal.id)
    .all<{ id: string; tenant_id: string; display_name: string; address: string | null }>();

  return json({
    token: minted.token, // the one and only time it's visible
    tokenId: minted.id,
    username: principal.login_email,
    scopes,
    accounts: accounts.map((a) => ({
      accountId: a.id,
      tenantId: a.tenant_id,
      name: a.display_name,
      address: a.address,
    })),
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
