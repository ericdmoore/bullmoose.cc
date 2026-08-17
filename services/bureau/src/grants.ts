import {
  isBureauVerb,
  resolveBureauGrant,
  verifyBearer,
  type BureauGrant,
} from "@bullmoose/auth-core/principal";
import {
  principalForInvocation,
  resolveInvocationToken,
  type InvocationIdentity,
} from "@bullmoose/auth-core/invocation";
import { describeDenial, effectiveNodeAuthority, mayUse } from "@bullmoose/scheduling";
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
 *
 * ── THE FOURTH STEP: THE ENVELOPE (s17 (c)) ────────────────────────────────
 * A delegated invocation carries an authority envelope whose `credentials` axis
 * named `vault_credentials.name` HANDLES — and until now that axis had NO
 * consumer anywhere in the tree. The reason was structural, not an oversight:
 * step 1 authorizes a BEARER, and a `bm_` bearer is a principal, so
 * `resolveBureauGrant(principal, credRef, verb)` had nothing to intersect
 * against. A `bmi_` per-invocation token (`@bullmoose/auth-core/invocation`)
 * NAMES the acting invocation, so the axis finally has one — this file.
 *
 * The two vocabularies line up with NO translation, and that is checked rather
 * than assumed: `bureau_grants.cred_name` is documented in `control-plane.sql`
 * as *"the public handle (`vault_credentials.name`), not the row id"*, and
 * `attenuation.ts`'s axis table says the `credentials` axis carries *"
 * `vault_credentials.name` HANDLES — the `credentialRef` an agent config
 * carries"*. Same string, same table, same column. `grants.test.ts` asserts a
 * grant and an envelope written with the same literal handle resolve to the
 * same credential.
 *
 * ⚠️ **THE COMPOSITION INVARIANT.** The envelope is ANDed **after** step 1,
 * never substituted for it. `mayUse` is a DENIAL function — `credentials: null`
 * means "no level of this chain declared the axis" (the DefaultCase the Job
 * columns were built with), and it is NOT a grant. A caller that reached this
 * file with an envelope naming `aws-mcp` and no `bureau_grants` row must still
 * be refused, and the refusal must be step 1's. Reading `effective` as a grant
 * would turn the whole capability model into an access model that anyone who
 * can write `authority_json` can widen.
 *
 * ⚠️ **WHERE THIS STOPS**, named so it is a boundary and not an oversight — the
 * same shape as the MCP tool axis. An invocation with no `job_id` is not a
 * delegation: `effectiveNodeAuthority` answers `{credentials: null, …}` for it,
 * `mayUse` then admits every handle, and `bureau_grants` alone governs, exactly
 * as it did before s17. So gap 2 CLOSES for Job nodes and merely NARROWS
 * (lifetime, and one invocation instead of a principal's whole reach) for an
 * ordinary mail-triggered invocation. Closing the rest means redefining
 * `config_json.jobs.credentials` as bounding every invocation of a binding
 * rather than only its Job nodes — a decision about what that key means, taken
 * with whoever owns the key, not a patch applied here.
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
  /**
   * The verb's arguments — for `fetch`, the request the agent wants proxied
   * (`{url, method?, headers?, body?}`; see `fetchVerb.ts`). Opaque to the
   * authorization spine on purpose: authorization is a decision about a tuple,
   * and nothing the caller puts in here may influence it. Note what a caller
   * still cannot supply anywhere on this interface — the header name, the
   * destination allowlist, or any transform (§2).
   */
  request?: unknown;
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
  const caller = await authenticateCaller(env, header.slice(7));
  if (!caller) return { ok: false, status: 401, error: "unauthorized" };

  const verb = typeof body.verb === "string" ? body.verb : "";
  const credRef = typeof body.credRef === "string" ? body.credRef : "";
  if (!verb || !credRef) {
    return { ok: false, status: 400, error: "verb and credRef are required" };
  }
  if (!isBureauVerb(verb)) {
    return { ok: false, status: 400, error: `unknown verb: ${verb}` };
  }

  const grant = await resolveBureauGrant(env.DB, caller.principalId, credRef, verb);

  // Invariant 6: every ATTEMPTED use is written, allowed or refused. The
  // existing grant_audit contract already says rows record attempts rather than
  // outcomes (introspectTools' ACCESS_LOG_LIMITATIONS), so a refusal belongs in
  // the same trail — an agent probing for credentials it was never granted is
  // exactly what an audit log is for, and it is the one case a
  // write-only-on-success log would silently drop. An ENVELOPE refusal is an
  // attempt too, and is audited by the same call: the row records that this
  // principal reached for this tuple, which is the forensic question, and the
  // reason it was refused is in the response.
  await auditUse(env, caller.username, caller.principalId, credRef, verb, grant?.grantId ?? null);

  // Refusal BEFORE the credential lookup, deliberately: an ungranted caller gets
  // the same 403 whether or not the credential exists, so the error code cannot
  // be used to enumerate what is in someone's vault.
  if (!grant) {
    return {
      ok: false,
      status: 403,
      error: `no live grant for (${caller.username}, ${credRef}, ${verb})`,
    };
  }

  // …AND THEN the envelope (s17 (c)). STRICTLY after the standing check, and in
  // front of the credential lookup for the same enumeration reason: an
  // invocation whose delegation did not carry this handle must not be able to
  // tell a credential that exists from one that does not.
  if (caller.invocation) {
    const gated = await envelopeAllowsCredential(env, caller.invocation, credRef);
    if (!gated.ok) return gated.refusal;
  }

  const contract = await credentialContract(env, caller.principalId, credRef);
  if (!contract) return { ok: false, status: 404, error: `no credential named ${credRef}` };

  return {
    ok: true,
    principalId: caller.principalId,
    principal: caller.username,
    grant,
    kind: contract.kind,
    meta: contract.meta,
  };
}

