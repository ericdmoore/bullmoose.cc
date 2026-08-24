import { AwsClient } from "aws4fetch";
import {
  LOGIN_KEY_ALGO,
  LOGIN_KEY_ITERATIONS,
  TOKEN_SCOPES,
  hashLoginKey,
  isLoginKey,
  loginSaltHex,
  mintToken,
  resolveMintScopes,
} from "@bullmoose/auth-core";
import { BUREAU_VERBS, isBureauVerb } from "@bullmoose/auth-core/principal";
import { adminRefusalReason } from "./reservedLocalparts";
// s26 T4 — the BYOK core, shared with the session door
// (`services/jmap/src/methods/providerCredential.ts`). ONE implementation of
// seal → grant → attach, because two writers of `config_json.providerCredentials`
// is two things the Bureau's own "does this binding name this credential?"
// check can disagree with. See that file's header.
import {
  BYOK_PROVIDERS,
  DEFAULT_HEADER_RECIPE,
  attachCredentialToBindings,
  credentialExists,
  grantFetchOnCredential,
  isCredRef,
  normalizeAllow,
  normalizeHeaderRecipe,
  sealProviderKey,
} from "./byokProvision";

/**
 * Provision — multi-domain onboarding, fully API-driven (§8 of the design
 * doc). Cloudflare is both DNS and compute, so adding domain #50 is the
 * same call as domain #1.
 *
 * Admin API (Authorization: Bearer <ADMIN_TOKEN>):
 *   POST   /tenants               {tenantId, name}
 *   POST   /domains               {tenantId, domain}   → runs the wiring steps
 *   GET    /domains/{domain}      → re-checks SES/DKIM verification, flips active
 *   POST   /accounts              {tenantId, domain, localpart, displayName}
 *   PATCH  /tenants/{id}          {name}                → rename
 *   PATCH  /accounts/{id}         {displayName}         → rename
 *   PATCH  /domains/{domain}      {status: active|suspended}
 *   DELETE /tenants/{id}          → refuses while anything references it
 *   DELETE /domains/{domain}      → refuses while any route/identity is on it
 *   DELETE /accounts/{id}         → SOFT (tombstone) + route/KV teardown
 *   POST   /agent-bindings/{id}/disable  → the agent kill switch
 *   POST   /agent-bindings/{id}/enable
 *   POST   /agent-bindings/{id}/supervisor {ownerEmail?} → the supervisory
 *                                 grant, minted after the fact (s10 T7)
 *   POST   /agent-bindings/{id}/backfill {sinceDays?, budgetMicros?}
 *                                 → mint PENDING invocations over the archive,
 *                                 newest-first, NULL-due, floor-bounded (s26 T3)
 *   POST   /agent-bindings/{id}/floor-request {toEpochMs} → the rule-1 approval:
 *                                 a tier-1 proposal to move the history floor BACK
 *   PATCH  /agent-bindings/{id}   → the TYPED CORE only (s10 T4)
 *   GET    /agent-bindings/{id}/lifecycle → the binding's provenance chain
 *   DELETE /agent-bindings/{id}   → refuses while invocations are queued
 *   POST   /bureau-grants         {principalEmail, credRef, verb, expiresDays?}
 *   GET    /bureau-grants         → the capability table (?email= / ?credRef=)
 *   DELETE /bureau-grants/{id}    → TOMBSTONE; credential + siblings survive
 *   POST   /provider-keys         {email, key, provider?, bindingName?, allow?}
 *                                 → s26 T4 BYOK: seal a tenant's own provider
 *                                   key in the Bureau, grant `fetch` on it, and
 *                                   attach its ref to their binding(s). The key
 *                                   goes IN once and is never readable back.
 *
 * POST /domains is idempotent-ish: each step reports ok/detail so a failed
 * run can simply be re-run after fixing the underlying issue. POST /accounts
 * is idempotent outright: re-running it for an address that already has a
 * mailbox returns that mailbox (`created: false`) rather than building a
 * second one — see `createAccount` for why that matters.
 *
 * ── Lifecycle, and why the verbs are shaped the way they are (sVOL 008) ──
 *
 * Provisioning used to be one-way: the only update was `POST
 * /principals/password` and the only deletes were tokens and grants. A
 * mistyped domain was permanent through the API.
 *
 * Three tiers, by blast radius rather than by noun:
 *
 *  1. REVERSIBLE — `PATCH` rename, `PATCH /domains {status}`, and the two
 *     agent-binding verbs. Pure state; nothing is destroyed. These do not
 *     need an operator to confirm anything.
 *  2. SOFT DELETE — `DELETE /accounts/{id}` writes `accounts.deleted_at` and
 *     tears down delivery. The row survives because the account's DATA does
 *     not live here (see control-plane.sql's note on the column).
 *  3. HARD DELETE — `DELETE /tenants` and `DELETE /domains`, both of which
 *     REFUSE with 409 while anything still references them. A tenant or a
 *     domain with nothing on it never carried mail, so there is no history
 *     to keep; that is exactly the mistyped-domain case these exist for.
 *
 * `tokens` and `grants` keep their hard `DELETE`. Tombstoning them is
 * `.plans/s03.A-foundations` T2's job, which also wants a `grant_lifecycle`
 * log — doing half of it here would buy this repo two hand-run schema events
 * instead of one.
 */

export interface Env {
  DB: D1Database;
  ROUTES: KVNamespace;
  SES_REGION: string;
  INGEST_WORKER_NAME: string;
  /** Public hostname of the jmap worker (SRV autodiscovery target). */
  JMAP_HOST?: string;
  ADMIN_TOKEN: string;
  CF_API_TOKEN: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  /**
   * The Bureau (s04 T3a), for `POST /provider-keys` only (s26 T4).
   *
   * This worker holds no master key and never will: sealing a tenant's provider
   * key is a HOP, the same as it is from `services/agent`. The plaintext
   * crosses this binding once, on its way in, and nothing comes back but an
   * acknowledgement — there is no route on the Bureau that returns a secret.
   *
   * Optional so a deployment without it degrades to a 501 on that one route
   * rather than failing to boot; every other verb here is unaffected.
   */
  BUREAU?: Fetcher;
  /** Shared with the Bureau's `/internal/*` surface. See `docs/DEPLOY.md`. */
  INTERNAL_TOKEN?: string;
}

interface Step {
  step: string;
  ok: boolean;
  detail?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      if (route === "POST /tenants") {
        return createTenant((await request.json()) as { tenantId: string; name: string }, env);
      }
      if (route === "GET /tenants") return listTenants(env);
      if (route === "GET /domains") return listDomains(env);
      if (route === "GET /accounts") return listAccounts(url, env);
      if (route === "POST /domains") {
        return addDomain((await request.json()) as { tenantId: string; domain: string }, env);
      }
      if (request.method === "GET" && /^\/domains\/[^/]+$/.test(url.pathname)) {
        return checkDomain(url.pathname.split("/")[2] as string, env);
      }
      if (route === "POST /accounts") {
        return createAccount(
          (await request.json()) as {
            tenantId: string;
            domain: string;
            localpart: string;
            displayName: string;
            principalEmail?: string;
          },
          env,
        );
      }
      if (route === "POST /principals/password") {
        return setPassword((await request.json()) as { email: string; loginKey: string }, env);
      }
      if (route === "POST /principals/enrollment-link") {
        return mintEnrollmentLink((await request.json()) as { email: string }, env);
      }
      if (route === "POST /tokens") {
        return mintPrincipalToken(
          (await request.json()) as {
            email: string;
            name: string;
            scopes?: string[];
            expiresDays?: number;
          },
          env,
        );
      }
      if (route === "GET /tokens") return listTokens(url, env);
      if (route === "POST /agent-bindings") {
        return createAgentBinding((await request.json()) as { email: string; name: string; slaSeconds?: number }, env);
      }
      if (route === "GET /agent-bindings") return listAgentBindings(url, env);
      // s12 2-D — mint the bouncer@ account + reply-only binding for ONE
      // tenant domain. Explicit per-tenant call; nothing is auto-provisioned
      // for existing tenants.
      if (route === "POST /bouncer") {
        return provisionBouncer(
          (await request.json()) as { tenantId: string; domain: string; localpart?: string },
          env,
        );
      }
      // s20 wave 2 — mint the remind@ account + reply-only binding for ONE
      // tenant domain (the mail-native Watches door). Explicit per-tenant call,
      // same shape as /bouncer; nothing is auto-provisioned.
      if (route === "POST /remind") {
        return provisionRemind((await request.json()) as { tenantId: string; domain: string; localpart?: string }, env);
      }
      // s18 A2 — turn the extraction pass on for ONE human account. A binding on
      // the account's OWN mailbox (it reads what is delivered), not a separate
      // agent account: extraction writes Annotations, it sends nothing. Re-run
      // to SWAP the model. This is the spend decision, made explicitly.
      if (route === "POST /extractor") {
        return provisionExtractor(
          (await request.json()) as { email: string; model?: string; provider?: string; maxTokens?: number },
          env,
        );
      }
      // The kill switch (`.feedback/fromClaude/agentic/023`). TWO EXPLICIT
      // VERBS rather than a general `PATCH {enabled}`: in an incident the
      // dangerous direction must be unambiguous in the audit log and
      // impossible to typo into its opposite.
      const bindingVerb = url.pathname.match(/^\/agent-bindings\/([^/]+)\/(disable|enable)$/);
      if (request.method === "POST" && bindingVerb) {
        return setBindingEnabled(bindingVerb[1] as string, bindingVerb[2] === "enable", url, env);
      }
      // s10 T7 — the supervisory grant, after the fact. Idempotent; refuses
      // when it cannot tell who owns the agent (see `superviseBinding`).
      const bindingSupervisor = url.pathname.match(/^\/agent-bindings\/([^/]+)\/supervisor$/);
      if (request.method === "POST" && bindingSupervisor) {
        return superviseBinding(
          bindingSupervisor[1] as string,
          await readJson<{ ownerEmail?: string }>(request),
          url,
          env,
        );
      }
      // s26 T3 — BACKFILL: mint pending invocations over the account's
      // archive, newest-first, NULL-due, bounded below by the history floor.
      const bindingBackfill = url.pathname.match(/^\/agent-bindings\/([^/]+)\/backfill$/);
      if (request.method === "POST" && bindingBackfill) {
        return backfillBinding(
          bindingBackfill[1] as string,
          await readJson<{ sinceDays?: number; budgetMicros?: number }>(request),
          url,
          env,
        );
      }
      // s26 T3 — the rule-1 approval: moving the history floor BACK is an act
      // that needs a human. Mints a tier-1 `floor-request` proposal.
      const bindingFloor = url.pathname.match(/^\/agent-bindings\/([^/]+)\/floor-request$/);
      if (request.method === "POST" && bindingFloor) {
        return requestHistoryFloor(
          bindingFloor[1] as string,
          await readJson<{ toEpochMs?: number }>(request),
          url,
          env,
        );
      }
      // The binding config write surface (s10 T4). Typed core ONLY — see
      // `patchAgentBinding`. It sits beside the two kill-switch verbs rather
      // than replacing them: `enabled` is reachable both ways, but an incident
      // operator keeps a route whose NAME is the direction.
      if (request.method === "PATCH" && /^\/agent-bindings\/[^/]+$/.test(url.pathname)) {
        return patchAgentBinding(
          url.pathname.split("/")[2] as string,
          await readJson<Record<string, unknown>>(request),
          url,
          env,
        );
      }
      const bindingChain = url.pathname.match(/^\/agent-bindings\/([^/]+)\/lifecycle$/);
      if (request.method === "GET" && bindingChain) {
        return listBindingLifecycle(bindingChain[1] as string, url, env);
      }
      if (request.method === "DELETE" && /^\/agent-bindings\/[^/]+$/.test(url.pathname)) {
        return deleteAgentBinding(url.pathname.split("/")[2] as string, url, env);
      }
      if (request.method === "PATCH" && /^\/tenants\/[^/]+$/.test(url.pathname)) {
        return renameTenant(url.pathname.split("/")[2] as string, await readJson<{ name?: string }>(request), env);
      }
      if (request.method === "DELETE" && /^\/tenants\/[^/]+$/.test(url.pathname)) {
        return deleteTenant(url.pathname.split("/")[2] as string, env);
      }
      if (request.method === "PATCH" && /^\/domains\/[^/]+$/.test(url.pathname)) {
        return setDomainStatus(url.pathname.split("/")[2] as string, await readJson<{ status?: string }>(request), env);
      }
      if (request.method === "DELETE" && /^\/domains\/[^/]+$/.test(url.pathname)) {
        return deleteDomain(url.pathname.split("/")[2] as string, env);
      }
      if (request.method === "PATCH" && /^\/accounts\/[^/]+$/.test(url.pathname)) {
        return renameAccount(
          url.pathname.split("/")[2] as string,
          await readJson<{ displayName?: string }>(request),
          env,
        );
      }
      if (request.method === "DELETE" && /^\/accounts\/[^/]+$/.test(url.pathname)) {
        return deleteAccount(url.pathname.split("/")[2] as string, env);
      }
      if (request.method === "DELETE" && /^\/tokens\/[^/]+$/.test(url.pathname)) {
        return revokeToken(url.pathname.split("/")[2] as string, env);
      }
      if (route === "POST /grants") {
        return createGrant(
          (await request.json()) as {
            granteeEmail: string;
            targetEmail: string;
            scopes?: string[];
            collection?: string;
            collectionId?: string;
            expiresDays?: number;
          },
          env,
        );
      }
      if (route === "GET /grants") return listGrants(url, env);
      if (request.method === "DELETE" && /^\/grants\/[^/]+$/.test(url.pathname)) {
        return revokeGrant(url.pathname.split("/")[2] as string, env);
      }
      if (route === "POST /bureau-grants") {
        return createBureauGrant(
          (await request.json()) as {
            principalEmail: string;
            credRef: string;
            verb: string;
            expiresDays?: number;
          },
          env,
        );
      }
      if (route === "GET /bureau-grants") return listBureauGrants(url, env);
      // s26 T4 — BYOK. The tenant's own provider key: sealed in the Bureau,
      // granted, and named by their binding, so their provider-side guardrails
      // apply to their agents' calls. Re-run to rotate the key in place.
      if (route === "POST /provider-keys") {
        return provisionProviderKey(await readJson<ProviderKeyBody>(request), env);
      }
      if (request.method === "DELETE" && /^\/bureau-grants\/[^/]+$/.test(url.pathname)) {
        return revokeBureauGrant(url.pathname.split("/")[2] as string, env);
      }
    } catch (err) {
      return json({ error: String(err) }, 500);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ---- tenants ---------------------------------------------------------

async function createTenant(body: { tenantId: string; name: string }, env: Env) {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?)`)
    .bind(body.tenantId, body.name, Date.now())
    .run();
  return json({ ok: true, tenantId: body.tenantId });
}

async function listTenants(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, status, created_at FROM tenants ORDER BY created_at`,
  ).all();
  return json({ tenants: results });
}

/**
 * Rename. `createTenant` is `INSERT OR IGNORE`, so re-POSTing with a corrected
 * name silently no-ops and still returns `ok: true` — there was no way to fix
 * a typo at all.
 */
async function renameTenant(id: string, body: { name?: string }, env: Env) {
  if (!body?.name) return json({ error: "name required" }, 400);
  const res = await env.DB.prepare(`UPDATE tenants SET name = ? WHERE id = ?`).bind(body.name, id).run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: `no tenant ${id}` }, 404);
  return json({ ok: true, tenantId: id, name: body.name });
}

/**
 * Hard delete — and the one place tombstones are finally purged.
 *
 * It refuses while any DOMAIN or any LIVE account is on the tenant. It does
 * **not** refuse for tombstoned accounts, and that asymmetry is the whole
 * design: `deleteAccount` is soft and nothing in the tree deletes an
 * `identities` or `principals` row, so counting tombstones as blockers would
 * make every tenant that ever held one account permanently undeletable — the
 * exact hand-edit-D1 situation these verbs exist to remove.
 *
 * So the tenant delete is the terminal verb. Once its domains are gone and its
 * live accounts are gone, what remains is bookkeeping for accounts that are
 * already dead, and it goes with the tenant, in foreign-key order. Every
 * referencing table declares `REFERENCES`, so the order is not cosmetic;
 * getting it wrong surfaces as an opaque FK 500 from the catch in `fetch`.
 *
 * The DATA plane is untouched — mailboxes, emails, calendars, R2 — because it
 * lives in another database this worker cannot reach (008 open question #4).
 * The response says so rather than implying a clean sweep.
 */
async function deleteTenant(id: string, env: Env) {
  const tenant = await env.DB.prepare(`SELECT id FROM tenants WHERE id = ?`).bind(id).first<{ id: string }>();
  if (!tenant) return json({ error: `no tenant ${id}` }, 404);

  const blockers = (await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM domains  WHERE tenant_id = ?1) AS domains,
            (SELECT COUNT(*) FROM accounts WHERE tenant_id = ?1 AND deleted_at IS NULL) AS liveAccounts`,
  )
    .bind(id)
    .first<{ domains: number; liveAccounts: number }>()) ?? { domains: 0, liveAccounts: 0 };
  const held = Object.entries(blockers).filter(([, n]) => n > 0);
  if (held.length > 0) {
    return json(
      {
        error:
          `tenant ${id} still holds ${held.map(([k, n]) => `${n} ${k}`).join(", ")} — ` +
          "delete those first (DELETE /domains/{domain}, DELETE /accounts/{id}). " +
          "Already-deleted accounts do NOT block; they are purged with the tenant",
        tenantId: id,
        holds: blockers,
      },
      409,
    );
  }

  const purged = (await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM accounts   WHERE tenant_id = ?1) AS accounts,
            (SELECT COUNT(*) FROM principals WHERE tenant_id = ?1) AS principals`,
  )
    .bind(id)
    .first<{ accounts: number; principals: number }>()) ?? { accounts: 0, principals: 0 };

  // Foreign-key order, in one atomic batch: grants and identities reference
  // accounts; tokens, credentials and vault_credentials reference principals;
  // accounts reference both; principals reference the tenant.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM grants WHERE tenant_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM identities WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = ?)`).bind(id),
    ...["tokens", "credentials", "vault_credentials"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE principal_id IN (SELECT id FROM principals WHERE tenant_id = ?)`).bind(
        id,
      ),
    ),
    env.DB.prepare(`DELETE FROM accounts WHERE tenant_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM principals WHERE tenant_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM tenants WHERE id = ?`).bind(id),
  ]);

  return json({
    ok: true,
    deleted: true,
    tenantId: id,
    purged,
    retained: [
      "the data plane — mailboxes, emails, calendars, contacts and R2 blobs are in a separate database this worker cannot reach",
    ],
  });
}

async function listDomains(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT domain, tenant_id, status, cf_zone_id, created_at FROM domains ORDER BY domain`,
  ).all();
  return json({ domains: results });
}

/**
 * Tombstoned accounts are hidden by default and visible with
 * `?includeDeleted=1` — the forensic half of a soft delete is worthless if no
 * read path can see it.
 */
