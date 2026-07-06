import { hasScope, parseToken, verifyTokenSecret } from "@bullmoose/auth-core";

/**
 * Bearer-token auth against the control-plane tokens table. One table
 * serves device tokens, agent tokens, and (control-plane) admin tokens —
 * see packages/auth-core. DEV_BEARER_TOKEN remains as a local-dev
 * bootstrap that maps to a synthetic single-account principal.
 */

export interface AccountAccess {
  accountId: string;
  tenantId: string;
  name: string;
}

export interface Principal {
  username: string;
  scopes: string[];
  accounts: AccountAccess[];
}

export interface AuthEnv {
  DB: D1Database;
  DEV_BEARER_TOKEN?: string;
  DEV_ACCOUNT_ID: string;
  DEV_TENANT_ID: string;
  DEV_USERNAME: string;
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

export async function authenticate(request: Request, env: AuthEnv): Promise<Principal | null> {
  const header = request.headers.get("Authorization") ?? "";
  let raw = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!raw) {
    // Browser/Node WebSocket clients cannot set an Authorization header —
    // accept the token as a query parameter (RFC 6750 §2.3 style) so the
    // push channel is reachable. Header wins when both are present.
    raw = new URL(request.url).searchParams.get("access_token");
  }
  if (!raw) return null;

  // Local-dev bootstrap.
  if (env.DEV_BEARER_TOKEN && raw === env.DEV_BEARER_TOKEN) {
    return {
      username: env.DEV_USERNAME,
      scopes: ["mail"],
      accounts: [
        { accountId: env.DEV_ACCOUNT_ID, tenantId: env.DEV_TENANT_ID, name: env.DEV_USERNAME },
      ],
    };
  }

  const parsed = parseToken(raw);
  if (!parsed) return null;

  const row = await env.DB.prepare(
    `SELECT t.secret_hash, t.scopes, t.expires_at, t.last_used_at,
            t.principal_id, p.login_email
     FROM tokens t JOIN principals p ON p.id = t.principal_id
     WHERE t.id = ? AND t.kind = 'bearer'`,
  )
    .bind(parsed.id)
    .first<{
      secret_hash: string;
      scopes: string;
      expires_at: number | null;
      last_used_at: number | null;
      principal_id: string;
      login_email: string;
    }>();
  if (!row) return null;
  if (!(await verifyTokenSecret(parsed.secret, row.secret_hash))) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;

  const { results: accountRows } = await env.DB.prepare(
    `SELECT id, tenant_id, display_name FROM accounts WHERE principal_id = ? ORDER BY created_at`,
  )
    .bind(row.principal_id)
    .all<{ id: string; tenant_id: string; display_name: string }>();

  // Throttled liveness bookkeeping — one small write per token per window.
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_WRITE_INTERVAL_MS) {
    await env.DB.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`)
      .bind(now, parsed.id)
      .run();
  }

  return {
    username: row.login_email,
    scopes: JSON.parse(row.scopes) as string[],
    accounts: accountRows.map((a) => ({
      accountId: a.id,
      tenantId: a.tenant_id,
      name: a.display_name,
    })),
  };
}

export function accountAccess(principal: Principal, accountId: string): AccountAccess | null {
  return principal.accounts.find((a) => a.accountId === accountId) ?? null;
}

export function principalHasScope(principal: Principal, scope: string): boolean {
  return hasScope(principal.scopes, scope);
}
