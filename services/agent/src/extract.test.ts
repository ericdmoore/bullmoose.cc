import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { EmailRow } from "@bullmoose/mailstore";
import {
  EXTRACT_SYSTEM,
  hasExtractCue,
  parseExtraction,
  parseScoutVerdict,
  runExtract,
  type ExtractJob,
  usableStart,
} from "./extract.js";

// s18 A2 — the extraction pass. A model reads a delivered message and writes
// commitment/decision/task Annotations. The bounds that keep it honest: a
// deterministic cue pre-filter spends NO model call on a cue-less message; the
// model's output is parsed defensively (garbage → nothing, never a crash and
// never an invented claim); and the run is idempotent per message.

const ACCOUNT = "t_bm__a_eric";
const job: ExtractJob = { id: "inv_x", account_id: ACCOUNT, binding_name: "scribe" };

const CFG = {
  pipeline: "extract" as const,
  modelAliases: { extract: [{ provider: "workers-ai" as const, model: "@cf/x" }] },
  defaultModel: "extract",
};

function world(modelResponse: string) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@bullmoose.cc", displayName: "Eric" });
  // The fake Workers AI answers with our chosen text (bouncerClassify pattern).
  const run = vi.fn(async () => ({
    response: modelResponse,
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }));
  (w.env as { AI?: unknown }).AI = { run };
  return { w, run };
}

function inbound(o: { id?: string; subject?: string; body?: string }): EmailRow {
  return {
    // Overridable so a test can deliver a SECOND, different message — without
    // it the per-message idempotence guard skips the second run, and a test
    // meant to exercise the moment-level dupe check passes for the wrong
    // reason entirely.
    id: o.id ?? "e_msg",
    from: [{ email: "bob@example.com" }],
    subject: o.subject ?? "",
    preview: (o.body ?? "").slice(0, 256),
  } as unknown as EmailRow;
}

const annotations = (w: ReturnType<typeof fakeEnv>) =>
  w.db.query<{
    author_kind: string;
    author: string;
    class: string;
    body: string;
    confidence: number | null;
    status: string;
    anchor_json: string;
    source_ref: string;
  }>(`SELECT * FROM annotations`);

describe("parseExtraction — defensive by construction", () => {
  it("pulls well-formed items and clamps confidence", () => {
    const items = parseExtraction('[{"class":"commitment","body":"I\'ll send the calc Friday","confidence":1.4}]');
    expect(items).toEqual([{ class: "commitment", body: "I'll send the calc Friday", confidence: 1 }]);
  });
  it("finds the array inside a chatty/fenced answer", () => {
    const items = parseExtraction('Sure!\n```json\n[{"class":"task","body":"review the PR"}]\n```');
    expect(items).toEqual([{ class: "task", body: "review the PR", confidence: null }]);
  });
  it("returns [] for garbage, a non-array, and unknown classes / empty bodies", () => {
    expect(parseExtraction("no json here")).toEqual([]);
    expect(parseExtraction('{"class":"task"}')).toEqual([]);
    expect(parseExtraction('[{"class":"vibe","body":"x"},{"class":"task","body":"  "}]')).toEqual([]);
  });
});

