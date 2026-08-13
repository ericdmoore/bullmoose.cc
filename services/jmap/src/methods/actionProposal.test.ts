import { describe, expect, it } from "vitest";
import { MethodRegistry, AGENT_CAP } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import { buildSession } from "../session";
import type { Principal } from "../auth";
import type { RequestContext } from "./common";

/**
 * ActionProposal — the read model over agent_invocations and the human decision
 * surface (s03.D T1). Harness is @bullmoose/test-fakes (real node:sqlite on the
 * live schema, the REAL AccountDO), so the load-bearing assertion is the
 * CHOREOGRAPHY one: a decision that lands the row but skips commitChanges reads
 * back on a direct /get and is invisible to /changes — so every transition here
 * is checked through ActionProposal/changes, not just /get. Reverting the commit
 * in `ActionProposal/set` makes the /changes cases below fail (and only those).
 *
 * Proofs, mapped to the T1 done-when:
 *   - a proposal projects `agent`/status from the invocation, never a 2nd store;
 *   - approving a tier-1 applies it AND stamps provenance;
 *   - a tier-3 approve is refused to an agent token and requires a human (the
 *     capability wall — the `send` scope agents lack), and relays on approve;
 *   - a human edit is captured separately, the agent's original retained;
 *   - the collection lives behind urn:bullmoose:agent (session gate).
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";

interface SetResult {
  oldState: string;
  newState: string;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
  destroyed: string[];
  notDestroyed: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness(scopes: string[] = ["mail"], agent?: { binding: string; invocation?: string }) {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
    // When set, an agent binding drove this call (the s03 bridge shape) — the
    // self-approve gate reads it.
    ...(agent ? { agent } : {}),
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("ActionProposal/set", args);
  return { w, ctx, call, set };
}

interface SeedSpec {
  id: string;
  kind: string;
  tier: number;
  status?: string;
  payload?: Record<string, unknown>;
  subject?: Record<string, unknown>;
  rationale?: string;
  evidence?: unknown[];
  expiresAt?: number | null;
  bindingName?: string;
  question?: string | null;
  amendments?: unknown[] | null;
  expiresRemainingMs?: number | null;
  /** s11 T1 — the work's deadline, on the INVOCATION (epoch ms). */
  dueAt?: number | null;
  /** A decision ALREADY on the row — how history (including history recorded
   * under an older reason taxonomy) is put in front of the read path. */
  decision?: Record<string, unknown> | null;
  decidedAt?: number | null;
}

/** Seed the invocation (source of truth) + its 1:1 proposal side-row. */
function seedProposal(w: ReturnType<typeof fakeEnv>, s: SeedSpec): void {
  w.db.seed("agent_invocations", [
    {
      id: s.id,
      account_id: ACCOUNT,
      binding_id: "bind_x",
      binding_name: s.bindingName ?? "emily",
      status: "done",
      created_at: 1,
      due_at: s.dueAt ?? null,
    },
  ]);
  w.db.seed("agent_proposals", [
    {
      id: s.id,
      account_id: ACCOUNT,
      kind: s.kind,
      tier: s.tier,
      subject_json: JSON.stringify(s.subject ?? {}),
      payload_json: JSON.stringify(s.payload ?? {}),
      rationale: s.rationale ?? "because it looked relevant",
      evidence_json: JSON.stringify(s.evidence ?? [{ realm: "Email", objectId: "e_1" }]),
      status: s.status ?? "pending",
      created_at: 1,
      decision_json: s.decision ? JSON.stringify(s.decision) : null,
      decided_at: s.decidedAt ?? null,
      expires_at: s.expiresAt ?? null,
      question: s.question ?? null,
      amendments_json: s.amendments ? JSON.stringify(s.amendments) : null,
      expires_remaining_ms: s.expiresRemainingMs ?? null,
    },
  ]);
}

// ---- read model -----------------------------------------------------------