async function listAccounts(url: URL, env: Env) {
  const tenant = url.searchParams.get("tenant");
  const includeDeleted = url.searchParams.get("includeDeleted") === "1";
  const where = [...(tenant ? ["a.tenant_id = ?"] : []), ...(includeDeleted ? [] : ["a.deleted_at IS NULL"])];
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.tenant_id, a.display_name, a.shard, a.created_at, a.deleted_at,
       (SELECT group_concat(i.email) FROM identities i WHERE i.account_id = a.id) AS addresses
     FROM accounts a
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.created_at`,
  )
    .bind(...(tenant ? [tenant] : []))
    .all();
  return json({ accounts: results });
}

// ---- domains ---------------------------------------------------------

async function addDomain(body: { tenantId: string; domain: string }, env: Env) {
  const { tenantId, domain } = body;
  const steps: Step[] = [];
  const ses = sesClient(env);

  // 1. Find the zone (must already exist on the Cloudflare account).
  const zone = await cf<Array<{ id: string }>>(env, `/zones?name=${domain}`);
  const zoneId = zone.result?.[0]?.id;
  steps.push({ step: "cf:find-zone", ok: !!zoneId, detail: zoneId ?? "zone not on account" });
  if (!zoneId) return json({ ok: false, steps }, 422);

  // 2. Enable Email Routing (adds the inbound MX + SPF records itself).
  const enable = await cf(env, `/zones/${zoneId}/email/routing/enable`, { method: "POST" });
  steps.push({ step: "cf:email-routing-enable", ok: enable.success, detail: firstError(enable) });

  // 3. Catch-all rule → the ingest worker.
  const catchAll = await cf(env, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: {
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [env.INGEST_WORKER_NAME] }],
      enabled: true,
      name: "bullmoose ingest",
    },
  });
  steps.push({ step: "cf:catch-all→ingest", ok: catchAll.success, detail: firstError(catchAll) });

  // 4. SES: create the domain identity (409 = already exists, fine).
  let dkimTokens: string[] = [];
  const createIdentity = await ses.fetch(sesUrl(env, "/v2/email/identities"), {
    method: "POST",
    body: JSON.stringify({ EmailIdentity: domain }),
    headers: { "content-type": "application/json" },
  });
  if (createIdentity.ok) {
    const data = (await createIdentity.json()) as { DkimAttributes?: { Tokens?: string[] } };
    dkimTokens = data.DkimAttributes?.Tokens ?? [];
    steps.push({ step: "ses:create-identity", ok: true });
  } else if (createIdentity.status === 409) {
    const existing = await ses.fetch(sesUrl(env, `/v2/email/identities/${domain}`));
    const data = (await existing.json()) as { DkimAttributes?: { Tokens?: string[] } };
    dkimTokens = data.DkimAttributes?.Tokens ?? [];
    steps.push({ step: "ses:create-identity", ok: true, detail: "already existed" });
  } else {
    steps.push({ step: "ses:create-identity", ok: false, detail: await createIdentity.text() });
  }

  // 5. DKIM CNAMEs.
  for (const token of dkimTokens) {
    const rec = await dnsRecord(env, zoneId, {
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      content: `${token}.dkim.amazonses.com`,
    });
    steps.push({ step: `cf:dkim-cname:${token.slice(0, 8)}…`, ok: rec.ok, detail: rec.detail });
  }

  // 6. Custom MAIL FROM subdomain + its MX/SPF.
  const mailFrom = `bounce.${domain}`;
  const setMailFrom = await ses.fetch(sesUrl(env, `/v2/email/identities/${domain}/mail-from`), {
    method: "PUT",
    body: JSON.stringify({ MailFromDomain: mailFrom }),
    headers: { "content-type": "application/json" },
  });
  steps.push({
    step: "ses:mail-from",
    ok: setMailFrom.ok,
    detail: setMailFrom.ok ? mailFrom : await setMailFrom.text(),
  });
  const mfMx = await dnsRecord(env, zoneId, {
    type: "MX",
    name: mailFrom,
    content: `feedback-smtp.${env.SES_REGION}.amazonses.com`,
    priority: 10,
  });
  steps.push({ step: "cf:mail-from-mx", ok: mfMx.ok, detail: mfMx.detail });
  const mfSpf = await dnsRecord(env, zoneId, {
    type: "TXT",
    name: mailFrom,
    content: `"v=spf1 include:amazonses.com ~all"`,
  });
  steps.push({ step: "cf:mail-from-spf", ok: mfSpf.ok, detail: mfSpf.detail });

  // 7. DMARC.
  const dmarc = await dnsRecord(env, zoneId, {
    type: "TXT",
    name: `_dmarc.${domain}`,
    content: `"v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}"`,
  });
  steps.push({ step: "cf:dmarc", ok: dmarc.ok, detail: dmarc.detail });

  // 7b. JMAP autodiscovery (RFC 8620 §2.2): _jmap._tcp SRV → the app origin,
  // so `bullmoose login user@<domain>` needs no --base.
  //
  // This is the step that decides whether the FIRST command a new human runs
  // works, and it is the one with a silent failure mode: the client's rungs are
  // SRV → SRV-over-DoH → `https://<domain>/.well-known/jmap`, and rung 1 short-
  // circuits. A record pointing at a host that has stopped answering therefore
  // does not degrade to the fallback — it PRE-EMPTS it, and the login fails on
  // a domain that would have worked with no record at all. Whatever `JMAP_HOST`
  // names must answer `/.well-known/jmap` (401 counts, and is the usual answer);
  // leaving the var unset is the honest choice when nothing does. See the note
  // on the var in `wrangler.jsonc` for the window this deployment got wrong.
  if (env.JMAP_HOST) {
    const srv = await cf(env, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: {
        type: "SRV",
        name: `_jmap._tcp.${domain}`,
        ttl: 1,
        data: { priority: 0, weight: 1, port: 443, target: env.JMAP_HOST },
      },
    });
    const msg = firstError(srv);
    const already = msg !== undefined && /already exists/i.test(msg);
    steps.push({
      step: "cf:jmap-srv",
      ok: srv.success || already,
      detail: srv.success ? `→ ${env.JMAP_HOST}:443` : already ? "already existed" : msg,
    });
  } else {
    steps.push({
      step: "cf:jmap-srv",
      ok: true,
      detail:
        "skipped — no JMAP_HOST var; clients fall through to the " +
        "https://<domain>/.well-known/jmap rung, or need `login --base <app-origin>`",
    });
  }

  // 8. Record in the control plane; GET /domains/{domain} flips to active
  //    once SES verifies DKIM.
  await env.DB.prepare(
    `INSERT INTO domains (domain, tenant_id, status, cf_zone_id, created_at)
     VALUES (?, ?, 'pending_ses', ?, ?)
     ON CONFLICT (domain) DO UPDATE SET cf_zone_id = excluded.cf_zone_id`,
  )
    .bind(domain, tenantId, zoneId, Date.now())
    .run();

  return json({ ok: steps.every((s) => s.ok), domain, steps });
}

async function checkDomain(domain: string, env: Env) {
  const ses = sesClient(env);
  const res = await ses.fetch(sesUrl(env, `/v2/email/identities/${domain}`));
  if (!res.ok) return json({ domain, error: await res.text() }, 502);

  const data = (await res.json()) as {
    VerifiedForSendingStatus?: boolean;
    DkimAttributes?: { Status?: string };
  };
  const verified = data.VerifiedForSendingStatus === true && data.DkimAttributes?.Status === "SUCCESS";

  if (verified) {
    // NOT over a suspension. `status` is set from two directions — this SES
    // poll and the operator's `PATCH /domains {status}` — and a poll is a read
    // that happens to write. Without this guard, running `admin domain status`
    // on a suspended domain silently flips it back to `active` while its route
    // keys stay parked: `admin domain list` then reports healthy for a domain
    // whose every message bounces, with no read path showing the true state.
    await env.DB.prepare(`UPDATE domains SET status = 'active' WHERE domain = ? AND status != 'suspended'`)
      .bind(domain)
      .run();
  }

  return json({
    domain,
    verifiedForSending: data.VerifiedForSendingStatus ?? false,
    dkimStatus: data.DkimAttributes?.Status ?? "UNKNOWN",
    status: verified ? "active" : "pending_ses",
  });
}

/** The only statuses an operator may set by hand. `checkDomain` owns the rest
 * of the ladder (`pending_dns → pending_ses → active`); mirrors the
 * GRANTABLE_SCOPES allow-list pattern rather than trusting the body. */
const SETTABLE_DOMAIN_STATUSES = new Set(["active", "suspended"]);

/**
 * Suspend / resume a domain — the reversible 90% of "delete this domain".
 *
 * ⚠️ The status column alone is COSMETIC: nothing in the tree reads
 * `domains.status`, and ingest resolves delivery through KV with no D1
 * fallback (`services/ingest/src/index.ts` `resolveRoute`). A route-flag that
 * does not stop mail would be worse than no route at all, so suspension is
 * implemented where delivery actually lives: the KV keys for the domain are
 * moved aside, and mail bounces `550 5.1.1` from the next message on.
 *
 * They are PARKED rather than deleted because `forwardTo` is a KV-only field
 * (read by ingest, written by nothing here — see `reconcileRouteKey`). D1 can
 * rebuild `{kind, accountId, tenantId}` but it cannot rebuild a hand-set
 * deliver-and-forward list, so resume restores the parked copy verbatim and
 * only falls back to `routes` for keys that have no parked copy.
 */
async function setDomainStatus(domain: string, body: { status?: string }, env: Env) {
  const status = body?.status;
  if (!status || !SETTABLE_DOMAIN_STATUSES.has(status)) {
    return json({ error: `status must be one of: ${[...SETTABLE_DOMAIN_STATUSES].sort().join(", ")}` }, 400);
  }
  const row = await env.DB.prepare(`SELECT domain, status FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<{ domain: string; status: string }>();
  if (!row) return json({ error: `no domain ${domain}` }, 404);

  const steps: Step[] = [
    status === "suspended" ? await parkDomainRoutes(env, domain) : await restoreDomainRoutes(env, domain),
  ];
  await env.DB.prepare(`UPDATE domains SET status = ? WHERE domain = ?`).bind(status, domain).run();
  steps.push({ step: "d1:domains.status", ok: true, detail: `${row.status} → ${status}` });

  return json({ ok: true, domain, status, previousStatus: row.status, steps });
}

/**
 * Move every live route key for the domain aside. Mail stops here.
 *
 * Keys are independent, so they move concurrently: this is the operation an
 * operator reaches for mid-incident to stop mail NOW, and serialising three KV
 * round trips per mailbox would put a 50-account domain into multiple seconds
 * of wall clock inside one request.
 */
async function parkDomainRoutes(env: Env, domain: string): Promise<Step> {
  // D1 first, then KV's listing. `KV.list` is eventually consistent — it lags
  // writes by up to a minute — so provisioning an account and immediately
  // suspending the domain (the natural incident sequence) would miss the key
  // that was just written and report `ok: true` for a suspension with a live
  // hole in it. `routes` is the authoritative record of which keys must exist;
  // the KV listing adds the hand-set ones D1 never knew about (aliases,
  // catch-alls). Union of the two, deduped.
  const { results: rows } = await env.DB.prepare(`SELECT localpart FROM routes WHERE domain = ?`)
    .bind(domain)
    .all<{ localpart: string }>();
  const keys = [
    ...new Set([
      ...rows.map((r) => `route:${domain}:${r.localpart}`),
      ...(await listAllKeys(env.ROUTES, `route:${domain}:`)),
    ]),
  ];
  const parked = await Promise.all(
    keys.map(async (key) => {
      const value = await env.ROUTES.get(key);
      if (value === null) return 0;
      await env.ROUTES.put(`suspended-${key}`, value);
      await env.ROUTES.delete(key);
      return 1;
    }),
  );
  const n = parked.reduce((a: number, b: number) => a + b, 0);
  return {
    step: "kv:park-route-keys",
    ok: true,
    detail: `${n} key(s) parked — mail for ${domain} now bounces 550 5.1.1`,
  };
}

/**
 * Put them back.
 *
 * D1 FIRST, parked copies SECOND, and the order is the point. `routes` can
 * rebuild `{kind, accountId, tenantId}` but not `forwardTo`, which is written
 * by nothing in this worker and read by ingest; the parked copy is the only
 * record of it. Reconciling first and then overwriting from the park means the
 * parked value always wins, so a stale KV read during the reconcile pass — KV
 * gives no read-after-write guarantee and caches negative lookups for up to a
 * minute — can no longer clobber a deliver-and-forward list.
 *
 * A `routes` row whose kind is not `mailbox` (a hand-set alias or forward) is
 * restorable only from its parked copy, because D1 does not record its
 * payload. If one has no parked copy, the step says so instead of quietly
 * coming back `active` with a class of addresses bouncing.
 */
async function restoreDomainRoutes(env: Env, domain: string): Promise<Step> {
  const { results: rows } = await env.DB.prepare(
    `SELECT r.localpart, r.kind, r.target, a.tenant_id
     FROM routes r LEFT JOIN accounts a ON a.id = r.target
     WHERE r.domain = ?`,
  )
    .bind(domain)
    .all<{ localpart: string; kind: string; target: string; tenant_id: string | null }>();

  // `reconcileRouteKey`, not a bare put: it compares the key against the
  // `routes` row rather than merely checking that SOMETHING is there, so a key
  // that drifted onto a different accountId is corrected instead of skipped.
  const mailbox = rows.filter((r) => r.kind === "mailbox" && r.tenant_id !== null);
  const repairs = await Promise.all(
    mailbox.map((r) =>
      reconcileRouteKey(env, { tenantId: r.tenant_id as string, domain, localpart: r.localpart }, r.target),
    ),
  );
  const rebuilt = repairs.filter((x) => x !== null).length;

  const parked = await listAllKeys(env.ROUTES, `suspended-route:${domain}:`);
  const parkedLocalparts = new Set(parked.map((k) => k.slice(`suspended-route:${domain}:`.length)));
  const restoredFlags = await Promise.all(
    parked.map(async (key) => {
      const value = await env.ROUTES.get(key);
      if (value !== null) await env.ROUTES.put(key.slice("suspended-".length), value);
      await env.ROUTES.delete(key);
      return value !== null ? 1 : 0;
    }),
  );
  const restored = restoredFlags.reduce((a: number, b: number) => a + b, 0);

  const unrestorable = rows.filter((r) => r.kind !== "mailbox" && !parkedLocalparts.has(r.localpart));
  return {
    step: "kv:restore-route-keys",
    ok: unrestorable.length === 0,
    detail:
      `${restored} restored from the parked copy, ${rebuilt} reconciled against routes` +
      (unrestorable.length > 0
        ? ` — ⚠️ ${unrestorable.length} non-mailbox route(s) (${unrestorable
            .map((r) => `${r.localpart}:${r.kind}`)
            .join(", ")}) had no parked copy and cannot be rebuilt from D1; re-create them by hand`
        : ""),
  };
}

/** Every key under a prefix, following KV's cursor. */
async function listAllKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) names.push(key.name);
    if (page.list_complete) return names;
    cursor = page.cursor;
  }
}

/**
 * Hard delete — the mistyped-domain case, and narrowly that.
 *
 * REFUSES with 409 while any `routes` row or any identity sits on the domain.
 * That is not only politeness: `routes.domain` declares `REFERENCES
 * domains(domain)`, so the delete would otherwise surface as `{error:
 * "D1_ERROR: FOREIGN KEY constraint failed"}` with a 500 from the catch at the
 * top of `fetch`. A domain nothing points at never carried mail, so there is
 * no history a tombstone would preserve.
 *
 * `addDomain` mutates Cloudflare and SES as well as D1, and symmetry with it
 * is the point: create tells you which of eight steps failed, so delete must
 * too. What it unwinds and what it deliberately does not:
 *
 *   unwound   — the catch-all rule pointing at the ingest worker, and the SES
 *               domain identity. Both are ours, both were created by
 *               `addDomain`, and both keep working after the platform forgets
 *               the domain if they are left.
 *   NOT       — Email Routing itself (the zone may carry other rules), and
 *   unwound     every DNS record: DKIM CNAMEs, MAIL FROM MX/SPF, DMARC, the
 *               `_jmap._tcp` SRV. They are inert without the SES identity, an
 *               operator may have hand-edited them, and deleting records out
 *               from under a zone is a worse failure than leaving them.
 *
 * Both facts land in `steps[]` either way, so a person reads the output and
 * knows what is left.
 */
async function deleteDomain(domain: string, env: Env) {
  const row = await env.DB.prepare(`SELECT domain, tenant_id, cf_zone_id FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<{ domain: string; tenant_id: string; cf_zone_id: string | null }>();
  if (!row) return json({ error: `no domain ${domain}` }, 404);

  const routes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM routes WHERE domain = ?`)
    .bind(domain)
    .first<{ n: number }>();
  // LIVE accounts only. `deleteAccount` deliberately RETAINS `identities` rows
  // so the tombstone can still be read, and nothing in the tree deletes one —
  // so counting them all would make the 409 permanent, and its own advice
  // ("delete those accounts first") impossible to satisfy. A domain whose only
  // remaining identities belong to tombstones has no live claim on it; that is
  // precisely the mistyped-domain-with-one-account case this verb exists for.
  //
  // `instr` rather than LIKE: a domain is untrusted input and `_` is a legal
  // LIKE wildcard as well as a legal DNS character.
  const identities = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM identities i JOIN accounts a ON a.id = i.account_id
     WHERE lower(substr(i.email, instr(i.email, '@') + 1)) = ? AND a.deleted_at IS NULL`,
  )
    .bind(domain.toLowerCase())
    .first<{ n: number }>();
  const heldRoutes = routes?.n ?? 0;
  const heldIdentities = identities?.n ?? 0;
  if (heldRoutes > 0 || heldIdentities > 0) {
    return json(
      {
        error:
          `${domain} still carries ${heldRoutes} route(s) and ${heldIdentities} identity(s) — ` +
          "delete those accounts first (DELETE /accounts/{id}), or suspend the domain instead " +
          `(PATCH /domains/${domain} {"status":"suspended"})`,
        domain,
        holds: { routes: heldRoutes, identities: heldIdentities },
      },
      409,
    );
  }

  const steps: Step[] = [];

  if (row.cf_zone_id) {
    // There is no DELETE for a catch-all rule; disabling it and pointing it at
    // `drop` is the mirror of the PUT `addDomain` makes.
    const catchAll = await cf(env, `/zones/${row.cf_zone_id}/email/routing/rules/catch_all`, {
      method: "PUT",
      body: {
        matchers: [{ type: "all" }],
        actions: [{ type: "drop" }],
        enabled: false,
        name: "bullmoose ingest (removed)",
      },
    });
    steps.push({
      step: "cf:catch-all-disable",
      ok: catchAll.success,
      detail: catchAll.success ? "no longer routed to ingest" : firstError(catchAll),
    });
  } else {
    steps.push({
      step: "cf:catch-all-disable",
      ok: true,
      detail: "skipped — no cf_zone_id on record",
    });
  }
  steps.push({
    step: "cf:email-routing",
    ok: true,
    detail: "NOT disabled — the zone may carry other rules; disable it by hand if this was the only one",
  });

  const ses = sesClient(env);
  const dropIdentity = await ses.fetch(sesUrl(env, `/v2/email/identities/${domain}`), {
    method: "DELETE",
  });
  steps.push({
    step: "ses:delete-identity",
    // 404 = already gone, which is the state we wanted.
    ok: dropIdentity.ok || dropIdentity.status === 404,
    detail: dropIdentity.ok ? undefined : dropIdentity.status === 404 ? "already absent" : await dropIdentity.text(),
  });
  steps.push({
    step: "cf:dns-records",
    ok: true,
    detail: "NOT unwound — DKIM CNAMEs, MAIL FROM MX/SPF, _dmarc and _jmap._tcp SRV are left in place",
  });

  // Stragglers: the 409 above proves `routes` is empty, but KV is a copy and
  // copies drift. Parked keys from a previous suspend go too, or a later
  // re-add of the domain would resurrect delivery for addresses that are gone.
  let dropped = 0;
  for (const prefix of [`route:${domain}:`, `suspended-route:${domain}:`]) {
    for (const key of await listAllKeys(env.ROUTES, prefix)) {
      await env.ROUTES.delete(key);
      dropped += 1;
    }
  }
  steps.push({ step: "kv:route-keys", ok: true, detail: `${dropped} key(s) removed` });

  await env.DB.prepare(`DELETE FROM domains WHERE domain = ?`).bind(domain).run();
  steps.push({ step: "d1:delete-domain", ok: true });

  return json({ ok: steps.every((s) => s.ok), deleted: true, domain, steps });
}

// ---- accounts --------------------------------------------------------

/**
 * A mail address must be unique as a **delivery route**. That constraint
 * already exists — `routes` is `PRIMARY KEY (domain, localpart)` — and it
 * deliberately does NOT exist on `identities`, whose `UNIQUE (account_id,
 * email)` is per-account on purpose: aliases and send-as (`Identity/set`)
 * legitimately want one address usable from more than one place. The route is
 * what decides where mail lands, so the route is what must be unique.
 *
 * Before this guard, `POST /accounts` was last-write-wins. A second call for
 * an address that already had a mailbox created a SECOND account and repointed
 * delivery onto it with `INSERT OR REPLACE`, which in SQLite is
 * delete-then-insert. Account #1 kept every message it had ever received and
 * became unreachable by any address; the API reported success. The triggers
 * were mundane — a request retried after a timeout, a re-run bootstrap, a typo
 * "fixed" by running it again — and the symptom was "my mail stopped arriving"
 * on a system where every component reports healthy.
 *
 *   existing route for (domain, localpart)?
 *   ├── none                     → create the account, insert the route    200
 *   ├── already THIS address's   → return the existing account             200
 *   │   mailbox                    (idempotent retry; no D1 write)
 *   └── anything else            → 409, change nothing
 *
 * The pre-check cannot be atomic with the write (D1 has no interactive
 * transaction), so the write is its own guard too: `INSERT INTO routes`
 * — not `INSERT OR REPLACE` — lets the primary key reject a concurrent
 * duplicate, and D1's batch is atomic so the loser rolls back whole.
 */
