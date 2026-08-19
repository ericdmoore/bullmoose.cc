import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

/**
 * s26 T3 — BACKFILL, the cursor's missing half. The queue-as-cursor answers
 * forward progress; `POST /agent-bindings/{id}/backfill` mints the historical
 * half: PENDING invocations over the account's archive, newest-first, NULL-due
 * (sit-free), idempotent per (binding, email), and bounded below by the
 * HISTORY FLOOR (devPlan rule 1: `historyFloor ?? createdAt` — a new agent
 * never reprocesses old news by default).
 *
 * `POST /agent-bindings/{id}/floor-request` is rule 1's approval: moving the
 * floor BACK is an act needing a human, so it mints a tier-1 proposal
 * (carrier-invocation pattern) whose approve effect — the jmap side, proved in
 * actionProposalFloor.test.ts — writes `config_json.historyFloor`.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "family.test";
const TENANT = "t_fam";
const NOW = Date.now();
const DAY = 86_400_000;

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  call: (path: string, body: Record<string, unknown>) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Family", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z1", created_at: 1 }]);
  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  };
  const call = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://provision.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { db, kv, call };
}

/** A human account + its extract binding, with a DETERMINISTIC floor: the
 * provision stamp is Date.now(), so tests that reason about windows overwrite
 * the floor keys to fixed instants. Returns the ids. */
async function seedExtractor(
  h: Harness,
  floor: { createdAt?: number; historyFloor?: number } | null = { createdAt: NOW - 10 * DAY },
): Promise<{ accountId: string; bindingId: string }> {
  const acc = await h.call("/accounts", { tenantId: TENANT, domain: DOMAIN, localpart: "dad", displayName: "dad" });
  expect(acc.status).toBe(200);
  const res = await h.call("/extractor", { email: `dad@${DOMAIN}` });
  expect(res.status).toBe(200);
  const row = h.db.query<{ id: string; account_id: string; config_json: string }>(
    `SELECT id, account_id, config_json FROM agent_bindings WHERE name = 'extractor'`,
  )[0]!;
  if (floor !== null) {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    delete cfg.createdAt;
    delete cfg.historyFloor;
    h.db.query(`UPDATE agent_bindings SET config_json = ? WHERE id = ?`, JSON.stringify({ ...cfg, ...floor }), row.id);
  }
  return { accountId: row.account_id, bindingId: row.id };
}

function seedEmail(h: Harness, accountId: string, id: string, receivedAt: number): void {
  h.db.seed("emails", [
    { id, account_id: accountId, blob_id: `b_${id}`, thread_id: `t_${id}`, size: 1, received_at: receivedAt },
  ]);
}

const invocations = (h: Harness, bindingId: string) =>
  h.db.query<{
    id: string;
    email_id: string | null;
    status: string;
    due_at: number | null;
    context_json: string;
    privacy: string | null;
  }>(
    `SELECT id, email_id, status, due_at, context_json, privacy FROM agent_invocations
     WHERE binding_id = ? AND status = 'pending'`,
    bindingId,
  );

interface BackfillResult {
  ok?: boolean;
  minted?: number;
  skipped?: number;
  floorClamped?: boolean;
  floorMs?: number | null;
  floorSource?: string | null;
  windowStartMs?: number;
  capped?: boolean;
  budgetMicros?: number | null;
  error?: string;
}

