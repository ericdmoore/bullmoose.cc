import { verifyBearer } from "@bullmoose/auth-core/principal";

/**
 * Credential list/revoke — s33's closer. The rules of the surface:
 *
 *   OWN ONLY. A bearer sees and removes its OWN principal's authenticators;
 *   someone else's credential id answers exactly like a nonexistent one
 *   (no oracle in the difference).
 *
 *   AGENTS NEVER. An agent-scoped token managing the human's authenticators
 *   is the confused deputy at its sharpest — refused by scope, the s37
 *   owner-read precedent.
 *
 *   THE LAST CREDENTIAL OF A PASSWORDLESS PRINCIPAL STAYS. Revoking a LOST
 *   device must always work (that is what revocation is FOR), but removing
 *   the final passkey of an account with no password rung locks it forever
 *   — the weakest-recovery rule from the other side. The refusal names the
 *   two ways out: enroll a replacement first, or the admin-reset rung.
 */

interface ManageEnv {
  DB: D1Database;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function principalOf(request: Request, env: ManageEnv): Promise<{ id: string } | { error: Response }> {
  const raw = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const principal = raw ? await verifyBearer(env.DB, raw) : null;
  if (!principal) return { error: json({ error: "authentication required" }, 401) };
  if (principal.scopes.includes("agent")) {
    return {
      error: json(
        { error: "an agent token cannot manage the human's authenticators — this surface is owner-only" },
        403,
      ),
    };
  }
  const row = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(principal.username)
    .first<{ id: string }>();
  if (!row) return { error: json({ error: "authentication required" }, 401) };
  return { id: row.id };
}

/** GET /webauthn/credentials — the principal's own authenticators. */
export async function listCredentials(request: Request, env: ManageEnv): Promise<Response> {
  const who = await principalOf(request, env);
  if ("error" in who) return who.error;
  const { results } = await env.DB.prepare(
    `SELECT id, label, aaguid, created_at, last_used_at FROM webauthn_credentials
      WHERE principal_id = ? ORDER BY created_at`,
  )
    .bind(who.id)
    .all<{
      id: string;
      label: string | null;
      aaguid: string | null;
      created_at: number;
      last_used_at: number | null;
    }>();
  return json({
    credentials: (results ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      aaguid: c.aaguid,
      createdAt: c.created_at,
      // s37's display discipline holds here too: "last used", never
      // "active" — a stored key is not a device state.
      lastUsedAt: c.last_used_at,
    })),
  });
}

/** DELETE /webauthn/credentials/{id} — revoke one authenticator. */
export async function revokeCredential(request: Request, env: ManageEnv, credentialId: string): Promise<Response> {
  const who = await principalOf(request, env);
  if ("error" in who) return who.error;

  const mine = await env.DB.prepare(`SELECT 1 AS hit FROM webauthn_credentials WHERE id = ? AND principal_id = ?`)
    .bind(credentialId, who.id)
    .first<{ hit: number }>();
  // Someone else's and nonexistent answer identically — no oracle.
  if (!mine) return json({ error: "no such credential of yours" }, 404);

  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM webauthn_credentials WHERE principal_id = ?1) AS passkeys,
            (SELECT COUNT(*) FROM credentials WHERE principal_id = ?1) AS passwords`,
  )
    .bind(who.id)
    .first<{ passkeys: number; passwords: number }>();
  if ((counts?.passkeys ?? 0) <= 1 && (counts?.passwords ?? 0) === 0) {
    return json(
      {
        error:
          "this is the last passkey of a passwordless account — removing it would lock the account " +
          "forever. Enroll a replacement first, or use the admin-reset rung.",
      },
      409,
    );
  }

  await env.DB.prepare(`DELETE FROM webauthn_credentials WHERE id = ? AND principal_id = ?`)
    .bind(credentialId, who.id)
    .run();
  return json({ revoked: credentialId });
}
