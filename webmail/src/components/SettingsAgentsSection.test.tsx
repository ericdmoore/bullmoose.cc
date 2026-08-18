/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { AgentsPolicyView } from "./SettingsAgentsSection";
import type { AgentListRow } from "../lib/agents/dossier";

// s26 T2 — render tests for the Settings → Agents POLICY section (plain Node,
// preact-render-to-string — the AgentDossierPanel.test.tsx pattern). The
// derivations live in lib/settings/agentsPolicy.test.ts; here we prove the
// MARKUP: the discriminator teaches on-page, the provision defaults carry
// their read-only label, the roster wears the toggle, and refusals render
// beside the row they refused.

const row = (over: Partial<AgentListRow>): AgentListRow => ({
  id: "acct_a/ab_1",
  accountId: "acct_a",
  bindingId: "ab_1",
  name: "allen",
  address: "allen@bullmoose.cc",
  pipeline: "extract",
  enabled: true,
  pendingCount: 0,
  ...over,
});

const noToggle = () => {
  throw new Error("onToggle must not fire during render");
};

describe("AgentsPolicyView — the policy page", () => {
  const html = render(
    <AgentsPolicyView
      roster={[row({}), row({ id: "acct_a/ab_2", bindingId: "ab_2", name: "emily", enabled: false })]}
      errors={{}}
      onToggle={noToggle}
    />,
  );

  it("prints the discriminator so the split teaches itself", () => {
    expect(html).toContain("would the value still mean anything");
    expect(html).toContain("Settings");
    expect(html).toContain("Agents realm");
  });

  it("shows the provision-time defaults read-only, labeled as such", () => {
    expect(html).toContain("Default monthly budget");
    expect(html).toContain("$2.00 / month");
    expect(html).toContain("Default explore rate");
    expect(html).toContain("20% of runs");
    expect(html).toContain("set at provision time");
    // Read-only means READ-ONLY: no input collects a change with nowhere to go.
    expect(html).not.toContain("<input");
  });

  it("renders the roster with the summary, disabled-first, and the shared verb", () => {
    expect(html).toContain("2 agents · 1 enabled · 1 disabled");
    // disabled first (orderRoster): emily's row precedes allen's
    expect(html.indexOf("emily")).toBeLessThan(html.indexOf("allen@bullmoose.cc"));
    expect(html).toContain(">Enable<");
    expect(html).toContain(">Disable<");
    // and the dossier link, because everything else is a verb on that page
    expect(html).toContain('href="/agents"');
    expect(html).toContain("holds queued work");
  });

  it("never carries an inline style (CSP)", () => {
    expect(html).not.toContain("style=");
  });
});

describe("AgentsPolicyView — states", () => {
  it("a refusal renders beside the row it refused, as an alert", () => {
    const html = render(
      <AgentsPolicyView
        roster={[row({})]}
        errors={{ "acct_a/ab_1": "flipping a binding's kill switch requires the send capability" }}
        onToggle={noToggle}
      />,
    );
    expect(html).toContain("send capability");
    expect(html).toContain('role="alert"');
  });

  it("a busy row says so and disables its button", () => {
    const html = render(<AgentsPolicyView roster={[row({})]} busyRow="acct_a/ab_1" errors={{}} onToggle={noToggle} />);
    expect(html).toContain("Saving…");
    expect(html).toContain("disabled");
  });

  it("the no-capability floor explains instead of rendering a dead region", () => {
    const html = render(
      <AgentsPolicyView
        gateReason="This server does not advertise the bullmoose agent capability."
        roster={[]}
        errors={{}}
        onToggle={noToggle}
      />,
    );
    expect(html).toContain("does not advertise");
    // the policy body is withheld whole — no roster, no defaults
    expect(html).not.toContain("Default monthly budget");
  });

  it("an empty roster says the empty state in words", () => {
    const html = render(<AgentsPolicyView roster={[]} errors={{}} onToggle={noToggle} />);
    expect(html).toContain("No agent bindings on the accounts you own.");
  });
});
