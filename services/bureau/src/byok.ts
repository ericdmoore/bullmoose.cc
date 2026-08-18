import { resolveBureauGrant } from "@bullmoose/auth-core/principal";
import { verbPermittedForKind } from "./binding.js";
import { runFetchVerb } from "./fetchVerb.js";
import { auditUse } from "./grants.js";
import type { Env } from "./models.js";
import { credentialContract } from "./vault.js";

/**
 * **BYOK — the binding-scoped door** (s26 T4).
 *
 * Eric's ask: *"I have some privacy redactions on via a guardrail feature in
 * OpenRouter… we can let others turn on their OR guardrails etc via their own
 * keys?"* A tenant seals their OWN provider key here, their binding names it,
 * and every model call that binding makes authenticates **as them** — so
 * whatever provider-side policy they have switched on (OpenRouter's guardrails,
 * PII redaction, model/route allowlists, their own spend caps) applies to the
 * agent's traffic automatically. **That is the entire feature, and none of it
 * is implemented here.** It rides along because the request is theirs. Nothing
 * in this file interprets, mirrors or re-implements a provider's policy; if it
 * ever did, the copy would drift from the tenant's console and the drift would
 * be invisible to them.
 *
 * ── WHY THIS IS NOT `/bureau/use` ──────────────────────────────────────────
 * `/bureau/use` authenticates a BEARER — a `bm_` principal token or a `bmi_`
 * per-invocation one — because its caller is an agent, and the binding proves
 * only which worker is calling while the token proves which agent (arch.md
 * OQ1b). The BYOK caller is not an agent: it is `services/agent`'s own model
 * router (`callModel`), which runs beneath every pipeline and holds no bearer.
 * The cloud claim path mints a `bmi_` token and drops the plaintext on the
 * floor (`services/agent/src/index.ts`), so there is nothing to present.
 *
 * The honest options were: thread a token down through six pipelines into the
 * model router, or replace step 0 with checks of equal strength. This door
 * takes the second, and the substitution is the thing to review:
 *
 *   step 0 (`/bureau/use`)          this door
 *   ──────────────────────          ─────────
 *   a bearer names the AGENT        `x-internal-token` proves the WORKER, and
 *                                   the caller names an (account, binding) pair
 *   grant over (principal,          the SAME grant, unchanged
 *   credRef, verb)                  — mint still ≠ authorize
 *
 * A named pair would be self-assertion — the thing `grants.ts` warns against —
 * if nothing checked it. Three row-derived checks do, and every one of them
 * reads a row the caller cannot write:
 *
 *   1. **the binding is enabled** — `agent_bindings.enabled` is `008`'s kill
 *      switch, so disabling an agent stops it spending its tenant's key on the
 *      next call, with no separate BYOK switch to remember;
 *   2. **the binding's own `config_json` NAMES this credRef** — `config_json`
 *      is the operator plane (data-plane.sql says so explicitly, in the note on
 *      `agent_invocation_tokens`), so the set of credentials a binding may
 *      spend is fixed by whoever provisioned it, not by whoever calls this;
 *   3. **the credential belongs to the account's OWN principal** — the lookup
 *      is keyed `(accounts[accountId].principal_id, credRef)`, so binding A can
 *      never resolve tenant B's key. There is no code path that reaches a
 *      credential across that line, which is what makes multi-tenant BYOK safe
 *      to hand to a second tenant.
 *
 * Then the standing grant, the kind gate (§4.1), the destination binding (§6)
 * and the header-only injection (invariant 8) run exactly as they do for every
 * other caller, because this door ends in the SAME `runFetchVerb`. The
 * allowlist is what makes a BYOK key un-exfiltratable in the interesting sense:
 * a key sealed with `--allow https://openrouter.ai` can be spent at OpenRouter
 * and nowhere else, no matter what a compromised prompt talks the model into
 * asking for.
 *
 * And the invariant that survives all of it: **the key is never returned.** The
 * agent worker composes a chat-completions request and gets back a response
 * body. It does not hold the credential for the length of the call, or for an
 * instant — it never holds it at all.
 */

export interface BindingUseRequest {
  /** The account the invocation is running for — from the RUNTIME (`job.account_id`), never from config. */
  accountId?: unknown;
  /** The binding whose config named the credential (`job.binding_id`). */
  bindingId?: unknown;
  /** `vault_credentials.name` — the handle, checked against the binding's config. */
  credRef?: unknown;
  /** The `fetch` verb's arguments, exactly as `/bureau/use` takes them. */
  request?: unknown;
}

/**
 * The verb, fixed.
 *
 * This door is not a bearer-less `/bureau/use`: it proxies one request with one
 * verb, and a caller cannot name another. `sign_sigv4` behind an internal token
 * would be a signing oracle reachable by anything holding INTERNAL_TOKEN, which
 * is a different — and much larger — thing than "let a tenant's agent spend a
 * tenant's model key".
 */
const VERB = "fetch";

