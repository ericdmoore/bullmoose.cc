import { describe, expect, it } from "vitest";
import { Mailstore, type ContactWriter } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { jobView } from "@bullmoose/scheduling";
import agentWorker from "./index";
import { startJob } from "./jobs";
import type { Env } from "./models";

/**
 * s11 T7 — the Job DAG, driven end to end through the REAL cloud drain.
 *
 * Nothing here calls a private helper: every assertion is a consequence of
 * `POST /drain` running the same loop production runs, over rows the same
 * schema holds. What is being proven, in order:
 *
 *   1. a planner's output becomes CLAIMABLE SIBLING TASKS, and a join node
 *      synthesizes their results;
 *   2. the aggregate budget stops a runaway fan-out, and maxNodes/maxDepth
 *      stop a runaway planner — with NOTHING created in either case;
 *   3. the attenuation chain is enforced by the HARNESS, not just by the pure
 *      function: an amplifying task refuses the plan at any depth;
 *   4. a failed node blocks its dependents, permanently and by derivation;
 *   5. `needsInfo` pauses ONLY its subtree;
 *   6. a side-effectful leaf still egresses through `/approvals`;
 *   7. DefaultCase: an ordinary invocation is untouched by all of it.
 */

const ACCOUNT = "t_bm__a_job";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";
const BOOK = "ab_reach";
const HUMAN: ContactWriter = { principal: "eric@bullmoose.cc", kind: "human" };

const REPLY_CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are Emily.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
});

const SEND_CONFIG = JSON.stringify({
  ...JSON.parse(REPLY_CONFIG),
  replyMode: "send",
});

interface ScaffoldOpts {
  config?: string;
  /** Give the binding a governing book containing SENDER (for the send path). */
  governed?: boolean;
}

async function scaffold(opts: ScaffoldOpts = {}) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_emily",
      account_id: ACCOUNT,
      name: "emily",
      config_json: opts.config ?? REPLY_CONFIG,
      recipients_book_id: opts.governed ? BOOK : null,
    },
  ]);
  if (opts.governed) {
    w.db.seed("address_books", [
      {
        id: BOOK,
        account_id: ACCOUNT,
        name: "emily may email",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: 1,
        updated_at: 1,
        write_policy: "governed",
      },
    ]);
    await store.insertContactCard(
      ACCOUNT,
      {
        id: "cc_sender",
        addressBookId: BOOK,
        uid: "u_sender",
        card: { uid: "u_sender", emails: { e: { address: SENDER } } },
        nameFull: SENDER,
        davName: null,
        createdAt: 1,
        updatedAt: 1,
      },
      HUMAN,
    );
  }

  const raw = buildMime({
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    subject: "please review",
    messageId: "msg-1@example.com",
    date: new Date(1_000_000),
    text: "Here is my draft, thoughts?",
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(TENANT, ACCOUNT, buf);
  const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
  await store.insertEmail(ACCOUNT, {
    id: "e_thread",
    blobId,
    threadId: "t_1",
    messageId: "msg-1@example.com",
    inReplyTo: null,
    subject: "please review",
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    cc: [],
    bcc: [],
    preview: "Here is my draft, thoughts?",
    size: raw.byteLength,
    receivedAt: 1_000_000,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [inboxId],
    keywords: [],
  });

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
      needs_json: string | null;
      depth: number | null;
      authority_json: string | null;
      parent_id: string | null;
      job_id: string | null;
    }>(
      `SELECT id, status, context_json, result_json, needs_json, depth, authority_json, parent_id, job_id
         FROM agent_invocations WHERE account_id = ? AND job_id IS NOT NULL ORDER BY created_at, id`,
      ACCOUNT,
    );

  /** The root node — the only one with no parent. Ordering never decides it. */
  const root = () => nodes().find((r) => r.parent_id === null)!;

  /** A node, by the plan key the harness stamped into its context. */
  const byKey = (key: string) =>
    nodes().find((r) => (JSON.parse(r.context_json) as { jobKey?: string }).jobKey === key);

  const result = (id: string) =>
    JSON.parse(
      w.db.query<{ result_json: string }>(
        `SELECT result_json FROM agent_invocations WHERE account_id = ? AND id = ?`,
        ACCOUNT,
        id,
      )[0]!.result_json,
    ) as Record<string, unknown>;

  return { w, env: w.env as unknown as Env, drain, nodes, root, byKey, result };
}

