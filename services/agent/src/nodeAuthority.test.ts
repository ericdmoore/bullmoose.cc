import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import {
  authorizeNodeUse,
  effectiveNodeAuthority,
  foldChain,
  type NodeAuthority,
} from "@bullmoose/scheduling";
import agentWorker from "./index";
import { expandPlan, getJobNode, startJob } from "./jobs";
import type { Env } from "./models";

/**
 * s17 — THE USE-TIME GATE, against real rows.
 *
 * `useAuthority.test.ts` proves the arithmetic. This proves the wiring: that
 * the gate reads the ACTUAL delegation chain out of `agent_invocations`, that
 * `expandPlan` is bounded by it rather than by the row it was handed, and that
 * a node whose chain is unreadable fails through the REAL drain rather than
 * running.
 *
 * The adversary here is a row, not a planner. Every test that tampers does it
 * with a direct UPDATE — which is precisely the threat model: `authority_json`
 * is an ordinary TEXT column, and a gate that is only correct when the harness
 * wrote the column is not a gate. (`agents:invoke`, s17 step 2, will be exactly
 * such a second writer.)
 */

const ACCOUNT = "t_bm__a_use";
const TENANT = "t_bm";
const BINDING = "bind_cj";

/** The binding's declared ceiling — the top of every chain in these tests. */
const CONFIG = (jobs: Record<string, unknown> | null = null) =>
  JSON.stringify({
    pipeline: "reply",
    persona: "You are CJ.",
    replyMode: "draft",
    defaultModel: "cheap",
    modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
    ...(jobs ? { jobs } : {}),
  });

const BINDING_JOBS = {
  tools: ["files.read", "email.draft"],
  credentials: ["aws-mcp", "stripe"],
  budgetMicros: 1_000_000,
};

function scaffold(config = CONFIG(BINDING_JOBS)) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "CJ" });
  w.db.seed("identities", [{ id: "id_cj", account_id: ACCOUNT, email: "cj@bullmoose.cc" }]);
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "cj", config_json: config, recipients_book_id: null },
  ]);

  const drain = async () => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
    return (await res.json()) as { handled: number };
  };

  const nodes = () =>
    w.db.query<{
      id: string;
      status: string;
      binding_id: string;
      context_json: string;
      result_json: string | null;
      parent_id: string | null;
      job_id: string | null;
      depth: number | null;
      authority_json: string | null;
    }>(
      `SELECT id, status, binding_id, context_json, result_json, parent_id, job_id, depth, authority_json
         FROM agent_invocations WHERE account_id = ? AND job_id IS NOT NULL ORDER BY created_at, id`,
      ACCOUNT,
    );

  /** Rewrite a row's envelope behind the harness's back. THE threat model. */
  const tamper = (id: string, authorityJson: string | null) =>
    w.db.sqlite
      .prepare(`UPDATE agent_invocations SET authority_json = ? WHERE account_id = ? AND id = ?`)
      .run(authorityJson, ACCOUNT, id);

  /** Narrow the binding's ceiling mid-flight, as an operator would. */
  const narrowBinding = (jobs: Record<string, unknown>) =>
    w.db.sqlite
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .run(CONFIG(jobs), ACCOUNT, BINDING);

  /** A SECOND binding on the account — what a cross-binding chain crosses INTO. */
  const seedBinding = (id: string, jobs: Record<string, unknown> | null, enabled = 1) =>
    w.db.seed("agent_bindings", [
      { id, account_id: ACCOUNT, name: id, config_json: CONFIG(jobs), recipients_book_id: null, enabled },
    ]);

  /**
   * Move ONE node of a chain onto another binding, behind the harness's back.
   *
   * This is the only way to build a cross-binding chain today, and that is the
   * point rather than a shortcut: `attenuateChild` refuses a child on any
   * binding but its parent's, so a direct UPDATE is exactly the shape
   * `agents:invoke` — the second writer this whole module is built against —
   * will have when it is un-deferred. Testing the fold now means the gate is
   * already right on the day that write path exists.
   */
  const rebind = (invocationId: string, bindingId: string) =>
    w.db.sqlite
      .prepare(`UPDATE agent_invocations SET binding_id = ? WHERE account_id = ? AND id = ?`)
      .run(bindingId, ACCOUNT, invocationId);

  const destroyBinding = (id: string) =>
    w.db.sqlite.prepare(`DELETE FROM agent_bindings WHERE account_id = ? AND id = ?`).run(ACCOUNT, id);

  const gate = (id: string) => {
    const row = nodes().find((r) => r.id === id)!;
    return effectiveNodeAuthority(w.env as unknown as Env, ACCOUNT, row);
  };

  const byKey = (key: string) =>
    nodes().find((r) => (JSON.parse(r.context_json) as { jobKey?: string }).jobKey === key);

  const result = (id: string) =>
    JSON.parse(nodes().find((r) => r.id === id)!.result_json ?? "null") as Record<string, unknown>;

  return {
    w,
    env: w.env as unknown as Env,
    drain,
    nodes,
    tamper,
    narrowBinding,
    seedBinding,
    rebind,
    destroyBinding,
    gate,
    byKey,
    result,
    root: () => nodes().find((r) => r.parent_id === null)!,
  };
}

