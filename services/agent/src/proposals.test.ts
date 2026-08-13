import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import { expireStaleProposals } from "./proposals";

/**
 * The proposal PRODUCER (s03.D T1). Two properties, driven through the REAL
 * cloud worker on the same drain path a mail-triggered invocation takes:
 *
 *   1. A `send`-mode reply no longer auto-egresses. The run EMITS a pending
 *      tier-2 `reply-draft` proposal — rationale + evidence present — instead of
 *      relaying, and the proposal is keyed to the invocation (the read model)
 *      and reaches the changelog (so /changes and push see it). Nothing is sent.
 *   2. The expiry sweep flips a `pending` proposal past its `expires_at` to
 *      `expired` and commits — the pre-decision clock, distinct from hold_until.
 */

const ACCOUNT = "t_bm__a_emily";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";

const SEND_CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are Emily.",
  replyMode: "send", // tier-2: the run now proposes instead of relaying
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
});

async function scaffold() {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);

  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  // s10 T1: a send-mode binding is fail-closed without a governing book, so
  // the proposal producer under test needs SENDER inside one.
  w.db.seed("address_books", [
    {
      id: "ab_reach",
      account_id: ACCOUNT,
      name: "emily may email",
      write_policy: "governed",
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_sender",
      account_id: ACCOUNT,
      address_book_id: "ab_reach",
      uid: "u_sender",
      card_json: JSON.stringify({ uid: "u_sender", emails: { e1: { address: SENDER } } }),
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_emily",
      account_id: ACCOUNT,
      name: "emily",
      config_json: SEND_CONFIG,
      recipients_book_id: "ab_reach",
    },
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

  return { w, store, emailId, drain };
}

describe("a send-mode run emits a pending proposal instead of egressing", () => {
  it("produces a tier-2 reply-draft with rationale + evidence, visible to /changes", async () => {
    const s = await scaffold();
    // Queue a mail-triggered invocation (ingest's shape).
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_mail",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: s.emailId,
        context_json: JSON.stringify({ emailId: s.emailId, envelopeTo: SELF }),
        created_at: 1,
      },
    ]);

    const { handled } = await s.drain();
    expect(handled).toBe(1);

    // The invocation completed by PROPOSING, not sending.
    const inv = s.w.db.query<{ status: string; result_json: string }>(
      "SELECT status, result_json FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_mail",
    )[0]!;
    expect(inv.status).toBe("done");
    const result = JSON.parse(inv.result_json);
    expect(result).toMatchObject({ kind: "reply-draft", tier: 2, proposalId: "inv_mail" });

    // Nothing was relayed — the whole point of tier-2.
    expect(s.w.submit.calls).toEqual([]);

    // The proposal is a read model keyed to the invocation, pending, with a
    // NON-EMPTY rationale and the source message as evidence.
    const prop = s.w.db.query<{
      kind: string;
      tier: number;
      status: string;
      rationale: string;
      evidence_json: string;
      payload_json: string;
    }>(
      "SELECT kind, tier, status, rationale, evidence_json, payload_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_mail",
    )[0]!;
    expect(prop.kind).toBe("reply-draft");
    expect(prop.tier).toBe(2);
    expect(prop.status).toBe("pending");
    expect(prop.rationale.length).toBeGreaterThan(0);
    expect(JSON.parse(prop.evidence_json)).toEqual([
      { realm: "Email", objectId: s.emailId, note: "the message being replied to" },
    ]);
    const payload = JSON.parse(prop.payload_json);
    expect(payload).toMatchObject({ to: SENDER, self: SELF, mode: "send" });
    expect(typeof payload.blobId).toBe("string");

    // CHOREOGRAPHY: the proposal reached the changelog, so push sees it.
    const changes = await s.w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(changes.created).toContain("inv_mail");
  });
});

describe("the expiry sweep flips stale pending proposals to expired", () => {
  it("expires a pending proposal past its expires_at and commits /changes", async () => {
    const w = fakeEnv();
    w.db.seed("agent_invocations", [
      { id: "inv_x", account_id: ACCOUNT, binding_id: "b", binding_name: "emily", status: "done", created_at: 1 },
    ]);
    w.db.seed("agent_proposals", [
      {
        id: "inv_x",
        account_id: ACCOUNT,
        kind: "reply-draft",
        tier: 2,
        rationale: "r",
        status: "pending",
        created_at: 1,
        expires_at: Date.now() - 1000, // already past the decision deadline
      },
    ]);

    await expireStaleProposals(w.env);

    const prop = w.db.query<{ status: string }>(
      "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_x",
    )[0]!;
    expect(prop.status).toBe("expired");

    const changes = await w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(changes.updated).toContain("inv_x");
  });

  it("leaves a proposal whose expires_at is still in the future", async () => {
    const w = fakeEnv();
    w.db.seed("agent_invocations", [
      { id: "inv_f", account_id: ACCOUNT, binding_id: "b", binding_name: "emily", status: "done", created_at: 1 },
    ]);
    w.db.seed("agent_proposals", [
      {
        id: "inv_f",
        account_id: ACCOUNT,
        kind: "reply-draft",
        tier: 2,
        rationale: "r",
        status: "pending",
        created_at: 1,
        expires_at: Date.now() + 3_600_000,
      },
    ]);
    await expireStaleProposals(w.env);
    expect(
      w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "inv_f",
      )[0]!.status,
    ).toBe("pending");
  });
});