const echo = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
  key,
  budgetMicros: 100_000,
  context: { kind: "job-node", op: "echo", text },
  ...extra,
});

/** The Job every test starts from: root planner, aggregate budget, caps. */
async function startPlannerJob(env: Env, plan: unknown, over: Partial<Parameters<typeof startJob>[1]> = {}) {
  return startJob(env, {
    accountId: ACCOUNT,
    bindingId: "bind_emily",
    budgetMicros: 1_000_000,
    maxNodes: 8,
    maxDepth: 2,
    authority: { tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 500_000 },
    rootContext: { kind: "job-node", op: "plan", plan },
    ...over,
  });
}

describe("a planner's output becomes claimable sibling tasks, and a join synthesizes", () => {
  const PLAN = {
    tasks: [
      echo("a", "alpha"),
      echo("b", "beta"),
      {
        key: "join",
        budgetMicros: 100_000,
        needs: ["a", "b"],
        context: { kind: "job-node", op: "join" },
      },
    ],
  };

  it("the plan is produced at RUNTIME (the root is one node until it runs)", async () => {
    const s = await scaffold();
    const started = await startPlannerJob(s.env, PLAN);
    expect(started.ok).toBe(true);
    // Progressive revelation: before the planner runs, the DAG is one node.
    expect(s.nodes()).toHaveLength(1);
    expect(s.root().depth).toBe(0);

    await s.drain();
    const after = s.nodes();
    expect(after).toHaveLength(4);
    expect(after.filter((r) => r.status === "pending")).toHaveLength(3);
  });

  it("the two siblings are SIMULTANEOUSLY claimable and the join is not — the DAG is the ordering", async () => {
    const s = await scaffold();
    await startPlannerJob(s.env, PLAN);
    await s.drain(); // planner

    const a = s.byKey("a")!;
    const b = s.byKey("b")!;
    const join = s.byKey("join")!;
    expect(a.needs_json).toBe("[]");
    expect(JSON.parse(join.needs_json!)).toEqual([a.id, b.id]);
    // Every child hangs off the planner (context + attenuation chain), while
    // `needs` — a DIFFERENT relation — orders execution among siblings.
    expect([a.parent_id, b.parent_id, join.parent_id]).toEqual([s.root().id, s.root().id, s.root().id]);
    expect([a.depth, b.depth, join.depth]).toEqual([1, 1, 1]);

    await s.drain(); // the two unblocked siblings, in one pass
    expect(s.byKey("a")!.status).toBe("done");
    expect(s.byKey("b")!.status).toBe("done");
    expect(s.byKey("join")!.status).toBe("pending"); // released only now
  });

  it("the join node receives its dependencies' RESULTS as context and synthesizes them", async () => {
    const s = await scaffold();
    await startPlannerJob(s.env, PLAN);
    await s.drain();
    await s.drain();
    await s.drain(); // the join

    const join = s.byKey("join")!;
    expect(join.status).toBe("done");
    const out = s.result(join.id);
    expect(out.text).toBe("alpha\nbeta");
    // In the planner's order, not the database's.
    expect(out.inputs).toEqual([s.byKey("a")!.id, s.byKey("b")!.id]);
  });

  it("the Job's status is derived at every stage, and reads `done` at the end", async () => {
    const s = await scaffold();
    const started = await startPlannerJob(s.env, PLAN);
    if (!started.ok) throw new Error("job did not start");
    const view = () => jobView(s.w.env.DB, ACCOUNT, started.jobId);

    expect((await view())!.status).toBe("pending");
    await s.drain();
    expect((await view())!.status).toBe("running");
    await s.drain();
    await s.drain();
    const end = (await view())!;
    expect(end.status).toBe("done");
    expect(end.nodes).toMatchObject({ total: 4, done: 4, blocked: 0 });
    // Structural nodes call no model, so the DAG cost exactly nothing.
    expect(end.spentMicros).toBe(0);
  });
});

