import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore, type ContactWriter } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import { jobView } from "@bullmoose/scheduling";
import agentWorker, { escalateOverdue } from "./index";
import { startJob } from "./jobs";
import { authorizeNodeUse } from "./useGate";
import { registerActionProposalMethods } from "../../jmap/src/methods/actionProposal";
import type { RequestContext } from "../../jmap/src/methods/common";
import type { Env } from "./models";

/**
 * s17 — THE LAUNDERING PATH THROUGH A HUMAN'S QUESTION.
 *
 * The attack is three ordinary steps, none of which looks like an attack:
 *
 *   1. a node inside a Job holds a NARROWED envelope — the binding grants
 *      `email.draft`, the delegation did not take it;
 *   2. that node's work egresses as a proposal (`/approvals`, as every Job's
 *      side-effectful leaf does — jobs-and-facets §8.3);
 *   3. a human meets the proposal with a QUESTION instead of a verdict, and the
 *      answer round that gets enqueued is a brand-new invocation.
 *
 * Before this file, step 3 minted that round with `binding_id` and nothing
 * else: no `job_id`, so `useGate.ts` read it as "not a delegation" and enforced
 * nothing — the DefaultCase, arrived at from INSIDE a Job. The narrowed node
 * could not exceed its envelope, but it could cause an invocation that had
 * never heard of one, on the same binding, with the binding's full reach.
 * Attenuation was not exceeded, it was sidestepped.
 *
 * Everything below runs through the REAL surfaces: the real `startJob`, the
 * real drain (`POST /drain`), the real JMAP `ActionProposal/set`, and the real
 * gate. The only direct SQL is the tampering, which is the threat model
 * (`useGate.test.ts`: "the adversary here is a row, not a planner").
 */

const ACCOUNT = "t_bm__a_ask";
const TENANT = "t_bm";
const BINDING = "bind_cj";
const SELF = "cj@bullmoose.cc";
const SENDER = "human@example.com";
const BOOK = "ab_reach";
const HUMAN: ContactWriter = { principal: "eric@bullmoose.cc", kind: "human" };

/**
 * The binding grants TWO tools, TWO credentials and a million micro-dollars.
 * Every "did the round regain it?" assertion below names something from this
 * list that the delegation deliberately dropped.
 */
const BINDING_JOBS = {
  tools: ["files.read", "email.draft"],
  credentials: ["aws-mcp", "stripe"],
  budgetMicros: 1_000_000,
};

const CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are CJ.",
  // `send` mode is what makes the leaf emit a tier-2 proposal instead of
  // relaying — the proposal is the thing a human can ask a question about.
  replyMode: "send",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
  jobs: BINDING_JOBS,
});

