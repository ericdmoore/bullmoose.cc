import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerActionProposalMethods } from "./actionProposal";
import type { RequestContext } from "./common";

/**
 * s20 wave 6 — the SCHEDULE verb applies, end to end, through the real method.
 *
 * #202 deferred `schedule` in one sentence: *"there is no `create-event` apply
 * case and no proposal-shaped path into `CalendarEvent`, so shipping the
 * button would mean shipping a kind whose approval has nowhere to land."* This
 * file is the proof that the sentence is no longer true — every assertion
 * below is driven from `ActionProposal/set { status: "approved" }` all the way
 * to the `calendar_events` row it writes, or to the in-place refusal that
 * leaves the tray moving.
 *
 * The two properties the whole verb hangs on, tested rather than promised:
 *
 *   1. an approved hold is a HOLD — `tentative`, `freeBusyStatus: "free"`,
 *      every participant `scheduleAgent: "none"` with no `sendTo`. Nobody is
 *      invited, nothing egresses, the calendar does not claim you are busy.
 *   2. a hold with no time REFUSES IN PLACE. The agent will not invent a time;
 *      the approval says so, the row stays `pending` and editable, and the
 *      human's own `editedPayload` is what lands. That is the #196-safe shape,
 *      not a wedge.
 */

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const APPROVER = "eric@login.example";
const OWNER = "eric@bullmoose.cc";

interface SetResult {
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string; properties?: string[] }>;
}

/** A webmail session carries `calendar` (webmail/src/lib/app/oauth.ts
 *  SESSION_SCOPES); `scopes` is a parameter here so the one test that cares
 *  can hand over a mail-only token instead. */
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
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  const set = (args: Record<string, unknown>) => call<SetResult>("ActionProposal/set", args);
  return { w, ctx, call, set };
}

/** The invocation + proposal `runScheduleVerb` mints (services/agent
 *  mailVerbs.ts) — a template run is genuinely free, hence `cost_micros: 0`
 *  with a NULL provider. */
function seedHold(h: ReturnType<typeof harness>, id: string, payload: Record<string, unknown>) {
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
      kind: "verb-schedule",
      tier: 1,
      subject_json: JSON.stringify({ realm: "Email", objectId: "e_orig" }),
      payload_json: JSON.stringify(payload),
      rationale: "you asked me to find a time",
      evidence_json: JSON.stringify([{ realm: "Email", objectId: "e_orig" }]),
      status: "pending",
      created_at: 1,
    },
  ]);
}

function seedIdentity(h: ReturnType<typeof harness>) {
  h.w.db.seed("identities", [
    {
      id: "identity_1",
      account_id: ACCOUNT,
      email: OWNER,
      name: "Eric",
      text_signature: "",
      html_signature: "",
      may_delete: 0,
    },
  ]);
}

const TIMED = {
  verb: "schedule",
  title: "Board quote call",
  start: "2026-08-20T15:00:00",
  duration: "PT45M",
  timeZone: "America/New_York",
  attendees: ["sergio@example.com", OWNER, "kim@x.test"],
  alternatives: ["2026-08-21T09:00:00"],
  description: "Sergio offered Thursday 3pm or Friday 9am.",
  composed: "model",
};

const eventRows = (h: ReturnType<typeof harness>) =>
  h.w.db.query<{
    id: string;
    calendar_id: string;
    uid: string;
    event_json: string;
    title: string | null;
    start_at: number | null;
    end_at: number | null;
    is_recurring: number;
  }>(`SELECT id, calendar_id, uid, event_json, title, start_at, end_at, is_recurring
        FROM calendar_events WHERE account_id = '${ACCOUNT}'`);

const proposalRow = (h: ReturnType<typeof harness>, id: string) =>
  h.w.db.query<{ status: string; decision_json: string | null }>(
    `SELECT status, decision_json FROM agent_proposals WHERE id = '${id}'`,
  )[0]!;