describe("the caps stop a runaway planner, and nothing is created", () => {
  it("the AGGREGATE BUDGET refuses a fan-out of individually-legal tasks", async () => {
    const s = await scaffold();
    // Ten tasks × 200_000µ$ = $2.00 against a $1.00 Job budget. Each one is a
    // legal delegation on its own (200_000 ≤ the root's 500_000).
    const plan = {
      tasks: Array.from({ length: 10 }, (_, i) => echo(`t${i}`, "x", { budgetMicros: 200_000 })),
    };
    const started = await startPlannerJob(s.env, plan, { maxNodes: 16 });
    if (!started.ok) throw new Error("job did not start");
    await s.drain();

    expect(s.nodes()).toHaveLength(1); // the planner, and nothing else
    expect(s.root().status).toBe("failed");
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string }>;
    expect(refusals.map((r) => r.axis)).toContain("budget");
    // A refused planner stalls its Job rather than half-running it.
    expect((await jobView(s.w.env.DB, ACCOUNT, started.jobId))!.status).toBe("stalled");
  });

  it("maxNodes refuses the plan that would cross it", async () => {
    const s = await scaffold();
    const plan = { tasks: Array.from({ length: 5 }, (_, i) => echo(`t${i}`, "x")) };
    await startPlannerJob(s.env, plan, { maxNodes: 3 });
    await s.drain();
    expect(s.nodes()).toHaveLength(1);
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string }>;
    expect(refusals.map((r) => r.axis)).toContain("fanout");
  });

  it("maxDepth stops the planner that keeps planning", async () => {
    const s = await scaffold();
    // depth 0 root plans a depth-1 planner, which plans a depth-2 task.
    const nested = { tasks: [echo("leaf", "too deep")] };
    const plan = {
      tasks: [
        {
          key: "sub",
          budgetMicros: 100_000,
          context: { kind: "job-node", op: "plan", plan: nested },
        },
      ],
    };
    const started = await startPlannerJob(s.env, plan, { maxDepth: 1 });
    if (!started.ok) throw new Error("job did not start");

    await s.drain(); // the root planner: allowed, depth 1 == maxDepth
    expect(s.nodes()).toHaveLength(2);
    await s.drain(); // the nested planner: refused at depth 2
    expect(s.nodes()).toHaveLength(2);
    const sub = s.byKey("sub")!;
    expect(sub.status).toBe("failed");
    const refusals = s.result(sub.id).refusals as Array<{ axis: string }>;
    expect(refusals.map((r) => r.axis)).toContain("depth");
  });

  it("the SQL guard refuses even when the pure check read STALE state (the concurrent-planner race)", async () => {
    const s = await scaffold();
    const plan = { tasks: [echo("a", "alpha"), echo("b", "beta")] };
    const started = await startPlannerJob(s.env, plan, { maxNodes: 2 });
    if (!started.ok) throw new Error("job did not start");

    // Simulate the race: another planner filled the Job between the harness's
    // usage read and its INSERT. The lie is told to the usage query ONLY, so
    // `attenuatePlan` sees room that the guarded INSERT will not find.
    const realDb = s.w.env.DB;
    const lying = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("COALESCE(SUM(COALESCE(json_extract(authority_json")) return stmt;
          return new Proxy(stmt, {
            get(st, p, r) {
              if (p !== "bind") return Reflect.get(st, p, r);
              return () => ({ first: async () => ({ n: 0, reserved: 0 }) });
            },
          });
        };
      },
    });
    (s.w.env as { DB: D1Database }).DB = lying as D1Database;

    await s.drain();
    (s.w.env as { DB: D1Database }).DB = realDb;
    // maxNodes is 2 and the root already exists, so ONE task would fit and two
    // do not: the statement is all-or-nothing, so neither lands.
    expect(s.nodes()).toHaveLength(1);
    expect(s.root().status).toBe("failed");
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string }>;
    expect(refusals.map((r) => r.axis)).toContain("fanout");
  });
});

