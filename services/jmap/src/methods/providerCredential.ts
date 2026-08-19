import { MethodError, type MethodRegistry } from "@bullmoose/jmap-core";
import { isAgentPrincipal } from "@bullmoose/auth-core/principal";
// The BYOK core, shared with the operator door (`POST /provider-keys`). ONE
// implementation of seal → grant → attach; see that file's header for why a
// second one would be a security bug rather than duplication. Imported across
// the service boundary the same way `actionProposal.ts` imports
// `services/agent/src/watchCompose` — the module is self-contained by
// construction, so nothing of the provisioning worker rides along.
import {
  BYOK_PROVIDERS,
  DEFAULT_HEADER_RECIPE,
  attachCredentialToBindings,
  byokStatus,
  credentialExists,
  detachCredentialFromBindings,
  grantFetchOnCredential,
  normalizeAllow,
  revokeFetchGrant,
  sealProviderKey,
  type ByokStatus,
} from "../../../provision/src/byokProvision";
import { requireAccount, type RequestContext } from "./common";

/**
 * **ProviderCredential** (urn:bullmoose:params:jmap:agent) — the session-
 * reachable BYOK door (s26 T4's missing half).
 *
 * #203 built the entire path: a tenant's own provider key, sealed in the
 * Bureau, named by their binding, spent on their behalf so that **their**
 * provider-side guardrails — OpenRouter's PII redaction, route and model
 * allowlists, their own spend cap — apply to their agents' traffic. None of
 * that is implemented anywhere in bullmoose and none of it ever should be: it
 * rides along because the request authenticates as them. #204 wired the
 * pipelines that spend. What neither shipped was a way for the person whose key
 * it is to bring one. Sealing a key was an `ADMIN_TOKEN` `curl` against
 * `services/provision` — which is to say, Eric did it for you.
 *
 * This method is the door. Everything below is the argument for its shape.
 *
 * ── THE KEY IS WRITE-ONLY ──────────────────────────────────────────────────
 *
 * `ProviderCredential/set` takes a `key`. Nothing gives one back — not this
 * method, not `ProviderCredential/get`, not the console dossier, not the vault,
 * not the Bureau. The plaintext is read in exactly one place (the seal branch
 * below), handed to exactly one function (`sealProviderKey`), and crosses
 * exactly one boundary (the BUREAU service binding, behind which
 * `VAULT_MASTER_KEY` lives and this worker's does not — s04 T3a moved that key
 * and never copied it). It is not stored here, not echoed, not logged, and not
 * put in an error message — **not even truncated**. A four-character prefix of
 * an API key is not a redaction; it is the exact substring an attacker holding
 * a stolen dump uses to confirm which key they have. `providerCredential.test.ts`
 * sweeps the whole method response, every row of every control-plane table and
 * every thrown message for a canary, and proves the sweep bites by feeding it a
 * response that DID leak.
 *
 * ── THE SEAL IS A HOP, NOT A LOCAL ACT ─────────────────────────────────────
 *
 * This worker holds no master key. That is not an accident of layering, it is
 * s04's whole thesis: after T3a, the workers that read untrusted email and run
 * agent tools **cannot** unseal a credential, by platform rather than by rule.
 * `services/jmap` is squarely in that set — it renders attacker-authored mail.
 * So the seal goes over `BUREAU` exactly as `services/provision`'s does, and
 * the deployment consequence is stated where it belongs (`wrangler.jsonc`):
 * without the binding this method answers 501 and nothing else changes.
 *
 * ── THE SCOPE: `vault`, and why it is not `send` ───────────────────────────
 *
 * s26 T2's kill switch (`AgentBinding/set`, #198) gates on `send`, reusing the
 * capability wall's scope. This does NOT, and the difference is the honest one
 * rather than the convenient one: `send` prices *"may arm autonomous action"*.
 * Sealing a provider key is a different act — it is **custody of a secret**,
 * and `vault` is the scope this codebase already spends on exactly that
 * (auth-core: *"the store holding third-party provider credentials"*;
 * `/vault/credentials` gates on it; `console.ts` refuses to serve credential
 * references without it, calling anything weaker *"a scope downgrade with a
 * different door on it"*). Using `send` here would be that downgrade.
 *
 * The scope arithmetic, which is where the choice earns itself:
 *
 *   • `hasScope(["mail"], "vault")` is FALSE (common/001 closed that wildcard),
 *     so an ordinary device token cannot seal;
 *   • `SUPERVISORY_GRANT_SCOPES` = read + annotate + draft — no `vault`. **A
 *     supervisory-grant-derived session cannot seal, rotate or revoke.** This
 *     mirrors #198's assertion and EXTENDS it, because the extension is
 *     structural rather than incidental: `send` can be put on a grant by a
 *     deliberate operator (agentBinding.test.ts has a test for exactly that
 *     widening), whereas `vault` is **not in `GRANTABLE_SCOPES` at all**. No
 *     account→account grant can confer it, however widened. Custody does not
 *     delegate through a share;
 *   • `vault` is not in `OAUTH_SCOPES` either (s02 decision 4), so no third-
 *     party client and no hosted-sign-in session can hold it — including the
 *     webmail's own primary login. That is not a gap to route around: the read
 *     below is deliberately gated lower so the STATUS is legible to every
 *     session while the custody act needs a token minted for custody.
 *
 * ── AND THE AGENT REFUSAL, BESIDE IT ───────────────────────────────────────
 *
 * `vault` IS self-service mintable, and agent runtime tokens legitimately hold
 * it (that is how an agent reaches `/vault/credentials`). So the scope alone
 * would let a prompt-injected agent rotate its own tenant's provider key to a
 * value the attacker supplied — a credential-substitution attack that ends with
 * the tenant's mail flowing through the attacker's provider account, under the
 * attacker's guardrails, which is this feature's exact inverse. Agent-marked
 * principals and agent-provenance calls are therefore refused UNCONDITIONALLY,
 * before any account is resolved, exactly as the kill switch refuses them. An
 * unconditional refusal discloses nothing.
 *
 * ── OWNERSHIP ──────────────────────────────────────────────────────────────
 *
 * Owner-grade only, both methods. `requireAccount` resolves the account on the
 * principal (an unreachable one is `accountNotFound` before anything else), and
 * a grant-reached account is then refused by name — for `set` the scope already
 * makes it impossible, and for `get` it is a deliberate second rule: a
 * credential handle and its destination are the account owner's business, not
 * every holder of a share. Bindings are resolved `WHERE account_id = ? AND
 * id = ?`, so a binding id belonging to someone else answers exactly like one
 * that never existed.
 *
 * ── AUDIT ──────────────────────────────────────────────────────────────────
 *
 * Every write leaves a row naming the acting principal: `grant_lifecycle`
 * (`created` on seal, `revoked` on revoke) and `binding_lifecycle`
 * (`provider-credential-attached` / `-detached`, old→new carrying the
 * `provider=handle` pair). Handles only — a handle is a public name already
 * present in `config_json`, in `bureau_grants.cred_name` and on the wire of
 * every Bureau call. No audit row in this system can contain a key, because
 * nothing outside the seal hop ever holds one.
 *
 * ProviderCredential is NOT a synced collection: no changelog, no `/changes`.
 * The `/set` response carries the server-confirmed state and `/get` recomputes
 * from the rows, which is the same bargain `AgentBinding` makes.
 */