describe("ActionProposal projects over the invocation, not a second store", () => {
  it("get/query surface `agent`, tier, rationale and evidence", async () => {
    const h = harness();
    seedProposal(h.w, {
      id: "inv_1",
      kind: "reply-draft",
      tier: 2,
      bindingName: "allen",
      rationale: "drafted a reply to the AWS thread",
      evidence: [{ realm: "Email", objectId: "e_aws", note: "the bill thread" }],
    });

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_1"],
    });
    const p = got.list[0]!;
    // `agent` is READ from the invocation's binding_name — never duplicated.
    expect(p.agent).toBe("allen");
    expect(p.kind).toBe("reply-draft");
    expect(p.tier).toBe(2);
    expect(p.status).toBe("pending");
    expect(p.rationale).toBe("drafted a reply to the AWS thread");
    expect(p.evidence).toEqual([{ realm: "Email", objectId: "e_aws", note: "the bill thread" }]);
    // The read-model surface from the invocation.
    expect(p.invocationStatus).toBe("done");

    const q = await h.call<{ ids: string[] }>("ActionProposal/query", {
      filter: { status: "pending" },
    });
    expect(q.ids).toEqual(["inv_1"]);
  });
});

// ---- tier-1: apply immediately + provenance -------------------------------

describe("approving a tier-1 proposal applies it and stamps provenance", () => {
  it("creates the contact, stamps last_writer_*, and /changes reflects both", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, {
      id: "inv_c",
      kind: "create-contact",
      tier: 1,
      payload: { card: { name: { full: "Dana Vendor" }, emails: { work: { address: "dana@acme.test" } } } },
    });

    const res = await h.set({ update: { inv_c: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_c).toBeNull();

    // The tier-1 write actually happened, through the Mailstore write path.
    const card = h.w.db.query<{
      id: string;
      name_full: string;
      last_writer_principal: string;
      last_writer_binding: string;
      last_writer_invocation: string;
    }>("SELECT id, name_full, last_writer_principal, last_writer_binding, last_writer_invocation FROM contact_cards WHERE account_id = ?", ACCOUNT)[0]!;
    expect(card.name_full).toBe("Dana Vendor");
    // Provenance: the human approved (principal) an agent's proposed write
    // (binding + invocation) — the .feedback common/033 gap, closed.
    expect(card.last_writer_principal).toBe("eric@login.example");
    expect(card.last_writer_binding).toBe("emily");
    expect(card.last_writer_invocation).toBe("inv_c");

    // The proposal is `approved` with an undo handle kept (tier-1 reversibility).
    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_c",
    )[0]!;
    expect(prop.status).toBe("approved");
    expect(JSON.parse(prop.decision_json).undo).toMatchObject({ action: "destroy-contact", cardId: card.id });

    // CHOREOGRAPHY: the transition reached the changelog (else push is blind).
    const propChanges = await h.w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(propChanges.updated).toContain("inv_c");
    const cardChanges = await h.w.accountDo.changes(ACCOUNT, "ContactCard", "0");
    expect(cardChanges.created).toContain(card.id);
  });
});

// ---- edit: capture the diff, retain the original --------------------------

describe("a human edit is captured separately and never overwrites the original", () => {
  it("applies the edited payload but retains the agent's payload for the diff", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, {
      id: "inv_e",
      kind: "create-contact",
      tier: 1,
      payload: { card: { name: { full: "Agent Guess" } } },
    });

    await h.set({
      update: { inv_e: { status: "approved", editedPayload: { card: { name: { full: "Human Fix" } } } } },
    });

    // The APPLIED write used the human's version.
    const card = h.w.db.query<{ name_full: string }>(
      "SELECT name_full FROM contact_cards WHERE account_id = ?",
      ACCOUNT,
    )[0]!;
    expect(card.name_full).toBe("Human Fix");

    // ...but the agent's original payload survives, alongside the edit — the
    // retained diff is what a later score needs (s07 §T4).
    const prop = h.w.db.query<{ payload_json: string; edited_payload_json: string }>(
      "SELECT payload_json, edited_payload_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_e",
    )[0]!;
    expect(JSON.parse(prop.payload_json).card.name.full).toBe("Agent Guess");
    expect(JSON.parse(prop.edited_payload_json).card.name.full).toBe("Human Fix");
  });
});

