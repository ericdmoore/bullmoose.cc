import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { proposeRepetitionOffers, REPETITION_OFFER_CAP, REPETITION_THRESHOLD } from "./repetition.js";
import type { Env } from "./models.js";

// s31 rung 3b — the offer must be EARNED (threshold, window, fresh sender),
// HONEST (held-not-filed language; the engine cannot file), SUPPRESSED by
// any prior ask or rule (a decline is a lesson; re-offering unlearns it),
// and NEVER the grant (a sweep-born row is pending, whoever holds rung 3).

const ACCOUNT = "t_bm__a_rep";
const SENDER = "blast@deals.example";

function world() {
  const w = fakeEnv();
  w.db.seed("agent_bindings", [
    {
      id: "bind_bouncer",
      account_id: ACCOUNT,
      name: "bouncer",
      enabled: 1,
      config_json: JSON.stringify({ pipeline: "bouncer", ruleAutoApply: true }), // rung 3 GRANTED — and must not matter
    },
  ]);
  w.db.seed("mailboxes", [
    { id: "mb_arch", account_id: ACCOUNT, name: "Archive", role: "archive", sort_order: 0 },
    { id: "mb_inbox", account_id: ACCOUNT, name: "Inbox", role: "inbox", sort_order: 0 },
  ]);
  return w;
}

function seedArchived(w: ReturnType<typeof world>, n: number, sender = SENDER, mailbox = "mb_arch") {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `e_${sender.split("@")[0]}_${i}`;
    w.db.seed("emails", [
      {
        id,
        account_id: ACCOUNT,
        blob_id: "b",
        thread_id: `t_${id}`,
        subject: `promo ${i}`,
        from_json: JSON.stringify([{ name: "Deals", email: sender }]),
        preview: "buy now",
        size: 10,
        received_at: now - i * 60_000,
        has_attachment: 0,
      },
    ]);
    w.db.seed("email_mailboxes", [{ account_id: ACCOUNT, email_id: id, mailbox_id: mailbox }]);
  }
}

const proposals = (w: ReturnType<typeof world>) =>
  w.db.query<{ id: string; status: string; rationale: string; payload_json: string; decision_json: string | null }>(
    "SELECT id, status, rationale, payload_json, decision_json FROM agent_proposals WHERE account_id = ?",
    ACCOUNT,
  );

describe("the repetition detector earns its offers", () => {
  it("five archives in the window earn ONE honest, PENDING offer — grant or no grant", async () => {
    const w = world();
    seedArchived(w, REPETITION_THRESHOLD);
    const offered = await proposeRepetitionOffers(w.env as unknown as Env);
    expect(offered).toBe(1);
    const rows = proposals(w);
    expect(rows).toHaveLength(1);
    // NEVER the grant: the binding above HAS rung 3, and the sweep-born row
    // is still pending with nobody's decision on it — offers are questions.
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.decision_json).toBeNull();
    // Honest language: the engine holds, it cannot file — and the count is
    // the evidence that earned the question.
    expect(rows[0]!.rationale).toContain(`archived ${REPETITION_THRESHOLD} messages from ${SENDER}`);
    expect(rows[0]!.rationale).toContain("held at the boundary");
    expect(rows[0]!.rationale).not.toContain("file them into Archive");
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.offer).toMatchObject({ sender: SENDER, archived: REPETITION_THRESHOLD });
    expect(payload.rule.all[0].value).toBe(SENDER);
    // The carrier invocation exists and names the sweep, so the ledger's
    // provenance chain holds for an agent-initiated row too.
    const inv = w.db.query<{ context_json: string }>(
      "SELECT context_json FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      rows[0]!.id,
    );
    expect(inv[0]!.context_json).toContain("repetition-offer");
  });

  it("four archives earn silence; five in the INBOX earn silence", async () => {
    const under = world();
    seedArchived(under, REPETITION_THRESHOLD - 1);
    expect(await proposeRepetitionOffers(under.env as unknown as Env)).toBe(0);

    const inbox = world();
    seedArchived(inbox, REPETITION_THRESHOLD, SENDER, "mb_inbox");
    expect(await proposeRepetitionOffers(inbox.env as unknown as Env)).toBe(0);
  });

  it("any prior ask about the sender suppresses — a decline most of all", async () => {
    const w = world();
    seedArchived(w, REPETITION_THRESHOLD);
    w.db.seed("agent_proposals", [
      {
        id: "inv_old",
        account_id: ACCOUNT,
        kind: "sieve-rule",
        tier: 2,
        subject_json: "{}",
        payload_json: JSON.stringify({ rule: { all: [{ kind: "contains", field: "from", value: SENDER }] } }),
        rationale: "asked before",
        evidence_json: "[]",
        status: "rejected",
        created_at: 1,
      },
    ]);
    expect(await proposeRepetitionOffers(w.env as unknown as Env)).toBe(0);
  });

  it("a rulebook rule already naming the sender suppresses", async () => {
    const w = world();
    seedArchived(w, REPETITION_THRESHOLD);
    w.db.seed("sieve_rules", [
      {
        account_id: ACCOUNT,
        rules_json: JSON.stringify([
          { id: "r1", all: [{ kind: "contains", field: "from", value: SENDER }], action: "reject" },
        ]),
        updated_at: 1,
      },
    ]);
    expect(await proposeRepetitionOffers(w.env as unknown as Env)).toBe(0);
  });

  it("no bouncer binding, no offer — nothing would own the conversation", async () => {
    const w = world();
    w.db.query("DELETE FROM agent_bindings WHERE account_id = ?", ACCOUNT);
    seedArchived(w, REPETITION_THRESHOLD);
    expect(await proposeRepetitionOffers(w.env as unknown as Env)).toBe(0);
  });

  it("the per-sweep cap holds, and what it drops is LOGGED, never silent", async () => {
    const w = world();
    for (let i = 0; i < REPETITION_OFFER_CAP + 2; i++) {
      seedArchived(w, REPETITION_THRESHOLD, `sender${i}@spam${i}.example`);
    }
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => logs.push(String(m));
    try {
      expect(await proposeRepetitionOffers(w.env as unknown as Env)).toBe(REPETITION_OFFER_CAP);
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes("offer cap"))).toBe(true);
    // The dropped candidates are found again next sweep — after the first
    // three are decided, the suppression no longer hides the rest.
    expect(proposals(w)).toHaveLength(REPETITION_OFFER_CAP);
  });
});
