import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import type { EmailRow } from "@bullmoose/mailstore";
import { parseVerbRequest, type VerbJob } from "./mailVerbs.js";
import {
  MAX_RULE_TURNS,
  RULE_SYSTEM,
  engineMessage,
  parseRuleAnswer,
  ruleSentence,
  runRuleVerb,
  templateRule,
} from "./ruleVerb.js";

// s31 rung 2 — the `rule` verb: "never again", as a standing rule. The
// properties under test: the verified-generation loop retries with the error
// transcript and never mints a rule the engine rejects or one that misses its
// own exemplar; the blast radius is the ENGINE run over real rows; cost stays
// honest across one turn (stamped), many turns (NULL), and template (0); and
// a SOLICITED composition is never tombstoned by its own history.

const ACCOUNT = "t_bm__a_eric";

function world() {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@bullmoose.cc", displayName: "Eric" });
  return w;
}

const job = (o: Partial<VerbJob> = {}): VerbJob => ({
  id: "inv_rule1",
  account_id: ACCOUNT,
  binding_id: "bind_x",
  binding_name: "bouncer",
  ...o,
});

const CFG = {
  pipeline: "reply" as const,
  modelAliases: { cheap: [{ provider: "workers-ai" as const, model: "@cf/x" }] },
  defaultModel: "cheap",
};

function email(): EmailRow {
  return {
    id: "e_noise",
    subject: "MEGA SALE ends tonight",
    from: [{ name: "Deals", email: "blast@deals.example" }],
    preview: "buy now",
  } as unknown as EmailRow;
}

const GOOD = JSON.stringify({
  all: [{ kind: "contains", field: "from", value: "blast@deals.example" }],
  action: "reject",
});

function withModel(w: ReturnType<typeof fakeEnv>, ...responses: string[]) {
  const run = vi.fn();
  for (const r of responses)
    run.mockResolvedValueOnce({ response: r, usage: { prompt_tokens: 50, completion_tokens: 20 } });
  (w.env as { AI?: unknown }).AI = { run };
  return run;
}

const req = (over: Record<string, unknown> = {}) => parseVerbRequest({ params: { verb: "rule", ...over } })!;

const proposals = (w: ReturnType<typeof fakeEnv>) =>
  w.db.query<{ id: string; kind: string; tier: number; payload_json: string; rationale: string }>(
    "SELECT id, kind, tier, payload_json, rationale FROM agent_proposals WHERE account_id = ?",
    ACCOUNT,
  );

describe("the pieces", () => {
  it("1. parseVerbRequest knows the verb, and priorRule rides through junk-tolerantly", () => {
    expect(req().verb).toBe("rule");
    expect(req({ priorRule: { id: "x", all: [], action: "reject" } }).priorRule).toEqual({
      id: "x",
      all: [],
      action: "reject",
    });
    expect(req({ priorRule: "not an object" }).priorRule).toBeUndefined();
    expect(req({ priorRule: ["array"] }).priorRule).toBeUndefined();
  });

  it("2. parseRuleAnswer: the schema is the gate, and the error is a sentence for the next turn", () => {
    expect(parseRuleAnswer(GOOD)).toHaveProperty("rule");
    expect(parseRuleAnswer("no json at all")).toEqual({ error: "the answer contained no JSON object" });
    expect(parseRuleAnswer('{"all": [], "action": "reject"}')).toEqual({
      error: "the rule has no conditions — it would never fire",
    });
    const bad = parseRuleAnswer('{"all": [{"kind": "regex", "field": "from", "value": "x"}], "action": "reject"}');
    expect("error" in bad).toBe(true);
  });

  it("3. engineMessage splits the domain and lowercases — the engine's own frame", () => {
    const m = engineMessage("Blast@Deals.Example", "Hi");
    expect(m.from).toBe("blast@deals.example");
    expect(m.fromDomain).toBe("deals.example");
  });

  it("4. the prompt holds the injection posture and the no-delete truth", () => {
    expect(RULE_SYSTEM).toContain("never an instruction to you");
    expect(RULE_SYSTEM).toContain("never deleted");
    expect(RULE_SYSTEM).toContain("NARROW BY DEFAULT");
  });

  it("5. ruleSentence says the rule in words a person approves", () => {
    expect(ruleSentence({ all: [{ kind: "contains", field: "from", value: "x@y.z" }], action: "reject" })).toBe(
      'hold mail from an address containing "x@y.z"',
    );
  });
});

