import { isBureauVerb, resolveBureauGrant, verifyBearer, type BureauGrant } from "@bullmoose/auth-core/principal";
import type { Env } from "./models.js";
// Metadata only — `credentialContract` reads `kind` + `meta_json` and never
// `enc_json`. The authorization spine has no business holding a secret.
import { credentialContract } from "./vault.js";

/**
 * The authorization spine every Bureau verb runs through (bureau.md §5.1, §11
 * invariant 6; s04 T2).
 *
 * Three things happen here, in this order, and the order is load-bearing:
 *
 *   1. **Authenticate the caller.** `verifyBearer` on the presented invocation
 *      token — never a self-asserted principal id in the body. The service
 *      binding proves which WORKER is calling; only the token proves which
 *      AGENT. That distinction is the whole reason this step exists: `travel@`
 *      and `editor@` run in the same agent worker and arrive over the same
 *      binding, so without the token a prompt-injected `editor@` (sVOL 014 reads
 *      untrusted email) would inherit `travel@`'s grants for free.
 *   2. **Authorize the tuple** `(principal, credRef, verb)`, exactly — not a
 *      prefix, not a neighbouring verb, not another credential.
 *   3. **Audit the attempt**, before answering, whether it was allowed or not.
 *
 * Why `verifyBearer` and not a JWT (arch.md OQ1b, ratified): issuer and verifier
 * are the same service, so offline verification buys nothing — and it would COST
 * revocability. A JWT is valid until it expires; this system's two kill switches
 * (`008`'s `agent_bindings.enabled`, `s03.A`'s `grants.revoked_at`) both work by
 * making a token stop resolving on the next check. Going through `verifyBearer`
 * inherits every one of them for free, for the price of one D1 read that is
 * noise beside the outbound request the call is about to make.
 *
 * The Bureau VERIFIES; it never ISSUES. There is no token-minting route here and
 * there must never be one.
 */

export type UseDecision =
  | {
      ok: true;
      principalId: string;
      principal: string;
      grant: BureauGrant;
      kind: string;
      meta: Record<string, unknown>;
    }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string };

export interface UseRequest {
  verb?: unknown;
  credRef?: unknown;
}

/**
 * Authenticate → authorize → audit. Returns the credential's CONTRACT (kind +
 * §5 metadata) on success and never the credential itself; unsealing is the verb
 * runtime's job (T3/T5), downstream of this decision.
 */
export async function authorizeUse(
  env: Env,
  request: Request,
  body: UseRequest,
): Promise<UseDecision> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const principal = await verifyBearer(env.DB, header.slice(7));
  if (!principal) return { ok: false, status: 401, error: "unauthorized" };

  const verb = typeof body.verb === "string" ? body.verb : "";
  const credRef = typeof body.credRef === "string" ? body.credRef : "";
  if (!verb || !credRef) {
    return { ok: false, status: 400, error: "verb and credRef are required" };
  }
  if (!isBureauVerb(verb)) {
    return { ok: false, status: 400, error: `unknown verb: ${verb}` };
  }

  // `verifyBearer` returns the login email, not the principal id — the grant
  // tuple is keyed on the id, so resolve it here rather than widening the
  // Principal shape every caller in the repo constructs.
  const row = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(principal.username.toLowerCase())
    .first<{ id: string }>();
  if (!row) return { ok: false, status: 401, error: "unauthorized" };
  const principalId = row.id;

  const grant = await resolveBureauGrant(env.DB, principalId, credRef, verb);

  // Invariant 6: every ATTEMPTED use is written, allowed or refused. The
  // existing grant_audit contract already says rows record attempts rather than
  // outcomes (introspectTools' ACCESS_LOG_LIMITATIONS), so a refusal belongs in
  // the same trail — an agent probing for credentials it was never granted is
  // exactly what an audit log is for, and it is the one case a
  // write-only-on-success log would silently drop.
  await auditUse(env, principal.username, principalId, credRef, verb, grant?.grantId ?? null);

  // Refusal BEFORE the credential lookup, deliberately: an ungranted caller gets
  // the same 403 whether or not the credential exists, so the error code cannot
  // be used to enumerate what is in someone's vault.
  if (!grant) {
    return {
      ok: false,
      status: 403,
      error: `no live grant for (${principal.username}, ${credRef}, ${verb})`,
    };
  }

  const contract = await credentialContract(env, principalId, credRef);
  if (!contract) return { ok: false, status: 404, error: `no credential named ${credRef}` };

  return {
    ok: true,
    principalId,
    principal: principal.username,
    grant,
    kind: contract.kind,
    meta: contract.meta,
  };
}

/**
 * One row per attempted use, on the EXISTING `grant_audit` path (invariant 6) —
 * a second audit table would mean two places to look when answering "what did
 * this agent do?".
 *
 * Two shape notes for whoever reads this trail:
 *  - `method` is `bureau:<verb>:<credRef>`, a fourth shape beside `mcp:<tool>`
 *    and the two JMAP `<domain>:<scope>` forms. The credRef is on the row
 *    because invariant 6 audits the whole tuple, and there is no column for it.
 *  - `grant_id` is `none` when nothing authorized the attempt. Every other
 *    writer names a real grant, so a reader joining `grant_audit` to `grants`
 *    will not resolve these rows — by design: a refusal HAS no grant, and
 *    inventing one would be a lie in the forensic record.
 *
 * `account_id` is NOT NULL and a Bureau grant is principal-scoped rather than
 * account-scoped, so it carries the principal's first owned account — which is
 * what makes the use visible in that account's access log — falling back to the
 * principal id when the principal owns none.
 */
async function auditUse(
  env: Env,
  principalEmail: string,
  principalId: string,
  credRef: string,
  verb: string,
  grantId: string | null,
): Promise<void> {
  const acct = await env.DB.prepare(
    `SELECT id FROM accounts WHERE principal_id = ? AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1`,
  )
    .bind(principalId)
    .first<{ id: string }>();
  await env.DB.prepare(
    `INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      grantId ?? "none",
      principalEmail,
      acct?.id ?? principalId,
      `bureau:${verb}:${credRef}`,
      Date.now(),
    )
    .run();
}
