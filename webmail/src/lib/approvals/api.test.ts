import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { correctDueAt, decide, loadQueue } from "./api";
import { installApprovalsDemo, type ApprovalsDemoBackend } from "./demoApprovals";

const ACCOUNT = "acct-fake";
// Wall time, not a pinned instant: the demo's `/set` stamps decisions with
// `Date.now()` exactly as the server does, so a pinned fixture anchor would
// put decision clocks (holdUntil) on the wrong side of fixture clocks
// (expiresAt). Fixture-shape assertions that want a pinned NOW live in
// `demoApprovals.test.ts`.
const NOW = Date.now();

function harness(opts: Parameters<typeof installApprovalsDemo>[1] = {}): {
  client: FakeJmapClient;
  backend: ApprovalsDemoBackend;
} {
  const client = new FakeJmapClient();
  const backend = installApprovalsDemo(client, { now: NOW, ...opts });
  return { client, backend };
}

describe("loadQueue", () => {
  it("returns the whole collection in one query→get round trip", async () => {
    const { client } = harness();
    const { proposals, state } = await loadQueue(client, ACCOUNT);
    expect(proposals.length).toBe(10);
    expect(state).toBe("0");
    // Every status the arch names is present in the fixture set, so the whole
    // surface — queue, waiting-on-agent, hold tray, history — is drivable
    // without a server.
    const statuses = new Set(proposals.map((p) => p.status));
    for (const s of ["pending", "info-requested", "held", "approved", "rejected", "expired"]) {
      expect(statuses, `fixture set is missing status ${s}`).toContain(s);
    }
    // …and all three tiers among the PENDING rows, plus the shared-queue ask.
    const pending = proposals.filter((p) => p.status === "pending");
    expect(new Set(pending.map((p) => p.tier))).toEqual(new Set([1, 2, 3]));
    expect(pending.some((p) => p.kind === "grant-request")).toBe(true);
  });
});

