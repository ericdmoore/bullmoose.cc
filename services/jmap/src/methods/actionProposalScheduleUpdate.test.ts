import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s36 V2 — the MERGE landing. `verb-schedule-update` is the offer extract.ts
 * mints when a message re-states an event the calendar already holds with a
 * moment that moved. What approval writes is an UPDATE to that one named
 * event — never a second copy.
 *
 * The two properties the whole kind hangs on, tested rather than promised:
 *
 *   1. the diff is CHECKED AT APPLY TIME. If the calendar moved since the
 *      offer was minted — another device, CalDAV, an earlier approval — the
 *      `from` no longer matches and the case refuses in place. A wrong create
 *      is a duplicate the reader can see and delete; a wrong update
 *      overwrites something true with something older, which is the one
 *      write this design exists to never make.
 *   2. identity survives the move. Same row id, same uid, same calendar —
 *      a CalDAV client sees its event change, not vanish and reappear.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

function harness(scopes: string[] = ["mail", "calendar"]) {
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
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const set = (args: Record<string, unknown>) =>
    registry.get("ActionProposal/set")!({ accountId: ACCOUNT, ...args }, ctx) as unknown as Promise<SetResult>;
  return { w, set };
}

/** The hold already on the calendar — deliberately in a HOME timezone, not
 *  UTC, because the diff must stay in the event's own wall-clock frame. */
function seedEvent(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  h.w.db.seed("calendars", [
    { id: "cal_1", account_id: ACCOUNT, name: "Calendar", is_default: 1, ctag: 7, created_at: 1, updated_at: 1 },
  ]);
  const event = {
    "@type": "Event",
    uid: "urn:uuid:tourn",
    title: "U12G tournament",
    start: "2026-08-23T08:00:00",
    duration: "PT30M",
    timeZone: "America/Chicago",
    status: "confirmed",
    ...over,
  };
  h.w.db.seed("calendar_events", [
    {
      id: "ev_tourn",
      account_id: ACCOUNT,
      calendar_id: "cal_1",
      uid: "urn:uuid:tourn",
      event_json: JSON.stringify(event),
      title: String(event.title),
      start_at: Date.parse("2026-08-23T13:00:00Z"), // 08:00 Chicago in August
      end_at: Date.parse("2026-08-23T13:30:00Z"),
      is_recurring: 0,
      created_at: 1,
      updated_at: 1,
    },
  ]);
}

/** The offer extract.ts's reconcile step mints, carrier + proposal. */
function seedMove(h: ReturnType<typeof harness>, id: string, payload: Record<string, unknown>) {
  h.w.db.seed("agent_invocations", [
    {
      id,
      account_id: ACCOUNT,
      binding_id: "bind_x",
      binding_name: "extractor",
      status: "done",
      email_id: "e_orig",
      created_at: 1,
      claimed_at: 1,
      done_at: 1,
      provider: null,
      model: null,
      cost_micros: 0,
    },
  ]);
  h.w.db.seed("agent_proposals", [
    {
      id,
      account_id: ACCOUNT,
      kind: "verb-schedule-update",
      tier: 1,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify(payload),
      rationale: "the message moved the time",
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_orig" }]),
      status: "pending",
      created_at: 1,
    },
  ]);
}

const MOVE = {
  verb: "schedule-update",
  targetEventId: "ev_tourn",
  targetTitle: "U12G tournament",
  changes: { start: { from: "2026-08-23T08:00:00", to: "2026-08-23T07:30:00" } },
  composed: false,
};

const eventRow = (h: ReturnType<typeof harness>) =>
  h.w.db.query<{
    id: string;
    calendar_id: string;
    uid: string;
    event_json: string;
    start_at: number | null;
    end_at: number | null;
  }>(`SELECT id, calendar_id, uid, event_json, start_at, end_at FROM calendar_events WHERE account_id = '${ACCOUNT}'`);

