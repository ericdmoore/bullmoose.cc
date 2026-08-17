import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

/**
 * `/console/*` — the four routes s03.E requested and this worker now serves.
 *
 * Driven through the WORKER'S OWN `fetch`, not through `handleConsole`: the
 * bearer, `verifyBearer`'s tokens⋈principals⋈accounts⋈grants resolution, the
 * scope gate and the routing are the substance here, and a test that called the
 * handler directly with a hand-built principal would assert the shapes while
 * skipping every gate that makes them safe to return.
 *
 * Fakes are `@bullmoose/test-fakes` (sVOL 002): real node:sqlite over the LIVE
 * schema, so every query below executes as written, foreign keys and all.
 *
 * What these tests are actually about, in order of importance:
 *
 *   1. ISOLATION. `p_eric` owns two accounts; `p_stranger` owns a third, and
 *      Eric additionally holds a grant ON it — so "another account" appears here
 *      in both of its dangerous forms: unreachable (must be notFound) and
 *      grant-REACHED (must be refused, because these routes report who ELSE can
 *      reach an account and a grant to read is not a grant to read the access
 *      list). `authorizeAccount` would say `ok` for the second one; that is
 *      exactly why it is not what gates.
 *   2. The shapes are the client's, verbatim — `consoleContract.test.ts` proves
 *      that end to end against the real console code.
 *   3. Tombstones survive to the wire on the forensic route, because
 *      point-in-time reconstruction is the console's job and it cannot do it
 *      against rows the server already filtered by liveness.
 */

const TENANT = "t_bm";
const ERIC = "eric@bullmoose.cc";
const NOW = Date.now();
const DAY = 86_400_000;
const ago = (d: number): number => NOW - d * DAY;

interface Minted {
  id: string;
  token: string;
  secretHash: string;
}
let full: Minted; // mail + vault
let readOnly: Minted; // read (no vault)
let scopeless: Minted; // nothing — not even read
let agentTok: Minted; // mail + the s10 agent marker
let stranger: Minted; // the other principal's token

beforeAll(async () => {
  [full, readOnly, scopeless, agentTok, stranger] = (await Promise.all([
    mintToken(),
    mintToken(),
    mintToken(),
    mintToken(),
    mintToken(),
  ])) as [Minted, Minted, Minted, Minted, Minted];
});

function token(w: FakeWorker, m: Minted, principalId: string, scopes: string[]): void {
  w.db.seed("tokens", [
    {
      id: m.id,
      principal_id: principalId,
      kind: "bearer",
      secret_hash: m.secretHash,
      name: "test",
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: null,
      last_used_at: NOW,
    },
  ]);
}

/**
 * One deployment: Eric owns his own account AND the agent account `allen@`
 * (the shape the console can actually see — an agent under a separate principal
 * is not reachable by its operator's token, by construction). A stranger owns a
 * third account, and there is one grant in each direction across that line.
 */