describe("decide → ActionProposal/set", () => {
  it("tier-2 approve lands in the HOLD TRAY: held + holdUntil, and no egress", async () => {
    const { client, backend } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-reply-elk", { status: "approved" });
    expect(outcome).toEqual({ ok: true });
    const row = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(row.status).toBe("held");
    expect(row.holdUntil).not.toBeNull();
    // The retraction window is holdUntil, NOT the (still-future) expiresAt.
    expect(Date.parse(row.holdUntil!)).toBeLessThan(Date.parse(row.expiresAt!));
    // Nothing was sent: the commit out of the tray is s03.D T2.
    expect(backend.sent).toEqual([]);
  });

  it("an approve WITH edits writes editedPayload and never touches payload", async () => {
    const { client, backend } = harness();
    const before = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    const originalText = before.payload.text as string;
    const edited = { ...before.payload, text: "Shorter. Monday works.\n— Eric" };

    const outcome = await decide(client, ACCOUNT, "ap-reply-elk", {
      status: "approved",
      editedPayload: edited,
    });
    expect(outcome).toEqual({ ok: true });

    const after = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    // The agent's original survives; the human's version lands beside it.
    // This is the diff the s07 score reads — losing it is the bug.
    expect(after.payload.text).toBe(originalText);
    expect(after.editedPayload?.text).toBe("Shorter. Monday works.\n— Eric");
  });

  it("an edited tier-3 approve SENDS the edited version and RETAINS the original", async () => {
    // Retention must hold on the apply path too, not just in the hold tray:
    // the server applies the EFFECTIVE payload (edited if present,
    // actionProposal.ts:294-298) while the row keeps the agent's original.
    const { client, backend } = harness();
    const before = backend.proposals.find((p) => p.id === "ap-reply-invoice")!;
    const originalSubject = before.payload.subject as string;
    const edited = { ...before.payload, subject: "Re: Invoice 0042 — paid" };

    const outcome = await decide(client, ACCOUNT, "ap-reply-invoice", {
      status: "approved",
      editedPayload: edited,
    });
    expect(outcome).toEqual({ ok: true });
    // What egressed is the human's version…
    expect(backend.sent).toEqual([{ id: "ap-reply-invoice", to: "billing@example.test", subject: "Re: Invoice 0042 — paid" }]);
    // …and what is retained is still the agent's.
    const after = backend.proposals.find((p) => p.id === "ap-reply-invoice")!;
    expect(after.payload.subject).toBe(originalSubject);
    expect(after.editedPayload?.subject).toBe("Re: Invoice 0042 — paid");
  });

  it("tier-1 approve applies immediately and keeps an undo handle", async () => {
    const { client, backend } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-contact-dana", { status: "approved" });
    expect(outcome).toEqual({ ok: true });
    expect(backend.proposals.find((p) => p.id === "ap-contact-dana")!.status).toBe("approved");
    expect(backend.applied).toEqual([
      { id: "ap-contact-dana", kind: "create-contact", undo: { action: "destroy-contact", cardId: "cc-ap-contact-dana" } },
    ]);
  });

  it("tier-3 approve with the send capability egresses — and says so in `sent`", async () => {
    const { client, backend } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-reply-invoice", { status: "approved" });
    expect(outcome).toEqual({ ok: true });
    expect(backend.sent).toEqual([
      { id: "ap-reply-invoice", to: "billing@example.test", subject: "Re: Invoice 0042 — payment confirmation" },
    ]);
  });

  it("tier-3 approve WITHOUT send is refused with the server's capability-wall sentence", async () => {
    const { client, backend } = harness({ scopes: ["read", "annotate", "draft", "move", "delete"] });
    const outcome = await decide(client, ACCOUNT, "ap-reply-invoice", { status: "approved" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("requires the send capability");
      expect(outcome.message).toContain("cannot auto-commit irreversible egress");
    }
    // Refused means refused: still pending, nothing egressed.
    expect(backend.proposals.find((p) => p.id === "ap-reply-invoice")!.status).toBe("pending");
    expect(backend.sent).toEqual([]);
  });

  it("decline records the no-thanks signal: reason enum + note + who", async () => {
    const { client, backend } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-grant-photos", {
      status: "rejected",
      reason: "notNow",
      note: "after the fair",
    });
    expect(outcome).toEqual({ ok: true });
    const row = backend.proposals.find((p) => p.id === "ap-grant-photos")!;
    expect(row.status).toBe("rejected");
    expect(row.decision).toEqual({ by: "fake@bullmoose.test", reason: "notNow", note: "after the fair" });
  });

  it("a decided row is not re-decidable (T1: only pending decides; yank is T2)", async () => {
    const { client } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-held-agenda", { status: "rejected", reason: "notNow" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("is held, not pending");
  });

  it("surfaces a stateMismatch instead of silently overwriting a moved queue", async () => {
    const { client } = harness();
    await decide(client, ACCOUNT, "ap-contact-dana", { status: "approved" }); // moves state 0→1
    const stale = await decide(client, ACCOUNT, "ap-reply-elk", { status: "approved" }, { ifInState: "0" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.message).toContain("stateMismatch");
  });
});

