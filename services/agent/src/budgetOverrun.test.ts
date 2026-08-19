import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { budgetPeriodEndMs, budgetPeriodKey } from "@bullmoose/scheduling";
import agentWorker from "./index";
import { proposeBudgetOverruns, budgetMarkerKind } from "./budgetOverrun";

/**
 * s11 T9 — budget overrun is a DECISION, not a dead end.
 *
 * The hole: a binding out of monthly budget strands its pending work when no
 * free runtime is live. The gate holds paid claimants off (exhaustion narrows
 * the claimant set) and T3's backstop cannot help work with no deadline. Under
 * the rule "marker when nothing can be decided; proposal when something can",
 * *"spend anyway?"* is a real question — so it earns the queue.
 *
 * These tests are written to BITE:
 *   - the ask fires ONCE per binding per period, including under a raced sweep
 *     (both sweeps race for the SAME representative row's guarded UPDATE);
 *   - the DefaultCase cases produce NOTHING — no cap, nothing waiting, budget
 *     not exhausted, a live homelab, a far-off deadline, a pinned row;
 *   - the numbers on the row are the real ones, and an unknown estimate stays
 *     null rather than becoming a plausible zero;
 *   - the proposal cannot outlive its period.
 *
 * The APPROVE half (the bound the gate then honors) lives in
 * services/jmap/src/methods/actionProposal.budgetOverrun.test.ts, where the
 * decision surface is.
 */

const ACCOUNT = "t_bm__a_budget";
const TENANT = "t_bm";
const SELF = "photos@bullmoose.cc";
const SENDER = "human@example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 5_000_000; // $5.00 in micro-USD

const REPLY_CONFIG = {
  pipeline: "reply",
  persona: "You are photos.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
};
const BUDGETED_CONFIG = JSON.stringify({ ...REPLY_CONFIG, budgets: { spendPerMonth: CAP } });
const UNBUDGETED_CONFIG = JSON.stringify(REPLY_CONFIG);