function world(): { w: FakeWorker; env: Env } {
  const w = fakeEnv();

  w.db.seedAccount({
    accountId: "acct_eric",
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: ERIC,
    displayName: "Eric",
  });
  w.db.seedAccount({
    accountId: "acct_allen",
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: ERIC,
    displayName: "Allen",
  });
  w.db.seedAccount({
    accountId: "acct_stranger",
    tenantId: TENANT,
    principalId: "p_stranger",
    loginEmail: "dana@example.com",
    displayName: "Dana (contractor)",
  });
  w.db.seed("identities", [
    { id: "id_eric", account_id: "acct_eric", email: ERIC, name: "Eric" },
    { id: "id_allen", account_id: "acct_allen", email: "allen@bullmoose.cc", name: "Allen" },
    { id: "id_dana", account_id: "acct_stranger", email: "dana@example.com", name: "Dana" },
  ]);

  token(w, full, "p_eric", ["mail", "vault"]);
  token(w, readOnly, "p_eric", ["read"]);
  token(w, scopeless, "p_eric", []);
  token(w, agentTok, "p_eric", ["mail", "agent"]);
  token(w, stranger, "p_stranger", ["mail"]);

  w.db.seed("grants", [
    {
      // The superset case: stored as ["mail"], confers six permissions.
      id: "g_allen_mail",
      tenant_id: TENANT,
      grantee_account_id: "acct_allen",
      target_account_id: "acct_eric",
      scopes: JSON.stringify(["mail"]),
      collection: null,
      collection_id: null,
      created_by: "p_eric",
      created_at: ago(120),
      expires_at: null,
      revoked_at: null,
    },
    {
      // Narrow, and REVOKED four days ago — after it was used.
      id: "g_temp_vendors",
      tenant_id: TENANT,
      grantee_account_id: "acct_stranger",
      target_account_id: "acct_eric",
      scopes: JSON.stringify(["contacts"]),
      collection: "AddressBook",
      collection_id: "ab_vendors",
      created_by: "p_eric",
      created_at: ago(30),
      expires_at: null,
      revoked_at: ago(4),
    },
    {
      // Eric REACHES the stranger's account through this one — the grant-reached
      // case every route below must refuse rather than serve.
      id: "g_eric_into_stranger",
      tenant_id: TENANT,
      grantee_account_id: "acct_eric",
      target_account_id: "acct_stranger",
      scopes: JSON.stringify(["read"]),
      collection: null,
      collection_id: null,
      created_by: "p_stranger",
      created_at: ago(10),
      expires_at: null,
      revoked_at: null,
    },
  ]);

  w.db.seed("agent_bindings", [
    {
      id: "ab_1",
      account_id: "acct_allen",
      name: "allen",
      trigger_on: "mailbox-delivery",
      sla_seconds: 120,
      enabled: 1,
      config_json: JSON.stringify({
        pipeline: "reply",
        replyMode: "send",
        persona: "You are Allen.",
        allowedSenders: ["eric@bullmoose.cc"],
        modelAliases: { cheap: [], smart: [] },
      }),
    },
    {
      id: "ab_2",
      account_id: "acct_allen",
      name: "allen-digest",
      trigger_on: "schedule",
      sla_seconds: null,
      enabled: 0,
      config_json: "{not json",
    },
  ]);

  w.db.seed("agent_invocations", [
    {
      id: "inv_9",
      account_id: "acct_allen",
      binding_id: "ab_1",
      binding_name: "allen",
      status: "done",
      email_id: "em_412",
      context_json: JSON.stringify({ envelopeTo: "secret+tag@bullmoose.cc" }),
      result_json: JSON.stringify({ model: "x" }),
      note: null,
      created_at: ago(1),
      done_at: ago(1),
      cost_micros: 1_250_000,
    },
    {
      id: "inv_8",
      account_id: "acct_allen",
      binding_id: "ab_1",
      binding_name: "allen",
      status: "done",
      email_id: "em_410",
      context_json: "{}",
      note: "skipped: noreply@vendor.example not in allowedSenders",
      created_at: ago(3),
      done_at: ago(3),
      // NULL cost — undetermined, and must not be counted as free.
      cost_micros: null,
    },
  ]);

  w.db.seed("vault_credentials", [
    {
      id: "vc_1",
      principal_id: "p_eric",
      name: "aws-mcp",
      kind: "aws-sigv4",
      enc_json: '{"v":1,"iv":"x","ct":"SECRET-CIPHERTEXT"}',
      meta_json: JSON.stringify({
        allow: "https://*.amazonaws.com",
        scope: "actor",
        enforcement: "broad",
        provider: "aws",
      }),
      created_at: ago(200),
      updated_at: ago(12),
    },
    {
      // Pre-contract row: no reserved keys at all.
      id: "vc_2",
      principal_id: "p_eric",
      name: "legacy-key",
      kind: "api-key",
      enc_json: '{"v":1,"iv":"y","ct":"SECRET-CIPHERTEXT"}',
      meta_json: "{}",
      created_at: ago(300),
      updated_at: ago(300),
    },
  ]);

  w.db.seed("bureau_grants", [
    {
      id: "bg_1",
      principal_id: "p_eric",
      cred_name: "aws-mcp",
      verb: "sign_sigv4",
      created_by: "p_eric",
      created_at: ago(200),
      expires_at: null,
      revoked_at: null,
    },
    {
      id: "bg_2",
      principal_id: "p_eric",
      cred_name: "aws-mcp",
      verb: "fetch",
      created_by: "p_eric",
      created_at: ago(200),
      expires_at: null,
      revoked_at: ago(20),
    },
  ]);

  w.db.seed("address_books", [
    {
      id: "ab_vendors",
      account_id: "acct_eric",
      name: "VendorsBook",
      created_at: ago(300),
      updated_at: ago(5),
      last_writer_principal: ERIC,
    },
    {
      id: "ab_theirs",
      account_id: "acct_stranger",
      name: "TheirBook",
      created_at: ago(300),
      updated_at: ago(5),
    },
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_101",
      account_id: "acct_eric",
      address_book_id: "ab_vendors",
      uid: "u101",
      card_json: "{}",
      name_full: "Sparkling Pools LLC",
      created_at: ago(40),
      updated_at: ago(6),
      last_writer_principal: "allen@bullmoose.cc",
      last_writer_binding: "allen",
      last_writer_invocation: "inv_8",
    },
    {
      // common/033: a DAV write. Authenticated, and stamped with nothing.
      id: "cc_102",
      account_id: "acct_eric",
      address_book_id: "ab_vendors",
      uid: "u102",
      card_json: "{}",
      name_full: "Midbury Hardware",
      created_at: ago(40),
      updated_at: ago(5),
    },
  ]);
  w.db.seed("calendars", [
    {
      id: "cal_1",
      account_id: "acct_allen",
      name: "Allen's calendar",
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("mailboxes", [{ id: "mb_1", account_id: "acct_allen", name: "Inbox", role: "inbox" }]);
  w.db.seed("file_nodes", [
    {
      id: "fn_1",
      account_id: "acct_allen",
      parent_id: null,
      name: "Reports",
      node_type: "directory",
      created: 1,
      modified: 1,
      accessed: 1,
      changed: 1,
    },
  ]);

  w.db.seed("grant_audit", [
    {
      grant_id: "g_temp_vendors",
      principal: "dana@example.com",
      account_id: "acct_eric",
      method: "contacts:contacts",
      at: ago(9),
    },
    {
      grant_id: "g_allen_mail",
      principal: "allen@bullmoose.cc",
      account_id: "acct_eric",
      method: "mcp:contacts_upsert_card",
      at: ago(6),
    },
    {
      // A Bureau REFUSAL — nothing authorized it, so grant_id is 'none'.
      grant_id: "none",
      principal: "editor@bullmoose.cc",
      account_id: "acct_eric",
      method: "bureau:fetch:aws-mcp",
      at: ago(2),
    },
    {
      // Another account's trail. Must never appear in Eric's dossier.
      grant_id: "g_other",
      principal: "someone@example.com",
      account_id: "acct_stranger",
      method: "mail:read",
      at: ago(1),
    },
  ]);

  return { w, env: w.env as Env };
}

async function get(
  env: Env,
  path: string,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://app.bullmoose.cc${path}`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }),
    env,
  );
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON — the status is the whole message */
  }
  return { status: res.status, body };
}

