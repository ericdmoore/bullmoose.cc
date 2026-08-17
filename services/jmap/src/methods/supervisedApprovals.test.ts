import { describe, expect, it } from "vitest";
import { MethodRegistry, AGENT_CAP } from "@bullmoose/jmap-core";
import { fakeEnv, fakeKV, type FakeWorker } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import { verifyBearer } from "@bullmoose/auth-core/principal";
import provisionWorker, { SUPERVISORY_GRANT_SCOPES, type Env as ProvisionEnv } from "../../../provision/src/index";
import { registerActionProposalMethods } from "./actionProposal";
import { buildSession } from "../session";
import type { RequestContext } from "./common";

/**
 * s10 T7 — *proposals must reach the human they wait on*, proven against the
 * real method over the real control-plane schema.
 *
 * THE BUG, observed live on the first end-to-end run: EditorEmily produced a
 * `pending` reply-draft and `/approvals` told Eric "Nothing is waiting on
 * you."
 *
 *   eric@bullmoose.cc   → account …850b74f3 → principal p_03f2bbe3
 *   editor@bullmoose.cc → account …ca58ac53 → principal p_9e016b64  ← the proposal
 *   grants between them → none
 *
 * Agents are separate principals BY DESIGN, so a single-account queue can never
 * show a human their agents' work. The fix is two halves, and this suite is the
 * second half's proof: with the supervisory grant provisioning now mints, the
 * proposal is visible, decidable, revocable — and never crosses a tenant.
 *
 * Nothing is mocked in the authorization path: the principal is resolved from a
 * REAL minted token through `verifyBearer`, the grant rows are real, and every
 * read and decision runs through the registered `ActionProposal/*` methods. The
 * grant SCOPES are imported from the provisioning worker, so a change to what
 * provisioning mints and a change to what the queue needs cannot pass each
 * other in the dark — the two ends of T7 are pinned to one constant.
 */

const TENANT = "t_bm";
const OTHER_TENANT = "t_neighbour";

const ERIC = "a_eric"; //     the human
const EMILY = "a_emily"; //   agent account, FULL supervisory grant
const CJ = "a_cj"; //         agent account, grant WITHOUT `send`
const ALLEN = "a_allen"; //   agent account, READ-ONLY grant
const UNGRANTED = "a_quiet"; // agent account in the same tenant, no grant
const NEIGHBOUR = "a_neighbour"; // another tenant's human
const OTTO = "a_otto"; //     another tenant's agent — granted, INSIDE that tenant

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

interface GetResult {
  accountId: string;
  list: Record<string, unknown>[];
}

interface SeedSpec {
  account: string;
  id: string;
  binding: string;
  kind?: string;
  tier?: number;
  payload?: Record<string, unknown>;
}

function seedProposal(w: FakeWorker, s: SeedSpec): void {
  w.db.seed("agent_invocations", [
    {
      id: s.id,
      account_id: s.account,
      binding_id: `bind_${s.binding}`,
      binding_name: s.binding,
      status: "done",
      created_at: 1,
    },
  ]);
  w.db.seed("agent_proposals", [
    {
      id: s.id,
      account_id: s.account,
      kind: s.kind ?? "create-contact",
      tier: s.tier ?? 1,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_1" }),
      payload_json: JSON.stringify(s.payload ?? { card: { name: { full: "Grace" } } }),
      rationale: `${s.binding} thinks this is worth doing`,
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_1" }]),
      status: "pending",
      created_at: 1,
    },
  ]);
}

/**
 * Give one account's binding a governing book reaching `members` (s10 T1).
 * The outbound bound is fail-closed, so any fixture that expects mail to leave
 * must state the reach it is claiming — see actionProposal.test.ts's twin.
 */
function governBinding(w: FakeWorker, account: string, binding: string, members: string[]): void {
  const bookId = `ab_${binding}`;
  w.db.seed("agent_bindings", [
    {
      id: `bind_${binding}`,
      account_id: account,
      name: binding,
      recipients_book_id: bookId,
      enabled: 1,
    },
  ]);
  w.db.seed("address_books", [
    {
      id: bookId,
      account_id: account,
      name: `${binding} may email`,
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
      id: `cc_${binding}${i}`,
      account_id: account,
      address_book_id: bookId,
      uid: `u_${binding}${i}`,
      card_json: JSON.stringify({ uid: `u_${binding}${i}`, emails: { e: { address } } }),
      name_full: address,
      dav_name: null,
      created_at: 1,
      updated_at: 1,
    })),
  );
}

