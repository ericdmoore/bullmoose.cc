import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { commitDueHeldProposals, registerActionProposalMethods } from "./actionProposal";
import { templateFollowupBody } from "../../../agent/src/watchCompose";
import type { RequestContext } from "./common";

/**
 * s20 wave 3 — `watch-followup` finally APPLIES (drafting-on-fire's other
 * half), and the exact wedge it fixes, reproduced first:
 *
 * `fire()` (services/agent watches.ts) emits `watch-followup` at tier 2, so an
 * approve parks the row in the hold tray — and `applyProposal` had NO case for
 * the kind, so `commitDueHeldProposals` threw "not applied in this slice" and
 * the row stayed `held`, retried forever: an approved follow-up nobody could
 * ever get, failing silently on a 5-minute clock. The tests here drive the
 * REAL approve → hold-tray → commit-sweep path end to end.
 *
 * What approval now produces is a DRAFT in the Drafts mailbox, in the OWNER's
 * voice (the primary identity, falling back to the watch's owner) — the same
 * shape the reply pipeline's draft mode writes (`$draft` + `$agent`, MIME blob
 * in R2, threaded to the watched message). NOT an egress: nothing relays; the
 * human sends it from their own composer. That is why there is no outbound-
 * bound check here — the draft belongs to the human, not to a binding.
 *
 * Old-format rows must apply too: a watch that FIRED before drafting-on-fire
 * deployed carries an intent-only payload ({watchId, conditionType, to,
 * note} — no body). The apply path synthesizes the SAME deterministic
 * template body compose falls back to, at apply time, instead of throwing.
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

/** Seed a fired watch's proposal: carrier invocation (done) + tier-2
 *  `watch-followup` row, exactly as `fire()` mints them. */
function seedFired(
  h: ReturnType<typeof harness>,
  id: string,
  payload: Record<string, unknown>,
  o: { cost?: { provider: string; model: string; tokensIn: number; tokensOut: number; costMicros: number } } = {},
) {
  h.w.db.seed("agent_invocations", [
    {
      id,
      account_id: ACCOUNT,
      binding_id: "bind_w",
      binding_name: "remind@",
      status: "done",
      created_at: 1,
      claimed_at: 1,
      done_at: 1,
      provider: o.cost?.provider ?? null,
      model: o.cost?.model ?? null,
      tokens_in: o.cost?.tokensIn ?? null,
      tokens_out: o.cost?.tokensOut ?? null,
      cost_micros: o.cost ? o.cost.costMicros : 0,
    },
  ]);
  h.w.db.seed("agent_proposals", [
    {
      id,
      account_id: ACCOUNT,
      kind: "watch-followup",
      tier: 2,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify(payload),
      rationale: "sergio had not replied by the deadline you set",
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_orig" }]),
      status: "pending",
      created_at: 1,
    },
  ]);
}

/** The account's primary sending identity — where the draft's From comes from. */
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

/** The message the watch was set on, for threading + the Re: subject. */
function seedOriginal(h: ReturnType<typeof harness>) {
  h.w.db.seed("emails", [
    {
      id: "e_orig",
      account_id: ACCOUNT,
      blob_id: "b_orig",
      thread_id: "t_orig",
      message_id: "orig@x",
      subject: "the quote",
      from_json: JSON.stringify([{ email: OWNER }]),
      to_json: JSON.stringify([{ email: "sergio@example.com" }]),
      preview: "any word on the quote?",
      size: 20,
      received_at: 100,
      has_attachment: 0,
    },
  ]);
}