/** Providers a SESSION may seal for: those with a default destination.
 *
 * `gateway` is deliberately absent even though the operator door offers it. Its
 * endpoint is deployment-specific, so serving it here would mean accepting an
 * `allow` origin from the caller — and the destination binding (bureau.md §6)
 * is the one control that makes a sealed key un-exfiltratable: a key allowed at
 * `https://openrouter.ai` can be spent there and nowhere else, whatever URL a
 * compromised prompt talks an agent into composing. A caller-chosen allowlist
 * is that control handed to the caller. The operator door keeps `gateway`
 * because an operator naming their own gateway origin is a considered act; a
 * session naming an arbitrary one is a proxy. */
export function sessionSealableProviders(): string[] {
  return Object.entries(BYOK_PROVIDERS)
    .filter(([, spec]) => !!spec.defaultAllow)
    .map(([name]) => name);
}

/** The three verbs, one per call. */
type Action = "seal" | "detach" | "revoke";

interface SealArgs {
  provider?: unknown;
  key?: unknown;
  bindingId?: unknown;
  expiresDays?: unknown;
}
interface DetachArgs {
  bindingId?: unknown;
  provider?: unknown;
}
interface RevokeArgs {
  credRef?: unknown;
}

export function registerProviderCredentialMethods(registry: MethodRegistry<RequestContext>): void {
  // ── the read ────────────────────────────────────────────────────────────
  //
  // Gated on `read`, not `vault`, and the asymmetry is the point. The single
  // most important property of #203 is that a binding naming a credential that
  // does not resolve REFUSES rather than spending the platform key — right,
  // and invisible: from the outside it looks like an agent that is merely
  // quiet. Hiding that status behind a scope no ordinary session can hold
  // would recreate the silence this whole feature exists to prevent. What is
  // returned is a projection of the caller's OWN account's agent configuration
  // joined to grant state (`byokStatus`), never the vault's list: it cannot
  // enumerate credentials, and it carries no `header`, no `meta` and — of
  // course — no value. `allow` IS carried, because "where may my key be spent"
  // is the security-relevant fact of the feature and withholding it from the
  // account's owner would make the page dishonest.
  registry.register("ProviderCredential/get", async (args, ctx) => {
    const access = await requireAccount(ctx, args, "read");
    if (access.granted) {
      throw new MethodError(
        "forbidden",
        "provider credentials are the account owner's: a session reaching this account " +
          "through a grant can read its agents but not their credential configuration",
      );
    }
    const owner = await principalOf(ctx, access.accountId);
    const status = await byokStatus(ctx.env.DB, access.accountId, owner.principalId);
    const write = mayWrite(ctx);
    return {
      accountId: access.accountId,
      ...status,
      // Stated in the payload rather than assumed by the client: there is no
      // property here, now or later, that carries a key.
      keyReadable: false,
      // What a session may actually DO, computed from the same gate the write
      // runs, so the UI greys the verbs it would be refused for instead of
      // offering them and explaining afterwards.
      mayWrite: write.ok,
      writeRefusal: write.ok ? null : write.reason,
      sealableProviders: sessionSealableProviders(),
    } satisfies ByokStatus & Record<string, unknown>;
  });

  // ── the writes ──────────────────────────────────────────────────────────
  registry.register("ProviderCredential/set", async (args, ctx) => {
    // The unconditional agent refusal FIRST (see header): before the account is
    // resolved, so a marked token cannot even distinguish reachable accounts
    // from unreachable ones here.
    if (ctx.agent || isAgentPrincipal(ctx.principal)) {
      throw new MethodError(
        "forbidden",
        "sealing or rotating a provider key is a human act of custody: an agent-driven call " +
          "may not do it (an agent rotating its own tenant's key to an attacker-supplied value " +
          "would route that tenant's mail through the attacker's provider account)",
      );
    }

    const action = soleAction(args);
    // THE CUSTODY SCOPE. `vault` — never `send`, never `mail`. A supervisory
    // grant cannot carry it, and no grant can (GRANTABLE_SCOPES omits it), so
    // the domain argument to requireAccount is inert here by construction.
    const access = await requireAccount(ctx, args, "vault");
    if (access.granted) {
      // Unreachable today — a grant cannot confer `vault`, so the scope check
      // above already refused. Kept as a second lock rather than a comment: if
      // GRANTABLE_SCOPES ever widens, custody must not widen with it silently.
      throw new MethodError("forbidden", "custody of a provider key does not delegate through a grant");
    }
    const owner = await principalOf(ctx, access.accountId);
    const actor = ctx.principal.username;

    if (action === "seal") return sealAction(ctx, access.accountId, owner.principalId, actor, args.seal as SealArgs);
    if (action === "detach") {
      return detachAction(ctx, access.accountId, owner.principalId, actor, args.detach as DetachArgs);
    }
    return revokeAction(ctx, access.accountId, owner.principalId, actor, args.revoke as RevokeArgs);
  });
}

