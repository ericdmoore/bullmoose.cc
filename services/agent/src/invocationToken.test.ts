import { describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { issueInvocationToken, parseInvocationToken } from "@bullmoose/auth-core/invocation";
import { fakeEnv } from "@bullmoose/test-fakes";
import davWorker from "../../anglebrackets/src/index";
import agentWorker from "./index";
import jmapWorker from "../../jmap/src/index";
import { handleMcp, TOOLS } from "./mcp";
import { handleVault } from "./vault";
import type { Env } from "./models";

/**
 * s17 — PER-INVOCATION TOKENS, driven as an attacker would drive them.
 *
 * `packages/auth-core/src/invocation.test.ts` proves the grammar and the
 * lifetime. This proves the two things that only exist once real surfaces are
 * involved:
 *
 *  1. **REFUSAL EVERYWHERE ELSE.** The whole argument for a second grammar is
 *     that a credential `verifyBearer` accepts is accepted by EVERY surface,
 *     and no surface but MCP understands an envelope. So a `bmi_` token is
 *     presented to the vault, to JMAP and to CalDAV here and each must 401.
 *     That property is asserted, never assumed: it is bought by `parseToken`
 *     being a strict anchored `^bm_…$`, which is one careless "relax the
 *     regex" away from being lost, and the loss would be silent.
 *
 *  2. **THE ENVELOPE BITES AT MCP.** Tool visibility and tool dispatch both
 *     narrow to `mayUse(effective(node), …)` — recomputed live, ANDed after
 *     the standing check, and denying outright when the chain cannot be read.
 *
 * Every chain below is hand-seeded with direct INSERTs rather than built
 * through `startJob`, and that is the threat model rather than a shortcut:
 * `authority_json` is an ordinary TEXT column, so a gate that is only correct
 * when the harness wrote the column is not a gate (see `nodeAuthority.test.ts`).
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_cj";
const BINDING = "bind_cj";
const PRINCIPAL = "p_cj";
const V = "2026-07-28";

/** Two real MCP tool names, one of which the leaf's delegation gave up. */
const KEPT = "spend_by_month";
const DROPPED = "top_senders";

const CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are CJ.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
  // The binding's ceiling — the first term of every fold below.
  jobs: { tools: [KEPT, DROPPED], credentials: [], budgetMicros: 1_000_000 },
});

const envelope = (tools: string[]) =>
  JSON.stringify({ tools, credentials: [], budgetMicros: 100_000 });

/**
 * root ──┬── leaf     envelope [KEPT]        ← who we mint for
 *        └── sibling  envelope [KEPT, DROPPED]
 *
 * The sibling is WIDER on purpose. It is the prize in the only escalation this
 * design has to refuse: intra-Job envelope-hopping.
 */
async function world() {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: PRINCIPAL,
    loginEmail: "cj@bullmoose.cc",
  });
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "cj", config_json: CONFIG, recipients_book_id: null },
  ]);
  const node = (id: string, parent: string | null, tools: string[]) => ({
    id,
    account_id: ACCOUNT,
    binding_id: BINDING,
    binding_name: "cj",
    status: "running",
    context_json: "{}",
    created_at: 1,
    job_id: "job_1",
    parent_id: parent,
    depth: parent === null ? 0 : 1,
    authority_json: envelope(tools),
  });
  w.db.seed("agent_invocations", [
    node("inv_root", null, [KEPT, DROPPED]),
    node("inv_leaf", "inv_root", [KEPT]),
    node("inv_sib", "inv_root", [KEPT, DROPPED]),
    // Unclaimed, and NOT part of a Job — the ordinary invocation the claim
    // path mints for.
    {
      id: "inv_pending",
      account_id: ACCOUNT,
      binding_id: BINDING,
      binding_name: "cj",
      status: "pending",
      context_json: "{}",
      created_at: 1,
    },
  ]);

  const mint = async (invocationId: string) =>
    (await issueInvocationToken(w.env.DB, { invocationId, accountId: ACCOUNT }))!;

  return {
    w,
    env: w.env as unknown as Env,
    leaf: await mint("inv_leaf"),
    sibling: await mint("inv_sib"),
    mint,
    /** Rewrite a hop's envelope behind the harness's back. */
    corrupt: (id: string, authorityJson: string | null) =>
      w.db.sqlite
        .prepare(`UPDATE agent_invocations SET authority_json = ? WHERE account_id = ? AND id = ?`)
        .run(authorityJson, ACCOUNT, id),
    finish: (id: string) =>
      w.db.sqlite
        .prepare(`UPDATE agent_invocations SET status = 'done' WHERE account_id = ? AND id = ?`)
        .run(ACCOUNT, id),
  };
}