// ---- tier-3: the capability wall ------------------------------------------

describe("a tier-3 approve requires a human and is refused to an agent token", () => {
  const tier3 = (id = "inv_3") => ({
    id,
    kind: "reply-draft",
    tier: 3,
    payload: {
      to: "outside@example.com",
      self: "eric@bullmoose.cc",
      subject: "Re: already public",
      text: "sending into the open thread",
      blobId: "b_reply",
      inReplyTo: null,
    },
  });

  it("REFUSES an agent token (no send scope) and relays nothing", async () => {
    // An agent token: read+draft, the scopes an agent binding carries. It can
    // review, but it structurally lacks `send`.
    const h = harness(["read", "draft"]);
    seedProposal(h.w, tier3());

    const res = await h.set({ update: { inv_3: { status: "approved" } } });
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_3!.type).toBe("forbidden");
    expect(res.notUpdated.inv_3!.description).toMatch(/send|human/i);

    // The wall held: nothing was relayed, the proposal is still pending.
    expect(h.w.submit.calls).toEqual([]);
    const prop = h.w.db.query<{ status: string }>(
      "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_3",
    )[0]!;
    expect(prop.status).toBe("pending");
  });

  it("PERMITS a human (send scope): relays and marks approved", async () => {
    const h = harness(["mail"]); // a human token — `mail` covers `send`
    seedProposal(h.w, tier3());

    const res = await h.set({ update: { inv_3: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_3).toBeNull();

    // The egress happened, once, to the intended recipient.
    expect(h.w.submit.calls).toEqual([{ mailFrom: "eric@bullmoose.cc", rcptTo: ["outside@example.com"] }]);
    const prop = h.w.db.query<{ status: string }>(
      "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_3",
    )[0]!;
    expect(prop.status).toBe("approved");
  });
});

// ---- tier-2: enters the hold tray -----------------------------------------

describe("approving a tier-2 proposal enters the hold tray", () => {
  it("sets status=held with a holdUntil (a different clock from expiresAt)", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_2", kind: "reply-draft", tier: 2, payload: { to: "x@y.z" } });

    await h.set({ update: { inv_2: { status: "approved" } } });
    const prop = h.w.db.query<{ status: string; hold_until: number | null }>(
      "SELECT status, hold_until FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_2",
    )[0]!;
    // The retraction window opened; the send commit is s03.D T2, so nothing
    // egressed here.
    expect(prop.status).toBe("held");
    expect(prop.hold_until).toBeGreaterThan(0);
    expect(h.w.submit.calls).toEqual([]);
  });
});

// ---- reject: the no-thanks signal -----------------------------------------

