import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { registerAgentMethods } from "./agent";
import type { RequestContext } from "./common";

/**
 * s11 T2 — the eligibility gate is enforced IN the claim's guarded UPDATE,
 * through the REAL AgentInvocation/set method. These are the server-side
 * obligations of the T2-FIT-CONTRACT: a claim outside the claimant's
 * eligible set is refused by the WHERE clause itself, no matter how the
 * client self-filters; a refused row stays `pending` and the refusal is
 * distinguishable (`forbidden`) from a lost race (`notFound`).
 *
 * Time is real Date.now() — due_at values are seeded relative to it, far
 * outside any window jitter (minutes, not milliseconds).
 */

const ACCOUNT = "a_gate";
const TENANT = "t_bm";
const MIN = 60_000;
const HOUR = 60 * MIN;

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
}

function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerAgentMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "runtime@login.example",
      scopes: ["read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Gate" }],
    },
  };
  w.db.seed("agent_bindings", [{ id: "bind_g", account_id: ACCOUNT, name: "gated" }]);

  const seedInv = (id: string, extra: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_g",
        binding_name: "gated",
        status: "pending",
        email_id: "e_x",
        created_at: 1,
        ...extra,
      },
    ]);

  const claim = (invId: string, claimant?: Record<string, unknown>) =>
    registry.get("AgentInvocation/set")!(
      {
        accountId: ACCOUNT,
        ...(claimant !== undefined ? { claimant } : {}),
        update: { [invId]: { status: "running" } },
      },
      ctx,
    ) as unknown as Promise<SetResult>;

  const set = (args: Record<string, unknown>) =>
    registry.get("AgentInvocation/set")!({ accountId: ACCOUNT, ...args }, ctx) as unknown as Promise<SetResult>;

  const rowOf = (id: string) =>
    w.db.query<{ status: string; claimant_free: number | null; claimant_caps_json: string | null }>(
      `SELECT status, claimant_free, claimant_caps_json FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;

  return { w, claim, set, seedInv, rowOf };
}

/** A completed free claim `agoMs` ago — what makes a free runtime "live". */
function seedFreeClaim(w: FakeWorker, agoMs: number) {
  w.db.seed("agent_invocations", [
    {
      id: `inv_free_${agoMs}`,
      account_id: ACCOUNT,
      binding_id: "bind_g",
      binding_name: "gated",
      status: "done",
      created_at: 1,
      claimed_at: Date.now() - agoMs,
      done_at: Date.now() - agoMs + 1000,
      claimant_free: 1,
    },
  ]);
}

const FREE = { isFree: true };

describe("policy in the UPDATE: sit free, escalate near-due", () => {
  it("a paid claim (no claimant declared) on far-due work is REFUSED by the UPDATE, row stays pending", async () => {
    const h = harness();
    h.seedInv("inv_far", { due_at: Date.now() + 3 * HOUR }); // outside the 1h no-history window
    const res = await h.claim("inv_far");
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_far!.type).toBe("forbidden");
    expect(res.notUpdated.inv_far!.description).toMatch(/not eligible/);
    expect(h.rowOf("inv_far").status).toBe("pending");
  });

  it("a free claimant takes the same far-due work", async () => {
    const h = harness();
    h.seedInv("inv_far", { due_at: Date.now() + 3 * HOUR });
    const res = await h.claim("inv_far", FREE);
    expect(res.updated).toEqual({ inv_far: null });
    expect(h.rowOf("inv_far")).toMatchObject({ status: "running", claimant_free: 1 });
  });

  it("near-due (inside the window), the paid claimant becomes eligible", async () => {
    const h = harness();
    h.seedInv("inv_near", { due_at: Date.now() + 30 * MIN }); // inside 1h default window
    const res = await h.claim("inv_near");
    expect(res.updated).toEqual({ inv_near: null });
    expect(h.rowOf("inv_near")).toMatchObject({ status: "running", claimant_free: 0 });
  });

  it("the window is cost-scaled from this binding's history (3 × median duration)", async () => {
    const h = harness();
    // Median duration 10min → window 30min.
    for (const [i, d] of [8 * MIN, 10 * MIN, 12 * MIN].entries()) {
      h.w.db.seed("agent_invocations", [
        {
          id: `inv_hist_${i}`,
          account_id: ACCOUNT,
          binding_id: "bind_g",
          binding_name: "gated",
          status: "done",
          created_at: 1,
          claimed_at: 1_000,
          done_at: 1_000 + d,
        },
      ]);
    }
    h.seedInv("inv_40", { due_at: Date.now() + 40 * MIN }); // outside 30min
    h.seedInv("inv_20", { due_at: Date.now() + 20 * MIN }); // inside 30min
    expect((await h.claim("inv_40")).notUpdated.inv_40!.type).toBe("forbidden");
    expect((await h.claim("inv_20")).updated).toEqual({ inv_20: null });
  });
});

describe("the NULL-due rule: sit-free only while a free runtime is LIVE", () => {
  it("STRANDING GUARD: NULL-due work with no live free runtime is claimed by the paid cloud immediately", async () => {
    const h = harness();
    h.seedInv("inv_null"); // due_at NULL, no facets — and nobody free has ever claimed
    const res = await h.claim("inv_null");
    expect(res.updated).toEqual({ inv_null: null });
    expect(h.rowOf("inv_null").status).toBe("running");
  });

  it("a free claim 5 minutes ago makes NULL-due work free-only (paid refused)", async () => {
    const h = harness();
    seedFreeClaim(h.w, 5 * MIN);
    h.seedInv("inv_null");
    const res = await h.claim("inv_null");
    expect(res.notUpdated.inv_null!.type).toBe("forbidden");
    expect(h.rowOf("inv_null").status).toBe("pending");
    // …while the free claimant itself remains eligible.
    expect((await h.claim("inv_null", FREE)).updated).toEqual({ inv_null: null });
  });

  it("a free claim 20 minutes ago is ABSENCE (beyond the 15min horizon) — paid claims again", async () => {
    const h = harness();
    seedFreeClaim(h.w, 20 * MIN);
    h.seedInv("inv_null");
    expect((await h.claim("inv_null")).updated).toEqual({ inv_null: null });
  });
});

describe("the privacy pin: free/local only, ALWAYS", () => {
  it("pinned work is never claimable by paid — even past due, even with no free runtime anywhere", async () => {
    const h = harness();
    h.seedInv("inv_pin", { privacy: "pinned", due_at: Date.now() - 2 * HOUR }); // long overdue
    const res = await h.claim("inv_pin");
    expect(res.notUpdated.inv_pin!.type).toBe("forbidden");
    expect(h.rowOf("inv_pin").status).toBe("pending"); // pinned work MAY sit (alerting is T3)
  });

  it("a free claimant takes pinned work", async () => {
    const h = harness();
    h.seedInv("inv_pin", { privacy: "pinned", due_at: Date.now() - 2 * HOUR });
    expect((await h.claim("inv_pin", FREE)).updated).toEqual({ inv_pin: null });
  });
});

describe("budget exhaustion narrows to free, regardless of due-ness", () => {
  const CONFIG = JSON.stringify({ budgets: { spendPerMonth: 2_000_000 } }); // 2 USD in micro-USD

  function withSpend(h: ReturnType<typeof harness>, costMicros: number, doneAgoMs = 60_000) {
    h.w.db.query(`UPDATE agent_bindings SET config_json = ? WHERE id = 'bind_g'`, CONFIG);
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_spent",
        account_id: ACCOUNT,
        binding_id: "bind_g",
        binding_name: "gated",
        status: "done",
        created_at: 1,
        claimed_at: Date.now() - doneAgoMs - 1000,
        done_at: Date.now() - doneAgoMs,
        cost_micros: costMicros,
      },
    ]);
  }

  it("over budget: paid refused even on overdue work; free still claims", async () => {
    const h = harness();
    withSpend(h, 2_000_000);
    h.seedInv("inv_due", { due_at: Date.now() - HOUR });
    expect((await h.claim("inv_due")).notUpdated.inv_due!.type).toBe("forbidden");
    expect((await h.claim("inv_due", FREE)).updated).toEqual({ inv_due: null });
  });

  it("under budget: paid claims near-due work as usual", async () => {
    const h = harness();
    withSpend(h, 1_999_999);
    h.seedInv("inv_due", { due_at: Date.now() - HOUR });
    expect((await h.claim("inv_due")).updated).toEqual({ inv_due: null });
  });

  it("no spendPerMonth configured → no budget constraint however much was spent", async () => {
    const h = harness();
    h.w.db.seed("agent_invocations", [
      {
        id: "inv_spent",
        account_id: ACCOUNT,
        binding_id: "bind_g",
        binding_name: "gated",
        status: "done",
        created_at: 1,
        claimed_at: Date.now() - 2000,
        done_at: Date.now() - 1000,
        cost_micros: 99_000_000,
      },
    ]);
    h.seedInv("inv_due", { due_at: Date.now() - HOUR });
    expect((await h.claim("inv_due")).updated).toEqual({ inv_due: null });
  });
});

describe("fit in the UPDATE: requires_json vs the declared vector", () => {
  it("a vision requirement refuses a declared no-vision vector — even a FREE one", async () => {
    const h = harness();
    h.seedInv("inv_vis", { requires_json: JSON.stringify({ vision: true }) });
    const res = await h.claim("inv_vis", { isFree: true, capabilities: { vision: false } });
    expect(res.notUpdated.inv_vis!.type).toBe("forbidden");
    expect(h.rowOf("inv_vis").status).toBe("pending");
  });

  it("declaring the capability admits, and the vector is recorded on the claim", async () => {
    const h = harness();
    h.seedInv("inv_vis", { requires_json: JSON.stringify({ vision: true }) });
    const res = await h.claim("inv_vis", { isFree: true, capabilities: { vision: true } });
    expect(res.updated).toEqual({ inv_vis: null });
    const row = h.rowOf("inv_vis");
    expect(row.claimant_free).toBe(1);
    expect(JSON.parse(row.claimant_caps_json!)).toEqual({ vision: true });
  });

  it("contextTokens beyond the declared window refuses; within it admits", async () => {
    const h = harness();
    h.seedInv("inv_big", { requires_json: JSON.stringify({ contextTokens: 64_000 }) });
    h.seedInv("inv_small", { requires_json: JSON.stringify({ contextTokens: 16_000 }) });
    const caps = { isFree: true, capabilities: { contextTokens: 32_000 } };
    expect((await h.claim("inv_big", caps)).notUpdated.inv_big!.type).toBe("forbidden");
    expect((await h.claim("inv_small", caps)).updated).toEqual({ inv_small: null });
  });

  it("T2-FIT-CONTRACT: a claimant sending NO vector claims requires-stamped work exactly as today", async () => {
    const h = harness();
    h.seedInv("inv_vis", {
      requires_json: JSON.stringify({ vision: true, contextTokens: 900_000 }),
    });
    // No claimant argument at all — the pre-T2 claim shape.
    expect((await h.claim("inv_vis")).updated).toEqual({ inv_vis: null });
  });
});

describe("trust-but-audit: identity is recorded, not attested", () => {
  it("a paid claimant LYING isFree:true does claim far-due work — and the lie is on the record for the score", async () => {
    // Deliberate (documented in @bullmoose/scheduling): isFree is fit-shaped,
    // not authority-shaped. The gate trusts the declaration; the claim row
    // records it, and per-runtime history (a "free" claimant whose runs stamp
    // nonzero cost_micros) is what catches the liar — remote attestation is
    // out of scope. Nothing here widens AUTHORITY: the token still had to
    // pass requireAccount to claim at all.
    const h = harness();
    h.seedInv("inv_far", { due_at: Date.now() + 3 * HOUR });
    const res = await h.claim("inv_far", { isFree: true });
    expect(res.updated).toEqual({ inv_far: null });
    expect(h.rowOf("inv_far").claimant_free).toBe(1); // the audit trail
  });

  it("an undeclared claim records the conservative identity (paid, no vector)", async () => {
    const h = harness();
    h.seedInv("inv_plain");
    await h.claim("inv_plain");
    const row = h.rowOf("inv_plain");
    expect(row.claimant_free).toBe(0);
    expect(row.claimant_caps_json).toBeNull();
  });
});

describe("DefaultCase and the untouched edges", () => {
  it("an unfaceted row, no claimant argument → claimed exactly as today", async () => {
    const h = harness();
    h.seedInv("inv_plain");
    expect((await h.claim("inv_plain")).updated).toEqual({ inv_plain: null });
    expect(h.rowOf("inv_plain").status).toBe("running");
  });

  it("completion is NEVER gated: a running pinned row finishes without any declaration", async () => {
    const h = harness();
    h.seedInv("inv_pin", { status: "running", privacy: "pinned", claimed_at: 5 });
    const res = await h.set({ update: { inv_pin: { status: "done", result: { ok: 1 } } } });
    expect(res.updated).toEqual({ inv_pin: null });
    expect(h.rowOf("inv_pin").status).toBe("done");
  });

  it("a claim on a missing id is notFound (not forbidden)", async () => {
    const h = harness();
    const res = await h.claim("inv_ghost");
    expect(res.notUpdated.inv_ghost!.type).toBe("notFound");
  });

  it("a claim on an already-running row is notFound '(or already claimed)' — the race, not the gate", async () => {
    const h = harness();
    h.seedInv("inv_taken", { status: "running", claimed_at: 5 });
    const res = await h.claim("inv_taken");
    expect(res.notUpdated.inv_taken!.type).toBe("notFound");
    expect(res.notUpdated.inv_taken!.description).toMatch(/already claimed/);
  });
});

/**
 * THE 008 KILL SWITCH, THROUGH THE REAL CLAIM (s26 T2 follow-up).
 *
 * `AgentBinding/set` and the Settings→Agents page promise: "Disabling holds
 * queued work; nothing is cancelled." CREATE has honored the switch since 007
 * (the interlock above refuses a NEW invocation against a disabled binding),
 * but the rows a human queued BEFORE flipping it are what "holds queued work"
 * is actually about — and until the gate grew `bindingDisabledSql` they stayed
 * claimable through this method by any claimant that declared itself free,
 * which is exactly what the fleet host and the `bullmoose agent` CLI declare.
 * The switch stopped new work and let the backlog keep running.
 *
 * These are the server-side obligations of that sentence, at the one place the
 * pending→running transition happens.
 */
describe("the kill switch holds queued work (008, through AgentInvocation/set)", () => {
  /** A second binding on the same account, switched OFF, with a row already
   *  queued against it — the state a human creates by disabling a busy agent. */
  function disabledBinding(h: ReturnType<typeof harness>, invId: string, extra: Record<string, unknown> = {}) {
    h.w.db.seed("agent_bindings", [{ id: "bind_off", account_id: ACCOUNT, name: "switched-off", enabled: 0 }]);
    h.seedInv(invId, { binding_id: "bind_off", binding_name: "switched-off", ...extra });
  }

  it("a FREE claimant cannot take a disabled binding's queued row", async () => {
    const h = harness();
    disabledBinding(h, "inv_off");
    const res = await h.claim("inv_off", FREE);
    expect(res.updated).toEqual({});
    expect(res.notUpdated.inv_off!.type).toBe("forbidden");
    expect(h.rowOf("inv_off").status).toBe("pending");
  });

  it("neither can the paid cloud, on work that is already overdue", async () => {
    const h = harness();
    disabledBinding(h, "inv_off", { due_at: Date.now() - 2 * HOUR });
    expect((await h.claim("inv_off")).notUpdated.inv_off!.type).toBe("forbidden");
    expect(h.rowOf("inv_off").status).toBe("pending");
  });

  it("HELD, not cancelled: re-enabling resumes the SAME row, no requeue", async () => {
    const h = harness();
    disabledBinding(h, "inv_off");
    expect((await h.claim("inv_off", FREE)).notUpdated.inv_off!.type).toBe("forbidden");
    h.w.db.query(`UPDATE agent_bindings SET enabled = 1 WHERE id = 'bind_off'`);
    expect((await h.claim("inv_off", FREE)).updated).toEqual({ inv_off: null });
    expect(h.rowOf("inv_off").status).toBe("running");
  });

  it("the switch is per-binding: an enabled binding's work on the same account is untouched", async () => {
    const h = harness();
    disabledBinding(h, "inv_off");
    h.seedInv("inv_on");
    expect((await h.claim("inv_off", FREE)).notUpdated.inv_off!.type).toBe("forbidden");
    expect((await h.claim("inv_on", FREE)).updated).toEqual({ inv_on: null });
  });

  it("completion is still never gated — a run in flight when the switch flips still finishes", async () => {
    // The promise is that nothing is CANCELLED. A runtime that legitimately
    // claimed before the flip owns that invocation and must be able to record
    // what happened; failing its write would lose work the human never asked
    // to lose.
    const h = harness();
    disabledBinding(h, "inv_mid", { status: "running", claimed_at: 5 });
    const res = await h.set({ update: { inv_mid: { status: "done", result: { ok: 1 } } } });
    expect(res.updated).toEqual({ inv_mid: null });
    expect(h.rowOf("inv_mid").status).toBe("done");
  });
});