async function createAccount(
  body: {
    tenantId: string;
    domain: string;
    localpart: string;
    displayName: string;
    principalEmail?: string;
    /** Explicit, audited override for a reserved local-part — the admin
     *  claiming `postmaster@` deliberately. A self-serve path never sets it. */
    allowReserved?: boolean;
  },
  env: Env,
) {
  const { tenantId, domain, displayName } = body;
  // Normalize once. The route row, the identity and the KV key must all agree
  // on casing or delivery resolves to a different key than provisioning wrote.
  const localpart = body.localpart.toLowerCase();
  const address = `${localpart}@${domain}`;
  const now = Date.now();

  // s33's 🔴 — reserved names refuse BEFORE any check touches the database,
  // so the refusal costs nothing and leaks nothing (not even "is it taken").
  const reserved = adminRefusalReason(localpart);
  if (reserved && body.allowReserved !== true) {
    return json(
      {
        error:
          `${localpart}@ is reserved (${reserved}) — if you are the operator claiming it deliberately, ` +
          `re-send with {"allowReserved": true}`,
        localpart,
        reserved,
      },
      422,
    );
  }

  // The route row references domains(domain); creating a mailbox on an
  // unwired domain must be a clear client error, not an FK 500.
  const domainRow = await env.DB.prepare(`SELECT tenant_id, status FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<{ tenant_id: string; status: string }>();
  if (!domainRow) {
    return json({ error: `domain ${domain} not onboarded — run POST /domains first` }, 422);
  }
  if (domainRow.tenant_id !== tenantId) {
    return json({ error: `domain ${domain} belongs to a different tenant` }, 422);
  }
  // A suspended domain has had its route keys moved aside so mail bounces.
  // Creating an account on it would write a LIVE key and quietly re-arm
  // delivery for that one address — a partial, undetectable suspension. The
  // adopt path runs through here too, so this also stops `reconcileRouteKey`
  // "repairing" a key the operator deliberately parked.
  if (domainRow.status === "suspended") {
    return json(
      {
        error: `domain ${domain} is suspended — resume it first (PATCH /domains/${domain} {"status":"active"})`,
        domain,
        status: domainRow.status,
      },
      409,
    );
  }

  // Uniqueness check BEFORE any write, so a rejected create leaves nothing
  // behind: no stray principal row, no KV key pointing at an account that was
  // never wired, no half-provisioned account.
  const existingRoute = await env.DB.prepare(`SELECT kind, target FROM routes WHERE domain = ? AND localpart = ?`)
    .bind(domain, localpart)
    .first<{ kind: string; target: string }>();
  if (existingRoute) {
    return adoptOrConflict(existingRoute, { tenantId, domain, localpart, address }, body.principalEmail, env);
  }

  // --principal attaches this mailbox to an EXISTING login, so one
  // session surfaces eric@a.com and eric@b.com as sibling accounts
  // (the §4 multi-domain model). Default: a new principal keyed to the
  // address itself.
  let principalId: string;
  if (body.principalEmail) {
    const existing = await findPrincipal(env, body.principalEmail);
    if (!existing) {
      return json({ error: `principal ${body.principalEmail} not found` }, 422);
    }
    principalId = existing.id;
  } else {
    principalId = `p_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO principals (id, tenant_id, login_email, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(principalId, tenantId, address, now)
      .run();
    const row = await findPrincipal(env, address);
    principalId = row?.id ?? principalId;
  }

  const accountId = `${tenantId}__a_${crypto.randomUUID().slice(0, 8)}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, tenant_id, principal_id, display_name, shard, created_at)
           VALUES (?, ?, ?, ?, 'shard0', ?)`,
      ).bind(accountId, tenantId, principalId, displayName, now),
      env.DB
        // may_delete = 0 explicitly rather than by default: this is the
        // account's primary, the row EmailSubmission/set resolves `From:`
        // against, and Identity/set refuses to destroy it. The column
        // DEFAULTs to 1 because user-added identities are the common case,
        // so relying on the default here would make the one identity that
        // must survive the one that is deletable.
        .prepare(
          `INSERT INTO identities (id, account_id, email, name, may_delete)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .bind(`identity_${crypto.randomUUID().slice(0, 8)}`, accountId, address, displayName),
      // NOT `INSERT OR REPLACE` — that is a delete-then-insert in SQLite and
      // was the mechanism that silently moved delivery off account #1. Plain
      // INSERT lets PRIMARY KEY (domain, localpart) reject the duplicate, which
      // is what makes this batch safe against the race the pre-check above
      // cannot close on its own.
      env.DB.prepare(`INSERT INTO routes (domain, localpart, kind, target) VALUES (?, ?, 'mailbox', ?)`).bind(
        domain,
        localpart,
        accountId,
      ),
      // Standard role mailboxes so the first Mailbox/get isn't empty.
      //
      // SIX, not seven: wave 1 seeded a second pile beside Junk under an
      // invented `role: 'quarantine'`, which is in no IANA registry and which
      // a standards-native client therefore renders as an ordinary folder.
      // Held mail lives in the REGISTERED junk role (so Apple Mail, himalaya
      // et al. behave correctly) under the display name 'Quarantined' — a
      // condition, not a room.
      //
      // The pair is spelled out rather than imported: provision does not
      // depend on @bullmoose/mailstore and adding the dependency to carry two
      // strings would pull the whole store (postal-mime and all) into this
      // worker's bundle. `createAccount.test.ts` asserts the seed against
      // QUARANTINE_ROLE/QUARANTINE_NAME, so the duplication cannot drift
      // silently — the test is the link the import would have been.
      ...[
        ["inbox", "Inbox"],
        ["sent", "Sent"],
        ["drafts", "Drafts"],
        ["trash", "Trash"],
        ["junk", "Quarantined"],
        ["archive", "Archive"],
      ].map(([role, name]) =>
        env.DB.prepare(
          `INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order)
             VALUES (?, ?, NULL, ?, ?, 0)`,
        ).bind(`mb_${crypto.randomUUID()}`, accountId, name, role),
      ),
    ]);
  } catch (err) {
    // Two concurrent creates for one address both clear the pre-check and
    // arrive here; the primary key picks a winner. D1's batch is atomic, so the
    // loser rolls back whole — no account, no identity, no mailboxes — and it
    // has touched no KV, because the put below is deliberately after the batch.
    // 409 rather than the generic 500 says what actually happened.
    if (isRouteConflict(err)) {
      return json(
        {
          error: `${address} was provisioned concurrently by another request — nothing was written`,
          address,
        },
        409,
      );
    }
    throw err;
  }

  // Hot copy for the ingest fast path. After the batch, never before: ingest
  // resolves delivery through this key alone, so a key written ahead of a
  // batch that then rolled back would point at an account that does not exist.
  await env.ROUTES.put(`route:${domain}:${localpart}`, JSON.stringify({ kind: "mailbox", accountId, tenantId }));

  return json({ ok: true, created: true, accountId, address });
}

/**
 * A route already exists for this address. Adopt it only when it is *exactly*
 * what a successful create would have produced — a mailbox route onto an
 * account in this tenant that already carries this identity. That is the
 * retried-bootstrap case, which is where this actually bites.
 *
 * Everything else is a real conflict: a forward/alias/catch-all route, another
 * tenant's account, a target that no longer exists, or an explicit
 * `principalEmail` that disagrees with who owns the account. Returning 200 for
 * any of those would be the same species of lie as the silent repoint it
 * replaces — success reported, reality somewhere else.
 */
async function adoptOrConflict(
  route: { kind: string; target: string },
  req: { tenantId: string; domain: string; localpart: string; address: string },
  principalEmail: string | undefined,
  env: Env,
) {
  const conflict = (reason: string) =>
    json(
      {
        error: `${req.address} already routes somewhere — ${reason}`,
        address: req.address,
        existingRoute: { kind: route.kind, target: route.target },
        // The reason this is 409 and not a repoint: there is no DELETE
        // /accounts, so an accidental repoint is not recoverable through the
        // API (.plans/sVOL-CapSurNoun/008).
        hint: "delivery was left untouched — see docs/DEPLOY.md, 'Runbook: an address already routes somewhere'",
      },
      409,
    );

  if (route.kind !== "mailbox") return conflict(`it is a '${route.kind}' route, not a mailbox`);

  const account = await env.DB.prepare(`SELECT id, tenant_id, principal_id, deleted_at FROM accounts WHERE id = ?`)
    .bind(route.target)
    .first<{ id: string; tenant_id: string; principal_id: string; deleted_at: number | null }>();
  if (!account) return conflict(`its target account ${route.target} no longer exists`);
  // Defensive: `deleteAccount` drops the route row, so a route pointing at a
  // tombstone should be unreachable. If one exists anyway, adopting it would
  // resurrect delivery into a deleted account — the one outcome the tombstone
  // is there to prevent.
  if (account.deleted_at !== null) return conflict(`its target account ${route.target} was deleted`);
  if (account.tenant_id !== req.tenantId) {
    return conflict(`its account belongs to tenant ${account.tenant_id}`);
  }

  // A mailbox route onto an account with no identity for this address is not a
  // retry of this request — it is some other wiring that happens to sit on the
  // same key, and taking it over is precisely the orphaning this guards.
  const identity = await env.DB.prepare(`SELECT id FROM identities WHERE account_id = ? AND email = ?`)
    .bind(account.id, req.address)
    .first<{ id: string }>();
  if (!identity) return conflict(`its account ${account.id} has no ${req.address} identity`);

  if (principalEmail) {
    const wanted = await findPrincipal(env, principalEmail);
    if (!wanted) return json({ error: `principal ${principalEmail} not found` }, 422);
    if (wanted.id !== account.principal_id) {
      return conflict(`its account is owned by principal ${account.principal_id}, not ${principalEmail}`);
    }
  }

  // Idempotent retry. Nothing is written to D1 — the rows are already correct.
  const repaired = await reconcileRouteKey(env, req, account.id);
  return json({
    ok: true,
    created: false,
    accountId: account.id,
    address: req.address,
    note: `${req.address} already exists — returned the existing account, delivery untouched`,
    ...(repaired ? { repairedRouteKey: repaired } : {}),
  });
}

/**
 * Bring the ingest fast-path key back in line with the `routes` row.
 *
 * Worth doing on the adopt path specifically: ingest resolves delivery through
 * `route:{domain}:{localpart}` and has **no D1 fallback**
 * (`services/ingest/src/index.ts` `resolveRoute`), so a key that is missing —
 * the first call died between the batch and the put — means every message
 * bounces `550 5.1.1` while the control plane looks perfectly healthy. D1 is
 * the durable record; KV is the copy, so KV is what gets corrected.
 *
 * A key that already agrees is left completely alone, which keeps a hand-set
 * `forwardTo` (read by ingest, written by nothing here) from being clobbered
 * by a retry. Returns what it fixed, or null if there was nothing to fix.
 */
async function reconcileRouteKey(
  env: Env,
  req: { tenantId: string; domain: string; localpart: string },
  accountId: string,
): Promise<string | null> {
  const key = `route:${req.domain}:${req.localpart}`;
  const current = await env.ROUTES.get<{
    kind?: string;
    accountId?: string;
    tenantId?: string;
    forwardTo?: string[];
  }>(key, "json");
  if (current?.kind === "mailbox" && current.accountId === accountId && current.tenantId === req.tenantId) {
    return null;
  }
  await env.ROUTES.put(
    key,
    JSON.stringify({
      kind: "mailbox",
      accountId,
      tenantId: req.tenantId,
      ...(current?.forwardTo?.length ? { forwardTo: current.forwardTo } : {}),
    }),
  );
  return current ? "stale" : "missing";
}

/**
 * A `PRIMARY KEY (domain, localpart)` violation on `routes`.
 *
 * SQLite implements a composite primary key on a rowid table as a unique
 * index, so the failure surfaces as `UNIQUE constraint failed: routes.domain,
 * routes.localpart` — matched here rather than compared exactly because D1
 * prefixes it (`D1_ERROR: …`) and the column list is not worth pinning.
 */
function isRouteConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /constraint failed:[^\n]*\broutes\b/i.test(msg);
}

/** Rename. `display_name` is what the JMAP Session calls the account, so this
 * is the one an operator sees after a typo. */
async function renameAccount(id: string, body: { displayName?: string }, env: Env) {
  if (!body?.displayName) return json({ error: "displayName required" }, 400);
  const res = await env.DB.prepare(`UPDATE accounts SET display_name = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.displayName, id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: `no live account ${id}` }, 404);
  return json({ ok: true, accountId: id, displayName: body.displayName });
}

/**
 * SOFT delete — a tombstone plus a delivery teardown.
 *
 * The tombstone is not squeamishness. `accounts.shard` (default `shard0`)
 * selects a DIFFERENT database, and R2 has no GC path at all
 * (`packages/mailstore/src/index.ts`: *"garbage collection is a separate sweep
 * (TODO)"*). Everything this account owns — messages, calendars, contacts,
 * blobs — is out of this worker's reach. Dropping the `accounts` row would
 * leave all of it addressed by an id that resolves to nothing, which destroys
 * the evidence without freeing the storage. So the row stays and every
 * resolution path filters `deleted_at IS NULL`.
 *
 * KV BEFORE D1, which is the exact mirror of `createAccount` writing D1 before
 * KV. Both orders are chosen so a crash in the middle fails SAFE:
 *
 *   create  D1 → KV   a key never points at an account that does not exist
 *   delete  KV → D1   a live account never has mail delivered into a tombstone
 *
 * A crash between the two leaves mail bouncing for an account that is still
 * live — visible, recoverable, and strictly better than the reverse.
 */
async function deleteAccount(accountId: string, env: Env) {
  const account = await env.DB.prepare(
    `SELECT id, tenant_id, principal_id, shard, deleted_at FROM accounts WHERE id = ?`,
  )
    .bind(accountId)
    .first<{
      id: string;
      tenant_id: string;
      principal_id: string;
      shard: string;
      deleted_at: number | null;
    }>();
  if (!account) return json({ error: `no account ${accountId}` }, 404);
  if (account.deleted_at !== null) {
    return json({
      ok: true,
      deleted: false,
      accountId,
      deletedAt: account.deleted_at,
      note: `${accountId} was already deleted — nothing was written`,
    });
  }

  // EVERY route, not just `kind = 'mailbox'`. An alias, a forward, or the
  // catch-all `localpart = '*'` can all name this account as their target —
  // `resolveRoute` in ingest falls back to the catch-all — and one left behind
  // goes on delivering into the tombstone. It would also block
  // `DELETE /domains` forever, since that refuses while any route survives.
  const { results: routes } = await env.DB.prepare(`SELECT domain, localpart, kind FROM routes WHERE target = ?`)
    .bind(accountId)
    .all<{ domain: string; localpart: string; kind: string }>();
  const { results: identities } = await env.DB.prepare(
    `SELECT email FROM identities WHERE account_id = ? ORDER BY email`,
  )
    .bind(accountId)
    .all<{ email: string }>();

  const steps: Step[] = [];
  const now = Date.now();

  await Promise.all(
    routes.flatMap((r) => [
      env.ROUTES.delete(`route:${r.domain}:${r.localpart}`),
      // The parked copy too: a suspended domain that is later resumed must not
      // resurrect delivery into an account that has since been deleted.
      env.ROUTES.delete(`suspended-route:${r.domain}:${r.localpart}`),
    ]),
  );
  steps.push({
    step: "kv:route-keys",
    ok: true,
    detail:
      routes.length > 0
        ? `${routes.map((r) => `${r.localpart}@${r.domain} (${r.kind})`).join(", ")} — mail now bounces 550 5.1.1`
        : "none were set",
  });

  // Public share links resolve from KV alone, on no credential at all
  // (`services/jmap` `GET /share/*`), so tombstoning the account does not touch
  // them: whoever holds a minted URL keeps pulling R2 blobs until the record's
  // TTL runs out — up to 90 days. Absence denies (`if (!record …)` there), so
  // deleting the key IS the revocation.
  const shareKeys = await listAllKeys(env.ROUTES, `share:${accountId}:`);
  await Promise.all(shareKeys.map((k) => env.ROUTES.delete(k)));
  steps.push({
    step: "kv:share-links",
    ok: true,
    detail: `${shareKeys.length} link(s) revoked`,
  });

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM routes WHERE target = ?`).bind(accountId),
    env.DB.prepare(`UPDATE accounts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(now, accountId),
  ]);
  steps.push({ step: "d1:routes", ok: true, detail: `${routes.length} row(s) removed` });
  steps.push({ step: "d1:accounts.deleted_at", ok: true, detail: new Date(now).toISOString() });

  // Bindings on a tombstoned account are already inert — the drain filters
  // deleted accounts — but flipping the column keeps `admin agent list`
  // honest, and re-creating the address later must not silently re-arm an
  // agent nobody remembers binding.
  const bindings = await env.DB.prepare(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND enabled = 1`)
    .bind(accountId)
    .run();
  steps.push({
    step: "d1:agent-bindings",
    ok: true,
    detail: `${bindings.meta.changes ?? 0} disabled`,
  });

  // ── disable HOLDS the queue; delete CANCELS it ──────────────────────────
  //
  // `setBindingEnabled` deliberately leaves `pending` rows alone, because
  // disable is a pause with a matching enable. Delete has no matching verb and
  // the drain skips tombstoned accounts, so those rows could never reach a
  // terminal status again: they would sit `pending` forever, permanently
  // blocking `DELETE /agent-bindings` (which refuses while work is queued) and
  // permanently inflating the drain's held-backlog log. Terminating them here
  // is what keeps that log actionable.
  const cancelled = await env.DB.prepare(
    `UPDATE agent_invocations SET status = 'failed', note = ?, done_at = ?
     WHERE account_id = ? AND status IN ('pending', 'running')`,
  )
    .bind(`account ${accountId} was deleted`, now, accountId)
    .run();
  steps.push({
    step: "d1:agent-invocations",
    ok: true,
    detail: `${cancelled.meta.changes ?? 0} queued invocation(s) cancelled — they can never run now`,
  });

  // ── the credential hole ────────────────────────────────────────────────
  //
  // `principals.login_email` is UNIQUE and `createAccount` reuses a principal
  // by that email, so re-creating a deleted address RE-ATTACHES the old
  // principal. Without this, every token and the password that could read the
  // old mailbox silently become live credentials for whoever is given the
  // address next — the opposite of what deleting a compromised mailbox means.
  //
  // Only when this was the principal's last live account: a principal may
  // legitimately own eric@a.com and eric@b.com, and deleting one must not log
  // the other out. Tokens are the one thing here that is hard-deleted rather
  // than tombstoned, and that is `revokeToken`'s existing convention.
  const stillOwns = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM accounts WHERE principal_id = ? AND deleted_at IS NULL`,
  )
    .bind(account.principal_id)
    .first<{ n: number }>();
  const orphaned = (stillOwns?.n ?? 0) === 0;
  if (orphaned) {
    const [tokens] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM tokens WHERE principal_id = ?`).bind(account.principal_id),
      env.DB.prepare(`DELETE FROM credentials WHERE principal_id = ?`).bind(account.principal_id),
    ]);
    steps.push({
      step: "d1:principal-credentials",
      ok: true,
      detail: `${account.principal_id} owns no live account — ${tokens?.meta.changes ?? 0} token(s) and its password revoked`,
    });
  } else {
    steps.push({
      step: "d1:principal-credentials",
      ok: true,
      detail: `${account.principal_id} still owns ${stillOwns?.n} live account(s) — its tokens were left alone`,
    });
  }

  return json({
    ok: true,
    deleted: true,
    softDeleted: true,
    accountId,
    deletedAt: now,
    addresses: identities.map((i) => i.email),
    steps,
    // Say what is left, in the response, so the caller does not have to infer
    // it. "Delete account" leaves rows and objects behind and always will
    // until somebody owns cross-plane teardown (008 open question #4).
    retained: [
      "identities and mailboxes rows — kept so the tombstone can still be read",
      `every message, calendar, contact and R2 blob on ${account.shard} — the data plane is a separate database this worker cannot reach`,
      "grants naming this account — inert while it is tombstoned (see s03.A T2 for their own lifecycle)",
      ...(orphaned
        ? []
        : [
            `tokens and vault credentials of principal ${account.principal_id} — it still owns another live account, so revoking them would log that one out too`,
          ]),
    ],
    note:
      "re-creating this address with POST /accounts builds a NEW account; " +
      "the tombstoned one keeps its mail and stays unreachable",
  });
}

// ---- credentials & tokens ---------------------------------------------

async function findPrincipal(env: Env, email: string): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(email.toLowerCase())
    .first<{ id: string }>();
}

/** How long an enrollment link lives. Long enough to text someone and let
 *  them get to it tonight; short enough that a forgotten link is not a
 *  standing credential. */
const ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mint a one-time enrollment link (s33 day-one).
 *
 * THE POINT is who never learns what: `setPassword` above is operator-called,
 * so every credential it sets is a credential the operator chose and knows —
 * the distance #213 named. This link inverts it. The operator gets a URL and
 * hands it over OUT-OF-BAND (a text message is a different channel — the s33
 * trust anchor); the arriving human registers TWO PASSKEYS at /enroll on the
 * AS (s33 slice 2 — the credential rule removed the password entirely), and
 * there is nothing for the operator to see: the rows are public keys.
 *
 * Storage follows the tokens table's rule to the letter: the plaintext is in
 * the response ONCE, only its SHA-256 lands in the row. The URL carries the
 * token in the FRAGMENT, which browsers do not send — so it stays out of the
 * AS's access logs and out of any Referer.
 *
 * Minting again before use supersedes: the old row is consumed by the mint
 * (audit trail intact), so a link that went to the wrong number can be killed
 * by issuing a fresh one.
 */
async function mintEnrollmentLink(body: { email: string }, env: Env) {
  if (!body.email) return json({ error: "email required" }, 400);
  const principal = await findPrincipal(env, body.email);
  if (!principal) return json({ error: `no principal for ${body.email}` }, 404);

  const now = Date.now();
  // Supersede any live link for this principal — see the header.
  await env.DB.prepare(`UPDATE enrollments SET consumed_at = ? WHERE principal_id = ? AND consumed_at IS NULL`)
    .bind(now, principal.id)
    .run();

  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const secretHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = `en_${crypto.randomUUID()}`;
  const expiresAt = now + ENROLLMENT_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO enrollments (id, principal_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, principal.id, secretHash, now, expiresAt)
    .run();

  return json({
    url: `https://auth.bullmoose.cc/enroll#${secret}`,
    expiresAt,
    note: "One-time; hand it over out-of-band. Minting again supersedes this link.",
  });
}

