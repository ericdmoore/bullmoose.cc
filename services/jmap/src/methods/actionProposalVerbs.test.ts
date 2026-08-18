import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s20 T2 — the verbs APPLY, end to end, through the real method.
 *
 * The rule this file exists to keep (PR #196's lesson, restated as a test):
 * **a proposal kind whose producer exists and whose `applyProposal` case does
 * not is a wedge.** So every kind the verb pipeline can mint is driven here
 * from `ActionProposal/set { status: "approved" }` all the way to the row it
 * writes — and `watch-notify`, which had a producer and no case since T1, is
 * driven the same way.
 *
 * What approval produces for a verb is a DRAFT in the owner's own Drafts
 * mailbox: nothing relays, the human sends it from their own composer. Tier 1,
 * so it applies immediately and keeps an undo handle — the draft is a row,
 * delete it.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";
const OWNER = "eric@bullmoose.cc";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: APPROVER,
    displayName: "Eric",
  });
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: APPROVER,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("ActionProposal/set", args);
  return { w, ctx, call, set };
}

/** The invocation + proposal a verb run mints (mailVerbs.ts `runMailVerb`). */
function seedVerb(
  h: ReturnType<typeof harness>,
  id: string,
  kind: "verb-answer" | "verb-bring-in" | "verb-compose",
  payload: Record<string, unknown>,
  o: { costMicros?: number | null; provider?: string | null; subject?: { realm: string; objectId: string } } = {},
) {
  h.w.db.seed("agent_invocations", [
    {
      id,
      account_id: ACCOUNT,
      binding_id: "bind_x",
      binding_name: "extractor",
      status: "done",
      email_id: "e_orig",
      created_at: 1,
      claimed_at: 1,
      done_at: 1,
      provider: o.provider ?? null,
      model: null,
      cost_micros: o.costMicros === undefined ? 0 : o.costMicros,
    },
  ]);
  h.w.db.seed("agent_proposals", [
    {
      id,
      account_id: ACCOUNT,
      kind,
      tier: 1,
      subject_json: JSON.stringify(o.subject ?? { realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify(payload),
      rationale: "you asked me to",
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_orig" }]),
      status: "pending",
      created_at: 1,
    },
  ]);
}

function seedIdentity(h: ReturnType<typeof harness>, email = OWNER) {
  h.w.db.seed("identities", [
    {
      id: "identity_1",
      account_id: ACCOUNT,
      email,
      name: "Eric",
      text_signature: "",
      html_signature: "",
      may_delete: 0,
    },
  ]);
}

function seedOriginal(h: ReturnType<typeof harness>) {
  h.w.db.seed("emails", [
    {
      id: "e_orig",
      account_id: ACCOUNT,
      blob_id: "b_orig",
      thread_id: "t_orig",
      message_id: "orig@x",
      subject: "the board quote",
      from_json: JSON.stringify([{ email: "sergio@example.com" }]),
      to_json: JSON.stringify([{ email: OWNER }]),
      preview: "can you confirm the price?",
      size: 20,
      received_at: 100,
      has_attachment: 0,
    },
  ]);
}

const draftRows = (h: ReturnType<typeof harness>) =>
  h.w.db.query<{
    id: string;
    subject: string;
    from_json: string;
    to_json: string;
    preview: string;
    thread_id: string;
    in_reply_to: string | null;
  }>(
    `SELECT e.id, e.subject, e.from_json, e.to_json, e.preview, e.thread_id, e.in_reply_to
       FROM emails e WHERE e.account_id = '${ACCOUNT}' AND e.id != 'e_orig'`,
  );

const keywordsOf = (h: ReturnType<typeof harness>, emailId: string) =>
  h.w.db
    .query<{ keyword: string }>(`SELECT keyword FROM email_keywords WHERE email_id = '${emailId}'`)
    .map((r) => r.keyword);

const proposalRow = (h: ReturnType<typeof harness>, id: string) =>
  h.w.db.query<{ status: string; decision_json: string | null }>(
    `SELECT status, decision_json FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;

describe("verb-answer — approve puts the drafted reply in Drafts", () => {
  it("applies immediately (tier 1), threaded, in the owner's voice, with an undo handle", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_a1", "verb-answer", {
      verb: "answer",
      to: "sergio@example.com",
      subject: "Re: the board quote",
      body: "Hi Sergio — $750 still stands.",
      composed: "model",
    });

    const res = await h.set({ update: { inv_a1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    // Tier 1: decided and APPLIED in the same call — no hold tray, so no sweep
    // to wedge in. (This is the whole reason the verbs are tier 1: the write
    // is a row in your own Drafts, and reversing it is a delete.)
    const prop = proposalRow(h, "inv_a1");
    expect(prop.status).toBe("approved");
    const decision = JSON.parse(prop.decision_json!);
    expect(decision.by).toBe(APPROVER);
    expect(decision.undo).toEqual({ action: "destroy-email", emailId: expect.any(String) });

    const drafts = draftRows(h);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.subject).toBe("Re: the board quote");
    expect(d.preview).toContain("$750 still stands");
    expect(JSON.parse(d.from_json)[0].email).toBe(OWNER);
    expect(JSON.parse(d.to_json)[0].email).toBe("sergio@example.com");
    expect(d.in_reply_to).toBe("orig@x");
    expect(d.thread_id).toBe("t_orig");
    expect(keywordsOf(h, d.id)).toEqual(expect.arrayContaining(["$draft", "$agent"]));
    expect(decision.undo.emailId).toBe(d.id);

    const mailbox = h.w.db.query<{ role: string }>(
      `SELECT m.role FROM mailboxes m
        JOIN email_mailboxes em ON em.mailbox_id = m.id AND em.account_id = m.account_id
       WHERE em.email_id = '${d.id}'`,
    )[0]!;
    expect(mailbox.role).toBe("drafts");

    // A draft is NOT an egress: nothing relayed.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("the approver's EDIT is what lands, not the agent's draft", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_a2", "verb-answer", {
      verb: "answer",
      to: "sergio@example.com",
      subject: "Re: the board quote",
      body: "the agent's words",
    });

    await h.set({
      update: {
        inv_a2: {
          status: "approved",
          editedPayload: {
            verb: "answer",
            to: "sergio@example.com",
            subject: "Re: the board quote",
            body: "my words",
          },
        },
      },
    });

    expect(draftRows(h)[0]!.preview).toBe("my words");
    // The ORIGINAL is retained beside the edit — that retention is what lets a
    // later score tell "approved clean" from "approved after edit" (s07 §T4).
    const kept = h.w.db.query<{ payload_json: string; edited_payload_json: string }>(
      `SELECT payload_json, edited_payload_json FROM agent_proposals WHERE id = 'inv_a2'`,
    )[0]!;
    expect(JSON.parse(kept.payload_json).body).toBe("the agent's words");
    expect(JSON.parse(kept.edited_payload_json).body).toBe("my words");
  });

  it("no identity row: the draft is signed by the approver, never nobody", async () => {
    const h = harness();
    seedOriginal(h);
    seedVerb(h, "inv_a3", "verb-answer", { verb: "answer", to: "sergio@example.com", body: "hi" });

    await h.set({ update: { inv_a3: { status: "approved" } } });
    expect(JSON.parse(draftRows(h)[0]!.from_json)[0].email).toBe(APPROVER);
  });

  it("a deleted original still applies — subject and threading degrade, nothing throws", async () => {
    const h = harness();
    seedIdentity(h);
    // No `emails` row at all: the message the verb acted on is gone.
    seedVerb(h, "inv_a4", "verb-answer", { verb: "answer", to: "sergio@example.com", body: "hi" });

    const res = await h.set({ update: { inv_a4: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    const d = draftRows(h)[0]!;
    expect(d.subject).toBe("Following up"); // the plainest true thing
    expect(d.in_reply_to).toBeNull();
  });
});

describe("verb-bring-in — the agent's chosen mode shapes the draft", () => {
  it("forward starts a message; cc continues the conversation", async () => {
    for (const [mode, threaded] of [
      ["forward", false],
      ["cc", true],
      ["summarize", true],
    ] as const) {
      const h = harness();
      seedIdentity(h);
      seedOriginal(h);
      seedVerb(h, `inv_b_${mode}`, "verb-bring-in", {
        verb: "bring-in",
        mode,
        to: "kim@x.test",
        subject: mode === "forward" ? "Fwd: the board quote" : "Re: the board quote",
        body: "Kim — you own pricing on this one.",
        composed: "model",
      });

      const res = await h.set({ update: { [`inv_b_${mode}`]: { status: "approved" } } });
      expect(res.notUpdated).toEqual({});
      const d = draftRows(h)[0]!;
      expect(JSON.parse(d.to_json)[0].email).toBe("kim@x.test");
      // A forward filed In-Reply-To the original would put it in a thread it
      // is not part of.
      expect(d.in_reply_to).toBe(threaded ? "orig@x" : null);
      expect(h.w.submit.calls).toEqual([]);
    }
  });
});

describe("the refusals are loud and cannot wedge", () => {
  it("a payload with no recipient is refused in place; the row stays pending", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_bad1", "verb-answer", { verb: "answer", body: "hi" });

    const res = await h.set({ update: { inv_bad1: { status: "approved" } } });
    expect(res.notUpdated["inv_bad1"]!.type).toBe("invalidProperties");
    expect(res.notUpdated["inv_bad1"]!.description).toContain("recipient");
    // Still decidable: a tier-1 refusal leaves the row PENDING (nothing was
    // written and no status moved), so the human can decline it. That is the
    // difference between a loud error and the #196 wedge.
    expect(proposalRow(h, "inv_bad1").status).toBe("pending");
    expect(draftRows(h)).toEqual([]);
  });

  it("a payload with no body is refused — an empty draft is worse than saying so", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_bad2", "verb-bring-in", { verb: "bring-in", to: "kim@x.test" });

    const res = await h.set({ update: { inv_bad2: { status: "approved" } } });
    expect(res.notUpdated["inv_bad2"]!.description).toContain("body");
    expect(proposalRow(h, "inv_bad2").status).toBe("pending");
  });
});

describe("declining a verb feeds the s03.D taxonomy, unchanged", () => {
  it("records wrongContent — the verbs are NOT no-fault kinds", async () => {
    const h = harness();
    seedOriginal(h);
    seedVerb(h, "inv_d1", "verb-answer", { verb: "answer", to: "sergio@example.com", body: "wrong" });

    const res = await h.set({
      update: { inv_d1: { status: "rejected", decision: { reason: "wrongContent", note: "too breezy" } } },
    });
    expect(res.notUpdated).toEqual({});
    const row = proposalRow(h, "inv_d1");
    expect(row.status).toBe("rejected");
    expect(JSON.parse(row.decision_json!)).toEqual({ by: APPROVER, reason: "wrongContent", note: "too breezy" });
    expect(draftRows(h)).toEqual([]);
  });

  it("`unsafe` — the categorically separate hard negative — is accepted as itself", async () => {
    const h = harness();
    seedOriginal(h);
    seedVerb(h, "inv_d2", "verb-bring-in", { verb: "bring-in", to: "kim@x.test", body: "here is everything" });
    await h.set({ update: { inv_d2: { status: "rejected", decision: { reason: "unsafe" } } } });
    expect(JSON.parse(proposalRow(h, "inv_d2").decision_json!).reason).toBe("unsafe");
  });

  it("an invented reason is still refused", async () => {
    const h = harness();
    seedOriginal(h);
    seedVerb(h, "inv_d3", "verb-answer", { verb: "answer", to: "s@x.test", body: "x" });
    const res = await h.set({ update: { inv_d3: { status: "rejected", decision: { reason: "notNow" } } } });
    expect(res.notUpdated["inv_d3"]!.description).toContain("wrongContent | wrongAction | unsafe");
  });
});

describe("watch-notify — the tier-1 case that was missing since T1", () => {
  /** The proposal `fire()` emits for a `notify` watch: tier 1, intent-only
   *  payload, carrier invocation done and genuinely free. */
  function seedNotify(h: ReturnType<typeof harness>, id: string) {
    h.w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "watch",
        binding_name: "remind@",
        status: "done",
        created_at: 1,
        claimed_at: 1,
        done_at: 1,
        cost_micros: 0,
      },
    ]);
    h.w.db.seed("agent_proposals", [
      {
        id,
        account_id: ACCOUNT,
        kind: "watch-notify",
        tier: 1,
        subject_json: JSON.stringify({ realm: "Watch", objectId: "w_1" }),
        payload_json: JSON.stringify({ watchId: "w_1", conditionType: "deadline", to: null, note: "call the bank" }),
        rationale: "Your reminder came due — the watch you set on 2026-08-18.",
        evidence_json: "[]",
        status: "pending",
        created_at: 1,
      },
    ]);
  }

  it("approving a reminder means what the emit side promised: seen, and nothing touched", async () => {
    const h = harness();
    seedNotify(h, "inv_n1");

    // PRE-FIX: `applyProposal` had no case, so this fell to the default throw
    // — `invalidProperties: approving a "watch-notify" proposal is not applied
    // in this slice` — and a reminder could never be acknowledged at all.
    const res = await h.set({ update: { inv_n1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    const row = proposalRow(h, "inv_n1");
    expect(row.status).toBe("approved");
    const decision = JSON.parse(row.decision_json!);
    expect(decision.by).toBe(APPROVER);
    // No undo handle: there is nothing to undo, and a handle naming an action
    // nothing implements would be a promise the codebase cannot keep.
    expect(decision.undo).toBeUndefined();

    // "Clearing it touches nothing in the world" — watches.ts said so, so
    // nothing may be written: no draft, no mail, no relay.
    expect(draftRows(h)).toEqual([]);
    expect(h.w.submit.calls).toEqual([]);
  });

  it("declining a reminder is an ordinary decline and records a fault when given one", async () => {
    const h = harness();
    seedNotify(h, "inv_n2");
    const res = await h.set({
      update: { inv_n2: { status: "rejected", decision: { reason: "wrongAction", note: "stop reminding me" } } },
    });
    expect(res.notUpdated).toEqual({});
    expect(JSON.parse(proposalRow(h, "inv_n2").decision_json!).reason).toBe("wrongAction");
  });
});

describe("no producer is left without an applier", () => {
  it("an unknown kind still refuses loudly — the default case is intact", async () => {
    const h = harness();
    seedVerb(h, "inv_x", "verb-answer", { verb: "answer", to: "s@x.test", body: "x" });
    h.w.db.query(`UPDATE agent_proposals SET kind = 'verb-schedule' WHERE id = 'inv_x'`);
    const res = await h.set({ update: { inv_x: { status: "approved" } } });
    expect(res.notUpdated["inv_x"]!.description).toContain("not applied in this slice");
  });
});

describe("verb-compose — the composer's intent mode applies into your own Drafts", () => {
  // s20 T3. The THIRD label on the verbs' one apply case, not a fourth apply
  // path: what approval does here is byte-for-byte what it does for an answer,
  // which is why there is no second `draftIntoDrafts` to drift. Two things
  // differ, and both are asserted below: a compose never threads, and it never
  // inherits a `Re:` subject from the message it stood next to.
  it("approve → a draft to the resolved recipient, in the owner's voice, with an undo handle", async () => {
    const h = harness();
    seedIdentity(h);
    seedVerb(
      h,
      "inv_c1",
      "verb-compose",
      {
        verb: "compose",
        to: "sergio@boards.example",
        subject: "Selling assembled boards",
        body: "Sergio — would you mind if I sold a few assembled boards?",
        composed: "model",
        tone: "supportive",
        constraints: ["no big commitment"],
        recipientVia: "address-book+history",
        ask: "ask Sergio whether he's comfortable with me selling assembled boards",
      },
      // A compose usually acts on no message at all — the invocation itself is
      // its subject, and the apply path must not go looking for an email.
      { subject: { realm: "AgentInvocation", objectId: "inv_c1" } },
    );

    const res = await h.set({ update: { inv_c1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    const prop = proposalRow(h, "inv_c1");
    expect(prop.status).toBe("approved");
    const decision = JSON.parse(prop.decision_json!);
    expect(decision.undo).toEqual({ action: "destroy-email", emailId: expect.any(String) });

    const drafts = draftRows(h);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.subject).toBe("Selling assembled boards");
    expect(d.preview).toContain("assembled boards");
    expect(JSON.parse(d.from_json)[0].email).toBe(OWNER);
    expect(JSON.parse(d.to_json)[0].email).toBe("sergio@boards.example");
    expect(d.in_reply_to).toBeNull();
    expect(keywordsOf(h, d.id)).toEqual(expect.arrayContaining(["$draft", "$agent"]));

    const mailbox = h.w.db.query<{ role: string }>(
      `SELECT m.role FROM mailboxes m
        JOIN email_mailboxes em ON em.mailbox_id = m.id AND em.account_id = m.account_id
       WHERE em.email_id = '${d.id}'`,
    )[0]!;
    expect(mailbox.role).toBe("drafts");

    // T3 ends at a draft. Nothing relayed, here or anywhere on this path.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("NEVER threads into the message it used as background", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_c2", "verb-compose", {
      verb: "compose",
      to: "sergio@example.com",
      subject: "Selling assembled boards",
      body: "a new ask",
    });

    await h.set({ update: { inv_c2: { status: "approved" } } });

    const d = draftRows(h)[0]!;
    // The proposal's subject ref IS `e_orig` here — the last exchange with
    // them — and it is background, not a parent. Threading it would file a new
    // ask under an old conversation and announce a reply that isn't one.
    expect(d.in_reply_to).toBeNull();
    expect(d.thread_id).not.toBe("t_orig");
    expect(d.subject).toBe("Selling assembled boards");
  });

  it("a subject-less compose gets a BLANK subject for the human, never `Re:` the background", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedVerb(h, "inv_c3", "verb-compose", { verb: "compose", to: "sergio@example.com", body: "a new ask" });

    await h.set({ update: { inv_c3: { status: "approved" } } });

    expect(draftRows(h)[0]!.subject).toBe("");
  });

  it("the approver's EDIT is what lands — the recipient included", async () => {
    const h = harness();
    seedIdentity(h);
    seedVerb(
      h,
      "inv_c4",
      "verb-compose",
      { verb: "compose", to: "sergio.vidal@old.example", subject: "Boards", body: "the agent's words" },
      { subject: { realm: "AgentInvocation", objectId: "inv_c4" } },
    );

    // The whole point of showing the resolution: when it IS wrong, correcting
    // it is an ordinary edit-then-approve, and the agent's version is retained
    // beside it as the feedback signal.
    await h.set({
      update: {
        inv_c4: {
          status: "approved",
          editedPayload: {
            verb: "compose",
            to: "sergio.ramos@boards.example",
            subject: "Boards",
            body: "my words",
          },
        },
      },
    });

    const d = draftRows(h)[0]!;
    expect(JSON.parse(d.to_json)[0].email).toBe("sergio.ramos@boards.example");
    expect(d.preview).toBe("my words");
    const kept = h.w.db.query<{ payload_json: string; edited_payload_json: string }>(
      `SELECT payload_json, edited_payload_json FROM agent_proposals WHERE id = 'inv_c4'`,
    )[0]!;
    expect(JSON.parse(kept.payload_json).to).toBe("sergio.vidal@old.example");
    expect(JSON.parse(kept.edited_payload_json).to).toBe("sergio.ramos@boards.example");
  });

  it("a payload with no recipient fails IN PLACE and stays declinable — it cannot wedge", async () => {
    const h = harness();
    seedIdentity(h);
    seedVerb(h, "inv_c5", "verb-compose", { verb: "compose", subject: "Boards", body: "words" });

    const res = await h.set({ update: { inv_c5: { status: "approved" } } });
    expect(res.notUpdated.inv_c5?.type).toBe("invalidProperties");
    expect(proposalRow(h, "inv_c5").status).toBe("pending");
    expect(draftRows(h)).toHaveLength(0);
  });
});
