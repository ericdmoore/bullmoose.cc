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

const BOOK = "ab_reach";

/**
 * Give the proposal's binding a governing book reaching `members` (s10 T1).
 *
 * Every egress in this file now sits behind the outbound bound, and the bound
 * is fail-closed: with no `agent_bindings` row and no book, EVERY send refuses.
 * So a fixture that expects mail to leave has to say who the binding is
 * ALLOWED to email — which is the production posture stated as a fixture, not
 * a concession to the test.
 */
function governBinding(
  w: ReturnType<typeof fakeEnv>,
  members: string[],
  opts: { bookId?: string | null; enabled?: number; account?: string } = {},
): void {
  const account = opts.account ?? ACCOUNT;
  const bookId = opts.bookId === undefined ? BOOK : opts.bookId;
  w.db.seed("agent_bindings", [
    {
      id: "bind_x",
      account_id: account,
      name: "emily",
      recipients_book_id: bookId,
      enabled: opts.enabled ?? 1,
    },
  ]);
  if (bookId === null) return;
  w.db.seed("address_books", [
    {
      id: bookId,
      account_id: account,
      name: "the binding may email",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: 1,
      updated_at: 1,
      write_policy: "governed",
    },
  ]);
  w.db.seed(
    "contact_cards",
    members.map((address, i) => ({
      id: `cc_gb${i}`,
      account_id: account,
      address_book_id: bookId,
      uid: `u_gb${i}`,
      card_json: JSON.stringify({ uid: `u_gb${i}`, emails: { e: { address } } }),
      name_full: address,
      dav_name: null,
      created_at: 1,
      updated_at: 1,
    })),
  );
}

/** Narrow the book to nothing — the "revoked between draft and send" move. */
function narrowBook(w: ReturnType<typeof fakeEnv>): void {
  w.db.query(`DELETE FROM contact_cards WHERE address_book_id = '${BOOK}'`);
}

