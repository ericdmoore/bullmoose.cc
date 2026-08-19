/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { FakeJmapClient } from "../lib/jmap/FakeJmapClient";
import { chooseRecipient, resolveRecipient, type Resolution } from "../lib/intent/resolve";
import { parseIntent } from "../lib/intent/parse";
import type { DraftSpec } from "../lib/mail/compose";
import type { Identity } from "../lib/mail/types";
import Composer, { IntentPanel, RecipientRow } from "./Composer";

// s20 T3 — the composer's seam, asserted the way MessageView's is.
//
// The load-bearing claim: **the classic composer is untouched.** Every field
// and both buttons are in the markup with or without an agent, because prose
// is the escape hatch and the precision tool — removing it would be ideology.
// Intent mode is an additional door on the same surface, behind the same
// capability gate the thread view uses, and it never sends anything.

const identity: Identity = { id: "id_1", name: "Eric Moore", email: "eric@bullmoose.cc" } as Identity;

function draft(over: Partial<DraftSpec> = {}): DraftSpec {
  return {
    from: [{ name: "Eric Moore", email: "eric@bullmoose.cc" }],
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: "",
    ...over,
  };
}

const noop = () => {};

function renderComposer(props: Record<string, unknown> = {}): string {
  return render(
    <Composer
      draft={draft()}
      identities={[identity]}
      identityId="id_1"
      sending={false}
      onChange={noop}
      onIdentity={noop}
      onSend={noop}
      onSaveDraft={noop}
      onDiscard={noop}
      {...props}
    />,
  );
}

describe("Composer without an agent session", () => {
  it("is exactly the composer it has always been — every field, both buttons", () => {
    const html = renderComposer();
    expect(html).toContain(">From<");
    expect(html).toContain(">To<");
    expect(html).toContain(">Subject<");
    expect(html).toContain("composer-body");
    expect(html).toContain(">Send<");
    expect(html).toContain(">Save draft<");
  });

  it("offers no mode toggle and no intent surface at all", () => {
    const html = renderComposer();
    expect(html).not.toContain("composer-modes");
    expect(html).not.toContain("intent-panel");
    expect(html).not.toContain("What do you want to happen?");
  });

  it("keeps the classic editor when a client is present but the capability has not landed", () => {
    // The gate is `hasAgentCapability`, resolved in an effect: until it
    // answers, the composer is the plain-client floor. A session that never
    // answers stays here forever, which is the correct failure.
    const html = renderComposer({ client: new FakeJmapClient({}), accountId: "acct-fake" });
    expect(html).toContain(">Send<");
    expect(html).not.toContain("intent-panel");
  });
});

describe("IntentPanel", () => {
  function renderPanel(): string {
    return render(
      <IntentPanel
        client={new FakeJmapClient({})}
        accountId="acct-fake"
        identities={[identity]}
        onWriteItMyself={noop}
      />,
    );
  }

  it("asks the one question, and shows the shape of an answer", () => {
    const html = renderPanel();
    expect(html).toContain("What do you want to happen?");
    expect(html).toContain("ask Sergio whether he's comfortable with me selling assembled boards");
  });

  it("keeps the classic editor one keystroke away, on screen, at all times", () => {
    const html = renderPanel();
    expect(html).toContain(">Write it myself<");
    expect(html).toContain("Esc to write it yourself");
  });

  it("cannot ask until something has been asked for", () => {
    const html = renderPanel();
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Draft this<\/button>/);
  });

  it("carries no inline style and no navigating form (CSP, tokenInUrl)", () => {
    const html = renderPanel();
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<form");
  });
});

describe("RecipientRow — the inference, shown", () => {
  const resolved = resolveRecipient(
    "Sergio",
    [{ email: "sergio@boards.example", name: "Sergio Ramos" }],
    [{ email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_1", at: Date.now() - 86_400_000 }],
  );
  const ambiguous = resolveRecipient(
    "Sergio",
    [
      { email: "sergio.ramos@boards.example", name: "Sergio Ramos" },
      { email: "sergio.vidal@old.example", name: "Sergio Vidal" },
    ],
    [],
  );

  function renderRow(resolution: Resolution): string {
    return render(
      <RecipientRow resolution={resolution} looking={false} chosen={null} typed="" onType={noop} onPick={noop} />,
    );
  }

  it("names the address AND why it believes it, with a box to overrule it", () => {
    const html = renderRow(resolved);
    expect(html).toContain("sergio@boards.example");
    expect(html).toContain("in your address book");
    expect(html).toContain("1 message between you");
    expect(html).toContain('aria-label="Recipient address"');
  });

  it("an ambiguous name is said out loud, with both candidates offered", () => {
    const html = renderRow(ambiguous);
    expect(html).toContain("I will not choose for you");
    expect(html).toContain("sergio.ramos@boards.example");
    expect(html).toContain("sergio.vidal@old.example");
    expect(html).toContain('role="alert"');
  });

  it("says plainly when it has never heard of them", () => {
    const html = renderRow(resolveRecipient("Sergio", [], []));
    expect(html).toContain("could not find");
    expect(html).toContain("Type their address");
  });
});

describe("the rule that decides whether an ask may leave", () => {
  const plan = parseIntent("ask Sergio whether he's comfortable — supportive tone, no big commitment");

  it("an ambiguous resolution yields NO recipient — which is what disables the ask", () => {
    const ambiguous = resolveRecipient(
      "Sergio",
      [
        { email: "sergio.ramos@boards.example", name: "Sergio Ramos" },
        { email: "sergio.vidal@old.example", name: "Sergio Vidal" },
      ],
      [],
    );
    expect(ambiguous.status).toBe("ambiguous");
    expect(chooseRecipient(plan, ambiguous, null)).toBeNull();
  });

  it("picking one of the candidates unblocks it and KEEPS the provenance", () => {
    const ambiguous = resolveRecipient(
      "Sergio",
      [
        { email: "sergio.ramos@boards.example", name: "Sergio Ramos" },
        { email: "sergio.vidal@old.example", name: "Sergio Vidal" },
      ],
      [{ email: "sergio.ramos@boards.example", name: "Sergio Ramos", emailId: "e_9", at: Date.now() }],
    );
    expect(chooseRecipient(plan, ambiguous, "sergio.ramos@boards.example")).toEqual({
      to: "sergio.ramos@boards.example",
      via: "address-book+history",
      anchorEmailId: "e_9",
    });
  });

  it("an address typed out of nowhere is honestly labelled as typed", () => {
    const unknown = resolveRecipient("Sergio", [], []);
    expect(chooseRecipient(plan, unknown, "someone@new.example")).toEqual({ to: "someone@new.example", via: "typed" });
  });

  it("an address written into the sentence needs no resolution at all", () => {
    const typed = parseIntent("email sergio@boards.example about the boards");
    expect(chooseRecipient(typed, resolveRecipient(typed.who, [], []), null)).toEqual({
      to: "sergio@boards.example",
      via: "typed",
    });
  });
});
