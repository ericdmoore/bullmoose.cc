import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { EmailRow } from "@bullmoose/mailstore";
import { parseExtraction, runExtract, type ExtractJob } from "./extract";

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
    const items = parseExtraction(
      '[{"class":"commitment","body":"I\'ll send the calc Friday","confidence":1.4}]',
    );
    expect(items).toEqual([
      { class: "commitment", body: "I'll send the calc Friday", confidence: 1 },
    ]);
  });
  it("finds the array inside a chatty/fenced answer", () => {
    const items = parseExtraction('Sure!\n```json\n[{"class":"task","body":"review the PR"}]\n```');
    expect(items).toEqual([{ class: "task", body: "review the PR", confidence: null }]);
  });
  it("returns [] for garbage, a non-array, and unknown classes / empty bodies", () => {
    expect(parseExtraction("no json here")).toEqual([]);
    expect(parseExtraction('{"class":"task"}')).toEqual([]);
    expect(parseExtraction('[{"class":"vibe","body":"x"},{"class":"task","body":"  "}]')).toEqual(
      [],
    );
  });
});

describe("runExtract — writes Annotations from a delivered message", () => {
  it("extracts, anchors to the message, authors by the binding, and stamps cost", async () => {
    const { w, run } = world(
      '[{"class":"commitment","body":"You promised Bob the load calc by Friday","confidence":0.8}]',
    );
    const done = vi.fn(async () => {});
    await runExtract(
      w.env,
      job,
      CFG,
      inbound({ subject: "the calc", body: "I'll send it by Friday" }),
      {},
      done,
    );

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

  it("PRE-FILTER: a cue-less message spends NO model call and writes nothing", async () => {
    const { w, run } = world("[]");
    const done = vi.fn(async () => {});
    await runExtract(
      w.env,
      job,
      CFG,
      inbound({ subject: "hello", body: "just saying hi, nice weather" }),
      {},
      done,
    );

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
    await runExtract(
      w.env,
      job,
      CFG,
      inbound({ subject: "re: plans", body: "let's circle back" }),
      {},
      done,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(annotations(w)).toEqual([]);
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
    await runExtract(
      w.env,
      job,
      { pipeline: "extract" },
      inbound({ body: "I'll send it Friday" }),
      {},
      done,
    );
    expect(done).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({ note: expect.stringContaining("model menu") }),
    );
  });
});