async function setPassword(body: { email: string; loginKey: string }, env: Env) {
  // The client derives loginKey via PBKDF2 (see auth-core) — the raw
  // password never reaches this worker, and the KDF cost never hits the
  // Workers Free 10ms CPU cap.
  if (!body.email || !isLoginKey(body.loginKey)) {
    return json({ error: "email and loginKey (64-hex client-derived key; the CLI derives it) required" }, 400);
  }
  const principal = await findPrincipal(env, body.email);
  if (!principal) return json({ error: `no principal for ${body.email}` }, 404);

  await env.DB.prepare(
    `INSERT INTO credentials (principal_id, pw_algo, pw_hash, pw_salt, pw_iters, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (principal_id) DO UPDATE SET
       pw_algo = excluded.pw_algo, pw_hash = excluded.pw_hash,
       pw_salt = excluded.pw_salt, pw_iters = excluded.pw_iters,
       updated_at = excluded.updated_at`,
  )
    .bind(
      principal.id,
      LOGIN_KEY_ALGO,
      await hashLoginKey(body.loginKey),
      await loginSaltHex(body.email),
      LOGIN_KEY_ITERATIONS,
      Date.now(),
    )
    .run();
  return json({ ok: true, email: body.email.toLowerCase(), algo: LOGIN_KEY_ALGO });
}

/** Operator-minted tokens: agent runtimes, devices for other users, etc. */
async function mintPrincipalToken(
  body: { email: string; name: string; scopes?: string[]; expiresDays?: number },
  env: Env,
) {
  if (!body.email || !body.name) return json({ error: "email and name required" }, 400);
  const principal = await findPrincipal(env, body.email);
  if (!principal) return json({ error: `no principal for ${body.email}` }, 404);

  // Explicit scopes, always. This is the operator plane, so it is the one
  // mint site that may issue `admin` — all the more reason not to let an
  // omitted field pick for you. TOKEN_SCOPES also closes the hole where any
  // invented string was written to the row verbatim: GRANTABLE_SCOPES below
  // has always validated grants, and tokens had no equivalent.
  const wanted = resolveMintScopes(body.scopes, TOKEN_SCOPES);
  if (!wanted.ok) return json({ error: wanted.error }, 400);
  const scopes = wanted.scopes;
  const minted = await mintToken();
  await env.DB.prepare(
    `INSERT INTO tokens (id, principal_id, secret_hash, name, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      minted.id,
      principal.id,
      minted.secretHash,
      body.name,
      JSON.stringify(scopes),
      Date.now(),
      body.expiresDays ? Date.now() + body.expiresDays * 86_400_000 : null,
    )
    .run();
  return json({ token: minted.token, tokenId: minted.id, scopes }); // shown once
}

async function listTokens(url: URL, env: Env) {
  const email = url.searchParams.get("email");
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.scopes, t.created_at, t.expires_at, t.last_used_at, p.login_email
     FROM tokens t JOIN principals p ON p.id = t.principal_id
     ${email ? "WHERE p.login_email = ?" : ""} ORDER BY t.created_at`,
  )
    .bind(...(email ? [email.toLowerCase()] : []))
    .all();
  return json({ tokens: results });
}

async function revokeToken(id: string, env: Env) {
  const res = await env.DB.prepare(`DELETE FROM tokens WHERE id = ?`).bind(id).run();
  return json({ revoked: (res.meta.changes ?? 0) > 0 });
}

// ---- grants (Phase 3: cross-account delegation + sharing) ---------------

/**
 * What an account→account grant may confer.
 *
 * Exported since s26 T4's surface pass so the session BYOK door's tests can
 * assert an ABSENCE against the real list: `vault` is not here, which is what
 * makes "custody of a provider key does not delegate through a share" a
 * structural fact rather than a policy anyone has to remember. If a future
 * widening adds it, `providerCredential.test.ts` fails rather than the door
 * silently opening to every supervisor.
 */
export const GRANTABLE_SCOPES = new Set([
  "read",
  "annotate",
  "draft",
  "move",
  "send",
  "delete",
  "contacts",
  "calendar",
  "mail",
]);

/**
 * THE grant_lifecycle writer (s10 T2) — every lifecycle row goes through here
 * so the chain's columns cannot drift between the four call sites.
 * `viaProposalId` is the WHY: the authorizing proposal, when one was in scope.
 * The admin plane has none today, so its callers pass nothing and the column
 * lands NULL — the column existing is the contract T3 fills.
 */
async function logGrantLifecycle(
  env: Env,
  grantId: string,
  event: "created" | "revoked",
  at: number,
  viaProposalId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO grant_lifecycle (grant_id, event, at, actor, via_proposal_id)
     VALUES (?, ?, ?, 'admin', ?)`,
  )
    .bind(grantId, event, at, viaProposalId)
    .run();
}

/** Operator-minted grant: agent delegation (whole account) or a scoped
 * collection share. Same primitive AddressBook.shareWith rides on. */
async function createGrant(
  body: {
    granteeEmail: string;
    targetEmail: string;
    scopes?: string[];
    collection?: string;
    collectionId?: string;
    expiresDays?: number;
  },
  env: Env,
) {
  if (!body.granteeEmail || !body.targetEmail) {
    return json({ error: "granteeEmail and targetEmail required" }, 400);
  }
  const grantee = await accountWithTenant(env, body.granteeEmail);
  const target = await accountWithTenant(env, body.targetEmail);
  if (!grantee) return json({ error: `no account for ${body.granteeEmail}` }, 404);
  if (!target) return json({ error: `no account for ${body.targetEmail}` }, 404);
  if (grantee.id === target.id) return json({ error: "grantee = target" }, 400);
  if (grantee.tenant_id !== target.tenant_id) {
    return json({ error: "cross-tenant grants are not supported" }, 400);
  }

  const scopes = body.scopes && body.scopes.length > 0 ? body.scopes : ["read"];
  const bad = scopes.filter((s) => !GRANTABLE_SCOPES.has(s));
  if (bad.length > 0) return json({ error: `ungrantable scopes: ${bad.join(",")}` }, 400);
  if (body.collection !== undefined && body.collection !== "AddressBook") {
    return json({ error: `unknown collection: ${body.collection}` }, 400);
  }
  if (body.collection && !body.collectionId) {
    return json({ error: "collectionId required with collection" }, 400);
  }

  const id = `g_${crypto.randomUUID()}`;
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO grants (id, tenant_id, grantee_account_id, target_account_id, scopes,
       collection, collection_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      target.tenant_id,
      grantee.id,
      target.id,
      JSON.stringify(scopes),
      body.collection ?? null,
      body.collectionId ?? null,
      now,
      body.expiresDays ? now + body.expiresDays * 86_400_000 : null,
    )
    .run();
  // Log the birth of the grant (s03.A T2) — but only when a row was actually
  // inserted. `ON CONFLICT DO NOTHING` makes a duplicate tuple a silent no-op, so
  // guarding on `changes` keeps grant_lifecycle from claiming a create that never
  // happened.
  if ((res.meta.changes ?? 0) > 0) {
    await logGrantLifecycle(env, id, "created", now);
  } else {
    // The guard above was already here, keeping grant_lifecycle from claiming a
    // create that never happened — but the response still reported success with
    // an `id` no row carries. That is the worst shape for this failure: the
    // caller is told access was granted, gets a grantId to quote back, and
    // nothing exists. Now that `grants_tuple` is partial on `revoked_at IS
    // NULL`, a conflict can only mean a LIVE grant already covers this exact
    // tuple, so say that instead of inventing an id.
    const existing = await env.DB.prepare(
      `SELECT id FROM grants
        WHERE grantee_account_id = ? AND target_account_id = ?
          AND COALESCE(collection, '') = COALESCE(?, '')
          AND COALESCE(collection_id, '') = COALESCE(?, '')
          AND revoked_at IS NULL`,
    )
      .bind(grantee.id, target.id, body.collection ?? null, body.collectionId ?? null)
      .first<{ id: string }>();
    return json(
      {
        error: "a live grant already covers this grantee, target and collection",
        grantId: existing?.id ?? null,
        hint: "revoke the existing grant before creating one with different scopes",
      },
      409,
    );
  }
  return json({
    grantId: id,
    grantee: { email: body.granteeEmail.toLowerCase(), accountId: grantee.id },
    target: { email: body.targetEmail.toLowerCase(), accountId: target.id },
    scopes,
    collection: body.collection ?? null,
    collectionId: body.collectionId ?? null,
  });
}

async function listGrants(url: URL, env: Env) {
  const email = url.searchParams.get("email");
  let acct: { id: string } | null = null;
  if (email) {
    // Tombstones included. `deleteAccount` says grants naming the account are
    // "inert while it is tombstoned", and an operator auditing what it could
    // still reach must be able to see them — by id is the only way to revoke
    // one, and by email is the only way to find the id.
    acct = await accountByAddressAny(env, email);
    if (!acct) return json({ grants: [] });
  }
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.grantee_account_id, g.target_account_id, g.scopes, g.collection,
            g.collection_id, g.created_by, g.created_at, g.expires_at,
            (SELECT i.email FROM identities i WHERE i.account_id = g.grantee_account_id LIMIT 1) AS grantee_email,
            (SELECT i.email FROM identities i WHERE i.account_id = g.target_account_id LIMIT 1) AS target_email
     FROM grants g
     ${acct ? "WHERE g.grantee_account_id = ?1 OR g.target_account_id = ?1" : ""}
     ORDER BY g.created_at`,
  )
    .bind(...(acct ? [acct.id] : []))
    .all();
  return json({ grants: results });
}

async function revokeGrant(id: string, env: Env) {
  const now = Date.now();
  // Soft delete (s03.A T2): tombstone the row instead of DELETEing it. The grant
  // stops resolving immediately — verifyBearer filters `revoked_at IS NULL` — but
  // the row and its grant_lifecycle history survive, so "who could have reached
  // this account last Tuesday?" stays answerable. `008` left grants on hard
  // DELETE with a note that this slice owns their lifecycle; this is it. Only a
  // still-live grant flips; revoking an already-revoked grant is a no-op that
  // logs nothing (idempotent).
  const res = await env.DB.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now, id)
    .run();
  const revoked = (res.meta.changes ?? 0) > 0;
  if (revoked) {
    await logGrantLifecycle(env, id, "revoked", now);
  }
  return json({ revoked });
}

// ---- Bureau grants: mint ≠ authorize (bureau.md §5.1, s04 T2) --------------
//
// A SECOND grant vocabulary, and deliberately not the one above. `POST /grants`
// says "this account may read that account's mail"; this says "this principal
// may run THIS VERB with THAT CREDENTIAL" —
//
//     p_allen may use `sign_sigv4` with `aws-mcp`
//
// capability-shaped, never access-shaped. The distinction is not pedantry: it is
// what makes "this agent holds a SIGNING capability" legible in a way a scope
// string never is, and what lets the console show a per-agent view (grants) and
// a per-resource view (the credential) of the same fact.
//
// Who may use a credential is NOT a mint-time field. Keeping it out of
// `vault_credentials` is what makes revocation cheap: dropping a grant leaves
// the credential and every other grant on it untouched, so cutting `editor@`'s
// `fetch` does not disturb `travel@`'s.

/**
 * Grant `(principal, credRef, verb)`.
 *
 * Re-granting a tuple that was revoked REINSTATES it (`revoked_at = NULL`) and
 * logs a fresh `created` event, rather than the silent `ON CONFLICT DO NOTHING`
 * no-op `POST /grants` performs — a tombstone should not make a capability
 * ungrantable forever. The history survives in `grant_lifecycle` either way.
 */
async function createBureauGrant(
  body: { principalEmail: string; credRef: string; verb: string; expiresDays?: number },
  env: Env,
) {
  if (!body?.principalEmail || !body?.credRef || !body?.verb) {
    return json({ error: "principalEmail, credRef and verb are required" }, 400);
  }
  if (!isBureauVerb(body.verb)) {
    return json({ error: `verb must be one of ${BUREAU_VERBS.join(", ")}` }, 400);
  }
  const principal = await env.DB.prepare(`SELECT id FROM principals WHERE login_email = ?`)
    .bind(body.principalEmail.toLowerCase())
    .first<{ id: string }>();
  if (!principal) return json({ error: `no principal for ${body.principalEmail}` }, 404);

  // The credential must exist before a capability over it can be granted —
  // otherwise a typo in `credRef` mints a grant that authorizes nothing and
  // looks live in the console forever.
  const cred = await env.DB.prepare(`SELECT kind FROM vault_credentials WHERE principal_id = ? AND name = ?`)
    .bind(principal.id, body.credRef)
    .first<{ kind: string }>();
  if (!cred) return json({ error: `no credential named ${body.credRef}` }, 404);

  const id = `bg_${crypto.randomUUID()}`;
  const now = Date.now();
  const expiresAt = body.expiresDays ? now + body.expiresDays * 86_400_000 : null;
  await env.DB.prepare(
    `INSERT INTO bureau_grants (id, principal_id, cred_name, verb, created_by,
       created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, 'admin', ?, ?, NULL)
     ON CONFLICT (principal_id, cred_name, verb) DO UPDATE SET
       revoked_at = NULL, created_at = excluded.created_at,
       created_by = excluded.created_by, expires_at = excluded.expires_at`,
  )
    .bind(id, principal.id, body.credRef, body.verb, now, expiresAt)
    .run();

  // The row may be the pre-existing one (reinstated), so read the id back rather
  // than assuming the one we generated won — the lifecycle log must name the row
  // that is actually live.
  const row = await env.DB.prepare(`SELECT id FROM bureau_grants WHERE principal_id = ? AND cred_name = ? AND verb = ?`)
    .bind(principal.id, body.credRef, body.verb)
    .first<{ id: string }>();
  const grantId = row?.id ?? id;
  await logGrantLifecycle(env, grantId, "created", now);

  return json({
    grantId,
    principal: { email: body.principalEmail.toLowerCase(), principalId: principal.id },
    credRef: body.credRef,
    kind: cred.kind,
    verb: body.verb,
    expiresAt,
  });
}

/** The capability table. Tombstones included and labelled — an operator
 *  auditing what an agent COULD do must be able to see what it no longer can. */
async function listBureauGrants(url: URL, env: Env) {
  const email = url.searchParams.get("email");
  const credRef = url.searchParams.get("credRef");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (email) {
    where.push("p.login_email = ?");
    binds.push(email.toLowerCase());
  }
  if (credRef) {
    where.push("bg.cred_name = ?");
    binds.push(credRef);
  }
  const { results } = await env.DB.prepare(
    `SELECT bg.id, bg.principal_id, p.login_email, bg.cred_name, bg.verb,
            bg.created_by, bg.created_at, bg.expires_at, bg.revoked_at
     FROM bureau_grants bg JOIN principals p ON p.id = bg.principal_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY bg.created_at`,
  )
    .bind(...binds)
    .all();
  return json({ bureauGrants: results });
}

/**
 * Revoke = TOMBSTONE, matching `grants.revoked_at` (s03.A T2) rather than the
 * hard DELETE `008` left behind. The capability stops resolving on the very next
 * Bureau call — `resolveBureauGrant` filters `revoked_at IS NULL` — while the row
 * and its `grant_lifecycle` history survive, so "what could this agent sign with
 * last Tuesday?" stays answerable. Idempotent: revoking an already-revoked grant
 * changes nothing and logs nothing.
 *
 * What it does NOT touch: the credential, and every other grant on it.
 */
async function revokeBureauGrant(id: string, env: Env) {
  const now = Date.now();
  const res = await env.DB.prepare(`UPDATE bureau_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now, id)
    .run();
  const revoked = (res.meta.changes ?? 0) > 0;
  if (revoked) {
    await logGrantLifecycle(env, id, "revoked", now);
  }
  return json({ revoked });
}

/** Tombstoned accounts are not grantable, bindable or resolvable — the whole
 * point of the tombstone is that the account stops being a live target. */
async function accountWithTenant(env: Env, email: string) {
  return env.DB.prepare(
    `SELECT a.id, a.tenant_id FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE i.email = ? AND a.deleted_at IS NULL LIMIT 1`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string; tenant_id: string }>();
}

// ---- agent bindings ----------------------------------------------------

/**
 * Address → account, for paths that are about to ACT on it: bind an agent,
 * write a grant, flip a kill switch. Tombstoned accounts are excluded, because
 * the whole point of the tombstone is that the account stops being a live
 * target.
 *
 * Admin *reads* deliberately do not use this — see `accountByAddressAny`.
 */
async function accountByAddress(env: Env, email: string) {
  return env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE i.email = ? AND a.deleted_at IS NULL LIMIT 1`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string }>();
}

/**
 * The same lookup, tombstones included, for the read-only `?email=` filters on
 * `GET /grants` and `GET /agent-bindings`.
 *
 * The filter belongs on resolution and write paths, not on operator reads: a
 * soft delete whose whole justification is *"history survives"* must not make
 * "what could this account reach?" unanswerable the moment you delete it. Both
 * routes are admin-gated and return rows that still exist in D1 either way —
 * hiding them by address would only mean the operator has to go to the D1
 * console to see rows the API is already willing to dump unfiltered.
 */
async function accountByAddressAny(env: Env, email: string) {
  return env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE i.email = ? LIMIT 1`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string }>();
}

// ---- the supervisory grant (s10 T7) ------------------------------------
//
// THE BUG THIS EXISTS FOR, observed live on the first end-to-end run:
// EditorEmily produced a real `pending` reply-draft proposal and `/approvals`
// told Eric "Nothing is waiting on you." Every layer was individually correct.
// Agents are separate PRINCIPALS by design (agent mailboxes, pattern B), the
// invocation ran on Emily's binding, the proposal was written to the account
// owning that binding, and the queue refused to show another principal's data.
// The composition is what failed: the queue is human-scoped by intent and
// account-scoped by implementation.
//
// Provisioning is one of the two halves. Creating an agent must, by default,
// let its owner SEE what it proposes — and the grant is the right model rather
// than a special case: supervising an agent is a capability, visible in
// `GET /grants`, audited in `grant_audit`, and revocable like any other. The
// other half is the multi-account queue (webmail + cli-go).

/**
 * The scope set a supervisory grant carries, and the whole of it.
 *
 * Read the two methods it must satisfy rather than reaching for a bundle:
 *   `ActionProposal/get` + `/query` + `/changes` gate on `read`;
 *   `ActionProposal/set` — approve, decline, needsInfo, the due-date
 *   correction — gates on `draft`;
 *   a tier-3 approve additionally runs the CAPABILITY WALL, which demands
 *   `send` on the proposal's account (actionProposal.ts).
 *
 * ⚠️ `send` IS NOT IN THIS SET, and the reason is worth reading before adding
 * it back. An earlier version carried it, justified by "a `reply-draft` is
 * tier 3 — precisely the kind that produced this bug". That premise is FALSE:
 * `reply-draft` is emitted at tier 2 (`services/agent/src/proposals.ts`), so
 * `if (row.tier === 3)` never fires for it and the wall is never reached. A
 * tier-2 approve parks in the hold tray and is committed later, server-side,
 * by the cron — not under the approver's token. So `draft` is sufficient, and
 * `send` was a real widening bought with a wrong belief: it hands the
 * supervising human the authority to send mail AS the agent, which supervision
 * does not need.
 *
 * If a tier-3 KIND ever ships, this set needs `send` again — and the failure
 * mode until then is loud and correct: the approver gets an explicit
 * "requires the send capability" refusal naming the missing scope, rather than
 * silently holding an authority nobody audited.
 *
 * And NOT `mail`, deliberately, though it is one word shorter. That bundle
 * also carries `annotate`, `move` and `delete`, so the operator would silently
 * gain the authority to reorganise and DELETE the agent's mailbox. Supervision
 * is not custody. No realm scope either (`contacts`/`calendar`/`files`/
 * `vault`): deciding proposals is no business of the agent's address book, and
 * none of it in the credential store.
 *
 * Whole-account (`collection: NULL`) because the grant vocabulary has no
 * mail-domain collection — `AddressBook`/`Calendar` scoping unlocks the
 * contacts/calendar domains only (`grantCoversDomain`, principal.ts), so a
 * collection-scoped grant could not carry the mail-domain queue at all.
 */
// `annotate` joined 2026-08-18 (Eric): marking an agent's mail read/flagged
// WHILE reviewing it is supervision, not custody — keyword flips are
// reversible and touch no mailbox structure. move/delete stay out: those
// reorganise and destroy, which supervision is not.
export const SUPERVISORY_GRANT_SCOPES = ["read", "annotate", "draft"] as const;

/** What a provisioning response says about supervision — always present, so a
 *  caller can never mistake "we did not try" for "there is nothing to see". */
interface Supervision {
  granted: boolean;
  grantId?: string;
  /** False when a live grant already covered it — the idempotency signal. */
  created?: boolean;
  scopes?: string[];
  owner?: { email: string; accountId: string };
  /** Present iff `granted` is false: why, in a sentence an operator can act on. */
  reason?: string;
}

/**
 * Mint (or adopt) the supervisory grant. IDEMPOTENT: a live grant covering
 * this grantee/target tuple is REPORTED, never duplicated and never widened —
 * re-running provisioning is a supported operation (it is how the three
 * pre-T7 bindings are backfilled), and an operator who deliberately narrowed a
 * supervisory grant must not have it silently restored by a re-run.
 *
 * Note it does not go through `createGrant`: that route answers a conflict
 * with 409 + a hint to revoke, which is right for an operator typing a NEW
 * grant and wrong for an idempotent provisioning step.
 */
