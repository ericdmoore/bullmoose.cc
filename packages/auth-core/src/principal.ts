import { hasScope, parseToken, verifyTokenSecret } from "./index";

/**
 * Bearer-token auth against the control-plane tokens table. One table
 * serves device tokens, agent tokens, and (control-plane) admin tokens —
 * see packages/auth-core. DEV_BEARER_TOKEN remains as a local-dev
 * bootstrap that maps to a synthetic single-account principal.
 */

/** One grant row, resolved onto a granted AccountAccess. */
export interface GrantRef {
  grantId: string;
  /** Same vocabulary as token scopes; effective = token ∩ grant. */
  scopes: string[];
  /** NULL = whole account; 'AddressBook' = one shared book. */
  collection: string | null;
  collectionId: string | null;
}

export interface AccountAccess {
  accountId: string;
  tenantId: string;
  name: string;
  /** Present iff access comes through grants rather than ownership. */
  granted?: GrantRef[];
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
  // App-password pattern: third-party JMAP clients (Mailtemi, etc.) often
  // only speak HTTP Basic. Accept Basic where the password IS a minted
  // bm_ token; the username must match the token's principal.
  let basicUser: string | null = null;
  if (!raw && header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const colon = decoded.indexOf(":");
      if (colon > 0) {
        basicUser = decoded.slice(0, colon);
        raw = decoded.slice(colon + 1);
      }
    } catch {
      return null;
    }
  }
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
  if (basicUser && basicUser.toLowerCase() !== row.login_email.toLowerCase()) return null;

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

  const accounts: AccountAccess[] = accountRows.map((a) => ({
    accountId: a.id,
    tenantId: a.tenant_id,
    name: a.display_name,
  }));

  // Grants extend the principal's reach to other accounts (sharing +
  // agent delegation). Owned accounts win over grants to themselves.
  if (accounts.length > 0) {
    const marks = accounts.map(() => "?").join(",");
    const { results: grantRows } = await env.DB.prepare(
      `SELECT g.id, g.target_account_id, g.scopes, g.collection, g.collection_id,
              a.tenant_id, a.display_name
       FROM grants g JOIN accounts a ON a.id = g.target_account_id
       WHERE g.grantee_account_id IN (${marks})
         AND (g.expires_at IS NULL OR g.expires_at > ?)`,
    )
      .bind(...accounts.map((a) => a.accountId), now)
      .all<{
        id: string;
        target_account_id: string;
        scopes: string;
        collection: string | null;
        collection_id: string | null;
        tenant_id: string;
        display_name: string;
      }>();

    const owned = new Set(accounts.map((a) => a.accountId));
    const grantedByTarget = new Map<string, AccountAccess>();
    for (const g of grantRows) {
      if (owned.has(g.target_account_id)) continue;
      const ref: GrantRef = {
        grantId: g.id,
        scopes: JSON.parse(g.scopes) as string[],
        collection: g.collection,
        collectionId: g.collection_id,
      };
      const existing = grantedByTarget.get(g.target_account_id);
      if (existing) existing.granted!.push(ref);
      else {
        grantedByTarget.set(g.target_account_id, {
          accountId: g.target_account_id,
          tenantId: g.tenant_id,
          name: g.display_name,
          granted: [ref],
        });
      }
    }
    accounts.push(...grantedByTarget.values());
  }

  return {
    username: row.login_email,
    scopes: JSON.parse(row.scopes) as string[],
    accounts,
  };
}

export function accountAccess(principal: Principal, accountId: string): AccountAccess | null {
  return principal.accounts.find((a) => a.accountId === accountId) ?? null;
}

export function principalHasScope(principal: Principal, scope: string): boolean {
  return hasScope(principal.scopes, scope);
}

/** Method domains for grant coverage: an AddressBook-scoped grant only
 * unlocks contacts methods; a whole-account grant covers any domain its
 * scopes allow. */
export type MethodDomain = "mail" | "contacts";

function grantCoversDomain(g: GrantRef, domain: MethodDomain): boolean {
  if (g.collection === null) return true;
  return g.collection === "AddressBook" && domain === "contacts";
}

/** Grants on this access that satisfy scope+domain (empty for owners). */
export function matchingGrants(
  access: AccountAccess,
  scope: string,
  domain: MethodDomain,
): GrantRef[] {
  if (!access.granted) return [];
  return access.granted.filter((g) => grantCoversDomain(g, domain) && hasScope(g.scopes, scope));
}

/**
 * Collection restriction for contacts methods: null = unrestricted
 * (owner, or a whole-account grant); otherwise the set of AddressBook
 * ids the principal may touch under this scope.
 */
export function allowedBookIds(access: AccountAccess, scope: string): Set<string> | null {
  if (!access.granted) return null;
  const matching = matchingGrants(access, scope, "contacts");
  if (matching.some((g) => g.collection === null)) return null;
  return new Set(
    matching.flatMap((g) =>
      g.collection === "AddressBook" && g.collectionId ? [g.collectionId] : [],
    ),
  );
}
