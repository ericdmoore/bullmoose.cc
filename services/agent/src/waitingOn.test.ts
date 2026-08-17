import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { sweepWaitingOn } from "./waitingOn";

// s20 T1↔T4 — the anti-star. The sweep scans YOUR Sent mail for a question you
// asked that went unanswered past a threshold, and OFFERS to watch it. The two
// properties that keep it from being a second inbox: it offers only inside a
// silence window (old enough to notice, not so old it's moot), and it offers a
// thread at most once — a reply that already arrived, a watch already on the
// thread, or a prior offer all mean silence, not a fresh nudge.

const ACCOUNT = "t_bm__a_eric";
const SELF = "eric@bullmoose.cc";
const DAY = 24 * 3600_000;
const NOW = 10_000_000_000_000; // fixed clock; sweepWaitingOn takes `now`

function world() {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: SELF, displayName: "Eric" });
  // The Sent mailbox — `mb.role='sent'` is what scopes the scan to sent mail.
  w.db.seed("mailboxes", [{ id: "mb_sent", account_id: ACCOUNT, name: "Sent", role: "sent", sort_order: 0 }]);
  return w;
}

/** Seed a message in the Sent mailbox: something YOU sent. */
function seedSent(
  w: ReturnType<typeof fakeEnv>,
  o: { id: string; to: string; subject: string; sentAt: number; threadId?: string; preview?: string },
) {
  const threadId = o.threadId ?? `th_${o.id}`;
  w.db.seed("emails", [
    {
      id: o.id,
      account_id: ACCOUNT,
      blob_id: "b",
      thread_id: threadId,
      message_id: `${o.id}@x`,
      subject: o.subject,
      from_json: JSON.stringify([{ email: SELF }]),
      to_json: JSON.stringify([{ email: o.to }]),
      preview: o.preview ?? "body",
      size: 4,
      received_at: o.sentAt,
      has_attachment: 0,
    },
  ]);
  w.db.seed("email_mailboxes", [{ account_id: ACCOUNT, email_id: o.id, mailbox_id: "mb_sent" }]);
  return threadId;
}

/** A reply landing in the account (any mailbox) from `sender` on `threadId`. */
function seedReply(w: ReturnType<typeof fakeEnv>, sender: string, threadId: string, receivedAt: number) {
  w.db.seed("emails", [
    {
      id: `re_${receivedAt}`,
      account_id: ACCOUNT,
      blob_id: "b",
      thread_id: threadId,
      message_id: `re${receivedAt}@x`,
      subject: "re",
      from_json: JSON.stringify([{ email: sender }]),
      to_json: JSON.stringify([{ email: SELF }]),
      preview: "hi",
      size: 2,
      received_at: receivedAt,
      has_attachment: 0,
    },
  ]);
}

const offers = (w: ReturnType<typeof fakeEnv>) =>
  w.db.query<{ id: string; kind: string; tier: number; account_id: string; payload_json: string; subject_json: string; evidence_json: string }>(
    `SELECT id, kind, tier, account_id, payload_json, subject_json, evidence_json FROM agent_proposals WHERE kind = 'watch-offer'`,
  );

describe("sweepWaitingOn — offers a watch on an unanswered question", () => {
  it("offers a tier-1 watch-offer for a sent question gone quiet, citing the message", async () => {
    const w = world();
    seedSent(w, { id: "e_ask", to: "sergio@example.com", subject: "are you free Thursday?", sentAt: NOW - 5 * DAY });
    await sweepWaitingOn(w.env, NOW);

    const rows = offers(w);
    expect(rows).toHaveLength(1);
    const o = rows[0]!;
    expect(o.tier).toBe(1); // arming a watch egresses nothing — reversible
    expect(o.account_id).toBe(ACCOUNT);
    const payload = JSON.parse(o.payload_json);
    expect(payload.to).toBe("sergio@example.com");
    expect(payload.threadId).toBe("th_e_ask");
    expect(payload.emailId).toBe("e_ask");
    expect(payload.sentAt).toBe(NOW - 5 * DAY);
    expect(payload.watchDurationMs).toBeGreaterThan(0);
    // It cites the message you're waiting on.
    expect(JSON.parse(o.subject_json)).toEqual({ realm: "Email", objectId: "e_ask" });
    expect(JSON.parse(o.evidence_json)[0].objectId).toBe("e_ask");

    // The carrier invocation is done-on-arrival, cost 0 — no model ran.
    const inv = w.db.query<{ status: string; cost_micros: number }>(
      `SELECT status, cost_micros FROM agent_invocations WHERE id = '${o.id}'`,
    )[0]!;
    expect(inv.status).toBe("done");
    expect(inv.cost_micros).toBe(0);
  });

  it("says nothing when the reply already arrived — being answered is silence", async () => {
    const w = world();
    const thread = seedSent(w, { id: "e_ask", to: "sergio@example.com", subject: "free Thursday?", sentAt: NOW - 5 * DAY });
    seedReply(w, "sergio@example.com", thread, NOW - 2 * DAY); // Sergio replied
    await sweepWaitingOn(w.env, NOW);
    expect(offers(w)).toEqual([]);
  });

  it("does not offer a thread that already has a watch (human- or agent-armed)", async () => {
    const w = world();
    seedSent(w, { id: "e_ask", to: "sergio@example.com", subject: "free Thursday?", sentAt: NOW - 5 * DAY, threadId: "th_x" });
    w.db.seed("watches", [
      {
        id: "w_existing",
        account_id: ACCOUNT,
        owner: SELF,
        condition_type: "no-reply-from",
        condition_json: JSON.stringify({ sender: "sergio@example.com", threadId: "th_x" }),
        deadline_at: NOW + DAY,
        action_type: "draft-followup",
        action_json: "{}",
        status: "armed",
        source_ref: null,
        created_at: NOW - 5 * DAY,
      },
    ]);
    await sweepWaitingOn(w.env, NOW);
    expect(offers(w)).toEqual([]);
  });

  it("offers a thread at most once — a second sweep adds nothing (a decline stays declined)", async () => {
    const w = world();
    seedSent(w, { id: "e_ask", to: "sergio@example.com", subject: "free Thursday?", sentAt: NOW - 5 * DAY });
    await sweepWaitingOn(w.env, NOW);
    await sweepWaitingOn(w.env, NOW + 60_000);
    expect(offers(w)).toHaveLength(1);
  });

  it("respects the silence window: too recent and too old both stay quiet", async () => {
    const w = world();
    seedSent(w, { id: "e_recent", to: "a@example.com", subject: "quick q?", sentAt: NOW - 1 * DAY }); // < 3d
    seedSent(w, { id: "e_ancient", to: "b@example.com", subject: "old q?", sentAt: NOW - 40 * DAY }); // > 30d
    await sweepWaitingOn(w.env, NOW);
    expect(offers(w)).toEqual([]);
  });

  it("ignores a note to yourself, and a sent message with no question mark", async () => {
    const w = world();
    seedSent(w, { id: "e_self", to: SELF, subject: "remember this?", sentAt: NOW - 5 * DAY });
    seedSent(w, { id: "e_stmt", to: "c@example.com", subject: "here is the file", preview: "no question here", sentAt: NOW - 5 * DAY });
    await sweepWaitingOn(w.env, NOW);
    expect(offers(w)).toEqual([]);
  });

  it("degrades to a no-op on a shard with no mailboxes table — never crashes the cron", async () => {
    const w = world();
    w.db.query(`DROP TABLE IF EXISTS mailboxes`);
    await expect(sweepWaitingOn(w.env, NOW)).resolves.toBeUndefined();
  });
});
