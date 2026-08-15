import { beforeAll, describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { capResult, handleMcp, TOOLS } from "./mcp";

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

  it("6. initialize is ALIVE and legacy (s02 T2 — this test inverted on purpose)", async () => {
    // It asserted `initialize` was dead, which was correct for a server only
    // we talked to and fatal for one claude.ai must reach: Claude clients
    // open with `initialize`, so a -32601 there ends the connection before
    // any tool is ever listed. The inversion of THIS test is the signal that
    // T2 landed. What must NOT come back is the session machinery — see the
    // legacy-lane suite below.
    const { res } = call(
      { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { Authorization: bearer() },
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.result.protocolVersion).toBe("2025-11-25");
    expect(b.result.capabilities).toEqual({ tools: {} });
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

// s02 T5 — the sleeper blocker. A third-party client has no way to learn a
// bullmoose account id: they are `t_<tenant>__a_<uuid>`, they appear in no
// discovery document, and the tool that would tell you used to need one to
// answer. A model in that position guesses, fails, and gives up. These pin
// the two halves of the fix — resolution is server-side, and the discovery
// entry point takes no arguments — plus the thing that must NOT change: a
// client-supplied id is still never trusted.
describe("handleMcp — accountId resolves server-side (s02 T5)", () => {
  const callTool = (args: Record<string, unknown>, fx: Fixture, id = 20) =>
    call(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: "spend_by_month", arguments: args, _meta: meta() } },
      headers(),
      fx,
    );

  it("20. omitting accountId defaults to the principal's single owned account", async () => {
    const { res } = callTool({}, ericOwns());
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.error).toBeUndefined();
    expect(b.result.isError).toBeUndefined();
  });

  it("21. two owned accounts refuse to be guessed at, and the error NAMES them", async () => {
    // The point of naming: the next call can succeed. An error that says only
    // "accountId is required" sends the model back to where it started.
    const { res } = callTool({}, {
      principalId: "p_eric",
      accounts: [
        { id: "a_eric", display_name: "Eric" },
        { id: "a_work", display_name: "Work" },
      ],
      spend: [{ account_id: "a_eric" }],
    });
    const b = (await (await res).json()) as any;
    expect(b.error.code).toBe(-32602);
    expect(b.error.message).toContain("a_eric");
    expect(b.error.message).toContain("a_work");
  });

  it("22. an owned account wins over a grant-reached one", async () => {
    // Defaulting into someone else's mailbox because you hold a grant on it
    // is the surprise this ordering exists to prevent.
    const { res, writes } = callTool({}, {
      principalId: "p_allen",
      loginEmail: "allen@bullmoose.cc",
      accounts: [{ id: "a_allen", display_name: "Allen" }],
      otherAccounts: [{ id: "a_eric", display_name: "Eric" }],
      grants: [{ id: "g1", grantee_account_id: "a_allen", target_account_id: "a_eric", scopes: ["read"] }],
      spend: [{ account_id: "a_allen" }],
    });
    expect((await res).status).toBe(200);
    // It resolved to the OWNED account, so no grant was traversed to get there.
    expect(writes.some((w) => w.sql.includes("grant_audit"))).toBe(false);
  });

  it("23. a token owning no account refuses rather than resolving to nothing", async () => {
    // Structurally this is also a token with NO reach at all: principal.ts:149
    // only resolves grants when the principal owns an account, because a
    // grantee is an account. So "owns nothing" and "reaches nothing" are the
    // same state, and the message says the actionable half.
    //
    // Reached the way production reaches it — a SOFT-DELETED account. The
    // token and principal rows outlive it (the FK requires as much), and
    // principal.ts:128's `deleted_at IS NULL` is what empties the list.
    const w = world({ principalId: "p_eric", accounts: [{ id: "a_eric", display_name: "Eric" }] });
    w.db.query(`UPDATE accounts SET deleted_at = 1 WHERE id = 'a_eric'`);
    const res = await handleMcp(
      new Request("https://agent/mcp/analytics", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: { name: "spend_by_month", arguments: {}, _meta: meta() },
        }),
      }),
      w.env,
    );
    const b = (await res.json()) as any;
    expect(b.error.code).toBe(-32602);
    expect(b.error.message).toMatch(/owns no account/);
  });

  it("24. a supplied accountId is STILL never trusted — the gate is unchanged", async () => {
    // The defaulting is server-side resolution, not a relaxation. mcp.ts:347's
    // rejection of a self-asserted id has to survive this task intact.
    const { res } = callTool({ accountId: "a_stranger" }, ericOwns());
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(403);
    expect(b.error.code).toBe(-32004);
  });

  it("25. whoami answers with NO arguments at all — it is the discovery entry point", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: meta() } },
      headers(),
      ericOwns(),
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.result.isError).toBeUndefined();
    const answer = JSON.parse(b.result.content[0].text);
    expect(answer.ownedAccounts.map((a: any) => a.accountId)).toEqual(["a_eric"]);
  });

  it("26. whoami works with several owned accounts — where the default would refuse", async () => {
    // The case that makes `accountless` necessary rather than cosmetic: two
    // owned accounts is exactly when defaulting refuses, and it is exactly
    // when you most need the tool that lists them.
    const { res } = call(
      { jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: meta() } },
      headers(),
      {
        principalId: "p_eric",
        accounts: [
          { id: "a_eric", display_name: "Eric" },
          { id: "a_work", display_name: "Work" },
        ],
      },
    );
    const b = (await (await res).json()) as any;
    const answer = JSON.parse(b.result.content[0].text);
    expect(answer.ownedAccounts).toHaveLength(2);
  });

  it("27. whoami is still scope-gated — accountless is not unauthenticated", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 27, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: meta() } },
      headers(),
      { ...ericOwns(), tokenScopes: ["agent"] },
    );
    const r = await res;
    const b = (await r.json()) as any;
    expect(r.status).toBe(403);
    expect(b.error.code).toBe(-32004);
  });
});