const echo = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  budgetMicros: 100_000,
  context: { kind: "job-node", op: "echo", text: key },
  ...extra,
});

/** A Job whose root holds ONE tool and ONE credential out of the binding's two. */
async function start(env: Env, plan: unknown, over: Record<string, unknown> = {}) {
  const started = await startJob(env, {
    accountId: ACCOUNT,
    bindingId: BINDING,
    budgetMicros: 1_000_000,
    maxNodes: 8,
    maxDepth: 3,
    authority: { tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 500_000 },
    rootContext: { kind: "job-node", op: "plan", plan },
    ...over,
  });
  if (!started.ok) throw new Error(`job did not start: ${JSON.stringify(started.refusals)}`);
  return started;
}

/**
 * root → mid → leaf, all on one binding, all through the real harness.
 * Returns `mid`'s id — the hop the cross-binding tests re-point.
 *
 * `leafPlan` gives the leaf a plan of its own, so a test can prove it never
 * got to expand it.
 */
async function threeDeep(s: ReturnType<typeof scaffold>, leafPlan?: unknown): Promise<string> {
  await start(s.env, {
    tasks: [
      {
        key: "mid",
        tools: ["files.read"],
        credentials: ["aws-mcp"],
        budgetMicros: 200_000,
        context: {
          kind: "job-node",
          op: "plan",
          plan: {
            tasks: [
              {
                key: "leaf",
                tools: ["files.read"],
                credentials: ["aws-mcp"],
                budgetMicros: 50_000,
                context: leafPlan
                  ? { kind: "job-node", op: "plan", plan: leafPlan }
                  : { kind: "job-node", op: "echo", text: "leaf" },
              },
            ],
          },
        },
      },
    ],
  });
  await s.drain(); // the root planner creates `mid`
  await s.drain(); // `mid` expands into `leaf`
  return s.byKey("mid")!.id;
}

// ---------------------------------------------------------------------------

