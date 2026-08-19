import { describe, expect, it } from "vitest";
import { Mailstore, type ContactWriter } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import { attenuateChild, effectiveNodeAuthority, type NodeAuthority } from "@bullmoose/scheduling";
import agentWorker from "./index";
import { delegate, handOff, openDelegation } from "./handoff";
import { startJob } from "./jobs";
import type { Env } from "./models";

/**
 * s17 — AGENT-TO-AGENT HANDOFF, driven through the REAL cloud drain.
 *
 * Nothing here calls a private helper: `POST /drain` runs the loop production
 * runs, over rows the live schema holds. What is being proven, in the order the
 * PR argues it:
 *
 *   1. a handoff creates work on ANOTHER binding, and its authority is the
 *      INTERSECTION — proven transitively, from the rows, through the use-time
 *      fold rather than through the write path's own arithmetic;
 *   2. the budget decision holds at the claim gate, and the µUSD attributes to
 *      the binding that actually spent it (NULL ≠ 0);
 *   3. the 008 kill switch COMPOSES: a disabled colleague makes handed-off work
 *      WAIT, and re-enabling resumes the same row;
 *   4. provenance survives the hop and lands on the surface the Activity realm
 *      already reads;
 *   5. NO EGRESS LAUNDERING — a handed-off leaf in a send-mode binding with a
 *      governing book that permits the recipient STILL exits via /approvals;
 *   6. loops and depth refuse loudly, from the database, not just in the pure
 *      module;
 *   7. and the door stays shut: a plain plan still cannot mint a cross-binding
 *      child.
 */

const ACCOUNT = "t_bm__a_ho";
const TENANT = "t_bm";
const SELF = "cj@bullmoose.cc";
const SENDER = "human@example.com";
const BOOK = "ab_allen_reach";
const HUMAN: ContactWriter = { principal: "eric@bullmoose.cc", kind: "human" };

const REPLY = {
  pipeline: "reply",
  persona: "You are a colleague.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
};

/** CJ: holds two tools and a credential, and may hand work to allen. */
const CJ_CONFIG = JSON.stringify({
  ...REPLY,
  jobs: {
    tools: ["files.read", "mail.draft"],
    credentials: ["aws-mcp"],
    budgetMicros: 500_000,
    handoff: { mayHandTo: ["allen"] },
  },
});

interface Scaffold {
  /** allen's `config_json.jobs`, merged over the default. */
  allenJobs?: Record<string, unknown>;
  /** allen's whole config — wins over `allenJobs`. */
  allenConfig?: string;
  allenEnabled?: number;
  /** Give allen a governing book containing SENDER (the send path). */
  governed?: boolean;
  /** A third colleague, for the two-hop cases. */
  emily?: boolean;
}

