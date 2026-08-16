import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { EmailRow } from "@bullmoose/mailstore";
import { parseRemindRequest, runRemind, type RemindJob } from "./remind";
import { sweepWatches } from "./watches";

// s20 wave 2 — remind@, the mail-native Watches door. A human CCs remind@ with
// a deadline in plain words; a Watch is armed on THEIR account (not remind@'s),
// and the ordinary sweep fires it into their approvals. The two properties that
// make it trustworthy: the deadline parser is the SAME conservative one ingest
// uses (a request it cannot pin gets a teaching reply, never a guessed time),
// and the watch it arms is a real, fireable one — proven end-to-end below.

const HUMAN = "eric@bullmoose.cc";
const HUMAN_ACCOUNT = "t_bm__a_eric";
const REMIND_ACCOUNT = "t_bm__a_remind"; // the invocation runs on remind@'s account

// A date far enough out that extractDueAt (which rejects past deadlines)
// resolves it to a fixed future instant no matter when the suite runs.
const FUTURE_CUE = "by 2099-12-31";
const FUTURE_AT = Date.UTC(2099, 11, 31, 17, 0); // EOD 17:00 UTC, per dueDate

function world() {
  const w = fakeEnv();
  // The human whose reminder this is — resolvable by identity email.
  w.db.seedAccount({ accountId: HUMAN_ACCOUNT, loginEmail: HUMAN, displayName: "Eric" });
  w.db.seed("identities", [{ id: "id_eric", account_id: HUMAN_ACCOUNT, email: HUMAN, name: "Eric" }]);
  // remind@ itself (the invocation's account); no identity needed for the test.
  w.db.seedAccount({ accountId: REMIND_ACCOUNT, principalId: "p_remind", loginEmail: "remind@bullmoose.cc" });
  return w;
}

const job: RemindJob = { id: "inv_abc", account_id: REMIND_ACCOUNT, binding_name: "remind@", tenant_id: "t_bm" };

function inbound(o: { from?: string; subject?: string; body?: string }): EmailRow {
  return {
    id: "e_in",
    from: [{ email: o.from ?? HUMAN }],
    subject: o.subject ?? "",
    preview: (o.body ?? "").slice(0, 256),
    messageId: "m_in@x",
  } as unknown as EmailRow;
}

const armedWatches = (w: ReturnType<typeof fakeEnv>) =>
  w.db.query<{
    id: string;
    account_id: string;
    owner: string;
    condition_type: string;
    action_type: string;
    status: string;
    deadline_at: number;
    action_json: string;
  }>(`SELECT * FROM watches`);

describe("parseRemindRequest — the deterministic read", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");

  it("pins a cue-word deadline and takes the note from the subject", () => {
    const p = parseRemindRequest({ subject: `Follow up with Sergio ${FUTURE_CUE}`, text: "", now });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.deadlineAt).toBe(FUTURE_AT);
      expect(p.note).toBe("Follow up with Sergio by 2099-12-31");
    }
  });

  it("refuses a vague time rather than guess — a wrong reminder is worse than none", () => {
    expect(parseRemindRequest({ subject: "ping me soon", text: "sometime next week?", now }).ok).toBe(false);
    expect(parseRemindRequest({ subject: "remind me tomorrow", text: "", now }).ok).toBe(false);
  });

  it("strips Re:/Fwd: scaffolding, and falls back to the body's first line when the subject is empty", () => {
    const a = parseRemindRequest({ subject: `Re: Fwd: the invoice ${FUTURE_CUE}`, text: "", now });
    if (a.ok) expect(a.note).toBe(`the invoice ${FUTURE_CUE}`);

    const b = parseRemindRequest({ subject: "", text: `\n\ncall the vet ${FUTURE_CUE}\nand book a slot`, now });
    if (b.ok) expect(b.note).toBe(`call the vet ${FUTURE_CUE}`);
  });
});