// ---- MCP driving ---------------------------------------------------------

const meta = () => ({
  "io.modelcontextprotocol/protocolVersion": V,
  "io.modelcontextprotocol/clientCapabilities": {},
});

function mcp(env: Env, token: string, body: Record<string, unknown>): Promise<Response> {
  const params = (body.params ?? {}) as Record<string, unknown>;
  return handleMcp(
    new Request("https://agent/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": V,
      },
      body: JSON.stringify({ ...body, params: { ...params, _meta: meta() } }),
    }),
    env,
  );
}

const listTools = async (env: Env, token: string): Promise<string[] | { error: string }> => {
  const res = await mcp(env, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const body = (await res.json()) as {
    result?: { tools: Array<{ name: string }> };
    error?: { message: string };
  };
  if (body.error) return { error: body.error.message };
  return body.result!.tools.map((t) => t.name);
};

const callTool = (env: Env, token: string, name: string) =>
  mcp(env, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: { accountId: ACCOUNT } },
  });

// ---------------------------------------------------------------------------

describe("A bmi_ token is REFUSED by every surface that does not understand invocations", () => {
  it("401s at the vault, at JMAP and at CalDAV — while a bm_ token does not", async () => {
    const s = await world();
    // A real, live `bm_` token for the SAME principal, so each 401 below is
    // attributable to the GRAMMAR and not to an unseeded fixture.
    const bm = await mintToken();
    s.w.db.seed("tokens", [
      {
        id: bm.id,
        principal_id: PRINCIPAL,
        kind: "bearer",
        secret_hash: bm.secretHash,
        name: "device",
        scopes: JSON.stringify(["mail", "vault", "contacts", "calendar"]),
        created_at: 1,
        expires_at: null,
        last_used_at: Date.now(),
      },
    ]);

    const surfaces: Array<{ name: string; hit: (token: string) => Promise<Response> }> = [
      {
        // vault.ts's HAND-ROLLED auth — the copy that funnels through
        // parseToken and is the reason "every reader" is literally true.
        // `GET /vault/credentials` returns every credential row for the
        // principal, gated on the `vault` scope alone: exactly the leak.
        name: "vault",
        hit: (token) =>
          handleVault(
            new Request("https://agent/vault/credentials", {
              headers: { Authorization: `Bearer ${token}` },
            }),
            s.env,
          ),
      },
      {
        name: "jmap",
        hit: (token) =>
          jmapWorker.fetch!(
            new Request("https://jmap.bullmoose.cc/api/jmap", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ using: ["urn:ietf:params:jmap:core"], methodCalls: [] }),
            }),
            s.w.env as never,
          ),
      },
      {
        name: "caldav",
        hit: (token) =>
          davWorker.fetch!(
            new Request("https://dav.bullmoose.cc/dav/", {
              method: "PROPFIND",
              headers: { Authorization: `Bearer ${token}` },
            }),
            s.w.env as never,
          ),
      },
    ];

    for (const surface of surfaces) {
      const refused = await surface.hit(s.leaf);
      expect(refused.status, `${surface.name} accepted a bmi_ token`).toBe(401);
      // The control: the same request with a bm_ token is NOT a 401, so the
      // 401 above is the grammar refusing and not the fixture being empty.
      const accepted = await surface.hit(bm.token);
      expect(accepted.status, `${surface.name} rejected a valid bm_ token`).not.toBe(401);
    }
  });

  it("the invocation token is also refused as a Basic app password", async () => {
    const s = await world();
    const basic = btoa(`cj@bullmoose.cc:${s.leaf}`);
    const res = await davWorker.fetch!(
      new Request("https://dav.bullmoose.cc/dav/", {
        method: "PROPFIND",
        headers: { Authorization: `Basic ${basic}` },
      }),
      s.w.env as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("MCP — the envelope narrows what a bmi_ token can SEE and DO", () => {
  it("tools/list hides a tool the delegation dropped; tools/call refuses it", async () => {
    const s = await world();
    const listed = (await listTools(s.env, s.leaf)) as string[];
    expect(listed).toContain(KEPT);
    expect(listed).not.toContain(DROPPED);
    // Not merely "fewer tools": everything outside the binding's own ceiling
    // is gone too, because the ceiling is the first term of the fold.
    expect(listed).toEqual([KEPT]);

    expect((await callTool(s.env, s.leaf, KEPT)).status).toBe(200);
    const refused = await callTool(s.env, s.leaf, DROPPED);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toMatch(/inv_leaf/);
  });

  it("an ORDINARY bm_ bearer is untouched — no envelope, no narrowing", async () => {
    const s = await world();
    const bm = await mintToken();
    s.w.db.seed("tokens", [
      {
        id: bm.id,
        principal_id: PRINCIPAL,
        kind: "bearer",
        secret_hash: bm.secretHash,
        name: "device",
        scopes: JSON.stringify(["mail"]),
        created_at: 1,
        expires_at: null,
        last_used_at: Date.now(),
      },
    ]);
    const listed = (await listTools(s.env, bm.token)) as string[];
    expect(listed).toHaveLength(TOOLS.length);
  });

  it("NARROWING THE BINDING MID-FLIGHT bites a token that is already open", async () => {
    const s = await world();
    expect((await listTools(s.env, s.leaf)) as string[]).toContain(KEPT);
    // The operator narrows the binding's ceiling. Nothing about the token row
    // or the node's own envelope changed; the effective authority did.
    s.w.db.sqlite
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .run(CONFIG.replace(`"${KEPT}",`, ""), ACCOUNT, BINDING);
    expect((await listTools(s.env, s.leaf)) as string[]).not.toContain(KEPT);
    expect((await callTool(s.env, s.leaf, KEPT)).status).toBe(403);
  });

  it("reaches EXACTLY its own account — naming another one is 'account not found'", async () => {
    const s = await world();
    // A second account the SAME principal owns. A bm_ device token would reach
    // it; an invocation token is bound to the account its binding lives on.
    s.w.db.seedAccount({ accountId: "t_bm__a_second", tenantId: TENANT, principalId: PRINCIPAL });
    const res = await mcp(s.env, s.leaf, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: KEPT, arguments: { accountId: "t_bm__a_second" } },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/account not found/);
  });
});

describe("THE MINT is the claim, and only the claim", () => {
  /** A real device token for the fleet host that claims. */
  async function claimant(s: Awaited<ReturnType<typeof world>>, scopes: string[]) {
    const bm = await mintToken();
    s.w.db.seed("tokens", [
      {
        id: bm.id,
        principal_id: PRINCIPAL,
        kind: "bearer",
        secret_hash: bm.secretHash,
        name: "fleet",
        scopes: JSON.stringify(scopes),
        created_at: 1,
        expires_at: null,
        last_used_at: Date.now(),
      },
    ]);
    return bm.token;
  }

  const claim = async (s: Awaited<ReturnType<typeof world>>, token: string, id: string) => {
    const res = await jmapWorker.fetch!(
      new Request("https://jmap.bullmoose.cc/api/jmap", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:bullmoose:params:jmap:agent"],
          methodCalls: [
            ["AgentInvocation/set", { accountId: ACCOUNT, update: { [id]: { status: "running" } } }, "0"],
          ],
        }),
      }),
      s.w.env as never,
    );
    const body = (await res.json()) as {
      methodResponses: Array<[string, { updated: Record<string, { invocationToken?: string } | null> }, string]>;
    };
    return body.methodResponses[0]![1].updated[id];
  };

  it("the winner of pending→running gets the plaintext, ONCE, in updated[id]", async () => {
    const s = await world();
    const device = await claimant(s, ["mail"]);

    const first = await claim(s, device, "inv_pending");
    const token = first?.invocationToken;
    expect(token).toBeDefined();
    expect(parseInvocationToken(token!)).not.toBeNull();
    // Exactly one row, and it is this invocation's.
    expect(s.w.db.count("agent_invocation_tokens", "invocation_id = ?", "inv_pending")).toBe(1);

    // …and it works: the credential the claim handed back authenticates at MCP.
    const listed = (await listTools(s.env, token!)) as string[];
    expect(listed).toContain(KEPT);
  });

  /**
   * ⚠️ THE BOUNDARY, ASSERTED SO IT CANNOT BE MISTAKEN FOR AN OVERSIGHT.
   *
   * `inv_pending` has no `job_id`, so it is not a delegation, and
   * `effectiveNodeAuthority` answers `delegated: false` with an authority of
   * `{tools: null, …}` — the DefaultCase the Job columns were designed around
   * ("NULL = no envelope = an ordinary invocation"; denying there would strand
   * every ordinary agent on the platform). `mayUse` therefore allows every
   * tool, and the binding's `config_json.jobs` ceiling is never consulted,
   * because that ceiling is defined as the top of a JOB's chain.
   *
   * So for an ordinary invocation the token still narrows a great deal —
   * ONE account instead of every account the principal reaches, no `vault`, no
   * `admin`, no `send`, and a lifetime that ends when the work does — but it
   * does not narrow the TOOL SET. That is the difference between gap 1 being
   * closed (Job nodes) and merely narrowed (everything else), and closing the
   * rest is a decision about what `config_json.jobs` means outside a Job, not
   * a bug in this gate.
   */
  it("an ordinary (non-Job) invocation is NOT a delegation — the tool axis is unbounded", async () => {
    const s = await world();
    const device = await claimant(s, ["mail"]);
    const token = (await claim(s, device, "inv_pending"))!.invocationToken!;
    expect((await listTools(s.env, token)) as string[]).toHaveLength(TOOLS.length);
    // …and the narrowing it DOES buy is real: a second account the same
    // principal owns stays out of reach.
    s.w.db.seedAccount({ accountId: "t_bm__a_second", tenantId: TENANT, principalId: PRINCIPAL });
    const res = await mcp(s.env, token, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: KEPT, arguments: { accountId: "t_bm__a_second" } },
    });
    expect(res.status).toBe(403);
  });

  it("a LOSER of the race mints nothing — the guard is `changes === 1`, not `status`", async () => {
    const s = await world();
    const device = await claimant(s, ["mail"]);
    expect((await claim(s, device, "inv_pending"))?.invocationToken).toBeDefined();

    // Second claim of the same row: the guarded UPDATE matches nothing.
    const second = await claim(s, device, "inv_pending");
    expect(second).toBeUndefined();
    expect(s.w.db.count("agent_invocation_tokens", "invocation_id = ?", "inv_pending")).toBe(1);
  });

  it("the CLOUD DRAIN mints on its own claim, on the same `changes === 1` guard", async () => {
    const s = await world();
    s.w.db.seed("identities", [{ id: "id_cj", account_id: ACCOUNT, email: "cj@bullmoose.cc" }]);
    expect(s.w.db.count("agent_invocation_tokens", "invocation_id = ?", "inv_pending")).toBe(0);

    const res = await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": s.w.env.INTERNAL_TOKEN },
      }),
      s.w.env as never,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);

    // The mint sits BEFORE `runInvocation`, so it does not depend on the
    // pipeline succeeding — what it depends on is winning the claim.
    expect(s.w.db.count("agent_invocation_tokens", "invocation_id = ?", "inv_pending")).toBe(1);
    // …and the row is dead already, because the drain finished the work: the
    // lifetime is the claim's, not the token's.
    expect(
      s.w.db.query<{ status: string }>(
        `SELECT status FROM agent_invocations WHERE id = 'inv_pending'`,
      )[0]!.status,
    ).not.toBe("pending");
  });

  it("completion (done/failed) is not a claim and mints nothing", async () => {
    const s = await world();
    const device = await claimant(s, ["mail"]);
    const res = await jmapWorker.fetch!(
      new Request("https://jmap.bullmoose.cc/api/jmap", {
        method: "POST",
        headers: { Authorization: `Bearer ${device}`, "content-type": "application/json" },
        body: JSON.stringify({
          using: ["urn:ietf:params:jmap:core", "urn:bullmoose:params:jmap:agent"],
          methodCalls: [
            ["AgentInvocation/set", { accountId: ACCOUNT, update: { inv_leaf: { status: "done" } } }, "0"],
          ],
        }),
      }),
      s.w.env as never,
    );
    expect(res.status).toBe(200);
    expect(s.w.db.count("agent_invocation_tokens", "invocation_id = ?", "inv_leaf")).toBe(1); // the one from world()
  });
});