async function scaffold() {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "CJ" });
  w.db.seed("identities", [{ id: "id_cj", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    { id: BINDING, account_id: ACCOUNT, name: "cj", config_json: CONFIG, recipients_book_id: BOOK },
  ]);
  // The governing book — a send-mode binding with no book cannot email anyone,
  // so without this the leaf skips instead of proposing (s10 T1).
  w.db.seed("address_books", [
    {
      id: BOOK,
      account_id: ACCOUNT,
      name: "cj may email",
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
    bodyText: "Here is my draft, thoughts?",
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

  // The HUMAN's decision surface, registered exactly as the jmap worker does.
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  const ctx: RequestContext = {
    env: w.env as unknown as RequestContext["env"],
    principal: {
      username: "eric@login.example",
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "CJ" }],
    },
  };
  const needsInfo = (id: string, question: string) =>
    registry.get("ActionProposal/set")!(
      { accountId: ACCOUNT, update: { [id]: { status: "info-requested", question } } },
      ctx,
    ) as Promise<{ updated: Record<string, null>; notUpdated: Record<string, { type: string }> }>;

  interface Row {
    id: string;
    status: string;
    context_json: string;
    result_json: string | null;
    parent_id: string | null;
    job_id: string | null;
    depth: number | null;
    authority_json: string | null;
    privacy: string | null;
    due_at: number | null;
  }
  const invocations = () =>
    w.db.query<Row>(
      `SELECT id, status, context_json, result_json, parent_id, job_id, depth, authority_json,
              privacy, due_at
         FROM agent_invocations WHERE account_id = ? ORDER BY created_at, id`,
      ACCOUNT,
    );
  const byKey = (key: string) =>
    invocations().find((r) => (JSON.parse(r.context_json) as { jobKey?: string }).jobKey === key);
  /** Every answer round enqueued so far, oldest first. */
  const rounds = () =>
    invocations().filter(
      (r) => (JSON.parse(r.context_json) as { kind?: string }).kind === "answer-info-request",
    );
  const proposal = (id: string) =>
    w.db.query<{ status: string; amendments_json: string | null }>(
      `SELECT status, amendments_json FROM agent_proposals WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;

  return { w, env: w.env as unknown as Env, drain, needsInfo, invocations, byKey, rounds, proposal };
}

/**
 * The Job under test: a root planner that expands to ONE side-effectful leaf.
 * The leaf carries `files.read` and 100_000µ$ — the binding's `email.draft`,
 * `stripe` and the other 900_000µ$ are dropped at the root and never reach it.
 */
async function startAskingJob(env: Env, over: Record<string, unknown> = {}) {
  const started = await startJob(env, {
    accountId: ACCOUNT,
    bindingId: BINDING,
    budgetMicros: 800_000,
    maxNodes: 8,
    maxDepth: 2,
    authority: { tools: ["files.read"], credentials: ["aws-mcp"], budgetMicros: 500_000 },
    rootContext: {
      kind: "job-node",
      op: "plan",
      plan: {
        tasks: [
          {
            key: "reply",
            tools: ["files.read"],
            credentials: ["aws-mcp"],
            budgetMicros: 100_000,
            emailId: "e_thread",
            // No `kind`: this task runs the binding's ORDINARY reply pipeline,
            // which is what "nodes are ordinary invocations" means — and what
            // puts a proposal in front of a human.
            context: { emailId: "e_thread", threadId: "t_1", envelopeTo: SELF },
          },
        ],
      },
    },
    ...over,
  });
  if (!started.ok) throw new Error(`job did not start: ${JSON.stringify(started.refusals)}`);
  return started;
}

/** Run the Job to the point where its leaf is waiting on a human. */
async function upToTheProposal(s: Awaited<ReturnType<typeof scaffold>>) {
  await startAskingJob(s.env);
  await s.drain(); // the planner expands
  await s.drain(); // the leaf runs the reply pipeline and proposes
  const leaf = s.byKey("reply")!;
  expect(leaf.status).toBe("done");
  expect(s.proposal(leaf.id).status).toBe("pending");
  return leaf;
}

// ---------------------------------------------------------------------------

describe("THE ATTACK — a question must not launder a narrowed node back to its binding", () => {
  it("the answer round holds what the NODE held, not what the binding holds", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);

    // Sanity: the leaf itself is properly bounded. `email.draft` is the
    // binding's, and the delegation dropped it.
    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "tool", name: "files.read" })).ok).toBe(true);
    expect((await authorizeNodeUse(s.env, ACCOUNT, leaf.id, { kind: "tool", name: "email.draft" })).ok).toBe(false);

    // The human asks a question. This is the whole exploit: one ordinary,
    // well-intentioned verb on the ordinary decision surface.
    const res = await s.needsInfo(leaf.id, "Why Bob, and not the alias you have?");
    expect(res.notUpdated).toEqual({});
    expect(s.proposal(leaf.id).status).toBe("info-requested");

    const round = s.rounds()[0]!;
    expect(round.id).not.toBe(leaf.id);

    // ---- THE ASSERTION THE BUG WOULD FAIL --------------------------------
    // The round is a DELEGATION, not an ordinary invocation, and it is bounded
    // by the same chain the leaf was: it may still read files, and it still may
    // not draft email — even though its binding may.
    const draft = await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "email.draft" });
    expect(draft.ok).toBe(false);
    if (!draft.ok) {
      expect(draft.denial.axis).toBe("tools");
      expect(draft.denial.requested).toBe("email.draft");
      expect(draft.note).toContain(round.id);
    }
    const read = await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "files.read" });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.delegated).toBe(true);

    // Every other axis too — a fix that closed only the tool axis would be a
    // fix for the example rather than for the hole.
    expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "credential", name: "stripe" })).ok).toBe(false);
    expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "credential", name: "aws-mcp" })).ok).toBe(true);
    // The binding would allow 1_000_000 and the Job 800_000; the NODE's
    // delegated ceiling is 100_000, and that is what the round inherits.
    expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "spend", micros: 100_000 })).ok).toBe(true);
    expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "spend", micros: 100_001 })).ok).toBe(false);
  });

  it("the round's effective authority is IDENTICAL to the node's — same envelope, not a re-derived one", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    await s.needsInfo(leaf.id, "which quarter?");
    const round = s.rounds()[0]!;

    const use = { kind: "tool", name: "files.read" } as const;
    const forLeaf = await authorizeNodeUse(s.env, ACCOUNT, leaf.id, use);
    const forRound = await authorizeNodeUse(s.env, ACCOUNT, round.id, use);
    expect(forRound.ok && forLeaf.ok).toBe(true);
    if (forRound.ok && forLeaf.ok) expect(forRound.effective).toEqual(forLeaf.effective);

    // A CONTINUATION, not a child: same Job, same parent, same depth, same
    // envelope. The parent is the leaf's parent — which is what makes the
    // chain above the round identical to the chain above the leaf.
    expect(round.job_id).toBe(leaf.job_id);
    expect(round.parent_id).toBe(leaf.parent_id);
    expect(round.depth).toBe(leaf.depth);
    expect(round.authority_json).toBe(leaf.authority_json);
  });

  it("NARROWING THE BINDING mid-question bites the round — it is a live fold, not a frozen copy", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    await s.needsInfo(leaf.id, "why?");
    const round = s.rounds()[0]!;
    expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "files.read" })).ok).toBe(true);

    // The operator narrows the binding while the question is open. The round's
    // own column still says `files.read`; its EFFECTIVE authority does not,
    // because the binding is the first term of the fold and the fold is
    // recomputed on every call (s17). A round that carried a snapshot would
    // still say yes here.
    s.w.db.sqlite
      .prepare(`UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = ?`)
      .run(
        JSON.stringify({ ...JSON.parse(CONFIG), jobs: { tools: [], credentials: [], budgetMicros: 10 } }),
        ACCOUNT,
        BINDING,
      );

    const refused = await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "files.read" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.axis).toBe("tools");
  });

  it("a TAMPERED round envelope cannot mint what the chain never held", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    await s.needsInfo(leaf.id, "why?");
    const round = s.rounds()[0]!;
    // A second writer gives the round everything the binding has.
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET authority_json = ? WHERE account_id = ? AND id = ?`)
      .run(JSON.stringify(BINDING_JOBS), ACCOUNT, round.id);

    const r = await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "email.draft" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.axis).toBe("tools");
  });
});

