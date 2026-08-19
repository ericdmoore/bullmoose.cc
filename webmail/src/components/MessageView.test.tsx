/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { createDemoBackend, demoEmails } from "../lib/jmap/demo";
import type { ThreadDetail } from "../lib/mail/threadView";
import MessageView, { AgentVerbs } from "./MessageView";

// s18 A3 — the plain floor, asserted: MessageView's client/accountId props are
// OPTIONAL, and without them the thread renders exactly as it always did — no
// margin, no person-panel, no dead region. (The margin itself is unit-tested
// in AnnotationMargin.test.tsx; the fetch in api.test.ts; this guards the
// seam.)
//
// s20 T2 adds the verbs to the same seam, under the same rule: Reply, Reply
// all and Forward are present in every case below, agent session or not, and
// the agent verbs appear ONLY behind the capability gate. Prose is the escape
// hatch and the precision tool — removing it would be ideology.

function detail(): ThreadDetail {
  const emails = demoEmails().filter((e) => e.threadId === "t-elk");
  return { threadId: "t-elk", emails, notFound: [] };
}

const noop = () => {};

/** Render with every message expanded, so the action bars are in the markup. */
function renderView(props: Record<string, unknown> = {}): string {
  const d = detail();
  return render(
    <MessageView
      detail={d}
      expanded={new Set(d.emails.map((e) => e.id))}
      imagesAllowed={new Set()}
      showQuotes={false}
      onToggleExpand={noop}
      onAllowImages={noop}
      onToggleQuotes={noop}
      onReply={noop}
      onForward={noop}
      onBack={noop}
      {...props}
    />,
  );
}

describe("MessageView without a client", () => {
  it("renders the thread with no agent surface at all", () => {
    const html = renderView();
    expect(html).toContain("Project Elk kickoff");
    expect(html.match(/message-card/g)?.length).toBe(2); // both messages survive the Fragment wrap
    expect(html).not.toContain("anno-margin");
    expect(html).not.toContain("person-panel");
    expect(html).not.toContain("agent-verbs");
  });

  it("still offers the classic three — the verbs are additive, never a swap", () => {
    const html = renderView();
    expect(html).toContain(">Reply<");
    expect(html).toContain(">Reply all<");
    expect(html).toContain(">Forward<");
  });
});

describe("MessageView with an agent session (s20 T2)", () => {
  /**
   * The verb bar is rendered from state set by an async capability check, so
   * the first synchronous render never carries it — that is the point of the
   * gate, and it is what a session WITHOUT the capability keeps forever.
   * `renderToString` sees only that first pass, so the assertions here are the
   * floor (nothing leaks before the gate answers); the doors themselves are
   * driven end to end in `lib/verbs/api.test.ts`.
   */
  it("renders nothing agent-shaped before the capability gate answers", () => {
    const demo = createDemoBackend();
    const html = renderView({ client: demo.client, accountId: "acct-fake" });
    expect(html).toContain("Project Elk kickoff");
    expect(html).not.toContain("agent-verbs");
    // …and the mail surface is untouched while it waits.
    expect(html).toContain(">Forward<");
  });

  it("a session without the agent capability is byte-identical to the plain floor", () => {
    const demo = createDemoBackend({ agentCapability: false });
    expect(renderView({ client: demo.client, accountId: "acct-fake" })).toBe(renderView());
  });
});

describe("the verb bar's markup", () => {
  const email = demoEmails().find((e) => e.threadId === "t-elk")!;
  const bar = (props: Record<string, unknown> = {}) =>
    render(<AgentVerbs email={email} cell={undefined} blocked={false} onWatch={noop} onAsk={noop} {...props} />);

  it("offers the three asks, and names who a Watch would wait on", () => {
    const html = bar();
    expect(html).toContain(">Answer<");
    expect(html).toContain(">Watch<");
    expect(html).toContain("Bring in");
    expect(html).toContain(">Schedule<");
    // A calendar verb states its whole promise before it is pressed: a hold,
    // on your own calendar, reaching nobody.
    expect(html).toContain("tentative, and nobody is invited");
    // The contract is legible BEFORE it is armed — a resolved address the
    // human can see is how a wrong guess gets caught early.
    expect(html).toContain(`title="Watch for a reply from ${email.from[0]!.email}"`);
    // No inline styles anywhere (CSP), and no navigating form.
    expect(html).not.toContain(" style=");
    expect(html).not.toContain("<form");
  });

  it("a message with nobody to wait on greys Watch instead of arming a guess", () => {
    const html = render(
      <AgentVerbs
        email={{ ...email, from: [], to: [] }}
        cell={undefined}
        blocked={false}
        onWatch={noop}
        onAsk={noop}
      />,
    );
    expect(html).toContain('title="No address to wait on"');
    expect(html.match(/disabled/g)?.length).toBe(1); // only Watch
  });

  it("a scope wall greys every ask rather than inviting the same refusal", () => {
    const html = render(<AgentVerbs email={email} cell={undefined} blocked onWatch={noop} onAsk={noop} />);
    expect(html.match(/disabled/g)).toHaveLength(4); // Answer, Watch, Bring in, Schedule
  });

  it("bring-in asks for an address rather than guessing a name", () => {
    const html = bar({ initiallyBringOpen: true });
    expect(html).toContain("Who should I bring in?");
    expect(html).toContain('aria-label="Email address of the person to bring in"');
  });

  it("says what the server said — armed, queued, or refused", () => {
    expect(bar({ cell: { busy: true } })).toContain("Asking…");
    const ok = bar({ cell: { ok: true, message: "Watching for a reply from sergio@example.test." } });
    expect(ok).toContain("Watching for a reply");
    expect(ok).not.toContain("notice-error");
    const bad = bar({ cell: { ok: false, message: "No agent is set up on this mailbox yet." } });
    expect(bad).toContain("notice-error");
    expect(bad).toContain('role="alert"');
  });
});
