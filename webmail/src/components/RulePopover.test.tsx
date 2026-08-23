/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { RulePopoverView, type RuleState, type RuleViewHandlers } from "./RulePopover";
import type { ActionProposal } from "../lib/approvals/types";

// s31 rung 2b — the popover's face, one test per state. The IO wrapper is
// thin (poll → decide → state); what must not regress is what each state
// SAYS: the rule in words, the blast radius beside it, (X) always reachable,
// and the held state telling the truth about the tray.

const noop = () => {};
const h: RuleViewHandlers = {
  onApprove: noop,
  onEditOpen: noop,
  onEditChange: noop,
  onEditSave: noop,
  onDeclineOpen: noop,
  onDecline: noop,
  onRetryOpen: noop,
  onRetryChange: noop,
  onRetrySend: noop,
  onBack: noop,
  onClose: noop,
};

const p = {
  id: "inv_r1",
  kind: "sieve-rule",
  tier: 2,
  status: "pending",
  subject: { realm: "Email", objectId: "e1" },
  payload: {
    verb: "rule",
    rule: { id: "inv_r1", all: [{ kind: "contains", field: "from", value: "blast@deals.example" }], action: "reject" },
    blastRadius: { tested: 200, caught: 3, sampleIds: [], answeredCaught: 1 },
  },
} as unknown as ActionProposal;

const paint = (state: RuleState) => render(<RulePopoverView state={state} h={h} />);

describe("RulePopoverView", () => {
  it("1. every state is a dialog with the (X) reachable — 'not now' is never trapped", () => {
    for (const state of [
      { kind: "minting" },
      { kind: "ready", p },
      { kind: "held" },
      { kind: "stalled" },
    ] as RuleState[]) {
      const html = paint(state);
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-label="Not now"');
    }
  });

  it("2. minting says what is happening, and nothing is decidable yet", () => {
    const html = paint({ kind: "minting" });
    expect(html).toContain("Making the rule…");
    expect(html).not.toContain(">Approve<");
  });

  it("3. ready leads with the RULE IN WORDS and the blast radius — informed Accept, not a rubber stamp", () => {
    const html = paint({ kind: "ready", p });
    expect(html).toContain("Hold mail where");
    expect(html).toContain("blast@deals.example");
    expect(html).toContain("Would have held 3 of your last 200 messages — 1 you replied to");
    expect(html).toContain("never deleted");
    for (const verb of [">Approve<", ">Edit<", ">Retry…<", ">Decline<"]) expect(html).toContain(verb);
  });

  it("4. declining offers the full taxonomy — a labelled negative or none", () => {
    const html = paint({ kind: "declining", p });
    expect(html).toContain("My slip");
    expect(html).toContain("Bad rule");
    expect(html).toContain("Should not have offered");
  });

  it("5. editing shows the JSON the redline lands as", () => {
    const html = paint({
      kind: "editing",
      p,
      form: { shape: "json", json: '{"rule": {}}' },
    });
    expect(html).toContain("rule-pop-json");
    expect(html).toContain("Save &amp; approve");
  });

  it("6. retrying asks for the nudge in the owner's words", () => {
    const html = paint({ kind: "retrying", p, nudge: "broader" });
    expect(html).toContain("What should change?");
    expect(html).toContain("Compose again");
  });

  it("7. held tells the truth about the tray — approved is not yet applied", () => {
    const html = paint({ kind: "held" });
    expect(html).toContain("hold tray");
    expect(html).toContain("take it back");
    expect(html).toContain('href="/approvals"');
  });

  it("8. stalled degrades honestly — the offer is not lost, it is in the queue", () => {
    const html = paint({ kind: "stalled" });
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/approvals"');
  });
});