async function ensureSupervisoryGrant(
  env: Env,
  args: { tenantId: string; ownerAccountId: string; agentAccountId: string; ownerEmail: string },
): Promise<Supervision> {
  const { tenantId, ownerAccountId, agentAccountId, ownerEmail } = args;
  const owner = { email: ownerEmail, accountId: ownerAccountId };

  // A live grant already covering the pair — including one an operator wrote
  // by hand with different scopes. Reported as-is; see above.
  const existing = await env.DB.prepare(
    `SELECT id, scopes FROM grants
      WHERE grantee_account_id = ? AND target_account_id = ?
        AND collection IS NULL AND revoked_at IS NULL`,
  )
    .bind(ownerAccountId, agentAccountId)
    .first<{ id: string; scopes: string }>();
  if (existing) {
    return {
      granted: true,
      grantId: existing.id,
      created: false,
      scopes: safeScopes(existing.scopes),
      owner,
    };
  }

  const id = `g_${crypto.randomUUID()}`;
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO grants (id, tenant_id, grantee_account_id, target_account_id, scopes,
       collection, collection_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'provision:supervisory', ?, NULL)
     ON CONFLICT DO NOTHING`,
  )
    .bind(id, tenantId, ownerAccountId, agentAccountId, JSON.stringify(SUPERVISORY_GRANT_SCOPES), now)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    // Lost a race with a concurrent provisioning run — the other row is the
    // live one. Re-read rather than claim an id nothing carries (the lesson
    // `createGrant`'s conflict branch already learned).
    const raced = await env.DB.prepare(
      `SELECT id, scopes FROM grants
        WHERE grantee_account_id = ? AND target_account_id = ?
          AND collection IS NULL AND revoked_at IS NULL`,
    )
      .bind(ownerAccountId, agentAccountId)
      .first<{ id: string; scopes: string }>();
    return raced
      ? {
          granted: true,
          grantId: raced.id,
          created: false,
          scopes: safeScopes(raced.scopes),
          owner,
        }
      : { granted: false, reason: "the supervisory grant could not be written (conflicting row)" };
  }
  await logGrantLifecycle(env, id, "created", now);
  return {
    granted: true,
    grantId: id,
    created: true,
    scopes: [...SUPERVISORY_GRANT_SCOPES],
    owner,
  };
}

function safeScopes(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** The account a principal is supervised THROUGH: grant resolution hangs off
 *  the grantee's OWNED accounts (`reachableAccounts`), so the grantee must be a
 *  real account, not a bare login. Prefer the one carrying the login address;
 *  else the oldest. */
async function principalSupervisorAccount(
  env: Env,
  loginEmail: string,
): Promise<{ id: string; tenant_id: string } | null> {
  const byAddress = await accountWithTenant(env, loginEmail);
  if (byAddress) return byAddress;
  return env.DB.prepare(
    `SELECT a.id, a.tenant_id FROM accounts a JOIN principals p ON p.id = a.principal_id
      WHERE p.login_email = ? AND a.deleted_at IS NULL
      ORDER BY a.created_at LIMIT 1`,
  )
    .bind(loginEmail.toLowerCase())
    .first<{ id: string; tenant_id: string }>();
}

/**
 * WHO owns this agent — and a refusal when that cannot be established.
 *
 * Ownership is not a column anywhere: an agent account mints its own principal
 * at create (`POST /accounts` with no `principalEmail`), so nothing in the
 * schema records the human behind it. Two ways to answer, in order:
 *
 *  1. `ownerEmail` on the request — explicit, and it always wins.
 *  2. The tenant's HUMAN principals, structurally: every principal of the
 *     tenant none of whose accounts carries an agent binding (the same test
 *     `provisionBouncer` already uses to find the household), minus the agent's
 *     own principal. EXACTLY ONE ⇒ that is the owner; zero or several ⇒
 *     ambiguous, and we refuse rather than guess. Inventing a supervisor is how
 *     one household's agent ends up visible to the wrong human.
 */
async function resolveAgentOwner(
  env: Env,
  agentAccountId: string,
  explicitEmail?: string,
): Promise<
  { ok: true; accountId: string; email: string; tenantId: string } | { ok: false; reason: string; self?: true }
> {
  const agent = await env.DB.prepare(
    `SELECT a.tenant_id, a.principal_id, p.login_email
       FROM accounts a JOIN principals p ON p.id = a.principal_id WHERE a.id = ?`,
  )
    .bind(agentAccountId)
    .first<{ tenant_id: string; principal_id: string; login_email: string }>();
  if (!agent) return { ok: false, reason: `account ${agentAccountId} not found` };

  if (explicitEmail) {
    const owner = await accountWithTenant(env, explicitEmail);
    if (!owner) return { ok: false, reason: `no account for ${explicitEmail}` };
    if (owner.id === agentAccountId) {
      return {
        ok: false,
        self: true,
        reason:
          "the binding sits on its owner's own account — its proposals already land in that " +
          "account's queue, so there is nothing to grant",
      };
    }
    if (owner.tenant_id !== agent.tenant_id) {
      return {
        ok: false,
        reason: `${explicitEmail} is in a different tenant — cross-tenant grants are not supported`,
      };
    }
    return {
      ok: true,
      accountId: owner.id,
      email: explicitEmail.toLowerCase(),
      tenantId: agent.tenant_id,
    };
  }

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT p.login_email FROM principals p
      WHERE p.tenant_id = ?1 AND p.id != ?2
        AND NOT EXISTS (
          SELECT 1 FROM accounts a
          JOIN agent_bindings b ON b.account_id = a.id
          WHERE a.principal_id = p.id)
      ORDER BY p.login_email`,
  )
    .bind(agent.tenant_id, agent.principal_id)
    .all<{ login_email: string }>();
  const humans = results.map((r) => r.login_email);
  if (humans.length !== 1) {
    return {
      ok: false,
      reason:
        humans.length === 0
          ? // Two shapes land here and the schema cannot tell them apart, so
            // the sentence says both rather than picking one: an agent bound
            // to its OWNER's own account needs no grant (its proposals are
            // already in that account's queue), and an agent-only tenant needs
            // a human named. Claiming either would be a guess.
            `tenant ${agent.tenant_id} has no other human principal to supervise this agent. ` +
            "If the binding sits on its owner's own account, its proposals already land in that " +
            "account's queue and there is nothing to grant; otherwise name the owner with " +
            '{"ownerEmail": "..."}'
          : `tenant ${agent.tenant_id} has ${humans.length} human principals (${humans.join(", ")}), ` +
            'so ownership is ambiguous — name one with {"ownerEmail": "..."}',
    };
  }
  const ownerEmail = humans[0] as string;
  const owner = await principalSupervisorAccount(env, ownerEmail);
  if (!owner) {
    return { ok: false, reason: `${ownerEmail} owns no live account to hold the grant` };
  }
  if (owner.id === agentAccountId) {
    return {
      ok: false,
      self: true,
      reason:
        "the binding sits on its owner's own account — its proposals already land in that " +
        "account's queue, so there is nothing to grant",
    };
  }
  return { ok: true, accountId: owner.id, email: ownerEmail, tenantId: agent.tenant_id };
}

/**
 * `POST /agent-bindings/{id}/supervisor` — the BACKFILL, and the one honest way
 * to fix an agent that predates T7.
 *
 * Deliberately not a migration. A migration would have to decide who owns
 * `editor@` from the schema alone, and the schema does not know: it would be
 * inventing an authorization record, which is the one thing a grant may never
 * be. This route makes an operator name the owner (or accepts the structural
 * answer when the tenant has exactly one human), refuses when it cannot tell,
 * and is idempotent so it can be run over every binding without thought.
 */
async function superviseBinding(id: string, body: { ownerEmail?: string }, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;

  const owner = await resolveAgentOwner(env, binding.account_id, body.ownerEmail);
  if (!owner.ok) {
    // A refusal, said out loud — the alternative is a route that silently does
    // nothing and reports 200, which is how the original bug felt.
    return json(
      {
        error: owner.reason,
        bindingId: binding.id,
        accountId: binding.account_id,
        ...(owner.self ? { supervision: { granted: false, reason: owner.reason } } : {}),
      },
      owner.self ? 200 : 422,
    );
  }
  const supervision = await ensureSupervisoryGrant(env, {
    tenantId: owner.tenantId,
    ownerAccountId: owner.accountId,
    agentAccountId: binding.account_id,
    ownerEmail: owner.email,
  });
  return json({
    ok: supervision.granted,
    bindingId: binding.id,
    name: binding.name,
    accountId: binding.account_id,
    supervision,
  });
}

async function createAgentBinding(
  body: {
    email: string;
    name: string;
    slaSeconds?: number;
    config?: Record<string, unknown>;
    /** s10 T1 — the governing book (typed column, not config_json): the
     *  binding's outbound allowlist. Omitted ⇒ NULL ⇒ the binding cannot
     *  send (fail-closed) until an operator seeds one. */
    recipientsBookId?: string;
    /** s10 T7 — the human who will supervise this agent. Omitted ⇒ derived
     *  when the tenant has exactly one human principal, refused (reported, not
     *  thrown) when ownership is ambiguous. */
    ownerEmail?: string;
    /** s10 T7, internal — `provisionBouncer` supervises the whole household
     *  itself (bouncer@ has no single owner), so it opts this step out rather
     *  than letting two writers report on the same grant. */
    skipSupervision?: boolean;
  },
  env: Env,
) {
  if (!body.email || !body.name) return json({ error: "email and name required" }, 400);
  const account = await accountByAddress(env, body.email);
  if (!account) return json({ error: `no account for ${body.email}` }, 404);

  // WHO owns it is resolved BEFORE the insert. The structural owner test is "a
  // principal none of whose accounts carries a binding", and this call is about
  // to give the agent's account one — asking afterwards would work for a fresh
  // agent account and silently mis-answer for a second binding on an existing
  // one. The grant itself is minted after the binding lands, so a failed create
  // cannot leave a grant to an agent that does not exist.
  const owner = body.skipSupervision
    ? ({ ok: false, reason: "supervised at the household level" } as const)
    : await resolveAgentOwner(env, account.id, body.ownerEmail);

  const id = `bind_${crypto.randomUUID().slice(0, 8)}`;
  // s26 T3 — the binding's BIRTH rides in the blob (`agent_bindings` has no
  // created_at column, and adding one is a hand-run migration this repo
  // rations). It is the backfill verb's DEFAULT HISTORY FLOOR: a new agent is
  // bounded to current + future work, and only an approved `floor-request`
  // (config_json.historyFloor) reaches behind it. A caller-supplied createdAt
  // wins so a deliberate fixture can say otherwise.
  await env.DB.prepare(
    `INSERT INTO agent_bindings
       (id, account_id, name, trigger_on, sla_seconds, enabled, config_json, recipients_book_id)
     VALUES (?, ?, ?, 'mailbox-delivery', ?, 1, ?, ?)`,
  )
    .bind(
      id,
      account.id,
      body.name,
      body.slaSeconds ?? null,
      JSON.stringify({ createdAt: Date.now(), ...(body.config ?? {}) }),
      body.recipientsBookId ?? null,
    )
    .run();

  // SLA set → a watchdog responder backs this binding: fires unless the
  // invocation is claimed in time (agent-integration.md §8 ladder rung 1).
  if (body.slaSeconds) {
    await env.DB.prepare(
      `INSERT INTO responders (id, account_id, kind, enabled, wait_seconds, cancel_if,
         subject, text_body, suppress_seconds)
       VALUES (?, ?, 'watchdog', 1, ?, 'invocation-active', ?, ?, 3600)
       ON CONFLICT (account_id, id) DO UPDATE SET
         enabled = 1, wait_seconds = excluded.wait_seconds`,
    )
      .bind(
        `watchdog_${id}`,
        account.id,
        body.slaSeconds,
        `Auto: delayed response from ${body.email}`,
        `This mailbox is handled by an automated agent ("${body.name}") that appears to be temporarily unavailable. Your message is queued and will be answered when it recovers.`,
      )
      .run();
  }
  const supervision: Supervision = owner.ok
    ? await ensureSupervisoryGrant(env, {
        tenantId: owner.tenantId,
        ownerAccountId: owner.accountId,
        agentAccountId: account.id,
        ownerEmail: owner.email,
      })
    : { granted: false, reason: owner.reason };

  return json({
    ok: true,
    bindingId: id,
    accountId: account.id,
    watchdog: !!body.slaSeconds,
    // Always reported, granted or not: "every new agent is born invisible" was
    // the T7 bug, and a silent field is how it stayed invisible. A false here
    // carries the sentence and the fix (POST /agent-bindings/{id}/supervisor).
    supervision,
  });
}

/**
 * s12 2-D — one call mints bouncer@'s conversational surface for a tenant:
 *
 *   1. the agent ACCOUNT `bouncer@<domain>` (reuses POST /accounts —
 *      idempotent, so a retried call adopts rather than duplicates);
 *   2. its GOVERNING BOOK (`write_policy: 'governed'`) seeded with the
 *      tenant's human principals — the binding's reply-only reach, because
 *      every bouncer egress targets exactly the directive's sender and the
 *      s10 outbound bound resolves recipients against this book;
 *   3. the BINDING itself (name 'bouncer', mailbox-delivery trigger,
 *      `pipeline: 'bouncer'`, `replyMode: 'send'`), with `allowedSenders` =
 *      the same principals — the inbound gate's mirror of the book.
 *
 * "Human principals" is structural: every principal of the tenant none of
 * whose accounts carries an agent binding. Agent accounts (analyst@, emily@,
 * bouncer@ itself) mint a principal per address at create, and each of those
 * accounts has a binding — so binding-less principals are the humans. The
 * list is FROZEN at provision time; adding a household member later means
 * re-running this call (idempotent) or editing the book + config by hand.
 *
 * Fail-closed: a tenant with NO human principals gets refused — a bouncer
 * with an empty allowedSenders list would gate nobody (the empty allowlist
 * means "no gate" in services/agent), which is the one config this endpoint
 * must never write.
 *
 * Explicitly NOT called from any other path: existing tenants are never
 * auto-provisioned.
 */
async function provisionBouncer(body: { tenantId: string; domain: string; localpart?: string }, env: Env) {
  const { tenantId, domain } = body;
  if (!tenantId || !domain) return json({ error: "tenantId and domain required" }, 400);
  const localpart = (body.localpart ?? "bouncer").toLowerCase();
  const address = `${localpart}@${domain}`;
  const now = Date.now();

  // The humans, BEFORE any write: refusing an empty house must leave nothing.
  const { results: principalRows } = await env.DB.prepare(
    `SELECT DISTINCT p.login_email FROM principals p
     WHERE p.tenant_id = ?1 AND p.login_email != ?2
       AND NOT EXISTS (
         SELECT 1 FROM accounts a
         JOIN agent_bindings b ON b.account_id = a.id
         WHERE a.principal_id = p.id)
     ORDER BY p.login_email`,
  )
    .bind(tenantId, address)
    .all<{ login_email: string }>();
  const humans = principalRows.map((r) => r.login_email.toLowerCase());
  if (humans.length === 0) {
    return json(
      {
        error:
          `tenant ${tenantId} has no human principals — provision the household first; ` +
          "a bouncer with an empty allowedSenders list would gate nobody",
      },
      422,
    );
  }

  // 1 — the account (idempotent through createAccount's adopt path).
  const accountRes = await createAccount({ tenantId, domain, localpart, displayName: "Bouncer" }, env);
  const account = (await accountRes.json()) as { ok?: boolean; accountId?: string; error?: string };
  if (!account.ok || !account.accountId) {
    return json({ error: `bouncer account: ${account.error ?? `HTTP ${accountRes.status}`}` }, 422);
  }
  const accountId = account.accountId;

  // Idempotency for the rest: an existing 'bouncer' binding on the account
  // means a previous run finished — report it, write nothing.
  //
  // Except the supervisory grants (s10 T7), which are re-checked on EVERY run.
  // That is deliberate and it is the documented backfill path for bouncer@: a
  // bouncer provisioned before T7 has no grant back to the household, so
  // re-running this call is what makes its held-mail questions reachable. The
  // step is idempotent in its own right (a live grant is adopted, never
  // duplicated), so a re-run on an already-supervised bouncer writes nothing.
  const existing = await env.DB.prepare(`SELECT id FROM agent_bindings WHERE account_id = ? AND name = 'bouncer'`)
    .bind(accountId)
    .first<{ id: string }>();
  if (existing) {
    return json({
      ok: true,
      created: false,
      accountId,
      address,
      bindingId: existing.id,
      supervision: await superviseHousehold(env, tenantId, accountId, humans),
    });
  }

  // 2 — the governing book + members + membership chain, one atomic batch.
  // Direct SQL (the provisioning precedent — this worker seeds mailboxes the
  // same way and binds no R2, which Mailstore requires); the chain rows ride
  // the same batch so the s10 fold-reconciliation invariant holds from row one.
  const bookId = `ab_${crypto.randomUUID()}`;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO address_books
           (id, account_id, name, description, sort_order, is_default, is_subscribed,
            ctag, created_at, updated_at, write_policy)
         VALUES (?, ?, 'Bouncer may reply', 'The household principals bouncer@ answers to — its reply-only outbound bound.',
                 0, 0, 1, 0, ?, ?, 'governed')`,
    ).bind(bookId, accountId, now, now),
  ];
  for (const human of humans) {
    const uid = `bouncer-reach-${crypto.randomUUID()}`;
    const cardId = `cc_${crypto.randomUUID().slice(0, 8)}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO contact_cards
             (id, account_id, address_book_id, uid, card_json, name_full, dav_name,
              created_at, updated_at, last_writer_principal)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'provision')`,
      ).bind(
        cardId,
        accountId,
        bookId,
        uid,
        JSON.stringify({ uid, kind: "individual", emails: { e0: { address: human } } }),
        human,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO book_membership_log
             (account_id, book_id, event, address, card_id, uid, actor, via_proposal_id, at)
           VALUES (?, ?, 'added', ?, ?, ?, 'provision', NULL, ?)`,
      ).bind(accountId, bookId, human, cardId, uid, now),
    );
  }
  await env.DB.batch(stmts);

  // 3 — the binding, through the same path POST /agent-bindings takes.
  // `ownerEmail` is deliberately NOT passed: bouncer has no single owner, so
  // the household gets supervision below (createAgentBinding's derivation will
  // report ambiguity for any tenant with more than one human, which is the
  // right answer for a per-owner grant and the wrong shape for this agent).
  const bindingRes = await createAgentBinding(
    {
      email: address,
      name: "bouncer",
      config: { pipeline: "bouncer", replyMode: "send", allowedSenders: humans },
      recipientsBookId: bookId,
      skipSupervision: true,
    },
    env,
  );
  const binding = (await bindingRes.json()) as { ok?: boolean; bindingId?: string; error?: string };
  if (!binding.ok) return json({ error: `bouncer binding: ${binding.error ?? "failed"}` }, 422);

  return json({
    ok: true,
    created: true,
    accountId,
    address,
    bindingId: binding.bindingId,
    recipientsBookId: bookId,
    allowedSenders: humans,
    supervision: await superviseHousehold(env, tenantId, accountId, humans),
  });
}

/**
 * remind@'s account + reply-only binding for ONE tenant domain (s20 wave 2 —
 * the mail-native Watches door, services/agent/src/remind.ts). Structurally a
 * slimmer bouncer:
 *
 *   - SAME safety bounds — `allowedSenders` = the household's human principals
 *     (a stranger is skipped silently by the agent gate), and a governing book
 *     of those same humans bounds the ONE thing remind@ sends: a confirmation
 *     back to whoever asked.
 *   - NO persona and NO model menu — the remind pipeline is deterministic; it
 *     parses a deadline and arms a Watch, spending no tokens.
 *   - NO supervisory grants (the one real divergence). bouncer@ needs them
 *     because its held-mail questions are proposals on bouncer's OWN account;
 *     remind@ writes each Watch to the ASKER's account, so a fired reminder
 *     already lands in that human's own queue. There is nothing on remind@'s
 *     account for a human to supervise.
 *
 * Explicit per-tenant call; nothing is auto-provisioned for existing tenants.
 */
