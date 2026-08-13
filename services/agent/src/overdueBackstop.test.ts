import { describe, expect, it } from "vitest";
import { armResponder } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import type { ClaimantIdentity } from "@bullmoose/scheduling";
import agentWorker, { escalateOverdue } from "./index";

/**
 * s11 T3 — the watchdog reconcile. The scheduler's optimism (T2: sit for
 * free, escalate near-due, hold off out-of-budget work) must never STRAND
 * work, and the §8 liveness backstop must not violate the privacy pin.
 *
 * The invariant these tests hold, in the exact form devPlan decision 0 leaves
 * it: **no invocation with a past `due_at` sits `pending` SILENTLY.** Past
 * due, the cloud claims OUTSIDE the policy gate — otherwise the backstop
 * would refuse precisely the budget-exhausted work it exists to rescue, and
 * be decorative. Two things survive the bypass, and both end in an ALERT
 * rather than a claim:
 *
 *   pinned  privacy beats liveness. The work sits for a private runtime.
 *   unfit   claiming work this runtime cannot satisfy burns the deadline on
 *           a run that must fail.
 *
 * The tests below are written to BITE: the budget case proves the bypass is
 * real (a gated claim refuses it), the pinned case proves the exemption
 * survives however overdue, and the alert-once case proves repeated sweeps
 * cannot storm.
 */

const ACCOUNT = "t_bm__a_overdue";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;

const REPLY_CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are Emily.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
});

/** The same binding, with a monthly cap the fixture then exhausts. */
const BUDGETED_CONFIG = JSON.stringify({
  ...(JSON.parse(REPLY_CONFIG) as Record<string, unknown>),
  budgets: { spendPerMonth: 1_000_000 },
});

/** A claimant that DECLARES a vector, and so can be unfit for work. */
const NO_VISION: ClaimantIdentity = {
  isFree: false,
  capabilities: { vision: false, tools: true, contextTokens: 128_000 },
};

const EMAIL_ID = "e_thread";

async function scaffold(bindingConfig: string = REPLY_CONFIG) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    { id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: bindingConfig },
  ]);

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
    id: EMAIL_ID,
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

  const seedInvocation = (id: string, extra: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: EMAIL_ID,
        context_json: JSON.stringify({ emailId: EMAIL_ID, threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
        ...extra,
      },
    ]);

  /** Exhaust this month's budget: one done invocation that spent the cap. */
  const spendTheBudget = () =>
    w.db.seed("agent_invocations", [
      {
        id: "inv_spent",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "done",
        created_at: 1,
        claimed_at: Date.now() - 2000,
        done_at: Date.now() - 1000,
        cost_micros: 1_000_000,
      },
    ]);

  /** The whole cron hook — drain first, then the backstop, as in production. */
  const cron = async () => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await agentWorker.scheduled!(
      { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController,
      w.env as never,
      execCtx,
    );
  };

  const rowOf = (id: string) =>
    w.db.query<{
      status: string;
      claimant_free: number | null;
      alert_kind: string | null;
      alert_at: number | null;
    }>(
      "SELECT status, claimant_free, alert_kind, alert_at FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  /** How many times the changelog was told this invocation changed. */
  const changelogHits = (id: string) =>
    w.accountDo.commits
      .flatMap((c) => c.entries)
      .filter((e) => e.collection === "AgentInvocation" && (e.updated ?? []).includes(id)).length;

  return { w, seedInvocation, spendTheBudget, cron, rowOf, changelogHits };
}

/** A free runtime's fingerprint: a claim with claimant_free = 1, `agoMs` ago. */
function seedFreeClaim(w: FakeWorker, agoMs: number) {
  w.db.seed("agent_invocations", [
    {
      id: `inv_by_free_${agoMs}`,
      account_id: ACCOUNT,
      binding_id: "bind_emily",
      binding_name: "emily",
      status: "done",
      created_at: 1,
      claimed_at: Date.now() - agoMs,
      done_at: Date.now() - agoMs + 500,
      claimant_free: 1,
    },
  ]);
}

// ---- the bypass ------------------------------------------------------------