describe("the gate DENIES at use time what the delegation dropped", () => {
  it("a tool the BINDING holds but the node's envelope omits is refused", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });

    // The binding grants `email.draft`; the root's delegation did not take it.
    // Before this gate existed, nothing between the two was ever consulted.
    const allowed = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" });
    expect(allowed.ok).toBe(true);

    const refused = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "email.draft" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.denial.axis).toBe("tools");
      expect(refused.denial.requested).toBe("email.draft");
      expect(refused.note).toContain(rootId);
      expect(refused.note).toMatch(/did not carry email\.draft/);
    }
  });

  it("a credential the binding holds but the node's envelope omits is refused", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "credential", name: "aws-mcp" })).ok).toBe(true);

    const refused = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "credential", name: "stripe" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.axis).toBe("credentials");
  });

  it("a spend over the node's own ceiling is refused, under the Job's aggregate", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "spend", micros: 500_000 })).ok).toBe(true);
    // The Job's aggregate is 1_000_000 and would have allowed this; the NODE's
    // own delegated ceiling is 500_000 and does not.
    const refused = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "spend", micros: 600_000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.axis).toBe("budget");
  });

  it("an unknown invocation is DENIED, not waved through", async () => {
    const s = scaffold();
    const r = await authorizeNodeUse(s.env, ACCOUNT, "inv_nope", { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.axis).toBe("envelope");
  });
});

describe("THE BINDING BOUND — a delegation may not outlive the ceiling above it", () => {
  it("narrowing the binding mid-flight bites work ALREADY in the queue", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" })).ok).toBe(true);

    // The operator narrows the binding. The root row's envelope still says
    // `files.read`; the effective authority no longer does.
    s.narrowBinding({ tools: ["email.draft"], credentials: [], budgetMicros: 10 });

    const refused = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.axis).toBe("tools");
    // ...and the money ceiling narrows with it.
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "spend", micros: 100 })).ok).toBe(false);
  });

  it("a TAMPERED envelope cannot mint a tool the binding never granted", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    // A second writer (a repair script, a future `agents:invoke`) puts a tool
    // in the row that no ancestor and no binding ever held.
    s.tamper(rootId, JSON.stringify({ tools: ["root.shell"], credentials: [], budgetMicros: 1 }));

    const r = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "root.shell" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.axis).toBe("tools");
  });
});

/**
 * EVERY BINDING THE CHAIN CROSSES IS A TERM — not just the acting node's.
 *
 * Unreachable through the harness today: `attenuateChild` refuses a child on
 * any binding but its parent's, so every chain in the product is
 * single-binding and the intersection has one member. It stops being
 * unreachable the moment `agents:invoke` is un-deferred, because agent→agent
 * delegation IS a chain that spans bindings — and a gate that folds only the
 * LEAF's binding would then hold B's ceiling with A's silently dropped. That
 * is the widest hop winning instead of the narrowest, and it would break
 * "narrowing a binding bites work already in the queue" for precisely the
 * delegated work the invariant is for.
 *
 * So these chains are built the way that second writer will build them: a
 * direct UPDATE of `binding_id`, the same threat model as `tamper` above.
 */
