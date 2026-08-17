import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import { expireStaleProposals, type ProposalAmendment } from "./proposals";

/**
 * The proposal PRODUCER (s03.D T1) and the needsInfo ANSWER round (s10 T3),
 * driven through the REAL cloud worker on the same drain path a mail-triggered
 * invocation takes:
 *
 *   1. THE RESPOND-ONLY RULE (2026-08-15): a `send`-mode reply to the requester
 *      egresses DIRECTLY — solicitation is authorization. Proposals are for
 *      relaying, and the proposal is keyed to the invocation (the read model)
 *      and reaches the changelog (so /changes and push see it). Nothing is sent.
 *   2. The expiry sweep flips a `pending` proposal past its `expires_at` to
 *      `expired` and commits — the pre-decision clock, distinct from hold_until.
 *   3. An `answer-info-request` invocation answers the OPEN needsInfo round:
 *      APPEND (fill the open amendment; rationale untouched), back to
 *      `pending`, banked clock resumed — and exactly ONE round per human
 *      action: a second answer without a fresh human question is refused.
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

describe("the respond-only rule: a send-mode run replies DIRECTLY to the requester", () => {
  // Eric, 2026-08-15: solicitation is authorization. The s03.D tier gate that
  // stood here routed EditorEmily's five-second answer into a proposal that
  // sat two days — while the pipeline's own ERROR replies kept egressing
  // through the same path to the same recipient. By the time this run reaches
  // the model, four authorizations already exist (allowedSenders, to==[the
  // requester], the outboundRefusal book check, replyMode: "send" opt-in);
  // asking a fifth time was the systematic mistake. Proposals remain the rule
  // for AGENT-INITIATED egress, which this pipeline never constructs.
  it("egresses to the requester with no proposal — the ask was the approval", async () => {
    const s = await scaffold();
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

    // The invocation completed by SENDING — to exactly the requester.
    const inv = s.w.db.query<{ status: string; result_json: string }>(
      "SELECT status, result_json FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_mail",
    )[0]!;
    expect(inv.status).toBe("done");
    const result = JSON.parse(inv.result_json);
    expect(result.solicited).toBe(true);
    expect(result.replyId).toBeTruthy();
    expect(result.kind).toBeUndefined();

    // One relay, to the person who asked, and nobody else.
    expect(s.w.submit.calls).toEqual([{ mailFrom: SELF, rcptTo: [SENDER] }]);

    // And NO proposal row — the queue holds agent-initiated work, not answers
    // to questions the human asked.
    const props = s.w.db.query<{ id: string }>("SELECT id FROM agent_proposals WHERE account_id = ?", ACCOUNT);
    expect(props).toEqual([]);
  });
});

// ---- needsInfo: the answer round (s10 T3) ---------------------------------

const HOUR = 3600_000;

/** Scaffold for answer-round runs: account + binding + proposal + the
 * `answer-info-request` invocation ActionProposal/set would have enqueued. */
