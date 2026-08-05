import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { handleMcp } from "./mcp";

// Handler-level conformance for the stateless-MCP (2026-07-28) surface +
// the §6 auth gate. Per .plans/devPrinciples.md the D1 client is injected,
// so the whole path — verifyBearer → authorizeAccount → tool — runs in plain
// Node against a fake DB with no network. verifyBearer does real crypto over
// a really-minted token, so the auth path is exercised for real, not stubbed.

type Rows = {
  token?: Record<string, unknown> | null;
  accounts?: unknown[];
  grants?: unknown[];
  tool?: unknown[];
};

/** A fake D1 that routes by SQL and records every write for assertions. */
function fakeD1(rows: Rows) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        if (sql.includes("FROM tokens t JOIN principals")) return rows.token ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM accounts WHERE principal_id")) return { results: rows.accounts ?? [] };
        if (sql.includes("FROM grants g")) return { results: rows.grants ?? [] };
        return { results: rows.tool ?? [] }; // tool queries (spend_facts / emails …)
      },
      async run() {
        writes.push({ sql, args: bound });
        return { meta: { changes: 1 } };
      },
    };
  };
  return { db: { prepare }, writes };
}

const V = "2026-07-28";

let minted: { id: string; token: string; secretHash: string };
beforeAll(async () => {
  minted = await mintToken();
});

const tokenRow = (over: Record<string, unknown> = {}) => ({
  secret_hash: minted.secretHash,
  scopes: JSON.stringify(["read"]),
  expires_at: null,
  last_used_at: Date.now(), // recent → no last_used write to add noise
  principal_id: "p_eric",
  login_email: "eric@bullmoose.cc",
  ...over,
});

const ericOwns = (): Rows => ({
  token: tokenRow(),
  accounts: [{ id: "a_eric", tenant_id: "t_bm", display_name: "Eric" }],
  grants: [],
  tool: [{ period_month: "2026-08", total_cents: 4200, txns: 3 }],
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

function call(body: unknown, hdrs: Record<string, string>, rows: Rows) {
  const { db, writes } = fakeD1(rows);
  const req = new Request("https://agent/mcp/analytics", {
    method: "POST",
    headers: { "content-type": "application/json", ...hdrs },
    body: JSON.stringify(body),
  });
  // Test file is excluded from tsc; the env only needs DB for this handler.
  return { res: handleMcp(req, { DB: db } as unknown as Parameters<typeof handleMcp>[1]), writes };
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

  it("10. allows and audits a grant-reached read", async () => {
    const rows: Rows = {
      token: tokenRow({ principal_id: "p_allen", login_email: "allen@bullmoose.cc" }),
      accounts: [{ id: "a_allen", tenant_id: "t_bm", display_name: "Allen" }],
      grants: [
        {
          id: "g1",
          target_account_id: "a_eric",
          scopes: JSON.stringify(["read"]),
          collection: null,
          collection_id: null,
          tenant_id: "t_bm",
          display_name: "Eric",
        },
      ],
      tool: [{ period_month: "2026-08", total_cents: 1 }],
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
