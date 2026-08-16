import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { sweepWatches } from "./watches";

// s20 T1 — the Watch engine. A star replaced by a contract: the sweep fires
// watches whose deadline has passed, produces a PROPOSAL (never a direct
// action), and — the property that makes it trustworthy — a `no-reply-from`
// watch EXPIRES CLEAN when the reply it was waiting for actually arrived, so
// arming one and being answered produces silence, not a spurious follow-up.

const ACCOUNT = "t_bm__a_eric";
const TENANT = "t_bm";
const OWNER = "eric@bullmoose.cc";

function world() {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, principalId: "p_eric", loginEmail: OWNER, displayName: "Eric" });
  return w;
}

function armWatch(
  w: ReturnType<typeof fakeEnv>,
  o: {
    id: string;
    condition_type: string;
    condition?: Record<string, unknown>;
    deadline_at: number;
    action_type: string;
    action?: Record<string, unknown>;
    source_ref?: string | null;
    created_at?: number;
  },
) {
  w.db.seed("watches", [
    {
      id: o.id,
      account_id: ACCOUNT,
      owner: OWNER,
      condition_type: o.condition_type,
      condition_json: JSON.stringify(o.condition ?? {}),
      deadline_at: o.deadline_at,
      action_type: o.action_type,
      action_json: JSON.stringify(o.action ?? {}),
      status: "armed",
      source_ref: o.source_ref ?? null,
      created_at: o.created_at ?? 1000,
    },
  ]);
}

const watchRow = (w: ReturnType<typeof fakeEnv>, id: string) =>
  w.db.query<{ status: string; proposal_id: string | null; fired_at: number | null }>(
    `SELECT status, proposal_id, fired_at FROM watches WHERE id = '${id}'`,
  )[0]!;

describe("sweepWatches — the deadline reminder", () => {
  it("fires a due 'deadline' watch: proposal minted, watch flipped to fired", async () => {
    const w = world();
    armWatch(w, { id: "w_1", condition_type: "deadline", deadline_at: 500, action_type: "notify" });
    await sweepWatches(w.env, 1_000);

    const watch = watchRow(w, "w_1");
    expect(watch.status).toBe("fired");
    expect(watch.proposal_id).toBeTruthy();
    // The proposal exists, is pending, and is keyed to the carrier invocation.
    const prop = w.db.query<{ kind: string; tier: number; status: string }>(
      `SELECT kind, tier, status FROM agent_proposals WHERE id = '${watch.proposal_id}'`,
    )[0]!;
    expect(prop.kind).toBe("watch-notify");
    expect(prop.tier).toBe(1); // an FYI is reversible
    expect(prop.status).toBe("pending");
    // The carrier invocation is done-on-arrival with zero cost — no model ran.
    const inv = w.db.query<{ status: string; cost_micros: number }>(
      `SELECT status, cost_micros FROM agent_invocations WHERE id = '${watch.proposal_id}'`,
    )[0]!;
    expect(inv.status).toBe("done");
    expect(inv.cost_micros).toBe(0);
  });

  it("leaves a watch whose deadline is still in the future", async () => {
    const w = world();
    armWatch(w, { id: "w_future", condition_type: "deadline", deadline_at: 5_000, action_type: "notify" });
    await sweepWatches(w.env, 1_000);
    expect(watchRow(w, "w_future").status).toBe("armed");
    expect(w.db.query(`SELECT id FROM agent_proposals`)).toEqual([]);
  });
});