/** Who is calling, in the one shape the rest of the spine needs. */
interface Caller {
  /** Login email — what `grant_audit.principal` records. */
  username: string;
  /** The id the grant tuple is keyed on. */
  principalId: string;
  /**
   * Present ONLY when a `bmi_` per-invocation token authenticated this call.
   * `null` is an ordinary `bm_` bearer, and it means there is no delegation in
   * play — a different thing from an invocation whose envelope declares nothing
   * (see `envelopeAllowsCredential`). The two are separate types so a call site
   * cannot confuse them.
   */
  invocation: InvocationIdentity | null;
}

/**
 * Step 0, both credentials — `bm_` first, then `bmi_`.
 *
 * The order costs nothing and cannot mis-route: `parseToken` and
 * `parseInvocationToken` are DISJOINT anchored grammars (`bmi_…` fails
 * `^bm_([0-9a-f]{12})_` on the `i`, which is not hex), so at most one of them
 * can match and the loser returns before touching D1.
 *
 * The Bureau is the SECOND surface in the tree to understand invocations, and
 * that is the whole point of `bmi_` being its own grammar rather than a flag on
 * an ordinary bearer: a surface opts IN by importing the resolver. Every surface
 * that has not — the vault, JMAP, CalDAV, and anything written later that reuses
 * `verifyBearer` — goes on 401ing with no line of code being written.
 */
async function authenticateCaller(env: Env, raw: string): Promise<Caller | null> {
  const principal = await verifyBearer(env.DB, raw);
  if (principal) {
    // `verifyBearer` returns the login email, not the principal id — the grant
    // tuple is keyed on the id, so resolve it here rather than widening the
    // Principal shape every caller in the repo constructs.
    const row = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
      .bind(principal.username.toLowerCase())
      .first<{ id: string }>();
    if (!row) return null;
    return { username: principal.username, principalId: row.id, invocation: null };
  }

  const invocation = await resolveInvocationToken(env.DB, raw);
  if (!invocation) return null;
  // Not just the login email: `principalForInvocation` also re-checks that the
  // invocation's account still resolves and is still OWNED by that principal,
  // and answers null when it does not. Reading `principals.login_email` here
  // instead would authenticate an invocation on a deleted account.
  const acting = await principalForInvocation(env.DB, invocation);
  if (!acting) return null;
  return { username: acting.username, principalId: invocation.principalId, invocation };
}

/**
 * THE ENVELOPE'S `credentials` AXIS, finally consumed.
 *
 * Re-derived LIVE from the rows on every call — `binding ∩ env(root) ∩ … ∩
 * env(this node)` — so an operator narrowing `config_json.jobs.credentials`, or
 * throwing the 008 kill switch on an ancestor's binding, bites a token that is
 * already open. Nothing is read off the token row but the invocation's identity.
 *
 * ⚠️ `!resolved.ok` is a DENIAL, never "no envelope to enforce". A corrupt,
 * absent, grafted or cyclic chain means the bound is UNKNOWN, and an unknown
 * bound is not a permissive one. This is the mutation that would make the gate
 * decorative, so it is the branch to read twice.
 */
async function envelopeAllowsCredential(
  env: Env,
  invocation: InvocationIdentity,
  credRef: string,
): Promise<{ ok: true } | { ok: false; refusal: Extract<UseDecision, { ok: false }> }> {
  const resolved = await effectiveNodeAuthority(env, invocation.accountId, invocation.node);
  if (!resolved.ok) {
    return {
      ok: false,
      refusal: {
        ok: false,
        status: 403,
        error: `invocation ${invocation.invocationId}: authority unresolvable — ${resolved.note}`,
      },
    };
  }
  const verdict = mayUse(resolved.effective, { kind: "credential", name: credRef });
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    refusal: {
      ok: false,
      status: 403,
      error: `invocation ${invocation.invocationId}: ${describeDenial(verdict.denial)}`,
    },
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