describe("CROSS-BINDING chains fold to the NARROWEST binding they pass through", () => {
  it("ADVERSARIAL: the ANCESTOR holds the narrow binding — folding the leaf's alone re-grants what the ancestor gave up", async () => {
    const s = scaffold();
    // No tools, no credentials, and a money ceiling NO other term in this
    // chain holds — so every axis below can only have come from here.
    s.seedBinding("bind_narrow", { tools: [], credentials: [], budgetMicros: 25_000 });
    await start(s.env, { tasks: [echo("a", { tools: ["files.read"], credentials: ["aws-mcp"] })] });
    await s.drain();

    const leaf = s.byKey("a")!;
    // Everything the OLD fold consulted says yes: the leaf's own envelope
    // genuinely carries `files.read`, and the leaf's own binding is the wide
    // one. Only the ancestor's binding says no.
    expect(JSON.parse(leaf.authority_json!).tools).toEqual(["files.read"]);
    expect(leaf.binding_id).toBe(BINDING);

    s.rebind(s.root().id, "bind_narrow");

    const eff = await s.gate(leaf.id);
    expect(eff.ok).toBe(true);
    if (eff.ok) {
      expect(eff.effective.tools).toEqual([]);
      expect(eff.effective.credentials).toEqual([]);
      // 25_000 is bind_narrow's and nothing else's — the envelopes say 100_000
      // and 500_000, the leaf's binding says 1_000_000.
      expect(eff.effective.budgetMicros).toBe(25_000);
    }

    const refused = await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "tool", name: "files.read" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.axis).toBe("tools");
  });

  it("THREE HOPS with the narrowest in the MIDDLE — neither end of the chain is the answer", async () => {
    const s = scaffold();
    s.seedBinding("bind_mid", { tools: ["files.read"], credentials: [], budgetMicros: 7 });
    await start(s.env, {
      tasks: [
        {
          key: "mid",
          tools: ["files.read"],
          credentials: ["aws-mcp"],
          budgetMicros: 200_000,
          context: {
            kind: "job-node",
            op: "plan",
            plan: {
              tasks: [echo("leaf", { tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 50_000 })],
            },
          },
        },
      ],
    });
    await s.drain(); // the root planner creates `mid`
    await s.drain(); // `mid` expands into `leaf`

    const leaf = s.byKey("leaf")!;
    s.rebind(s.byKey("mid")!.id, "bind_mid");
    // The two ENDS of the chain both still run under the wide binding.
    expect(s.root().binding_id).toBe(BINDING);
    expect(leaf.binding_id).toBe(BINDING);

    // `aws-mcp` is in every envelope in this chain AND in both end bindings.
    // Only the middle hop's binding drops it.
    const cred = await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "credential", name: "aws-mcp" });
    expect(cred.ok).toBe(false);
    if (!cred.ok) expect(cred.denial.axis).toBe("credentials");

    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "tool", name: "files.read" })).ok).toBe(true);
    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "spend", micros: 7 })).ok).toBe(true);
    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "spend", micros: 8 })).ok).toBe(false);

    const eff = await s.gate(leaf.id);
    if (eff.ok) expect(eff.effective).toEqual({ tools: ["files.read"], credentials: [], budgetMicros: 7 });
  });

  it("a DISABLED binding mid-chain DENIES — the kill switch is not 'no ceiling'", async () => {
    const s = scaffold();
    // Deliberately declares NO `jobs` ceiling. If `enabled` went unchecked
    // this binding would contribute the identity element and the chain would
    // fold to exactly what it folds to with no second binding at all — the
    // revocation would be invisible rather than wrong, which is worse.
    s.seedBinding("bind_off", null, 0);
    const mid = await threeDeep(s);
    s.rebind(mid, "bind_off");

    const leaf = s.byKey("leaf")!;
    const r = await s.gate(leaf.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.requested).toContain("bind_off");
      expect(r.denial.requested).toMatch(/hop 2 of 3/);
      expect(r.denial.why).toMatch(/DISABLED/);
      expect(r.note).toContain(leaf.id);
    }
    // And the per-axis gate refuses with it, rather than falling through.
    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "tool", name: "files.read" })).ok).toBe(false);
  });

  it("a MISSING binding mid-chain DENIES — a destroyed ceiling is unknown, not absent", async () => {
    const s = scaffold();
    s.seedBinding("bind_gone", { tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 1_000_000 });
    const mid = await threeDeep(s);
    s.rebind(mid, "bind_gone");

    const leaf = s.byKey("leaf")!;
    // While the row is there the chain folds fine — so the denial below is the
    // ROW's absence and nothing else about the rebinding.
    expect((await s.gate(leaf.id)).ok).toBe(true);

    s.destroyBinding("bind_gone");
    const r = await s.gate(leaf.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.requested).toContain("bind_gone");
      expect(r.denial.why).toMatch(/no longer exists/);
    }
  });

  it("a node whose ANCESTOR's binding was revoked FAILS through the real drain instead of running", async () => {
    const s = scaffold();
    s.seedBinding("bind_off", null, 0);
    const mid = await threeDeep(s, { tasks: [echo("tail")] });
    s.rebind(mid, "bind_off");

    await s.drain();
    // `leaf` never expanded its own plan; it failed its pre-flight with the
    // structured denial, exactly as an unreadable envelope does.
    expect(s.byKey("tail")).toBeUndefined();
    const leaf = s.byKey("leaf")!;
    expect(leaf.status).toBe("failed");
    expect(s.result(leaf.id).denial).toMatchObject({ axis: "envelope" });
  });
});