/** Put an address back into the governing book — narrowing's inverse. */
function widenBook(w: ReturnType<typeof fakeEnv>, address: string): void {
  w.db.seed("contact_cards", [
    {
      id: `cc_w_${address}`,
      account_id: ACCOUNT,
      address_book_id: BOOK,
      uid: `u_w_${address}`,
      card_json: JSON.stringify({ uid: `u_w_${address}`, emails: { e: { address } } }),
      name_full: address,
      dav_name: null,
      created_at: 2,
      updated_at: 2,
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
      payload: {
        card: { name: { full: "Dana Vendor" }, emails: { work: { address: "dana@acme.test" } } },
      },
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
    }>(
      "SELECT id, name_full, last_writer_principal, last_writer_binding, last_writer_invocation FROM contact_cards WHERE account_id = ?",
      ACCOUNT,
    )[0]!;
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
    expect(JSON.parse(prop.decision_json).undo).toMatchObject({
      action: "destroy-contact",
      cardId: card.id,
    });

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
      update: {
        inv_e: { status: "approved", editedPayload: { card: { name: { full: "Human Fix" } } } },
      },
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
    governBinding(h.w, ["outside@example.com"]);

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
      update: {
        inv_r: { status: "rejected", decision: { reason: "wrongContent", note: "off tone" } },
      },
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
    const res = await h.set({
      update: { inv_bad: { status: "rejected", decision: { reason: "meh" } } },
    });
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
        inv_unsafe: {
          status: "rejected",
          decision: { reason: "unsafe", note: "quoted the contract terms" },
        },
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
    expect(res.notUpdated.inv_retired!.description).toBe("decision.reason must be wrongContent | wrongAction | unsafe");
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
    await expect(h.set({ create: { c: { kind: "reply-draft", tier: 2 } } })).rejects.toThrow(/create/i);
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
      update: {
        inv_ni: { status: "info-requested", question: "Why Bob, and not the alias you have?" },
      },
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
    const inv = h.w.db.query<{
      id: string;
      binding_id: string;
      binding_name: string;
      context_json: string;
    }>(
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
    expect(JSON.parse(prop.decision_json).undo).toMatchObject({
      action: "destroy-contact",
      cardId: card.id,
    });
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
    expect(h.w.db.query<{ id: string }>("SELECT id FROM contact_cards WHERE account_id = ?", ACCOUNT)).toHaveLength(1);
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
    seedProposal(h.w, {
      id: "inv_clear",
      kind: "reply-draft",
      tier: 2,
      dueAt: Date.UTC(2027, 0, 1),
    });
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

// ---- s03.D T2: yank, and the commit that makes Approve mean send ----------
//
// The half the tray was waiting for. Found honestly: EditorEmily answered a
// draft request in five seconds and the reply sat for two days — approving it
// would only have parked it in a tray nothing ever emptied. These pin both
// halves: the retraction verb, and the sweep that egresses what the window
// releases.

import { commitDueHeldProposals } from "./actionProposal";

const HELD_PAYLOAD = {
  to: "outside@example.com",
  self: "emily@bullmoose.cc",
  blobId: "b_draft",
  subject: "re: please tighten this",
  text: "Tightened. —E",
};

/** Seed a proposal already in the hold tray, window closing at `holdUntil`.
 *  The sweep resolves the account's tenant per row (it crosses accounts), so
 *  unlike the /set tests the account row itself must exist. The binding is
 *  governed to reach exactly the held payload's recipient — the sweep egresses,
 *  so it sits behind the outbound bound like every other send. */
function seedHeld(h: ReturnType<typeof harness>, id: string, holdUntil: number, by = "eric@login.example") {
  h.w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@login.example",
    displayName: "Eric",
  });
  if (h.w.db.count("agent_bindings") === 0) governBinding(h.w, [HELD_PAYLOAD.to]);
  seedProposal(h.w, { id, kind: "reply-draft", tier: 2, status: "held", payload: HELD_PAYLOAD });
  h.w.db.query(
    `UPDATE agent_proposals SET hold_until = ${holdUntil}, decided_at = 5,
       decision_json = '${JSON.stringify({ by })}' WHERE id = '${id}'`,
  );
}

describe("s03.D T2 — yank: the retraction the hold window exists for", () => {
  it("yanks a held proposal while the window is open, and nothing egresses", async () => {
    const h = harness();
    seedHeld(h, "inv_y1", Date.now() + 60_000);
    const res = await h.set({ update: { inv_y1: { status: "yanked" } } });
    expect(res.updated).toHaveProperty("inv_y1");
    const row = h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_y1'`)[0]!;
    expect(row.status).toBe("yanked");
    expect(h.w.submit.calls).toEqual([]);
  });

  it("a yank is visible to /changes — the choreography survives the new verb", async () => {
    const h = harness();
    seedHeld(h, "inv_y2", Date.now() + 60_000);
    const before = (await h.call<{ state: string }>("ActionProposal/get", { ids: [] })).state;
    await h.set({ update: { inv_y2: { status: "yanked" } } });
    const changes = await h.call<{ updated: string[] }>("ActionProposal/changes", {
      sinceState: before,
    });
    expect(changes.updated).toContain("inv_y2");
  });

  it("refuses a yank after the window closes — the sweep owns it now", async () => {
    const h = harness();
    seedHeld(h, "inv_y3", Date.now() - 1_000);
    const res = await h.set({ update: { inv_y3: { status: "yanked" } } });
    expect(res.notUpdated.inv_y3?.description).toMatch(/too late to yank/);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_y3'`)[0]!.status).toBe(
      "held",
    );
  });

  it("refuses to yank a pending proposal — that is a decline, not a yank", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_y4", kind: "reply-draft", tier: 2 });
    const res = await h.set({ update: { inv_y4: { status: "yanked" } } });
    expect(res.notUpdated.inv_y4?.description).toMatch(/declined, not yanked/);
  });

  it("refuses to RE-decide a held proposal — the tray offers yank and nothing else", async () => {
    const h = harness();
    seedHeld(h, "inv_y5", Date.now() + 60_000);
    const res = await h.set({ update: { inv_y5: { status: "approved" } } });
    expect(res.notUpdated.inv_y5?.description).toMatch(/is held, not pending/);
  });
});

