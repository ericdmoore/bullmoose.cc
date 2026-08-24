import { describe, expect, it } from "vitest";
import { INVOCATION_STANDING_SCOPES } from "@bullmoose/auth-core/invocation";
import { bindingEnvelope, type EnvelopeBindingRow } from "./envelope.js";

// s44 slice 1. The envelope is read to decide whether an ASK is proportionate,
// so the property under test is that it never claims a bound nobody applies
// and never asserts "none" where the truth is "not bounded here".

const row = (over: Partial<EnvelopeBindingRow> = {}): EnvelopeBindingRow => ({
  id: "bind_x",
  name: "extractor",
  enabled: 1,
  config_json: "{}",
  recipients_book_id: null,
  ...over,
});
const noSpend = { spentMicros: 0, overageMicros: 0 };

describe("bindingEnvelope — a projection, never an invention", () => {
  it("1. a bare binding: standing scopes, no ceilings, fail-closed outbound", () => {
    const e = bindingEnvelope(row(), noSpend);
    expect(e.scopes).toEqual([...INVOCATION_STANDING_SCOPES]);
    // NULL, not [] — "no ceiling declared" is not "no tools allowed".
    expect(e.toolCeiling).toBeNull();
    expect(e.credentialCeiling).toBeNull();
    // No governing book = cannot email anyone (outboundBound's fail-closed).
    expect(e.recipientsBookId).toBeNull();
    // The trigger gate reads as OFF; addresses never appear at all.
    expect(e.senderGate).toEqual({ active: false, count: 0 });
    expect(e.historyFloorAt).toBeNull();
  });

  it("2. the tool ceiling is projected WITH the fact that it bites jobs only", () => {
    // A job-less invocation folds to tools:null (nodeAuthority), so a ceiling
    // declared here bounds nothing for ordinary work — the projection says so
    // rather than implying a wall that is not there.
    const e = bindingEnvelope(row({ config_json: JSON.stringify({ jobs: { tools: ["email.draft"] } }) }), noSpend);
    expect(e.toolCeiling).toEqual(["email.draft"]);
    expect(e.toolCeilingApplies).toBe("jobs-only");
  });

  it("3. budget arithmetic mirrors budgetExhaustedSql: cap + overage − spent", () => {
    const e = bindingEnvelope(row({ config_json: JSON.stringify({ budgets: { spendPerMonth: 5_000_000 } }) }), {
      spentMicros: 1_500_000,
      overageMicros: 500_000,
    });
    expect(e.budget).toEqual({
      capMicros: 5_000_000,
      spentMicros: 1_500_000,
      overageMicros: 500_000,
      remainingMicros: 4_000_000,
    });
  });

  it("4. no cap means NOTHING TO REMAIN WITHIN — never 'infinite remaining'", () => {
    const e = bindingEnvelope(row(), { spentMicros: 900, overageMicros: 0 });
    expect(e.budget.capMicros).toBeNull();
    expect(e.budget.remainingMicros).toBeNull();
    expect(e.budget.spentMicros).toBe(900); // spend is still a fact
  });

  it("5. the kill switch is projected, because a disabled binding reaches nothing", () => {
    expect(bindingEnvelope(row({ enabled: 0 }), noSpend).enabled).toBe(false);
  });

  it("6. a corrupt config reads as NOTHING DECLARED — never stricter than the enforcer", () => {
    // bindingCeiling itself treats an unreadable config as unset; a projection
    // that showed a bound here would show a wall nobody applies.
    const e = bindingEnvelope(row({ config_json: "not json at all" }), noSpend);
    expect(e.toolCeiling).toBeNull();
    expect(e.budget.capMicros).toBeNull();
    expect(e.senderGate.active).toBe(false);
  });

  it("7. junk inside a readable config degrades field by field", () => {
    const e = bindingEnvelope(
      row({
        config_json: JSON.stringify({
          jobs: { tools: ["ok", 7, null], credentials: "not a list", maxDepth: "deep" },
          budgets: { spendPerMonth: "lots" },
          allowedSenders: ["a@b.c", 42],
          historyFloor: 1_700_000_000_000,
        }),
      }),
      noSpend,
    );
    expect(e.toolCeiling).toEqual(["ok"]);
    expect(e.credentialCeiling).toBeNull();
    expect(e.maxDepth).toBeNull();
    expect(e.budget.capMicros).toBeNull();
    expect(e.senderGate).toEqual({ active: true, count: 1 });
    expect(e.historyFloorAt).toBe(1_700_000_000_000);
  });

  it("8. the whole envelope, as a human would read it before widening anything", () => {
    const e = bindingEnvelope(
      row({
        enabled: 1,
        recipients_book_id: "ab_governing",
        config_json: JSON.stringify({
          jobs: { tools: ["email.draft", "files.read"], credentials: ["aws-mcp"], maxNodes: 8, maxDepth: 2 },
          budgets: { spendPerMonth: 2_000_000 },
          allowedSenders: ["eric@bullmoose.cc"],
          historyFloor: 1_690_000_000_000,
        }),
      }),
      { spentMicros: 250_000, overageMicros: 0 },
    );
    expect(e).toMatchObject({
      enabled: true,
      toolCeiling: ["email.draft", "files.read"],
      credentialCeiling: ["aws-mcp"],
      maxNodes: 8,
      maxDepth: 2,
      recipientsBookId: "ab_governing",
      senderGate: { active: true, count: 1 },
      historyFloorAt: 1_690_000_000_000,
    });
    // The guard console.test.ts holds on the dossier: derived facts, never
    // the config — an allowlisted address is a third party's data.
    expect(JSON.stringify(e)).not.toContain("eric@bullmoose.cc");
    expect(e.budget.remainingMicros).toBe(1_750_000);
  });
});