// ── seal / rotate ─────────────────────────────────────────────────────────

/**
 * Seal the tenant's key, grant `fetch` on it, and attach it to their binding(s).
 *
 * Re-running is the ROTATION path, deliberately the same call: the tenant rolls
 * their key at the provider, submits it here, and nothing about their agents'
 * configuration changes — same handle, same grant, same attachment, new
 * ciphertext. Rotation being indistinguishable from creation at the call site
 * is what makes it something a person will actually do.
 *
 * The handle is NOT caller-chosen. It is the provider name, always. A
 * caller-named handle could collide with a credential sealed for something else
 * entirely — an MCP server's API key under `aws-mcp` — and `mode: "mint"`
 * upserts, so the collision would silently overwrite that credential's
 * ciphertext and leave every other consumer of it broken with no error
 * anywhere. One provider, one handle, no way to aim at a neighbour's row.
 */
async function sealAction(
  ctx: RequestContext,
  accountId: string,
  principalId: string,
  actor: string,
  raw: SealArgs,
): Promise<Record<string, unknown>> {
  const provider = str(raw.provider) || "openrouter";
  const spec = BYOK_PROVIDERS[provider];
  const allow = spec?.defaultAllow ? normalizeAllow(spec.defaultAllow) : null;
  if (!spec || !allow) {
    throw new MethodError(
      "invalidArguments",
      `provider must be one of ${sessionSealableProviders().join(", ")}. ` +
        `"${provider}" has no fixed destination, so sealing for it would mean naming an ` +
        `allowlist origin here — an operator act (POST /provider-keys)`,
    );
  }
  // The ONE read of the plaintext in this file. Nothing below it touches `raw.key`.
  if (typeof raw.key !== "string" || raw.key.trim().length === 0) {
    // Note what this refusal does NOT say: nothing about length, shape, prefix
    // or what was received. "A key is required" is the whole honest message.
    throw new MethodError("invalidArguments", "key is required (it is write-only: nothing ever reads it back)");
  }
  const bindingId = str(raw.bindingId);
  if (bindingId && !(await bindingOnAccount(ctx, accountId, bindingId))) {
    // Indistinguishable from a binding that never existed — see header.
    throw new MethodError("invalidArguments", "no such binding on this account");
  }
  const expiresDays =
    Number.isFinite(Number(raw.expiresDays)) && Number(raw.expiresDays) > 0 ? Number(raw.expiresDays) : undefined;

  const credRef = provider;
  const existed = await credentialExists(ctx.env.DB, principalId, credRef);
  const sealed = await sealProviderKey(
    ctx.env,
    { principalId, credRef, allow, header: DEFAULT_HEADER_RECIPE },
    raw.key.trim(),
  );
  if (!sealed.ok) {
    // The Bureau's STATUS, never its body, and never anything derived from the
    // key. Fail closed with nothing else written.
    throw new MethodError(sealed.status === 501 ? "unknownMethod" : "serverFail", sealed.error);
  }

  const grantId = await grantFetchOnCredential(ctx.env.DB, principalId, credRef, { actor, expiresDays });
  const attached = await attachCredentialToBindings(ctx.env.DB, accountId, provider, credRef, {
    actor,
    bindingId: bindingId || undefined,
  });

  return {
    accountId,
    action: "seal",
    credRef,
    provider,
    allow,
    created: !existed,
    rotated: existed,
    grantId,
    bindings: attached,
    keyReadable: false,
    ...(attached.length === 0
      ? {
          note:
            `Sealed and granted, but no agent on this account routes to ${provider} yet, ` +
            `so nothing names the key and nothing will spend it.`,
        }
      : {}),
  };
}

