import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore, QUARANTINE_NAME, QUARANTINE_ROLE, loadBayesState } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s12 — the DECISION half of `held-mail-review`: what approving and declining
 * a batch of held mail actually DO.
 *
 * Both verbs are answers, and neither is a no-op — which is the difference
 * between this and a Junk folder. Approve is a rescue (the message moves, the
 * chain records it, the filter learns ham); decline is a confirmation (the
 * message stays, the chain finally records a judgment, the filter learns spam).
 * Either way the question leaves the queue and the mail is DECIDED, so the
 * sweep never asks about it again.
 *
 * Asserted against real storage — a real Mailstore over the live schema — and
 * through the real `ActionProposal/set`, because the interesting failures are
 * all "the row says approved and nothing moved".
 */

const ACCOUNT = "t_bm__a_ada";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";
const DOMAIN = "elsewhere.test";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

const rawMime = (n: number) =>
  [
    `From: Sender ${n} <sender${n}@${DOMAIN}>`,
    "To: Ada <ada@example.test>",
    `Subject: maybe important ${n}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Quarterly casino numbers, no rush.",
  ].join("\r\n");

async function harness(heldCount: number) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT });
  w.db.seed("agent_bindings", [{ id: "bind_bouncer", account_id: ACCOUNT, name: "bouncer", config_json: "{}" }]);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: APPROVER,
      scopes: ["mail", "read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Ada" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
  const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");

  const emailIds: string[] = [];
  for (let n = 1; n <= heldCount; n += 1) {
    const emailId = `e_held_${n}`;
    const raw = new TextEncoder().encode(rawMime(n));
    const blobId = await store.putBlob(TENANT, ACCOUNT, raw.buffer as ArrayBuffer);
    await store.insertQuarantinedEmail(
      ACCOUNT,
      {
        id: emailId,
        blobId,
        threadId: `th_${n}`,
        messageId: `<held${n}@${DOMAIN}>`,
        inReplyTo: null,
        subject: `maybe important ${n}`,
        from: [{ email: `sender${n}@${DOMAIN}` }],
        to: [{ email: "ada@example.test" }],
        cc: [],
        bcc: [],
        preview: "Quarterly casino numbers, no rush.",
        bodyText: "Quarterly casino numbers, no rush.",
        size: raw.byteLength,
        receivedAt: 1000 + n,
        hasAttachment: false,
        attachments: [],
        mailboxIds: [quarantineId],
        keywords: [],
      },
      {
        event: "screened",
        sender: `sender${n}@${DOMAIN}`,
        domain: DOMAIN,
        stage: "bayes-mid@0.50",
        emailId,
        at: 1000 + n,
      },
    );
    // The classifier's shrug — the row the sweep selected on.
    await store.appendQuarantineEvent(ACCOUNT, {
      event: "screened",
      sender: `sender${n}@${DOMAIN}`,
      domain: DOMAIN,
      stage: "llm:unsure",
      emailId,
      at: 2000 + n,
    });
    emailIds.push(emailId);
  }

  /** The ask, exactly as `midBandProposal.ts` emits it. */
  const ask = (id = "inv_ask", ids = emailIds) => {
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_bouncer",
        binding_name: "bouncer",
        status: "done",
        created_at: 3,
        claimed_at: 3,
        done_at: 3,
        cost_micros: 0,
      },
    ]);
    w.db.seed("agent_proposals", [
      {
        id,
        account_id: ACCOUNT,
        kind: "held-mail-review",
        tier: 1,
        subject_json: JSON.stringify({ realm: "Mailbox", objectId: quarantineId }),
        payload_json: JSON.stringify({
          periodKey: "2026-08-13",
          heldCount: ids.length,
          emailIds: ids,
          messages: ids.map((emailId, i) => ({
            emailId,
            sender: `sender${i + 1}@${DOMAIN}`,
            subject: `maybe important ${i + 1}`,
            stage: "bayes-mid@0.50",
            receivedAt: 1001 + i,
          })),
        }),
        rationale: `The boundary held ${ids.length} messages it could not classify.`,
        evidence_json: JSON.stringify(ids.map((e) => ({ realm: "Email", objectId: e }))),
        status: "pending",
        created_at: 3,
        expires_at: Date.now() + 3600_000,
      },
    ]);
    return id;
  };

  const mailboxesOf = (emailId: string) =>
    w.db
      .query<{ mailbox_id: string }>(
        `SELECT mailbox_id FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
        ACCOUNT,
        emailId,
      )
      .map((r) => r.mailbox_id);

  const chain = (emailId: string) =>
    w.db
      .query<{ event: string; stage: string; actor: string | null }>(
        `SELECT event, stage, actor FROM quarantine_events WHERE account_id = ? AND email_id = ? ORDER BY id`,
        ACCOUNT,
        emailId,
      )
      .map((e) => `${e.event}:${e.stage}${e.actor ? `:${e.actor}` : ""}`);

  const proposalRow = (id: string) =>
    w.db.query<{
      status: string;
      decision_json: string | null;
      edited_payload_json: string | null;
      payload_json: string;
    }>(`SELECT status, decision_json, edited_payload_json, payload_json FROM agent_proposals WHERE id = ?`, id)[0]!;

  return { w, call, store, quarantineId, inboxId, emailIds, ask, mailboxesOf, chain, proposalRow };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const labels = async (w: FakeWorker) => {
  const state = await loadBayesState(w.env.DB, ACCOUNT);
  return { ham: state?.hamCount ?? 0, spam: state?.spamCount ?? 0 };
};