describe("sweepWatches — no-reply-from: the one that must not cry wolf", () => {
  function seedInbound(w: ReturnType<typeof fakeEnv>, from: string, receivedAt: number, threadId = "t_x") {
    w.db.seed("emails", [
      {
        id: `e_${receivedAt}`,
        account_id: ACCOUNT,
        blob_id: "b",
        thread_id: threadId,
        message_id: `m${receivedAt}@x`,
        subject: "re",
        from_json: JSON.stringify([{ email: from }]),
        to_json: JSON.stringify([{ email: OWNER }]),
        preview: "hi",
        size: 2,
        received_at: receivedAt,
        has_attachment: 0,
      },
    ]);
  }

  it("FIRES a draft-followup when no reply arrived — the follow-up is tier-2 (agent-initiated egress)", async () => {
    const w = world();
    armWatch(w, {
      id: "w_nr",
      condition_type: "no-reply-from",
      condition: { sender: "sergio@example.com", threadId: "t_x" },
      deadline_at: 500,
      action_type: "draft-followup",
      action: { to: "sergio@example.com" },
      source_ref: "e_orig",
      created_at: 100,
    });
    await sweepWatches(w.env, 1_000);

    const watch = watchRow(w, "w_nr");
    expect(watch.status).toBe("fired");
    const prop = w.db.query<{ kind: string; tier: number; evidence_json: string; payload_json: string }>(
      `SELECT kind, tier, evidence_json, payload_json FROM agent_proposals WHERE id = '${watch.proposal_id}'`,
    )[0]!;
    expect(prop.kind).toBe("watch-followup");
    expect(prop.tier).toBe(2); // a send to a third party — the queue holds it
    // It cites the message the watch was set on.
    expect(JSON.parse(prop.evidence_json)).toEqual([
      { realm: "Email", objectId: "e_orig", note: "the message this watch was set on" },
    ]);
    // …and names who to follow up with.
    expect(JSON.parse(prop.payload_json).to).toBe("sergio@example.com");
  });

  it("EXPIRES CLEAN when the awaited reply already arrived — no proposal, no noise", async () => {
    const w = world();
    // Sergio replied at t=800, after the watch was armed at t=100.
    seedInbound(w, "sergio@example.com", 800, "t_x");
    armWatch(w, {
      id: "w_answered",
      condition_type: "no-reply-from",
      condition: { sender: "sergio@example.com", threadId: "t_x" },
      deadline_at: 500,
      action_type: "draft-followup",
      created_at: 100,
    });
    await sweepWatches(w.env, 1_000);

    expect(watchRow(w, "w_answered").status).toBe("expired");
    // The whole point: being answered produces SILENCE.
    expect(w.db.query(`SELECT id FROM agent_proposals`)).toEqual([]);
    expect(watchRow(w, "w_answered").proposal_id).toBeNull();
  });

  it("a reply on a DIFFERENT thread does not count — the watch still fires", async () => {
    const w = world();
    seedInbound(w, "sergio@example.com", 800, "t_other");
    armWatch(w, {
      id: "w_wrongthread",
      condition_type: "no-reply-from",
      condition: { sender: "sergio@example.com", threadId: "t_x" },
      deadline_at: 500,
      action_type: "draft-followup",
      created_at: 100,
    });
    await sweepWatches(w.env, 1_000);
    expect(watchRow(w, "w_wrongthread").status).toBe("fired");
  });

  it("a reply from someone ELSE does not satisfy it", async () => {
    const w = world();
    seedInbound(w, "mallory@example.com", 800, "t_x");
    armWatch(w, {
      id: "w_wrongsender",
      condition_type: "no-reply-from",
      condition: { sender: "sergio@example.com", threadId: "t_x" },
      deadline_at: 500,
      action_type: "draft-followup",
      created_at: 100,
    });
    await sweepWatches(w.env, 1_000);
    expect(watchRow(w, "w_wrongsender").status).toBe("fired");
  });
});

describe("sweepWatches — safety posture", () => {
  it("never double-fires: a second sweep finds the watch already fired and does nothing", async () => {
    const w = world();
    armWatch(w, { id: "w_once", condition_type: "deadline", deadline_at: 500, action_type: "notify" });
    await sweepWatches(w.env, 1_000);
    await sweepWatches(w.env, 2_000);
    // Exactly one proposal, ever.
    expect(w.db.query(`SELECT id FROM agent_proposals`)).toHaveLength(1);
  });

  it("expires an unknown condition rather than firing it — the safe default", async () => {
    const w = world();
    armWatch(w, { id: "w_future_kind", condition_type: "shipment-late", deadline_at: 500, action_type: "notify" });
    await sweepWatches(w.env, 1_000);
    expect(watchRow(w, "w_future_kind").status).toBe("expired");
    expect(w.db.query(`SELECT id FROM agent_proposals`)).toEqual([]);
  });

  it("degrades to a no-op on a shard with no watches table — never crashes the cron", async () => {
    const w = world();
    w.db.query(`DROP TABLE IF EXISTS watches`);
    await expect(sweepWatches(w.env, 1_000)).resolves.toBeUndefined();
  });

  it("the proposal reaches the changelog, so push sees a fired watch", async () => {
    const w = world();
    armWatch(w, { id: "w_changes", condition_type: "deadline", deadline_at: 500, action_type: "notify" });
    await sweepWatches(w.env, 1_000);
    const pid = watchRow(w, "w_changes").proposal_id!;
    const changes = await w.accountDo.changes(ACCOUNT, "ActionProposal", "0");
    expect(changes.created).toContain(pid);
  });
});
