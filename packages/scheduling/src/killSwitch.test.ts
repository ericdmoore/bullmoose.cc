import { describe, expect, it } from "vitest";
import { fakeD1, type FakeD1 } from "@bullmoose/test-fakes";
import type { ClaimantIdentity } from "./mayClaim.js";
import { bindingDisabled, bindingDisabledSql, budgetMonthStartMs, claimGateBinds, claimGateSql } from "./claimGate.js";

/**
 * THE 008 KILL SWITCH, AT THE CLAIM (s26 T2 follow-up).
 *
 * `AgentBinding/set` gave a human a session-reachable off switch, and the
 * Settings→Agents copy promises exactly this much and no more:
 *
 *   "Disabling holds queued work; nothing is cancelled."
 *
 * Both halves are load-bearing, and this file holds the gate to both:
 *
 *   HELD       a pending row on a disabled binding is claimable by NOBODY —
 *              not the paid cloud drain, not a free homelab/fleet claimant
 *              coming through `AgentInvocation/set`. Before this term the
 *              refusal existed only at CREATE (agent.ts's interlock) and in
 *              the cloud drain's SELECT join, so the rows a human queued
 *              BEFORE flipping the switch stayed claimable by any free
 *              claimant — the switch stopped new work and left the backlog
 *              running, which is the gap this file closes.
 *   NOT CANCELLED
 *              the row is refused, not failed: it stays `pending`, keeps its
 *              facets, and re-enabling makes it claimable again with no
 *              requeue. Same idiom as the budget gate — exhaustion NARROWS
 *              the claimant set, it never fails the invocation.
 *
 * The kill switch sits OUTSIDE the `isFree` short-circuit, unlike every money
 * term. Money is a reason to prefer a free runtime; an off switch is not a
 * budget, and "your homelab may still run it for free" is not what a human
 * flipping a switch labelled Disable is agreeing to.
 */

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const FREE: ClaimantIdentity = { isFree: true, capabilities: null };
const PAID: ClaimantIdentity = { isFree: false, capabilities: null };

let n = 0;

/** One account + binding + pending invocation. `enabled: undefined` = let the
 *  schema default (1) apply, i.e. exactly how every other fixture seeds. */
function seedCase(db: FakeD1, opts: { enabled?: number; noBinding?: boolean }) {
  n += 1;
  const accountId = `a_ks_${n}`;
  const bindingId = `b_ks_${n}`;
  const invId = `inv_ks_${n}`;
  if (!opts.noBinding) {
    db.seed("agent_bindings", [
      {
        id: bindingId,
        account_id: accountId,
        name: `ks${n}`,
        config_json: "{}",
        ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
      },
    ]);
  }
  db.seed("agent_invocations", [
    {
      id: invId,
      account_id: accountId,
      binding_id: bindingId,
      binding_name: `ks${n}`,
      status: "pending",
      created_at: 1,
    },
  ]);
  return { accountId, bindingId, invId };
}

/** Would the gate let `claimant` take this row right now? */
async function claimable(
  db: FakeD1,
  seeded: { accountId: string; invId: string },
  claimant: ClaimantIdentity,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM agent_invocations
       WHERE account_id = ? AND id = ? AND status = 'pending'${claimGateSql("agent_invocations")}`,
    )
    .bind(
      seeded.accountId,
      seeded.invId,
      ...claimGateBinds({
        now: NOW,
        claimant,
        escalationWindowMs: 60 * 60_000,
        monthStartMs: budgetMonthStartMs(NOW),
      }),
    )
    .first<{ hit: number }>();
  return row !== null;
}

describe("the kill switch narrows the claimant set to nobody", () => {
  it("an ENABLED binding's pending row is claimable by both claimant kinds (the control)", async () => {
    const db = fakeD1();
    const seeded = seedCase(db, {});
    expect(await claimable(db, seeded, FREE), "free").toBe(true);
    expect(await claimable(db, seeded, PAID), "paid").toBe(true);
    db.close();
  });

  it("a DISABLED binding's already-queued pending row is claimable by NOBODY", async () => {
    const db = fakeD1();
    const seeded = seedCase(db, { enabled: 0 });
    // The FREE claimant is the one the gap was about: the fleet host and the
    // `bullmoose agent` CLI both declare `isFree: true`, so every money term
    // short-circuits past them. Only a term outside that branch stops them.
    expect(await claimable(db, seeded, FREE), "free").toBe(false);
    expect(await claimable(db, seeded, PAID), "paid").toBe(false);
    db.close();
  });

  it("HELD, not cancelled: the refused row is still pending and claims again once re-enabled", async () => {
    const db = fakeD1();
    const seeded = seedCase(db, { enabled: 0 });
    expect(await claimable(db, seeded, FREE)).toBe(false);

    // Nothing about the row changed — the gate refused it, it did not fail it.
    const [before] = db.query<{ status: string; claimed_at: number | null; done_at: number | null }>(
      `SELECT status, claimed_at, done_at FROM agent_invocations WHERE id = ?`,
      seeded.invId,
    );
    expect(before).toEqual({ status: "pending", claimed_at: null, done_at: null });

    db.query(`UPDATE agent_bindings SET enabled = 1 WHERE id = ?`, seeded.bindingId);
    // Re-enabling RESUMES it: no requeue, no new row, the same invocation.
    expect(await claimable(db, seeded, FREE), "free after re-enable").toBe(true);
    expect(await claimable(db, seeded, PAID), "paid after re-enable").toBe(true);
    db.close();
  });

  it("anything that is not exactly 1 reads as off — the switch fails closed", async () => {
    const db = fakeD1();
    for (const enabled of [0, -1, 2]) {
      const seeded = seedCase(db, { enabled });
      expect(await claimable(db, seeded, FREE), `enabled=${enabled}`).toBe(false);
    }
    db.close();
  });

  it("no binding row at all is NOT the kill switch — an orphan claims exactly as before", async () => {
    // DefaultCase, deliberately: the promise being kept here is about DISABLED
    // bindings. An invocation whose binding was destroyed is a different
    // question, already answered elsewhere (the drain's INNER JOIN skips it,
    // and auth-core refuses to resolve its invocation token), and silently
    // stranding it here would be a second, unasked-for behaviour change.
    const db = fakeD1();
    const seeded = seedCase(db, { noBinding: true });
    expect(await claimable(db, seeded, FREE)).toBe(true);
    expect(await claimable(db, seeded, PAID)).toBe(true);
    db.close();
  });

  it("the fragment costs no placeholder, so every caller's bind order is untouched", () => {
    expect(bindingDisabledSql("inv").includes("?")).toBe(false);
  });

  it("the pure twin agrees with the SQL on every reading, absence included", () => {
    expect(bindingDisabled(null)).toBe(false); // no row → EXISTS is false
    expect(bindingDisabled(undefined)).toBe(false);
    expect(bindingDisabled({ enabled: 1 })).toBe(false);
    expect(bindingDisabled({ enabled: 0 })).toBe(true);
    expect(bindingDisabled({ enabled: 2 })).toBe(true);
    // An unreadable switch reads as OFF — the opposite of the budget gate's
    // absence rule, and on purpose (see `bindingDisabledSql`).
    expect(bindingDisabled({ enabled: null })).toBe(true);
  });
});