describe("runExtract — writes Annotations from a delivered message", () => {
  it("extracts, anchors to the message, authors by the binding, and stamps cost", async () => {
    const { w, run } = world(
      '[{"class":"commitment","body":"You promised Bob the load calc by Friday","confidence":0.8}]',
    );
    const done = vi.fn(async () => {});
    await runExtract(w.env, job, CFG, inbound({ subject: "the calc", body: "I'll send it by Friday" }), {}, done);

    const rows = annotations(w);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.author_kind).toBe("agent");
    expect(a.author).toBe("scribe");
    expect(a.class).toBe("commitment");
    expect(a.body).toBe("You promised Bob the load calc by Friday");
    expect(a.confidence).toBe(0.8);
    expect(a.status).toBe("open");
    expect(JSON.parse(a.anchor_json)).toEqual({ realm: "Email", objectId: "e_msg" });
    expect(a.source_ref).toBe("e_msg");

    expect(run).toHaveBeenCalledOnce();
    // Cost was stamped and passed to finish (workers-ai → genuinely free, 0).
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ costMicros: 0 }),
    );
  });

  it("PRE-FILTER: List-Unsubscribe bulk mail spends NO model call, even with cue-shaped copy", async () => {
    const { w, run } = world("[]");
    const done = vi.fn(async () => {});
    await runExtract(
      w.env,
      job,
      CFG,
      inbound({ subject: "SALE ends soon", body: "Order by Friday and save 20%!" }),
      { headers: [{ key: "List-Unsubscribe", value: "<mailto:u@x>" }] },
      done,
    );
    expect(run).not.toHaveBeenCalled();
    expect(annotations(w)).toEqual([]);
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ note: expect.stringContaining("List-Unsubscribe") }),
    );
  });

  it("PRE-FILTER: a cue-less message spends NO model call and writes nothing", async () => {
    const { w, run } = world("[]");
    const done = vi.fn(async () => {});
    await runExtract(w.env, job, CFG, inbound({ subject: "hello", body: "just saying hi, nice weather" }), {}, done);

    expect(run).not.toHaveBeenCalled(); // the whole point — no spend on a newsletter
    expect(annotations(w)).toEqual([]);
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ note: expect.stringContaining("no extraction cues") }),
    );
  });

  it("finds nothing when the model returns [] — a model call, but no invented claim", async () => {
    const { w, run } = world("[]");
    const done = vi.fn(async () => {});
    await runExtract(w.env, job, CFG, inbound({ subject: "re: plans", body: "let's circle back" }), {}, done);
    expect(run).toHaveBeenCalledOnce();
    expect(annotations(w)).toEqual([]);
  });

  it("records the assignment arm; exploreRate 0 is always exploit", async () => {
    const { w } = world('[{"class":"task","body":"review the PR","confidence":0.7}]');
    const done = vi.fn(async () => {});
    await runExtract(w.env, job, CFG, inbound({ subject: "PR", body: "you'll want to review this" }), {}, done);
    expect(done).toHaveBeenCalledWith("done", expect.objectContaining({ arm: "exploit" }), expect.anything());
  });

  it("with a menu + exploreRate, some invocation ids explore the alternate (deterministically)", async () => {
    const cfg = {
      ...CFG,
      modelAliases: {
        extract: [
          { provider: "workers-ai" as const, model: "@cf/x" },
          { provider: "workers-ai" as const, model: "@cf/alt" },
        ],
      },
      frontier: { exploreRate: 1 }, // force exploration for the test
    };
    const { w, run } = world('[{"class":"task","body":"x","confidence":0.5}]');
    const done = vi.fn(async () => {});
    await runExtract(
      w.env,
      { ...job, id: "inv_explore_me" },
      cfg,
      inbound({ subject: "q", body: "I'll do it" }),
      {},
      done,
    );
    expect(done).toHaveBeenCalledWith("done", expect.objectContaining({ arm: "explore" }), expect.anything());
    // The alternate model actually ran (the fake AI records the model id it was given).
    expect(run.mock.calls.length).toBeGreaterThan(0);
  });

  it("is idempotent: a retry over an already-extracted message writes no duplicates", async () => {
    const { w } = world('[{"class":"task","body":"review the PR","confidence":0.7}]');
    const done = vi.fn(async () => {});
    const msg = inbound({ subject: "PR", body: "you'll want to review this" });
    await runExtract(w.env, job, CFG, msg, {}, done);
    await runExtract(w.env, job, CFG, msg, {}, done); // reaped-and-retried
    expect(annotations(w)).toHaveLength(1);
  });

  it("fails cleanly when the binding has no model menu", async () => {
    const { w } = world("[]");
    const done = vi.fn(async () => {});
    await runExtract(w.env, job, { pipeline: "extract" }, inbound({ body: "I'll send it Friday" }), {}, done);
    expect(done).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({ note: expect.stringContaining("model menu") }),
    );
  });
});

// ---- s26 T3 v2: scouts, then troops (backfill rows only) -------------------
//
// A backfill-minted row (context_json.backfill) with a FREE candidate
// (workers-ai) beside a paid one runs the cheap scout first: NO → done free,
// no paid call; YES → the PAID candidates take the extraction, with the
// scout's verdict riding the result. Live rows are character-for-character
// the pre-v2 path — no scout key, no reordered menu.

