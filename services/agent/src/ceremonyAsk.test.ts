import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv, fakeSubmit } from "@bullmoose/test-fakes";
import { CEREMONY_TTL_MS, consumeCeremonyPass, requestCeremony, sweepCeremonyFailNotices } from "./ceremonyAsk.js";
import type { Env } from "./models.js";

// The agent-side contract: the ask is OPERATOR-GATED (OQ2 — an invented
// category refuses before a row exists), the link goes into the THREAD
// (the tier-2 asker; a compromised mailbox still cannot assert), the gate
// answers PASS|FAIL and nothing else, a PASS consumes exactly once, and a
// FAIL notifies the ENROLLED address exactly once.

const ACCOUNT = "t_bm__a_cer";
const TENANT = "t_bm";
const PRINCIPAL = "p_owner";
const ASKER = "alice@company.test";

function world() {
  const w = fakeEnv();
  const submit = fakeSubmit();
  (w.env as { SUBMIT?: unknown }).SUBMIT = submit.binding;
  (w.env as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN = "itk";
  w.db.seed("tenants", [{ id: TENANT, name: "bm", status: "active", created_at: 1 }]);
  w.db.seed("principals", [{ id: PRINCIPAL, tenant_id: TENANT, login_email: "owner@company.test", created_at: 1 }]);
  w.db.seed("accounts", [
    { id: ACCOUNT, tenant_id: TENANT, principal_id: PRINCIPAL, display_name: "HR", shard: "shard0", created_at: 1 },
  ]);
  // The governing book, with the asker in it (the outbound bound is REAL here).
  w.db.seed("address_books", [
    {
      id: "ab_gov",
      account_id: ACCOUNT,
      name: "employees",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: 1,
      updated_at: 1,
      write_policy: "governed",
    },
  ]);
  w.db.seed("contact_cards", [
    {
      id: "cc_alice",
      account_id: ACCOUNT,
      address_book_id: "ab_gov",
      uid: "u-alice",
      card_json: JSON.stringify({ uid: "u-alice", kind: "individual", emails: { e0: { address: ASKER } } }),
      created_at: 1,
      updated_at: 1,
    },
  ]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_hr",
      account_id: ACCOUNT,
      name: "hr",
      enabled: 1,
      recipients_book_id: "ab_gov",
      config_json: JSON.stringify({ pipeline: "reply", disclosureCategories: ["benefits.balance"] }),
    },
  ]);
  return { w, submit, env: w.env as unknown as Env, store: new Mailstore(w.env.DB, w.env.BLOBS) };
}

const JOB = { id: "inv_c1", account_id: ACCOUNT, tenant_id: TENANT, binding_id: "bind_hr", binding_name: "hr" };
const ASK = {
  category: "benefits.balance",
  description: "Approve: hr@company.test disclosing your 401(k) balance in reply to alice@company.test.",
  messageId: "<q1@company.test>",
  to: ASKER,
  selfAddress: "hr@company.test",
};

const rows = (w: ReturnType<typeof world>["w"]) =>
  w.db.query<{ id: string; status: string; secret_hash: string; category: string; consumed_at: number | null }>(
    "SELECT id, status, secret_hash, category, consumed_at FROM ceremonies WHERE account_id = ?",
    ACCOUNT,
  );

describe("requestCeremony — the ask", () => {
  it("an invented category refuses before a row exists (OQ2, enforced)", async () => {
    const { w, submit, env, store } = world();
    const out = await requestCeremony(env, store, JOB, { ...ASK, category: "salary.full-history" });
    expect("refused" in out && out.refused).toContain("no one reviewed");
    expect(rows(w)).toHaveLength(0);
    expect(submit.calls).toHaveLength(0);
  });

  it("a declared category replies into the thread with the link, then lands the row", async () => {
    const { w, submit, env, store } = world();
    const out = await requestCeremony(env, store, JOB, ASK);
    expect("ceremonyId" in out).toBe(true);
    // The reply went to the ASKER (the thread), through the real bound.
    expect(submit.calls).toHaveLength(1);
    expect(submit.calls[0]!.rcptTo).toEqual([ASKER]);
    // The mail carries the link; the ROW carries only the hash of it.
    const blobId = submit.bodies[0]!.blobId as string;
    const blob = await store.getBlob(TENANT, ACCOUNT, blobId);
    const raw = new TextDecoder().decode(await blob!.arrayBuffer());
    // The body travels base64 — decode it exactly as a receiving MUA would.
    const [, b64 = ""] = raw.split(/\r?\n\r?\n/);
    const mime = atob(b64.replace(/\s+/g, ""));
    const link = /https:\/\/auth\.bullmoose\.cc\/ceremony#([0-9a-f]+)/.exec(mime);
    expect(link).not.toBeNull();
    const stored = rows(w)[0]!;
    expect(stored.status).toBe("pending");
    expect(stored.secret_hash).not.toContain(link![1]!);
    expect(mime).toContain("doing nothing is a refusal");
  });

  it("the outbound bound is a wall, not advice: an asker outside the book refuses and no row lands", async () => {
    const { w, env, store } = world();
    await expect(requestCeremony(env, store, JOB, { ...ASK, to: "stranger@evil.test" })).rejects.toThrow(
      /not in the governing book/,
    );
    expect(rows(w)).toHaveLength(0);
  });
});