describe("THE THREE ATTACKS", () => {
  it("1. a token forged to name a SIBLING node with a wider envelope is refused", async () => {
    const s = await world();
    // The sibling genuinely holds DROPPED — this is the prize, and it exists.
    expect((await listTools(s.env, s.sibling)) as string[]).toContain(DROPPED);

    // The forgery: the SIBLING's public token id (which an attacker holding
    // the leaf's token can enumerate — ids are not secrets) spliced onto the
    // secret the attacker actually possesses.
    const sibId = parseInvocationToken(s.sibling)!.id.replace("it_", "");
    const leafSecret = parseInvocationToken(s.leaf)!.secret;
    const forged = `bmi_${sibId}_${leafSecret}`;
    expect(parseInvocationToken(forged)).not.toBeNull(); // WELL-FORMED…

    const res = await mcp(s.env, forged, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    // …and unauthenticated. Not "validated then narrowed": a token is bound to
    // ONE invocation id by the hash over its own secret, so there is no
    // request in which naming a sibling is a thing you can do.
    expect(res.status).toBe(401);

    // And the leaf's own real token never acquires the sibling's envelope,
    // however many times it asks.
    expect((await listTools(s.env, s.leaf)) as string[]).not.toContain(DROPPED);
  });

  it("2. a token whose invocation reached `done` between mint and use is refused, with NO DB write", async () => {
    const s = await world();
    expect((await callTool(s.env, s.leaf, KEPT)).status).toBe(200);

    s.finish("inv_leaf");
    const before = s.w.db.writes.length;
    const res = await mcp(s.env, s.leaf, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    // The refusal is a READ. Nothing is stamped, no `grant_audit` row, no
    // `last_used_at` bump — a dead credential must not leave a trail that
    // looks like use.
    expect(s.w.db.writes.length).toBe(before);
    expect((await callTool(s.env, s.leaf, KEPT)).status).toBe(401);
  });

  it("3. a corrupt authority_json MID-CHAIN denies the fold — and the consumer does not read that as 'no envelope'", async () => {
    const s = await world();
    // The ROOT, not the leaf: the corruption is a hop the token holder does
    // not name, and the fold must deny for the whole chain.
    s.corrupt("inv_root", "{ truncated");

    const listed = await listTools(s.env, s.leaf);
    // THE MUTATION THIS TEST EXISTS FOR: a consumer that treated `ok: false`
    // as "there is no envelope to enforce" would return the FULL tool list
    // here — the widest possible answer for the least readable chain.
    expect(Array.isArray(listed)).toBe(false);
    expect((listed as { error: string }).error).toMatch(/unresolvable/);

    const called = await callTool(s.env, s.leaf, KEPT);
    expect(called.status).toBe(403);

    // A hop carrying NO envelope at all denies identically — an unbounded
    // link is not an unrestricted one.
    const s2 = await world();
    s2.corrupt("inv_root", null);
    expect(Array.isArray(await listTools(s2.env, s2.leaf))).toBe(false);
  });
});