describe("parseScoutVerdict — one defensive line", () => {
  it("reads a leading YES/NO and keeps the why as the note", () => {
    expect(parseScoutVerdict("NO — routine newsletter, no commitments.")).toEqual({
      verdict: "no",
      note: "routine newsletter, no commitments.",
    });
    expect(parseScoutVerdict("YES - promises a load calc by Friday")).toEqual({
      verdict: "yes",
      note: "promises a load calc by Friday",
    });
  });
  it("tolerates chatty wrappers, casing, and quoting", () => {
    expect(parseScoutVerdict('"Yes" — there is a deadline in here').verdict).toBe("yes");
    expect(parseScoutVerdict("Answer: NO, nothing actionable").verdict).toBe("no");
  });
  it("an unparseable answer ESCALATES (yes) — unsure must not silently discard mail", () => {
    const v = parseScoutVerdict("hard to say, could go either way?");
    expect(v.verdict).toBe("yes");
    expect(v.note).toContain("unparseable");
  });
});

describe("runExtract — the scout branch", () => {
  const backfillJob: ExtractJob = {
    ...job,
    id: "inv_backfill",
    context_json: JSON.stringify({ emailId: "e_msg", backfill: true }),
  };
  // A menu with a free scout AND paid troops — the shape rule 3a needs.
  const MENU_CFG = {
    pipeline: "extract" as const,
    defaultModel: "extract",
    modelAliases: {
      extract: [
        { provider: "workers-ai" as const, model: "@cf/scout" },
        { provider: "mock" as const, model: "paid" },
      ],
    },
  };
  const cueful = () => inbound({ subject: "the calc", body: "I'll send it by Friday" });
  /** A `done` whose recorded calls keep their types, so a test can read the
   *  result object back without casting. */
  const doneFn = () => vi.fn(async (_s: "done" | "failed", _r: Record<string, unknown>, _c?: unknown) => {});

  it("scout says NO: done FREE — no paid call, verdict recorded, cost 0", async () => {
    const { w, run } = world("NO — routine notification, nothing promised.");
    const done = vi.fn(async () => {});
    await runExtract(w.env, backfillJob, MENU_CFG, cueful(), {}, done);

    expect(run).toHaveBeenCalledOnce(); // the scout, and ONLY the scout
    expect(annotations(w)).toEqual([]);
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({
        note: "scouted: nothing — no paid call",
        scout: { verdict: "no", note: "routine notification, nothing promised.", model: "workers-ai/@cf/scout" },
      }),
      // The scout's cost is the whole cost: workers-ai → known, genuinely free.
      expect.objectContaining({ costMicros: 0 }),
    );
  });

  it("scout says YES: the PAID candidate runs the extraction, scout note carried in the result", async () => {
    const { w, run } = world("YES — promises a load calc by Friday.");
    const done = vi.fn(async () => {});
    await runExtract(w.env, backfillJob, MENU_CFG, cueful(), {}, done);

    // The free model ran once (as the scout); the extraction went to the
    // PAID candidate — the mock provider needs no AI binding, so exactly one
    // AI.run call means the troops were not the free model.
    expect(run).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({
        model: "mock/paid",
        scout: expect.objectContaining({
          verdict: "yes",
          note: "promises a load calc by Friday.",
          model: "workers-ai/@cf/scout",
        }),
      }),
      expect.anything(),
    );
  });

  it("a LIVE row with the same menu is untouched: no scout call, no scout key", async () => {
    const { w, run } = world('[{"class":"task","body":"review the PR","confidence":0.7}]');
    const done = doneFn();
    await runExtract(
      w.env,
      { ...job, context_json: JSON.stringify({ emailId: "e_msg" }) },
      MENU_CFG,
      cueful(),
      {},
      done,
    );

    // One model call — the extraction itself (the free candidate ranks first
    // by price, exactly as before v2), and no scout in the result.
    expect(run).toHaveBeenCalledOnce();
    expect(annotations(w)).toHaveLength(1);
    const result = done.mock.calls[0]![1];
    expect(result.scout).toBeUndefined();
    expect(result.model).toBe("workers-ai/@cf/scout");
  });

  it("a backfill row with a FREE-ONLY menu takes the ordinary path (nobody to send as troops)", async () => {
    const { w, run } = world('[{"class":"task","body":"review the PR","confidence":0.7}]');
    const done = doneFn();
    await runExtract(w.env, backfillJob, CFG, cueful(), {}, done);
    expect(run).toHaveBeenCalledOnce(); // the extraction, not a scout
    const result = done.mock.calls[0]![1];
    expect(result.scout).toBeUndefined();
    expect(annotations(w)).toHaveLength(1);
  });

  it("a broken scout FAILS OPEN to the ordinary fallback chain — never a lost message", async () => {
    const w = fakeEnv();
    w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@bullmoose.cc", displayName: "Eric" });
    const run = vi.fn(async () => {
      throw new Error("AI runtime down");
    });
    (w.env as { AI?: unknown }).AI = { run };
    const done = doneFn();
    await runExtract(w.env, backfillJob, MENU_CFG, cueful(), {}, done);

    // The scout threw; the ordinary path then tried the free candidate (also
    // down) and fell through to the paid mock — the pre-v2 fallback semantics.
    expect(done).toHaveBeenCalledWith("done", expect.objectContaining({ model: "mock/paid" }), expect.anything());
    const result = done.mock.calls[0]![1];
    expect(result.scout).toBeUndefined();
  });
});

