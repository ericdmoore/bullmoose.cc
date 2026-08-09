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
 *   POST /tenants               {tenantId, name}
 *   POST /domains               {tenantId, domain}   → runs the wiring steps
 *   GET  /domains/{domain}      → re-checks SES/DKIM verification, flips active
 *   POST /accounts              {tenantId, domain, localpart, displayName}
 *
 * POST /domains is idempotent-ish: each step reports ok/detail so a failed
 * run can simply be re-run after fixing the underlying issue. POST /accounts
 * is idempotent outright: re-running it for an address that already has a
 * mailbox returns that mailbox (`created: false`) rather than building a
 * second one — see `createAccount` for why that matters.
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
  const domainRow = await env.DB.prepare(`SELECT tenant_id FROM domains WHERE domain = ?`)
    .bind(domain)
    .first<{ tenant_id: string }>();
  if (!domainRow) {
    return json({ error: `domain ${domain} not onboarded — run POST /domains first` }, 422);
  }
  if (domainRow.tenant_id !== tenantId) {
    return json({ error: `domain ${domain} belongs to a different tenant` }, 422);
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
    `SELECT id, tenant_id, principal_id FROM accounts WHERE id = ?`,
  )
    .bind(route.target)
    .first<{ id: string; tenant_id: string; principal_id: string }>();
  if (!account) return conflict(`its target account ${route.target} no longer exists`);
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
    acct = await accountByAddress(env, email);
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

async function accountWithTenant(env: Env, email: string) {
  return env.DB.prepare(
    `SELECT a.id, a.tenant_id FROM accounts a JOIN identities i ON i.account_id = a.id
     WHERE i.email = ? LIMIT 1`,
  )
    .bind(email.toLowerCase())
    .first<{ id: string; tenant_id: string }>();
}

// ---- agent bindings ----------------------------------------------------

async function accountByAddress(env: Env, email: string) {
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
    const account = await accountByAddress(env, email);
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