describe("the overdue backstop claims OUTSIDE the policy gate", () => {
  it("out of budget and past due: the gate refuses, the watchdog claims anyway", async () => {
    const s = await scaffold(BUDGETED_CONFIG);
    s.spendTheBudget();
    s.seedInvocation("inv_late", { due_at: Date.now() - HOUR });

    // The proof that this is a bypass and not a coincidence: the gated drain
    // leaves it alone (drainEligibility.test.ts pins that), and the cron —
    // which runs the drain FIRST — still ends with the row done.
    const drained = await drainOnly(s.w);
    expect(drained.handled).toBe(0);
    expect(s.rowOf("inv_late").status).toBe("pending");

    await s.cron();
    expect(s.rowOf("inv_late")).toMatchObject({ status: "done", claimant_free: 0 });
    // Claimed, not alerted: an alert is for work nobody may take.
    expect(s.rowOf("inv_late").alert_kind).toBeNull();
  });

  it("THE INVARIANT: deferred-then-overdue is claimed by the cloud though every free runtime stayed down", async () => {
    // The devPlan's test, exactly: a row that sat free-only while it was far
    // from due, whose deadline then passed with no homelab in sight and no
    // paid budget left. Nothing in the eligible set can take it; the backstop
    // must, or the work is stranded forever.
    const s = await scaffold(BUDGETED_CONFIG);
    s.spendTheBudget();
    s.seedInvocation("inv_deferred", { due_at: Date.now() - 30 * MIN });
    s.seedInvocation("inv_far", { due_at: Date.now() + 40 * HOUR }); // still sitting, correctly

    await s.cron();

    expect(s.rowOf("inv_deferred").status).toBe("done");
    expect(s.rowOf("inv_far").status).toBe("pending");
    // And the invariant as a query: nothing past due is pending and unspoken.
    const stranded = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_invocations
       WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ? AND alert_kind IS NULL`,
      Date.now(),
    )[0]!;
    expect(stranded.n).toBe(0);
  });
});

// ---- the privacy pin -------------------------------------------------------

describe("privacy is a pin: past-due pinned work SITS, and the human is told", () => {
  it("pinned + overdue is never claimed, and is alerted exactly once across repeated sweeps", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_pin", { privacy: "pinned", due_at: Date.now() - 2 * HOUR });

    await s.cron();
    const first = s.rowOf("inv_pin");
    expect(first.status).toBe("pending"); // privacy beat liveness
    expect(first.alert_kind).toBe("overdue-pinned");
    expect(first.alert_at).toBeGreaterThan(0);

    // NO ALERT STORM: the cron runs every few minutes and this row will stay
    // stuck for as long as the homelab is down. The marker is raised once.
    await s.cron();
    await s.cron();
    expect(s.rowOf("inv_pin")).toMatchObject({
      status: "pending",
      alert_kind: "overdue-pinned",
      alert_at: first.alert_at,
    });
    expect(s.changelogHits("inv_pin")).toBe(1);
  });

  it("the alert is durable and queryable — the marker is a row, not a log line", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_pin", { privacy: "pinned", due_at: Date.now() - HOUR });
    s.seedInvocation("inv_ok", { due_at: Date.now() - HOUR });
    await s.cron();

    const alerted = s.w.db.query<{ id: string; alert_kind: string }>(
      `SELECT id, alert_kind FROM agent_invocations
       WHERE account_id = ? AND alert_kind IS NOT NULL ORDER BY id`,
      ACCOUNT,
    );
    expect(alerted).toEqual([{ id: "inv_pin", alert_kind: "overdue-pinned" }]);
  });
});

// ---- fit ------------------------------------------------------------------

describe("cloud-unfit overdue work is treated like pinned: alerted, not claimed", () => {
  it("a declared vector that cannot meet requires_json alerts instead of burning the deadline", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_vision", {
      due_at: Date.now() - HOUR,
      requires_json: JSON.stringify({ vision: true }),
    });

    const res = await escalateOverdue(s.w.env as never, NO_VISION);
    expect(res).toEqual({ claimed: 0, alerted: 1 });
    expect(s.rowOf("inv_vision")).toMatchObject({
      status: "pending",
      alert_kind: "overdue-unfit",
    });
  });

  it("...and the same row IS claimed by a runtime that declares no vector (T2-FIT-CONTRACT)", async () => {
    // The asymmetry is deliberate and lives in `fit()`: an UNDECLARED vector
    // claims exactly as today, so today's cloud (which declares nothing) has
    // no unfit set and this branch is dormant in production — correct the day
    // the cloud declares one, rather than a hardcode that can never fire.
    const s = await scaffold();
    s.seedInvocation("inv_vision", {
      due_at: Date.now() - HOUR,
      requires_json: JSON.stringify({ vision: true }),
    });

    const res = await escalateOverdue(s.w.env as never);
    expect(res.claimed).toBe(1);
    expect(res.alerted).toBe(0);
    expect(s.rowOf("inv_vision").alert_kind).toBeNull();
  });
});

// ---- DefaultCase ----------------------------------------------------------

describe("DefaultCase: the sweep touches nothing that is not past due", () => {
  it("unfaceted, due-less work is invisible to the backstop", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_plain"); // no due_at, no facets — today's shape
    s.seedInvocation("inv_future", { due_at: Date.now() + 40 * HOUR });
    s.seedInvocation("inv_pin_future", { privacy: "pinned", due_at: Date.now() + 40 * HOUR });

    // The sweep alone, so the ordinary drain cannot be mistaken for it.
    expect(await escalateOverdue(s.w.env as never)).toEqual({ claimed: 0, alerted: 0 });
    for (const id of ["inv_plain", "inv_future", "inv_pin_future"]) {
      expect(s.rowOf(id)).toMatchObject({ status: "pending", alert_kind: null, alert_at: null });
    }
  });

  it("a disabled binding's overdue work is held, not force-claimed — the kill switch wins", async () => {
    const s = await scaffold();
    s.w.db.sqlite.exec(`UPDATE agent_bindings SET enabled = 0 WHERE id = 'bind_emily'`);
    s.seedInvocation("inv_late", { due_at: Date.now() - HOUR });

    expect(await escalateOverdue(s.w.env as never)).toEqual({ claimed: 0, alerted: 0 });
    // Held, and NOT alerted: `reportHeldBacklog` already speaks for a queue
    // behind a pulled switch, and "the operator turned it off" is not a
    // liveness failure the watchdog should be shouting about.
    expect(s.rowOf("inv_late")).toMatchObject({ status: "pending", alert_kind: null });
  });
});

// ---- composition with the §8 SLA-silence trigger ---------------------------

describe("the two watchdog triggers compose (agent-integration.md §8)", () => {
  /** Arm the binding's SLA watchdog for the delivered message, as ingest does. */
  async function armSlaWatchdog(w: FakeWorker, fireAt: number) {
    w.db.seed("responders", [
      {
        id: "watchdog_bind_emily",
        account_id: ACCOUNT,
        kind: "watchdog",
        enabled: 1,
        wait_seconds: 60,
        cancel_if: "invocation-active",
        text_body: "emily appears to be unavailable; your message is queued.",
        suppress_seconds: 3600,
      },
    ]);
    await armResponder(w.env.ACCOUNT_DO, {
      responderId: "watchdog_bind_emily",
      accountId: ACCOUNT,
      tenantId: TENANT,
      accountAddress: SELF,
      sender: SENDER,
      origMessageId: "msg-1@example.com",
      origSubject: "please review",
      emailId: EMAIL_ID,
      cancelIf: "invocation-active",
      fireAt,
    });
  }

  it("SLA silence still fires when nobody has claimed — unchanged by T3", async () => {
    const s = await scaffold();
    seedFreeClaim(s.w, 5 * MIN); // a homelab is live, so the drain sits...
    s.seedInvocation("inv_quiet"); // ...on this NULL-due row, and never claims it
    await armSlaWatchdog(s.w, Date.now() - 1);

    await s.cron(); // the backstop has nothing to say: no due_at, nothing past due
    expect(s.rowOf("inv_quiet").status).toBe("pending");

    await s.w.accountDo.runAlarm(ACCOUNT);
    expect(s.w.submit.calls).toEqual([{ mailFrom: SELF, rcptTo: [SENDER] }]);
  });

  it("the overdue backstop STANDS THE SLA RESPONDER DOWN by claiming (cancelIf: invocation-active)", async () => {
    const s = await scaffold(BUDGETED_CONFIG);
    s.spendTheBudget();
    s.seedInvocation("inv_late", { due_at: Date.now() - HOUR });
    await armSlaWatchdog(s.w, Date.now() - 1);

    await s.cron(); // the backstop claims and runs it
    expect(s.rowOf("inv_late").status).toBe("done");

    await s.w.accountDo.runAlarm(ACCOUNT);
    // Nothing relayed to the SENDER: the work got done, so there is no outage
    // to apologise for. (The reply itself is a draft in this binding's mode.)
    expect(s.w.submit.calls).toEqual([]);
  });

  it("pinned overdue reaches BOTH: the marker for the owner, the §8 notice for the sender", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_pin", { privacy: "pinned", due_at: Date.now() - HOUR });
    await armSlaWatchdog(s.w, Date.now() - 1);

    await s.cron();
    expect(s.rowOf("inv_pin").alert_kind).toBe("overdue-pinned");

    await s.w.accountDo.runAlarm(ACCOUNT);
    expect(s.w.submit.calls).toEqual([{ mailFrom: SELF, rcptTo: [SENDER] }]);
  });
});

/** The gated drain on its own — the control for "the backstop is a bypass". */
async function drainOnly(w: FakeWorker): Promise<{ handled: number }> {
  const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await agentWorker.fetch!(
    new Request("https://agent.internal/drain", {
      method: "POST",
      headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
    }),
    w.env as never,
    execCtx,
  );
  return res.json() as Promise<{ handled: number }>;
}
