import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentListRow } from "../agents/dossier";
import {
  DISCRIMINATOR_NO,
  DISCRIMINATOR_QUESTION,
  DISCRIMINATOR_YES,
  PROVISION_DEFAULT_BUDGET_MICROS,
  PROVISION_DEFAULT_EXPLORE_RATE,
  orderRoster,
  provisionDefaults,
  rosterSummary,
} from "./agentsPolicy";

// s26 T2 — the Settings → Agents policy shaping, and the anti-drift pin for
// its provision-time mirrors (the caveats.test.ts shape: worker code cannot be
// imported into a browser bundle, so the source is read off disk and the
// literals must be present — move either side and this fails, loudly).

const PROVISION = fileURLToPath(new URL("../../../../services/provision/src/index.ts", import.meta.url));

describe("the provision-time defaults are mirrors, pinned to the source", () => {
  const source = readFileSync(PROVISION, "utf8").replace(/\s+/g, " ");

  it("default monthly budget: provisionExtractor's budgetMicros fallback", () => {
    // `Number(body.budgetMicros) : 2_000_000` — the $2/month default.
    expect(source).toContain(`Number(body.budgetMicros)) ? Number(body.budgetMicros) : 2_000_000`);
    expect(PROVISION_DEFAULT_BUDGET_MICROS).toBe(2_000_000);
  });

  it("default explore rate: provisionExtractor's frontier fallback", () => {
    expect(source).toContain(`Number(body.exploreRate)) ? Number(body.exploreRate) : 0.2`);
    expect(PROVISION_DEFAULT_EXPLORE_RATE).toBe(0.2);
  });

  it("renders as µUSD money and a percentage, labeled read-only honestly", () => {
    const defaults = provisionDefaults();
    expect(defaults.map((d) => d.label)).toEqual(["Default monthly budget", "Default explore rate"]);
    expect(defaults[0]!.value).toBe("$2.00 / month");
    expect(defaults[1]!.value).toBe("20% of runs");
    // v1 is read-only BY DESIGN: the note says where the value is actually set
    // rather than the page collecting a change with nowhere to go.
    for (const d of defaults) expect(d.note.toLowerCase()).toContain("provision");
  });
});

describe("the discriminator is a complete rule, not a fragment", () => {
  it("question + both arms name their destinations", () => {
    expect(DISCRIMINATOR_QUESTION).toContain("would the value still mean anything");
    expect(DISCRIMINATOR_YES).toContain("Settings");
    expect(DISCRIMINATOR_NO).toContain("Agents realm");
    expect(DISCRIMINATOR_NO).toContain("verb");
  });

  it("every character in it is one the section's font stack can actually draw", () => {
    // The live page rendered "Yes □ it belongs here" — a U+2192 arrow with no
    // glyph in `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
    // Copy nobody can read is not copy, so the rule is: this string uses only
    // ASCII plus the punctuation the rest of the app already renders (em dash,
    // ellipsis, middle dot). Anything outside that set fails here by name
    // rather than in a screenshot nobody takes.
    const DRAWABLE = new Set(["—", "…", "·", "’"]);
    for (const s of [DISCRIMINATOR_QUESTION, DISCRIMINATOR_YES, DISCRIMINATOR_NO]) {
      const exotic = [...s].filter((ch) => ch.charCodeAt(0) > 127 && !DRAWABLE.has(ch));
      expect(exotic, `${s} carries ${exotic.map((c) => `U+${c.charCodeAt(0).toString(16)}`).join(", ")}`).toEqual([]);
    }
    // …and the connector is present, so the rule still reads as a rule.
    expect(DISCRIMINATOR_YES).toContain("Yes —");
    expect(DISCRIMINATOR_NO).toContain("No —");
  });
});

const row = (over: Partial<AgentListRow>): AgentListRow => ({
  id: "a/b",
  accountId: "a",
  bindingId: "b",
  name: "x",
  address: "x@bullmoose.cc",
  pipeline: "reply",
  enabled: true,
  pendingCount: 0,
  ...over,
});

describe("rosterSummary", () => {
  it("says the empty state in words", () => {
    expect(rosterSummary([])).toBe("No agent bindings on the accounts you own.");
  });
  it("all enabled collapses to one clause; a disabled agent splits the count", () => {
    expect(rosterSummary([row({}), row({ id: "a/c" })])).toBe("2 agents · all enabled");
    expect(rosterSummary([row({}), row({ id: "a/c", enabled: false })])).toBe("2 agents · 1 enabled · 1 disabled");
    expect(rosterSummary([row({})])).toBe("1 agent · all enabled");
  });
});

describe("orderRoster — disabled first (they need the decision), then by name", () => {
  it("orders and does not mutate its input", () => {
    const rows = [
      row({ id: "1", name: "zeta" }),
      row({ id: "2", name: "beta", enabled: false }),
      row({ id: "3", name: "alpha" }),
      row({ id: "4", name: "delta", enabled: false }),
    ];
    const snapshot = rows.map((r) => r.id);
    expect(orderRoster(rows).map((r) => r.name)).toEqual(["beta", "delta", "alpha", "zeta"]);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});