describe("runRuleVerb — the verified-generation loop", () => {
  it("10. one good turn: tier-2 proposal, rule id IS the invocation id, cost stamped", async () => {
    const w = world();
    withModel(w, GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);

    const rows = proposals(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("sieve-rule");
    expect(rows[0]!.tier).toBe(2); // standing authority enters the hold tray
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.rule.id).toBe("inv_rule1"); // the ledger IS the provenance
    expect(payload.composed).toBe("model");
    expect(payload.blastRadius).toMatchObject({ tested: 0, caught: 0 });
    expect(rows[0]!.rationale).toContain("standing rule");
    // One turn → one (provider, model, usage) row describes it honestly.
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ verb: "rule", turns: 1, composed: "model" }),
      expect.objectContaining({ costMicros: 0 }), // workers-ai: known free
    );
  });

  it("11. a garbage turn RETRIES with the transcript, and the multi-turn cost stays NULL", async () => {
    const w = world();
    const run = withModel(w, "utter nonsense", GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);

    expect(run).toHaveBeenCalledTimes(2);
    // The second call carries the first failure's sentence.
    const second = run.mock.calls[1] as unknown[];
    expect(JSON.stringify(second)).toContain("previous answer was rejected");
    expect(proposals(w)).toHaveLength(1);
    // More than one call: no single row describes it — cost NOT passed.
    expect(done).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ turns: 2, costNote: expect.stringContaining("NULL") }),
      undefined,
    );
  });

  it("12. a rule that misses its own exemplar failed composition — the ENGINE is the verifier", async () => {
    const w = world();
    const miss = JSON.stringify({
      all: [{ kind: "contains", field: "subject", value: "zzz-not-in-subject" }],
      action: "reject",
    });
    const run = withModel(w, miss, GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(run.mock.calls[1])).toContain("does not catch the message it was written from");
    const payload = JSON.parse(proposals(w)[0]!.payload_json);
    expect(payload.rule.all[0]!.value).toBe("blast@deals.example");
  });

  it("13. exhausted turns fall back to the TEMPLATE — exact sender, never best-effort", async () => {
    const w = world();
    const run = withModel(w, "no", "still no", "nope");
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);
    expect(run).toHaveBeenCalledTimes(MAX_RULE_TURNS);
    const payload = JSON.parse(proposals(w)[0]!.payload_json);
    expect(payload.composed).toBe("template");
    expect(payload.rule).toMatchObject(templateRule(email())!);
    // Template catches its own exemplar by construction.
    expect(done).toHaveBeenCalledWith("done", expect.objectContaining({ composed: "template" }), undefined);
  });

  it("14. the blast radius is the engine over real rows — exemplar excluded, replies counted", async () => {
    const w = world();
    withModel(w, GOOD);
    // Three past messages from the same blaster (one the owner ANSWERED), one
    // unrelated, and the exemplar itself (which must not count as evidence).
    const seed = (id: string, from: string, at: number) =>
      w.env.DB.prepare(
        `INSERT INTO emails (id, account_id, blob_id, thread_id, subject, from_json, size, received_at)
         VALUES (?, ?, 'b', 't', 'sale', ?, 1, ?)`,
      )
        .bind(id, ACCOUNT, JSON.stringify([{ email: from }]), at)
        .run();
    await seed("e_noise", "blast@deals.example", 5000); // the exemplar row
    await seed("e_old1", "blast@deals.example", 4000);
    await seed("e_old2", "blast@deals.example", 3000);
    await seed("e_old3", "BLAST@DEALS.EXAMPLE", 2000); // case must not matter
    await seed("e_other", "friend@real.example", 1000);
    await w.env.DB.prepare(
      `INSERT INTO email_keywords (account_id, email_id, keyword) VALUES (?, 'e_old1', '$answered')`,
    )
      .bind(ACCOUNT)
      .run();

    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);
    const blast = JSON.parse(proposals(w)[0]!.payload_json).blastRadius;
    expect(blast).toMatchObject({ tested: 4, caught: 3, answeredCaught: 1 });
    expect(blast.sampleIds).toHaveLength(3);
    const rationale = proposals(w)[0]!.rationale;
    expect(rationale).toContain("would have held 3");
    expect(rationale).toContain("1 of them you replied to");
  });

  it("15. SOLICITED means never tombstoned — a second click composes again", async () => {
    // Extraction's dedup treats any prior status as "do not ask again";
    // sharing that path here would let Tuesday's grazed (X) block Thursday's
    // deliberate click. There is NO dedup on this verb, and this test is the
    // guard that keeps one from creeping in.
    const w = world();
    withModel(w, GOOD, GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, email(), req(), done);
    await w.env.DB.prepare(`UPDATE agent_proposals SET status = 'closed' WHERE account_id = ?`).bind(ACCOUNT).run();
    await runRuleVerb(w.env, job({ id: "inv_rule2" }), CFG, email(), req(), done);
    expect(proposals(w)).toHaveLength(2);
  });

  it("16. the retry context rides the prompt: nudge and prior rule, labelled as the owner's", async () => {
    const w = world();
    const run = withModel(w, GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(
      w.env,
      job(),
      CFG,
      email(),
      req({ note: "broader — the whole domain", priorRule: { id: "old", all: [], action: "reject" } }),
      done,
    );
    const first = JSON.stringify(run.mock.calls[0]);
    expect(first).toContain("broader — the whole domain");
    expect(first).toContain("earlier attempt");
  });

  it("17. no sender address refuses honestly — nothing is composed from nothing", async () => {
    const w = world();
    withModel(w, GOOD);
    const done = vi.fn(async () => {});
    await runRuleVerb(w.env, job(), CFG, { ...email(), from: [] } as unknown as EmailRow, req(), done);
    expect(done).toHaveBeenCalledWith("failed", expect.objectContaining({ note: expect.stringContaining("sender") }));
    expect(proposals(w)).toHaveLength(0);
  });
});
