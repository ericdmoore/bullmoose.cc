import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { handleMcp, TOOLS } from "./mcp";

// Handler-level conformance for the stateless-MCP (2026-07-28) surface +
// the §6 auth gate. Per .plans/devPrinciples.md the D1 client is injected,
// so the whole path — verifyBearer → authorizeAccount → tool — runs in plain
// Node against a fake DB with no network. verifyBearer does real crypto over
// a really-minted token, so the auth path is exercised for real, not stubbed.
//
// The DB is @bullmoose/test-fakes (sVOL 002) — real SQLite on the live schema.
// The fixture is now the ROWS, so `verifyBearer`'s tokens⋈principals join, its
// accounts lookup and its grants⋈accounts join all execute as written; the fake
// this replaced answered each of them from a hand-labelled bucket and answered
// every unrecognized query, including a tool's, from a catch-all.

const V = "2026-07-28";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

interface Fixture {
  /** Who the bearer belongs to. */
  principalId?: string;
  loginEmail?: string;
  tokenScopes?: string[];
  /** Accounts this principal owns. */
  accounts?: Array<{ id: string; display_name: string }>;
  /** Cross-account grants reaching the principal's accounts. */
  grants?: Array<{ id: string; grantee_account_id: string; target_account_id: string; scopes: string[] }>;
  /** Accounts that exist but belong to someone else (grant targets). */
  otherAccounts?: Array<{ id: string; display_name: string }>;
  /** Rows the analytics tools read. */
  spend?: Array<Record<string, unknown>>;
}

const TENANT = "t_bm";

const SPEND_ROW = {
  id: "sf_1",
  vendor: "sparkling-pools",
  amount_cents: 4200,
  currency: "USD",
  txn_date: "2026-08-03",
  period_month: "2026-08",
  category: "home",
  confidence: 1,
  dedup_hash: "h1",
  created_at: 1,
};

function world(fx: Fixture) {
  const principalId = fx.principalId ?? "p_eric";
  const w = fakeEnv();

  for (const a of fx.accounts ?? []) {
    w.db.seedAccount({
      accountId: a.id,
      tenantId: TENANT,
      principalId,
      loginEmail: fx.loginEmail ?? "eric@bullmoose.cc",
      displayName: a.display_name,
    });
  }
  for (const a of fx.otherAccounts ?? []) {
    w.db.seedAccount({
      accountId: a.id,
      tenantId: TENANT,
      principalId: `p_owner_${a.id}`,
      loginEmail: `owner-${a.id}@bullmoose.cc`,
      displayName: a.display_name,
    });
  }
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: principalId,
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(fx.tokenScopes ?? ["read"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(), // recent → no last_used write to add noise
    },
  ]);
  w.db.seed(
    "grants",
    (fx.grants ?? []).map((g) => ({
      id: g.id,
      tenant_id: TENANT,
      grantee_account_id: g.grantee_account_id,
      target_account_id: g.target_account_id,
      scopes: JSON.stringify(g.scopes),
      collection: null,
      collection_id: null,
      created_by: "admin",
      created_at: 1,
      expires_at: null,
    })),
  );
  w.db.seed(
    "spend_facts",
    (fx.spend ?? []).map((s) => ({ ...SPEND_ROW, ...s })),
  );
  return w;
}

const ericOwns = (): Fixture => ({
  principalId: "p_eric",
  loginEmail: "eric@bullmoose.cc",
  accounts: [{ id: "a_eric", display_name: "Eric" }],
  spend: [{ account_id: "a_eric" }],
});

const bearer = () => `Bearer ${minted.token}`;
const headers = (over: Record<string, string> = {}) => ({
  Authorization: bearer(),
  "MCP-Protocol-Version": V,
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...over,
});

function call(body: unknown, hdrs: Record<string, string>, fx: Fixture) {
  const w = world(fx);
  const req = new Request("https://agent/mcp/analytics", {
    method: "POST",
    headers: { "content-type": "application/json", ...hdrs },
    body: JSON.stringify(body),
  });
  // No cast: the harness supplies every binding services/agent's Env requires.
  return { res: handleMcp(req, w.env), writes: w.db.writes, db: w.db };
}