describe("THE DEPTH CEILING — questions are not a way to buy levels", () => {
  it("round after round stays at the node's depth, on the node's parent", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);

    // Round 1: asked, answered by the real drain, proposal back to pending.
    await s.needsInfo(leaf.id, "first question");
    await s.drain();
    expect(s.proposal(leaf.id).status).toBe("pending");
    // Round 2: the human asks again on the same proposal.
    await s.needsInfo(leaf.id, "second question");
    await s.drain();
    expect(s.proposal(leaf.id).status).toBe("pending");

    const all = s.rounds();
    expect(all).toHaveLength(2);
    for (const round of all) {
      // Neither round is a hop. If a round were the node's CHILD at
      // `depth + 1`, N questions would buy N levels of the Job's `maxDepth`
      // (`expandPlan` guards on `parent.depth + 1`), and asking your own agent
      // a question repeatedly would be a depth-ceiling escape. It is not: every
      // round sits exactly where the node it continues sits.
      expect(round.depth).toBe(leaf.depth);
      expect(round.parent_id).toBe(leaf.parent_id);
      expect(round.job_id).toBe(leaf.job_id);
      // And the chain LENGTH is invariant too, so a long conversation can never
      // walk itself past MAX_CHAIN_HOPS and start denying honest work.
      expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "files.read" })).ok).toBe(true);
      expect((await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "email.draft" })).ok).toBe(false);
    }
    // Both answers landed on the proposal's append-only record.
    const amendments = JSON.parse(s.proposal(leaf.id).amendments_json ?? "[]") as Array<{ answer: string | null }>;
    expect(amendments).toHaveLength(2);
    expect(amendments.every((a) => a.answer !== null)).toBe(true);
  });
});