const proposalRow = (h: ReturnType<typeof harness>, id: string) =>
  h.w.db.query<{ status: string; decision_json: string | null }>(
    `SELECT status, decision_json FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;

describe("verb-schedule-update — approve moves the ONE named hold", () => {
  it("applies the diff in the event's own wall-clock frame, identity intact", async () => {
    const h = harness();
    seedEvent(h);
    seedMove(h, "inv_m1", MOVE);

    const res = await h.set({ update: { inv_m1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    const rows = eventRow(h);
    expect(rows).toHaveLength(1); // an update, never a second copy
    const row = rows[0]!;
    // Identity survives: same row, same uid, same calendar.
    expect(row.id).toBe("ev_tourn");
    expect(row.uid).toBe("urn:uuid:tourn");
    expect(row.calendar_id).toBe("cal_1");

    const event = JSON.parse(row.event_json) as Record<string, unknown>;
    expect(event.start).toBe("2026-08-23T07:30:00");
    // The wall clock moved IN THE EVENT'S OWN TIMEZONE — 7:30 Chicago is
    // 12:30 UTC in August. An epoch-frame diff would have landed elsewhere.
    expect(row.start_at).toBe(Date.parse("2026-08-23T12:30:00Z"));
    expect(row.end_at).toBe(Date.parse("2026-08-23T13:00:00Z"));
    // What the update did NOT touch: the event keeps its own status — this
    // was the owner's confirmed event, not a hold to re-stamp tentative.
    expect(event.status).toBe("confirmed");
    expect(event.title).toBe("U12G tournament");

    // The undo is the precise inverse: put back the fields this moved.
    const decision = JSON.parse(proposalRow(h, "inv_m1").decision_json!);
    expect(decision.undo).toEqual({
      action: "restore-event-fields",
      eventId: "ev_tourn",
      fields: { start: "2026-08-23T08:00:00" },
    });

    // CalDAV's sync token moved.
    const ctag = h.w.db.query<{ ctag: number }>(`SELECT ctag FROM calendars WHERE id = 'cal_1'`)[0]!.ctag;
    expect(ctag).toBeGreaterThan(7);

    // Nothing egressed.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("a duration change rides the same diff and lands on end_at", async () => {
    const h = harness();
    seedEvent(h);
    seedMove(h, "inv_m2", {
      ...MOVE,
      changes: {
        start: { from: "2026-08-23T08:00:00", to: "2026-08-23T07:30:00" },
        duration: { from: "PT30M", to: "PT120M" },
      },
    });
    const res = await h.set({ update: { inv_m2: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    const row = eventRow(h)[0]!;
    expect(row.start_at).toBe(Date.parse("2026-08-23T12:30:00Z"));
    expect(row.end_at).toBe(Date.parse("2026-08-23T14:30:00Z"));
  });

  it("REFUSES when the calendar moved since the offer — never overwrite newer with older", async () => {
    const h = harness();
    // The event was already moved to 7:45 by another hand.
    seedEvent(h, { start: "2026-08-23T07:45:00" });
    seedMove(h, "inv_m3", MOVE); // offer still expects from=08:00

    const res = await h.set({ update: { inv_m3: { status: "approved" } } });
    const err = res.notUpdated.inv_m3!;
    expect(err.type).toBe("invalidProperties");
    expect(err.description).toContain("calendar moved");
    expect(err.description).toContain("07:45");

    // Refused IN PLACE: the row stays pending, the event stays where the
    // other hand put it.
    expect(proposalRow(h, "inv_m3").status).toBe("pending");
    const event = JSON.parse(eventRow(h)[0]!.event_json) as Record<string, unknown>;
    expect(event.start).toBe("2026-08-23T07:45:00");
  });

  it("refuses when the hold it names is gone — nothing to move, nothing invented", async () => {
    const h = harness();
    seedMove(h, "inv_m4", MOVE); // no calendar event at all
    const res = await h.set({ update: { inv_m4: { status: "approved" } } });
    const err = res.notUpdated.inv_m4!;
    expect(err.type).toBe("invalidProperties");
    expect(err.description).toContain("no longer on the calendar");
    expect(proposalRow(h, "inv_m4").status).toBe("pending");
    expect(eventRow(h)).toHaveLength(0);
  });

  it("the capability wall: a mail-only token cannot move a calendar by approving", async () => {
    const h = harness(["mail"]);
    seedEvent(h);
    seedMove(h, "inv_m5", MOVE);
    const res = await h.set({ update: { inv_m5: { status: "approved" } } });
    expect(res.notUpdated.inv_m5!.type).toBe("forbidden");
    // Nothing was written, and the row is still decidable by someone who may.
    const event = JSON.parse(eventRow(h)[0]!.event_json) as Record<string, unknown>;
    expect(event.start).toBe("2026-08-23T08:00:00");
    expect(proposalRow(h, "inv_m5").status).toBe("pending");
  });

  it("an empty diff is nothing to approve", async () => {
    const h = harness();
    seedEvent(h);
    seedMove(h, "inv_m6", { ...MOVE, changes: {} });
    const res = await h.set({ update: { inv_m6: { status: "approved" } } });
    expect(res.notUpdated.inv_m6!.type).toBe("invalidProperties");
    expect(res.notUpdated.inv_m6!.description).toContain("nothing to approve");
  });
});