describe("ATTENUATION, enforced by the harness at every depth", () => {
  it("a task asking for a tool its planner does not hold refuses the whole plan", async () => {
    const s = await scaffold();
    const plan = {
      tasks: [echo("honest", "fine", { tools: ["files.read"] }), echo("greedy", "nope", { tools: ["email.send"] })],
    };
    await startPlannerJob(s.env, plan);
    await s.drain();
    expect(s.nodes()).toHaveLength(1); // the honest sibling did not smuggle it through
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string; key: string }>;
    expect(refusals).toEqual([expect.objectContaining({ axis: "tools", key: "greedy" })]);
  });

  it("a child's stored envelope is a SUBSET of its parent's, and the row proves it", async () => {
    const s = await scaffold();
    const plan = {
      tasks: [echo("a", "alpha", { tools: ["files.read"], credentials: [], budgetMicros: 50_000 })],
    };
    await startPlannerJob(s.env, plan);
    await s.drain();
    const child = JSON.parse(s.byKey("a")!.authority_json!) as Record<string, unknown>;
    expect(child).toEqual({ tools: ["files.read"], credentials: [], budgetMicros: 50_000 });
    const rootAuthority = JSON.parse(s.root().authority_json!) as {
      tools: string[];
      budgetMicros: number;
    };
    expect(rootAuthority.tools).toEqual(["files.read"]);
    expect(rootAuthority.budgetMicros).toBe(500_000);
  });

  it("a SUB-task cannot regain what its parent gave up (depth 2 is as safe as depth 1)", async () => {
    const s = await scaffold();
    // The depth-1 planner drops `files.read` and keeps no credentials; its own
    // child then asks for both back.
    const nested = {
      tasks: [echo("grand", "x", { tools: ["files.read"], credentials: ["aws-mcp"] })],
    };
    const plan = {
      tasks: [
        {
          key: "sub",
          tools: [],
          credentials: [],
          budgetMicros: 100_000,
          context: { kind: "job-node", op: "plan", plan: nested },
        },
      ],
    };
    await startPlannerJob(s.env, plan, { maxDepth: 3 });
    await s.drain(); // root planner → the sub-planner exists
    await s.drain(); // sub-planner → refused
    expect(s.nodes()).toHaveLength(2);
    const sub = s.byKey("sub")!;
    expect(sub.status).toBe("failed");
    const axes = (s.result(sub.id).refusals as Array<{ axis: string }>).map((r) => r.axis);
    expect(axes).toEqual(expect.arrayContaining(["tools", "credentials"]));
  });

  it("a task naming ANOTHER binding is refused — agents:invoke stays deferred", async () => {
    const s = await scaffold();
    const plan = { tasks: [echo("delegate", "x", { bindingId: "bind_cj" })] };
    await startPlannerJob(s.env, plan);
    await s.drain();
    expect(s.nodes()).toHaveLength(1);
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string; why: string }>;
    expect(refusals[0]!.axis).toBe("identity");
    expect(refusals[0]!.why).toContain("agents:invoke");
  });

  it("a task minting a RESERVED context kind is refused", async () => {
    const s = await scaffold();
    const plan = {
      tasks: [
        {
          key: "hijack",
          budgetMicros: 10,
          context: { kind: "answer-info-request", proposalId: "p_x" },
        },
      ],
    };
    await startPlannerJob(s.env, plan);
    await s.drain();
    expect(s.nodes()).toHaveLength(1);
    const refusals = s.result(s.root().id).refusals as Array<{ axis: string }>;
    expect(refusals[0]!.axis).toBe("context");
  });
});

