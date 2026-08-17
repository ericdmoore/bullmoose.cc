import { describe, expect, it } from "vitest";
import {
  VOCAB_CAP,
  bayesClassify,
  type BoundaryMessage,
  type SieveRule,
} from "@bullmoose/boundary";
import { fakeD1 } from "@bullmoose/test-fakes";
import {
  BAYES_STATE_MAX_BYTES,
  SieveRulesInvalid,
  listSieveRules,
  loadBayesState,
  putSieveRules,
  recordBayesLabel,
  saveBayesState,
} from "./boundaryStore";

/**
 * s12 wave 2-C storage: the sieve ruleset and Bayes state rows. The two
 * disciplines under test are asymmetric on purpose:
 *   WRITES are strict — putSieveRules refuses garbage (a half-stored ruleset
 *   silently diverges from what its author believes is configured).
 *   READS fail open — corrupt/oversized/missing rows load as no-rules/null,
 *   because these sit on the delivery hot path and must never bounce mail.
 */

const ACCOUNT = "t_bm__a_bstore";

const RULES: SieveRule[] = [
  {
    id: "no-winners",
    all: [{ kind: "contains", field: "subject", value: "winner" }],
    action: "reject",
  },
  { id: "allow-hr", all: [{ kind: "glob", field: "from", value: "*@hr.example" }], action: "pass" },
];

const msg = (over: Partial<BoundaryMessage> = {}): BoundaryMessage => ({
  from: "sender@spamfarm.test",
  fromDomain: "spamfarm.test",
  subject: "one weird trick",
  textBody: "buy cheap casino winnings now",
  headers: {},
  sizeBytes: 120,
  hasAttachments: false,
  ...over,
});

describe("sieve rules — round-trip and refusal", () => {
  it("round-trips a valid ruleset, replacing on re-put", async () => {
    const db = fakeD1();
    await putSieveRules(db, ACCOUNT, RULES);
    expect(await listSieveRules(db, ACCOUNT)).toEqual(RULES);

    await putSieveRules(db, ACCOUNT, [RULES[0]!]);
    expect(await listSieveRules(db, ACCOUNT)).toEqual([RULES[0]]);
    expect(db.count("sieve_rules")).toBe(1); // one document per account
  });

  it("REFUSES garbage, leaving the stored ruleset untouched", async () => {
    const db = fakeD1();
    await putSieveRules(db, ACCOUNT, RULES);

    const garbage: Array<[string, unknown]> = [
      ["not an array", { id: "x" }],
      ["missing id", [{ all: [], action: "reject" }]],
      ["empty id", [{ id: "", all: [], action: "reject" }]],
      [
        "duplicate ids",
        [
          { id: "a", all: [], action: "pass" },
          { id: "a", all: [], action: "pass" },
        ],
      ],
      ["bad action", [{ id: "a", all: [], action: "discard" }]],
      ["all not an array", [{ id: "a", all: "everything", action: "reject" }]],
      [
        "unknown matcher kind",
        [{ id: "a", all: [{ kind: "regex", field: "subject", value: ".*" }], action: "reject" }],
      ],
      [
        "unknown field",
        [{ id: "a", all: [{ kind: "contains", field: "body", value: "x" }], action: "reject" }],
      ],
      [
        "non-string value",
        [{ id: "a", all: [{ kind: "contains", field: "subject", value: 7 }], action: "reject" }],
      ],
      [
        "empty header name",
        [{ id: "a", all: [{ kind: "headerPresent", name: "" }], action: "reject" }],
      ],
    ];
    for (const [label, rules] of garbage) {
      await expect(putSieveRules(db, ACCOUNT, rules as SieveRule[]), label).rejects.toThrow(
        SieveRulesInvalid,
      );
    }
    expect(await listSieveRules(db, ACCOUNT)).toEqual(RULES); // untouched
  });

  it("reads fail open: no row → [], missing table → [], stored garbage → []", async () => {
    const db = fakeD1();
    expect(await listSieveRules(db, ACCOUNT)).toEqual([]);

    // A row that predates validation or was corrupted in place.
    db.seed("sieve_rules", [{ account_id: ACCOUNT, rules_json: "{not json", updated_at: 1 }]);
    expect(await listSieveRules(db, ACCOUNT)).toEqual([]);

    db.sqlite.exec("DROP TABLE sieve_rules"); // the pre-migration shard
    expect(await listSieveRules(db, ACCOUNT)).toEqual([]);
  });

  it("a stored row that parses but is not a ruleset also reads as no rules", async () => {
    const db = fakeD1();
    db.seed("sieve_rules", [
      {
        account_id: ACCOUNT,
        rules_json: JSON.stringify([{ id: "a", all: [], action: "discard" }]),
        updated_at: 1,
      },
    ]);
    expect(await listSieveRules(db, ACCOUNT)).toEqual([]);
  });
});