async function provisionRemind(body: { tenantId: string; domain: string; localpart?: string }, env: Env) {
  const { tenantId, domain } = body;
  if (!tenantId || !domain) return json({ error: "tenantId and domain required" }, 400);
  const localpart = (body.localpart ?? "remind").toLowerCase();
  const address = `${localpart}@${domain}`;
  const now = Date.now();

  // The humans, BEFORE any write (bouncer's precedent): an empty house leaves
  // nothing behind, and a remind@ whose allowedSenders/book are empty could
  // neither be used nor reply to anyone.
  const { results: principalRows } = await env.DB.prepare(
    `SELECT DISTINCT p.login_email FROM principals p
     WHERE p.tenant_id = ?1 AND p.login_email != ?2
       AND NOT EXISTS (
         SELECT 1 FROM accounts a
         JOIN agent_bindings b ON b.account_id = a.id
         WHERE a.principal_id = p.id)
     ORDER BY p.login_email`,
  )
    .bind(tenantId, address)
    .all<{ login_email: string }>();
  const humans = principalRows.map((r) => r.login_email.toLowerCase());
  if (humans.length === 0) {
    return json(
      {
        error:
          `tenant ${tenantId} has no human principals — provision the household first; ` +
          "a remind@ with an empty allowedSenders list could remind nobody",
      },
      422,
    );
  }

  // 1 — the account (idempotent through createAccount's adopt path).
  const accountRes = await createAccount({ tenantId, domain, localpart, displayName: "Remind" }, env);
  const account = (await accountRes.json()) as { ok?: boolean; accountId?: string; error?: string };
  if (!account.ok || !account.accountId) {
    return json({ error: `remind account: ${account.error ?? `HTTP ${accountRes.status}`}` }, 422);
  }
  const accountId = account.accountId;

  // Idempotency: an existing 'remind' binding means a previous run finished.
  const existing = await env.DB.prepare(`SELECT id FROM agent_bindings WHERE account_id = ? AND name = 'remind'`)
    .bind(accountId)
    .first<{ id: string }>();
  if (existing) {
    return json({ ok: true, created: false, accountId, address, bindingId: existing.id });
  }

  // 2 — the governing book + members (bouncer's atomic-batch precedent): the
  // household humans remind@ may confirm back to, and nobody else.
  const bookId = `ab_${crypto.randomUUID()}`;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO address_books
           (id, account_id, name, description, sort_order, is_default, is_subscribed,
            ctag, created_at, updated_at, write_policy)
         VALUES (?, ?, 'Remind may reply', 'The household principals remind@ confirms reminders to — its reply-only outbound bound.',
                 0, 0, 1, 0, ?, ?, 'governed')`,
    ).bind(bookId, accountId, now, now),
  ];
  for (const human of humans) {
    const uid = `remind-reach-${crypto.randomUUID()}`;
    const cardId = `cc_${crypto.randomUUID().slice(0, 8)}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO contact_cards
             (id, account_id, address_book_id, uid, card_json, name_full, dav_name,
              created_at, updated_at, last_writer_principal)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'provision')`,
      ).bind(
        cardId,
        accountId,
        bookId,
        uid,
        JSON.stringify({ uid, kind: "individual", emails: { e0: { address: human } } }),
        human,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO book_membership_log
             (account_id, book_id, event, address, card_id, uid, actor, via_proposal_id, at)
           VALUES (?, ?, 'added', ?, ?, ?, 'provision', NULL, ?)`,
      ).bind(accountId, bookId, human, cardId, uid, now),
    );
  }
  await env.DB.batch(stmts);

  // 3 — the binding. skipSupervision: remind@ owns no proposals of its own, so
  // there is nothing to supervise (see the header note); passing an ownerEmail
  // would mint a grant to an agent account that never emits a question.
  const bindingRes = await createAgentBinding(
    {
      email: address,
      name: "remind",
      config: { pipeline: "remind", replyMode: "send", allowedSenders: humans },
      recipientsBookId: bookId,
      skipSupervision: true,
    },
    env,
  );
  const binding = (await bindingRes.json()) as { ok?: boolean; bindingId?: string; error?: string };
  if (!binding.ok) return json({ error: `remind binding: ${binding.error ?? "failed"}` }, 422);

  return json({
    ok: true,
    created: true,
    accountId,
    address,
    bindingId: binding.bindingId,
    recipientsBookId: bookId,
    allowedSenders: humans,
  });
}

/**
 * Turn the extraction pass (s18 A2) on for ONE human account. Unlike bouncer@ /
 * remind@ this is NOT a new agent account — the binding lives on the account's
 * OWN mailbox, because the extractor reads what is delivered TO you and writes
 * Annotations back to you. It sends nothing, so there is no governing book, no
 * allowedSenders, and no supervisory grant.
 *
 * `model`/`provider` default to the OpenRouter MiniMax route (the paid model
 * Eric chose); pass others to shop around. Re-running is the SWAP path: it
 * UPDATEs the existing binding's model menu in place (config_json is otherwise
 * read-only on the API — a re-provision is how you change it), so
 * `POST /extractor {email, model:"qwen/..."}` is a one-liner model change.
 *
 * This is the spend decision, made explicitly and per-account: nothing here
 * runs until mail is delivered to `email`, and it can be turned off instantly
 * with `POST /agent-bindings/{id}/disable`.
 */
async function provisionExtractor(
  body: {
    email: string;
    model?: string;
    provider?: string;
    maxTokens?: number;
    budgetMicros?: number;
    /** s26 T5a — extra menu candidates the frontier explores over. */
    exploreModels?: Array<{ provider: string; model: string }>;
    exploreRate?: number;
  },
  env: Env,
) {
  const email = String(body.email ?? "").toLowerCase();
  if (!email) return json({ error: "email required" }, 400);
  const provider = typeof body.provider === "string" ? body.provider : "openrouter";
  const model = typeof body.model === "string" ? body.model : "minimax/minimax-m3";
  // A paid pipeline never ships uncapped: the s11 budget gate reads
  // $.budgets.spendPerMonth (µUSD), the drain refuses claims past it, pending
  // rows wait as the durable cursor, and proposeBudgetOverruns raises the ask
  // in approvals. Default $2/month; pass budgetMicros to change, 0 to refuse
  // all paid claims (the hard floor).
  const budget = Number.isFinite(Number(body.budgetMicros)) ? Number(body.budgetMicros) : 2_000_000;
  const arms = Array.isArray(body.exploreModels)
    ? body.exploreModels.filter((m) => typeof m?.provider === "string" && typeof m?.model === "string")
    : [];
  const config: Record<string, unknown> = {
    pipeline: "extract",
    modelAliases: { extract: [{ provider, model }, ...arms] },
    defaultModel: "extract",
    ...(arms.length > 0
      ? { frontier: { exploreRate: Number.isFinite(Number(body.exploreRate)) ? Number(body.exploreRate) : 0.2 } }
      : {}),
    budgets: { spendPerMonth: budget },
    ...(Number.isFinite(Number(body.maxTokens)) ? { maxTokens: Number(body.maxTokens) } : {}),
  };

  const account = await accountByAddress(env, email);
  if (!account) return json({ error: `no live account for ${email}` }, 404);

  // Re-provision UPDATES the model menu in place — the swap path (Llama → Qwen
  // → minimax). config_json is read-only on PATCH by design, so this is where
  // a shape change legitimately happens.
  const existing = await env.DB.prepare(
    `SELECT id, config_json FROM agent_bindings WHERE account_id = ? AND name = 'extractor'`,
  )
    .bind(account.id)
    .first<{ id: string; config_json: string }>();
  if (existing) {
    // s26 T3 — the swap replaces the MENU, never the binding's history state:
    // `createdAt` (its birth, the default floor) and `historyFloor` (an
    // APPROVED widening — a human decided it) survive the rewrite. Losing the
    // floor on a model swap would silently re-run an approval.
    const prior = safeConfig(existing.config_json);
    if (typeof prior.createdAt === "number" && Number.isFinite(prior.createdAt)) config.createdAt = prior.createdAt;
    if (typeof prior.historyFloor === "number" && Number.isFinite(prior.historyFloor)) {
      config.historyFloor = prior.historyFloor;
    }
    await env.DB.prepare(`UPDATE agent_bindings SET config_json = ?, enabled = 1 WHERE id = ?`)
      .bind(JSON.stringify(config), existing.id)
      .run();
    return json({
      ok: true,
      created: false,
      updated: true,
      accountId: account.id,
      bindingId: existing.id,
      model: `${provider}/${model}`,
    });
  }

  // A binding on the human's own account, reply-less. skipSupervision: nothing
  // to supervise — the annotations land on this same account, which the human
  // already sees; no cross-account grant is involved.
  const bindingRes = await createAgentBinding({ email, name: "extractor", config, skipSupervision: true }, env);
  const binding = (await bindingRes.json()) as { ok?: boolean; bindingId?: string; error?: string };
  if (!binding.ok) return json({ error: `extractor binding: ${binding.error ?? "failed"}` }, 422);

  return json({
    ok: true,
    created: true,
    accountId: account.id,
    bindingId: binding.bindingId,
    model: `${provider}/${model}`,
  });
}

// ---- BYOK: the tenant's own provider key (s26 T4) -----------------------

/**
 * `POST /provider-keys` — bring your own key.
 *
 * Eric, on discovering his own OpenRouter privacy redaction had rewritten an
 * address to `[ADDRESS]`: *"we can let others turn on their OR guardrails etc
 * via their own keys?"* Yes — and the striking part is how little there is to
 * build. **A tenant's provider-side policy is not something this platform
 * implements, mirrors or even reads. It applies because the request
 * authenticates as them.** Their guardrails, their redaction rules, their route
 * and model allowlists, their spend cap, their audit trail in their own
 * provider console. Nothing here interprets any of it, and nothing here can
 * drift from it. The whole feature is: use their key.
 *
 * What this door does, in the order that makes each step meaningful:
 *
 *   1. **seal** the key in the Bureau — the plaintext crosses the BUREAU
 *      binding once, on the way in, and there is no route anywhere that returns
 *      it. `byokProvision.test.ts` asserts that by trying every read surface;
 *   2. **grant** `(principal, credRef, fetch)` — because minting a credential
 *      authorizes nobody (bureau.md §5.1), and a sealed-but-ungranted key is a
 *      key that silently does nothing;
 *   3. **attach** the ref to the tenant's binding(s), which is what makes the
 *      Bureau's own check ("does this binding name this credential?") pass.
 *
 * Re-running SWAPS in place, exactly as `POST /extractor` does for the model
 * menu: same `credRef`, new ciphertext, same grant, same attachment. That is
 * the rotation path — the tenant rolls their key at the provider, re-posts it
 * here, and no agent config changes.
 *
 * The destination allowlist is the part that is easy to skip and must not be:
 * a key sealed with `--allow https://openrouter.ai` can be spent at OpenRouter
 * and NOWHERE else, whatever URL a compromised prompt talks an agent into
 * composing. A credential with no allowlist is refused at use time (invariant
 * 5), so this door always writes one.
 *
 * ⚠️ The `key` is write-only, here and everywhere downstream. It is never
 * echoed in the response, never logged, never put in an error message. Presence
 * is confirmed; the value is not.
 */
interface ProviderKeyBody {
  email?: string;
  /** The provider key itself. Write-only — in once, never back out. */
  key?: string;
  /** The HOST it authenticates at: `openrouter` (default) or `gateway`. */
  provider?: string;
  /** `vault_credentials.name`; defaults to the provider name. */
  credRef?: string;
  /** Destination binding (bureau.md §6). Defaults per provider; required for
   *  `gateway`, whose endpoint is deployment-specific. */
  allow?: string;
  /** Injection recipe; defaults to `Authorization: Bearer {}`. */
  header?: string;
  /** Attach to ONE named binding instead of every binding that routes to this
   *  provider. */
  bindingName?: string;
  /** Grant lifetime. NULL = no expiry, matching `POST /bureau-grants`. */
  expiresDays?: number;
}

async function provisionProviderKey(body: ProviderKeyBody, env: Env) {
  if (!env.BUREAU || !env.INTERNAL_TOKEN) {
    return json({ error: "BYOK not configured on this deployment (no BUREAU binding)" }, 501);
  }
  const email = String(body?.email ?? "").toLowerCase();
  if (!email) return json({ error: "email required" }, 400);
  if (typeof body?.key !== "string" || body.key.length === 0) {
    return json({ error: "key required" }, 400);
  }
  const provider = typeof body.provider === "string" ? body.provider : "openrouter";
  const providerSpec = BYOK_PROVIDERS[provider];
  if (!providerSpec) {
    return json({ error: `provider must be one of ${Object.keys(BYOK_PROVIDERS).join(", ")}` }, 400);
  }
  const credRef = typeof body.credRef === "string" && body.credRef ? body.credRef : provider;
  if (!isCredRef(credRef)) {
    return json({ error: "credRef must be alnum . _ - up to 64 chars" }, 400);
  }

  // The §5 contract, computed here rather than accepted from the caller: the
  // whole point of a destination binding is that it is not negotiable per call.
  const allow = normalizeAllow(body.allow ?? providerSpec.defaultAllow ?? "");
  if (!allow) {
    return json(
      {
        error:
          `allow must be an origin (https://host[:port]) or wildcard (*.host)` +
          `${providerSpec.defaultAllow ? "" : ` — required for provider "${provider}", which has no default endpoint`}`,
      },
      400,
    );
  }
  const header = normalizeHeaderRecipe(body.header ?? DEFAULT_HEADER_RECIPE);
  if (!header) {
    return json({ error: 'header must be "Header-Name: …{}…" (the {} is the value slot)' }, 400);
  }

  const account = await accountByAddress(env, email);
  if (!account) return json({ error: `no live account for ${email}` }, 404);
  const owner = await env.DB.prepare(
    `SELECT a.principal_id, p.login_email FROM accounts a
     JOIN principals p ON p.id = a.principal_id WHERE a.id = ?`,
  )
    .bind(account.id)
    .first<{ principal_id: string; login_email: string }>();
  if (!owner) return json({ error: `account ${account.id} has no principal` }, 404);

  const existed = await credentialExists(env.DB, owner.principal_id, credRef);

  // 1 — SEAL, 2 — GRANT, 3 — ATTACH. All three live in `byokProvision.ts`, so
  // this door and the session door (`services/jmap` ProviderCredential/set)
  // write the same rows by construction rather than by review. Fail closed on
  // the seal and write nothing else: a grant or an attachment pointing at a
  // credential that was never sealed is a config that looks live and is not.
  const sealed = await sealProviderKey(env, { principalId: owner.principal_id, credRef, allow, header }, body.key);
  if (!sealed.ok) return json({ error: sealed.error }, sealed.status);

  const grantId = await grantFetchOnCredential(env.DB, owner.principal_id, credRef, {
    actor: "admin",
    expiresDays: body.expiresDays,
  });
  const attached = await attachCredentialToBindings(env.DB, account.id, provider, credRef, {
    actor: "admin",
    bindingName: body.bindingName,
  });

  return json({
    ok: true,
    created: !existed,
    rotated: existed,
    accountId: account.id,
    principal: owner.login_email,
    provider,
    credRef,
    allow,
    header,
    grantId,
    bindings: attached,
    // Presence, never the value — and stated in the response so an operator can
    // see the guarantee rather than assume it.
    keyStored: true,
    keyReadable: false,
    ...(attached.length === 0
      ? {
          note:
            `sealed and granted, but NO binding on ${email} names it yet — ` +
            `no candidate routes to "${provider}". Re-run with {"bindingName": "…"} ` +
            `once the binding has a ${provider} route, or the key will never be used.`,
        }
      : {}),
  });
}

/**
 * bouncer@'s supervisory grants (s10 T7): one per HUMAN PRINCIPAL of the
 * household, not one owner.
 *
 * Every other agent has a single supervisor; bouncer does not, and pretending
 * otherwise would be the guess this slice refuses elsewhere. The list is not
 * invented: it is the same `humans` this function already computed and already
 * wrote into the governing book and `allowedSenders` — the people bouncer@
 * answers to. Its proposals are `held-mail-review` questions ("spam or not?"),
 * which any of them can answer, and the alternative — picking one — would put
 * the household's mail decisions behind whoever happened to sort first.
 */
async function superviseHousehold(
  env: Env,
  tenantId: string,
  agentAccountId: string,
  humans: string[],
): Promise<Supervision[]> {
  const out: Supervision[] = [];
  for (const email of humans) {
    const owner = await principalSupervisorAccount(env, email);
    if (!owner) {
      out.push({ granted: false, reason: `${email} owns no live account to hold the grant` });
      continue;
    }
    if (owner.id === agentAccountId || owner.tenant_id !== tenantId) continue;
    out.push(
      await ensureSupervisoryGrant(env, {
        tenantId,
        ownerAccountId: owner.id,
        agentAccountId,
        ownerEmail: email,
      }),
    );
  }
  return out;
}

async function listAgentBindings(url: URL, env: Env) {
  const email = url.searchParams.get("email");
  let accountId: string | null = null;
  if (email) {
    // Tombstones included: `deleteAccount` disables the bindings rather than
    // dropping them, precisely so this list stays honest. Filtering here would
    // answer "no bindings" where the truth is "bindings exist and are off".
    const account = await accountByAddressAny(env, email);
    if (!account) return json({ bindings: [] });
    accountId = account.id;
  }
  // `recipients_book_id` is projected because it IS the outbound bound (s10
  // T1): a read that omits it cannot answer "who may this agent email?", and a
  // config surface that cannot see the bound will render a blank where the
  // control is. Read-only and admin-gated — the book id names a collection, it
  // does not grant access to it, and the send path still resolves membership
  // server-side. Absent on a pre-s10 database, where SELECT simply yields no
  // such key and clients (cli-go `agents`) read that as UNREPORTED rather than
  // as "no book" — the two have opposite meanings.
  const { results } = await env.DB.prepare(
    `SELECT id, account_id, name, trigger_on, sla_seconds, enabled, config_json, recipients_book_id
     FROM agent_bindings
     ${accountId ? "WHERE account_id = ?" : ""}`,
  )
    .bind(...(accountId ? [accountId] : []))
    .all();
  return json({ bindings: results });
}

interface BindingRow {
  id: string;
  account_id: string;
  name: string;
  enabled: number;
  /**
   * The untyped remainder + the two typed-core keys whose promotion is
   * DEFERRED (s10 status block: only `recipients_book_id` became a column).
   * Projected here because `patchAgentBinding` read-modify-writes it and needs
   * the PRE-IMAGE both to preserve the remainder and as its compare-and-swap
   * predicate.
   */
  config_json: string;
  /** The outbound bound. NULL ⇒ this binding cannot send (fail-closed). */
  recipients_book_id: string | null;
  /** Its account's tombstone — NULL for a live account. */
  deleted_at: number | null;
}

/**
 * Address one binding.
 *
 * `agent_bindings` is `PRIMARY KEY (account_id, id)`, so an id alone is not
 * formally a key — but `agent bind` hands the operator a bare `bind_xxxxxxxx`
 * and the rest of this API speaks in email addresses, never account ids.
 * Requiring `t_home__a_3f2a1b9c` at 3am is exactly the friction the kill
 * switch exists to remove. So: bare id, resolved to its account, and an
 * explicit 409 in the (astronomically unlikely) case where one id sits on two
 * accounts. Silently picking a row would be the bug.
 */