describe("composition: failure, and questions", () => {
  it("a FAILED node blocks its dependents — derived, permanent, nothing written", async () => {
    const s = await scaffold();
    const plan = {
      tasks: [
        {
          key: "boom",
          budgetMicros: 100_000,
          context: { kind: "job-node", op: "fail", note: "provider down" },
        },
        echo("sibling", "unaffected"),
        {
          key: "after",
          budgetMicros: 100_000,
          needs: ["boom"],
          context: { kind: "job-node", op: "echo", text: "never" },
        },
      ],
    };
    const started = await startPlannerJob(s.env, plan);
    if (!started.ok) throw new Error("job did not start");

    await s.drain(); // planner
    await s.drain(); // boom (fails) + sibling (succeeds); `after` is blocked
    expect(s.byKey("boom")!.status).toBe("failed");
    expect(s.byKey("sibling")!.status).toBe("done"); // failure blocks DEPENDENTS, not the DAG
    expect(s.byKey("after")!.status).toBe("pending");

    // …and it stays pending however often the drain runs: the block is a
    // property of the rows, not a flag anyone has to maintain.
    await s.drain();
    await s.drain();
    expect(s.byKey("after")!.status).toBe("pending");
    expect((await jobView(s.w.env.DB, ACCOUNT, started.jobId))!.status).toBe("stalled");
  });

  it("needsInfo pauses ONLY its subtree — the sibling branch keeps running", async () => {
    const s = await scaffold();
    const plan = {
      tasks: [
        echo("asked", "answered later"),
        {
          key: "afterAsked",
          budgetMicros: 100_000,
          needs: ["asked"],
          context: { kind: "job-node", op: "echo", text: "downstream" },
        },
        echo("other", "independent"),
        {
          key: "afterOther",
          budgetMicros: 100_000,
          needs: ["other"],
          context: { kind: "job-node", op: "echo", text: "elsewhere" },
        },
      ],
    };
    const started = await startPlannerJob(s.env, plan);
    if (!started.ok) throw new Error("job did not start");
    await s.drain(); // planner
    await s.drain(); // `asked` and `other` run

    // A human meets `asked`'s proposal with a question (s10 T3): the node is
    // `done`, but its work is not finished until the answer lands.
    s.w.db.seed("agent_proposals", [
      {
        id: s.byKey("asked")!.id,
        account_id: ACCOUNT,
        kind: "reply-draft",
        tier: 2,
        rationale: "r",
        status: "info-requested",
        question: "which quarter?",
        created_at: 1,
      },
    ]);

    await s.drain();
    expect(s.byKey("afterAsked")!.status).toBe("pending"); // paused subtree
    expect(s.byKey("afterOther")!.status).toBe("done"); // the rest of the DAG moves
    expect((await jobView(s.w.env.DB, ACCOUNT, started.jobId))!.status).toBe("paused");

    // The answer lands; the subtree resumes with no other state to unwind.
    await s.w.env.DB.prepare(
      `UPDATE agent_proposals SET status = 'pending', question = NULL WHERE account_id = ? AND id = ?`,
    )
      .bind(ACCOUNT, s.byKey("asked")!.id)
      .run();
    await s.drain();
    expect(s.byKey("afterAsked")!.status).toBe("done");
    expect((await jobView(s.w.env.DB, ACCOUNT, started.jobId))!.status).toBe("done");
  });
});