// s02 T2 — the dual-era lane. Two things are being asserted at once, and the
// second matters more than the first: that a 2025-era client can complete a
// handshake, and that NONE of the old era's expensive machinery came back
// with it. The parts 2026-07-28 removed — HTTP+SSE, session ids,
// resumability — are exactly the parts this adapter must never grow.
describe("handleMcp — the legacy lane (s02 T2)", () => {
  const legacyHeaders = () => ({ Authorization: bearer() });

  it("30. a 2025 client completes initialize → tools/list → tools/call", async () => {
    // The end-to-end proof, in the order a real client does it. None of these
    // three requests carries the modern per-request envelope.
    const init = call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      legacyHeaders(),
      ericOwns(),
    );
    expect((await init.res).status).toBe(200);

    const list = call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, legacyHeaders(), ericOwns());
    const listBody = (await (await list.res).json()) as any;
    expect(Array.isArray(listBody.result.tools)).toBe(true);

    const callRes = call(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
      legacyHeaders(),
      ericOwns(),
    );
    const callBody = (await (await callRes.res).json()) as any;
    expect(callBody.result.isError).toBeUndefined();
  });

  it("31. echoes back the protocol version the client asked for, when we serve it", async () => {
    for (const v of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
      const { res } = call(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } },
        legacyHeaders(),
        ericOwns(),
      );
      expect(((await (await res).json()) as any).result.protocolVersion).toBe(v);
    }
  });

  it("32. answers an unknown requested version with our preferred one", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      legacyHeaders(),
      ericOwns(),
    );
    expect(((await (await res).json()) as any).result.protocolVersion).toBe("2025-11-25");
  });

  it("33. NEVER mints or echoes a session id — the whole point of the hedge", async () => {
    // If this ever fails, the adapter has started becoming a second protocol
    // implementation and the delete condition can no longer be met.
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...legacyHeaders(), "Mcp-Session-Id": "sess_client_invented_this" },
      ericOwns(),
    );
    const r = await res;
    expect(r.headers.get("Mcp-Session-Id")).toBeNull();
    const b = (await r.json()) as any;
    expect(JSON.stringify(b)).not.toContain("sess_client_invented_this");
    expect(b.result.sessionId).toBeUndefined();
  });

  it("34. advertises tools ONLY — never a capability we do not implement", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      legacyHeaders(),
      ericOwns(),
    );
    const caps = ((await (await res).json()) as any).result.capabilities;
    expect(Object.keys(caps)).toEqual(["tools"]);
    for (const never of ["resources", "prompts", "sampling", "roots", "logging"]) {
      expect(caps[never]).toBeUndefined();
    }
  });

  it("35. ping answers empty — keepalive, no state", async () => {
    const { res } = call({ jsonrpc: "2.0", id: 9, method: "ping" }, legacyHeaders(), ericOwns());
    const b = (await (await res).json()) as any;
    expect(b.result).toEqual({});
  });

  it("36. notifications/initialized is a 202", async () => {
    const { res } = call({ jsonrpc: "2.0", method: "notifications/initialized" }, legacyHeaders(), ericOwns());
    expect((await res).status).toBe(202);
  });

  it("37. the legacy lane still authenticates — it is a protocol shim, not an auth bypass", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      {},
      ericOwns(),
    );
    expect((await res).status).toBe(401);
  });

  it("38. and it still enforces the account gate", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "spend_by_month", arguments: { accountId: "a_stranger" } },
      },
      legacyHeaders(),
      ericOwns(),
    );
    const r = await res;
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe(-32004);
  });
});