// ---- approve: release the batch --------------------------------------------

describe("approve RELEASES the held mail — and teaches the filter", () => {
  it("moves every message to the Inbox, chains the rescue, and labels ham", async () => {
    const h: Harness = await harness(3);
    const id = h.ask();

    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [id]: { status: "approved" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(res.updated).toEqual({ [id]: null });

    for (const emailId of h.emailIds) {
      expect(h.mailboxesOf(emailId)).toEqual([h.inboxId]);
      // 'rescued' and not 'released': a human approving IS the rescue path, so
      // the correction is recorded with its actor, exactly as it would be if
      // they had told bouncer@ "H says they sent XYZ".
      expect(h.chain(emailId)).toEqual([
        "screened:bayes-mid@0.50",
        "screened:llm:unsure",
        `rescued:llm:unsure:${APPROVER}`,
      ]);
    }
    // The escape hatch feeds the filter (readme commitment 1.4): three human
    // ham labels, no spam.
    expect(await labels(h.w)).toEqual({ ham: 3, spam: 0 });
    expect(h.proposalRow(id).status).toBe("approved");

    // THE WRITE CHOREOGRAPHY (the recurring bug this file's header names): the
    // applied writes ride the SAME commit as the proposal transition, so a
    // connected client sees the mail move instead of finding it only on a
    // full refetch.
    const emailChanges = await h.w.accountDo.changes(ACCOUNT, "Email", "0");
    expect(emailChanges.updated.sort()).toEqual([...h.emailIds].sort());
    const mailboxChanges = await h.w.accountDo.changes(ACCOUNT, "Mailbox", "0");
    expect(mailboxChanges.updated.sort()).toEqual([h.inboxId, h.quarantineId].sort());
    expect((await h.w.accountDo.changes(ACCOUNT, "ActionProposal", "0")).updated).toEqual([id]);
  });

  it("an EDITED emailIds releases only those — and CONFIRMS the rest of the batch", async () => {
    const h: Harness = await harness(3);
    const id = h.ask();

    // "These two are fine; the third really is spam." Partial release needs no
    // new verb — it is the ordinary editedPayload discipline.
    await h.call("ActionProposal/set", {
      update: {
        [id]: { status: "approved", editedPayload: { emailIds: ["e_held_1", "e_held_3"] } },
      },
    });

    expect(h.mailboxesOf("e_held_1")).toEqual([h.inboxId]);
    expect(h.mailboxesOf("e_held_3")).toEqual([h.inboxId]);
    // The one the human did NOT pick is decided too — a partial approve is one
    // decision about the whole batch, not a decision about part of it and
    // silence about the rest. Silence is how the pile came back.
    expect(h.mailboxesOf("e_held_2")).toEqual([h.quarantineId]);
    expect(h.chain("e_held_2")).toEqual([
      "screened:bayes-mid@0.50",
      "screened:llm:unsure",
      `shunted:human:spam:${APPROVER}`,
    ]);
    expect(await labels(h.w)).toEqual({ ham: 2, spam: 1 });

    // The agent's original payload is never overwritten — the diff between what
    // it asked for and what the human approved is the highest-signal feedback
    // in the system (s07 §T4).
    expect(JSON.parse(h.proposalRow(id).payload_json).emailIds).toEqual(["e_held_1", "e_held_2", "e_held_3"]);
    expect(JSON.parse(h.proposalRow(id).edited_payload_json!).emailIds).toEqual(["e_held_1", "e_held_3"]);
  });

  it("an edit may only NARROW the batch — a stranger's id is refused whole", async () => {
    const h: Harness = await harness(2);
    const id = h.ask();
    const res = await h.call<SetResult>("ActionProposal/set", {
      update: {
        [id]: { status: "approved", editedPayload: { emailIds: ["e_held_1", "e_other"] } },
      },
    });
    expect(res.notUpdated[id]!.type).toBe("invalidProperties");
    expect(res.notUpdated[id]!.description).toMatch(/only NARROW/);
    // Refused WHOLE: nothing moved, and the row is still decidable.
    expect(h.mailboxesOf("e_held_1")).toEqual([h.quarantineId]);
    expect(h.proposalRow(id).status).toBe("pending");
  });

  it("an empty emailIds is refused — a decision that acts on nothing is not a decision", async () => {
    const h: Harness = await harness(2);
    const id = h.ask();
    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [id]: { status: "approved", editedPayload: { emailIds: [] } } },
    });
    expect(res.notUpdated[id]!.type).toBe("invalidProperties");
    expect(h.proposalRow(id).status).toBe("pending");
  });

  it("a message rescued before the decision does not collect a second chain row", async () => {
    const h: Harness = await harness(2);
    const id = h.ask();
    await h.store.rescueQuarantined(ACCOUNT, "e_held_1", "someone-else@example.test");
    const before = h.chain("e_held_1");

    await h.call("ActionProposal/set", { update: { [id]: { status: "approved" } } });
    // The earlier correction already won; the approve is a no-op for that one
    // and the chain does not lie about two rescues.
    expect(h.chain("e_held_1")).toEqual(before);
    expect(h.mailboxesOf("e_held_2")).toEqual([h.inboxId]);
  });
});

