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
  /**
   * Present iff this principal authenticated with a minted `bm_` token; the
   * OAuth and dev-bootstrap paths carry none. A named token IS a registered
   * device (s37), so anything device-scoped — a DeviceReport, above all —
   * binds to THIS id and never to a client-supplied one: one device must not
   * be able to write another's self-description.
   */
  tokenId?: string;
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
      accounts: [{ accountId: env.DEV_ACCOUNT_ID, tenantId: env.DEV_TENANT_ID, name: env.DEV_USERNAME }],
    };
  }

  const principal = await verifyBearer(env.DB, raw);
  if (!principal) return null;
  // App-password: a Basic username, when present, must be the token's own
  // principal (its login email).
  if (basicUser && basicUser.toLowerCase() !== principal.username.toLowerCase()) {
    return null;
  }
  return principal;
}

/**
 * Bearer → principal, decoupled from the HTTP request so any transport can
 * reuse it — the stateless-MCP handler resolves identity through this rather
 * than through `authenticate`. Reads the token row, its owned accounts, and
 * the grants that extend its reach; returns null for any missing/invalid/
 * expired token. `db` is injected, so the whole path is testable with a fake
 * D1 (no request, no env).
 */
export async function verifyBearer(db: D1Database, raw: string): Promise<Principal | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;

  const row = await db
    .prepare(
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

  // `deleted_at IS NULL` is what makes `DELETE /accounts/{id}` mean anything:
  // the tombstone is a soft delete (sVOL 008), so without this filter a
  // "deleted" account keeps authenticating and keeps serving its mail.
  // Throttled liveness bookkeeping — one small write per token per window.
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_WRITE_INTERVAL_MS) {
    await db.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).bind(now, parsed.id).run();
  }

  return {
    username: row.login_email,
    scopes: JSON.parse(row.scopes) as string[],
    accounts: await reachableAccounts(db, row.principal_id),
    tokenId: parsed.id,
  };
}

/**
 * Every account a principal can reach — owned first, then grant-reached.
 *
 * Split out of `verifyBearer` (s02 T4) because a `bm_` token is no longer the
 * only way to become a principal: an OAuth access token authenticates the
 * same human, and its scopes come from the consent grant rather than from a
 * `tokens` row. What must NOT fork is which accounts that human reaches and
 * on what basis — so the reach is computed here, once, for both credentials.
 */