/**
 * THE REGRESSION NET. Every chain that exists in the product today is
 * single-binding, so the new fold has to agree with the old one on all of
 * them — not approximately, and not only on the ok/denied verdict.
 */
describe("SAME-BINDING chains fold to exactly what they folded to before", () => {
  /** The pre-change first term: the acting node's binding, and only it. */
  const ONLY_THE_LEAFS_BINDING: NodeAuthority = {
    tools: BINDING_JOBS.tools,
    credentials: BINDING_JOBS.credentials,
    budgetMicros: BINDING_JOBS.budgetMicros,
  };

  it("every node of a three-deep Job matches the PRE-CHANGE formula, recomputed", async () => {
    const s = scaffold();
    await threeDeep(s);
    const rows = s.nodes();
    expect(rows).toHaveLength(3);

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const row of rows) {
      expect(row.binding_id).toBe(BINDING);
      // The envelopes, ROOT-FIRST, walked the way the gate walks them.
      const envelopes: Array<string | null> = [];
      for (let cur = row; ; ) {
        envelopes.unshift(cur.authority_json);
        if (cur.parent_id === null) break;
        cur = byId.get(cur.parent_id)!;
      }
      const oracle = foldChain(ONLY_THE_LEAFS_BINDING, envelopes);
      expect(oracle.ok).toBe(true);
      expect(await s.gate(row.id)).toEqual({
        ok: true,
        delegated: true,
        effective: oracle.ok ? oracle.authority : undefined,
      });
    }
  });

  it("...and the leaf matches a FROZEN literal, so the oracle is not marking its own homework", async () => {
    const s = scaffold();
    await threeDeep(s);
    const eff = await s.gate(s.byKey("leaf")!.id);
    expect(eff.ok).toBe(true);
    if (eff.ok) {
      expect(eff.effective).toEqual({ tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 50_000 });
    }
  });
});

