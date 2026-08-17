import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import agentWorker from "./index";

/**
 * s11 T2 — the cloud drain is a PAID claimant, and its own claim path (both
 * the candidate SELECT and the claim UPDATE in index.ts) carries the
 * eligibility gate. These tests drive the REAL worker over POST /drain:
 *
 *   - far-due work sits (a free runtime's to take);
 *   - near-due work escalates to the cloud;
 *   - NULL-due work goes to the cloud IMMEDIATELY unless a free runtime is
 *     live (the stranding guard — the devPlan's "NULL = free-only forever"
 *     composed with a homelab-less prod would strand everything);
 *   - pinned work is NEVER the cloud's, however overdue;
 *   - an out-of-budget binding is free-only;
 *   - ineligible head-of-queue rows do not starve an eligible row behind
 *     them (the SELECT-side gate).
 */

const ACCOUNT = "t_bm__a_drain";
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

async function scaffold(bindingConfig: string = REPLY_CONFIG) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [{ id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: bindingConfig }]);

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

  const seedInvocation = (id: string, extra: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: emailId,
        context_json: JSON.stringify({ emailId, threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
        ...extra,
      },
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
    return res.json() as Promise<{ handled: number }>;
  };

  const statusOf = (id: string) =>
    w.db.query<{ status: string; claimant_free: number | null }>(
      "SELECT status, claimant_free FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  return { w, seedInvocation, drain, statusOf };
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

describe("the paid drain sits on far-due work and escalates near-due", () => {
  it("far-due (outside the window) is left pending; near-due is claimed and done", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_far", { due_at: Date.now() + 3 * HOUR }); // 1h no-history window
    s.seedInvocation("inv_near", { due_at: Date.now() + 30 * MIN });

    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_far").status).toBe("pending"); // sitting, hoping for $0
    expect(s.statusOf("inv_near")).toMatchObject({ status: "done", claimant_free: 0 });
  });

  it("in the SELECT/UPDATE gray zone (inside 4h, outside the exact window) the UPDATE refuses", async () => {
    // The candidate SELECT uses the widest window (4h); the claim UPDATE
    // binds the exact per-binding one (1h here, no history). A row between
    // the two must survive the drain unclaimed — enforcement is the UPDATE.
    const s = await scaffold();
    s.seedInvocation("inv_gray", { due_at: Date.now() + 2 * HOUR });
    const { handled } = await s.drain();
    expect(handled).toBe(0);
    expect(s.statusOf("inv_gray").status).toBe("pending");
  });

  it("past-due work is claimed", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_late", { due_at: Date.now() - HOUR });
    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_late").status).toBe("done");
  });
});

describe("NULL-due: the stranding guard and the sit-free rule", () => {
  it("STRANDING GUARD: with no live free runtime, NULL-due work is claimed by the cloud immediately", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_null"); // no due_at, no facets, no homelab anywhere
    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_null").status).toBe("done");
  });

  it("with a free runtime live (claimed 5min ago), NULL-due work sits for it", async () => {
    const s = await scaffold();
    seedFreeClaim(s.w, 5 * MIN);
    s.seedInvocation("inv_null");
    const { handled } = await s.drain();
    expect(handled).toBe(0);
    expect(s.statusOf("inv_null").status).toBe("pending");
  });

  it("a free claim 20min ago is absence — the cloud takes the work back", async () => {
    const s = await scaffold();
    seedFreeClaim(s.w, 20 * MIN);
    s.seedInvocation("inv_null");
    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_null").status).toBe("done");
  });
});

describe("the privacy pin against the paid drain", () => {
  it("pinned work is NEVER claimed by the cloud, even long past due — it sits (T3 alerts)", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_pin", { privacy: "pinned", due_at: Date.now() - 2 * HOUR });
    const first = await s.drain();
    const second = await s.drain(); // and it is not eventually worn down
    expect(first.handled + second.handled).toBe(0);
    expect(s.statusOf("inv_pin").status).toBe("pending");
  });
});

describe("budget exhaustion holds the paid drain off", () => {
  const BUDGETED = JSON.stringify({
    ...JSON.parse(REPLY_CONFIG),
    budgets: { spendPerMonth: 1_000_000 },
  });

  it("over budget this month: even overdue work is left for a free runtime", async () => {
    const s = await scaffold(BUDGETED);
    s.w.db.seed("agent_invocations", [
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
    s.seedInvocation("inv_due", { due_at: Date.now() - HOUR });
    const { handled } = await s.drain();
    expect(handled).toBe(0);
    expect(s.statusOf("inv_due").status).toBe("pending");
  });

  it("under budget: the same overdue work is claimed", async () => {
    const s = await scaffold(BUDGETED);
    s.seedInvocation("inv_due", { due_at: Date.now() - HOUR });
    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_due").status).toBe("done");
  });
});

describe("ineligible rows do not starve eligible ones (the SELECT-side gate)", () => {
  it("a head-of-queue run of far-due rows longer than the batch does not block a NULL-due row behind them", async () => {
    const s = await scaffold();
    // Seven far-due rows, all OLDER (created_at) than the eligible row: more
    // than one DRAIN_BATCH (5) of ineligible work at the head of the queue.
    for (let i = 0; i < 7; i++) {
      s.seedInvocation(`inv_sit_${i}`, { due_at: Date.now() + 40 * HOUR, created_at: 10 + i });
    }
    s.seedInvocation("inv_ready", { created_at: 100 }); // NULL-due, no free runtime → eligible
    const { handled } = await s.drain();
    expect(handled).toBe(1);
    expect(s.statusOf("inv_ready").status).toBe("done");
    for (let i = 0; i < 7; i++) expect(s.statusOf(`inv_sit_${i}`).status).toBe("pending");
  });
});