// ── detach ────────────────────────────────────────────────────────────────

/**
 * Remove one binding's reference to the tenant's key.
 *
 * **What this does not do:** it does not delete the sealed credential, and it
 * does not revoke the grant. A hard delete DOES exist — `DELETE
 * /vault/credentials/{name}` on the agent worker's vault surface, principal-
 * scoped and gated on the same `vault` scope — but it is deliberately not one
 * of this door's three verbs: destroying the ciphertext is the one act with no
 * undo, and neither "this agent should stop using my key" nor "my key should
 * stop being spendable" needs it. Detach removes
 * `providerCredentials[provider]` from ONE binding's config, and the effect is
 * precise: with nobody naming a credential, `models.ts`' resolution order
 * reaches step 3 and that agent goes back to the **platform's** key — running
 * again, on our key, under our guardrails rather than the tenant's. That is
 * exactly right for *"this agent should stop using my key"* and exactly wrong
 * for *"my key should stop being spendable"*, which is what `revoke` is for.
 * The surface says both sentences out loud for the same reason.
 */
async function detachAction(
  ctx: RequestContext,
  accountId: string,
  principalId: string,
  actor: string,
  raw: DetachArgs,
): Promise<Record<string, unknown>> {
  const bindingId = str(raw.bindingId);
  if (!bindingId) throw new MethodError("invalidArguments", "detach requires a bindingId");
  if (!(await bindingOnAccount(ctx, accountId, bindingId))) {
    throw new MethodError("invalidArguments", "no such binding on this account");
  }
  const provider = str(raw.provider);
  const detached = await detachCredentialFromBindings(ctx.env.DB, accountId, {
    actor,
    bindingId,
    provider: provider || undefined,
  });
  return {
    accountId,
    action: "detach",
    detached,
    // The two facts a person needs to not be surprised, on the wire rather
    // than only in the UI copy.
    credentialDeleted: false,
    grantRevoked: false,
    ...(await statusTail(ctx, accountId, principalId)),
  };
}