export async function handleBindingUse(request: Request, env: Env): Promise<Response> {
  let body: BindingUseRequest;
  try {
    body = (await request.json()) as BindingUseRequest;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const accountId = str(body.accountId);
  const bindingId = str(body.bindingId);
  const credRef = str(body.credRef);
  if (!accountId || !bindingId || !credRef) {
    return json({ error: "accountId, bindingId and credRef are required" }, 400);
  }

  // The binding, by its OWN account — a binding id alone is not a key here, so
  // naming someone else's binding id under your account resolves nothing.
  const binding = await env.DB.prepare(
    `SELECT id, name, enabled, config_json FROM agent_bindings WHERE account_id = ? AND id = ?`,
  )
    .bind(accountId, bindingId)
    .first<{ id: string; name: string; enabled: number; config_json: string }>();
  if (!binding) return json({ error: `no binding ${bindingId} on account ${accountId}` }, 404);

  const account = await env.DB.prepare(`SELECT principal_id FROM accounts WHERE id = ? AND deleted_at IS NULL`)
    .bind(accountId)
    .first<{ principal_id: string }>();
  if (!account) return json({ error: `no live account ${accountId}` }, 404);
  const principal = await env.DB.prepare(`SELECT login_email FROM principals WHERE id = ?`)
    .bind(account.principal_id)
    .first<{ login_email: string }>();
  if (!principal) return json({ error: `account ${accountId} has no principal` }, 404);

  // Invariant 6 — one row per ATTEMPT, before the answer, allowed or refused.
  // Written as soon as there is a principal to attribute it to: the two 404s
  // above name no principal, so there is nobody to write a row about, and
  // inventing one would be a lie in the forensic record. The account is known
  // here, so the row lands in the RIGHT account's access log rather than the
  // principal's first-owned one that `/bureau/use` has to guess at.
  const grant = await resolveBureauGrant(env.DB, account.principal_id, credRef, VERB);
  await auditUse(env, principal.login_email, account.principal_id, credRef, VERB, grant?.grantId ?? null, accountId);

  // 1 — the 008 kill switch, inherited rather than duplicated. Disabling an
  // agent has to stop it spending its tenant's money, or "disabled" is a lie.
  if (binding.enabled !== 1) {
    return json({ error: `binding ${bindingId} is disabled` }, 403);
  }

  // 2 — the operator plane decides which credentials this binding may spend.
  // Exact string equality against what `config_json` actually carries; no
  // prefix, no substring, no "close enough".
  if (!bindingNamesCredential(binding.config_json, credRef)) {
    return json({ error: `binding ${binding.name} does not name credential "${credRef}" in its config` }, 403);
  }

  // 3 — mint ≠ authorize (§5.1), same as every other caller. Sealing a key for
  // a tenant does not let their agents spend it; the grant does, and revoking
  // it stops the next call while the credential and its siblings survive.
  if (!grant) {
    return json({ error: `no live grant for (${principal.login_email}, ${credRef}, ${VERB})` }, 403);
  }

  // 4 — the credential, resolved under the ACCOUNT'S OWN principal. This is the
  // tenant boundary: there is no argument the caller can make that reaches a
  // row belonging to anyone else.
  const contract = await credentialContract(env, account.principal_id, credRef);
  if (!contract) return json({ error: `no credential named ${credRef}` }, 404);

  // 5 — §4.1. A `hmac-key` credential cannot answer `fetch` even with a grant.
  if (!verbPermittedForKind(contract.kind, VERB)) {
    return json({ error: `verb "${VERB}" is not permitted for a "${contract.kind}" credential` }, 403);
  }

  // 6 — the same runtime as `/bureau/use`: destination binding (§6), unseal,
  // header-only injection (invariant 8), and only the result comes back.
  return runFetchVerb(
    env,
    { principalId: account.principal_id, credRef, kind: contract.kind, meta: contract.meta },
    body.request,
  );
}

/**
 * Does this binding's config actually name this credential?
 *
 * Two shapes, both written by the provisioning door
 * (`services/provision` `POST /provider-keys`) and read by the model router
 * (`services/agent/src/models.ts`):
 *
 *   {"providerCredentials": {"openrouter": "openrouter"}}      binding-wide
 *   {"modelAliases": {"extract": [{…, "credRef": "openrouter"}]}}  per route
 *
 * Anything else is "no". A malformed `config_json` is "no" as well — an
 * unparseable policy is not a permissive one, the same fail-closed reading
 * `readAllowlist` gives a malformed allowlist.
 */
export function bindingNamesCredential(configJson: string, credRef: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson || "{}");
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const config = parsed as Record<string, unknown>;

  const perProvider = config.providerCredentials;
  if (typeof perProvider === "object" && perProvider !== null && !Array.isArray(perProvider)) {
    for (const value of Object.values(perProvider as Record<string, unknown>)) {
      if (value === credRef) return true;
    }
  }

  const aliases = config.modelAliases;
  if (typeof aliases === "object" && aliases !== null && !Array.isArray(aliases)) {
    for (const menu of Object.values(aliases as Record<string, unknown>)) {
      if (!Array.isArray(menu)) continue;
      for (const candidate of menu) {
        if (typeof candidate !== "object" || candidate === null) continue;
        if ((candidate as { credRef?: unknown }).credRef === credRef) return true;
      }
    }
  }
  return false;
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