describe("the widened cue filter (s36 rung 1)", () => {
  // WIDE on purpose: the model is the filter, this only decides whether to pay
  // for one. A missed event costs the owner something; a needless call costs a
  // fraction of a cent, bounded by the binding's budget either way.

  it("40. still admits the commitment language it always did", () => {
    expect(hasExtractCue("I'll send the calc Friday")).toBe(true);
    expect(hasExtractCue("we decided to go with the Amalfi coast")).toBe(true);
  });

  it("41. admits times, dates and weekdays", () => {
    for (const t of ["arrive at 7:30 am", "kick-off 8am", "on 8/21", "Saturday", "Aug 21", "this weekend"]) {
      expect(hasExtractCue(t), t).toBe(true);
    }
  });

  it("42. admits the nouns that carry a time even without one", () => {
    for (const t of ["tournament details", "please RSVP", "our next practice", "the reservation"]) {
      expect(hasExtractCue(t), t).toBe(true);
    }
  });

  it("43. admits signature shapes — a phone number is the strongest tell", () => {
    expect(hasExtractCue("Call me on (312) 555-0147")).toBe(true);
    expect(hasExtractCue("Best regards,\nCoach Wallace")).toBe(true);
  });

  it("44. a message with none of it still costs nothing", () => {
    // The newsletter case, which is the reason the filter exists at all.
    expect(hasExtractCue("Your weekly digest of industry news and opinion.")).toBe(false);
    expect(hasExtractCue("Thanks for signing up. Click here to confirm.")).toBe(false);
  });

  it("45. admits the real tournament email — the message this was built for", () => {
    // Eric's Fwd: U12G White. It already tripped the OLD filter on "we will",
    // which is why widening was about what the MODEL looks for as much as what
    // the regex admits. This pins that it stays admitted.
    const real =
      "Fwd: U12G White - Tournament Details\nHello Team,\nBelow are the details for our tournament " +
      "this weekend. Please arrive 30 mins prior to Kick-off. Saturday 8:00 am, Sunday 7:30 am.";
    expect(hasExtractCue(real)).toBe(true);
  });
});

describe("the parser accepts what the prompt asks for", () => {
  // This drifted once, silently, in the worst way an allow-list can: the
  // prompt asked for `event` and `contact`, the model returned them, and the
  // parser dropped every one. Nothing errored and nothing logged — the pass
  // simply reported "nothing concrete" on messages full of dates. A parser
  // narrower than its own prompt is a feature that looks shipped and is not.
  it("50. keeps every class the prompt names", () => {
    const answer = JSON.stringify([
      { class: "commitment", body: "I'll send it Friday", confidence: 0.8 },
      { class: "decision", body: "we chose the Amalfi coast", confidence: 0.7 },
      { class: "task", body: "book the flights", confidence: 0.6 },
      { class: "event", body: "tournament Saturday", confidence: 0.9 },
      { class: "contact", body: "Coach Wallace, (312) 555-0147", confidence: 0.7 },
    ]);
    expect(parseExtraction(answer).map((i) => i.class)).toEqual(["commitment", "decision", "task", "event", "contact"]);
  });

  it("51. the prompt and the allow-list name the same set", () => {
    // The coupling itself, so the next class to be added cannot land in one
    // and not the other.
    for (const cls of ["commitment", "decision", "task", "event", "contact"]) {
      expect(EXTRACT_SYSTEM, `prompt must name ${cls}`).toContain(`"${cls}"`);
      expect(parseExtraction(JSON.stringify([{ class: cls, body: "x", confidence: 1 }])), cls).toHaveLength(1);
    }
  });

  it("52. still refuses a class neither of them names", () => {
    expect(parseExtraction(JSON.stringify([{ class: "invoice", body: "x", confidence: 1 }]))).toEqual([]);
  });
});