async function scaffold(bindingConfig: string = BUDGETED_CONFIG) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Photos" });
  w.db.seed("identities", [{ id: "id_photos", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [{ id: "bind_photos", account_id: ACCOUNT, name: "photos", config_json: bindingConfig }]);

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
  const emailId = "e_thread";
  await store.insertEmail(ACCOUNT, {
    id: emailId,
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

  let seq = 0;
  const seedInvocation = (id: string, extra: Record<string, unknown> = {}) => {
    seq += 1;
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "pending",
        email_id: emailId,
        context_json: JSON.stringify({ emailId, threadId: "t_1", envelopeTo: SELF }),
        created_at: seq,
        ...extra,
      },
    ]);
    return id;
  };

  /** Spend `micros` this month on this binding, as a completed run. */
  let spends = 0;
  const spend = (micros: number) => {
    spends += 1;
    w.db.seed("agent_invocations", [
      {
        id: `inv_spent_${spends}`,
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "done",
        created_at: 1,
        claimed_at: Date.now() - 2000,
        done_at: Date.now() - 1000,
        cost_micros: micros,
      },
    ]);
  };

  const proposals = () =>
    w.db.query<{
      id: string;
      kind: string;
      tier: number;
      status: string;
      payload_json: string;
      rationale: string;
      evidence_json: string;
      expires_at: number;
    }>(
      "SELECT id, kind, tier, status, payload_json, rationale, evidence_json, expires_at " +
        "FROM agent_proposals WHERE account_id = ? ORDER BY created_at",
      ACCOUNT,
    );

  const rowOf = (id: string) =>
    w.db.query<{ status: string; alert_kind: string | null; alert_at: number | null }>(
      "SELECT status, alert_kind, alert_at FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  const sweep = () => proposeBudgetOverruns(w.env as never);

  /** The whole cron hook, exactly as production runs it. */
  const cron = async () => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await agentWorker.scheduled!(
      { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController,
      w.env as never,
      execCtx,
    );
  };

  return { w, seedInvocation, spend, proposals, rowOf, sweep, cron };
}

/** A free runtime's fingerprint: a claim with claimant_free = 1, `agoMs` ago. */
function seedFreeClaim(w: FakeWorker, agoMs: number) {
  w.db.seed("agent_invocations", [
    {
      id: `inv_by_free_${agoMs}`,
      account_id: ACCOUNT,
      binding_id: "bind_photos",
      binding_name: "photos",
      status: "done",
      created_at: 1,
      claimed_at: Date.now() - agoMs,
      done_at: Date.now() - agoMs + 500,
      claimant_free: 1,
    },
  ]);
}

const payloadOf = (p: { payload_json: string }) => JSON.parse(p.payload_json) as Record<string, unknown>;

// ---- detection -------------------------------------------------------------

describe("detection: one proposal per binding, with the real numbers", () => {
  it("a binding over cap with waiting work produces exactly ONE proposal, batched", async () => {
    const s = await scaffold();
    // The cap, spent — by four real runs, which are also the cost history the
    // estimate reads. Median of [1.00, 1.00, 1.50, 1.50] = $1.25 per run.
    s.spend(1_000_000);
    s.spend(1_000_000);
    s.spend(1_500_000);
    s.spend(1_500_000);
    for (let i = 0; i < 12; i++) s.seedInvocation(`inv_wait_${i}`);

    expect(await s.sweep()).toEqual({ asked: 1 });

    const props = s.proposals();
    expect(props).toHaveLength(1); // never twelve — batch per BINDING
    const p = props[0]!;
    expect(p.kind).toBe("budget-overrun");
    expect(p.tier).toBe(1);
    expect(p.status).toBe("pending");

    const payload = payloadOf(p);
    expect(payload).toMatchObject({
      bindingId: "bind_photos",
      bindingName: "photos",
      waitingCount: 12,
      capMicros: CAP,
      periodKey: budgetPeriodKey(Date.now()),
    });
    // The spend is what the binding actually burned this month, not a rounded
    // story about it.
    expect(payload.monthSpentMicros).toBe(CAP);
    // The estimate is median × count, from the s07 T5 cost history — and it is
    // allowed to DWARF the cap. Twelve runs at $1.25 is $15.00 against a $5.00
    // budget; hiding that behind a clamp would be the one number the human
    // needed and did not get.
    expect(payload.estimateMicros).toBe(1_250_000 * 12);
    // ...and the requested BOUND is that plus the stated headroom (a median
    // under-shoots half the time by construction).
    expect(payload.overageMicros).toBe(Math.ceil(1_250_000 * 12 * 1.25));

    // rationale/evidence are required fields, and the numbers ARE the rationale.
    expect(p.rationale).toContain("12 invocation");
    expect(p.rationale).toContain("$5.00");
    expect(p.rationale).toContain("Declining leaves the work queued");
    const evidence = JSON.parse(p.evidence_json) as Array<{ realm: string; objectId: string }>;
    expect(evidence.map((e) => e.realm)).toEqual(["AgentBinding", "AgentInvocation"]);
  });

  it("no paid history: the cost is UNKNOWN, reported honestly, never guessed", async () => {
    // `spendPerMonth: 0` is "never spend paid" — exhausted from its first
    // moment, with nothing ever spent and so nothing to learn from. The one
    // binding shape where "no cost history" is genuinely reachable, and the
    // reason the estimate has to be nullable rather than merely conservative.
    const s = await scaffold(JSON.stringify({ ...REPLY_CONFIG, budgets: { spendPerMonth: 0 } }));
    s.spend(0); // a genuinely free run: known, and no evidence about paid cost
    s.seedInvocation("inv_wait");

    expect(await s.sweep()).toEqual({ asked: 1 });
    const payload = payloadOf(s.proposals()[0]!);
    expect(payload.estimateMicros).toBeNull();
    expect(payload.monthSpentMicros).toBe(0);
    expect(payload.capMicros).toBe(0);
    // No estimate and no cap to fall back on: a NOMINAL $1.00, labelled as
    // such. When you do not know, ask for little.
    expect(payload.overageMicros).toBe(1_000_000);
    expect(s.proposals()[0]!.rationale).toContain("UNKNOWN");
    expect(s.proposals()[0]!.rationale).toContain("nominal $1.00");
  });

  it("no paid history but a real cap: the bound falls back to one month's cap", async () => {
    const s = await scaffold();
    // Reaching the cap without a per-run cost is unusual but expressible: a run
    // whose cost was never determined (NULL) does not enter the estimate, and a
    // manual/backfilled spend row need not be a model call at all.
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_backfill",
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "failed", // a crash is a spend fact, not a cost estimate
        created_at: 1,
        claimed_at: Date.now() - 2000,
        done_at: Date.now() - 1000,
        cost_micros: CAP,
      },
    ]);
    s.seedInvocation("inv_wait");

    expect(await s.sweep()).toEqual({ asked: 1 });
    const payload = payloadOf(s.proposals()[0]!);
    expect(payload.estimateMicros).toBeNull();
    expect(payload.overageMicros).toBe(CAP);
  });

  it("the marker lands on ONE representative invocation — the oldest waiter", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_first");
    s.seedInvocation("inv_second");
    s.seedInvocation("inv_third");

    await s.sweep();
    expect(s.rowOf("inv_first").alert_kind).toBe(budgetMarkerKind(budgetPeriodKey(Date.now())));
    expect(s.rowOf("inv_first").alert_at).toBeGreaterThan(0);
    // The others are untouched: the marker is an idempotence key, not an alert
    // storm wearing a decision's clothes.
    expect(s.rowOf("inv_second").alert_kind).toBeNull();
    expect(s.rowOf("inv_third").alert_kind).toBeNull();
    // And nothing was cancelled or failed — all three still wait.
    for (const id of ["inv_first", "inv_second", "inv_third"]) {
      expect(s.rowOf(id).status).toBe("pending");
    }
  });

  it("the proposal hangs off its OWN invocation, so the marked row can still run", async () => {
    // A proposal's id IS its invocation's id. Hanging the ask off the waiting
    // row would collide the moment that row ran its own pipeline and emitted a
    // proposal under the same key.
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_wait");

    await s.sweep();
    const carrier = s.proposals()[0]!.id;
    expect(carrier).not.toBe("inv_wait");
    const row = s.w.db.query<{ status: string; cost_micros: number; binding_id: string }>(
      "SELECT status, cost_micros, binding_id FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      carrier,
    )[0]!;
    // Finished on arrival, and genuinely free: no model was called to ask.
    expect(row).toMatchObject({ status: "done", cost_micros: 0, binding_id: "bind_photos" });
  });
});

