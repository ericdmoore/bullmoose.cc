/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import MarginOffers from "./MarginOffers";
import type { ActionProposal } from "../lib/approvals/types";
import type { ApprovalsAccount } from "../lib/approvals/accounts";

const offer = (over: Partial<Record<string, unknown>> = {}): ActionProposal =>
  ({
    id: "p1",
    kind: "verb-schedule",
    tier: 1,
    status: "pending",
    subject: { realm: "Email", objectId: "e1" },
    payload: { verb: "schedule", title: "U12G tournament", start: "2026-08-23T07:30:00" },
    ...over,
  }) as unknown as ActionProposal;

const account: ApprovalsAccount = {
  accountId: "a1",
  name: "eric",
  mayDecide: true,
  mayApproveIrreversible: true,
} as unknown as ApprovalsAccount;

const noop = () => {};

describe("MarginOffers", () => {
  it("1. renders nothing at all for a thread with no offers", () => {
    // No dead region, no empty frame — the floor is the message exactly as it
    // was before this surface existed.
    expect(
      render(<MarginOffers offers={[]} account={account} busy={new Set()} onApprove={noop} onDecline={noop} />),
    ).toBe("");
  });

  it("2. says what the offer IS, with its time, before any verb", () => {
    const html = render(
      <MarginOffers offers={[offer()]} account={account} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("Add to calendar?");
    expect(html).toContain("U12G tournament");
    expect(html).toContain("2026-08-23 07:30");
  });

  it("3. the capability wall renders its own words, never grey mystery buttons", () => {
    // A margin that offered approve on a watch-only account would be a
    // privilege escalation with a nice animation. rowAuthority's note is the
    // SAME wall the queue shows, rendered verbatim.
    const watchOnly = { ...account, mayDecide: false } as unknown as ApprovalsAccount;
    const html = render(
      <MarginOffers offers={[offer()]} account={watchOnly} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("Watch-only");
    expect(html).not.toContain(">Approve<");
  });

  it("4. an account the session cannot reach explains itself too", () => {
    const html = render(
      <MarginOffers offers={[offer()]} account={undefined} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("cannot reach");
    expect(html).not.toContain(">Approve<");
  });

  it("5. a busy offer quiets its verbs instead of double-submitting", () => {
    const html = render(
      <MarginOffers offers={[offer()]} account={account} busy={new Set(["p1"])} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("Deciding…");
    expect(html).toContain("disabled");
  });

  it("6. links to the queue's full surface — second UI, same record", () => {
    const html = render(
      <MarginOffers offers={[offer()]} account={account} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain('href="/approvals?p=p1"');
  });

  it("7. a refusal renders as an alert, in the server's words", () => {
    const html = render(
      <MarginOffers
        offers={[offer()]}
        account={account}
        busy={new Set()}
        error="proposal is approved, not pending"
        onApprove={noop}
        onDecline={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("proposal is approved, not pending");
  });

  it("9. a MOVE offer renders the diff — approval is never assent to something unseen", () => {
    const html = render(
      <MarginOffers
        offers={[
          offer({
            kind: "verb-schedule-update",
            payload: {
              verb: "schedule-update",
              targetEventId: "ev_tourn",
              targetTitle: "U12G tournament",
              changes: { start: { from: "2026-08-23T08:00:00", to: "2026-08-23T07:30:00" } },
            },
          }),
        ]}
        account={account}
        busy={new Set()}
        onApprove={noop}
        onDecline={noop}
      />,
    );
    expect(html).toContain("Move on calendar?");
    expect(html).toContain("U12G tournament");
    // Same-day move: the right side is the time alone, what changed is what
    // the eye lands on.
    expect(html).toContain("2026-08-23 08:00 → 07:30");
  });

  it("10. a blocked dependent renders its wall — visible, with no Approve to mis-tap", () => {
    // s36 V2: the cause rides the same thread's offers, so the margin can say
    // "waits on" BEFORE the tap instead of relaying a refusal after it.
    const cause = offer(); // id p1, the pending schedule offer
    const dep = offer({
      id: "p2",
      kind: "contingent-commitment",
      payload: { verb: "commit", body: "Pay registration to the coach", waitsOn: "p1" },
    });
    const html = render(
      <MarginOffers offers={[cause, dep]} account={account} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("Commitment?");
    expect(html).toContain("Pay registration to the coach");
    expect(html).toContain("waits on:");
    // The cause still gets its Approve; the dependent gets exactly one
    // approve button between them — count the approve class, not the word.
    expect(html.match(/margin-verb-approve/g)).toHaveLength(1);
  });

  it("8. an offer with no start still renders its title rather than lying about a time", () => {
    const p = offer({ payload: { verb: "schedule", title: "Sometime thing" } });
    const html = render(
      <MarginOffers offers={[p]} account={account} busy={new Set()} onApprove={noop} onDecline={noop} />,
    );
    expect(html).toContain("Sometime thing");
    expect(html).not.toContain("undefined");
  });
});