describe("decide → needsInfo (s10 T3)", () => {
  it("moves a pending row to info-requested, pauses the deadline, appends the open round — and records NO decision", async () => {
    const { client, backend } = harness();
    const before = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(before.expiresAt).not.toBeNull();

    const outcome = await decide(client, ACCOUNT, "ap-reply-elk", {
      status: "info-requested",
      question: "Why does Grace need an answer today?",
    });
    expect(outcome).toEqual({ ok: true });

    const row = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(row.status).toBe("info-requested");
    expect(row.question).toBe("Why does Grace need an answer today?");
    // The PAUSE: no deadline while the ball is in the agent's court.
    expect(row.expiresAt).toBeNull();
    // The RL invariant: an action, not a reject — nothing decision-shaped.
    expect(row.decision).toBeNull();
    // The open round APPENDED, answer owed.
    expect(row.amendments).toHaveLength(1);
    expect(row.amendments[0]).toMatchObject({
      question: "Why does Grace need an answer today?",
      answer: null,
      answeredAt: null,
    });
  });

  it("refuses an empty question with the server's sentence", async () => {
    const { client, backend } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-reply-elk", {
      status: "info-requested",
      question: "   ",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("non-empty");
    expect(backend.proposals.find((p) => p.id === "ap-reply-elk")!.status).toBe("pending");
  });

  it("the ANSWER (the worker's job, driven via backend.answer) returns the row to pending with the dialogue and a resumed clock", async () => {
    const { client, backend } = harness();
    await decide(client, ACCOUNT, "ap-reply-elk", {
      status: "info-requested",
      question: "Why today?",
    });

    backend.answer("ap-reply-elk", "Grace's note says the venue releases the slot at 5pm.");

    const row = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(row.status).toBe("pending");
    expect(row.question).toBeNull();
    // The banked remainder was restored — a deadline exists again.
    expect(row.expiresAt).not.toBeNull();
    // The Q&A survives on the proposal forever.
    expect(row.amendments).toHaveLength(1);
    expect(row.amendments[0]!.answer).toContain("releases the slot");

    // One round per human action: a second answer with no fresh question is
    // a refusal (worker: failed invocation; demo: a no-op).
    backend.answer("ap-reply-elk", "spam re-answer");
    const after = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(after.amendments).toHaveLength(1);
    expect(after.amendments[0]!.answer).toContain("releases the slot");
  });

  it("a needsInfo verdict never carries a decision — the patch has only the question", async () => {
    // Guarded here because decide() BUILDS the patch: if it ever started
    // attaching a decision to this verb, the server would refuse — but the
    // client must not even try (the taxonomy invariant, client half).
    const { client } = harness();
    const outcome = await decide(client, ACCOUNT, "ap-grant-photos", {
      status: "info-requested",
      question: "Why the whole folder and not the day's uploads?",
    });
    expect(outcome).toEqual({ ok: true });
  });
});

describe("correctDueAt → the status-free { dueAt } patch (s11 T1)", () => {
  it("corrects the due date and leaves the row PENDING — a correction, not a decision", async () => {
    const { client, backend } = harness();
    const corrected = new Date(NOW + 3 * 24 * 3600_000).toISOString();

    const outcome = await correctDueAt(client, ACCOUNT, "ap-reply-elk", corrected);
    expect(outcome).toEqual({ ok: true });

    const row = backend.proposals.find((p) => p.id === "ap-reply-elk")!;
    expect(row.dueAt).toBe(corrected);
    // Nothing decision-shaped moved: still pending, no decision, clocks intact.
    expect(row.status).toBe("pending");
    expect(row.decision).toBeNull();
    expect(row.expiresAt).not.toBeNull();
  });

  it("clears a mis-read deadline back to never-urgent with dueAt: null", async () => {
    const { client, backend } = harness();
    expect(backend.proposals.find((p) => p.id === "ap-reply-elk")!.dueAt).not.toBeNull();
    const outcome = await correctDueAt(client, ACCOUNT, "ap-reply-elk", null);
    expect(outcome).toEqual({ ok: true });
    expect(backend.proposals.find((p) => p.id === "ap-reply-elk")!.dueAt).toBeNull();
  });

  it("surfaces the server's refusal of an unparseable date", async () => {
    const { client, backend } = harness();
    const outcome = await correctDueAt(client, ACCOUNT, "ap-reply-elk", "a week from Tuesday");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("ISO 8601");
    expect(backend.proposals.find((p) => p.id === "ap-reply-elk")!.dueAt).not.toBeNull(); // untouched
  });
});