describe("s03.D T2 — the commit sweep: Approve finally means send", () => {
  it("commits a held proposal whose window has closed: relays, records Sent, flips status", async () => {
    const h = harness();
    seedHeld(h, "inv_c1", Date.now() - 1_000, "approver@login.example");
    const { committed, failed } = await commitDueHeldProposals(h.ctx);
    expect(failed).toEqual([]);
    expect(committed).toEqual(["inv_c1"]);
    // The egress actually happened.
    expect(h.w.submit.calls).toEqual([{ mailFrom: "emily@bullmoose.cc", rcptTo: ["outside@example.com"] }]);
    // The Sent copy exists and its provenance names the APPROVER — the write
    // belongs to the human whose approval it executes, not to the sweep.
    const email = h.w.db.query<{
      last_writer_principal: string | null;
      last_writer_binding: string | null;
    }>(`SELECT last_writer_principal, last_writer_binding FROM emails WHERE account_id = '${ACCOUNT}'`)[0]!;
    expect(email.last_writer_principal).toBe("approver@login.example");
    expect(email.last_writer_binding).toBe("emily");
    // Status flipped with the commit stamped into the decision.
    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      `SELECT status, decision_json FROM agent_proposals WHERE id = 'inv_c1'`,
    )[0]!;
    expect(prop.status).toBe("approved");
    expect(JSON.parse(prop.decision_json).committedAt).toBeGreaterThan(0);
  });

  it("the commit is visible to /changes — a sweep that skips the changelog is invisible to push", async () => {
    const h = harness();
    seedHeld(h, "inv_c2", Date.now() - 1_000);
    const before = (await h.call<{ state: string }>("ActionProposal/get", { ids: [] })).state;
    await commitDueHeldProposals(h.ctx);
    const changes = await h.call<{ updated: string[] }>("ActionProposal/changes", {
      sinceState: before,
    });
    expect(changes.updated).toContain("inv_c2");
  });

  it("leaves a still-open window alone", async () => {
    const h = harness();
    seedHeld(h, "inv_c3", Date.now() + 60_000);
    const { committed } = await commitDueHeldProposals(h.ctx);
    expect(committed).toEqual([]);
    expect(h.w.submit.calls).toEqual([]);
  });

  it("a failed relay stays HELD and reports — retried next sweep, never lost, never double-sent", async () => {
    const h = harness();
    seedHeld(h, "inv_c4", Date.now() - 1_000);
    // Break the relay for this run.
    (h.w.env as { SUBMIT: Fetcher }).SUBMIT = {
      fetch: async () => new Response("boom", { status: 500 }),
    } as unknown as Fetcher;
    const { committed, failed } = await commitDueHeldProposals(h.ctx);
    expect(committed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toMatch(/submit relay failed/);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_c4'`)[0]!.status).toBe(
      "held",
    );
  });
});

// ---- the governing book, enforced AT EGRESS -------------------------------
//
// s10 T1 shipped `assertOutboundAllowed` and wired it into the agent worker's
// three relay sites. It was never wired into THIS worker — and the approval
// path egresses from here. The whole gap in one sentence: the book was checked
// when the agent DRAFTED, and never when the proposal SENT.
//
// These are written as the attacks they close, not as coverage. Each one is a
// sequence a real operator can perform with no special access: narrow a book,
// disable a binding, retype a recipient in the approve dialog.
//
// Deleting the `assertOutboundAllowed` call in `applyProposal` fails the first
// two and the edited-recipient one. Checking `row.payload_json` instead of the
// effective payload fails the edited-recipient one. Checking the book at draft
// time instead of at the relay fails all three.

const OUT = "outside@example.com";

