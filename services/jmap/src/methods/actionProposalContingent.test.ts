import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s36 V2 — contingent commitments, decided end to end through the real
 * method. The properties the design hangs on, tested rather than promised:
 *
 *   1. VISIBLE-BUT-BLOCKED: a dependent cannot be approved while its cause is
 *      undecided — the refusal is a sentence, in place, and the row stays
 *      pending. Approving the cause is what unblocks it.
 *   2. DECLINING THE CAUSE CLOSES THE DEPENDENT, visibly, reason recorded.
 *      `closed` is terminal but NOT a decline: nobody decided the dependent,
 *      its ground vanished, and no learning label is written.
 *   3. The "made real" moment: approving an unblocked dependent writes ONE
 *      open commitment annotation — the Commitments surface's raw material —
 *      with a dismiss undo. Nothing here can move money.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness(scopes: string[] = ["mail", "calendar"]) {
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
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const set = (args: Record<string, unknown>) =>
    registry.get("ActionProposal/set")!({ accountId: ACCOUNT, ...args }, ctx) as unknown as Promise<SetResult>;
  return { w, set };
}

function seedPair(h: ReturnType<typeof harness>, causeStatus = "pending") {
  for (const id of ["inv_cause", "inv_dep"]) {
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
        provider: null,
        model: null,
        cost_micros: 0,
      },
    ]);
  }
  h.w.db.seed("agent_proposals", [
    {
      id: "inv_cause",
      account_id: ACCOUNT,
      kind: "verb-schedule",
      tier: 1,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify({ verb: "schedule", title: "U12G tournament", start: "2026-08-23T08:00:00" }),
      rationale: "the message names a time",
      evidence_json: "[]",
      status: causeStatus,
      created_at: 1,
    },
    {
      id: "inv_dep",
      account_id: ACCOUNT,
      kind: "contingent-commitment",
      tier: 1,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify({
        verb: "commit",
        body: "Pay registration to the coach (Venmo or Zelle)",
        contingentOn: "2026-08-23T08:00:00",
        waitsOn: "inv_cause",
      }),
      rationale: "the message ties this to attending",
      evidence_json: "[]",
      status: "pending",
      created_at: 1,
    },
  ]);
}

const proposalRow = (h: ReturnType<typeof harness>, id: string) =>
  h.w.db.query<{ status: string; decision_json: string | null }>(
    `SELECT status, decision_json FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;

const commitmentNotes = (h: ReturnType<typeof harness>) =>
  h.w.db.query<{ class: string; body: string; status: string; source_ref: string | null }>(
    `SELECT class, body, status, source_ref FROM annotations WHERE account_id = '${ACCOUNT}' AND class = 'commitment'`,
  );

describe("contingent-commitment — visible-but-blocked, one level, closes with the cause", () => {
  it("refuses to approve while the cause is undecided — a sentence, in place", async () => {
    const h = harness();
    seedPair(h, "pending");
    const res = await h.set({ update: { inv_dep: { status: "approved" } } });
    const err = res.notUpdated.inv_dep!;
    expect(err.type).toBe("invalidProperties");
    expect(err.description).toContain("waits on the hold");
    expect(proposalRow(h, "inv_dep").status).toBe("pending"); // still decidable, later
    expect(commitmentNotes(h)).toHaveLength(0); // and nothing was written
  });

  it("cause approved → the dependent approves, and THAT is what writes the note", async () => {
    const h = harness();
    seedPair(h, "approved");
    const res = await h.set({ update: { inv_dep: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(proposalRow(h, "inv_dep").status).toBe("approved");

    const notes = commitmentNotes(h);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Pay registration to the coach (Venmo or Zelle)");
    expect(notes[0]!.status).toBe("open");
    expect(notes[0]!.source_ref).toBe("e_orig");

    // The undo dismisses the note — the record closes, it is never erased.
    const decision = JSON.parse(proposalRow(h, "inv_dep").decision_json!);
    expect(decision.undo.action).toBe("dismiss-annotation");
    expect(typeof decision.undo.annotationId).toBe("string");

    // Nothing egressed: a commitment note is not a mail and not a payment.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("declining the cause CLOSES the dependent — visibly, reason recorded, no decline fabricated", async () => {
    const h = harness();
    seedPair(h, "pending");
    const res = await h.set({ update: { inv_cause: { status: "rejected", reason: "wrongContent" } } });
    expect(res.notUpdated).toEqual({});

    const dep = proposalRow(h, "inv_dep");
    expect(dep.status).toBe("closed"); // NOT 'rejected' — nobody declined it
    const decision = JSON.parse(dep.decision_json!);
    expect(decision.closed).toBe("cause-declined");
    expect(decision.causeId).toBe("inv_cause");
    expect(decision.note).toContain("depended on was declined");
    expect(decision.by).toBe(APPROVER); // whose decline caused it — honest attribution
    // No learning label on the dependent: the reason lives on the CAUSE's
    // decision only, so the taxonomy is not poisoned by a row nobody judged.
    expect(decision.reason).toBeUndefined();

    // And terminal means terminal: the closed row refuses further decisions.
    const again = await h.set({ update: { inv_dep: { status: "approved" } } });
    expect(again.notUpdated.inv_dep!.description).toContain("closed");
  });

  it("a ground that vanished mid-air: cause declined between paint and tap", async () => {
    const h = harness();
    seedPair(h, "rejected"); // the cause is already declined, dependent somehow still pending
    const res = await h.set({ update: { inv_dep: { status: "approved" } } });
    const err = res.notUpdated.inv_dep!;
    expect(err.type).toBe("invalidProperties");
    expect(err.description).toContain("declined");
    expect(commitmentNotes(h)).toHaveLength(0);
  });

  it("declining a BLOCKED dependent is always open — saying no needs no ground", async () => {
    const h = harness();
    seedPair(h, "pending");
    const res = await h.set({ update: { inv_dep: { status: "rejected", reason: "wrongContent" } } });
    expect(res.notUpdated).toEqual({});
    expect(proposalRow(h, "inv_dep").status).toBe("rejected");
    // The cause is untouched — the dependency points one way only.
    expect(proposalRow(h, "inv_cause").status).toBe("pending");
  });

  it("a destroyed cause stands the wall down rather than blocking forever on a ghost", async () => {
    const h = harness();
    seedPair(h, "pending");
    await h.w.env.DB.prepare(`DELETE FROM agent_proposals WHERE id = 'inv_cause'`).run();
    const res = await h.set({ update: { inv_dep: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(commitmentNotes(h)).toHaveLength(1);
  });
});