describe("bayes state — load/save honesty", () => {
  it("absent, corrupt, wrong-shape and missing-table rows all load null", async () => {
    const db = fakeD1();
    expect(await loadBayesState(db, ACCOUNT)).toBeNull(); // no row

    db.seed("bayes_state", [{ account_id: ACCOUNT, state_json: "{corrupt", updated_at: 1 }]);
    expect(await loadBayesState(db, ACCOUNT)).toBeNull(); // corrupt JSON

    db.sqlite.exec("DELETE FROM bayes_state");
    db.seed("bayes_state", [
      {
        account_id: ACCOUNT,
        state_json: JSON.stringify({ spamCount: "many", hamCount: 0, tokens: {} }),
        updated_at: 1,
      },
    ]);
    expect(await loadBayesState(db, ACCOUNT)).toBeNull(); // wrong shape

    db.sqlite.exec("DROP TABLE bayes_state");
    expect(await loadBayesState(db, ACCOUNT)).toBeNull(); // pre-migration shard
  });

  it("an OVERSIZED row loads null (checked before parsing)", async () => {
    const db = fakeD1();
    const oversized = JSON.stringify({
      spamCount: 0,
      hamCount: 0,
      tokens: {},
      pad: "x".repeat(BAYES_STATE_MAX_BYTES),
    });
    db.seed("bayes_state", [{ account_id: ACCOUNT, state_json: oversized, updated_at: 1 }]);
    expect(await loadBayesState(db, ACCOUNT)).toBeNull();
  });

  it("saves prune to VOCAB_CAP — the cap is enforced on EVERY save", async () => {
    const db = fakeD1();
    const tokens: Record<string, { s: number; h: number }> = {};
    for (let i = 0; i < VOCAB_CAP + 10; i++) tokens[`tok${i}`] = { s: 1, h: 0 };
    // Keep a couple of high-count tokens that must survive any prune.
    tokens["keeper"] = { s: 40, h: 2 };
    await saveBayesState(db, ACCOUNT, { spamCount: 5, hamCount: 3, tokens });

    const loaded = await loadBayesState(db, ACCOUNT);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.tokens).length).toBe(VOCAB_CAP);
    expect(loaded!.tokens["keeper"]).toEqual({ s: 40, h: 2 });
    expect(loaded!.spamCount).toBe(5);
    expect(loaded!.hamCount).toBe(3);
  });
});

describe("recordBayesLabel — the one training entry point", () => {
  it("the first label CREATES the filter; the verdict shifts on re-classify", async () => {
    const db = fakeD1();
    const m = msg();
    // Untrained: the honest 0.5 (loadBayesState is null; the engine's empty
    // state classifies everything mid-band).
    expect(await loadBayesState(db, ACCOUNT)).toBeNull();

    await recordBayesLabel(db, ACCOUNT, m, "spam");
    const afterSpam = await loadBayesState(db, ACCOUNT);
    expect(afterSpam).not.toBeNull();
    expect(afterSpam!.spamCount).toBe(1);
    expect(afterSpam!.hamCount).toBe(0);
    expect(bayesClassify(afterSpam!, m).score).toBeGreaterThan(0.5);

    // Labels accumulate; a ham label pulls the same message back down.
    await recordBayesLabel(db, ACCOUNT, m, "ham");
    await recordBayesLabel(db, ACCOUNT, m, "ham");
    const afterHam = await loadBayesState(db, ACCOUNT);
    expect(afterHam!.hamCount).toBe(2);
    expect(bayesClassify(afterHam!, m).score).toBeLessThan(0.5);
  });

  it("a corrupt existing row degrades to a fresh state rather than dropping the label", async () => {
    const db = fakeD1();
    db.seed("bayes_state", [{ account_id: ACCOUNT, state_json: "{corrupt", updated_at: 1 }]);
    await recordBayesLabel(db, ACCOUNT, msg(), "ham");
    const state = await loadBayesState(db, ACCOUNT);
    expect(state).not.toBeNull();
    expect(state!.hamCount).toBe(1);
  });

  it("throws when the table is missing — training writes are loud, not silent", async () => {
    const db = fakeD1();
    db.sqlite.exec("DROP TABLE bayes_state");
    await expect(recordBayesLabel(db, ACCOUNT, msg(), "ham")).rejects.toThrow();
  });
});