describe("ATTACK: a book narrowed after the draft still bites at approve", () => {
  const tier3 = (payload: Record<string, unknown>) => ({
    id: "inv_nb",
    kind: "reply-draft",
    tier: 3,
    payload,
  });

  it("narrowing between draft and approve refuses the tier-3 apply, and nothing egresses", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, tier3({ to: OUT, self: "emily@bullmoose.cc", blobId: "b_r", subject: "s", text: "t" }));
    governBinding(h.w, [OUT]);

    // …the human narrows the book while the proposal sits in the queue.
    narrowBook(h.w);

    const res = await h.set({ update: { inv_nb: { status: "approved" } } });
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_nb!.type).toBe("forbidden");
    expect(res.notUpdated.inv_nb!.description).toMatch(
      /outbound bound.*not in the governing book: outside@example\.com/,
    );
    // Nothing left, and the row is recoverable rather than dropped: still
    // pending, still decidable once the book is right.
    expect(h.w.submit.calls).toEqual([]);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_nb'`)[0]!.status).toBe(
      "pending",
    );
    // No Sent copy either — the refusal is BEFORE the relay, not after it.
    expect(h.w.db.count("emails")).toBe(0);
  });

  it("re-widening the book lets the very same queued proposal through", async () => {
    const h = harness(["mail"]);
    seedProposal(h.w, tier3({ to: OUT, self: "emily@bullmoose.cc", blobId: "b_r", subject: "s", text: "t" }));
    governBinding(h.w, [OUT]);
    narrowBook(h.w);
    await h.set({ update: { inv_nb: { status: "approved" } } });
    expect(h.w.submit.calls).toEqual([]);

    // The bound is a live question, not a verdict: put the address back and
    // the identical row sends.
    widenBook(h.w, OUT);
    const res = await h.set({ update: { inv_nb: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(h.w.submit.calls).toEqual([{ mailFrom: "emily@bullmoose.cc", rcptTo: [OUT] }]);
  });
});

describe("ATTACK: a book narrowed after APPROVE still bites at the hold-tray commit", () => {
  it("the sweep refuses, the row stays held with a legible reason, and no mail leaves", async () => {
    const h = harness();
    seedHeld(h, "inv_nh", Date.now() - 1_000);
    // Approved, window closed, sweep about to run — and the book is narrowed
    // in that gap. This is the tier-2 twin of the case above, and the one the
    // 5-minute retraction window makes easy to hit.
    narrowBook(h.w);

    const { committed, failed } = await commitDueHeldProposals(h.ctx);
    expect(committed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toMatch(/outbound bound.*not in the governing book/);
    expect(h.w.submit.calls).toEqual([]);
    // Held, not lost: `commitHeld.ts` logs the reason loudly and the row is
    // retried next sweep — it sends the moment the book allows it again.
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_nh'`)[0]!.status).toBe(
      "held",
    );
  });

  it("an in-book held proposal still commits — the guard refuses, it does not block", async () => {
    const h = harness();
    seedHeld(h, "inv_ok", Date.now() - 1_000);
    const { committed, failed } = await commitDueHeldProposals(h.ctx);
    expect(failed).toEqual([]);
    expect(committed).toEqual(["inv_ok"]);
    expect(h.w.submit.calls).toEqual([{ mailFrom: "emily@bullmoose.cc", rcptTo: [OUT] }]);
  });
});

describe("ATTACK: editedPayload cannot edit its way past the bound", () => {
  // `editedPayload` is validated ONLY as `typeof === "object"` and then
  // REPLACES the payload wholesale for the apply (`effectivePayload`). Every
  // key is editable, `to` included — so before the egress check existed, the
  // approve dialog was a recipient-rewrite primitive. The first test proves
  // recipients really are editable (the hole is real); the second proves the
  // rewrite is now bounded by the same book.
  const seedEditable = (h: ReturnType<typeof harness>) =>
    seedProposal(h.w, {
      id: "inv_ed",
      kind: "reply-draft",
      tier: 3,
      payload: { to: OUT, self: "emily@bullmoose.cc", blobId: "b_r", subject: "s", text: "t" },
    });

  const edited = (to: string) => ({
    to,
    self: "emily@bullmoose.cc",
    blobId: "b_r",
    subject: "s",
    text: "t",
  });

  it("PROOF the hole is real: editedPayload.to redirects the actual envelope", async () => {
    const h = harness(["mail"]);
    seedEditable(h);
    governBinding(h.w, [OUT, "elsewhere@example.com"]);

    const res = await h.set({
      update: { inv_ed: { status: "approved", editedPayload: edited("elsewhere@example.com") } },
    });
    expect(res.notUpdated).toEqual({});
    // The agent drafted to `outside@`; the envelope went to `elsewhere@`. The
    // approver, not the agent, chose the recipient — which is exactly why the
    // draft-time check could never have been enough.
    expect(h.w.submit.calls).toEqual([{ mailFrom: "emily@bullmoose.cc", rcptTo: ["elsewhere@example.com"] }]);
    // And the agent's original is retained beside the edit, unrewritten.
    const prop = h.w.db.query<{ payload_json: string }>(
      `SELECT payload_json FROM agent_proposals WHERE id = 'inv_ed'`,
    )[0]!;
    expect(JSON.parse(prop.payload_json).to).toBe(OUT);
  });

  it("REFUSES an edited recipient outside the book — the human cannot widen the bound by retyping", async () => {
    const h = harness(["mail"]);
    seedEditable(h);
    governBinding(h.w, [OUT]); // `attacker@` is NOT in the book

    const res = await h.set({
      update: { inv_ed: { status: "approved", editedPayload: edited("attacker@evil.test") } },
    });
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_ed!.type).toBe("forbidden");
    expect(res.notUpdated.inv_ed!.description).toMatch(/not in the governing book: attacker@evil\.test/);
    expect(h.w.submit.calls).toEqual([]);
    expect(h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_ed'`)[0]!.status).toBe(
      "pending",
    );
  });

  it("REFUSES an edited recipient at the hold-tray commit too — tier 2 gets the same answer", async () => {
    const h = harness(["mail"]);
    seedHeld(h, "inv_eh", Date.now() - 1_000);
    // The approver edited the recipient on the way into the tray; the sweep
    // reads `edited_payload_json` in preference to `payload_json`, so this is
    // the address that would actually be relayed.
    h.w.db.query(
      `UPDATE agent_proposals SET edited_payload_json = '${JSON.stringify(edited("attacker@evil.test"))}'
       WHERE id = 'inv_eh'`,
    );
    const { committed, failed } = await commitDueHeldProposals(h.ctx);
    expect(committed).toEqual([]);
    expect(failed[0]!.error).toMatch(/not in the governing book: attacker@evil\.test/);
    expect(h.w.submit.calls).toEqual([]);
  });
});