// ---- idempotence -----------------------------------------------------------

describe("idempotence: mark once → ask once", () => {
  it("a second sweep produces NOTHING, and a third, and a fourth", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_a");
    s.seedInvocation("inv_b");

    expect(await s.sweep()).toEqual({ asked: 1 });
    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toHaveLength(1);
    // The cron runs every few minutes and this binding stays broke all month:
    // the whole queue's value is that it is short.
    await s.cron();
    await s.cron();
    expect(s.proposals()).toHaveLength(1);
  });

  it("a RACED double sweep still asks exactly once (the guarded UPDATE decides)", async () => {
    const s = await scaffold();
    s.spend(CAP);
    for (let i = 0; i < 5; i++) s.seedInvocation(`inv_${i}`);

    // Both sweeps read the world before either writes — the pre-check cannot
    // separate them, so the guarded UPDATE on the SAME representative row is
    // what has to. Its ordering is total (created_at, id), so both sweeps pick
    // the same row and exactly one UPDATE can change it.
    const [a, b] = await Promise.all([s.sweep(), s.sweep()]);
    expect(a.asked + b.asked).toBe(1);
    expect(s.proposals()).toHaveLength(1);
    const marked = s.w.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_invocations WHERE account_id = ? AND alert_kind IS NOT NULL",
      ACCOUNT,
    )[0]!;
    expect(marked.n).toBe(1);
  });

  it("the marker survives the work it marked: an answered ask is never re-asked", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_wait");
    await s.sweep();

    // The representative gets claimed and completes (say the overage was
    // approved and the drain took it). The marker stays on the row — the
    // idempotence check reads it WITHOUT a status filter for exactly this.
    s.w.db.sqlite.exec(`UPDATE agent_invocations SET status = 'done', done_at = ${Date.now()} WHERE id = 'inv_wait'`);
    s.seedInvocation("inv_new"); // fresh work arrives, still over cap
    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toHaveLength(1);
  });

  it("a NEW PERIOD is a new question: last month's marker does not silence this month", async () => {
    const s = await scaffold();
    s.spend(CAP);
    const stale = budgetMarkerKind(budgetPeriodKey(Date.now() - 40 * 24 * HOUR));
    s.seedInvocation("inv_old", { alert_kind: stale, alert_at: Date.now() - 40 * 24 * HOUR });

    expect(await s.sweep()).toEqual({ asked: 1 });
    // The same row is re-marked for THIS period — the guard admits a budget
    // marker from another period precisely so a month roll re-opens the ask.
    expect(s.rowOf("inv_old").alert_kind).toBe(budgetMarkerKind(budgetPeriodKey(Date.now())));
  });

  it("an overdue marker is NEVER clobbered by a budget one", async () => {
    // A passed deadline is a permanent fact about a run (T3). A money problem
    // must not overwrite it, so the sweep marks a different row — or none.
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_pinned_overdue", {
      privacy: "pinned",
      due_at: Date.now() - HOUR,
      alert_kind: "overdue-pinned",
      alert_at: Date.now() - MIN,
    });
    s.seedInvocation("inv_plain");

    await s.sweep();
    expect(s.rowOf("inv_pinned_overdue").alert_kind).toBe("overdue-pinned");
    expect(s.rowOf("inv_plain").alert_kind).toBe(budgetMarkerKind(budgetPeriodKey(Date.now())));
  });
});