describe("rejecting captures the no-thanks signal", () => {
  it("records the reason enum + note against the human, and /changes reflects it", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_r", kind: "reply-draft", tier: 2 });

    const res = await h.set({
      update: { inv_r: { status: "rejected", decision: { reason: "wrongContent", note: "off tone" } } },
    });
    expect(res.updated.inv_r).toBeNull();

    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_r",
    )[0]!;
    expect(prop.status).toBe("rejected");
    expect(JSON.parse(prop.decision_json)).toEqual({
      by: "eric@login.example",
      reason: "wrongContent",
      note: "off tone",
    });

    const changes = await h.w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(changes.updated).toContain("inv_r");
  });

  it("rejects an unknown decision reason", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_bad", kind: "reply-draft", tier: 2 });
    const res = await h.set({ update: { inv_bad: { status: "rejected", decision: { reason: "meh" } } } });
    expect(res.notUpdated.inv_bad!.type).toBe("invalidProperties");
  });

  it("accepts `unsafe` — the categorically-separate hard negative (decline-taxonomy.md)", async () => {
    // Not a stronger "no": it says a boundary was crossed (private information
    // left the account, or the agent committed the human to something). It must
    // be recordable, because a hard negative that cannot be written is one a
    // learning pipeline can never weight.
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_unsafe", kind: "reply-draft", tier: 2 });
    const res = await h.set({
      update: {
        inv_unsafe: { status: "rejected", decision: { reason: "unsafe", note: "quoted the contract terms" } },
      },
    });
    expect(res.updated.inv_unsafe).toBeNull();
    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_unsafe",
    )[0]!;
    expect(prop.status).toBe("rejected");
    expect(JSON.parse(prop.decision_json)).toEqual({
      by: "eric@login.example",
      reason: "unsafe",
      note: "quoted the contract terms",
    });
  });

  it("REFUSES the retired `notNow`, naming the three reasons that are left", async () => {
    // The retirement has to bite on the WRITE path or it is a comment. `notNow`
    // was a grab-bag — "I'll do it myself" (positive on selection), "not due
    // yet" (a dueAt correction, which records nothing) and "meh, later" — so it
    // may not enter a new rejection record.
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_retired", kind: "reply-draft", tier: 2 });
    const res = await h.set({
      update: { inv_retired: { status: "rejected", decision: { reason: "notNow" } } },
    });
    expect(res.notUpdated.inv_retired!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_retired!.description).toBe(
      "decision.reason must be wrongContent | wrongAction | unsafe",
    );
    expect(res.notUpdated.inv_retired!.description).not.toContain("notNow");
    // Refused means refused: undecided, nothing recorded.
    expect(
      h.w.db.query<{ status: string; decision_json: string | null }>(
        "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "inv_retired",
      )[0]!,
    ).toEqual({ status: "pending", decision_json: null });
  });

  it("still READS a decision recorded under the old taxonomy — history is not migrated", async () => {
    // The legacy-tolerance rule. Retiring `notNow` narrowed what may be
    // WRITTEN; rows decided before the revision keep it verbatim, because a
    // recorded human decision is a fact and a backfill would be an audit hole.
    // So the projection must carry it through untouched rather than throwing,
    // dropping it, or remapping it to a reason the human never chose.
    const h = harness(["mail"]);
    seedProposal(h.w, {
      id: "inv_legacy",
      kind: "reply-draft",
      tier: 2,
      status: "rejected",
      decidedAt: 1_700_000_000_000,
      decision: { by: "eric@login.example", reason: "notNow", note: "I'll ring them instead." },
    });
    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_legacy"],
    });
    expect(got.list).toHaveLength(1);
    expect(got.list[0]!.status).toBe("rejected");
    expect(got.list[0]!.decision).toEqual({
      by: "eric@login.example",
      reason: "notNow",
      note: "I'll ring them instead.",
    });
    // And it survives a filtered read too — nothing along the projection
    // validates the reason on the way out.
    const narrowed = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_legacy"],
      properties: ["decision"],
    });
    expect((narrowed.list[0]!.decision as { reason: string }).reason).toBe("notNow");
  });
});

// ---- create is not a thing here -------------------------------------------

describe("ActionProposal/set has no create", () => {
  it("refuses create — proposals are produced by the agent worker", async () => {
    const h = harness(["mail"]);
    await expect(
      h.set({ create: { c: { kind: "reply-draft", tier: 2 } } }),
    ).rejects.toThrow(/create/i);
  });

  it("cannot re-decide an already-decided proposal", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_done", kind: "reply-draft", tier: 2, status: "rejected" });
    const res = await h.set({ update: { inv_done: { status: "approved" } } });
    expect(res.notUpdated.inv_done!.type).toBe("invalidProperties");
  });
});

// ---- needsInfo: the third verb (s10 T3) -----------------------------------

