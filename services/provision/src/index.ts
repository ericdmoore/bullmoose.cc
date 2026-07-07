import { AwsClient } from "aws4fetch";
import {
  LOGIN_KEY_ALGO,
  LOGIN_KEY_ITERATIONS,
  hashLoginKey,
  isLoginKey,
  loginSaltHex,
  mintToken,
} from "@bullmoose/auth-core";

/**
 * Provision — multi-domain onboarding, fully API-driven (§8 of the design
 * doc). Cloudflare is both DNS and compute, so adding domain #50 is the
 * same call as domain #1.
 *
 * Admin API (Authorization: Bearer <ADMIN_TOKEN>):
 *   POST /tenants               {tenantId, name}
 *   POST /domains               {tenantId, domain}   → runs the wiring steps
 *   GET  /domains/{domain}      → re-checks SES/DKIM verification, flips active
 *   POST /accounts              {tenantId, domain, localpart, displayName}
 *
 * POST /domains is idempotent-ish: each step reports ok/detail so a failed
 * run can simply be re-run after fixing the underlying issue.
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
      if (request.method === "DELETE" && /^\/tokens\/[^/]+$/.test(url.pathname)) {
        return revokeToken(url.pathname.split("/")[2] as string, env);
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

async function listDomains(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT domain, tenant_id, status, created_at FROM domains ORDER BY domain`,
  ).all();
  return json({ domains: results });
}

async function listAccounts(url: URL, env: Env) {
  const tenant = url.searchParams.get("tenant");
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.tenant_id, a.display_name, a.shard, a.created_at,
       (SELECT group_concat(i.email) FROM identities i WHERE i.account_id = a.id) AS addresses
     FROM accounts a
     ${tenant ? "WHERE a.tenant_id = ?" : ""}
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
    await env.DB.prepare(`UPDATE domains SET status = 'active' WHERE domain = ?`)
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

// ---- accounts --------------------------------------------------------

async function createAccount(
  body: { tenantId: string; domain: string; localpart: string; displayName: string },
  env: Env,
) {
  const { tenantId, domain, localpart, displayName } = body;
  const address = `${localpart.toLowerCase()}@${domain}`;
  const now = Date.now();

  // The route row references domains(domain); creating a mailbox on an
  // unwired domain must be a clear client error, not an FK 500.
  const domainRow = await env.DB.prepare(`SELECT tenant_id FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<{ tenant_id: string }>();
  if (!domainRow) {
    return json({ error: `domain ${domain} not onboarded — run POST /domains first` }, 422);
  }
  if (domainRow.tenant_id !== tenantId) {
    return json({ error: `domain ${domain} belongs to a different tenant` }, 422);
  }

  const principalId = `p_${crypto.randomUUID()}`;
  const accountId = `${tenantId}__a_${crypto.randomUUID().slice(0, 8)}`;

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO principals (id, tenant_id, login_email, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(principalId, tenantId, address, now),
    env.DB
      .prepare(
        `INSERT INTO accounts (id, tenant_id, principal_id, display_name, shard, created_at)
         VALUES (?, ?, (SELECT id FROM principals WHERE login_email = ?), ?, 'shard0', ?)`,
      )
      .bind(accountId, tenantId, address, displayName, now),
    env.DB
      .prepare(`INSERT INTO identities (id, account_id, email, name) VALUES (?, ?, ?, ?)`)
      .bind(`identity_${crypto.randomUUID().slice(0, 8)}`, accountId, address, displayName),
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO routes (domain, localpart, kind, target) VALUES (?, ?, 'mailbox', ?)`,
      )
      .bind(domain, localpart.toLowerCase(), accountId),
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

  // Hot copy for the ingest fast path.
  await env.ROUTES.put(
    `route:${domain}:${localpart.toLowerCase()}`,
    JSON.stringify({ kind: "mailbox", accountId, tenantId }),
  );

  return json({ ok: true, accountId, address });
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

  const scopes = body.scopes ?? ["mail"];
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