describe("verb-schedule — approve puts a HOLD on your own calendar", () => {
  it("applies immediately (tier 1) into the default calendar, with an undo handle", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_s1", TIMED);

    const res = await h.set({ update: { inv_s1: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    const prop = proposalRow(h, "inv_s1");
    expect(prop.status).toBe("approved");
    const decision = JSON.parse(prop.decision_json!);
    expect(decision.by).toBe(APPROVER);

    const rows = eventRows(h);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(decision.undo).toEqual({ action: "destroy-event", eventId: row.id });

    // The default calendar was created on first touch, and the row is in it.
    const calendars = h.w.db.query<{ id: string; is_default: number; ctag: number }>(
      `SELECT id, is_default, ctag FROM calendars WHERE account_id = '${ACCOUNT}'`,
    );
    expect(calendars).toHaveLength(1);
    expect(calendars[0]!.is_default).toBe(1);
    expect(row.calendar_id).toBe(calendars[0]!.id);
    // CalDAV's sync token moved: an approval that skipped the bump would leave
    // an Apple Calendar client believing nothing had changed.
    expect(calendars[0]!.ctag).toBeGreaterThan(0);

    // The indexed span `buildEventRow` derives — the SAME function
    // `CalendarEvent/set` runs, so 15:00 New York is 19:00 UTC in August and
    // the 45-minute duration lands on `end_at`.
    expect(row.title).toBe("Board quote call");
    expect(row.start_at).toBe(Date.parse("2026-08-20T19:00:00Z"));
    expect(row.end_at).toBe(Date.parse("2026-08-20T19:45:00Z"));
    expect(row.is_recurring).toBe(0);
    expect(row.uid).toMatch(/^urn:uuid:/);

    // Nothing egressed. A hold is not a mail.
    expect(h.w.submit.calls).toEqual([]);
  });

  it("is a HOLD, not a booking: tentative, not-busy, and nobody is invited", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_s2", TIMED);
    await h.set({ update: { inv_s2: { status: "approved" } } });

    const event = JSON.parse(eventRows(h)[0]!.event_json) as Record<string, unknown>;
    expect(event["@type"]).toBe("Event");
    // Nobody has agreed to this yet, and a proposed slot does not get to say
    // you are busy on the strength of an unanswered email.
    expect(event.status).toBe("tentative");
    expect(event.freeBusyStatus).toBe("free");
    expect(event.start).toBe("2026-08-20T15:00:00");
    expect(event.duration).toBe("PT45M");
    expect(event.timeZone).toBe("America/New_York");

    const participants = event.participants as Record<string, Record<string, unknown>>;
    const addresses = Object.values(participants).map((p) => p.email);
    // The owner is dropped — you are not an attendee of your own hold, and
    // `needs-action` against your own address is a question addressed to
    // nobody.
    expect(addresses).toEqual(["sergio@example.com", "kim@x.test"]);
    for (const p of Object.values(participants)) {
      // THE load-bearing pair: no iTIP-deliverable address, and RFC 8984's
      // "no scheduling messages will be sent". The blob names who the hold is
      // with; no client can read it as an invitation to deliver.
      expect(p.sendTo).toBeUndefined();
      expect(p.scheduleAgent).toBe("none");
      expect(p.expectReply).toBe(false);
      expect(p.participationStatus).toBe("needs-action");
    }
  });

  it("the CalendarEvent changelog entry rides the SAME commit as the decision", async () => {
    const h = harness();
    seedIdentity(h);
    const before = await h.w.accountDo.state(ACCOUNT);
    seedHold(h, "inv_s3", TIMED);
    const res = await h.set({ update: { inv_s3: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});

    // A write invisible to `/changes` is invisible to push — the recurring bug
    // this file's header warns about. ONE commit carries the decision and the
    // calendar write together, so a client that syncs the new state sees both
    // or neither.
    expect(h.w.accountDo.commits).toHaveLength(1);
    const collections = h.w.accountDo.commits[0]!.entries.map((e) => e.collection).sort();
    expect(collections).toEqual(["ActionProposal", "Calendar", "CalendarEvent"]);
    const events = await h.w.accountDo.changes(ACCOUNT, "CalendarEvent", before);
    expect(events.created).toEqual([eventRows(h)[0]!.id]);
  });

  it("no identity row: the owner cannot be dropped, so everyone named is recorded", async () => {
    const h = harness();
    seedHold(h, "inv_s4", { ...TIMED, attendees: ["sergio@example.com"] });
    await h.set({ update: { inv_s4: { status: "approved" } } });
    const event = JSON.parse(eventRows(h)[0]!.event_json) as Record<string, unknown>;
    expect(Object.keys(event.participants as object)).toHaveLength(1);
  });

  it("a hold with nobody in it is still a hold", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_s5", { ...TIMED, attendees: [] });
    const res = await h.set({ update: { inv_s5: { status: "approved" } } });
    expect(res.notUpdated).toEqual({});
    const event = JSON.parse(eventRows(h)[0]!.event_json) as Record<string, unknown>;
    // Absent rather than an empty map: a blob says what is true, and "there is
    // a participants object with no participants in it" is not.
    expect(event.participants).toBeUndefined();
  });
});

describe("the timeless hold — the refusal that is a feature", () => {
  it("a null start refuses IN PLACE, names the field, and leaves the row pending", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_t1", {
      verb: "schedule",
      title: "Board quote call",
      start: null,
      duration: "PT30M",
      timeZone: "Etc/UTC",
      attendees: ["sergio@example.com"],
      composed: "template",
    });

    const res = await h.set({ update: { inv_t1: { status: "approved" } } });
    expect(res.notUpdated["inv_t1"]!.type).toBe("invalidProperties");
    expect(res.notUpdated["inv_t1"]!.description).toContain("would not invent one");
    // The wedge test. Nothing was written, no status moved, and the row is
    // still there to be edited or declined.
    expect(eventRows(h)).toEqual([]);
    expect(proposalRow(h, "inv_t1").status).toBe("pending");
  });

  it("the human's EDITED start is what lands — the timeless hold becomes a hold", async () => {
    const h = harness();
    seedIdentity(h);
    const agents = {
      verb: "schedule",
      title: "Board quote call",
      start: null,
      duration: "PT30M",
      timeZone: "Etc/UTC",
      attendees: ["sergio@example.com"],
      composed: "template",
    };
    seedHold(h, "inv_t2", agents);

    const res = await h.set({
      update: {
        inv_t2: {
          status: "approved",
          editedPayload: { ...agents, start: "2026-09-01T10:00:00", timeZone: "Europe/Lisbon" },
        },
      },
    });
    expect(res.notUpdated).toEqual({});

    const row = eventRows(h)[0]!;
    expect(row.start_at).toBe(Date.parse("2026-09-01T09:00:00Z")); // Lisbon is UTC+1 in September
    // The agent's original is retained beside the human's version — the diff
    // is the highest-signal feedback the system collects (s07 §T4).
    const kept = h.w.db.query<{ payload_json: string; edited_payload_json: string }>(
      `SELECT payload_json, edited_payload_json FROM agent_proposals WHERE id = 'inv_t2'`,
    )[0]!;
    expect(JSON.parse(kept.payload_json).start).toBeNull();
    expect(JSON.parse(kept.edited_payload_json).start).toBe("2026-09-01T10:00:00");
  });

  it("declining a timeless hold is an ordinary decline — the taxonomy is untouched", async () => {
    const h = harness();
    seedHold(h, "inv_t3", { verb: "schedule", title: "x", start: null, attendees: [] });
    const res = await h.set({
      update: { inv_t3: { status: "rejected", decision: { reason: "wrongAction", note: "not a meeting" } } },
    });
    expect(res.notUpdated).toEqual({});
    expect(JSON.parse(proposalRow(h, "inv_t3").decision_json!).reason).toBe("wrongAction");
    expect(eventRows(h)).toEqual([]);
  });
});