// The three conformance defects T2 corrects on the MODERN lane. Each was a
// generic JSON-RPC code where the spec assigns a specific one — the
// difference matters because a client keys its retry on the code, and
// "invalid request" is indistinguishable from a malformed body.
describe("handleMcp — modern-lane conformance codes (s02 T2)", () => {
  it("40. header/_meta mismatch is -32020 HeaderMismatch, not -32600", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" }) },
      },
      headers({ "MCP-Protocol-Version": "2025-06-18" }),
      ericOwns(),
    );
    const r = await res;
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32020);
  });

  it("41. missing clientCapabilities is -32021, not -32602", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": V } },
      },
      headers(),
      ericOwns(),
    );
    const r = await res;
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32021);
  });

  it("42. an Mcp-Method header that disagrees with the body is refused", async () => {
    // The header exists so an intermediary can route without parsing JSON,
    // which only works if the two cannot disagree.
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
      headers({ "Mcp-Method": "tools/call" }),
      ericOwns(),
    );
    const r = await res;
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32020);
  });

  it("43. an Mcp-Method header that AGREES is accepted", async () => {
    const { res } = call(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
      headers({ "Mcp-Method": "tools/list" }),
      ericOwns(),
    );
    expect((await res).status).toBe(200);
  });

  it("44. -32022 unsupported-version still carries the supported set", async () => {
    const { res } = call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta({ "io.modelcontextprotocol/protocolVersion": "2030-01-01" }) },
      },
      headers({ "MCP-Protocol-Version": "2030-01-01" }),
      ericOwns(),
    );
    const b = (await (await res).json()) as any;
    expect(b.error.code).toBe(-32022);
    expect(b.error.data.supported).toEqual([V]);
  });
});

// s02 T6. The MCP.2 surface exists primarily so bullmoose's OWN agents can
// find facts across each other (Eric, 2026-08-13), and both groups below
// serve that: an agent should learn what a tool requires without spending a
// turn on a refusal, and should never mistake a truncated answer for a
// complete one.
describe("tools/list publishes what a caller needs to pre-filter (s02 T6)", () => {
  const list = () =>
    call({ jsonrpc: "2.0", id: 50, method: "tools/list", params: { _meta: meta() } }, headers(), ericOwns());

  it("50. every tool carries its scope and domain", async () => {
    // Stripped before T6, so a caller could only discover the requirement by
    // calling and eating a -32004 — a wasted turn per tool, per agent.
    const b = (await (await list().res).json()) as any;
    expect(b.result.tools.length).toBeGreaterThan(0);
    for (const t of b.result.tools) {
      expect(typeof t.scope, t.name).toBe("string");
      expect(typeof t.domain, t.name).toBe("string");
    }
  });

  it("51. the published scope is the one the gate actually enforces", async () => {
    // The coupling that matters: an advertised requirement differing from the
    // enforced one is worse than none at all.
    const b = (await (await list().res).json()) as any;
    const published = new Map(b.result.tools.map((t: any) => [t.name, `${t.scope}:${t.domain}`]));
    for (const t of TOOLS) {
      expect(published.get(t.name), t.name).toBe(`${t.scope}:${t.domain}`);
    }
  });

  it("52. marks the accountless tools, and only those", async () => {
    // The closed set: whoami (discovery — s02 T5) and revoke_app (the
    // roster is principal property — s02 T4). A new name appearing here is
    // a new tool skipping the account gate, which is exactly what this
    // assertion exists to make deliberate rather than accidental.
    const b = (await (await list().res).json()) as any;
    const flagged = b.result.tools.filter((t: any) => t.accountless).map((t: any) => t.name).sort();
    expect(flagged).toEqual(["revoke_app", "whoami"]);
  });

  it("53. still carries the cache hint", async () => {
    const b = (await (await list().res).json()) as any;
    expect(b.result.ttlMs).toBeGreaterThan(0);
  });
});

describe("oversized results are capped, and say so (s02 T6)", () => {
  it("60. leaves a small result byte-identical", () => {
    expect(capResult('{"a":1}')).toBe('{"a":1}');
  });

  it("61. truncates a huge one and announces it in prose a model will read", () => {
    const capped = capResult("x".repeat(250_000));
    expect(capped.length).toBeLessThan(250_000);
    expect(capped).toContain("truncated by bullmoose");
    expect(capped).toContain("INCOMPLETE");
  });

  it("62. says how much is missing, so the caller can judge the gap", () => {
    expect(capResult("x".repeat(250_000))).toMatch(/150,000 of 250,000 characters omitted/);
  });

  it("63. tells the caller what to DO — a refusal with no next step wastes a turn", () => {
    expect(capResult("x".repeat(250_000))).toMatch(/Narrow the request/);
  });

  it("64. warns the text is no longer parseable, rather than letting it look valid", () => {
    // The failure this prevents: an agent parses a fragment, gets a shorter
    // list than reality, and concludes something false about the account.
    expect(capResult("x".repeat(250_000))).toMatch(/no longer valid JSON/);
  });
});