describe("runRemind — arms a Watch on the human's account", () => {
  it("writes a deadline/notify watch to the SENDER's account and confirms", async () => {
    const w = world();
    const reply = vi.fn(async (_text: string) => "e_reply");
    const finish = vi.fn(async () => {});
    await runRemind(w.env, job, inbound({ subject: `Follow up with Sergio ${FUTURE_CUE}` }), {}, reply, finish);

    const rows = armedWatches(w);
    expect(rows).toHaveLength(1);
    const watch = rows[0]!;
    expect(watch.account_id).toBe(HUMAN_ACCOUNT); // NOT remind@'s account
    expect(watch.owner).toBe(HUMAN);
    expect(watch.condition_type).toBe("deadline");
    expect(watch.action_type).toBe("notify"); // a pure reminder — nothing egresses
    expect(watch.status).toBe("armed");
    expect(watch.deadline_at).toBe(FUTURE_AT);
    expect(JSON.parse(watch.action_json).note).toBe("Follow up with Sergio by 2099-12-31");

    // The confirmation reply went out; the run finished done.
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]![0]).toContain("Reminder set");
    expect(finish).toHaveBeenCalledWith("done", expect.objectContaining({ note: "watch armed" }));
  });

  it("the armed watch is REAL: the sweep fires it into the human's approvals", async () => {
    const w = world();
    await runRemind(w.env, job, inbound({ subject: `ship the taxes ${FUTURE_CUE}` }), {}, async () => "e", async () => {});

    // Sweep with a clock past the (far-future) deadline.
    await sweepWatches(w.env, FUTURE_AT + 1000);

    const watch = armedWatches(w)[0]!;
    expect(watch.status).toBe("fired");
    const prop = w.db.query<{ account_id: string; kind: string; tier: number; status: string }>(
      `SELECT account_id, kind, tier, status FROM agent_proposals`,
    );
    expect(prop).toHaveLength(1);
    expect(prop[0]!.account_id).toBe(HUMAN_ACCOUNT); // lands in the HUMAN's queue
    expect(prop[0]!.kind).toBe("watch-notify");
    expect(prop[0]!.tier).toBe(1); // reversible FYI
    expect(prop[0]!.status).toBe("pending");
  });

  it("no deadline it trusts: no watch, a TEACHING reply, done", async () => {
    const w = world();
    const reply = vi.fn(async (_text: string) => "e_reply");
    const finish = vi.fn(async () => {});
    await runRemind(w.env, job, inbound({ subject: "remind me about the thing", body: "soon-ish" }), {}, reply, finish);

    expect(armedWatches(w)).toHaveLength(0);
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]![0]).toMatch(/couldn't find a deadline/i);
    expect(finish).toHaveBeenCalledWith("done", expect.objectContaining({ note: expect.stringContaining("teaching") }));
  });

  it("a sender with no bullmoose account is skipped SILENTLY — no watch, no reply (no oracle)", async () => {
    const w = world();
    const reply = vi.fn(async (_text: string) => "e_reply");
    const finish = vi.fn(async () => {});
    await runRemind(
      w.env,
      job,
      inbound({ from: "stranger@example.com", subject: `do a thing ${FUTURE_CUE}` }),
      {},
      reply,
      finish,
    );

    expect(armedWatches(w)).toHaveLength(0);
    expect(reply).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("done", expect.objectContaining({ note: expect.stringContaining("not a live") }));
  });

  it("idempotent on retry: the same invocation arms one watch and confirms once", async () => {
    const w = world();
    const reply = vi.fn(async (_text: string) => "e_reply");
    const finish = vi.fn(async () => {});
    const msg = inbound({ subject: `renew the domain ${FUTURE_CUE}` });

    await runRemind(w.env, job, msg, {}, reply, finish); // first run: arms + confirms
    await runRemind(w.env, job, msg, {}, reply, finish); // reaped-and-retried: same job.id

    expect(armedWatches(w)).toHaveLength(1); // exactly one, ever
    expect(reply).toHaveBeenCalledOnce(); // no double confirmation
    expect(finish).toHaveBeenLastCalledWith("done", expect.objectContaining({ note: expect.stringContaining("already armed") }));
  });
});