describe("ATTACK: fail-closed — an unbound or revoked binding cannot send at all", () => {
  const seedTier3 = (h: ReturnType<typeof harness>, id: string) =>
    seedProposal(h.w, {
      id,
      kind: "reply-draft",
      tier: 3,
      payload: { to: OUT, self: "emily@bullmoose.cc", blobId: "b_r", subject: "s", text: "t" },
    });

  it("a NULL governing book refuses — unbound means CANNOT SEND, never unrestricted", async () => {
    const h = harness(["mail"]);
    seedTier3(h, "inv_null");
    governBinding(h.w, [], { bookId: null });

    const res = await h.set({ update: { inv_null: { status: "approved" } } });
    expect(res.notUpdated.inv_null!.type).toBe("forbidden");
    expect(res.notUpdated.inv_null!.description).toMatch(/no governing book/);
    expect(h.w.submit.calls).toEqual([]);
  });

  it("a DISABLED binding refuses even with the recipient in its book", async () => {
    const h = harness(["mail"]);
    seedTier3(h, "inv_off");
    governBinding(h.w, [OUT], { enabled: 0 });

    const res = await h.set({ update: { inv_off: { status: "approved" } } });
    expect(res.notUpdated.inv_off!.type).toBe("forbidden");
    expect(res.notUpdated.inv_off!.description).toMatch(/is disabled/);
    expect(h.w.submit.calls).toEqual([]);
  });

  it("a MISSING binding row refuses — an invocation whose binding was destroyed cannot egress", async () => {
    const h = harness(["mail"]);
    seedTier3(h, "inv_gone"); // no `agent_bindings` row seeded at all

    const res = await h.set({ update: { inv_gone: { status: "approved" } } });
    expect(res.notUpdated.inv_gone!.type).toBe("forbidden");
    expect(res.notUpdated.inv_gone!.description).toMatch(/binding bind_x does not exist/);
    expect(h.w.submit.calls).toEqual([]);
  });

  it("an EMPTY governing book refuses — a book is an allowlist, not a formality", async () => {
    const h = harness(["mail"]);
    seedTier3(h, "inv_empty");
    governBinding(h.w, []);

    const res = await h.set({ update: { inv_empty: { status: "approved" } } });
    expect(res.notUpdated.inv_empty!.type).toBe("forbidden");
    expect(h.w.submit.calls).toEqual([]);
  });
});
// ---- the µUSD cost block on the read model (Eric 2026-08-18) --------------