describe("usableStart — strict on purpose", () => {
  // The asymmetry that sets the strictness: a refused `start` costs an OFFER
  // and the item still lands as a note, so the reader sees the date and can
  // add it by hand. A WRONG `start` puts a wrong entry in their calendar, and
  // they may not find out until they miss the thing it was for.
  it("60. accepts an ISO local time to the minute", () => {
    expect(usableStart("2026-08-23T07:30:00")).toBe("2026-08-23T07:30:00");
    expect(usableStart("2026-08-23T07:30")).toBe("2026-08-23T07:30");
    expect(usableStart("2026-08-23T07:30:00Z")).toBe("2026-08-23T07:30:00Z");
    expect(usableStart(" 2026-08-23T07:30:00 ")).toBe("2026-08-23T07:30:00");
  });

  it("61. refuses a bare date — 'sometime Saturday' is not a hold", () => {
    expect(usableStart("2026-08-23")).toBeNull();
  });

  it("62. refuses prose, empty, and the wrong type", () => {
    for (const bad of ["Saturday morning", "next week", "", null, undefined, 42, {}]) {
      expect(usableStart(bad as unknown), String(bad)).toBeNull();
    }
  });

  it("63. refuses a date that parses to nothing real", () => {
    expect(usableStart("2026-13-45T99:99:00")).toBeNull();
  });
});

describe("event items carry their offer fields", () => {
  it("70. keeps start, title and duration on an event", () => {
    const [item] = parseExtraction(
      JSON.stringify([
        {
          class: "event",
          body: "tournament Saturday",
          confidence: 0.9,
          start: "2026-08-23T07:30:00",
          title: "U12G tournament",
          durationMinutes: 480,
        },
      ]),
    );
    expect(item).toMatchObject({ start: "2026-08-23T07:30:00", title: "U12G tournament", durationMinutes: 480 });
  });

  it("71. an event with an unusable start stays a note", () => {
    // Not dropped — the reader still sees "there is a tournament Saturday".
    // It simply does not become a one-click hold.
    const [item] = parseExtraction(
      JSON.stringify([{ class: "event", body: "tournament Saturday", confidence: 0.9, start: "Saturday" }]),
    );
    expect(item?.class).toBe("event");
    expect(item?.start).toBeUndefined();
  });

  it("72. offer fields never attach to a non-event", () => {
    const [item] = parseExtraction(
      JSON.stringify([{ class: "task", body: "book flights", confidence: 0.5, start: "2026-08-23T07:30:00" }]),
    );
    expect(item?.start).toBeUndefined();
  });

  it("73. duration is clamped to something a day can hold", () => {
    const mk = (m: number) =>
      parseExtraction(
        JSON.stringify([
          { class: "event", body: "x", confidence: 1, start: "2026-08-23T07:30:00", durationMinutes: m },
        ]),
      )[0]?.durationMinutes;
    expect(mk(99999)).toBe(24 * 60);
    expect(mk(1)).toBe(5);
  });
});

describe("a decision tombstones the offer", () => {
  // Eric, on the rung-3 draft: "once approved/disapproved that decision can be
  // noted and effectively tombstone the proposal from re-surfacing."
  //
  // The first version keyed the dupe check on `status = 'pending'`, which
  // would have re-offered a DECLINED date the moment a quoted reply arrived —
  // overriding an answer the reader had already given. That is worse than the
  // duplicate the check exists to prevent.
  it("80. the dupe query filters on the moment, not on the status", () => {
    // Asserted against the source because the query is the invariant: a
    // `status =` clause creeping back in is precisely the regression.
    const src = readFileSync(new URL("./extract.ts", import.meta.url), "utf8");
    const q = src.slice(src.indexOf("SELECT 1 AS hit FROM agent_proposals"));
    const clause = q.slice(0, q.indexOf("LIMIT 1"));
    expect(clause).toContain("json_extract(payload_json, '$.start')");
    expect(clause, "any status is a tombstone — pending, approved, declined or expired").not.toContain("status =");
  });
});

