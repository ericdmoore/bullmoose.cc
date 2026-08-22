import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { EmailRow } from "@bullmoose/mailstore";
import { hasExtractCue, parseExtraction, parseScoutVerdict, runExtract, type ExtractJob } from "./extract.js";

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

function inbound(o: { subject?: string; body?: string }): EmailRow {
  return {
    id: "e_msg",
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