describe("consumeCeremonyPass — PASS|FAIL and nothing else", () => {
  async function seedCeremony(w: ReturnType<typeof world>["w"], over: Record<string, unknown> = {}) {
    w.db.seed("ceremonies", [
      {
        id: "cer_x",
        principal_id: PRINCIPAL,
        account_id: ACCOUNT,
        binding_id: "bind_hr",
        category: "benefits.balance",
        description: ASK.description,
        message_id: "<q1@company.test>",
        secret_hash: "h",
        status: "passed",
        created_at: Date.now(),
        expires_at: Date.now() + CEREMONY_TTL_MS,
        decided_at: Date.now(),
        ...over,
      },
    ]);
  }

  it("a passed, in-TTL, matching row passes EXACTLY once", async () => {
    const { w, env } = world();
    await seedCeremony(w);
    const q = {
      accountId: ACCOUNT,
      bindingId: "bind_hr",
      category: "benefits.balance",
      messageId: "<q1@company.test>",
    };
    const first = await consumeCeremonyPass(env, q);
    expect(first).toMatchObject({ pass: true, ceremonyId: "cer_x" });
    expect(rows(w)[0]!.consumed_at).not.toBeNull();
    expect(await consumeCeremonyPass(env, q)).toEqual({ pass: false }); // once means once
  });

  it("failed, expired, wrong-category and wrong-thread all answer the SAME bare fail", async () => {
    const { w, env } = world();
    const q = {
      accountId: ACCOUNT,
      bindingId: "bind_hr",
      category: "benefits.balance",
      messageId: "<q1@company.test>",
    };
    await seedCeremony(w, { id: "cer_f", status: "failed" });
    expect(await consumeCeremonyPass(env, q)).toEqual({ pass: false });
    await seedCeremony(w, { id: "cer_e", expires_at: Date.now() - 1 });
    expect(await consumeCeremonyPass(env, q)).toEqual({ pass: false });
    await seedCeremony(w, { id: "cer_c", category: "other.thing" });
    expect(await consumeCeremonyPass(env, q)).toEqual({ pass: false });
    await seedCeremony(w, { id: "cer_m", message_id: "<other@x>" });
    expect(await consumeCeremonyPass(env, q)).toEqual({ pass: false });
  });
});

describe("the OQ5 notice", () => {
  it("a failed ceremony lands ONE note in the enrolled inbox, and only one", async () => {
    const { w, env, store } = world();
    w.db.seed("ceremonies", [
      {
        id: "cer_n",
        principal_id: PRINCIPAL,
        account_id: ACCOUNT,
        binding_id: "bind_hr",
        category: "benefits.balance",
        description: ASK.description,
        secret_hash: "h",
        status: "failed",
        created_at: 1,
        expires_at: 2,
        decided_at: 3,
      },
    ]);
    expect(await sweepCeremonyFailNotices(env, store)).toBe(1);
    const inbox = w.db.query<{ subject: string; preview: string }>(
      "SELECT subject, preview FROM emails WHERE account_id = ?",
      ACCOUNT,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toContain("FAILED");
    expect(inbox[0]!.preview).toContain("401(k)");
    // Exactly once: the stamp survives the second sweep.
    expect(await sweepCeremonyFailNotices(env, store)).toBe(0);
    expect(w.db.query("SELECT id FROM emails WHERE account_id = ?", ACCOUNT)).toHaveLength(1);
  });
});