function answerScaffold(opts: {
  proposalStatus?: string;
  question?: string | null;
  amendments?: ProposalAmendment[];
  expiresRemainingMs?: number | null;
  config?: Record<string, unknown>;
  invocationId?: string;
}) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("agent_bindings", [
    {
      id: "bind_emily",
      account_id: ACCOUNT,
      name: "emily",
      config_json: JSON.stringify(
        opts.config ?? {
          persona: "You are Emily.",
          defaultModel: "cheap",
          modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
        },
      ),
    },
  ]);
  // The original invocation the proposal projects over (done long ago)...
  w.db.seed("agent_invocations", [
    {
      id: "inv_orig",
      account_id: ACCOUNT,
      binding_id: "bind_emily",
      binding_name: "emily",
      status: "done",
      created_at: 1,
    },
  ]);
  // ...its 1:1 proposal row, mid-needsInfo unless told otherwise...
  const question = opts.question === undefined ? "Why Bob?" : opts.question;
  const amendments =
    opts.amendments ??
    (question
      ? [
          {
            question,
            answer: null,
            askedAt: new Date(1_000).toISOString(),
            answeredAt: null,
            askedBy: "eric@login.example",
          },
        ]
      : []);
  w.db.seed("agent_proposals", [
    {
      id: "inv_orig",
      account_id: ACCOUNT,
      kind: "grant-request",
      tier: 1,
      payload_json: JSON.stringify({
        grantType: "recipient",
        bookId: "ab_gov",
        address: "bob@example.com",
      }),
      rationale: "Bob signed both invoices; he is not in my allowlist.",
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_1" }]),
      status: opts.proposalStatus ?? "info-requested",
      created_at: 1,
      expires_at: null,
      question,
      amendments_json: JSON.stringify(amendments),
      expires_remaining_ms: opts.expiresRemainingMs === undefined ? HOUR : opts.expiresRemainingMs,
    },
  ]);
  // ...and the answer invocation ActionProposal/set enqueued.
  const invId = opts.invocationId ?? "inv_answer";
  w.db.seed("agent_invocations", [
    {
      id: invId,
      account_id: ACCOUNT,
      binding_id: "bind_emily",
      binding_name: "emily",
      status: "pending",
      email_id: null,
      context_json: JSON.stringify({
        kind: "answer-info-request",
        proposalId: "inv_orig",
        question,
      }),
      created_at: 2,
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
  const proposalRow = () =>
    w.db.query<{
      status: string;
      question: string | null;
      rationale: string;
      amendments_json: string;
      expires_at: number | null;
      expires_remaining_ms: number | null;
    }>(
      "SELECT status, question, rationale, amendments_json, expires_at, expires_remaining_ms FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_orig",
    )[0]!;
  const invocationRow = (id = invId) =>
    w.db.query<{
      status: string;
      result_json: string | null;
      note: string | null;
      provider: string | null;
      tokens_in: number | null;
      cost_micros: number | null;
    }>(
      "SELECT status, result_json, note, provider, tokens_in, cost_micros FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0]!;

  return { w, drain, proposalRow, invocationRow };
}

describe("an answer-info-request invocation answers the open round", () => {
  it("fills the amendment (append, originals untouched), returns to pending, RESUMES the banked clock", async () => {
    const s = answerScaffold({ expiresRemainingMs: HOUR });
    const before = Date.now();
    const { handled } = await s.drain();
    expect(handled).toBe(1);

    const prop = s.proposalRow();
    expect(prop.status).toBe("pending");
    expect(prop.question).toBeNull(); // the open question is answered, none owed

    // THE PAUSE PROOF: the proposal sat in info-requested for an arbitrary
    // while (created at epoch-adjacent seed time), yet the restored deadline
    // is now + the BANKED hour — the clock did not advance toward expiry
    // while the ball was in the agent's court.
    expect(prop.expires_at).toBeGreaterThanOrEqual(before + HOUR);
    expect(prop.expires_at).toBeLessThan(before + HOUR + 10_000);
    expect(prop.expires_remaining_ms).toBeNull();

    // APPEND discipline: the round is filled in place; the rationale (the
    // agent's original why) is byte-identical.
    const amendments = JSON.parse(prop.amendments_json) as ProposalAmendment[];
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.question).toBe("Why Bob?");
    expect(amendments[0]!.answer).toBeTruthy();
    expect(amendments[0]!.answeredAt).toBeTruthy();
    expect(prop.rationale).toBe("Bob signed both invoices; he is not in my allowlist.");

    // The invocation finished done — and COSTED (the mock provider reports
    // usage; unpriceable → cost_micros NULL "not recorded", tokens kept as
    // the receipt), so chronic needsInfo rounds show up in $/approved-action.
    const inv = s.invocationRow();
    expect(inv.status).toBe("done");
    expect(JSON.parse(inv.result_json!)).toMatchObject({
      kind: "answer-info-request",
      proposalId: "inv_orig",
      answered: true,
    });
    expect(inv.provider).toBe("mock");
    expect(inv.tokens_in).toBeGreaterThan(0);
    expect(inv.cost_micros).toBeNull();

    // CHOREOGRAPHY: the return-to-pending reached the changelog.
    const changes = await s.w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(changes.updated).toContain("inv_orig");
  });

  it("a SECOND round appends after the first — both rounds survive, in order", async () => {
    // The proposal already carries one ANSWERED round (a previous human ask);
    // a fresh human needsInfo opened a second. Answering must append-fill the
    // second and leave the first byte-identical.
    const first: ProposalAmendment = {
      question: "Why Dana?",
      answer: "Dana signed the January invoice.",
      askedAt: new Date(500).toISOString(),
      answeredAt: new Date(600).toISOString(),
      askedBy: "eric@login.example",
    };
    const s = answerScaffold({
      question: "And why Bob too?",
      amendments: [
        first,
        {
          question: "And why Bob too?",
          answer: null,
          askedAt: new Date(1_000).toISOString(),
          answeredAt: null,
          askedBy: "eric@login.example",
        },
      ],
    });
    await s.drain();

    const prop = s.proposalRow();
    expect(prop.status).toBe("pending");
    const amendments = JSON.parse(prop.amendments_json) as ProposalAmendment[];
    expect(amendments).toHaveLength(2);
    expect(amendments[0]).toEqual(first); // the earlier round is untouched
    expect(amendments[1]!.question).toBe("And why Bob too?");
    expect(amendments[1]!.answer).toBeTruthy();
  });

  it("REFUSES a second answer without a fresh human question (one round per human action)", async () => {
    const s = answerScaffold({});
    await s.drain(); // answers the round; proposal returns to pending

    // A replayed/spammed answer invocation for the SAME proposal.
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_replay",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        context_json: JSON.stringify({
          kind: "answer-info-request",
          proposalId: "inv_orig",
          question: "Why Bob?",
        }),
        created_at: 3,
      },
    ]);
    await s.drain();

    const replay = s.invocationRow("inv_replay");
    expect(replay.status).toBe("failed");
    expect(replay.note).toMatch(/refused/);
    expect(replay.note).toMatch(/one round per human action/);

    // The dialogue did not grow and the answered round was not overwritten.
    const prop = s.proposalRow();
    expect(prop.status).toBe("pending");
    const amendments = JSON.parse(prop.amendments_json) as ProposalAmendment[];
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.answer).toBeTruthy();
  });

  it("a binding with NO model route still completes the round with an honest fallback answer", async () => {
    const s = answerScaffold({ config: { persona: "You are Emily." } }); // no modelAliases
    await s.drain();
    const prop = s.proposalRow();
    expect(prop.status).toBe("pending");
    const amendments = JSON.parse(prop.amendments_json) as ProposalAmendment[];
    expect(amendments[0]!.answer).toContain("no model route");
    expect(amendments[0]!.answer).toContain("Bob signed both invoices");
    // No cost stamped — nothing ran; NULL provider renders "not recorded".
    expect(s.invocationRow().provider).toBeNull();
  });

  it("a proposal that never had a deadline stays deadline-less after the answer", async () => {
    const s = answerScaffold({ expiresRemainingMs: null });
    await s.drain();
    const prop = s.proposalRow();
    expect(prop.status).toBe("pending");
    expect(prop.expires_at).toBeNull();
  });
});

describe("the sweep never expires an info-requested proposal", () => {
  it("leaves the row alone — its deadline is banked, not running", async () => {
    const s = answerScaffold({});
    // Before the answer runs: info-requested, expires_at NULL by design.
    await expireStaleProposals(s.w.env);
    expect(s.proposalRow().status).toBe("info-requested");
  });
});

describe("the expiry sweep flips stale pending proposals to expired", () => {
  it("expires a pending proposal past its expires_at and commits /changes", async () => {
    const w = fakeEnv();
    w.db.seed("agent_invocations", [
      {
        id: "inv_x",
        account_id: ACCOUNT,
        binding_id: "b",
        binding_name: "emily",
        status: "done",
        created_at: 1,
      },
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
      {
        id: "inv_f",
        account_id: ACCOUNT,
        binding_id: "b",
        binding_name: "emily",
        status: "done",
        created_at: 1,
      },
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