// ---- decline: confirm the shunts -------------------------------------------

describe("decline CONFIRMS the shunts — the answer 'yes, that is spam'", () => {
  it("leaves the mail held, writes the judgment the hold never had, and labels spam", async () => {
    const h: Harness = await harness(2);
    const id = h.ask();

    const res = await h.call<SetResult>("ActionProposal/set", {
      update: { [id]: { status: "rejected", decision: { note: "all junk" } } },
    });
    expect(res.updated).toEqual({ [id]: null });

    for (const emailId of h.emailIds) {
      expect(h.mailboxesOf(emailId)).toEqual([h.quarantineId]); // no move: it was already right
      expect(h.chain(emailId)).toEqual([
        "screened:bayes-mid@0.50",
        "screened:llm:unsure",
        `shunted:human:spam:${APPROVER}`,
      ]);
    }
    expect(await labels(h.w)).toEqual({ ham: 0, spam: 2 });
    // A decline APPLIES something here, so it commits like an approve does.
    expect((await h.w.accountDo.changes(ACCOUNT, "Email", "0")).updated.sort()).toEqual([...h.emailIds].sort());

    // THE TAXONOMY INVARIANT: a decline here is an ANSWER, not a complaint
    // about the agent. Who decided, and their note — no reason, because none
    // can be written on this kind.
    const decision = JSON.parse(h.proposalRow(id).decision_json!) as Record<string, unknown>;
    expect(decision).toEqual({ by: APPROVER, note: "all junk" });
    expect(decision.reason).toBeUndefined();
  });

  it("a reject REASON on this kind is refused — asking about mail it cannot judge is not a fault", async () => {
    const h: Harness = await harness(1);
    for (const reason of ["wrongContent", "wrongAction", "unsafe"]) {
      const id = h.ask(`inv_ask_${reason}`);
      const res = await h.call<SetResult>("ActionProposal/set", {
        update: { [id]: { status: "rejected", decision: { reason } } },
      });
      expect(res.notUpdated[id]!.type).toBe("invalidProperties");
      expect(res.notUpdated[id]!.description).toMatch(/no reject reason/);
      expect(h.proposalRow(id).status).toBe("pending");
    }
    // Nothing was decided by a refused decline: the mail is exactly where the
    // boundary left it.
    expect(h.mailboxesOf("e_held_1")).toEqual([h.quarantineId]);
    expect(h.chain("e_held_1")).toEqual(["screened:bayes-mid@0.50", "screened:llm:unsure"]);
  });

  it("declining twice cannot double-label — the second finds it already decided", async () => {
    const h: Harness = await harness(1);
    const first = h.ask("inv_ask_1");
    const second = h.ask("inv_ask_2"); // a duplicate ask, e.g. a raced sweep
    await h.call("ActionProposal/set", { update: { [first]: { status: "rejected" } } });
    await h.call("ActionProposal/set", { update: { [second]: { status: "rejected" } } });

    expect(h.chain("e_held_1")).toEqual([
      "screened:bayes-mid@0.50",
      "screened:llm:unsure",
      `shunted:human:spam:${APPROVER}`,
    ]);
    expect(await labels(h.w)).toEqual({ ham: 0, spam: 1 });
  });
});