/** Approve (→ held), then run the commit sweep past the retraction window. */
async function approveAndSweep(h: ReturnType<typeof harness>, id: string) {
  const res = await h.set({ update: { [id]: { status: "approved" } } });
  expect(res.notUpdated).toEqual({});
  const held = h.w.db.query<{ status: string; hold_until: number }>(
    `SELECT status, hold_until FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;
  expect(held.status).toBe("held"); // tier 2: the tray, not an immediate apply
  return commitDueHeldProposals(h.ctx, { now: held.hold_until + 1 });
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

describe("the wedge — an approved watch-followup must COMMIT, not retry forever", () => {
  it("new format (drafted at fire time): approve → held → sweep creates the draft", async () => {
    const h = harness();
    seedIdentity(h);
    seedOriginal(h);
    seedFired(h, "inv_wf1", {
      watchId: "w_1",
      conditionType: "no-reply-from",
      to: "sergio@example.com",
      note: "waiting on the quote",
      subject: "Re: the quote",
      body: "Hi Sergio — just checking in on the quote. Any word?",
      composed: "model",
      model: "openrouter/minimax/minimax-m3",
    });

    const { committed, failed } = await approveAndSweep(h, "inv_wf1");
    // THE WEDGE, pre-fix: failed = [{id, error: '…"watch-followup"…not applied
    // in this slice…'}] and the row stays held — approved work that can never
    // land, retried every sweep. Post-fix it commits.
    expect(failed).toEqual([]);
    expect(committed).toEqual(["inv_wf1"]);

    // The proposal is decided, not wedged.
    const prop = h.w.db.query<{ status: string }>(`SELECT status FROM agent_proposals WHERE id = 'inv_wf1'`)[0]!;
    expect(prop.status).toBe("approved");

    // The draft exists, in Drafts, as a DRAFT — the fire-time body verbatim,
    // in the owner's voice, threaded to the watched message.
    const drafts = draftRows(h);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.subject).toBe("Re: the quote");
    expect(d.preview).toContain("just checking in on the quote");
    expect(JSON.parse(d.from_json)[0].email).toBe(OWNER);
    expect(JSON.parse(d.to_json)[0].email).toBe("sergio@example.com");
    expect(d.in_reply_to).toBe("orig@x");
    expect(d.thread_id).toBe("t_orig");
    expect(keywordsOf(h, d.id)).toEqual(expect.arrayContaining(["$draft", "$agent"]));
    const mailbox = h.w.db.query<{ role: string }>(
      `SELECT m.role FROM mailboxes m
        JOIN email_mailboxes em ON em.mailbox_id = m.id AND em.account_id = m.account_id
       WHERE em.email_id = '${d.id}'`,
    )[0]!;
    expect(mailbox.role).toBe("drafts");

    // A draft is NOT an egress: nothing relayed.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("OLD format (fired before this shipped, intent only): the template body is synthesized at apply time", async () => {
    const h = harness();
    // No identities row: the From falls back to the WATCH's owner.
    h.w.db.seed("watches", [
      {
        id: "w_old",
        account_id: ACCOUNT,
        owner: OWNER,
        condition_type: "no-reply-from",
        condition_json: JSON.stringify({ sender: "sergio@example.com" }),
        deadline_at: 500,
        action_type: "draft-followup",
        action_json: "{}",
        status: "fired",
        created_at: 100,
      },
    ]);
    seedFired(h, "inv_wf_old", {
      watchId: "w_old",
      conditionType: "no-reply-from",
      to: "sergio@example.com",
      note: "the board quote",
      // no subject, no body, no composed — the live pre-deploy shape
    });

    const { committed, failed } = await approveAndSweep(h, "inv_wf_old");
    expect(failed).toEqual([]);
    expect(committed).toEqual(["inv_wf_old"]);

    const drafts = draftRows(h);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    // The SAME deterministic template the fire-time fallback uses — one
    // definition, two call sites (compose fallback; old-format apply).
    expect(d.preview).toBe(templateFollowupBody({ note: "the board quote" }).slice(0, 256));
    expect(d.subject).toBe("Following up: the board quote");
    expect(JSON.parse(d.from_json)[0].email).toBe(OWNER);
    expect(keywordsOf(h, d.id)).toEqual(expect.arrayContaining(["$draft", "$agent"]));
    expect(h.w.submit.calls).toEqual([]);
  });

  it("the sweep's commit reaches /changes — a draft push cannot see never happened", async () => {
    const h = harness();
    seedIdentity(h);
    seedFired(h, "inv_wf_ch", {
      watchId: "w_c",
      conditionType: "deadline",
      to: "sergio@example.com",
      note: null,
      subject: "Following up",
      body: "checking in.",
      composed: "template",
    });
    const before = (await h.call<{ state: string }>("ActionProposal/get", { ids: [] })).state;
    await approveAndSweep(h, "inv_wf_ch");
    const changes = await h.call<{ updated: string[] }>("ActionProposal/changes", { sinceState: before });
    expect(changes.updated).toContain("inv_wf_ch");
    const emailChanges = await h.w.accountDo.changes(ACCOUNT, "Email", "0");
    expect(emailChanges.created).toHaveLength(1);
  });

  it("refuses a payload with no recipient — loudly, not by wedging silently", async () => {
    const h = harness();
    seedIdentity(h);
    seedFired(h, "inv_wf_nr", { watchId: "w_x", conditionType: "no-reply-from", to: null, note: "malformed" });
    const { committed, failed } = await approveAndSweep(h, "inv_wf_nr");
    // A recipient-less follow-up cannot be drafted TO anyone: the row stays
    // held (visible, yankable) and the failure names the missing field —
    // the reply-draft posture for unappliable rows, not a silent drop.
    expect(committed).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toMatch(/recipient/);
    expect(draftRows(h)).toHaveLength(0);
  });
});

describe("approval-surface honesty — the compose cost rides the proposal row", () => {
  it("ActionProposal/get surfaces the carrier's cost block (µ$, tokens, model)", async () => {
    const h = harness();
    seedFired(
      h,
      "inv_wf_cost",
      {
        watchId: "w_cost",
        conditionType: "no-reply-from",
        to: "sergio@example.com",
        note: "the quote",
        subject: "Re: the quote",
        body: "composed body",
        composed: "model",
        model: "openrouter/minimax/minimax-m3",
      },
      { cost: { provider: "openrouter", model: "minimax/minimax-m3", tokensIn: 310, tokensOut: 74, costMicros: 42 } },
    );
    const got = await h.call<{ list: Array<Record<string, unknown>> }>("ActionProposal/get", {
      ids: ["inv_wf_cost"],
    });
    const p = got.list[0]!;
    expect(p.costMicros).toBe(42);
    expect(p.tokensIn).toBe(310);
    expect(p.tokensOut).toBe(74);
    expect(p.costModel).toBe("openrouter/minimax/minimax-m3");
    // …and the payload says which path composed the body.
    expect((p.payload as Record<string, unknown>).composed).toBe("model");
  });
});