describe("needsInfo — status info-requested with a required question", () => {
  const HOUR = 3600_000;

  it("requires a non-empty human-authored question; nothing changes without one", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_q", kind: "grant-request", tier: 1 });

    for (const patch of [
      { status: "info-requested" }, // missing
      { status: "info-requested", question: "   " }, // whitespace-only
      { status: "info-requested", question: 42 }, // not a string
    ]) {
      const res = await h.set({ update: { inv_q: patch } });
      expect(res.updated).toEqual({});
      expect(res.notUpdated.inv_q!.type).toBe("invalidProperties");
      expect(res.notUpdated.inv_q!.description).toMatch(/non-empty/);
    }

    // Refused means refused: still pending, no answer invocation enqueued.
    const prop = h.w.db.query<{ status: string }>(
      "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_q",
    )[0]!;
    expect(prop.status).toBe("pending");
    const invs = h.w.db.query<{ id: string }>(
      "SELECT id FROM agent_invocations WHERE account_id = ? AND status = 'pending'",
      ACCOUNT,
    );
    expect(invs).toEqual([]);
  });

  it("pauses the clock, appends the open round, enqueues the answer invocation — and writes NO decision", async () => {
    const h = harness(["mail"]);
    const before = Date.now();
    seedProposal(h.w, {
      id: "inv_ni",
      kind: "grant-request",
      tier: 1,
      payload: { grantType: "recipient", bookId: "ab_gov", address: "bob@example.com" },
      expiresAt: before + HOUR,
    });

    const res = await h.set({
      update: { "inv_ni": { status: "info-requested", question: "Why Bob, and not the alias you have?" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_ni).toBeNull();

    const prop = h.w.db.query<{
      status: string;
      question: string;
      amendments_json: string;
      decision_json: string | null;
      expires_at: number | null;
      expires_remaining_ms: number | null;
    }>(
      "SELECT status, question, amendments_json, decision_json, expires_at, expires_remaining_ms FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_ni",
    )[0]!;
    expect(prop.status).toBe("info-requested");
    expect(prop.question).toBe("Why Bob, and not the alias you have?");

    // The RL invariant, on the write path: needsInfo is an ACTION, not a
    // reject — it must never produce a rejection record.
    expect(prop.decision_json).toBeNull();

    // The PAUSE: the deadline is nulled and the remaining window banked, so
    // expiresAt cannot advance toward expiry while the ball is in the agent's
    // court (the sweep only flips rows with a live expires_at).
    expect(prop.expires_at).toBeNull();
    expect(prop.expires_remaining_ms).toBeGreaterThan(HOUR - 5_000);
    expect(prop.expires_remaining_ms).toBeLessThanOrEqual(HOUR);

    // The open round APPENDED — asker + timestamps recorded, answer owed.
    const amendments = JSON.parse(prop.amendments_json) as Array<Record<string, unknown>>;
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({
      question: "Why Bob, and not the alias you have?",
      answer: null,
      answeredAt: null,
      askedBy: "eric@login.example",
    });
    expect(typeof amendments[0]!.askedAt).toBe("string");

    // The answer round is a NEW pending invocation for the proposal's binding.
    const inv = h.w.db.query<{ id: string; binding_id: string; binding_name: string; context_json: string }>(
      "SELECT id, binding_id, binding_name, context_json FROM agent_invocations WHERE account_id = ? AND status = 'pending'",
      ACCOUNT,
    )[0]!;
    expect(inv.binding_id).toBe("bind_x");
    expect(inv.binding_name).toBe("emily");
    expect(JSON.parse(inv.context_json)).toEqual({
      kind: "answer-info-request",
      proposalId: "inv_ni",
      question: "Why Bob, and not the alias you have?",
    });

    // CHOREOGRAPHY: both transitions reached the changelog.
    const propChanges = await h.w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(propChanges.updated).toContain("inv_ni");
    const invChanges = await h.w.accountDo.changes(ACCOUNT, "AgentInvocation", "0");
    expect(invChanges.created).toContain(inv.id);
  });

  it("is valid from pending ONLY — an open round cannot be re-asked, history cannot be questioned", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_open", kind: "reply-draft", tier: 2, status: "info-requested" });
    seedProposal(h.w, { id: "inv_dead", kind: "reply-draft", tier: 2, status: "rejected" });

    for (const id of ["inv_open", "inv_dead"]) {
      const res = await h.set({ update: { [id]: { status: "info-requested", question: "why?" } } });
      expect(res.notUpdated[id]!.type).toBe("invalidProperties");
      expect(res.notUpdated[id]!.description).toMatch(/not pending/);
    }
  });

  it("carries ONLY the question — a decision or editedPayload on the verb is refused", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_extra", kind: "reply-draft", tier: 2 });
    const res = await h.set({
      update: {
        inv_extra: { status: "info-requested", question: "why?", decision: { note: "sneaky" } },
      },
    });
    expect(res.notUpdated.inv_extra!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_extra!.description).toMatch(/not a reject/);
  });

  it("never lands in rejection records: needsInfo is not a decision.reason", async () => {
    // The enum guard is where the taxonomy's invariant bites on the write
    // path: a pipeline reading decision_json can never find a needsInfo
    // "rejection", because the server refuses to record one.
    const h = harness(["mail"]);
    seedProposal(h.w, { id: "inv_taxo", kind: "reply-draft", tier: 2 });
    const res = await h.set({
      update: { inv_taxo: { status: "rejected", decision: { reason: "needsInfo" } } },
    });
    expect(res.notUpdated.inv_taxo!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_taxo!.description).toMatch(/wrongContent \| wrongAction \| unsafe/);
    expect(
      h.w.db.query<{ status: string; decision_json: string | null }>(
        "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "inv_taxo",
      )[0]!,
    ).toEqual({ status: "pending", decision_json: null });
  });
});

