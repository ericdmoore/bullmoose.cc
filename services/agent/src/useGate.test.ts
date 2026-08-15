import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import { expandPlan, getJobNode, startJob } from "./jobs";
import { authorizeNodeUse, effectiveNodeAuthority } from "./useGate";
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
      context_json: string;
      result_json: string | null;
      parent_id: string | null;
      job_id: string | null;
      depth: number | null;
      authority_json: string | null;
    }>(
      `SELECT id, status, context_json, result_json, parent_id, job_id, depth, authority_json
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