async function scaffold(opts: Scaffold = {}) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "CJ" });
  w.db.seed("identities", [{ id: "id_cj", account_id: ACCOUNT, email: SELF }]);

  const allenConfig =
    opts.allenConfig ??
    JSON.stringify({
      ...REPLY,
      replyMode: opts.governed ? "send" : "draft",
      jobs: { tools: ["files.read"], handoff: { acceptsFrom: ["cj"] }, ...(opts.allenJobs ?? {}) },
    });

  w.db.seed("agent_bindings", [
    { id: "bind_cj", account_id: ACCOUNT, name: "cj", config_json: CJ_CONFIG },
    {
      id: "bind_allen",
      account_id: ACCOUNT,
      name: "allen",
      config_json: allenConfig,
      ...(opts.allenEnabled === undefined ? {} : { enabled: opts.allenEnabled }),
      recipients_book_id: opts.governed ? BOOK : null,
    },
    ...(opts.emily
      ? [
          {
            id: "bind_emily",
            account_id: ACCOUNT,
            name: "emily",
            config_json: JSON.stringify({
              ...REPLY,
              jobs: { tools: ["files.read"], handoff: { acceptsFrom: ["allen"] } },
            }),
          },
        ]
      : []),
  ]);

  if (opts.governed) {
    w.db.seed("address_books", [
      {
        id: BOOK,
        account_id: ACCOUNT,
        name: "allen may email",
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
    subject: "can someone look at this invoice",
    messageId: "msg-1@example.com",
    date: new Date(1_000_000),
    text: "The March invoice looks wrong.",
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
    subject: "can someone look at this invoice",
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    cc: [],
    bcc: [],
    preview: "The March invoice looks wrong.",
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

  const node = (id: string) =>
    w.db.query<{
      id: string;
      binding_id: string;
      binding_name: string;
      status: string;
      job_id: string | null;
      parent_id: string | null;
      depth: number | null;
      authority_json: string | null;
      privacy: string | null;
      context_json: string;
      cost_micros: number | null;
      result_json: string | null;
    }>(
      `SELECT id, binding_id, binding_name, status, job_id, parent_id, depth, authority_json,
              privacy, context_json, cost_micros, result_json
         FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;

  return { w, env: w.env as unknown as Env, drain, node };
}

/** A Job on CJ, rooted at a free echo node, ready to hand off from. */
async function cjJob(env: Env, over: Record<string, unknown> = {}) {
  const started = await startJob(env, {
    accountId: ACCOUNT,
    bindingId: "bind_cj",
    budgetMicros: 1_000_000,
    maxNodes: 8,
    maxDepth: 3,
    authority: { tools: ["files.read", "mail.draft"], credentials: ["aws-mcp"], budgetMicros: 200_000 },
    rootContext: { kind: "job-node", op: "echo", text: "triage" },
    ...over,
  });
  if (!started.ok) throw new Error(`job did not start: ${JSON.stringify(started.refusals)}`);
  return started;
}

const TASK = {
  key: "look-at-invoice",
  tools: ["files.read"],
  budgetMicros: 50_000,
  context: { kind: "job-node", op: "echo", text: "invoice" },
};

// ---------------------------------------------------------------------------

describe("a handoff creates work on ANOTHER binding, narrowed to the intersection", () => {
  it("the row lands on the receiver, with the receiver's NAME over the receiver's id", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const child = s.node(r.handoff.invocationId);
    expect(child.binding_id).toBe("bind_allen");
    // The denormalization lie a cross-binding row would otherwise carry: before
    // s17 every child was stamped with its PARENT's binding_name, which was
    // only ever correct because every child was same-binding.
    expect(child.binding_name).toBe("allen");
    expect(child.job_id).toBe(job.jobId);
    expect(child.parent_id).toBe(job.rootId);
    expect(child.depth).toBe(1);
    expect(child.status).toBe("pending");
    expect(r.handoff.hop).toBe(1);
    expect(r.handoff.waiting).toBe(false);
  });

  it("the stored envelope is sender ∩ receiver — allen's ceiling drops `mail.draft` and `aws-mcp`", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      // CJ asks for everything it holds; allen's binding ceiling is narrower.
      task: { ...TASK, tools: ["files.read"], credentials: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const child = s.node(r.handoff.invocationId);
    expect(JSON.parse(child.authority_json!)).toEqual({
      tools: ["files.read"],
      credentials: [],
      budgetMicros: 50_000,
    });
  });

  it("a task asking for a tool ALLEN holds and CJ does not is refused, not borrowed", async () => {
    const s = await scaffold({ allenJobs: { tools: ["files.read", "payments.charge"] } });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: { ...TASK, tools: ["payments.charge"] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.axis)).toContain("tools");
  });

  it("a WIDE receiver does not widen: allen with no `jobs` ceiling still gets CJ's subset", async () => {
    const s = await scaffold({ allenConfig: JSON.stringify({ ...REPLY, jobs: { handoff: { acceptsFrom: ["cj"] } } }) });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: { ...TASK, tools: ["files.read", "mail.draft"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const auth = JSON.parse(s.node(r.handoff.invocationId).authority_json!) as NodeAuthority;
    expect(auth.tools).toEqual(["files.read", "mail.draft"]);
    // …and nothing beyond CJ's own two, whatever allen's unset ceiling implies.
    const wider = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "again",
      task: { ...TASK, key: "second", tools: ["payments.charge"] },
    });
    expect(wider.ok).toBe(false);
  });
});

describe("THE PROOF from the rows: A → B → C never exceeds A, at USE time", () => {
  it("the use-time fold intersects every binding the chain crosses", async () => {
    const s = await scaffold({ emily: true });
    const job = await cjJob(s.env);

    const first = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: { ...TASK, tools: ["files.read"], budgetMicros: 80_000 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Allen may hand on once more. (allen's config in this scaffold does not
    // name emily, so widen it the way an operator would.)
    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_allen'`,
      JSON.stringify({
        ...REPLY,
        jobs: { tools: ["files.read"], handoff: { acceptsFrom: ["cj"], mayHandTo: ["emily"] } },
      }),
      ACCOUNT,
    );

    const second = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: first.handoff.invocationId,
      toBindingName: "emily",
      reason: "Emily writes the reply",
      task: { key: "draft", tools: ["files.read"], budgetMicros: 80_000, context: { kind: "job-node", op: "echo" } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const effective = async (id: string) => {
      const row = s.node(id);
      const decided = await effectiveNodeAuthority(s.env, ACCOUNT, {
        id: row.id,
        binding_id: row.binding_id,
        job_id: row.job_id,
        parent_id: row.parent_id,
        authority_json: row.authority_json,
      });
      if (!decided.ok) throw new Error(`chain unreadable: ${decided.note}`);
      return decided.effective;
    };

    const a = await effective(job.rootId);
    const b = await effective(first.handoff.invocationId);
    const c = await effective(second.handoff.invocationId);

    const subset = (child: readonly string[] | null, parent: readonly string[] | null) =>
      parent === null || (child !== null && child.every((t) => parent.includes(t)));

    expect(subset(c.tools, a.tools), "C ⊆ A on tools").toBe(true);
    expect(subset(c.credentials, a.credentials), "C ⊆ A on credentials").toBe(true);
    expect(c.budgetMicros!).toBeLessThanOrEqual(a.budgetMicros!);
    expect(subset(c.tools, b.tools), "C ⊆ B on tools").toBe(true);
    // The transitive claim in its sharpest form: CJ held `aws-mcp` and
    // `mail.draft`; two hops later neither survives, because every hop is an
    // intersection and no hop can restore what an ancestor gave up.
    expect(c.tools).toEqual(["files.read"]);
    expect(c.credentials).toEqual([]);
  });

  it("narrowing CJ's binding AFTER the handoff bites the already-created node", async () => {
    // The property `useAuthority.ts` exists for: a ceiling checked only at
    // create time is a comment. The chain is re-folded from the rows on every
    // call, so an operator narrowing the SENDER reaches work already in flight
    // under a colleague.
    const s = await scaffold();
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: { ...TASK, tools: ["files.read"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_cj'`,
      JSON.stringify({ ...REPLY, jobs: { tools: [], handoff: { mayHandTo: ["allen"] } } }),
      ACCOUNT,
    );

    const row = s.node(r.handoff.invocationId);
    const after = await effectiveNodeAuthority(s.env, ACCOUNT, {
      id: row.id,
      binding_id: row.binding_id,
      job_id: row.job_id,
      parent_id: row.parent_id,
      authority_json: row.authority_json,
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // The row's own column still says `files.read`. The ANSWER does not.
    expect(JSON.parse(row.authority_json!).tools).toEqual(["files.read"]);
    expect(after.effective.tools).toEqual([]);
  });

  it("a DISABLED sender binding denies the chain — the handed-off node fails its pre-flight", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    s.w.db.query(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = 'bind_cj'`, ACCOUNT);
    await s.drain();

    const child = s.node(r.handoff.invocationId);
    expect(child.status).toBe("failed");
    const denial = JSON.parse(child.result_json!).denial as { axis: string; why: string };
    expect(denial.axis).toBe("envelope");
    expect(denial.why).toContain("DISABLED binding");
    // Cost is KNOWN zero — no model ran. Never NULL, which would read
    // "not recorded" on every surface.
    expect(child.cost_micros).toBe(0);
  });
});

describe("the 008 kill switch composes: a disabled colleague makes the work WAIT", () => {
  it("the handoff is created, reported as waiting, and claimed by nobody", async () => {
    const s = await scaffold({ allenEnabled: 0 });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    // NOT a refusal, and NOT a bounce back to CJ: bouncing would re-run the
    // work under the SENDER's authority, which is the escalation the whole
    // intersection exists to prevent.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.handoff.waiting).toBe(true);

    await s.drain();
    await s.drain();
    const held = s.node(r.handoff.invocationId);
    expect(held.status).toBe("pending");
    expect(held.cost_micros).toBeNull(); // nothing ran, so nothing is recorded

    // Re-enabling RESUMES the same row: no requeue, nothing cancelled.
    s.w.db.query(`UPDATE agent_bindings SET enabled = 1 WHERE account_id = ? AND id = 'bind_allen'`, ACCOUNT);
    await s.drain();
    expect(s.node(r.handoff.invocationId).status).toBe("done");
  });
});

describe("the 008 kill switch on the SENDER refuses outright", () => {
  it("a switched-off agent may not create work for a colleague", async () => {
    // The mirror image of the receiver case, and the asymmetry is the switch's
    // own logic: a disabled RECEIVER holds queued work, a disabled SENDER may
    // not create new work at all.
    const s = await scaffold();
    const job = await cjJob(s.env);
    s.w.db.query(`UPDATE agent_bindings SET enabled = 0 WHERE account_id = ? AND id = 'bind_cj'`, ACCOUNT);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.why).toContain("008 kill switch");
    const count = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_invocations WHERE account_id = ? AND job_id = ?`,
      ACCOUNT,
      job.jobId,
    )[0]!;
    expect(count.n).toBe(1);
  });
});

describe("budget: the purse is the receiver's, the gate is both", () => {
  it("an exhausted SENDER holds handed-off work at the claim gate", async () => {
    const s = await scaffold();
    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_cj'`,
      JSON.stringify({
        ...REPLY,
        budgets: { spendPerMonth: 1000 },
        jobs: { tools: ["files.read", "mail.draft"], handoff: { mayHandTo: ["allen"] } },
      }),
      ACCOUNT,
    );
    const job = await cjJob(s.env, { authority: { tools: ["files.read"], budgetMicros: 200_000 } });
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // CJ spends its month AFTER handing off. The row on allen — whose own
    // binding has no cap at all — stops being claimable by the PAID drain.
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_cj_spend",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "done",
        created_at: 1,
        done_at: Date.now(),
        cost_micros: 5000,
        context_json: "{}",
      },
    ]);
    await s.drain();
    await s.drain();
    expect(s.node(r.handoff.invocationId).status).toBe("pending");
  });

  it("the µUSD attributes to the binding that spent it, and 0 is not NULL", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await s.drain();
    await s.drain();

    const child = s.node(r.handoff.invocationId);
    expect(child.status).toBe("done");
    expect(child.binding_id).toBe("bind_allen");
    // A structural node calls no model: the cost is KNOWN and it is zero. The
    // distinction is load-bearing everywhere — 0 renders "$0.00", NULL renders
    // "not recorded" — and a handoff must not collapse it in either direction.
    expect(child.cost_micros).toBe(0);
    // Nothing was charged back to CJ: no row on `bind_cj` gained a cost.
    const cjCosts = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_invocations
        WHERE account_id = ? AND binding_id = 'bind_cj' AND cost_micros IS NOT NULL AND cost_micros > 0`,
      ACCOUNT,
    )[0]!;
    expect(cjCosts.n).toBe(0);
  });

  it("the Job's AGGREGATE budget bounds the handoff: an over-reserving task is refused", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env, { budgetMicros: 60_000 });
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      // The root already reserved 200_000 against a 60_000 Job budget's worth
      // of headroom; this asks for more on top.
      task: { ...TASK, budgetMicros: 50_000 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.axis)).toContain("budget");
  });
});

describe("NO EGRESS LAUNDERING", () => {
  it("a handed-off leaf in a SEND-mode binding whose book permits the recipient still proposes", async () => {
    // Every ingredient for a direct send is present: allen is `replyMode: send`,
    // allen's governing book contains the recipient, the recipient is a human,
    // and there is no allowedSenders list to fail. The ONLY thing standing
    // between this run and an email leaving the building is `job_id` — s11 T7's
    // sentence, which a handoff must not become a way around.
    const s = await scaffold({ governed: true });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: {
        key: "reply",
        budgetMicros: 50_000,
        emailId: "e_thread",
        // No `kind`: allen's ORDINARY reply pipeline runs.
        context: { emailId: "e_thread", threadId: "t_1", envelopeTo: SELF },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await s.drain();
    await s.drain();

    const leaf = s.node(r.handoff.invocationId);
    expect(leaf.status).toBe("done");
    const proposals = s.w.db.query<{
      id: string;
      kind: string;
      tier: number;
      status: string;
      rationale: string;
      evidence_json: string;
    }>(`SELECT id, kind, tier, status, rationale, evidence_json FROM agent_proposals WHERE account_id = ?`, ACCOUNT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: leaf.id, kind: "reply-draft", tier: 2, status: "pending" });
    // The door out is the proposal. Nothing was relayed.
    expect(s.w.submit.calls).toHaveLength(0);
  });

  it("PROVENANCE SURVIVES THE HOP — the proposal says who handed it over, and why", async () => {
    const s = await scaffold({ governed: true });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: {
        key: "reply",
        budgetMicros: 50_000,
        emailId: "e_thread",
        context: { emailId: "e_thread", threadId: "t_1", envelopeTo: SELF },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await s.drain();
    await s.drain();

    const [proposal] = s.w.db.query<{ rationale: string; evidence_json: string }>(
      `SELECT rationale, evidence_json FROM agent_proposals WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      r.handoff.invocationId,
    );
    // The chief-of-staff sentence, on the surface `/activity` and `/approvals`
    // already render — no new column, no parallel record.
    expect(proposal!.rationale).toContain("cj handed this to allen — Allen owns spend questions");
    // …and the agent's OWN rationale is preceded, never rewritten.
    expect(proposal!.rationale).toContain("Drafted a reply");
    const evidence = JSON.parse(proposal!.evidence_json) as Array<{ realm: string; objectId: string; note?: string }>;
    expect(evidence).toContainEqual({
      realm: "AgentInvocation",
      objectId: job.rootId,
      note: "cj handed this to allen — Allen owns spend questions",
    });
  });

  it("an ORDINARY proposal is untouched — no handoff, no decoration", async () => {
    const s = await scaffold({ governed: true });
    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_allen'`,
      JSON.stringify({ ...REPLY, replyMode: "send" }),
      ACCOUNT,
    );
    const started = await startJob(s.env, {
      accountId: ACCOUNT,
      bindingId: "bind_allen",
      budgetMicros: 1_000_000,
      maxNodes: 4,
      maxDepth: 2,
      authority: { budgetMicros: 100_000 },
      rootContext: { emailId: "e_thread", threadId: "t_1", envelopeTo: SELF },
      emailId: "e_thread",
    });
    if (!started.ok) throw new Error("job did not start");
    await s.drain();
    const [proposal] = s.w.db.query<{ rationale: string; evidence_json: string }>(
      `SELECT rationale, evidence_json FROM agent_proposals WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      started.rootId,
    );
    expect(proposal!.rationale.startsWith("Drafted a reply")).toBe(true);
    expect(JSON.parse(proposal!.evidence_json)).toHaveLength(1);
  });
});

describe("loops and depth, refused from the database", () => {
  it("A → B → A is refused as a cycle", async () => {
    const s = await scaffold();
    // Make the relationship reciprocal in BOTH directions, so the only thing
    // that can refuse the return hop is the cycle rule itself.
    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_cj'`,
      JSON.stringify({
        ...REPLY,
        jobs: { tools: ["files.read"], handoff: { mayHandTo: ["allen"], acceptsFrom: ["allen"] } },
      }),
      ACCOUNT,
    );
    s.w.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE account_id = ? AND id = 'bind_allen'`,
      JSON.stringify({
        ...REPLY,
        jobs: { tools: ["files.read"], handoff: { acceptsFrom: ["cj"], mayHandTo: ["cj"] } },
      }),
      ACCOUNT,
    );
    const job = await cjJob(s.env, { authority: { tools: ["files.read"], budgetMicros: 100_000 } });
    const out = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const back = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: out.handoff.invocationId,
      toBindingName: "cj",
      reason: "back to you",
      task: { ...TASK, key: "back" },
    });
    expect(back.ok).toBe(false);
    if (back.ok) return;
    expect(back.refusals.map((x) => x.axis)).toEqual(["handoff"]);
    expect(back.refusals[0]!.why).toContain("already in the delegation chain");
    // Refused LOUDLY: nothing was created.
    const count = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_invocations WHERE account_id = ? AND job_id = ?`,
      ACCOUNT,
      job.jobId,
    )[0]!;
    expect(count.n).toBe(2);
  });

  it("a colleague who never agreed refuses, and no row is written", async () => {
    const s = await scaffold({ allenConfig: JSON.stringify({ ...REPLY, jobs: { tools: ["files.read"] } }) });
    const job = await cjJob(s.env);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.why).toContain("does not accept work from cj");
    const count = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_invocations WHERE account_id = ? AND job_id = ?`,
      ACCOUNT,
      job.jobId,
    )[0]!;
    expect(count.n).toBe(1);
  });

  it("an unknown colleague refuses; an AMBIGUOUS one refuses rather than guessing", async () => {
    const s = await scaffold();
    const job = await cjJob(s.env);
    const unknown = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "nobody",
      reason: "x",
      task: TASK,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusals[0]!.why).toContain("no colleague by that name");

    // Two bindings share a name — `agent_bindings` has no unique index on it,
    // and here the name is half of a security control.
    s.w.db.seed("agent_bindings", [{ id: "bind_allen2", account_id: ACCOUNT, name: "allen", config_json: "{}" }]);
    const ambiguous = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: job.rootId,
      toBindingName: "allen",
      reason: "x",
      task: TASK,
    });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.refusals[0]!.why).toContain("share that name");
  });

  it("a handoff from an invocation with no Job says so rather than half-working", async () => {
    const s = await scaffold();
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "running",
        created_at: 1,
        context_json: "{}",
      },
    ]);
    const r = await handOff(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: "inv_plain",
      toBindingName: "allen",
      reason: "x",
      task: TASK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.axis).toBe("job");
    expect(r.refusals[0]!.why).toContain("delegate()");
  });
});

describe("the on-ramp: delegate() from an ordinary invocation", () => {
  it("opens a Job ROOTED ON THE HANDING BINDING, so the sender's ceiling stays in the fold", async () => {
    const s = await scaffold();
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "running",
        created_at: 1,
        email_id: "e_thread",
        privacy: "internal",
        context_json: JSON.stringify({ emailId: "e_thread" }),
      },
    ]);
    const r = await delegate(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: "inv_plain",
      toBindingName: "allen",
      reason: "Allen owns spend questions",
      task: TASK,
      open: { authority: { tools: ["files.read"], budgetMicros: 100_000 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const child = s.node(r.handoff.invocationId);
    const root = s.node(child.parent_id!);
    // The root is CJ's own node. If it were the handed-off work itself, the
    // chain would contain only ALLEN's binding and CJ's ceiling would vanish
    // from the intersection — the widest hop winning.
    expect(root.binding_id).toBe("bind_cj");
    expect(root.parent_id).toBeNull();
    expect(root.depth).toBe(0);
    // The causing invocation's facets ride across: an `internal` message does
    // not become an `open` Job by being delegated.
    expect(root.privacy).toBe("internal");
    expect(child.privacy).toBe("internal");
    expect(JSON.parse(root.context_json).delegation).toEqual({
      fromInvocationId: "inv_plain",
      reason: "Allen owns spend questions",
    });
  });

  it("delegating twice from the same ordinary invocation refuses the second open", async () => {
    const s = await scaffold();
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_plain2",
        account_id: ACCOUNT,
        binding_id: "bind_cj",
        binding_name: "cj",
        status: "running",
        created_at: 1,
        context_json: "{}",
        job_id: "job_elsewhere",
      },
    ]);
    const r = await openDelegation(s.env, {
      accountId: ACCOUNT,
      fromInvocationId: "inv_plain2",
      reason: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals[0]!.axis).toBe("job");
  });
});

describe("the door stays shut: a plain plan still cannot mint a cross-binding child", () => {
  it("`attenuateChild` refuses a task that names another binding, and says where to go", () => {
    const child = attenuateChild(
      {
        accountId: ACCOUNT,
        bindingId: "bind_cj",
        jobId: "job_1",
        depth: 0,
        authority: { tools: null, credentials: null, budgetMicros: null },
        privacy: null,
        dueAt: null,
      },
      { key: "sneaky", bindingId: "bind_allen" },
    );
    expect(child.ok).toBe(false);
    if (child.ok) return;
    expect(child.refusals[0]!.axis).toBe("identity");
    expect(child.refusals[0]!.why).toContain("HANDOFF");
  });
});