async function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerActionProposalMethods(registry);

  w.db
    .seedAccount({ accountId: ERIC, principalId: "p_eric", loginEmail: "eric@bullmoose.cc" })
    .seedAccount({ accountId: EMILY, principalId: "p_emily", loginEmail: "editor@bullmoose.cc" })
    .seedAccount({ accountId: CJ, principalId: "p_cj", loginEmail: "cj@bullmoose.cc" })
    .seedAccount({ accountId: ALLEN, principalId: "p_allen", loginEmail: "analyst@bullmoose.cc" })
    .seedAccount({ accountId: UNGRANTED, principalId: "p_quiet", loginEmail: "quiet@bullmoose.cc" })
    .seedAccount({
      accountId: NEIGHBOUR,
      principalId: "p_neighbour",
      loginEmail: "sam@neighbour.test",
      tenantId: OTHER_TENANT,
    })
    .seedAccount({
      accountId: OTTO,
      principalId: "p_otto",
      loginEmail: "otto@neighbour.test",
      tenantId: OTHER_TENANT,
    });

  // Eric's ONE login: a real minted bearer token. `mail` is a human token —
  // it bundles read/draft/send, so every refusal below comes from the GRANT
  // side of the token ∩ grant intersection, never from the token.
  const minted = await mintToken();
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "eric-laptop",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
    },
  ]);

  w.db.seed("grants", [
    // A grant that DOES carry `send`, spelled out rather than borrowed from
    // SUPERVISORY_GRANT_SCOPES. These tests are about the WALL — what it does
    // given a grant with `send` and without — not about what provision happens
    // to mint. Reusing the constant coupled the two, and narrowing the default
    // (it no longer carries `send`; reply-draft is tier 2, so the wall never
    // fires for it) broke a test that was never about the default at all.
    {
      id: "g_emily",
      tenant_id: TENANT,
      grantee_account_id: ERIC,
      target_account_id: EMILY,
      scopes: JSON.stringify(["read", "draft", "send"]),
      created_by: "provision:supervisory",
      created_at: 1,
    },
    // A supervisory grant an operator NARROWED: decide, but never send as it.
    {
      id: "g_cj",
      tenant_id: TENANT,
      grantee_account_id: ERIC,
      target_account_id: CJ,
      scopes: JSON.stringify(["read", "draft"]),
      created_by: "admin",
      created_at: 1,
    },
    // Watch-only.
    {
      id: "g_allen",
      tenant_id: TENANT,
      grantee_account_id: ERIC,
      target_account_id: ALLEN,
      scopes: JSON.stringify(["read"]),
      created_by: "admin",
      created_at: 1,
    },
    // THE CROSS-TENANT CONTROL: a real, live, whole-account supervisory grant
    // — inside the OTHER tenant. Without this row the isolation test passes
    // trivially (no grant, nothing to leak); with it, the test actually bites.
    {
      id: "g_otto",
      tenant_id: OTHER_TENANT,
      grantee_account_id: NEIGHBOUR,
      target_account_id: OTTO,
      scopes: JSON.stringify(SUPERVISORY_GRANT_SCOPES),
      created_by: "provision:supervisory",
      created_at: 1,
    },
  ]);

  seedProposal(w, { account: ERIC, id: "inv_eric", binding: "self-note" });
  seedProposal(w, { account: EMILY, id: "inv_emily", binding: "editor-emily" });
  seedProposal(w, { account: CJ, id: "inv_cj", binding: "cj" });
  seedProposal(w, { account: ALLEN, id: "inv_allen", binding: "allen-analyst" });
  seedProposal(w, { account: UNGRANTED, id: "inv_quiet", binding: "quiet" });
  seedProposal(w, { account: OTTO, id: "inv_otto", binding: "otto" });

  // Re-resolved on EVERY call, exactly as a request does — which is what makes
  // revocation propagate with no restart.
  const resolve = async () => {
    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve — fixture bug");
    return principal;
  };
  const call = async <T = Record<string, unknown>>(method: string, args: Record<string, unknown>): Promise<T> => {
    const ctx: RequestContext = { env: w.env, principal: await resolve() };
    return registry.get(method)!(args, ctx) as Promise<T>;
  };

  /** The client's fan-out: every reachable account's queue, merged. */
  const queue = async (): Promise<Record<string, unknown>[]> => {
    const principal = await resolve();
    const rows: Record<string, unknown>[] = [];
    for (const account of principal.accounts) {
      const res = await call<GetResult>("ActionProposal/get", { accountId: account.accountId });
      rows.push(...res.list);
    }
    return rows;
  };

  return { w, call, queue, resolve, minted };
}