async function resolveBinding(
  id: string,
  url: URL,
  env: Env,
): Promise<{ binding: BindingRow } | { response: Response }> {
  const email = url.searchParams.get("email");
  // `accountByAddressAny`, not the filtered lookup: a tombstoned account's
  // bindings must stay ADDRESSABLE, or `agent unbind --account <email>` — the
  // documented way to disambiguate an id — 404s exactly when you are cleaning
  // up. `deleted` rides along on the row so `enable` can refuse; the two
  // resolution branches must agree about what exists.
  if (email) {
    const account = await accountByAddressAny(env, email);
    if (!account) return { response: json({ error: `no account for ${email}` }, 404) };
    const row = await env.DB.prepare(
      `SELECT b.id, b.account_id, b.name, b.enabled, b.config_json, b.recipients_book_id, a.deleted_at
       FROM agent_bindings b JOIN accounts a ON a.id = b.account_id
       WHERE b.account_id = ? AND b.id = ?`,
    )
      .bind(account.id, id)
      .first<BindingRow>();
    return row ? { binding: row } : { response: json({ error: `no agent binding ${id} on ${email}` }, 404) };
  }

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.account_id, b.name, b.enabled, b.config_json, b.recipients_book_id, a.deleted_at
     FROM agent_bindings b JOIN accounts a ON a.id = b.account_id
     WHERE b.id = ?`,
  )
    .bind(id)
    .all<BindingRow>();
  if (results.length === 0) return { response: json({ error: `no agent binding ${id}` }, 404) };
  if (results.length > 1) {
    return {
      response: json(
        {
          error: `binding id ${id} exists on ${results.length} accounts — narrow it with ?email=<address>`,
          accounts: results.map((r) => r.account_id),
        },
        409,
      ),
    };
  }
  return { binding: results[0] as BindingRow };
}

/**
 * The agent kill switch (`.feedback/fromClaude/agentic/023`, P1).
 *
 * `agent_bindings.enabled` was written `1` at creation and never written
 * again: the column appeared in exactly two statements repo-wide, an INSERT
 * and a SELECT. Both drain paths already gate on it —
 * `services/ingest/src/index.ts` filters `enabled = 1` when it enqueues, and
 * `services/agent/src/index.ts` filters it again when it drains — so the off
 * switch was built, load-bearing on the read side, and unreachable. This is
 * the handle.
 *
 * ── The queue question, decided ──
 *
 * Disabling stops NEW invocations at enqueue. Rows already `pending` are then
 * neither run nor cleaned up, because the drain's `JOIN agent_bindings`
 * filters them out too. Leave them, or mark them cancelled?
 *
 * **They are left pending, and counted in the response.** Reasons, in order:
 *
 *  - Disable has a matching `enable`. It is a PAUSE, and a pause that destroys
 *    the queue is not reversible — you cannot un-cancel.
 *  - Those rows are the evidence of what the agent was about to do. An
 *    operator hitting the kill switch mid-incident is the last person who
 *    should have that deleted out from under them.
 *  - They are inert while disabled. Nothing drains them, nothing retries them,
 *    nothing bills for them.
 *
 * The real cost of leaving them is an INVISIBLE backlog — re-enable a week
 * later and a pile of stale invocations drains at once, replying to week-old
 * mail. That is answered by making it visible rather than by deleting data:
 * both verbs return `pendingInvocations`, the CLI prints it, and the drain
 * logs the held count on every wake-up. An operator who does want them gone
 * has the count in front of them and can clear them explicitly.
 */
async function setBindingEnabled(id: string, enable: boolean, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;

  // Enabling a binding on a tombstoned account would be a lie: the drain
  // filters deleted accounts, so nothing would ever run, and the success
  // response would promise a queue that drains. Disabling is still allowed —
  // it is the safe direction and idempotent.
  if (enable && binding.deleted_at !== null) {
    return json(
      {
        error:
          `account ${binding.account_id} is deleted — re-enabling ${binding.id} would arm nothing, ` +
          "because the drain skips tombstoned accounts",
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  // `enabled` is INTEGER in SQLite; write 0/1 rather than a JS boolean so the
  // column has one convention (createAgentBinding writes the literal 1).
  await env.DB.prepare(`UPDATE agent_bindings SET enabled = ? WHERE account_id = ? AND id = ?`)
    .bind(enable ? 1 : 0, binding.account_id, binding.id)
    .run();

  const queued = await queuedInvocations(env, binding);
  return json({
    ok: true,
    bindingId: binding.id,
    accountId: binding.account_id,
    name: binding.name,
    enabled: enable,
    // Whether this call actually moved the switch. NOT derived from
    // `meta.changes`: SQLite counts an UPDATE that writes an identical value
    // as a change, so that number is 1 for a no-op too.
    changed: !!binding.enabled !== enable,
    pendingInvocations: queued,
    note: enable
      ? `${queued} queued invocation(s) will now drain`
      : `${queued} queued invocation(s) are HELD, not cancelled — they resume on enable`,
  });
}

// ---- the binding config write surface (s10 T4) ------------------------

/**
 * The TYPED CORE, and the whole of what `PATCH /agent-bindings/{id}` accepts.
 *
 * `.plans/s10-agents/readme.md` — "do not CRUD a blob": `config_json` is one
 * untyped namespace shared by `persona`, `replyMode`, `allowedSenders`,
 * `modelAliases`, `maxTokens`, `pipeline` and `analyst@`'s `digestTargets`, so
 * a general merge endpoint would edit a different unvalidated shape per agent
 * and would let any caller write any key by accident. This route writes four
 * named fields and REFUSES every other key by name.
 *
 * `allowedSenders` and `replyMode` are still blob keys (the typed-core column
 * promotion is DEFERRED — s10 status block), so the write is a
 * read-modify-write that touches those two keys ONLY and leaves the remainder
 * exactly as it was.
 */
const BINDING_PATCH_FIELDS = ["enabled", "replyMode", "allowedSenders", "recipientsBookId", "ruleAutoApply"] as const;

/**
 * The remainder, named in the refusal so the 400 teaches the rule rather than
 * just enforcing it. Not exhaustive and does not need to be — it is the error
 * message's example set, while the ACCEPT list above is the actual gate.
 */
const BINDING_BLOB_REMAINDER = ["persona", "modelAliases", "digestTargets", "pipeline", "maxTokens"];

/** The values the runtime enforces — services/agent/src/models.ts BindingConfig
 *  (`replyMode?: "send" | "draft"`), defaulted to `draft` at every read site. */
const REPLY_MODES = ["send", "draft"];

/** Normalized exact-match discipline, same rule as the outbound bound's
 *  (packages/mailstore governance.normalizeAddress): lowercase, trimmed, and
 *  NOTHING else — no plus-tag folding, because `bob+x@` is not `bob@`. */
const normalizeSender = (raw: string): string => raw.trim().toLowerCase();

/** Structural JSON equality — the no-op test for the config blob. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i]));
  }
  if (typeof a !== "object") return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && sameJson(ao[k], bo[k]));
}

/**
 * `PATCH /agent-bindings/{id}` — the binding config write surface (s10 T4).
 *
 * Until this route existed the ONLY post-create write on a binding was
 * `UPDATE agent_bindings SET enabled`, which made every other config control a
 * surface that could render a value and never change it. Four decisions shape
 * it, and each is a refusal somewhere:
 *
 * ── 1. The typed core only ──
 * Four fields (`BINDING_PATCH_FIELDS`). An unknown key is a 400 that names both
 * the key and the rule; nothing is blind-merged into `config_json`, and the
 * agent-specific remainder is preserved byte-for-value across the write.
 *
 * ── 2. A re-pointed book must be `write_policy = 'governed'` ──
 * The bound IS an address book, so re-pointing at an `open` book would silently
 * UNBIND the agent: an open book takes direct agent writes under ordinary
 * `contacts` scope (the Mailstore chokepoint only engages for non-open books),
 * so the agent could then widen its own reach with `contacts_create_card` —
 * control and controlled become the same writable object, which is the exact
 * confused-deputy shape s10 T1 exists to close. The book must also live on the
 * BINDING'S OWN ACCOUNT, because that is the lookup the send gate itself runs
 * (`packages/mailstore/src/outboundBound.ts` — `address_books WHERE account_id = ? AND
 * id = ?`); a book anywhere else reads as "bounded" in a config surface and is
 * fail-closed at send time, which is a config surface telling a lie.
 *
 * NULL is the one other accepted value: it UNBINDS, the binding can no longer
 * send at all, and the response says so in those words. That is fail-closed and
 * therefore always allowed — but never silent.
 *
 * ── 3. Re-pointing appends a provenance row ──
 * Changing which book governs an agent is widening-class: the whole T2 argument
 * is that such a change must be reconstructable afterwards. See
 * `binding_lifecycle` in data-plane.sql for why the record is NOT a
 * `book_membership_log` row.
 *
 * ── 4. Idempotent, and concurrency-honest ──
 * A no-op PATCH writes NOTHING — no UPDATE, and no provenance row for a book
 * that did not move. A real write carries a compare-and-swap predicate on the
 * pre-image of both `config_json` and `recipients_book_id`: a concurrent edit
 * between the read and the write makes the UPDATE match zero rows and answers
 * 409 rather than silently clobbering the other writer's blob. The provenance
 * INSERT rides the SAME predicate in the SAME `db.batch()`, so the chain row
 * and the change it describes commit together or not at all.
 */
async function patchAgentBinding(id: string, body: Record<string, unknown>, url: URL, env: Env) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "body must be a JSON object", accepted: BINDING_PATCH_FIELDS }, 400);
  }
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !(BINDING_PATCH_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return json(
      {
        error:
          `unknown field(s): ${unknown.join(", ")}. This route writes the TYPED CORE only ` +
          `(${BINDING_PATCH_FIELDS.join(", ")}). The agent-specific remainder of config_json ` +
          `(${BINDING_BLOB_REMAINDER.join(", ")}, …) is deliberately NOT writable here: a form ` +
          `over an untyped blob edits a different unvalidated shape per agent, so the remainder ` +
          `stays read-only on every config surface and is preserved verbatim by this write. ` +
          `A different SHAPE is a new binding (POST /agent-bindings)`,
        accepted: BINDING_PATCH_FIELDS,
        rejected: unknown,
      },
      400,
    );
  }
  if (keys.length === 0) {
    return json({ error: `nothing to update — pass at least one of ${BINDING_PATCH_FIELDS.join(", ")}` }, 400);
  }

  // ---- value validation, all of it before any read of the row ----
  const wantsEnabled = "enabled" in body;
  if (wantsEnabled && typeof body.enabled !== "boolean") {
    return json({ error: "enabled must be true or false" }, 400);
  }
  const wantsReplyMode = "replyMode" in body;
  if (wantsReplyMode && !REPLY_MODES.includes(body.replyMode as string)) {
    return json(
      {
        error:
          `replyMode must be one of ${REPLY_MODES.join(", ")} — these are the values the runtime ` +
          `enforces (services/agent/src/models.ts; anything else is read as 'draft', so an ` +
          `unrecognised value here would silently disarm a send-mode agent)`,
      },
      400,
    );
  }
  const wantsSenders = "allowedSenders" in body;
  let nextSenders: string[] | null = null;
  if (wantsSenders && body.allowedSenders !== null) {
    const raw = body.allowedSenders;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
      return json({ error: "allowedSenders must be an array of email addresses, or null" }, 400);
    }
    const bad = (raw as string[]).filter((v) => !/^[^\s@]+@[^\s@]+$/.test(v.trim()));
    if (bad.length > 0) {
      return json(
        {
          error:
            `allowedSenders entries must be addresses (localpart@domain); rejected: ` +
            `${bad.map((b) => JSON.stringify(b)).join(", ")}. The inbound gate is a normalized ` +
            `EXACT match, so a non-address entry can never match and would quietly narrow the gate`,
        },
        400,
      );
    }
    if (raw.length === 0) {
      // The one shape that reads as its own opposite: services/agent treats an
      // empty-but-present allowedSenders as NO GATE, so `[]` from a config
      // surface means "anyone may invoke this agent" while looking like a
      // tightening. Removing the gate is allowed, but only when it is SAID.
      return json(
        {
          error:
            "allowedSenders: [] is refused — an empty-but-present list is read as NO GATE by " +
            "services/agent (anyone who can reach the mailbox could invoke this binding), which is " +
            "the opposite of what an empty list looks like. To REMOVE the inbound gate deliberately, " +
            "send allowedSenders: null; to keep a gate, send at least one address",
        },
        400,
      );
    }
    // Normalize + de-duplicate, order preserved. Normalization is not cosmetic:
    // the gate compares normalized-exact, so an unnormalized entry never matches.
    const seen = new Set<string>();
    nextSenders = [];
    for (const v of raw as string[]) {
      const n = normalizeSender(v);
      if (!seen.has(n)) {
        seen.add(n);
        nextSenders.push(n);
      }
    }
  }
  const wantsGrant = "ruleAutoApply" in body;
  if (wantsGrant && typeof body.ruleAutoApply !== "boolean" && body.ruleAutoApply !== null) {
    return json(
      {
        error:
          "ruleAutoApply must be true (grant rung 3: bouncer-composed rule changes auto-apply, " +
          "with a 5-minute yank window), or false/null to revoke. This is STANDING AUTHORITY, " +
          "given by this explicit write and never accrued (s31)",
      },
      400,
    );
  }
  const wantsBook = "recipientsBookId" in body;
  if (wantsBook && body.recipientsBookId !== null) {
    if (typeof body.recipientsBookId !== "string" || body.recipientsBookId.trim() === "") {
      return json(
        {
          error:
            "recipientsBookId must be a governing book id, or null to UNBIND. The empty string is " +
            "refused: there is no value meaning 'may send anywhere' — the absence of a book means " +
            "CANNOT SEND, and an empty-but-present bound is the shape that reads as unrestricted",
        },
        400,
      );
    }
  }

  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;

  // The blob's pre-image. Refuse rather than repair: a read-modify-write over
  // an unparseable blob would DESTROY the remainder it exists to preserve.
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(binding.config_json || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    config = parsed as Record<string, unknown>;
  } catch {
    return json(
      {
        error:
          `binding ${binding.id} has a config_json this route cannot parse as an object. It is ` +
          `refused rather than replaced: rewriting it would destroy the agent-specific remainder ` +
          `(${BINDING_BLOB_REMAINDER.join(", ")}) this route exists to preserve. Repair the row, ` +
          `or re-create the binding`,
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  // ---- the governing book: exists, on THIS account, and governed ----
  const nextBook: string | null = wantsBook
    ? ((body.recipientsBookId as string | null) ?? null)
    : binding.recipients_book_id;
  if (wantsBook && nextBook !== null && nextBook !== binding.recipients_book_id) {
    const book = await env.DB.prepare(
      // The send gate's own lookup (packages/mailstore/src/outboundBound.ts), account
      // and all: a book that this SELECT cannot see is fail-closed at send
      // time, whatever a config surface renders.
      `SELECT id, name, write_policy FROM address_books WHERE account_id = ? AND id = ?`,
    )
      .bind(binding.account_id, nextBook)
      .first<{ id: string; name: string; write_policy: string | null }>();
    if (!book) {
      return json(
        {
          error:
            `no address book ${nextBook} on account ${binding.account_id}. The governing book must ` +
            `live on the BINDING'S OWN account — that is the lookup the send gate runs ` +
            `(@bullmoose/mailstore outboundRefusal), so a book elsewhere would render as a bound here and ` +
            `refuse every send in production`,
          bindingId: binding.id,
          accountId: binding.account_id,
        },
        404,
      );
    }
    if ((book.write_policy ?? "open") !== "governed") {
      return json(
        {
          error:
            `address book ${nextBook} (${JSON.stringify(book.name)}) has write_policy ` +
            `'${book.write_policy ?? "open"}' — the ` +
            `governing book of a binding must be 'governed'. Pointing a binding at a non-governed ` +
            `book would SILENTLY UNBIND it: only a governed book refuses the agent's own direct ` +
            `writes (the Mailstore chokepoint engages on write_policy != 'open'; on 'propose' an ` +
            `agent write becomes a proposal, and on 'open' it just lands), so the agent could widen ` +
            `its own reach through contacts_create_card and control and controlled would be the same ` +
            `writable object. Mark the book governed first (provisioning: setAddressBookWritePolicy), ` +
            `then re-point`,
          bindingId: binding.id,
          bookId: nextBook,
          writePolicy: book.write_policy ?? "open",
          required: "governed",
        },
        422,
      );
    }
  }

  // Enabling a binding on a tombstoned account is refused for exactly the
  // reason the kill-switch verb refuses it: the drain skips deleted accounts,
  // so the success response would promise a queue that never drains.
  const nextEnabled = wantsEnabled ? (body.enabled as boolean) : binding.enabled === 1;
  if (wantsEnabled && nextEnabled && binding.deleted_at !== null) {
    return json(
      {
        error:
          `account ${binding.account_id} is deleted — re-enabling ${binding.id} would arm nothing, ` +
          "because the drain skips tombstoned accounts",
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  // ---- the next config: the two typed keys, and NOTHING else ----
  const nextConfig: Record<string, unknown> = { ...config };
  if (wantsReplyMode) nextConfig.replyMode = body.replyMode;
  if (wantsSenders) {
    if (nextSenders === null) delete nextConfig.allowedSenders;
    else nextConfig.allowedSenders = nextSenders;
  }
  // The rung-3 grant is present-or-absent, never stored false: a revoked
  // grant leaves no key to misread, and the dossier renders exactly what is
  // granted (s31: "rendered visibly, revocable").
  if (wantsGrant) {
    if (body.ruleAutoApply === true) nextConfig.ruleAutoApply = true;
    else delete nextConfig.ruleAutoApply;
  }
  const preserved = Object.keys(config).filter(
    (k) => k !== "replyMode" && k !== "allowedSenders" && k !== "ruleAutoApply",
  );

  const configChanged = !sameJson(config, nextConfig);
  const bookChanged = nextBook !== binding.recipients_book_id;
  const enabledChanged = nextEnabled !== (binding.enabled === 1);
  const changedFields = [
    ...(enabledChanged ? ["enabled"] : []),
    ...(wantsReplyMode && config.replyMode !== nextConfig.replyMode ? ["replyMode"] : []),
    ...(wantsSenders && !sameJson(config.allowedSenders, nextConfig.allowedSenders) ? ["allowedSenders"] : []),
    ...(bookChanged ? ["recipientsBookId"] : []),
  ];

  const now = Date.now();
  const provenance = bookChanged
    ? {
        record: "binding_lifecycle",
        event: "recipients-book-changed",
        from: binding.recipients_book_id,
        to: nextBook,
        actor: BINDING_ACTOR,
        viaProposalId: null,
        at: now,
      }
    : null;

  // ---- the write, or the honest absence of one ----
  if (!configChanged && !bookChanged && !enabledChanged) {
    // A no-op is a NO-OP: no UPDATE (SQLite would count an identical write as a
    // change and the response would claim one), and above all no provenance row
    // — a chain that records non-events is a chain nobody can read.
    return json({
      ok: true,
      changed: false,
      updated: [],
      ...bindingConfigView(binding, nextConfig, nextBook, nextEnabled, preserved),
      provenance: null,
      note: "no-op — every field already had the requested value; nothing was written",
    });
  }

  const nextConfigJson = JSON.stringify(nextConfig);
  const statements: D1PreparedStatement[] = [];
  if (provenance) {
    // Guarded on the SAME pre-image as the UPDATE below and ordered BEFORE it,
    // so the pair is all-or-nothing inside the batch's transaction: a lost CAS
    // must not leave a chain row describing a change that never happened.
    statements.push(
      env.DB.prepare(
        `INSERT INTO binding_lifecycle
             (account_id, binding_id, event, old_value, new_value, actor, via_proposal_id, at)
           SELECT ?, ?, ?, ?, ?, ?, NULL, ?
            WHERE EXISTS (SELECT 1 FROM agent_bindings
                           WHERE account_id = ? AND id = ?
                             AND config_json = ? AND recipients_book_id IS ?)`,
      ).bind(
        binding.account_id,
        binding.id,
        provenance.event,
        provenance.from,
        provenance.to,
        provenance.actor,
        provenance.at,
        binding.account_id,
        binding.id,
        binding.config_json,
        binding.recipients_book_id,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE agent_bindings
            SET config_json = ?, recipients_book_id = ?, enabled = ?
          WHERE account_id = ? AND id = ?
            AND config_json = ? AND recipients_book_id IS ?`,
    ).bind(
      nextConfigJson,
      nextBook,
      nextEnabled ? 1 : 0,
      binding.account_id,
      binding.id,
      binding.config_json,
      binding.recipients_book_id,
    ),
  );
  const results = await env.DB.batch(statements);
  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    // The compare-and-swap lost. Nothing was written — including the provenance
    // row, which carried the same predicate.
    return json(
      {
        error:
          `binding ${binding.id} changed between the read and the write of this PATCH — nothing was ` +
          `written (neither the config nor its provenance row). Re-read it (GET /agent-bindings) and ` +
          `re-apply: a blind retry would clobber the other writer's edit to config_json`,
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  return json({
    ok: true,
    changed: true,
    updated: changedFields,
    ...bindingConfigView(binding, nextConfig, nextBook, nextEnabled, preserved),
    provenance,
    ...(wantsEnabled ? { pendingInvocations: await queuedInvocations(env, binding) } : {}),
  });
}

/**
 * The admin plane has one bearer token and no principal behind it, so the actor
 * on its provenance rows is the literal `admin` — the same convention
 * `logGrantLifecycle` already writes. It is not a person's name and does not
 * pretend to be one; when a widening arrives through a proposal instead (T3),
 * `via_proposal_id` carries the identity, the rationale and the approver.
 */
const BINDING_ACTOR = "admin";

/** The config view every PATCH response shares, no-op or not. */
function bindingConfigView(
  binding: BindingRow,
  config: Record<string, unknown>,
  bookId: string | null,
  enabled: boolean,
  preserved: string[],
) {
  return {
    bindingId: binding.id,
    accountId: binding.account_id,
    name: binding.name,
    enabled,
    replyMode: (config.replyMode as string) ?? null,
    allowedSenders: (config.allowedSenders as string[] | undefined) ?? null,
    outbound: {
      state: bookId === null ? "none" : "book",
      governingBookId: bookId,
      failClosed: bookId === null,
      note:
        bookId === null
          ? "FAIL-CLOSED: with no governing book this binding CANNOT SEND — every send is refused " +
            "server-side (@bullmoose/mailstore outboundRefusal). That is safe, not unrestricted"
          : "membership is resolved server-side on every send, normalized exact match; the agent " +
            "cannot write this book (write_policy 'governed') — it asks with a grant-request proposal",
    },
    // The remainder this write did NOT touch, named so the caller can SEE that
    // the blob survived rather than having to trust it.
    preserved,
  };
}

/**
 * `GET /agent-bindings/{id}/lifecycle` — the binding's provenance chain.
 *
 * A record nobody can read is half an audit. This is the read half of
 * `binding_lifecycle`: oldest first, every row legible on its own
 * (`old_value` → `new_value`, actor, timestamp), and it survives the binding
 * because the table carries no FK — so "which book governed photos@ last
 * Tuesday, and who changed it?" stays answerable after a destroy.
 */
async function listBindingLifecycle(id: string, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;
  const { results } = await env.DB.prepare(
    `SELECT id, event, old_value, new_value, actor, via_proposal_id, at
       FROM binding_lifecycle
      WHERE account_id = ? AND binding_id = ?
      ORDER BY id`,
  )
    .bind(binding.account_id, binding.id)
    .all();
  return json({
    bindingId: binding.id,
    accountId: binding.account_id,
    name: binding.name,
    events: results,
  });
}

async function queuedInvocations(env: Env, binding: BindingRow): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_invocations
     WHERE account_id = ? AND binding_id = ? AND status IN ('pending', 'running')`,
  )
    .bind(binding.account_id, binding.id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Hard delete, refused while work is queued.
 *
 * The drain resolves jobs through `JOIN agent_bindings`, so deleting a binding
 * with `pending` rows behind it does not cancel them — it makes them
 * permanently invisible: never run, never failed, never cleaned up. Disable is
 * the reversible verb; if you want the binding gone, the queue has to be
 * empty first, and the 409 says so.
 *
 * `createAgentBinding` also arms a `watchdog_{id}` responder when `slaSeconds`
 * is set. Left behind, it goes on telling senders the agent is "temporarily
 * unavailable" forever, so it goes in the same operation.
 */
async function deleteAgentBinding(id: string, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;

  // Only for a LIVE account. On a tombstoned one the queue can never reach a
  // terminal status (the drain skips it), so refusing would make the binding
  // undeletable forever — and `deleteAccount` has already cancelled those rows
  // anyway.
  const queued = binding.deleted_at === null ? await queuedInvocations(env, binding) : 0;
  if (queued > 0) {
    return json(
      {
        error:
          `binding ${binding.id} still has ${queued} pending/running invocation(s) — ` +
          `deleting it would strand them (the drain joins agent_bindings). ` +
          `Disable it first (POST /agent-bindings/${binding.id}/disable), let the queue clear, then delete`,
        bindingId: binding.id,
        accountId: binding.account_id,
        pendingInvocations: queued,
      },
      409,
    );
  }

  const steps: Step[] = [];
  const watchdog = await env.DB.prepare(`DELETE FROM responders WHERE account_id = ? AND id = ?`)
    .bind(binding.account_id, `watchdog_${binding.id}`)
    .run();
  steps.push({
    step: "d1:watchdog-responder",
    ok: true,
    detail: (watchdog.meta.changes ?? 0) > 0 ? `watchdog_${binding.id} removed` : "none was armed",
  });

  await env.DB.prepare(`DELETE FROM agent_bindings WHERE account_id = ? AND id = ?`)
    .bind(binding.account_id, binding.id)
    .run();
  steps.push({ step: "d1:agent-binding", ok: true });

  return json({
    ok: true,
    deleted: true,
    bindingId: binding.id,
    accountId: binding.account_id,
    name: binding.name,
    steps,
  });
}

// ---- backfill: the cursor's missing half (s26 T3) ---------------------

/**
 * How many invocations one backfill call may mint. The cap keeps a single
 * admin POST from turning a decade of archive into one unbounded write burst;
 * re-running the (idempotent) call walks further back, newest-first.
 */
const BACKFILL_MINT_CAP = 500;

/** The default window when the caller names none — devPlan decision 2. */
const BACKFILL_DEFAULT_SINCE_DAYS = 90;

const DAY_MS = 86_400_000;

/** How long a human has to decide a floor-request before it expires. */
const FLOOR_REQUEST_EXPIRY_MS = 7 * 24 * 3600_000;

/** config_json, parsed junk-tolerantly: operator-written TEXT must degrade to
 *  "nothing declared", never throw. (The WRITE paths stay strict — see
 *  patchAgentBinding's refusal to rewrite an unparseable blob.) */
function safeConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The binding's EFFECTIVE HISTORY FLOOR (devPlan rule 1): how far back its
 * backfill may reach.
 *
 *   `historyFloor`  an approved widening (the floor-request round trip wrote
 *                   it) — wins when present;
 *   `createdAt`     the binding's birth, stamped by createAgentBinding — the
 *                   default: a new agent never reprocesses old news;
 *   neither         a pre-s26 binding. The floor is UNKNOWN, and unknown is
 *                   not "unbounded": backfill fails closed and points at the
 *                   floor-request verb, which ESTABLISHES a floor by approval.
 */
function effectiveHistoryFloor(configJson: string): {
  floorMs: number | null;
  source: "historyFloor" | "createdAt" | null;
} {
  const cfg = safeConfig(configJson);
  if (typeof cfg.historyFloor === "number" && Number.isFinite(cfg.historyFloor)) {
    return { floorMs: cfg.historyFloor, source: "historyFloor" };
  }
  if (typeof cfg.createdAt === "number" && Number.isFinite(cfg.createdAt)) {
    return { floorMs: cfg.createdAt, source: "createdAt" };
  }
  return { floorMs: null, source: null };
}

/** The binding's declared privacy floor, junk-tolerant (the ingest stamp's
 *  rule, restated here because the two workers share no module): a typo can
 *  only fail to raise, never lower. */
function backfillPrivacy(configJson: string): string | null {
  const v = safeConfig(configJson).privacyFloor;
  return v === "open" || v === "internal" || v === "pinned" ? v : null;
}

/**
 * `POST /agent-bindings/{id}/backfill {sinceDays?, budgetMicros?}` — the
 * manual backfill verb (devPlan rule 3). The queue-as-cursor answers FORWARD
 * progress; this mints the HISTORICAL half: PENDING invocations for the
 * binding's account's mail in [max(now − sinceDays, floor), now), so the
 * ordinary drain — budget gate and all — runs the same pipeline over the
 * archive that delivery runs over today's mail.
 *
 * The load-bearing choices:
 *
 *   NEWEST-FIRST   recent history is worth more than old history, and the
 *                  mint cap means one call may not reach the window's far
 *                  edge — the newest slice must be the one that lands.
 *   NULL due_at    sit-free work. The claim gate reads NULL-due as
 *                  never-urgent: a live homelab claimant may eat it at $0,
 *                  and the paid drain treats it as non-urgent rather than as
 *                  a deadline breach (claimGate.ts dueWindowSql).
 *   IDEMPOTENT     per (binding, email): a message that already has an
 *                  invocation for this binding — delivered live, or minted by
 *                  an earlier backfill — is skipped, enforced INSIDE each
 *                  INSERT (guarded INSERT…SELECT), so even a concurrent
 *                  double-POST cannot double-mint.
 *   FLOOR-BOUNDED  the DEFAULT window clamps to the effective floor and says
 *                  so (`floorClamped`); an EXPLICIT `sinceDays` that reaches
 *                  behind the floor is refused with 409 — that ask is a
 *                  floor move, which is rule 1's approval, not this verb.
 *
 * `budgetMicros` is the backfill's ENVELOPE, and since s26 T3 v2 it is
 * ENFORCED: it rides in the response and in each minted row's context_json,
 * and the claim gate (`backfillEnvelopeSql` / `backfillEnvelopeExhaustedSql`,
 * @bullmoose/scheduling) draws envelope-carrying rows from THAT purse instead
 * of the binding's monthly budget — prior backfill spend counts against it,
 * NULL costs count as unknown (never a spend), and when it is spent through
 * the remaining rows simply WAIT: a free homelab claimant still eats them at
 * $0, and the next envelope or surplus pass picks the rest up. Exhaustion is
 * not an error and raises no budget-overrun ask (a monthly overage would
 * release nothing for these rows). Absent is null ("no envelope named" — the
 * monthly budget gates as before), never 0 ("a $0 envelope": mint the rows,
 * spend nothing paid) — the money-honesty rule.
 *
 * No ACCOUNT_DO here, so no changelog push: the rows sit as the durable
 * cursor until a claimant's next wake-up, which is exactly what non-urgent
 * means.
 */
async function backfillBinding(id: string, body: { sinceDays?: number; budgetMicros?: number }, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;

  // A tombstoned account's queue can never drain (the drain skips it), and a
  // disabled binding's rows would pile up HELD — the invisible-backlog trap
  // the kill switch's response exists to surface. Both refuse rather than
  // minting work that silently sits.
  if (binding.deleted_at !== null) {
    return json(
      {
        error: `account ${binding.account_id} is deleted — backfill would mint invocations nothing can ever drain`,
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }
  if (binding.enabled !== 1) {
    return json(
      {
        error:
          `binding ${binding.id} is disabled — backfill would mint held work that drains all at once on ` +
          `enable. Enable it first (POST /agent-bindings/${binding.id}/enable), then backfill`,
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  const sinceDaysExplicit = body.sinceDays !== undefined;
  if (
    sinceDaysExplicit &&
    (typeof body.sinceDays !== "number" || !Number.isFinite(body.sinceDays) || body.sinceDays <= 0)
  ) {
    return json({ error: "sinceDays must be a positive number of days" }, 400);
  }
  const budgetGiven = body.budgetMicros !== undefined;
  if (
    budgetGiven &&
    (typeof body.budgetMicros !== "number" || !Number.isFinite(body.budgetMicros) || body.budgetMicros < 0)
  ) {
    return json({ error: "budgetMicros must be a non-negative integer (micro-USD)" }, 400);
  }
  const budgetMicros = budgetGiven ? Math.floor(body.budgetMicros as number) : null;

  const now = Date.now();
  const floor = effectiveHistoryFloor(binding.config_json);
  if (floor.floorMs === null) {
    // Pre-s26 binding: no historyFloor, no createdAt. There is no honest
    // default window — guessing one would either reprocess an archive nobody
    // approved or silently skip one somebody wanted. Fail closed, and name
    // the verb that establishes a floor ON PURPOSE.
    return json(
      {
        error:
          `binding ${binding.id} has no history floor: it predates the floor stamp (no createdAt, no ` +
          `historyFloor in config_json), so there is no honest default for how far back it may read. ` +
          `Establish one explicitly: POST /agent-bindings/${binding.id}/floor-request {toEpochMs} mints ` +
          `the approval; once approved, re-run this backfill`,
        bindingId: binding.id,
        accountId: binding.account_id,
        floorMs: null,
      },
      409,
    );
  }

  const sinceDays = sinceDaysExplicit ? (body.sinceDays as number) : BACKFILL_DEFAULT_SINCE_DAYS;
  const requestedStartMs = now - sinceDays * DAY_MS;
  if (sinceDaysExplicit && requestedStartMs < floor.floorMs) {
    // An explicit ask past the floor is not a window to clamp — it is a
    // request to MOVE the floor, and that is an act needing approval
    // (devPlan rule 1). Refuse with the path to the approval; the default
    // window (no sinceDays) clamps instead, below.
    return json(
      {
        error:
          `sinceDays=${sinceDays} reaches back to ${new Date(requestedStartMs).toISOString()}, behind this ` +
          `binding's history floor (${new Date(floor.floorMs).toISOString()}, from ${floor.source}). Moving ` +
          `the floor back is an approval, not a parameter: POST /agent-bindings/${binding.id}/floor-request ` +
          `{toEpochMs: ${requestedStartMs}} to ask, and re-run the backfill once it is approved`,
        bindingId: binding.id,
        accountId: binding.account_id,
        floorMs: floor.floorMs,
        floorSource: floor.source,
        requestedStartMs,
      },
      409,
    );
  }
  const floorClamped = requestedStartMs < floor.floorMs;
  const windowStartMs = floorClamped ? floor.floorMs : requestedStartMs;

  // The candidates, NEWEST-FIRST, minus every message this binding already has
  // an invocation for (live delivery or an earlier backfill) — that difference
  // is what the cap slices.
  const { results: candidates } = await env.DB.prepare(
    `SELECT e.id, e.thread_id FROM emails e
     WHERE e.account_id = ?1 AND e.received_at >= ?2 AND e.received_at < ?3
       AND NOT EXISTS (SELECT 1 FROM agent_invocations ai
                       WHERE ai.account_id = e.account_id AND ai.binding_id = ?4 AND ai.email_id = e.id)
     ORDER BY e.received_at DESC
     LIMIT ?5`,
  )
    .bind(binding.account_id, windowStartMs, now, binding.id, BACKFILL_MINT_CAP)
    .all<{ id: string; thread_id: string }>();

  const skippedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails e
     WHERE e.account_id = ?1 AND e.received_at >= ?2 AND e.received_at < ?3
       AND EXISTS (SELECT 1 FROM agent_invocations ai
                   WHERE ai.account_id = e.account_id AND ai.binding_id = ?4 AND ai.email_id = e.id)`,
  )
    .bind(binding.account_id, windowStartMs, now, binding.id)
    .first<{ n: number }>();

  const privacy = backfillPrivacy(binding.config_json);
  let minted = 0;
  if (candidates.length > 0) {
    // One guarded INSERT per email, newest-first, batched (transactional in
    // D1). The NOT EXISTS re-check inside each statement is the idempotence
    // guarantee under concurrency — the SELECT above was only the shortlist.
    const statements = candidates.map((e) =>
      env.DB.prepare(
        `INSERT INTO agent_invocations
           (id, account_id, binding_id, binding_name, status, email_id, context_json, created_at, privacy)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8
          WHERE NOT EXISTS (SELECT 1 FROM agent_invocations
                            WHERE account_id = ?2 AND binding_id = ?3 AND email_id = ?5)`,
      ).bind(
        `inv_${crypto.randomUUID()}`,
        binding.account_id,
        binding.id,
        binding.name,
        e.id,
        JSON.stringify({
          emailId: e.id,
          threadId: e.thread_id,
          backfill: true,
          // The envelope rides on the work it covers — the claim gate
          // (backfillEnvelopeSql) reads it from exactly here.
          ...(budgetMicros !== null ? { backfillBudgetMicros: budgetMicros } : {}),
        }),
        now,
        privacy,
      ),
    );
    const results = await env.DB.batch(statements);
    minted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }

  return json({
    ok: true,
    bindingId: binding.id,
    accountId: binding.account_id,
    minted,
    skipped: skippedRow?.n ?? 0,
    floorClamped,
    // The window that actually ran, and why — so `floorClamped: true` is
    // legible without re-deriving the arithmetic.
    windowStartMs,
    windowEndMs: now,
    floorMs: floor.floorMs,
    floorSource: floor.source,
    // Reached the cap ⇒ the window's far edge was NOT reached; re-run the same
    // call to walk further back (idempotence makes the re-run safe).
    capped: candidates.length === BACKFILL_MINT_CAP,
    // The ENFORCED envelope (s26 T3 v2). null = "no envelope named" — the
    // monthly budget gates those rows exactly as before.
    budgetMicros,
    note:
      budgetMicros !== null
        ? `minted rows are NULL-due (sit-free): a live homelab claimant may eat them at $0, and the paid ` +
          `drain draws them from this backfill's own envelope (budgetMicros) instead of the monthly ` +
          `budget — once prior backfill spend reaches it, the rest wait for the next envelope or surplus`
        : `minted rows are NULL-due (sit-free): a live homelab claimant may eat them at $0, and the paid ` +
          `drain treats them as non-urgent inside the binding's monthly budget (no envelope named)`,
  });
}