describe("FAIL CLOSED — an unreadable chain denies, and the node does not run", () => {
  it("a MALFORMED envelope denies every use", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    s.tamper(rootId, "{not json");

    const r = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.why).toMatch(/unreadable/);
    }
  });

  it("an ABSENT envelope on a Job node denies — absent is not unrestricted", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    s.tamper(rootId, null);

    const r = await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.axis).toBe("envelope");
      expect(r.denial.why).toMatch(/NO authority envelope/);
    }
  });

  it("a node with an unreadable chain FAILS through the real drain instead of running", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a"), echo("b")] });
    s.tamper(rootId, "{oops");

    await s.drain();
    // The planner did not expand: no children exist, and the node is failed
    // with a legible, structured denial rather than a silent shorter tool list.
    expect(s.nodes()).toHaveLength(1);
    const out = s.result(rootId);
    expect(s.root().status).toBe("failed");
    expect(String(out.note)).toMatch(/authority refused/);
    expect(out.denial).toMatchObject({ axis: "envelope" });
  });

  it("a chain whose PARENT vanished denies — half a chain bounds nothing", async () => {
    const s = scaffold();
    await start(s.env, { tasks: [echo("a")] });
    await s.drain(); // the planner expands
    const child = s.byKey("a")!;
    s.w.db.sqlite
      .prepare(`DELETE FROM agent_invocations WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, child.parent_id);

    const r = await authorizeNodeUse(s.env, ACCOUNT, child.id, { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.why).toMatch(/does not exist/);
  });

  it("a CYCLE in parent_id denies rather than spinning", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    await s.drain();
    const child = s.byKey("a")!;
    // Point the root at its own child: root → child → root → …
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET parent_id = ? WHERE account_id = ? AND id = ?`)
      .run(child.id, ACCOUNT, rootId);

    const r = await authorizeNodeUse(s.env, ACCOUNT, child.id, { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.axis).toBe("envelope");
  });

  it("a parent GRAFTED onto another Job denies — no inheriting a foreign ceiling", async () => {
    const s = scaffold();
    const first = await start(s.env, { tasks: [echo("a")] });
    await s.drain();
    const child = s.byKey("a")!;
    // A second Job, then re-point the child's parent at the first Job's root
    // while leaving the child in its own Job. The chain must refuse to cross.
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET job_id = ? WHERE account_id = ? AND id = ?`)
      .run("job_elsewhere", ACCOUNT, first.rootId);

    const r = await authorizeNodeUse(s.env, ACCOUNT, child.id, { kind: "tool", name: "files.read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.why).toMatch(/another Job's ceiling/);
  });
});

describe("RE-DELEGATION cannot widen — the chain is recomputed, not believed", () => {
  it("a two-hop chain: hop 2's TAMPERED row cannot re-grant what hop 1 dropped", async () => {
    const s = scaffold();
    await start(s.env, { tasks: [{ key: "mid", budgetMicros: 200_000, context: { kind: "job-node", op: "plan", plan: { tasks: [echo("leaf", { tools: ["email.draft"] })] } } }] });
    await s.drain(); // hop 1: the root planner creates `mid`

    const mid = s.byKey("mid")!;
    // `mid` legitimately holds NO tools (rule 2: omission is the empty set).
    expect(JSON.parse(mid.authority_json!).tools).toEqual([]);

    // Now tamper: give `mid`'s row every tool the binding has. Its own plan
    // asks for `email.draft` — legal against the tampered row, illegal against
    // the chain, because the ROOT gave `email.draft` up.
    s.tamper(mid.id, JSON.stringify({ tools: ["files.read", "email.draft"], credentials: [], budgetMicros: 200_000 }));

    await s.drain(); // hop 2: `mid` tries to expand
    expect(s.byKey("leaf")).toBeUndefined();
    expect(s.nodes().find((r) => r.id === mid.id)!.status).toBe("failed");
    const refusals = s.result(mid.id).refusals as Array<{ axis: string; why: string }>;
    expect(refusals.map((r) => r.axis)).toContain("tools");
  });

  it("hop 2 CAN still delegate what the chain genuinely left it", async () => {
    const s = scaffold();
    await start(s.env, {
      tasks: [
        {
          key: "mid",
          tools: ["files.read"],
          budgetMicros: 200_000,
          context: {
            kind: "job-node",
            op: "plan",
            plan: { tasks: [echo("leaf", { tools: ["files.read"], budgetMicros: 50_000 })] },
          },
        },
      ],
    });
    await s.drain(); // the root planner
    await s.drain(); // `mid` expands

    expect(s.byKey("leaf")).toBeDefined();
    expect(JSON.parse(s.byKey("leaf")!.authority_json!).tools).toEqual(["files.read"]);
    // And the leaf's effective authority is the intersection, all the way up.
    const eff = await authorizeNodeUse(s.env, ACCOUNT, s.byKey("leaf")!.id, {
      kind: "tool",
      name: "files.read",
    });
    expect(eff.ok).toBe(true);
    if (eff.ok) expect(eff.effective.budgetMicros).toBe(50_000);
    expect((await authorizeNodeUse(s.env, ACCOUNT, s.byKey("leaf")!.id, { kind: "tool", name: "email.draft" })).ok).toBe(false);
  });

  it("expandPlan REFUSES on its own when the chain is unreadable — the chokepoint does not lean on its caller", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    s.tamper(rootId, "{oops");
    // Called directly, past the drain's pre-flight: a chokepoint that is only
    // correct because something else checked first is not a chokepoint.
    const node = (await getJobNode(s.env, ACCOUNT, rootId))!;
    const r = await expandPlan(s.env, node, { tasks: [echo("a")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.axis)).toEqual(["envelope"]);
    expect(s.nodes()).toHaveLength(1);
  });

  it("a corrupt SIBLING cannot make another node's plan unanswerable", async () => {
    const s = scaffold();
    await start(s.env, { tasks: [echo("a"), { key: "mid", tools: ["files.read"], budgetMicros: 200_000, context: { kind: "job-node", op: "plan", plan: { tasks: [echo("leaf", { budgetMicros: 10_000 })] } } }] });
    await s.drain(); // the root planner creates `a` and `mid`
    // Corrupt an unrelated sibling's envelope. `json_extract` throws on
    // malformed JSON, so before the `json_valid` guard this took the whole
    // expansion down with a SQLite error rather than a refusal.
    s.tamper(s.byKey("a")!.id, "{oops");

    await s.drain(); // `mid` expands, and `a` fails its own pre-flight
    expect(s.byKey("leaf")).toBeDefined();
    expect(s.byKey("mid")!.status).toBe("done");
    expect(s.byKey("a")!.status).toBe("failed");
  });

  it("narrowing the BINDING refuses a plan that was legal when the Job started", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a", { tools: ["files.read"] })] });
    s.narrowBinding({ tools: [], credentials: [], budgetMicros: 1_000_000 });

    await s.drain();
    expect(s.byKey("a")).toBeUndefined();
    expect(s.root().status).toBe("failed");
    const refusals = s.result(rootId).refusals as Array<{ axis: string }>;
    expect(refusals.map((r) => r.axis)).toContain("tools");
  });
});

describe("DefaultCase — an ordinary invocation is untouched by any of it", () => {
  it("an invocation with no job_id is not a delegation and is not gated", async () => {
    const s = scaffold();
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: BINDING,
        binding_name: "cj",
        status: "pending",
        email_id: null,
        context_json: "{}",
        created_at: 1,
      },
    ]);
    const r = await authorizeNodeUse(s.env, ACCOUNT, "inv_plain", { kind: "tool", name: "anything" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delegated).toBe(false);
      // No chain, so no ceiling of its own: the binding's own gates — the
      // governing book, the token's scopes, bureau_grants — still govern it,
      // exactly as before Jobs existed.
      expect(r.effective).toEqual({ tools: null, credentials: null, budgetMicros: null });
    }
  });

  it("a binding with NO `jobs` ceiling still runs Jobs, bounded by the chain alone", async () => {
    const s = scaffold(CONFIG(null));
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    // Unset binding ceiling widens nothing: the root's own delegation binds.
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "files.read" })).ok).toBe(true);
    expect((await authorizeNodeUse(s.env, ACCOUNT, rootId, { kind: "tool", name: "email.draft" })).ok).toBe(false);
  });

  it("a binding with an UNPARSEABLE config reads as unset, and narrows nothing below it", async () => {
    const s = scaffold();
    const { rootId } = await start(s.env, { tasks: [echo("a")] });
    s.w.db.sqlite
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .run("{broken", ACCOUNT, BINDING);
    const r = await effectiveNodeAuthority(s.env, ACCOUNT, {
      id: rootId,
      binding_id: BINDING,
      job_id: "job_x",
      parent_id: null,
      authority_json: JSON.stringify({ tools: ["files.read"], credentials: [], budgetMicros: 1 }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.effective.tools).toEqual(["files.read"]);
  });

  it("an ordinary Job still runs end to end — the gate is a bound, not a brake", async () => {
    const s = scaffold();
    await start(s.env, {
      tasks: [
        echo("a"),
        echo("b"),
        { key: "join", budgetMicros: 100_000, needs: ["a", "b"], context: { kind: "job-node", op: "join" } },
      ],
    });
    await s.drain();
    await s.drain();
    await s.drain();
    expect(s.nodes().filter((r) => r.status === "done")).toHaveLength(4);
  });
});