// ---- grant-request: widening-by-proposal (s10 T3) --------------------------

describe("approving a recipient grant-request APPLIES the contact write", () => {
  const widening = (id = "inv_w") => ({
    id,
    kind: "grant-request",
    tier: 1,
    payload: {
      grantType: "recipient",
      bookId: "ab_gov",
      address: "bob@example.com",
      name: "Bob Vendor",
    },
    subject: { realm: "AddressBook", objectId: "ab_gov" },
  });

  const seedBook = (w: ReturnType<typeof fakeEnv>) =>
    w.db.seed("address_books", [
      // A widening targets a GOVERNING book — write_policy matters: it is what
      // makes the chokepoint demand the authorization and emit the chain row.
      {
        id: "ab_gov",
        account_id: ACCOUNT,
        name: "emily allowlist",
        write_policy: "governed",
        ctag: 0,
        created_at: 1,
        updated_at: 1,
      },
    ]);

  it("a HUMAN approve inserts the contact into the target book with the proposal as its why", async () => {
    const h = harness(["mail"]);
    seedBook(h.w);
    seedProposal(h.w, widening());

    const res = await h.set({ update: { inv_w: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_w).toBeNull();

    const card = h.w.db.query<{
      id: string;
      address_book_id: string;
      card_json: string;
      name_full: string;
      last_writer_principal: string;
      last_writer_binding: string;
      last_writer_invocation: string;
    }>(
      "SELECT id, address_book_id, card_json, name_full, last_writer_principal, last_writer_binding, last_writer_invocation FROM contact_cards WHERE account_id = ?",
      ACCOUNT,
    )[0]!;
    expect(card.address_book_id).toBe("ab_gov");
    expect(card.name_full).toBe("Bob Vendor");
    expect(JSON.parse(card.card_json).emails.primary.address).toBe("bob@example.com");
    // Provenance: the human approved (principal), the agent's proposal drove
    // it (binding + invocation == the proposal id) — the T2 chain's why.
    expect(card.last_writer_principal).toBe("eric@login.example");
    expect(card.last_writer_binding).toBe("emily");
    expect(card.last_writer_invocation).toBe("inv_w");

    // The applied write's membership-log row carries the authorizing proposal
    // (T2's via_proposal_id — the "why" is the proposal itself).
    const log = h.w.db.query<{ via_proposal_id: string; event: string; address: string }>(
      "SELECT via_proposal_id, event, address FROM book_membership_log WHERE account_id = ? AND book_id = ?",
      ACCOUNT,
      "ab_gov",
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.event).toBe("added");
    expect(log[0]!.address).toBe("bob@example.com");
    expect(log[0]!.via_proposal_id).toBe("inv_w");

    // The member change bumped the book's DAV ctag (CardDAV clients poll it).
    expect(
      h.w.db.query<{ ctag: number }>(
        "SELECT ctag FROM address_books WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "ab_gov",
      )[0]!.ctag,
    ).toBe(1);

    // Tier-1 reversibility: the undo handle is kept, and /changes saw the card.
    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = ?",
      ACCOUNT,
      "inv_w",
    )[0]!;
    expect(prop.status).toBe("approved");
    expect(JSON.parse(prop.decision_json).undo).toMatchObject({ action: "destroy-contact", cardId: card.id });
    const cardChanges = await h.w.accountDo.changes(ACCOUNT, "ContactCard", "0");
    expect(cardChanges.created).toContain(card.id);
  });

  it("REFUSES the beneficiary approving its own widening (CJ-cannot-self-approve)", async () => {
    // The approving call is driven by the SAME binding the proposal belongs
    // to — the agent would be widening its own reach. Refused.
    const h = harness(["mail"], { binding: "emily" });
    seedBook(h.w);
    seedProposal(h.w, widening("inv_self"));

    const res = await h.set({ update: { inv_self: { status: "approved" } } });
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_self!.type).toBe("forbidden");
    expect(res.notUpdated.inv_self!.description).toMatch(/own widening/);

    // Refused means refused: no contact, still pending.
    expect(h.w.db.query("SELECT id FROM contact_cards WHERE account_id = ?", ACCOUNT)).toEqual([]);
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "inv_self",
      )[0]!.status,
    ).toBe("pending");
  });

  it("permits a DIFFERENT binding as approver — CJ approving photos@'s ask, recorded as CJ", async () => {
    const h = harness(["mail"], { binding: "cj" });
    seedBook(h.w);
    seedProposal(h.w, widening("inv_cj"));

    const res = await h.set({ update: { inv_cj: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(
      h.w.db.query<{ id: string }>("SELECT id FROM contact_cards WHERE account_id = ?", ACCOUNT),
    ).toHaveLength(1);
  });

  it("refuses a widening into a book this account does not have", async () => {
    const h = harness(["mail"]);
    // No address_books seeded at all.
    seedProposal(h.w, widening("inv_nobook"));
    const res = await h.set({ update: { inv_nobook: { status: "approved" } } });
    expect(res.notUpdated.inv_nobook!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_nobook!.description).toMatch(/not found/);
  });

  it("keeps the original contract for scope-style grant-requests: decision recorded, NO local write", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, {
      id: "inv_scope",
      kind: "grant-request",
      tier: 1,
      payload: { scope: "read", realm: "files", target: "Events/2026", durationDays: 30 },
    });
    const res = await h.set({ update: { inv_scope: { status: "approved" } } });
    expect(res.updated.inv_scope).toBeNull();
    // Provision mints (s04); nothing was written locally.
    expect(h.w.db.query("SELECT id FROM contact_cards WHERE account_id = ?", ACCOUNT)).toEqual([]);
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        ACCOUNT,
        "inv_scope",
      )[0]!.status,
    ).toBe("approved");
  });
});