describe("a Job reorganizes work, never its egress", () => {
  it("a side-effectful leaf is an ORDINARY invocation and still exits through /approvals", async () => {
    const s = await scaffold({ config: SEND_CONFIG, governed: true });
    // No `kind` in the context: this task runs the binding's ordinary reply
    // pipeline, which in send mode emits a tier-2 proposal instead of relaying.
    const plan = {
      tasks: [
        {
          key: "reply",
          budgetMicros: 100_000,
          emailId: "e_thread",
          context: { emailId: "e_thread", threadId: "t_1", envelopeTo: SELF },
        },
      ],
    };
    await startPlannerJob(s.env, plan);
    await s.drain(); // planner
    await s.drain(); // the leaf, through the ordinary pipeline

    const leaf = s.byKey("reply")!;
    expect(leaf.status).toBe("done");
    const proposals = s.w.db.query<{ id: string; kind: string; tier: number; status: string }>(
      `SELECT id, kind, tier, status FROM agent_proposals WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(proposals).toEqual([
      expect.objectContaining({ id: leaf.id, kind: "reply-draft", tier: 2, status: "pending" }),
    ]);
    // Nothing was relayed: the proposal IS the door out, exactly as without a Job.
    expect(s.w.submit.calls).toHaveLength(0);
  });
});

describe("DefaultCase: an ordinary invocation is untouched by any of this", () => {
  it("a non-Job invocation drains beside a Job, with all its DAG columns NULL", async () => {
    const s = await scaffold();
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: "e_thread",
        context_json: JSON.stringify({ emailId: "e_thread", threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
      },
    ]);
    await startPlannerJob(s.env, { tasks: [echo("a", "alpha")] });
    await s.drain();
    await s.drain();

    const plain = s.w.db.query<{
      status: string;
      job_id: string | null;
      needs_json: string | null;
      depth: number | null;
    }>(
      `SELECT status, job_id, needs_json, depth FROM agent_invocations WHERE account_id = ? AND id = 'inv_plain'`,
      ACCOUNT,
    )[0]!;
    expect(plain).toEqual({ status: "done", job_id: null, needs_json: null, depth: null });
    expect(s.byKey("a")!.status).toBe("done");
  });

  it("a Job against a DISABLED binding is refused at creation (the 008 interlock)", async () => {
    const s = await scaffold();
    await s.w.env.DB.prepare(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = 'bind_emily'`)
      .bind(ACCOUNT)
      .run();
    const started = await startPlannerJob(s.env, { tasks: [echo("a", "alpha")] });
    expect(started.ok).toBe(false);
    expect(s.w.db.count("jobs")).toBe(0);
  });
});

describe("the binding is the top of the chain", () => {
  it("a binding's declared jobs ceiling caps the ROOT, not merely its children", async () => {
    const s = await scaffold({
      config: JSON.stringify({
        ...JSON.parse(REPLY_CONFIG),
        jobs: {
          tools: ["files.read"],
          credentials: [],
          budgetMicros: 200_000,
          maxNodes: 4,
          maxDepth: 1,
        },
      }),
    });
    const started = await startJob(s.env, {
      accountId: ACCOUNT,
      bindingId: "bind_emily",
      budgetMicros: 1_000_000,
      maxNodes: 8,
      maxDepth: 3,
      // The caller asks for more than the binding allows on every axis.
      authority: {
        tools: ["files.read", "email.send"],
        credentials: ["aws-mcp"],
        budgetMicros: 900_000,
      },
      rootContext: { kind: "job-node", op: "plan", plan: { tasks: [] } },
    });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(new Set(started.refusals.map((r) => r.axis))).toEqual(new Set(["tools", "credentials", "budget"]));
    }

    // Within the binding's ceiling, the Job starts — with the caps narrowed to
    // the binding's, not the caller's.
    const ok = await startJob(s.env, {
      accountId: ACCOUNT,
      bindingId: "bind_emily",
      budgetMicros: 1_000_000,
      maxNodes: 8,
      maxDepth: 3,
      authority: { tools: ["files.read"], credentials: [], budgetMicros: 200_000 },
      rootContext: { kind: "job-node", op: "plan", plan: { tasks: [] } },
    });
    expect(ok.ok).toBe(true);
    const job = s.w.db.query<{ max_nodes: number; max_depth: number; budget_micros: number }>(
      `SELECT max_nodes, max_depth, budget_micros FROM jobs WHERE account_id = ?`,
      ACCOUNT,
    )[0]!;
    expect(job).toEqual({ max_nodes: 4, max_depth: 1, budget_micros: 200_000 });
  });
});

/** Unused import guard: `FakeWorker` documents the harness type above. */
export type _Harness = FakeWorker;