describe("handleMcp — MCP.2 transport conformance", () => {
  it("1. server/discover advertises only the stateless version", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() } },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.result.supportedVersions).toEqual([V]);
  });

  it("1b. server/discover describes the surface it actually has", async () => {
    // The third leg of the coupling mcpTools.test.ts guards: `instructions` is
    // what a client shows the model before it picks a tool, and it said
    // "Read-only analytics" until sVOL 013 made that false. Asserted against
    // TOOLS rather than against a remembered string.
    const { res } = call(
      { jsonrpc: "2.0", id: 12, method: "server/discover", params: { _meta: meta() } },
      headers(),
      ericOwns(),
    );
    const b = (await (await res).json()) as any;
    const instructions = b.result.instructions as string;
    // It opened with "Read-only analytics over the bullmoose message log…",
    // which described the WHOLE surface. Read-only may still qualify the
    // analytics half; it may not lead.
    expect(instructions).not.toMatch(/^\s*read-only/i);
    if (TOOLS.some((t) => t.scope !== "read")) {
      expect(instructions).toMatch(/creat/i);
      expect(instructions).toMatch(/delet/i);
    }
    for (const domain of new Set(TOOLS.map((t) => t.domain))) {
      expect(instructions.toLowerCase()).toContain(domain === "mail" ? "message log" : domain);
    }
  });

  it("2. tools/list carries a cache ttl", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta() } },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(Array.isArray(b.result.tools)).toBe(true);
    expect(b.result.ttlMs).toBeGreaterThan(0);
  });

  it("3. rejects a missing MCP-Protocol-Version header", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: meta() } },
      { Authorization: bearer() },
      ericOwns(),
    );
    expect((await res).status).toBe(400);
  });

  it("4. rejects a header/_meta version mismatch", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2025-06-18" }) },
      },
      headers(),
      ericOwns(),
    );
    expect((await res).status).toBe(400);
  });

  it("5. rejects an unsupported version with the supported set", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2025-06-18" }) },
      },
      headers({ "MCP-Protocol-Version": "2025-06-18" }),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(400);
    expect(b.error.code).toBe(-32022);
    expect(b.error.data.supported).toEqual([V]);
  });

  it("6. has no initialize handshake (MCP.v1 is gone)", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 6, method: "initialize", params: { _meta: meta() } },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(404);
    expect(b.error.code).toBe(-32601);
  });
});

describe("handleMcp — §6 auth gate", () => {
  it("7. rejects a request with no bearer", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: meta() } },
      { "MCP-Protocol-Version": V },
      ericOwns(),
    );
    expect((await res).status).toBe(401);
  });

  it("8. runs a tool on an owned account", async () => {
    const { res, writes } = call(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "spend_by_month", arguments: { accountId: "a_eric" }, _meta: meta() },
      },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.result.content[0].type).toBe("text");
    // Owned read is not a delegated read → no grant_audit.
    expect(writes.some((w) => w.sql.includes("grant_audit"))).toBe(false);
  });

  it("9. forbids reading an account the principal cannot see (no data leaks)", async () => {
    const { res, writes } = call(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "spend_by_month", arguments: { accountId: "a_stranger" }, _meta: meta() },
      },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(403);
    expect(b.error).toBeDefined();
    expect(b.result).toBeUndefined();
    expect(writes.some((w) => w.sql.includes("grant_audit"))).toBe(false);
  });

  it("11. actually aggregates the ledger, per month and per currency", async () => {
    // New with the shared harness. The old fake answered the tool's query from
    // a catch-all holding a PRE-aggregated row, so `SUM`, `COUNT`, the
    // GROUP BY and the account filter were all inert — the tool would have
    // returned the fixture unchanged even with the SQL deleted. These rows are
    // raw receipts; the numbers below only appear if the query runs.
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "spend_by_month", arguments: { accountId: "a_eric" }, _meta: meta() },
      },
      headers(),
      {
        ...ericOwns(),
        spend: [
          { account_id: "a_eric", id: "sf_1", amount_cents: 4200, dedup_hash: "h1" },
          { account_id: "a_eric", id: "sf_2", amount_cents: 800, dedup_hash: "h2" },
          // Different month → its own bucket.
          { account_id: "a_eric", id: "sf_3", amount_cents: 100, period_month: "2026-07", dedup_hash: "h3" },
          // Another account's receipt must not be summed into Eric's total.
          { account_id: "a_other", id: "sf_4", amount_cents: 9999, dedup_hash: "h4" },
        ],
        otherAccounts: [{ id: "a_other", display_name: "Someone" }],
      },
    );
    const b = (await res).json() as Promise<any>;
    const rows = JSON.parse((await b).result.content[0].text) as Array<{
      period_month: string;
      currency: string;
      total_cents: number;
      txns: number;
    }>;
    // ORDER BY period_month DESC
    expect(rows).toEqual([
      { period_month: "2026-08", currency: "USD", total_cents: 5000, txns: 2 },
      { period_month: "2026-07", currency: "USD", total_cents: 100, txns: 1 },
    ]);
  });

  it("10. allows and audits a grant-reached read", async () => {
    const rows: Fixture = {
      principalId: "p_allen",
      loginEmail: "allen@bullmoose.cc",
      accounts: [{ id: "a_allen", display_name: "Allen" }],
      // a_eric belongs to someone else; the grant is the only way Allen
      // reaches it, and the tenant/display_name now come from the real
      // grants ⋈ accounts join rather than being pasted into the grant row.
      otherAccounts: [{ id: "a_eric", display_name: "Eric" }],
      grants: [
        { id: "g1", grantee_account_id: "a_allen", target_account_id: "a_eric", scopes: ["read"] },
      ],
      spend: [{ account_id: "a_eric", amount_cents: 1 }],
    };
    const { res, writes } = call(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "spend_by_month", arguments: { accountId: "a_eric" }, _meta: meta() },
      },
      headers(),
      rows,
    );
    const r = await res;
    expect(r.status).toBe(200);
    const audit = writes.find((w) => w.sql.includes("grant_audit"));
    expect(audit).toBeDefined();
    expect(audit!.args).toContain("g1");
    expect(audit!.args).toContain("a_eric");
  });
});