// ---- DefaultCase -----------------------------------------------------------

describe("DefaultCase: nothing stranded, nothing asked", () => {
  it("no spendPerMonth configured → no proposal (today's world, byte-identical)", async () => {
    const s = await scaffold(UNBUDGETED_CONFIG);
    s.spend(50_000_000); // spent a fortune; without a cap there is no ceiling
    for (let i = 0; i < 5; i++) s.seedInvocation(`inv_${i}`);

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
    expect(s.rowOf("inv_0").alert_kind).toBeNull();
  });

  it("budget configured but NOT exhausted → no proposal", async () => {
    const s = await scaffold();
    s.spend(CAP - 1); // one micro-dollar short
    s.seedInvocation("inv_wait");

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("over cap but NOTHING waiting → no proposal", async () => {
    const s = await scaffold();
    s.spend(CAP);
    // A done row is not waiting work.
    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("over cap but a free runtime is LIVE → the work is sitting on purpose, not stranded", async () => {
    const s = await scaffold();
    s.spend(CAP);
    seedFreeClaim(s.w, 5 * MIN); // a homelab claimed 5 min ago
    s.seedInvocation("inv_wait"); // NULL-due: free-only while someone free is here

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("over cap but the deadline is FAR OFF → early, not broke", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_far", { due_at: Date.now() + 40 * HOUR });

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("over cap but every waiter is PINNED → privacy's problem, and T3 already speaks for it", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_pin", { privacy: "pinned" });

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("over cap but every waiter carries a backfill ENVELOPE → its own purse, never this month's question", async () => {
    // s26 T3 v2: an envelope-carrying backfill row draws from its envelope,
    // not the monthly budget, so a monthly overage would release NOTHING for
    // it — the jobBudget precedent: never ask a human to approve money that
    // frees no work. Envelope exhaustion is not an error either; the row
    // simply waits for the next envelope or surplus.
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_bf", {
      context_json: JSON.stringify({ emailId: "e_thread", backfill: true, backfillBudgetMicros: 500_000 }),
    });

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("an envelope waiter does not INFLATE a real ask's count or estimate", async () => {
    const s = await scaffold();
    s.spend(CAP); // one $5.00 run = the cost history: median $5.00
    s.seedInvocation("inv_wait_a");
    s.seedInvocation("inv_wait_b");
    s.seedInvocation("inv_bf", {
      context_json: JSON.stringify({ emailId: "e_thread", backfill: true, backfillBudgetMicros: 500_000 }),
    });

    expect(await s.sweep()).toEqual({ asked: 1 });
    const p = s.proposals()[0]!;
    // Two stranded waiters — the envelope row is not part of this question,
    // so the human is quoted the cost of clearing what the grant would clear.
    expect(payloadOf(p).waitingCount).toBe(2);
  });

  it("a DISABLED binding's backlog is held, not asked about — the kill switch wins", async () => {
    const s = await scaffold();
    s.w.db.sqlite.exec(`UPDATE agent_bindings SET enabled = 0 WHERE id = 'bind_photos'`);
    s.spend(CAP);
    s.seedInvocation("inv_wait");

    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("an APPROVED overage that still covers the queue → nothing to ask", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.w.db.seed("agent_budget_overages", [
      {
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        period_key: budgetPeriodKey(Date.now()),
        amount_micros: 1_000_000,
        proposal_id: "p_earlier",
        approved_by: "eric",
        approved_at: Date.now() - HOUR,
      },
    ]);
    s.seedInvocation("inv_wait");

    // Under the RAISED ceiling the binding is not exhausted, so there is no
    // question to ask — the approval already answered it.
    expect(await s.sweep()).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });
});

// ---- expiry ----------------------------------------------------------------

describe("the proposal cannot outlive its period", () => {
  it("expires_at is the period end — an unanswered overage question is moot next month", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_wait");
    await s.sweep();

    const p = s.proposals()[0]!;
    const periodEnd = budgetPeriodEndMs(Date.now());
    expect(p.expires_at).toBe(periodEnd);
    // ...which is strictly sooner than the 7-day default every other proposal
    // gets, unless the month happens to be longer away than that.
    expect(p.expires_at).toBeLessThanOrEqual(Date.now() + 31 * 24 * HOUR);
    expect(p.expires_at).toBeGreaterThan(Date.now());
  });
});

// ---- composition with the rest of the cron ---------------------------------

describe("the sweep composes with T3's, and never claims anything itself", () => {
  it("runs on the cron after the backstop, and leaves the waiting work pending", async () => {
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_wait");

    await s.cron();
    expect(s.proposals()).toHaveLength(1);
    // The sweep ASKS. It does not claim, cancel, fail or re-prioritise anything.
    expect(s.rowOf("inv_wait").status).toBe("pending");
  });

  it("past-due work is the BACKSTOP's, not the sweep's: it is claimed, never asked about", async () => {
    // T3 claims past-due work OUTSIDE the policy gate precisely so budget
    // exhaustion cannot strand it. By the time this sweep runs there is nothing
    // left to ask about — which is why it runs last.
    const s = await scaffold();
    s.spend(CAP);
    s.seedInvocation("inv_late", { due_at: Date.now() - HOUR });

    await s.cron();
    expect(s.rowOf("inv_late").status).toBe("done");
    expect(s.proposals()).toEqual([]);
  });
});

// ---- needsInfo: the answer is a FACT, not a guess ---------------------------

describe('needsInfo — "what would it cost?" is answered from the record', () => {
  it("the EXISTING answer handler serves this kind unchanged, with the numbers in front of it", async () => {
    // s10 T3's `answer-info-request` round is not forked for T9. What T9 owes
    // it is that the answer be DERIVABLE: `composeAnswer` feeds the proposal's
    // rationale/evidence/payload to the model and forbids invention, so the
    // cost estimate has to be ON the record. It is — as `estimateMicros`, and
    // spelled out again in the rationale.
    const s = await scaffold();
    s.spend(1_000_000);
    s.spend(1_000_000);
    s.spend(1_500_000);
    s.spend(1_500_000);
    for (let i = 0; i < 12; i++) s.seedInvocation(`inv_wait_${i}`);
    await s.sweep();
    const proposalId = s.proposals()[0]!.id;

    // The human asks, exactly as ActionProposal/set records it.
    const question = "What would finishing the queue cost?";
    s.w.db.sqlite.exec(
      `UPDATE agent_proposals SET status = 'info-requested', question = '${question}',
         amendments_json = '${JSON.stringify([
           {
             question,
             answer: null,
             askedAt: new Date(1).toISOString(),
             answeredAt: null,
             askedBy: "eric",
           },
         ])}',
         expires_at = NULL, expires_remaining_ms = 3600000
       WHERE id = '${proposalId}'`,
    );
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_answer",
        account_id: ACCOUNT,
        binding_id: "bind_photos",
        binding_name: "photos",
        status: "pending",
        email_id: null,
        context_json: JSON.stringify({ kind: "answer-info-request", proposalId, question }),
        created_at: 999,
      },
    ]);

    // THE DEADLOCK, and how it is broken. The answer round is an ordinary
    // invocation for a binding whose budget is SPENT, so the gated drain will
    // not touch it — "what would it cost?" cannot be answered because there is
    // no money to answer with. `ActionProposal/set` therefore stamps such a
    // round past-due (guarded by the gate's own budget fragment), and T3's
    // backstop — which claims outside the policy gate for exactly this reason —
    // runs it on the next sweep.
    s.w.db.sqlite.exec(`UPDATE agent_invocations SET due_at = ${Date.now()} WHERE id = 'inv_answer'`);
    expect(await drainOnly(s.w)).toBe(0); // the gated path refuses it, as designed
    await s.cron();

    const answered = s.w.db.query<{ status: string; amendments_json: string; expires_at: number }>(
      "SELECT status, amendments_json, expires_at FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      proposalId,
    )[0]!;
    expect(answered.status).toBe("pending"); // back in the human's queue, clock resumed
    const rounds = JSON.parse(answered.amendments_json) as Array<{ answer: string | null }>;
    expect(rounds[0]!.answer).toBeTruthy();
    // The mock model echoes its prompt, so this asserts what the REAL model is
    // given: the estimate, the count and the ceiling, as recorded facts.
    expect(rounds[0]!.answer).toContain(String(1_250_000 * 12)); // estimateMicros
    expect(rounds[0]!.answer).toContain("12"); // waitingCount
    expect(rounds[0]!.answer).toContain(String(CAP)); // capMicros
    expect(rounds[0]!.answer).toContain(question);
  });
});

/** The gated drain alone — the control for "the backstop is the way through". */
async function drainOnly(w: FakeWorker): Promise<number> {
  const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await agentWorker.fetch!(
    new Request("https://agent.internal/drain", {
      method: "POST",
      headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
    }),
    w.env as never,
    execCtx,
  );
  return ((await res.json()) as { handled: number }).handled;
}
