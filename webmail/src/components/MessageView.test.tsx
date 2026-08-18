/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact-render-to-string";
import { demoEmails } from "../lib/jmap/demo";
import type { ThreadDetail } from "../lib/mail/threadView";
import MessageView from "./MessageView";

// s18 A3 — the plain floor, asserted: MessageView's client/accountId props are
// OPTIONAL, and without them the thread renders exactly as it always did — no
// margin, no person-panel, no dead region. (The margin itself is unit-tested
// in AnnotationMargin.test.tsx; the fetch in api.test.ts; this guards the
// seam.)

function detail(): ThreadDetail {
  const emails = demoEmails().filter((e) => e.threadId === "t-elk");
  return { threadId: "t-elk", emails, notFound: [] };
}

const noop = () => {};

describe("MessageView without a client", () => {
  it("renders the thread with no agent surface at all", () => {
    const html = render(
      <MessageView
        detail={detail()}
        expanded={new Set()}
        imagesAllowed={new Set()}
        showQuotes={false}
        onToggleExpand={noop}
        onAllowImages={noop}
        onToggleQuotes={noop}
        onReply={noop}
        onForward={noop}
        onBack={noop}
      />,
    );
    expect(html).toContain("Project Elk kickoff");
    expect(html.match(/message-card/g)?.length).toBe(2); // both messages survive the Fragment wrap
    expect(html).not.toContain("anno-margin");
    expect(html).not.toContain("person-panel");
  });
});