/**
 * `POST /agent-bindings/{id}/floor-request {toEpochMs}` — rule 1's approval,
 * as a proposal in the ordinary queue.
 *
 * Moving the history floor BACK is an act that needs a human ("crm@ asks to
 * read mail back to 2023 — allow?"), so this verb does not write the floor: it
 * mints a tier-1 `floor-request` proposal on the carrier-invocation pattern
 * (waitingOn.ts `offer`, budgetOverrun.ts), and `applyProposal` (services/jmap
 * actionProposal.ts) writes `config_json.historyFloor` on APPROVE. Tier 1 is
 * honest: approving moves a bound, spends nothing and egresses nothing —
 * backfill itself stays a separate, budgeted call — and the undo restores the
 * previous floor. Declining is a preference, never a fault (NO_FAULT_KINDS).
 *
 * Idempotent per pending ask: re-POSTing the same toEpochMs returns the
 * pending proposal; a DIFFERENT toEpochMs while one is pending is refused —
 * two open questions about the same floor is how a queue contradicts itself.
 */
async function requestHistoryFloor(id: string, body: { toEpochMs?: number }, url: URL, env: Env) {
  const found = await resolveBinding(id, url, env);
  if ("response" in found) return found.response;
  const { binding } = found;
  if (binding.deleted_at !== null) {
    return json(
      {
        error: `account ${binding.account_id} is deleted — a floor-request would ask a question nobody can act on`,
        bindingId: binding.id,
        accountId: binding.account_id,
      },
      409,
    );
  }

  const now = Date.now();
  const toEpochMs = body.toEpochMs;
  if (typeof toEpochMs !== "number" || !Number.isFinite(toEpochMs) || toEpochMs <= 0) {
    return json({ error: "toEpochMs required: the epoch-ms instant the floor should move back to" }, 400);
  }
  if (toEpochMs > now) {
    return json({ error: `toEpochMs ${toEpochMs} is in the future — a history floor bounds the PAST` }, 400);
  }
  const floor = effectiveHistoryFloor(binding.config_json);
  if (floor.floorMs !== null && toEpochMs >= floor.floorMs) {
    return json(
      {
        error:
          `the floor already stands at ${new Date(floor.floorMs).toISOString()} (from ${floor.source}) — ` +
          `${new Date(toEpochMs).toISOString()} is not behind it, so there is nothing to approve. ` +
          `(Backfill already reaches it; moving a floor FORWARD is not this verb.)`,
        bindingId: binding.id,
        floorMs: floor.floorMs,
      },
      400,
    );
  }

  // One open question per floor. subject_json is our own serialization, so
  // exact equality is a safe key.
  const subjectJson = JSON.stringify({ realm: "AgentBinding", objectId: binding.id });
  const pending = await env.DB.prepare(
    `SELECT id, payload_json FROM agent_proposals
     WHERE account_id = ? AND kind = 'floor-request' AND status = 'pending' AND subject_json = ?`,
  )
    .bind(binding.account_id, subjectJson)
    .first<{ id: string; payload_json: string }>();
  if (pending) {
    const asked = safeConfig(pending.payload_json).toEpochMs;
    if (asked === toEpochMs) {
      return json({ ok: true, proposalId: pending.id, minted: false, note: "this exact ask is already pending" });
    }
    return json(
      {
        error:
          `a floor-request for ${binding.id} is already pending (proposal ${pending.id}, asking for ` +
          `${typeof asked === "number" ? new Date(asked).toISOString() : "an unreadable instant"}) — decide ` +
          `it before asking differently`,
        proposalId: pending.id,
      },
      409,
    );
  }

  // The carrier invocation: done on arrival, cost 0 — no model ran, and 0 is
  // the honest figure for "nothing was spent" (never NULL, which means
  // "spent but unrecorded"). The proposal id IS the invocation id.
  const carrierId = `inv_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO agent_invocations
       (id, account_id, binding_id, binding_name, status, context_json,
        created_at, claimed_at, done_at, cost_micros, result_json)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      carrierId,
      binding.account_id,
      binding.id,
      binding.name,
      JSON.stringify({ kind: "floor-request", bindingId: binding.id, toEpochMs }),
      now,
      now,
      now,
      JSON.stringify({ kind: "floor-request", toEpochMs }),
    )
    .run();

  const currentFloorMs = floor.floorMs; // may be null — a pre-s26 binding ESTABLISHES its floor here
  await env.DB.prepare(
    `INSERT INTO agent_proposals
       (id, account_id, kind, tier, subject_json, payload_json, rationale,
        evidence_json, status, created_at, expires_at)
     VALUES (?, ?, 'floor-request', 1, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      carrierId,
      binding.account_id,
      subjectJson,
      JSON.stringify({
        bindingId: binding.id,
        bindingName: binding.name,
        toEpochMs,
        currentFloorMs,
        floorSource: floor.source,
      }),
      `"${binding.name}" asks to read mail back to ${new Date(toEpochMs).toISOString().slice(0, 10)}. ` +
        (currentFloorMs === null
          ? `It has no history floor today (it predates the floor stamp), so this ESTABLISHES one. `
          : `Its floor stands at ${new Date(currentFloorMs).toISOString().slice(0, 10)} (${floor.source}). `) +
        `Approving moves the floor and nothing else — backfill stays a separate, budgeted call, so this ` +
        `spends nothing by itself. Declining leaves history out of reach, and says nothing bad about the agent.`,
      JSON.stringify([
        { realm: "AgentBinding", objectId: binding.id, note: "the binding whose history floor would move" },
      ]),
      now,
      now + FLOOR_REQUEST_EXPIRY_MS,
    )
    .run();

  return json({
    ok: true,
    proposalId: carrierId,
    minted: true,
    kind: "floor-request",
    tier: 1,
    bindingId: binding.id,
    accountId: binding.account_id,
    toEpochMs,
    currentFloorMs,
  });
}

// ---- API helpers -----------------------------------------------------

interface CfResponse<T = unknown> {
  success: boolean;
  result?: T;
  errors?: Array<{ message: string }>;
}

async function cf<T = unknown>(
  env: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<CfResponse<T>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return (await res.json()) as CfResponse<T>;
}

async function dnsRecord(
  env: Env,
  zoneId: string,
  record: { type: string; name: string; content: string; priority?: number },
): Promise<{ ok: boolean; detail?: string }> {
  const res = await cf(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: { ...record, ttl: 1, proxied: false },
  });
  if (res.success) return { ok: true };
  const msg = firstError(res) ?? "unknown error";
  // "already exists" (81057/81058) is fine — re-runs are expected.
  return /already exists/i.test(msg) ? { ok: true, detail: "already existed" } : { ok: false, detail: msg };
}

function firstError(res: CfResponse): string | undefined {
  return res.errors?.[0]?.message;
}

function sesClient(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.SES_ACCESS_KEY_ID,
    secretAccessKey: env.SES_SECRET_ACCESS_KEY,
    region: env.SES_REGION,
    service: "ses",
  });
}

function sesUrl(env: Env, path: string): string {
  return `https://email.${env.SES_REGION}.amazonaws.com${path}`;
}

/**
 * Parse a request body, or hand back `{}`.
 *
 * The `PATCH` handlers all validate their own field and answer 400 with a
 * message naming it. Letting `request.json()` throw on an absent or malformed
 * body would jump straight past those guards into the catch at the top of
 * `fetch`, which answers **500** with `SyntaxError: Unexpected end of JSON
 * input` — a server error for what is plainly a client mistake, and one an
 * operator's monitoring will page on.
 */
async function readJson<T>(request: Request): Promise<T> {
  try {
    return ((await request.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