// ---- capability gate ------------------------------------------------------

describe("the collection lives behind urn:bullmoose:agent", () => {
  it("a book-scoped-grant session does NOT advertise the agent capability", () => {
    // The same per-account gate the other realm capabilities use: a book-scoped
    // grant exposes only contacts, so its account never sees AGENT_CAP — and a
    // client computes a method's `using[]` from the session, so it never calls
    // ActionProposal/* for that account (webmail capabilities.ts). A personal
    // account, by contrast, advertises it.
    const principal: Principal = {
      username: "sharee@login.example",
      scopes: ["read"],
      accounts: [
        { accountId: "a_self", tenantId: TENANT, name: "Self" },
        {
          accountId: "a_shared",
          tenantId: TENANT,
          name: "Shared",
          granted: [{ grantId: "g1", scopes: ["read"], collection: "AddressBook", collectionId: "ab_1" }],
        },
      ],
    };
    const session = buildSession("https://app.example", principal);
    const has = (acct: string) =>
      Object.prototype.hasOwnProperty.call(session.accounts[acct]!.accountCapabilities, AGENT_CAP);
    expect(has("a_self")).toBe(true); // personal account sees the collection
    expect(has("a_shared")).toBe(false); // book-scoped grant does not
  });
});

// ---- s11 T1: due_at — the third clock, projected and correctable -----------