describe("the proposal read model carries the invocation's frozen cost", () => {
  it("projects costMicros/tokens/costModel, and NULL survives as null (not 0)", async () => {
    const h = harness();
    seedProposal(h.w, { id: "inv_cost", kind: "reply-draft", tier: 2 });
    h.w.db.query(
      `UPDATE agent_invocations SET provider = 'openrouter', model = 'minimax/minimax-m3',
         tokens_in = 1832, tokens_out = 412, cost_micros = 2140 WHERE id = 'inv_cost'`,
    );
    seedProposal(h.w, { id: "inv_free", kind: "watch-offer", tier: 1 });
    h.w.db.query(`UPDATE agent_invocations SET cost_micros = 0 WHERE id = 'inv_free'`);
    seedProposal(h.w, { id: "inv_unknown", kind: "reply-draft", tier: 2 });

    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_cost", "inv_free", "inv_unknown"],
    });
    const by = new Map(got.list.map((p) => [p.id, p]));
    expect(by.get("inv_cost")).toMatchObject({
      costMicros: 2140,
      tokensIn: 1832,
      tokensOut: 412,
      costModel: "openrouter/minimax/minimax-m3",
    });
    // 0 is KNOWN FREE; null is NOT RECORDED — they must never collapse.
    expect(by.get("inv_free")!.costMicros).toBe(0);
    expect(by.get("inv_unknown")!.costMicros).toBeNull();
    expect(by.get("inv_unknown")!.costModel).toBeNull();
  });
});

// ---- s20 T1↔T4: the agent-offered Watch (watch-offer) ---------------------

describe("approving a watch-offer arms a no-reply-from Watch", () => {
  const sentAt = 5_000;
  const durationMs = 4 * 24 * 3600_000;
  const offerPayload = {
    to: "sergio@example.com",
    threadId: "th_x",
    emailId: "e_ask",
    sentAt,
    watchDurationMs: durationMs,
  };

  it("arms the watch (condition, action, source), backdating created_at to the send", async () => {
    const h = harness(["mail"]);
    h.w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, loginEmail: "eric@bullmoose.cc" }); // watches FK → accounts
    seedProposal(h.w, {
      id: "inv_wo",
      kind: "watch-offer",
      tier: 1,
      subject: { realm: "Email", objectId: "e_ask" },
      payload: offerPayload,
    });

    const before = Date.now();
    const res = await h.set({ update: { inv_wo: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_wo).toBeNull();

    const watch = h.w.db.query<{
      account_id: string;
      owner: string;
      condition_type: string;
      condition_json: string;
      action_type: string;
      action_json: string;
      status: string;
      source_ref: string | null;
      created_at: number;
      deadline_at: number;
      id: string;
    }>(`SELECT * FROM watches`)[0]!;
    expect(watch.account_id).toBe(ACCOUNT);
    expect(watch.condition_type).toBe("no-reply-from");
    expect(JSON.parse(watch.condition_json)).toEqual({
      sender: "sergio@example.com",
      threadId: "th_x",
    });
    expect(watch.action_type).toBe("draft-followup");
    expect(JSON.parse(watch.action_json)).toEqual({ to: "sergio@example.com" });
    expect(watch.status).toBe("armed");
    expect(watch.source_ref).toBe("e_ask");
    // Backdated: "no reply SINCE I sent it", not since I approved the offer.
    expect(watch.created_at).toBe(sentAt);
    // Deadline measured from approval, not from the (older) offer.
    expect(watch.deadline_at).toBeGreaterThanOrEqual(before + durationMs);

    // Approved, with the tier-1 undo handle that cancels the very watch armed.
    const prop = h.w.db.query<{ status: string; decision_json: string }>(
      `SELECT status, decision_json FROM agent_proposals WHERE id = 'inv_wo'`,
    )[0]!;
    expect(prop.status).toBe("approved");
    expect(JSON.parse(prop.decision_json).undo).toEqual({
      action: "cancel-watch",
      watchId: watch.id,
    });
  });

  it("declining is no-fault: a reject reason is refused; a bare decline records it and arms nothing", async () => {
    const h = harness(["mail"]);
    h.w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, loginEmail: "eric@bullmoose.cc" });
    seedProposal(h.w, { id: "inv_wo2", kind: "watch-offer", tier: 1, payload: offerPayload });

    // A fault reason is refused — the agent was right to notice you're waiting.
    const bad = await h.set({
      update: { inv_wo2: { status: "rejected", decision: { reason: "wrongAction" } } },
    });
    expect(bad.updated).toEqual({});
    expect(bad.notUpdated.inv_wo2!.type).toBe("invalidProperties");

    // A bare decline is accepted; no watch is armed.
    const ok = await h.set({ update: { inv_wo2: { status: "rejected" } } });
    expect(ok.updated.inv_wo2).toBeNull();
    expect(h.w.db.query(`SELECT * FROM watches`)).toEqual([]);
  });
});
