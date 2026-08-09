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
 *   DELETE /agent-bindings/{id}   → refuses while invocations are queued
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
        return createAgentBinding(
          (await request.json()) as { email: string; name: string; slaSeconds?: number },
          env,
        );
      }
      if (route === "GET /agent-bindings") return listAgentBindings(url, env);
      // The kill switch (`.feedback/fromClaude/agentic/023`). TWO EXPLICIT
      // VERBS rather than a general `PATCH {enabled}`: in an incident the
      // dangerous direction must be unambiguous in the audit log and
      // impossible to typo into its opposite.
      const bindingVerb = url.pathname.match(/^\/agent-bindings\/([^/]+)\/(disable|enable)$/);
      if (request.method === "POST" && bindingVerb) {
        return setBindingEnabled(bindingVerb[1] as string, bindingVerb[2] === "enable", url, env);
      }
      if (request.method === "DELETE" && /^\/agent-bindings\/[^/]+$/.test(url.pathname)) {
        return deleteAgentBinding(url.pathname.split("/")[2] as string, url, env);
      }
      if (request.method === "PATCH" && /^\/tenants\/[^/]+$/.test(url.pathname)) {
        return renameTenant(
          url.pathname.split("/")[2] as string,
          await readJson<{ name?: string }>(request),
          env,
        );
      }
      if (request.method === "DELETE" && /^\/tenants\/[^/]+$/.test(url.pathname)) {
        return deleteTenant(url.pathname.split("/")[2] as string, env);
      }
      if (request.method === "PATCH" && /^\/domains\/[^/]+$/.test(url.pathname)) {
        return setDomainStatus(
          url.pathname.split("/")[2] as string,
          await readJson<{ status?: string }>(request),
          env,
        );
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
    } catch (err) {
      return json({ error: String(err) }, 500);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ---- tenants ---------------------------------------------------------

async function createTenant(body: { tenantId: string; name: string }, env: Env) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tenants (id, name, status, created_at) VALUES (?, ?, 'active', ?)`,
  )
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
  const res = await env.DB.prepare(`UPDATE tenants SET name = ? WHERE id = ?`)
    .bind(body.name, id)
    .run();
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
  const tenant = await env.DB.prepare(`SELECT id FROM tenants WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
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
    env.DB
      .prepare(`DELETE FROM identities WHERE account_id IN (SELECT id FROM accounts WHERE tenant_id = ?)`)
      .bind(id),
    ...["tokens", "credentials", "vault_credentials"].map((table) =>
      env.DB
        .prepare(
          `DELETE FROM ${table} WHERE principal_id IN (SELECT id FROM principals WHERE tenant_id = ?)`,
        )
        .bind(id),
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
  const where = [
    ...(tenant ? ["a.tenant_id = ?"] : []),
    ...(includeDeleted ? [] : ["a.deleted_at IS NULL"]),
  ];
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

  // 7b. JMAP autodiscovery (RFC 8620 §2.2): _jmap._tcp SRV → jmap worker,
  // so `bullmoose login user@<domain>` needs no --base.
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
    steps.push({ step: "cf:jmap-srv", ok: true, detail: "skipped — set JMAP_HOST var to enable autodiscovery" });
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
    await env.DB.prepare(
      `UPDATE domains SET status = 'active' WHERE domain = ? AND status != 'suspended'`,
    )
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
    return json(
      { error: `status must be one of: ${[...SETTABLE_DOMAIN_STATUSES].sort().join(", ")}` },
      400,
    );
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
  const { results: rows } = await env.DB.prepare(
    `SELECT localpart FROM routes WHERE domain = ?`,
  )
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
      reconcileRouteKey(
        env,
        { tenantId: r.tenant_id as string, domain, localpart: r.localpart },
        r.target,
      ),
    ),
  );
  const rebuilt = repairs.filter((x) => x !== null).length;

  const parked = await listAllKeys(env.ROUTES, `suspended-route:${domain}:`);
  const parkedLocalparts = new Set(
    parked.map((k) => k.slice(`suspended-route:${domain}:`.length)),
  );
  const restoredFlags = await Promise.all(
    parked.map(async (key) => {
      const value = await env.ROUTES.get(key);
      if (value !== null) await env.ROUTES.put(key.slice("suspended-".length), value);
      await env.ROUTES.delete(key);
      return value !== null ? 1 : 0;
    }),
  );
  const restored = restoredFlags.reduce((a: number, b: number) => a + b, 0);

  const unrestorable = rows.filter(
    (r) => r.kind !== "mailbox" && !parkedLocalparts.has(r.localpart),
  );
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
  const row = await env.DB.prepare(
    `SELECT domain, tenant_id, cf_zone_id FROM domains WHERE domain = ?`,
  )
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
    steps.push({ step: "cf:catch-all-disable", ok: true, detail: "skipped — no cf_zone_id on record" });
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
    detail: dropIdentity.ok
      ? undefined
      : dropIdentity.status === 404
        ? "already absent"
        : await dropIdentity.text(),
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
  },
  env: Env,
) {
  const { tenantId, domain, displayName } = body;
  // Normalize once. The route row, the identity and the KV key must all agree
  // on casing or delivery resolves to a different key than provisioning wrote.
  const localpart = body.localpart.toLowerCase();
  const address = `${localpart}@${domain}`;
  const now = Date.now();

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
  const existingRoute = await env.DB.prepare(
    `SELECT kind, target FROM routes WHERE domain = ? AND localpart = ?`,
  )
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
      env.DB
        .prepare(
          `INSERT INTO accounts (id, tenant_id, principal_id, display_name, shard, created_at)
           VALUES (?, ?, ?, ?, 'shard0', ?)`,
        )
        .bind(accountId, tenantId, principalId, displayName, now),
      env.DB
        .prepare(`INSERT INTO identities (id, account_id, email, name) VALUES (?, ?, ?, ?)`)
        .bind(`identity_${crypto.randomUUID().slice(0, 8)}`, accountId, address, displayName),
      // NOT `INSERT OR REPLACE` — that is a delete-then-insert in SQLite and
      // was the mechanism that silently moved delivery off account #1. Plain
      // INSERT lets PRIMARY KEY (domain, localpart) reject the duplicate, which
      // is what makes this batch safe against the race the pre-check above
      // cannot close on its own.
      env.DB
        .prepare(`INSERT INTO routes (domain, localpart, kind, target) VALUES (?, ?, 'mailbox', ?)`)
        .bind(domain, localpart, accountId),
      // Standard role mailboxes so the first Mailbox/get isn't empty.
      ...[
        ["inbox", "Inbox"],
        ["sent", "Sent"],
        ["drafts", "Drafts"],
        ["trash", "Trash"],
        ["junk", "Junk"],
        ["archive", "Archive"],
      ].map(([role, name]) =>
        env.DB
          .prepare(
            `INSERT INTO mailboxes (id, account_id, parent_id, name, role, sort_order)
             VALUES (?, ?, NULL, ?, ?, 0)`,
          )
          .bind(`mb_${crypto.randomUUID()}`, accountId, name, role),
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
  await env.ROUTES.put(
    `route:${domain}:${localpart}`,
    JSON.stringify({ kind: "mailbox", accountId, tenantId }),
  );

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

  const account = await env.DB.prepare(
    `SELECT id, tenant_id, principal_id, deleted_at FROM accounts WHERE id = ?`,
  )
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
  const identity = await env.DB.prepare(
    `SELECT id FROM identities WHERE account_id = ? AND email = ?`,
  )
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
  if (
    current?.kind === "mailbox" &&
    current.accountId === accountId &&
    current.tenantId === req.tenantId
  ) {
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
  const res = await env.DB.prepare(
    `UPDATE accounts SET display_name = ? WHERE id = ? AND deleted_at IS NULL`,
  )
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
  const { results: routes } = await env.DB.prepare(
    `SELECT domain, localpart, kind FROM routes WHERE target = ?`,
  )
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
    env.DB
      .prepare(`UPDATE accounts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(now, accountId),
  ]);
  steps.push({ step: "d1:routes", ok: true, detail: `${routes.length} row(s) removed` });
  steps.push({ step: "d1:accounts.deleted_at", ok: true, detail: new Date(now).toISOString() });

  // Bindings on a tombstoned account are already inert — the drain filters
  // deleted accounts — but flipping the column keeps `admin agent list`
  // honest, and re-creating the address later must not silently re-arm an
  // agent nobody remembers binding.
  const bindings = await env.DB.prepare(
    `UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND enabled = 1`,
  )
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

async function setPassword(body: { email: string; loginKey: string }, env: Env) {
  // The client derives loginKey via PBKDF2 (see auth-core) — the raw
  // password never reaches this worker, and the KDF cost never hits the
  // Workers Free 10ms CPU cap.
  if (!body.email || !isLoginKey(body.loginKey)) {
    return json(
      { error: "email and loginKey (64-hex client-derived key; the CLI derives it) required" },
      400,
    );
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

const GRANTABLE_SCOPES = new Set([
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
  await env.DB.prepare(
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
      Date.now(),
      body.expiresDays ? Date.now() + body.expiresDays * 86_400_000 : null,
    )
    .run();
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
  const res = await env.DB.prepare(`DELETE FROM grants WHERE id = ?`).bind(id).run();
  return json({ revoked: (res.meta.changes ?? 0) > 0 });
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

async function createAgentBinding(
  body: { email: string; name: string; slaSeconds?: number; config?: Record<string, unknown> },
  env: Env,
) {
  if (!body.email || !body.name) return json({ error: "email and name required" }, 400);
  const account = await accountByAddress(env, body.email);
  if (!account) return json({ error: `no account for ${body.email}` }, 404);

  const id = `bind_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO agent_bindings (id, account_id, name, trigger_on, sla_seconds, enabled, config_json)
     VALUES (?, ?, ?, 'mailbox-delivery', ?, 1, ?)`,
  )
    .bind(id, account.id, body.name, body.slaSeconds ?? null, JSON.stringify(body.config ?? {}))
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
  return json({ ok: true, bindingId: id, accountId: account.id, watchdog: !!body.slaSeconds });
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
  const { results } = await env.DB.prepare(
    `SELECT id, account_id, name, trigger_on, sla_seconds, enabled, config_json FROM agent_bindings
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
      `SELECT b.id, b.account_id, b.name, b.enabled, a.deleted_at
       FROM agent_bindings b JOIN accounts a ON a.id = b.account_id
       WHERE b.account_id = ? AND b.id = ?`,
    )
      .bind(account.id, id)
      .first<BindingRow>();
    return row
      ? { binding: row }
      : { response: json({ error: `no agent binding ${id} on ${email}` }, 404) };
  }

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.account_id, b.name, b.enabled, a.deleted_at
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
  const watchdog = await env.DB.prepare(
    `DELETE FROM responders WHERE account_id = ? AND id = ?`,
  )
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