describe("dueAt — the work's deadline rides the projection and is human-correctable", () => {
  it("projects due_at from the invocation as ISO; absent → null (never-urgent)", async () => {
    const h = harness();
    const due = Date.UTC(2027, 2, 5, 17, 0);
    seedProposal(h.w, { id: "inv_due", kind: "reply-draft", tier: 2, dueAt: due });
    seedProposal(h.w, { id: "inv_free", kind: "reply-draft", tier: 2 });

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_due", "inv_free"],
    });
    const byId = new Map(got.list.map((p) => [p.id as string, p]));
    expect(byId.get("inv_due")!.dueAt).toBe(new Date(due).toISOString());
    // NULL is a value with a meaning — never-urgent — not a missing field.
    expect(byId.get("inv_free")!.dueAt).toBeNull();
  });

  it("a status-free { dueAt } patch CORRECTS the invocation and leaves the row pending", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_fix", kind: "reply-draft", tier: 2, dueAt: Date.UTC(2027, 0, 1) });

    const corrected = "2027-03-05T17:00:00.000Z";
    const res = await h.set({ update: { inv_fix: { dueAt: corrected } } });
    expect(res.updated.inv_fix).toBeNull();
    // The write landed on the INVOCATION — due_at is the work's field, not a
    // proposal clock — and the decision surface is untouched: still pending.
    expect(
      h.w.db.query<{ due_at: number }>(
        "SELECT due_at FROM agent_invocations WHERE account_id = ? AND id = 'inv_fix'",
        ACCOUNT,
      )[0]!.due_at,
    ).toBe(Date.parse(corrected));
    expect(
      h.w.db.query<{ status: string; decision_json: string | null }>(
        "SELECT status, decision_json FROM agent_proposals WHERE account_id = ? AND id = 'inv_fix'",
        ACCOUNT,
      )[0],
    ).toEqual({ status: "pending", decision_json: null });
    // Choreography: the correction is visible to /changes, not only to /get.
    expect(res.newState).not.toBe(res.oldState);

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_fix"],
    });
    expect(got.list[0]!.dueAt).toBe(corrected);
  });

  it("dueAt: null clears a mis-read deadline back to never-urgent", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_clear", kind: "reply-draft", tier: 2, dueAt: Date.UTC(2027, 0, 1) });
    const res = await h.set({ update: { inv_clear: { dueAt: null } } });
    expect(res.updated.inv_clear).toBeNull();
    expect(
      h.w.db.query<{ due_at: number | null }>(
        "SELECT due_at FROM agent_invocations WHERE account_id = ? AND id = 'inv_clear'",
        ACCOUNT,
      )[0]!.due_at,
    ).toBeNull();
  });

  it("refuses dueAt riding on a decision — a correction is not a verdict", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_both", kind: "reply-draft", tier: 2 });
    const res = await h.set({
      update: { inv_both: { status: "approved", dueAt: "2027-03-05T17:00:00Z" } },
    });
    expect(res.notUpdated.inv_both!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_both!.description).toMatch(/its own update/);
    // Refused means refused: neither the decision nor the correction landed.
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = 'inv_both'",
        ACCOUNT,
      )[0]!.status,
    ).toBe("pending");
  });

  it("refuses an unparseable dueAt — a bad date must not silently become 'no deadline'", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_bad", kind: "reply-draft", tier: 2, dueAt: Date.UTC(2027, 0, 1) });
    const res = await h.set({ update: { inv_bad: { dueAt: "a week from Tuesday" } } });
    expect(res.notUpdated.inv_bad!.type).toBe("invalidProperties");
    expect(
      h.w.db.query<{ due_at: number | null }>(
        "SELECT due_at FROM agent_invocations WHERE account_id = ? AND id = 'inv_bad'",
        ACCOUNT,
      )[0]!.due_at,
    ).toBe(Date.UTC(2027, 0, 1)); // untouched
  });
});