describe("offers — a dated event becomes a verb-schedule proposal", () => {
  // Production always carries a binding_id (index.ts's Job); an offer needs one
  // because its carrier invocation must be attributable to the binding whose
  // authority and budget it was made under.
  const offerJob: ExtractJob = { ...job, binding_id: "bind_x" };
  const dated = (start: unknown) =>
    JSON.stringify([{ class: "event", body: "U12G tournament, arrive 7:30", confidence: 0.9, start }]);

  it("90. mints ONE proposal per dated event, carried by its own invocation", async () => {
    // A proposal's id IS its invocation's id, so three offers need three
    // invocations — which is why this cannot be one proposal listing dates.
    const { w } = world(
      JSON.stringify([
        { class: "event", body: "Saturday game", confidence: 0.9, start: "2026-08-23T08:00:00" },
        { class: "event", body: "Sunday game", confidence: 0.9, start: "2026-08-24T07:30:00" },
      ]),
    );
    await runExtract(
      w.env,
      offerJob,
      CFG,
      inbound({ subject: "Tournament", body: "Saturday 8:00 am" }),
      {},
      async () => {},
    );
    const rows = w.db.query<{ id: string; kind: string; status: string; payload_json: string }>(
      "SELECT id, kind, status, payload_json FROM agent_proposals WHERE account_id = ?",
      ACCOUNT,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "verb-schedule" && r.status === "pending")).toBe(true);
    expect(rows.map((r) => JSON.parse(r.payload_json).start).sort()).toEqual([
      "2026-08-23T08:00:00",
      "2026-08-24T07:30:00",
    ]);
    // Each has its own carrier invocation, done at cost 0 — no model was
    // called for the offer; the extraction already paid for the thinking.
    for (const r of rows) {
      const inv = w.db.query<{ status: string; cost_micros: number }>(
        "SELECT status, cost_micros FROM agent_invocations WHERE id = ?",
        r.id,
      )[0];
      expect(inv).toMatchObject({ status: "done", cost_micros: 0 });
    }
  });

  it("91. an event with no usable start stays a note and offers nothing", async () => {
    const { w } = world(dated("Saturday morning"));
    await runExtract(w.env, offerJob, CFG, inbound({ subject: "Tournament", body: "Saturday" }), {}, async () => {});
    expect(w.db.query("SELECT id FROM agent_proposals WHERE account_id = ?", ACCOUNT)).toHaveLength(0);
    // But the reader still sees the date.
    expect(w.db.query("SELECT id FROM annotations WHERE account_id = ?", ACCOUNT)).toHaveLength(1);
  });

  it("92. the same moment is never offered twice — the quoted-thread case", async () => {
    const { w } = world(dated("2026-08-23T08:00:00"));
    const msg = inbound({ subject: "Tournament", body: "Saturday 8:00 am" });
    await runExtract(w.env, offerJob, CFG, msg, {}, async () => {});
    // A reply quoting the same schedule, arriving as its own delivery.
    await runExtract(
      w.env,
      { ...offerJob, id: "inv_y" },
      CFG,
      inbound({ id: "e_two", subject: "Re: Tournament", body: "Saturday 8:00 am" }),
      {},
      async () => {},
    );
    expect(w.db.query("SELECT id FROM agent_proposals WHERE account_id = ?", ACCOUNT)).toHaveLength(1);
  });

  it("93. a DECLINED moment is not re-offered — the decision is the tombstone", async () => {
    const { w } = world(dated("2026-08-23T08:00:00"));
    await runExtract(
      w.env,
      offerJob,
      CFG,
      inbound({ subject: "Tournament", body: "Saturday 8am" }),
      {},
      async () => {},
    );
    await w.env.DB.prepare("UPDATE agent_proposals SET status = 'rejected' WHERE account_id = ?").bind(ACCOUNT).run();
    await runExtract(
      w.env,
      { ...offerJob, id: "inv_z" },
      CFG,
      inbound({ id: "e_three", subject: "Re: Tournament", body: "Saturday 8am" }),
      {},
      async () => {},
    );
    // Still one: the answer already given is not asked again.
    expect(w.db.query("SELECT id FROM agent_proposals WHERE account_id = ?", ACCOUNT)).toHaveLength(1);
  });
});