// ── revoke ────────────────────────────────────────────────────────────────

/**
 * Stop the key being spendable at all: tombstone the `(principal, credRef,
 * fetch)` grant and detach it from every binding on the account.
 *
 * The tombstone is s03.A's contract, not a DELETE — the grant row and its
 * `grant_lifecycle` history survive, `resolveBureauGrant` stops resolving it on
 * the very next call, and re-sealing the key later reinstates the same row
 * rather than being blocked forever by it.
 *
 * The detach is not decoration. A grant alone stopping is the *safe* failure
 * (the binding refuses rather than spending the platform key), but it is the
 * SILENT one — an agent that quietly stops working while its dossier still says
 * "openrouter". Revoking and detaching together leaves a configuration whose
 * behaviour matches its description: the agent runs on the platform key, and
 * the page says so.
 */
async function revokeAction(
  ctx: RequestContext,
  accountId: string,
  principalId: string,
  actor: string,
  raw: RevokeArgs,
): Promise<Record<string, unknown>> {
  const credRef = str(raw.credRef);
  if (!credRef) throw new MethodError("invalidArguments", "revoke requires a credRef");
  const grantId = await revokeFetchGrant(ctx.env.DB, principalId, credRef, actor);
  const detached = (await detachCredentialFromBindings(ctx.env.DB, accountId, { actor })).filter(
    (d) => d.credRef === credRef,
  );
  return {
    accountId,
    action: "revoke",
    credRef,
    // null when there was nothing live to revoke — idempotent, so a second
    // click reports honestly rather than inventing a second tombstone.
    grantId,
    grantRevoked: grantId !== null,
    detached,
    // ⚠️ The sealed value is NOT destroyed, and saying otherwise would be the
    // one lie this surface must not tell. Deleting the stored value is a real
    // and separate act on the vault's own door (`DELETE /vault/credentials/
    // {name}`); this verb is the REVERSIBLE stop, and the difference is the
    // whole reason the flag is on the wire rather than assumed by the client.
    credentialDeleted: false,
    ...(await statusTail(ctx, accountId, principalId)),
  };
}