export async function reachableAccounts(db: D1Database, principalId: string): Promise<AccountAccess[]> {
  // `deleted_at IS NULL` is what makes `DELETE /accounts/{id}` mean anything:
  // the tombstone is a soft delete (sVOL 008), so without this filter a
  // "deleted" account keeps authenticating and keeps serving its mail.
  const { results: accountRows } = await db
    .prepare(
      `SELECT id, tenant_id, display_name FROM accounts
     WHERE principal_id = ? AND deleted_at IS NULL ORDER BY created_at`,
    )
    .bind(principalId)
    .all<{ id: string; tenant_id: string; display_name: string }>();

  const now = Date.now();
  const accounts: AccountAccess[] = accountRows.map((a) => ({
    accountId: a.id,
    tenantId: a.tenant_id,
    name: a.display_name,
  }));

  // Grants extend the principal's reach to other accounts (sharing +
  // agent delegation). Owned accounts win over grants to themselves.
  if (accounts.length > 0) {
    const marks = accounts.map(() => "?").join(",");
    // `revoked_at IS NULL` is the s03.A T2 tombstone filter, sitting beside the
    // existing `expires_at` check: a revoked grant stops resolving IMMEDIATELY
    // while its row (and its grant_lifecycle history) survive, so a point-in-time
    // query can still reconstruct who could reach this account last Tuesday. This
    // is a resolution-layer change only — `authorizeAccount` is untouched, so the
    // authz DECISION is identical.
    const { results: grantRows } = await db
      .prepare(
        `SELECT g.id, g.target_account_id, g.scopes, g.collection, g.collection_id,
              a.tenant_id, a.display_name
       FROM grants g JOIN accounts a ON a.id = g.target_account_id
       WHERE g.grantee_account_id IN (${marks})
         AND a.deleted_at IS NULL
         AND g.revoked_at IS NULL
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

  return accounts;
}

/**
 * Become a principal from a CONSENT GRANT rather than from a `bm_` token
 * (s02 T4) — the resource-server half of the OAuth bridge.
 *
 * The two arguments come from different places on purpose, and the split is
 * the security property:
 *
 *  - `principalId` is server-resolved: the AS put it into the provider's
 *    ENCRYPTED props after verifying a password, so it is not client-supplied
 *    and cannot be swapped by whoever holds the token.
 *  - `scopes` are the scopes of THIS grant, not the human's full authority. A
 *    connected app that was granted `read` gets `read`, even though the owner
 *    could have granted more. Passing the principal's own scopes here would
 *    silently upgrade every connected app to full account authority.
 *
 * Returns null when the principal no longer exists, so deleting a human
 * revokes their connected apps without a second bookkeeping step.
 */
export async function principalFromGrant(
  db: D1Database,
  principalId: string,
  scopes: string[],
): Promise<Principal | null> {
  const row = await db
    .prepare(`SELECT id, login_email FROM principals WHERE id = ?`)
    .bind(principalId)
    .first<{ id: string; login_email: string }>();
  if (!row) return null;
  return { username: row.login_email, scopes, accounts: await reachableAccounts(db, row.id) };
}

export function accountAccess(principal: Principal, accountId: string): AccountAccess | null {
  return principal.accounts.find((a) => a.accountId === accountId) ?? null;
}

export function principalHasScope(principal: Principal, scope: string): boolean {
  return hasScope(principal.scopes, scope);
}

/**
 * Is this an agent-runtime identity? True when the token carries the "agent"
 * marker scope (see AGENT_MARKER_SCOPE in auth-core). Checked verbatim, not
 * via hasScope — the marker is metadata, not a capability, and no bundle may
 * imply it. Used by the contact-write chokepoint's callers (JMAP, CardDAV) to
 * decide the writer kind; the MCP tool surface and the agent worker's own
 * writes are agent-driven by construction and do not consult it.
 */
export function isAgentPrincipal(principal: Pick<Principal, "scopes">): boolean {
  return principal.scopes.includes("agent");
}

/** Method domains for grant coverage: a collection-scoped grant only
 * unlocks its domain's methods; a whole-account grant covers any domain
 * its scopes allow. `files` (FileNode realm, sVOL 011) has no collection-scoped
 * grant type in this slice — sharing is deferred to the ACL epic (shareWith is
 * always null) — so a `files` grant is reachable only via a whole-account
 * grant (collection === null), which grantCoversDomain already covers. */
export type MethodDomain = "mail" | "contacts" | "calendar" | "files";

function grantCoversDomain(g: GrantRef, domain: MethodDomain): boolean {
  if (g.collection === null) return true;
  if (g.collection === "AddressBook") return domain === "contacts";
  if (g.collection === "Calendar") return domain === "calendar";
  return false;
}

/** Grants on this access that satisfy scope+domain (empty for owners). */
export function matchingGrants(access: AccountAccess, scope: string, domain: MethodDomain): GrantRef[] {
  if (!access.granted) return [];
  return access.granted.filter((g) => grantCoversDomain(g, domain) && hasScope(g.scopes, scope));
}

/**
 * Pure authorization decision for one account access, shared by every
 * transport that gates on scope ∩ grant (the JMAP `requireAccount` method
 * gate and the stateless-MCP handler both run on this). No I/O: it resolves
 * the account on the principal, enforces the token scope, and — for
 * grant-reached accounts — the token ∩ grant intersection over the method's
 * domain. It returns the grant that MUST be written to `grant_audit` (null
 * for owned accounts); performing that write is the caller's job, so the
 * effect stays in the shell and the decision stays testable without a DB.
 */
export type AuthzDecision =
  | { ok: true; access: AccountAccess; auditGrant: GrantRef | null }
  | { ok: false; reason: "accountNotFound" }
  | { ok: false; reason: "forbidden"; detail: string };

export function authorizeAccount(
  principal: Principal,
  accountId: string,
  scope: string,
  domain: MethodDomain = "mail",
): AuthzDecision {
  const access = accountAccess(principal, accountId);
  if (!access) return { ok: false, reason: "accountNotFound" };
  if (!principalHasScope(principal, scope)) {
    return { ok: false, reason: "forbidden", detail: `token lacks the "${scope}" scope` };
  }
  if (access.granted) {
    const matching = matchingGrants(access, scope, domain);
    if (matching.length === 0) {
      return {
        ok: false,
        reason: "forbidden",
        detail: `no grant covers "${scope}" on this account`,
      };
    }
    return { ok: true, access, auditGrant: matching[0]! };
  }
  return { ok: true, access, auditGrant: null };
}

// ---- Bureau grants (bureau.md §5.1, s04 T2) --------------------------------
//
// A SECOND, deliberately separate grant vocabulary, living here beside
// `authorizeAccount` because this file is the repo's authorization module — not
// because the two share a table. They do not: see `bureau_grants` in
// control-plane.sql for why account-sharing grants and capability grants cannot
// be one row shape. What they DO share is the tombstone contract, and this is
// the resolution layer that enforces it (`revoked_at IS NULL`), exactly as
// `verifyBearer` does for `grants`.

/** The Bureau's closed verb set (bureau.md §4). Widening it widens the oracle
 *  surface, so the bar is high — each verb exists only because its protocol
 *  cannot be expressed as "proxy the call". */
export const BUREAU_VERBS = ["fetch", "oauth_token", "sign_sigv4", "hmac_sha256"] as const;
export type BureauVerb = (typeof BUREAU_VERBS)[number];

export function isBureauVerb(v: string): v is BureauVerb {
  return (BUREAU_VERBS as readonly string[]).includes(v);
}

/** One live capability: this principal may use this verb with this credRef. */
export interface BureauGrant {
  grantId: string;
  principalId: string;
  credRef: string;
  verb: BureauVerb;
  expiresAt: number | null;
}

/**
 * Resolve `(principal, credRef, verb)` to a LIVE grant, or null.
 *
 * The tuple is matched exactly — no prefix, no wildcard, no "adjacent" verb and
 * no other credential. A grant on `sign_sigv4`+`aws-mcp` says nothing about
 * `fetch`+`aws-mcp` or `sign_sigv4`+`stripe`, and that narrowness IS the
 * capability model: authorization is over what you may DO, not what you may
 * reach.
 *
 * Filters `revoked_at IS NULL` (the s03.A tombstone contract — a revoked grant
 * stops resolving immediately while its row and history survive) and expiry, the
 * same two clauses `verifyBearer` applies to account grants. `db` is injected so
 * the decision is testable against a fake D1 with no request and no env.
 */
export async function resolveBureauGrant(
  db: D1Database,
  principalId: string,
  credRef: string,
  verb: string,
  now = Date.now(),
): Promise<BureauGrant | null> {
  if (!isBureauVerb(verb)) return null;
  const row = await db
    .prepare(
      `SELECT id, expires_at FROM bureau_grants
     WHERE principal_id = ? AND cred_name = ? AND verb = ?
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(principalId, credRef, verb, now)
    .first<{ id: string; expires_at: number | null }>();
  if (!row) return null;
  return { grantId: row.id, principalId, credRef, verb, expiresAt: row.expires_at };
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
  return new Set(matching.flatMap((g) => (g.collection === "AddressBook" && g.collectionId ? [g.collectionId] : [])));
}
