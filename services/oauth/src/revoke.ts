import { verifyBearer } from "@bullmoose/auth-core/principal";
import { revokeConsent } from "./consentMirror.js";

/**
 * POST /revoke — the owner disconnects a connected app (s02 T4's second half).
 *
 * Shipping connect without disconnect was the consent-invisibility failure one
 * layer up: a grant you can see but cannot kill. This closes it. The provider's
 * `revokeGrant` deletes every token under the grant's KV prefix BEFORE deleting
 * the grant (verified in source, oauth-provider.js:3834-3850), so access and
 * refresh tokens die immediately — not at their natural expiry.
 *
 * ## Who may call it, and why the answer is "a bm_ credential only"
 *
 * The route authenticates the presented bearer ITSELF, with `verifyBearer`
 * against D1 — it never trusts a caller-asserted principal id, which is what
 * makes it safe to serve on the public hostname (the credential required to
 * disconnect your apps is your own credential; a caller can only ever revoke
 * their own grants). That also makes it directly usable from the CLI:
 *
 *     curl -X POST https://auth.bullmoose.cc/revoke \
 *       -H 'authorization: Bearer bm_…' -d '{"clientId":"…"}'
 *
 * An OAuth access token is deliberately NOT accepted here. A connected app
 * that could revoke OTHER apps would be a confused deputy with a kill switch;
 * an app that wants to disconnect ITSELF already has RFC 7009 revocation at
 * the standard endpoint. Managing the roster of connected apps is owner
 * business, done with the owner's own device credential.
 *
 * Revocation is deny-only — the worst failure is disconnecting an app that
 * then has to reconnect — which is why no scope beyond a valid credential is
 * demanded (the bouncer precedent: the failure direction earns the latitude).
 *
 * A leaf module (no import from index.ts) so it is testable in plain Node:
 * index.ts pulls the provider, and the provider pulls `cloudflare:workers`.
 */

/** The slice of the worker Env this route needs. Structurally satisfied by
 *  index.ts's Env; declared here so tests need no provider import. */
export interface RevokeEnv {
  DB: D1Database;
  OAUTH_PROVIDER: {
    listUserGrants(
      userId: string,
      options?: { limit?: number; cursor?: string },
    ): Promise<{ items: Array<{ id: string; clientId: string }>; cursor?: string }>;
    revokeGrant(grantId: string, userId: string): Promise<void>;
  };
}

export async function revoke(request: Request, env: RevokeEnv): Promise<Response> {
  const authz = request.headers.get("authorization") ?? "";
  const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  const principal = raw ? await verifyBearer(env.DB, raw) : null;
  if (!principal) {
    return Response.json({ error: "a bullmoose device token (bm_…) is required" }, { status: 401 });
  }

  let body: { clientId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "JSON body with clientId required" }, { status: 400 });
  }
  const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
  if (!clientId) return Response.json({ error: "clientId is required" }, { status: 400 });

  // Grants are keyed by principal ID (what consent stored as userId), not by
  // login email — resolve it server-side from the verified credential.
  const row = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(principal.username)
    .first<{ id: string }>();
  if (!row) return Response.json({ error: "no principal" }, { status: 404 });

  // Kill every live grant this principal holds with this client. Paged, and
  // each revocation deletes the grant's tokens first (see the header note).
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(row.id, cursor ? { cursor } : undefined);
    for (const g of page.items) {
      if (g.clientId === clientId) {
        await env.OAUTH_PROVIDER.revokeGrant(g.id, row.id);
        revoked++;
      }
    }
    cursor = page.cursor;
  } while (cursor);

  // Tombstone the D1 mirror so the console stops showing the app — the same
  // moment, the same request, because a mirror that lags a revocation shows
  // an app as connected that can no longer act, and the person who just
  // revoked it is exactly the person looking.
  const mirrored = await revokeConsent(env.DB, row.id, clientId, Date.now());

  return Response.json({ ok: true, revokedGrants: revoked, mirroredConsents: mirrored });
}