describe("the round is real work, and the Job's accounting says so", () => {
  it("an outstanding round keeps the Job from reading `done`, and counts as one of its nodes", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    const jobId = leaf.job_id!;
    const before = (await jobView(s.w.env.DB, ACCOUNT, jobId))!;
    expect(before.nodes.total).toBe(2); // planner + leaf
    // A proposal merely AWAITING A VERDICT does not pause a Job: that node's
    // work IS finished and the human's decision is the egress step (§3).
    expect(before.status).toBe("done");

    await s.needsInfo(leaf.id, "why?");
    const asked = (await jobView(s.w.env.DB, ACCOUNT, jobId))!;
    // An open QUESTION re-opens it — the agent owes an answer — and the Job now
    // carries a third node to give it.
    expect(asked.nodes.total).toBe(3);
    expect(asked.nodes.pending).toBe(1);
    // `running`, not `paused`: the human is no longer the only thing this Job
    // waits on — its own answer round is claimable. While the round sat outside
    // the DAG, a Job with an invocation in flight for it reported that nothing
    // could progress, and its node count omitted work it was paying for.
    expect(asked.status).toBe("running");

    await s.drain();
    const answered = (await jobView(s.w.env.DB, ACCOUNT, jobId))!;
    expect(answered.nodes.done).toBe(3);
    expect(answered.status).toBe("done");
  });

  it("a Job at its fan-out cap can still be ASKED — the cap bounds planners, not humans", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    // The Job is full. `maxNodes` is the runaway-PLANNER backstop; refusing a
    // human's question on it would wedge the proposal in `info-requested` with
    // no round that could ever return it to the queue — a cap turned into a
    // dead end. So the round is created, and the Job is honestly one node over
    // its cap, which the next expansion (guarded, in SQL) is what pays for.
    s.w.db.sqlite
      .prepare(`UPDATE jobs SET max_nodes = 2 WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, leaf.job_id);

    const res = await s.needsInfo(leaf.id, "why?");
    expect(res.notUpdated).toEqual({});
    expect(s.rounds()).toHaveLength(1);
    expect((await jobView(s.w.env.DB, ACCOUNT, leaf.job_id!))!.nodes.total).toBe(3);
  });

  it("a round that FAILS stalls the Job instead of pausing it forever", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    await s.needsInfo(leaf.id, "why?");
    const round = s.rounds()[0]!;
    // An unreadable envelope on the round: the pre-flight refuses it rather
    // than answering a reviewer with work nobody can bound.
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET authority_json = ? WHERE account_id = ? AND id = ?`)
      .run("{oops", ACCOUNT, round.id);

    await s.drain();
    const failed = s.invocations().find((r) => r.id === round.id)!;
    expect(failed.status).toBe("failed");
    const out = JSON.parse(failed.result_json!) as { note: string; denial: { axis: string } };
    expect(out.note).toMatch(/authority refused/);
    expect(out.denial.axis).toBe("envelope");
    // The proposal stays open (only a completed round returns it to pending),
    // and the Job says the honest thing: something failed and nothing can
    // progress. Reading `paused` here would blame the human for a dead agent.
    expect(s.proposal(leaf.id).status).toBe("info-requested");
    expect((await jobView(s.w.env.DB, ACCOUNT, leaf.job_id!))!.status).toBe("stalled");
  });

  it("a round inherits the PRIVACY PIN, so a pinned Job's Q&A cannot go to the paid cloud", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    // The leaf's work was pinned. Its proposal's rationale, evidence and
    // payload are that work's output — which is exactly what the round reads.
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET privacy = 'pinned' WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, leaf.id);

    await s.needsInfo(leaf.id, "which client was this?");
    const round = s.rounds()[0]!;
    expect(round.privacy).toBe("pinned");

    // The paid drain may not claim it (privacy beats liveness, s11 decision 0);
    // it sits for a private runtime instead of leaking the answer.
    await s.drain();
    expect(s.invocations().find((r) => r.id === round.id)!.status).toBe("pending");
  });
});