// ---- the queue reaches the agent's account ---------------------------------

describe("the supervisory grant puts an agent's proposal in its owner's queue", () => {
  it("a freshly provisioned agent's proposal is in the queue with NO manual grant", async () => {
    const h = await harness();
    const rows = await h.queue();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("inv_emily");
    // …beside the human's own, in ONE queue (that is the point).
    expect(ids).toContain("inv_eric");
  });

  it("each row says WHICH agent and WHICH account it came from", async () => {
    const h = await harness();
    const rows = await h.queue();
    const emily = rows.find((r) => r.id === "inv_emily")!;
    const allen = rows.find((r) => r.id === "inv_allen")!;
    // Emily's ask must be tellable from Allen's — the queue is useless without
    // it. `agent` is the binding name (projected from the invocation), and
    // `accountId` is the row's own account, not the request's.
    expect(emily.agent).toBe("editor-emily");
    expect(emily.accountId).toBe(EMILY);
    expect(allen.agent).toBe("allen-analyst");
    expect(allen.accountId).toBe(ALLEN);
  });

  it("an agent account that granted nothing stays invisible", async () => {
    const h = await harness();
    const rows = await h.queue();
    expect(rows.map((r) => r.id)).not.toContain("inv_quiet");
    await expect(h.call("ActionProposal/get", { accountId: UNGRANTED })).rejects.toMatchObject({
      type: "accountNotFound",
    });
  });

  it("`ActionProposal/query` on the granted account lists the pending row", async () => {
    const h = await harness();
    const res = await h.call<{ ids: string[] }>("ActionProposal/query", {
      accountId: EMILY,
      filter: { status: "pending" },
    });
    expect(res.ids).toEqual(["inv_emily"]);
  });
});

// ---- cross-tenant isolation ------------------------------------------------

describe("another tenant's proposals never appear", () => {
  it("a live supervisory grant INSIDE the other tenant does not reach across", async () => {
    const h = await harness();
    // The control: that grant is real and live.
    expect(h.w.db.count("grants", "id = ? AND revoked_at IS NULL", "g_otto")).toBe(1);

    const rows = await h.queue();
    expect(rows.map((r) => r.id)).not.toContain("inv_otto");
    const principal = await h.resolve();
    expect(principal.accounts.map((a) => a.accountId)).not.toContain(OTTO);
    expect(principal.accounts.every((a) => a.tenantId === TENANT)).toBe(true);

    // …and asking for it by name is refused, not merely omitted.
    await expect(h.call("ActionProposal/get", { accountId: OTTO })).rejects.toMatchObject({
      type: "accountNotFound",
    });
    await expect(
      h.call("ActionProposal/set", {
        accountId: OTTO,
        update: { inv_otto: { status: "approved" } },
      }),
    ).rejects.toMatchObject({ type: "accountNotFound" });
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        OTTO,
        "inv_otto",
      )[0]!.status,
    ).toBe("pending");
  });
});

// ---- revocation ------------------------------------------------------------

