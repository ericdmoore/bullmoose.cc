/**
 * The D1 mirror of an OAuth consent (s02 T4).
 *
 * KV stays CANONICAL for authorization — nothing here is ever consulted to
 * decide a request, and a row with no live KV grant confers nothing. This
 * table exists to be read by humans, through `s03.E`'s console and
 * `who_can_access`, both of which read D1 and would otherwise answer "who can
 * reach my mail?" with silence for every connected client.
 *
 * Silence is the specific failure worth spending a table on. An access list
 * that omits claude.ai is not visibly wrong — it renders as "nobody else",
 * and the person reading it is reading precisely because they want to know.
 * The plan's guiding constraint puts it plainly: a public MCP endpoint whose
 * grants are invisible to that console is worse than no public endpoint,
 * because the surface whose whole job is answering that question starts lying
 * by omission.
 *
 * Both functions are BEST-EFFORT and never throw into the OAuth flow. The
 * mirror is a disclosure aid; failing a human's login because a reporting
 * write failed would trade a real capability for a cosmetic one. The cost of
 * that choice is an unmirrored grant, which is why the write sits on the
 * consent path itself — the one moment we are certain a consent happened —
 * rather than in a reconciling sweep that could silently fall behind.
 */

export interface ConsentRecord {
  principalId: string;
  clientId: string;
  clientName?: string;
  redirectHost?: string;
  scopes: string[];
  resource?: string;
}

/** A D1 that may predate the s02 T4 migration. */
type MaybeDb = D1Database;

function id(): string {
  return `oc_${crypto.randomUUID()}`;
}

/**
 * Record a consent. Returns the row id, or null when the write could not
 * happen — including on a shard whose schema predates this table, which must
 * keep issuing tokens rather than refusing to log in.
 */
export async function recordConsent(db: MaybeDb, rec: ConsentRecord, now: number): Promise<string | null> {
  const rowId = id();
  try {
    await db
      .prepare(
        `INSERT INTO oauth_consents
           (id, principal_id, client_id, client_name, redirect_host, scopes, resource, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        rowId,
        rec.principalId,
        rec.clientId,
        rec.clientName ?? null,
        rec.redirectHost ?? null,
        JSON.stringify(rec.scopes),
        rec.resource ?? null,
        now,
      )
      .run();
    return rowId;
  } catch {
    // Degrade to no-op: the token is still issued and still authorizes. What
    // is lost is the console's ability to SHOW it, which is worth reporting
    // but not worth refusing a login over.
    console.warn("oauth consent mirror degraded to no-op (missing oauth_consents table?)");
    return null;
  }
}

/**
 * Tombstone every live consent for this principal + client.
 *
 * Same bargain as `grants.revoked_at`: revoking sets the column rather than
 * deleting the row, so "what did I have connected last Tuesday?" survives the
 * revocation. Scoped to one client so revoking Claude Code does not silently
 * disconnect claude.ai.
 */
export async function revokeConsent(db: MaybeDb, principalId: string, clientId: string, now: number): Promise<number> {
  try {
    const res = await db
      .prepare(
        `UPDATE oauth_consents SET revoked_at = ?
         WHERE principal_id = ? AND client_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, principalId, clientId)
      .run();
    return res.meta?.changes ?? 0;
  } catch {
    console.warn("oauth consent revoke mirror degraded to no-op");
    return 0;
  }
}