describe("THE DEADLOCK, one cap over — a Job that spent its purse can still be asked", () => {
  it("a round under an exhausted JOB budget is stamped past-due and rescued by the backstop", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    // The Job has spent its aggregate budget. Nothing about that should make a
    // human's question unanswerable — but the round now carries `job_id`, so
    // `jobBudgetExhaustedSql` holds the paid cloud off it exactly as the
    // binding's monthly cap did in T9.
    s.w.db.sqlite
      .prepare(`UPDATE jobs SET budget_micros = 100 WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, leaf.job_id);
    s.w.db.sqlite
      .prepare(`UPDATE agent_invocations SET cost_micros = 100 WHERE account_id = ? AND id = ?`)
      .run(ACCOUNT, leaf.id);

    await s.needsInfo(leaf.id, "what would finishing cost?");
    const round = s.rounds()[0]!;
    // Stamped past-due by the same guard T9 uses, now reading BOTH money terms.
    expect(round.due_at).not.toBeNull();
    expect(round.due_at!).toBeLessThanOrEqual(Date.now());

    // The policy gate refuses it — that is the deadlock, and it is real.
    await s.drain();
    expect(s.invocations().find((r) => r.id === round.id)!.status).toBe("pending");

    // The overdue backstop claims OUTSIDE the policy gate, which is the whole
    // reason it exists, and the human gets their answer.
    const escalated = await escalateOverdue(s.env);
    expect(escalated.claimed).toBe(1);
    expect(s.invocations().find((r) => r.id === round.id)!.status).toBe("done");
    expect(s.proposal(leaf.id).status).toBe("pending");
  });

  it("a Job with budget to spare leaves `due_at` NULL — the stamp lands only where it must", async () => {
    const s = await scaffold();
    const leaf = await upToTheProposal(s);
    await s.needsInfo(leaf.id, "why?");
    expect(s.rounds()[0]!.due_at).toBeNull();
  });
});

describe("DefaultCase — an ordinary proposal's round is still ungated", () => {
  it("a non-Job invocation's answer round carries no envelope and is not a delegation", async () => {
    const s = await scaffold();
    // An ordinary invocation: no Job, exactly as ingest enqueues one.
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: BINDING,
        binding_name: "cj",
        status: "pending",
        email_id: "e_thread",
        context_json: JSON.stringify({ emailId: "e_thread", threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
      },
    ]);
    await s.drain();
    expect(s.proposal("inv_plain").status).toBe("pending");

    await s.needsInfo("inv_plain", "why Bob?");
    const round = s.rounds()[0]!;
    // Copying NULL yields NULL: there is no branch here, and so nothing to get
    // wrong. The round is the ungated invocation it has always been.
    expect(round.job_id).toBeNull();
    expect(round.parent_id).toBeNull();
    expect(round.depth).toBeNull();
    expect(round.authority_json).toBeNull();

    const r = await authorizeNodeUse(s.env, ACCOUNT, round.id, { kind: "tool", name: "anything" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delegated).toBe(false);
      expect(r.effective).toEqual({ tools: null, credentials: null, budgetMicros: null });
    }

    // …and it still runs. The gate is a bound, not a brake: the round answers
    // the question and the proposal returns to the queue.
    await s.drain();
    expect(s.invocations().find((x) => x.id === round.id)!.status).toBe("done");
    expect(s.proposal("inv_plain").status).toBe("pending");
  });
});