describe("POST /agent-bindings/{id}/backfill — the floor and the clamp", () => {
  it("defaults the floor to the binding's birth: older mail is not minted, and the clamp is reported", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h); // createdAt = NOW − 10d
    seedEmail(h, accountId, "e_ancient", NOW - 30 * DAY); // behind the floor
    seedEmail(h, accountId, "e_mid", NOW - 5 * DAY);
    seedEmail(h, accountId, "e_recent", NOW - 1 * DAY);

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as BackfillResult;
    // The default 90-day window reaches behind the 10-day-old birth → clamped.
    expect(body).toMatchObject({ ok: true, minted: 2, skipped: 0, floorClamped: true, floorSource: "createdAt" });
    expect(body.windowStartMs).toBe(NOW - 10 * DAY);

    const rows = invocations(h, bindingId);
    expect(rows.map((r) => r.email_id).sort()).toEqual(["e_mid", "e_recent"]);
  });

  it("mints NULL-due pending rows (sit-free: never-urgent for the paid drain, free for a homelab claimant)", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_1", NOW - 2 * DAY);

    await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    const rows = invocations(h, bindingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.due_at).toBeNull(); // NULL = no deadline = never-urgent, NOT "due at epoch"
    expect(JSON.parse(rows[0]!.context_json)).toMatchObject({ emailId: "e_1", threadId: "t_e_1", backfill: true });
  });

  it("an approved historyFloor wins over createdAt", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h, {
      createdAt: NOW - 10 * DAY,
      historyFloor: NOW - 40 * DAY,
    });
    seedEmail(h, accountId, "e_deep", NOW - 30 * DAY); // behind the birth, but above the approved floor

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    const body = (await res.json()) as BackfillResult;
    expect(body).toMatchObject({ minted: 1, floorSource: "historyFloor" });
    expect(body.windowStartMs).toBe(NOW - 40 * DAY);
  });

  it("an explicit sinceDays crossing the floor is refused with 409 pointing at floor-request — nothing minted", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h); // floor NOW − 10d
    seedEmail(h, accountId, "e_old", NOW - 20 * DAY);
    seedEmail(h, accountId, "e_new", NOW - 1 * DAY);

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, { sinceDays: 30 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as BackfillResult;
    expect(body.error).toContain("floor-request");
    expect(body.floorMs).toBe(NOW - 10 * DAY);
    // Fail-closed: the refused ask minted NOTHING, not even the in-window part.
    expect(invocations(h, bindingId)).toHaveLength(0);
  });

  it("an explicit sinceDays inside the floor narrows the window without a clamp", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h, { createdAt: NOW - 40 * DAY });
    seedEmail(h, accountId, "e_older", NOW - 30 * DAY);
    seedEmail(h, accountId, "e_newer", NOW - 2 * DAY);

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, { sinceDays: 7 });
    const body = (await res.json()) as BackfillResult;
    expect(body).toMatchObject({ minted: 1, floorClamped: false });
    expect(invocations(h, bindingId).map((r) => r.email_id)).toEqual(["e_newer"]);
  });

  it("a binding with NO floor at all (pre-s26) is refused with guidance, never guessed", async () => {
    const h = harness();
    const { bindingId } = await seedExtractor(h, null);
    // Strip the stamp entirely — the pre-s26 shape.
    h.db.query(`UPDATE agent_bindings SET config_json = '{}' WHERE id = ?`, bindingId);

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as BackfillResult;
    expect(body.error).toContain("floor-request");
    expect(body.floorMs).toBeNull();
  });
});

describe("POST /agent-bindings/{id}/backfill — idempotence, order, budget", () => {
  it("is idempotent per (binding, email): live-delivered work is skipped, and a re-run mints nothing", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_live", NOW - 3 * DAY);
    seedEmail(h, accountId, "e_a", NOW - 2 * DAY);
    seedEmail(h, accountId, "e_b", NOW - 1 * DAY);
    // e_live already has an invocation — ingest enqueued it at delivery.
    h.db.seed("agent_invocations", [
      {
        id: "inv_live",
        account_id: accountId,
        binding_id: bindingId,
        binding_name: "extractor",
        status: "done",
        email_id: "e_live",
        created_at: NOW - 3 * DAY,
      },
    ]);

    const first = (await (await h.call(`/agent-bindings/${bindingId}/backfill`, {})).json()) as BackfillResult;
    expect(first).toMatchObject({ minted: 2, skipped: 1 });

    const second = (await (await h.call(`/agent-bindings/${bindingId}/backfill`, {})).json()) as BackfillResult;
    expect(second).toMatchObject({ minted: 0, skipped: 3 });
    // Still exactly one invocation per (binding, email).
    expect(h.db.count("agent_invocations", "binding_id = ?", bindingId)).toBe(3);
  });

  it("mints NEWEST-FIRST — the order the cap slices, so the newest slice always lands", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_old", NOW - 6 * DAY);
    seedEmail(h, accountId, "e_mid", NOW - 4 * DAY);
    seedEmail(h, accountId, "e_new", NOW - 2 * DAY);

    await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    // The mint order IS the recorded write order (fakeD1 keeps attempts in
    // sequence); email_id is the 5th bind of the guarded INSERT.
    const mintWrites = h.db.writes.filter(
      (w) => w.sql.includes("INSERT INTO agent_invocations") && w.sql.includes("'pending'"),
    );
    expect(mintWrites.map((w) => w.args[4])).toEqual(["e_new", "e_mid", "e_old"]);
  });

  it("budgetMicros is the ENVELOPE: echoed in the response and stamped into each row's context, where the claim gate reads it", async () => {
    // Enforcement itself lives in the claim gate (backfillEnvelopeSql /
    // backfillEnvelopeExhaustedSql — claimGateAgreement.test.ts's envelope
    // table); this verb's whole duty is stamping the number where the gate
    // looks, so THAT is what is pinned here.
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_1", NOW - 1 * DAY);

    const res = (await (
      await h.call(`/agent-bindings/${bindingId}/backfill`, { budgetMicros: 500_000 })
    ).json()) as BackfillResult;
    expect(res.budgetMicros).toBe(500_000);
    const ctx = JSON.parse(invocations(h, bindingId)[0]!.context_json) as Record<string, unknown>;
    expect(ctx.backfillBudgetMicros).toBe(500_000);
  });

  it("no budgetMicros reads back null — 'no envelope named', never a $0 envelope", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_1", NOW - 1 * DAY);

    const res = (await (await h.call(`/agent-bindings/${bindingId}/backfill`, {})).json()) as BackfillResult;
    expect(res.budgetMicros).toBeNull();
    const ctx = JSON.parse(invocations(h, bindingId)[0]!.context_json) as Record<string, unknown>;
    expect("backfillBudgetMicros" in ctx).toBe(false);
  });

  it("the binding's privacy floor rides on minted rows — pinned archives never widen to the paid cloud", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    const cfg = JSON.parse(
      h.db.query<{ config_json: string }>(`SELECT config_json FROM agent_bindings WHERE id = ?`, bindingId)[0]!
        .config_json,
    ) as Record<string, unknown>;
    h.db.query(
      `UPDATE agent_bindings SET config_json = ? WHERE id = ?`,
      JSON.stringify({ ...cfg, privacyFloor: "pinned" }),
      bindingId,
    );
    seedEmail(h, accountId, "e_1", NOW - 1 * DAY);

    await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    expect(invocations(h, bindingId)[0]!.privacy).toBe("pinned");
  });

  it("refuses a disabled binding — minted rows would pile up as the invisible backlog", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h);
    seedEmail(h, accountId, "e_1", NOW - 1 * DAY);
    await h.call(`/agent-bindings/${bindingId}/disable`, {});

    const res = await h.call(`/agent-bindings/${bindingId}/backfill`, {});
    expect(res.status).toBe(409);
    expect(invocations(h, bindingId)).toHaveLength(0);
  });
});

