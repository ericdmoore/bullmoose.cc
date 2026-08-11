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

function harness(scopes: string[] = ["mail"]) {
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
      expires_at: s.expiresAt ?? null,
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