describe("revoking the supervisory grant empties the row out of the queue", () => {
  it("takes effect on the very next request — no restart, no cache", async () => {
    const h = await harness();
    expect((await h.queue()).map((r) => r.id)).toContain("inv_emily");

    h.w.db.query("UPDATE grants SET revoked_at = ? WHERE id = ?", Date.now(), "g_emily");

    const rows = await h.queue();
    expect(rows.map((r) => r.id)).not.toContain("inv_emily");
    // The human's own proposals are untouched — revocation is surgical.
    expect(rows.map((r) => r.id)).toContain("inv_eric");
    await expect(h.call("ActionProposal/get", { accountId: EMILY })).rejects.toMatchObject({
      type: "accountNotFound",
    });
  });
});

// ---- deciding across the grant ---------------------------------------------

describe("deciding a granted account's proposal", () => {
  it("approves a tier-1 through the grant, and the row lands approved", async () => {
    const h = await harness();
    const res = await h.call<SetResult>("ActionProposal/set", {
      accountId: EMILY,
      update: { inv_emily: { status: "approved" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(res.updated.inv_emily).toBeNull();
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        EMILY,
        "inv_emily",
      )[0]!.status,
    ).toBe("approved");
    // The cross-account decision is AUDITED — that is what makes supervision
    // visible rather than ambient.
    expect(h.w.db.count("grant_audit", "grant_id = ? AND account_id = ?", "g_emily", EMILY)).toBeGreaterThan(0);
  });

  it("declines and asks for information through the grant", async () => {
    const h = await harness();
    const declined = await h.call<SetResult>("ActionProposal/set", {
      accountId: CJ,
      update: { inv_cj: { status: "rejected", decision: { reason: "wrongAction" } } },
    });
    expect(declined.updated.inv_cj).toBeNull();

    const h2 = await harness();
    const asked = await h2.call<SetResult>("ActionProposal/set", {
      accountId: EMILY,
      update: { inv_emily: { status: "info-requested", question: "why this recipient?" } },
    });
    expect(asked.updated.inv_emily).toBeNull();
    expect(
      h2.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        EMILY,
        "inv_emily",
      )[0]!.status,
    ).toBe("info-requested");
  });

  it("REFUSES every decision on a watch-only grant, and changes nothing", async () => {
    const h = await harness();
    // Visible…
    const seen = await h.call<GetResult>("ActionProposal/get", { accountId: ALLEN });
    expect(seen.list.map((r) => r.id)).toEqual(["inv_allen"]);
    // …and undecidable: `ActionProposal/set` demands `draft`, which this grant
    // does not carry. The refusal is method-level (the base gate), so it is a
    // thrown MethodError rather than a per-object SetError.
    await expect(
      h.call("ActionProposal/set", {
        accountId: ALLEN,
        update: { inv_allen: { status: "approved" } },
      }),
    ).rejects.toMatchObject({ type: "forbidden" });
    expect(
      h.w.db.query<{ status: string }>(
        "SELECT status FROM agent_proposals WHERE account_id = ? AND id = ?",
        ALLEN,
        "inv_allen",
      )[0]!.status,
    ).toBe("pending");
  });

  it("the tier-3 wall follows the GRANT: `send` in it approves, its absence refuses", async () => {
    const reply = {
      kind: "reply-draft",
      tier: 3,
      payload: {
        to: "outside@example.com",
        self: "editor@bullmoose.cc",
        subject: "Re: the ask",
        text: "sending into the open thread",
        blobId: "b_reply",
      },
    };

    // The narrowed grant (read+draft): the row is decidable, but the
    // irreversible egress is not — the capability wall reads the grant, and the
    // human's own `mail` token cannot widen it.
    const narrow = await harness();
    seedProposal(narrow.w, { account: CJ, id: "inv_cj3", binding: "cj", ...reply });
    const refused = await narrow.call<SetResult>("ActionProposal/set", {
      accountId: CJ,
      update: { inv_cj3: { status: "approved" } },
    });
    expect(refused.updated).toEqual({});
    expect(refused.notUpdated.inv_cj3!.type).toBe("forbidden");
    expect(narrow.w.submit.calls).toEqual([]);

    // The full supervisory grant carries `send`, which is exactly why it is in
    // the set: a reply-draft is tier 3, and it is the kind that produced this
    // bug. Without `send` the owner would see the ask and be unable to answer.
    const full = await harness();
    seedProposal(full.w, { account: EMILY, id: "inv_emily3", binding: "editor-emily", ...reply });
    // The capability wall is not the only gate in front of an egress: the
    // outbound bound (s10 T1) resolves the binding's governing book at the
    // relay. Grant the reach this send needs, or the wall's PERMIT case would
    // be indistinguishable from the bound's refusal.
    governBinding(full.w, EMILY, "editor-emily", ["outside@example.com"]);
    const approved = await full.call<SetResult>("ActionProposal/set", {
      accountId: EMILY,
      update: { inv_emily3: { status: "approved" } },
    });
    expect(approved.notUpdated).toEqual({});
    expect(approved.updated.inv_emily3).toBeNull();
    expect(full.w.submit.calls.length).toBe(1);
  });
});

// ---- what the session tells the client -------------------------------------

describe("the session reports, per account, what may be decided there", () => {
  it("mayDecide / mayApproveIrreversible track the grant, not the token", async () => {
    const h = await harness();
    const session = buildSession("https://mail.test", await h.resolve());
    const agentCap = (accountId: string) =>
      session.accounts[accountId]!.accountCapabilities[AGENT_CAP] as Record<string, boolean>;

    // Owned: the token is `mail`, so both.
    expect(agentCap(ERIC)).toEqual({ mayDecide: true, mayApproveIrreversible: true });
    // Full supervisory grant: both — the queue can decide and can approve the
    // tier-3 reply-draft it exists for.
    expect(agentCap(EMILY)).toEqual({ mayDecide: true, mayApproveIrreversible: true });
    // Narrowed: decide yes, irreversible no — the client hides ONLY approve.
    expect(agentCap(CJ)).toEqual({ mayDecide: true, mayApproveIrreversible: false });
    // Watch-only: no verbs at all. This is the flag that keeps a UI from
    // offering a decide button the server would refuse.
    expect(agentCap(ALLEN)).toEqual({ mayDecide: false, mayApproveIrreversible: false });
    // Another tenant's account is not in the session at all.
    expect(session.accounts[OTTO]).toBeUndefined();
  });
});

// ---- the two halves, composed ----------------------------------------------

/**
 * THE LIVE BUG, reproduced end to end and fixed end to end: the provisioning
 * worker and the JMAP queue over ONE database, with nothing hand-seeded
 * between them.
 *
 * This is the test the other suites cannot be: `supervisoryGrant.test.ts`
 * proves provisioning writes a grant, and everything above proves the queue
 * reads one — but only running both against the same rows proves they are the
 * SAME grant. A column name, a scopes encoding or a grantee/target swap would
 * pass both halves separately and still leave Eric staring at "Nothing is
 * waiting on you."
 */
describe("provision → queue: an agent provisioned today is visible today", () => {
  it("mints the grant at create, and the owner's queue shows the first proposal", async () => {
    const w = fakeEnv();
    const kv = fakeKV();
    const registry = new MethodRegistry<RequestContext>();
    registerActionProposalMethods(registry);

    const provision: ProvisionEnv = {
      DB: w.env.DB,
      ROUTES: kv.ns,
      ADMIN_TOKEN: "admin-secret",
      SES_REGION: "us-east-1",
      INGEST_WORKER_NAME: "bullmoose-ingest",
      CF_API_TOKEN: "cf",
      SES_ACCESS_KEY_ID: "ak",
      SES_SECRET_ACCESS_KEY: "sk",
    };
    const admin = (path: string, body: Record<string, unknown>) =>
      provisionWorker.fetch(
        new Request(`https://provision.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        provision,
      );

    w.db.seed("tenants", [{ id: TENANT, name: "bullmoose", status: "active", created_at: 1 }]);
    w.db.seed("domains", [
      {
        domain: "bullmoose.cc",
        tenant_id: TENANT,
        status: "active",
        cf_zone_id: "z1",
        created_at: 1,
      },
    ]);

    // The household, exactly as an operator provisions it.
    const eric = (await (
      await admin("/accounts", {
        tenantId: TENANT,
        domain: "bullmoose.cc",
        localpart: "eric",
        displayName: "Eric",
      })
    ).json()) as { accountId: string };
    const editor = (await (
      await admin("/accounts", {
        tenantId: TENANT,
        domain: "bullmoose.cc",
        localpart: "editor",
        displayName: "EditorEmily",
      })
    ).json()) as { accountId: string };
    const binding = (await (
      await admin("/agent-bindings", { email: "editor@bullmoose.cc", name: "editor-emily" })
    ).json()) as { ok: boolean; supervision: { granted: boolean; grantId?: string } };
    expect(binding.supervision.granted).toBe(true);

    // Eric logs in — a REAL token on the principal provisioning created.
    const principalId = w.db.query<{ principal_id: string }>(
      "SELECT principal_id FROM accounts WHERE id = ?",
      eric.accountId,
    )[0]!.principal_id;
    const minted = await mintToken();
    w.db.seed("tokens", [
      {
        id: minted.id,
        principal_id: principalId,
        kind: "bearer",
        secret_hash: minted.secretHash,
        name: "eric-laptop",
        scopes: JSON.stringify(["mail"]),
        created_at: 1,
      },
    ]);

    // Emily's first proposal — the reply-draft that started all this.
    seedProposal(w, {
      account: editor.accountId,
      id: "inv_first",
      binding: "editor-emily",
      kind: "reply-draft",
      // TIER 2 — what `reply-draft` is actually emitted at
      // (services/agent/src/proposals.ts). This said `tier: 3`, and the
      // assertion below cited that as proof `send` "had to be" in the
      // supervisory grant. Circular: the test manufactured a tier no
      // producer emits, then used it to justify a scope.
      tier: 2,
      payload: {
        to: "grace@example.test",
        self: "editor@bullmoose.cc",
        subject: "Re: Project Elk",
        text: "Monday works.",
        blobId: "b_reply",
      },
    });

    const principal = await verifyBearer(w.env.DB, minted.token);
    if (!principal) throw new Error("token failed to resolve");
    const ctx: RequestContext = { env: w.env, principal };

    // The queue, as `/approvals` and `bullmoose approvals` now build it.
    const rows: Record<string, unknown>[] = [];
    for (const account of principal.accounts) {
      const res = (await registry.get("ActionProposal/get")!(
        { accountId: account.accountId },
        ctx,
      )) as unknown as GetResult;
      rows.push(...res.list);
    }
    const first = rows.find((r) => r.id === "inv_first");
    expect(first, "the freshly provisioned agent's proposal is NOT in its owner's queue").toBeTruthy();
    expect(first!.agent).toBe("editor-emily");
    expect(first!.accountId).toBe(editor.accountId);

    // And it is answerable with the DEFAULT supervisory grant — read+draft, no
    // `send`. That is the whole promise: a queue that shows you work AND lets
    // you answer it.
    const decided = (await registry.get("ActionProposal/set")!(
      { accountId: editor.accountId, update: { inv_first: { status: "approved" } } },
      ctx,
    )) as unknown as SetResult;
    expect(decided.notUpdated).toEqual({});

    // A tier-2 approve does NOT egress here — it parks in the hold tray, and
    // the cron commits it later, server-side. That is exactly why `send` is not
    // needed on the approver's token: nothing sends under it. This assertion
    // used to read `toBe(1)` against a synthetic tier-3 row, which is what made
    // the old `send` justification look sound.
    expect(w.submit.calls.length, "a tier-2 approve must not send inline").toBe(0);
    const held = w.db.query("SELECT status FROM agent_proposals WHERE id = ?", "inv_first") as
      | Array<{ status: string }>
      | undefined;
    expect(held?.[0]?.status, "an approved tier-2 proposal waits in the hold tray").toBe("held");

    // Revoked, it vanishes — the same grant, the same tombstone contract.
    w.db.query("UPDATE grants SET revoked_at = ? WHERE id = ?", Date.now(), binding.supervision.grantId!);
    const after = await verifyBearer(w.env.DB, minted.token);
    expect(after!.accounts.map((a) => a.accountId)).not.toContain(editor.accountId);
  });
});