describe("POST /agent-bindings/{id}/floor-request — rule 1's approval", () => {
  it("mints a tier-1 pending proposal on a done, cost-0 carrier invocation", async () => {
    const h = harness();
    const { accountId, bindingId } = await seedExtractor(h); // floor NOW − 10d
    const to = NOW - 100 * DAY;

    const res = await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: to });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; proposalId: string; minted: boolean };
    expect(body).toMatchObject({ ok: true, minted: true });

    const prop = h.db.query<{ kind: string; tier: number; status: string; payload_json: string; rationale: string }>(
      `SELECT kind, tier, status, payload_json, rationale FROM agent_proposals WHERE id = ?`,
      body.proposalId,
    )[0]!;
    expect(prop).toMatchObject({ kind: "floor-request", tier: 1, status: "pending" });
    expect(JSON.parse(prop.payload_json)).toMatchObject({
      bindingId,
      bindingName: "extractor",
      toEpochMs: to,
      currentFloorMs: NOW - 10 * DAY,
      floorSource: "createdAt",
    });
    expect(prop.rationale).toContain("asks to read mail back to");

    // The carrier: done on arrival, cost 0 (an honest zero — no model ran).
    const carrier = h.db.query<{ status: string; cost_micros: number | null; account_id: string }>(
      `SELECT status, cost_micros, account_id FROM agent_invocations WHERE id = ?`,
      body.proposalId,
    )[0]!;
    expect(carrier).toMatchObject({ status: "done", cost_micros: 0, account_id: accountId });
  });

  it("is idempotent for the same pending ask, and refuses a conflicting one", async () => {
    const h = harness();
    const { bindingId } = await seedExtractor(h);
    const to = NOW - 100 * DAY;

    const first = (await (await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: to })).json()) as {
      proposalId: string;
    };
    const again = await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: to });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { proposalId: string; minted: boolean };
    expect(againBody).toMatchObject({ proposalId: first.proposalId, minted: false });
    expect(h.db.count("agent_proposals", "kind = 'floor-request'")).toBe(1);

    const conflicting = await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: to - DAY });
    expect(conflicting.status).toBe(409);
    expect(h.db.count("agent_proposals", "kind = 'floor-request'")).toBe(1);
  });

  it("refuses an ask that is not behind the floor, a future instant, and a missing one", async () => {
    const h = harness();
    const { bindingId } = await seedExtractor(h); // floor NOW − 10d

    expect((await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: NOW - 1 * DAY })).status).toBe(400);
    expect((await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: NOW + 1 * DAY })).status).toBe(400);
    expect((await h.call(`/agent-bindings/${bindingId}/floor-request`, {})).status).toBe(400);
    expect(h.db.count("agent_proposals", "kind = 'floor-request'")).toBe(0);
  });

  it("a floor-less (pre-s26) binding may ESTABLISH its floor — currentFloorMs is an honest null", async () => {
    const h = harness();
    const { bindingId } = await seedExtractor(h, null);
    h.db.query(`UPDATE agent_bindings SET config_json = '{}' WHERE id = ?`, bindingId);

    const res = await h.call(`/agent-bindings/${bindingId}/floor-request`, { toEpochMs: NOW - 30 * DAY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposalId: string };
    const payload = JSON.parse(
      h.db.query<{ payload_json: string }>(`SELECT payload_json FROM agent_proposals WHERE id = ?`, body.proposalId)[0]!
        .payload_json,
    ) as Record<string, unknown>;
    expect(payload.currentFloorMs).toBeNull(); // unknown ≠ 0 — the epoch is a real instant
  });
});