// ── plumbing ──────────────────────────────────────────────────────────────

/** Exactly one verb per call: the audit trail should never have to guess which
 *  of three things a request meant, and a partial failure across two of them is
 *  a state nobody asked for. */
function soleAction(args: Record<string, unknown>): Action {
  const present = (["seal", "detach", "revoke"] as const).filter(
    (k) => args[k] !== undefined && args[k] !== null && typeof args[k] === "object",
  );
  if (present.length === 0) {
    throw new MethodError(
      "invalidArguments",
      'ProviderCredential/set takes exactly one of "seal", "detach" or "revoke"',
    );
  }
  if (present.length > 1) {
    throw new MethodError("invalidArguments", `one verb per call; received ${present.join(" + ")}`);
  }
  return present[0]!;
}

/** The write gate, as a value — so `/get` can report it and the UI can grey a
 *  button instead of offering an act it would be refused for. Mirrors the two
 *  refusals `/set` actually performs, in the same order. */
function mayWrite(ctx: RequestContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.agent || isAgentPrincipal(ctx.principal)) {
    return { ok: false, reason: "an agent-driven session may not seal, rotate or revoke a provider key" };
  }
  if (!ctx.principal.scopes.includes("vault")) {
    return {
      ok: false,
      reason:
        'this session does not carry the "vault" scope, which custody of a provider key requires. ' +
        "Hosted sign-in cannot grant it (the consent screen deliberately excludes the credential " +
        "realm) and no account share can — mint a token with vault access and use it here.",
    };
  }
  return { ok: true };
}

/**
 * Note `mayWrite` tests `scopes.includes("vault")` rather than `hasScope`.
 * That is not a shortcut: `vault` is a realm scope covered by no bundle, so
 * `hasScope(s, "vault")` reduces to exactly this membership test — and writing
 * it verbatim keeps this REPORT from ever becoming more permissive than the
 * gate if a future bundle grows a wildcard. The gate itself
 * (`requireAccount(..., "vault")`) is unchanged and remains the enforcement.
 */

async function principalOf(ctx: RequestContext, accountId: string): Promise<{ principalId: string }> {
  const row = await ctx.env.DB.prepare(`SELECT principal_id FROM accounts WHERE id = ? AND deleted_at IS NULL`)
    .bind(accountId)
    .first<{ principal_id: string }>();
  // The local-dev bootstrap principal has a synthetic account with no row.
  if (!row) throw new MethodError("accountNotFound");
  return { principalId: row.principal_id };
}

/** Ownership, the only way a binding id is ever resolved here. */
async function bindingOnAccount(ctx: RequestContext, accountId: string, bindingId: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare(`SELECT id FROM agent_bindings WHERE account_id = ? AND id = ?`)
    .bind(accountId, bindingId)
    .first<{ id: string }>();
  return !!row;
}

/** The post-write state, so a client reconciles from the server's word rather
 *  than from what it hoped the write did (ProviderCredential has no /changes). */
async function statusTail(ctx: RequestContext, accountId: string, principalId: string): Promise<ByokStatus> {
  return byokStatus(ctx.env.DB, accountId, principalId);
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}