describe("the other refusals are loud and cannot wedge either", () => {
  it("a start the calendar cannot read fails in place, naming it", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_r1", { ...TIMED, start: "next Thursday" });
    const res = await h.set({ update: { inv_r1: { status: "approved" } } });
    expect(res.notUpdated["inv_r1"]!.type).toBe("invalidProperties");
    expect(res.notUpdated["inv_r1"]!.description).toContain("start");
    expect(eventRows(h)).toEqual([]);
    expect(proposalRow(h, "inv_r1").status).toBe("pending");
  });

  it("a timezone no tzdb knows fails in place rather than throwing a serverFail", async () => {
    const h = harness();
    seedIdentity(h);
    seedHold(h, "inv_r2", { ...TIMED, timeZone: "Mars/Olympus_Mons" });
    const res = await h.set({ update: { inv_r2: { status: "approved" } } });
    expect(res.notUpdated["inv_r2"]!.type).toBe("invalidProperties");
    expect(eventRows(h)).toEqual([]);
    expect(proposalRow(h, "inv_r2").status).toBe("pending");
  });

  it("a mail-only token cannot write a calendar by approving something", async () => {
    // `ActionProposal/set` gates on ("draft", "mail"), and `mail` does NOT
    // cover `calendar` (auth-core hasScope, common/001). Approving a proposal
    // must not be a way to perform a write your own token could not perform
    // directly — so the case re-runs `CalendarEvent/set`'s own gate.
    const h = harness(["mail"]);
    seedIdentity(h);
    seedHold(h, "inv_r3", TIMED);
    const res = await h.set({ update: { inv_r3: { status: "approved" } } });
    expect(res.notUpdated["inv_r3"]!.type).toBe("forbidden");
    expect(res.notUpdated["inv_r3"]!.description).toContain("calendar");
    expect(eventRows(h)).toEqual([]);
    expect(proposalRow(h, "inv_r3").status).toBe("pending");
  });
});