// ---- the gate -------------------------------------------------------------

describe("/console/* — the gate", () => {
  const paths = [
    "/console/agents",
    "/console/agents/acct_allen",
    "/console/accounts/acct_allen/resources",
    "/console/resources/AddressBook/ab_vendors?accountId=acct_eric&at=1&since=0",
  ];

  it("401s with no bearer, on every route", async () => {
    const { env } = world();
    for (const p of paths) expect((await get(env, p)).status).toBe(401);
  });

  it("403s a token that does not satisfy `read`, on every route", async () => {
    const { env } = world();
    for (const p of paths) {
      const res = await get(env, p, scopeless.token);
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain('"read" scope');
    }
  });

  it("403s an AGENT-MARKED principal and says where to go instead", async () => {
    // s10's sticky marker. The console serves token inventory, which `015`
    // Rule 4 deliberately kept out of an agent's tool loop.
    const { env } = world();
    for (const p of paths) {
      const res = await get(env, p, agentTok.token);
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("my_access");
    }
  });

  it("refuses anything but GET — there is no console write surface", async () => {
    const { env } = world();
    const res = await worker.fetch(
      new Request("https://app.bullmoose.cc/console/agents", {
        method: "POST",
        headers: { Authorization: `Bearer ${full.token}` },
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("404s an unknown console path rather than falling through to JMAP", async () => {
    const { env } = world();
    expect((await get(env, "/console/nope", full.token)).status).toBe(404);
  });
});

// ---- GET /console/agents --------------------------------------------------

describe("GET /console/agents", () => {
  it("returns the owned accounts that carry bindings, with their counts", async () => {
    const { env } = world();
    const { status, body } = await get(env, "/console/agents", full.token);
    expect(status).toBe(200);
    const agents = body.agents as Array<Record<string, unknown>>;
    // acct_eric owns no binding, so it is not an agent; acct_stranger is not owned.
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      accountId: "acct_allen",
      principalId: "p_eric",
      principal: ERIC,
      displayName: "Allen",
      bindingCount: 2,
      enabledBindingCount: 1,
    });
  });

  it("never lists an account the caller does not own", async () => {
    const { env } = world();
    const { body } = await get(env, "/console/agents", stranger.token);
    // The stranger owns acct_stranger, which has no bindings at all.
    expect(body.agents).toEqual([]);
  });
});

// ---- GET /console/agents/{accountId} --------------------------------------

describe("GET /console/agents/{accountId}", () => {
  it("returns the dossier the per-agent view parses", async () => {
    const { env } = world();
    const { status, body } = await get(env, "/console/agents/acct_allen", full.token);
    expect(status).toBe(200);

    expect(body.accountId).toBe("acct_allen");
    expect(body.principalId).toBe("p_eric");
    expect(body.principal).toBe(ERIC);
    // The union across the principal's live bearer tokens, marker included.
    expect(body.tokenScopes).toEqual(["agent", "mail", "read", "vault"]);

    const bindings = body.bindings as Array<Record<string, unknown>>;
    expect(bindings.map((b) => b.bindingId)).toEqual(["ab_1", "ab_2"]);
    expect(bindings[0]).toMatchObject({
      name: "allen",
      triggerOn: "mailbox-delivery",
      slaSeconds: 120,
      enabled: true,
      config: {
        pipeline: "reply",
        replyMode: "send",
        hasPersona: true,
        senderAllowlist: { active: true, count: 1 },
        modelAliasCount: 2,
      },
    });
    // Derived facts, never the config: the persona text and the allowlisted
    // address are third parties' data and neither reaches the wire.
    expect(JSON.stringify(bindings)).not.toContain("You are Allen");
    expect(JSON.stringify(bindings)).not.toContain("eric@bullmoose.cc");
    // An unparseable blob says so instead of being silently reported as empty.
    expect(bindings[1]?.config).toEqual({
      pipeline: null,
      replyMode: null,
      configUnparseable: true,
    });

    // Grants: what this account reaches, with `mail` expanded to what it does.
    const held = body.grantsHeld as Array<Record<string, unknown>>;
    expect(held).toHaveLength(1);
    expect(held[0]?.grantId).toBe("g_allen_mail");
    expect(held[0]?.scopes).toEqual(["mail"]);
    expect(held[0]?.allows).toEqual(["read", "annotate", "draft", "move", "send", "delete"]);
    expect(held[0]?.target).toEqual({
      accountId: "acct_eric",
      name: "Eric",
      address: ERIC,
    });
    expect(held[0]?.createdAt).toBe(ago(120));
    expect(body.grantsGiven).toEqual([]);

    // Invocations, newest first, without context_json or result_json.
    const invs = body.invocations as Array<Record<string, unknown>>;
    expect(invs.map((i) => i.invocationId)).toEqual(["inv_9", "inv_8"]);
    expect(JSON.stringify(invs)).not.toContain("secret+tag");

    // Spend: one priced row (1.25 USD); the NULL one is not counted as free.
    expect(body.spend).toEqual({
      currency: "USD",
      totalCents: 125,
      rows: 1,
      since: ago(1),
    });
  });

  it("returns credential REFERENCES and never a value", async () => {
    const { env } = world();
    const { body } = await get(env, "/console/agents/acct_allen", full.token);
    const creds = body.credentials as Array<Record<string, unknown>>;
    expect(creds.map((c) => c.name)).toEqual(["aws-mcp", "legacy-key"]);
    expect(creds[0]).toEqual({
      name: "aws-mcp",
      kind: "aws-sigv4",
      allow: "https://*.amazonaws.com",
      header: null,
      scope: "actor",
      enforcement: "broad",
      createdAt: ago(200),
      updatedAt: ago(12),
      // The reserved mint-time keys are surfaced typed, not twice.
      meta: { provider: "aws" },
    });
    // A pre-contract row gets the honest weakest default rather than a null the
    // client's type does not allow.
    expect(creds[1]?.enforcement).toBe("broad");
    expect(creds[1]?.allow).toBeNull();
    // enc_json is not in any SELECT and cannot reach the wire.
    expect(JSON.stringify(body)).not.toContain("SECRET-CIPHERTEXT");

    // Bureau grants come back WITH the tombstone, so a revocation is visible.
    const bg = body.bureauGrants as Array<Record<string, unknown>>;
    expect(bg.map((g) => [g.credRef, g.verb, g.revokedAt])).toEqual([
      ["aws-mcp", "fetch", ago(20)],
      ["aws-mcp", "sign_sigv4", null],
    ]);
  });

  it("withholds credential references from a token without the `vault` scope", async () => {
    // The same gate `/vault/credentials` applies; serving these under `read`
    // would be a scope downgrade with a different door on it.
    const { env } = world();
    const { status, body } = await get(env, "/console/agents/acct_allen", readOnly.token);
    expect(status).toBe(200);
    expect(body.credentials).toEqual([]);
    expect(body.bureauGrants).toEqual([]);
    // …and the rest of the dossier still renders.
    expect((body.bindings as unknown[]).length).toBe(2);
  });

  it("is notFound for an account the token cannot reach", async () => {
    const { env } = world();
    const res = await get(env, "/console/agents/acct_nobody", full.token);
    expect(res.status).toBe(404);
  });

  it("REFUSES an account reached through a grant, with the reason", async () => {
    // `authorizeAccount` would say `ok` here. That is the shortcut this exists
    // to defeat: those rows are about third parties.
    const { env } = world();
    const res = await get(env, "/console/agents/acct_stranger", full.token);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("through a grant, not ownership");
  });

  it("does not leak the other principal's dossier to its own owner's token either way", async () => {
    const { env } = world();
    // The stranger cannot read Eric's agent…
    expect((await get(env, "/console/agents/acct_allen", stranger.token)).status).toBe(404);
    // …and reading their OWN account returns their own rows, not Eric's.
    const own = await get(env, "/console/agents/acct_stranger", stranger.token);
    expect(own.status).toBe(200);
    expect(own.body.credentials).toEqual([]);
    expect(own.body.bindings).toEqual([]);
    const given = own.body.grantsGiven as Array<Record<string, unknown>>;
    expect(given.map((g) => g.grantId)).toEqual(["g_eric_into_stranger"]);
  });
});

// ---- GET /console/accounts/{accountId}/resources --------------------------

describe("GET /console/accounts/{accountId}/resources", () => {
  it("lists this account's collections plus those its grants reach on OWNED accounts", async () => {
    const { env } = world();
    const { status, body } = await get(env, "/console/accounts/acct_allen/resources", full.token);
    expect(status).toBe(200);
    const rs = body.resources as Array<Record<string, unknown>>;
    expect(rs.map((r) => [r.accountId, r.collection, r.collectionId])).toEqual([
      ["acct_allen", "Calendar", "cal_1"],
      ["acct_allen", "FileNode", "fn_1"],
      ["acct_allen", "Mailbox", "mb_1"],
      // Reached through g_allen_mail, and owned by the same operator.
      ["acct_eric", "AddressBook", "ab_vendors"],
    ]);
  });

  it("never lists a collection on an account the caller does not own", async () => {
    // Eric holds a live grant INTO acct_stranger, so it is reachable — and its
    // address book still must not appear, because the dossier behind it is
    // owner-only and a row that 403s when clicked is worse than an absent one.
    const { env } = world();
    const { body } = await get(env, "/console/accounts/acct_eric/resources", full.token);
    const rs = body.resources as Array<Record<string, unknown>>;
    expect(rs.map((r) => r.collectionId)).not.toContain("ab_theirs");
    for (const r of rs) expect(r.accountId).toBe("acct_eric");
  });

  it("refuses a grant-reached account and is notFound for an unreachable one", async () => {
    const { env } = world();
    expect((await get(env, "/console/accounts/acct_stranger/resources", full.token)).status).toBe(
      403,
    );
    expect((await get(env, "/console/accounts/acct_nobody/resources", full.token)).status).toBe(
      404,
    );
  });
});

// ---- GET /console/resources/{collection}/{collectionId} -------------------

const RESOURCE = (q: string): string => `/console/resources/AddressBook/ab_vendors?${q}`;

describe("GET /console/resources/{collection}/{collectionId}", () => {
  it("returns who-could and who-did for the window, tombstones intact", async () => {
    const { env } = world();
    const { status, body } = await get(
      env,
      RESOURCE(`accountId=acct_eric&at=${NOW}&since=${ago(90)}`),
      full.token,
    );
    expect(status).toBe(200);
    expect(body.resource).toEqual({
      collection: "AddressBook",
      collectionId: "ab_vendors",
      name: "VendorsBook",
      accountId: "acct_eric",
    });

    // The whole-account grant covers this book; the narrow one names it. The
    // REVOKED row is on the wire — reconstructing "who could have, six days
    // ago" is the console's job and it needs the tombstone to do it.
    const grants = body.grants as Array<Record<string, unknown>>;
    expect(grants.map((g) => g.grantId).sort()).toEqual(["g_allen_mail", "g_temp_vendors"]);
    const revoked = grants.find((g) => g.grantId === "g_temp_vendors");
    expect(revoked?.revokedAt).toBe(ago(4));
    expect(revoked?.grantee).toEqual({
      accountId: "acct_stranger",
      name: "Dana (contractor)",
      address: "dana@example.com",
    });

    // The trail, newest first — including the Bureau refusal (grant_id 'none'),
    // which looks identical to a success in the table and means the opposite.
    const audit = body.audit as Array<Record<string, unknown>>;
    expect(audit.map((a) => a.grantId)).toEqual(["none", "g_allen_mail", "g_temp_vendors"]);
    // …and never another account's rows.
    for (const a of audit) expect(a.accountId).toBe("acct_eric");

    // Provenance: the book itself, then its cards — nulls intact, because NULL
    // is a recording gap (common/033) and not an anonymous actor.
    const prov = body.provenance as Array<Record<string, unknown>>;
    expect(prov.map((p) => p.recordId)).toEqual(["ab_vendors", "cc_102", "cc_101"]);
    expect(prov[1]).toEqual({
      realm: "contact_cards",
      recordId: "cc_102",
      label: "Midbury Hardware",
      lastWriterPrincipal: null,
      lastWriterBinding: null,
      lastWriterInvocation: null,
      updatedAt: ago(5),
    });
    expect(prov[2]).toMatchObject({
      lastWriterPrincipal: "allen@bullmoose.cc",
      lastWriterBinding: "allen",
      lastWriterInvocation: "inv_8",
    });

    // The directory the forensic view renders audit principals through.
    expect(body.parties).toEqual(
      expect.arrayContaining([
        { accountId: "acct_stranger", name: "Dana (contractor)", address: "dana@example.com" },
      ]),
    );
    // No credential is a resource this picker can name, so there is never a row.
    expect(body.bureauGrants).toEqual([]);
  });

  it("windows the trail — and only the trail", async () => {
    const { env } = world();
    const { body } = await get(
      env,
      RESOURCE(`accountId=acct_eric&at=${NOW}&since=${ago(3)}`),
      full.token,
    );
    const audit = body.audit as Array<Record<string, unknown>>;
    expect(audit.map((a) => a.grantId)).toEqual(["none"]);
    // The grant set is NOT windowed: an earlier `at` must still be answerable.
    expect((body.grants as unknown[]).length).toBe(2);
  });

  it("respects `at` as an upper bound, not just `since`", async () => {
    const { env } = world();
    const { body } = await get(
      env,
      RESOURCE(`accountId=acct_eric&at=${ago(5)}&since=${ago(90)}`),
      full.token,
    );
    const audit = body.audit as Array<Record<string, unknown>>;
    expect(audit.map((a) => a.at)).toEqual([ago(6), ago(9)]);
  });

  it("is notFound for another account's collection id under an account you own", async () => {
    // The isolation that matters: the account id is BOUND into the lookup, so a
    // borrowed collection id resolves to nothing rather than being filtered.
    const { env } = world();
    const res = await get(
      env,
      `/console/resources/AddressBook/ab_theirs?accountId=acct_eric&at=${NOW}&since=${ago(90)}`,
      full.token,
    );
    expect(res.status).toBe(404);
  });

  it("refuses the grant-reached account that actually holds it", async () => {
    const { env } = world();
    const res = await get(
      env,
      `/console/resources/AddressBook/ab_theirs?accountId=acct_stranger&at=${NOW}&since=${ago(90)}`,
      full.token,
    );
    expect(res.status).toBe(403);
  });

  it("400s a missing accountId and 404s a collection it does not serve", async () => {
    const { env } = world();
    expect((await get(env, RESOURCE(`at=${NOW}&since=0`), full.token)).status).toBe(400);
    expect(
      (await get(env, `/console/resources/tokens/x?accountId=acct_eric`, full.token)).status,
    ).toBe(404);
  });

  it("400s a non-numeric instant rather than silently reading `now`", async () => {
    const { env } = world();
    const res = await get(env, RESOURCE("accountId=acct_eric&at=yesterday&since=0"), full.token);
    expect(res.status).toBe(400);
  });
});
