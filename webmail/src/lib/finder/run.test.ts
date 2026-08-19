import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import type { JmapClient } from "../jmap/JmapClient";
import type { Email } from "../mail/types";
import { FINDER_SCOPE_NOTE, runFind, toHit } from "./run";
import { newSession, refine, type FinderSession } from "./session";

// The Finder's one query path (s20 T5), driven end-to-end against the demo
// backend — the same `Email/query` the mail surface answers from. The tests
// that matter are the LOOP's: a chip added to a session narrows the previous
// result set on re-query, and backing it out widens again.

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

async function demoFind(session: FinderSession) {
  const demo = createDemoBackend();
  const account = await demo.client.primaryAccountId();
  return runFind(demo.client, account, session);
}

describe("runFind over the demo backend", () => {
  it("finds by free text with the server's total and thread ids on every hit", async () => {
    const result = await demoFind(newSession("elk", NOW));
    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.subject)).toEqual(
      expect.arrayContaining(["Project Elk kickoff", "Re: Project Elk kickoff"]),
    );
    for (const hit of result.hits) expect(hit.threadId).toBe("t-elk");
  });

  it("a `from` chip NARROWS the same query — the directed-find loop's one move", async () => {
    const base = newSession("elk", NOW);
    const narrowed = await demoFind(refine(base, { kind: "from", value: "grace" }));
    expect(narrowed.hits.map((h) => h.id)).toEqual(["e-thread-1"]);
    // …and backing the chip out widens again (the chain is an array edit).
    expect((await demoFind(base)).total).toBe(2);
  });

  it("a window chip narrows by receivedAt — after inclusive, before exclusive", async () => {
    const july = refine(newSession("elk", NOW), {
      kind: "window",
      label: "Jul 2026",
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-08-01T00:00:00.000Z",
    });
    expect((await demoFind(july)).total).toBe(2);

    const august = refine(newSession("elk", NOW), {
      kind: "window",
      label: "Aug 2026",
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-09-01T00:00:00.000Z",
    });
    expect((await demoFind(august)).total).toBe(0);
  });

  it("chips alone are a find — has-attachment with no text reaches the invoice", async () => {
    const result = await demoFind(refine(newSession("", NOW), { kind: "attachment" }));
    expect(result.hits.map((h) => h.id)).toEqual(["e-invoice"]);
    expect(result.hits[0]?.hasAttachment).toBe(true);
  });

  it("a BLANK session queries nothing at all — browsing is /mail's job", async () => {
    const refusing = {
      queryThenGet: () => {
        throw new Error("a blank session must not reach the server");
      },
    } as unknown as JmapClient;
    await expect(runFind(refusing, "acct", newSession("", NOW))).resolves.toEqual({ hits: [], total: 0 });
  });
});

describe("toHit", () => {
  it("projects the row and is honest about absences", () => {
    const email = {
      id: "e-1",
      threadId: "t-1",
      subject: "",
      from: [],
      receivedAt: "2026-07-01T09:00:00.000Z",
      preview: "",
      hasAttachment: false,
    } as unknown as Email;
    expect(toHit(email)).toEqual({
      id: "e-1",
      threadId: "t-1",
      subject: "(no subject)",
      sender: "(unknown sender)",
      senderEmail: "",
      receivedAt: "2026-07-01T09:00:00.000Z",
      preview: "",
      hasAttachment: false,
    });
  });

  it("prefers the display name, falling back to the address", () => {
    const email = {
      id: "e-2",
      threadId: "t-2",
      subject: "Hi",
      from: [{ name: null, email: "grace@example.test" }],
      receivedAt: "2026-07-01T09:00:00.000Z",
      preview: "hello",
      hasAttachment: true,
    } as unknown as Email;
    expect(toHit(email)).toMatchObject({ sender: "grace@example.test", senderEmail: "grace@example.test" });
  });
});

describe("the scope note", () => {
  it("names what is searched AND the realms that are not — the boundary is the sentence's point", () => {
    expect(FINDER_SCOPE_NOTE).toMatch(/mail history/i);
    expect(FINDER_SCOPE_NOTE).toMatch(/whole words/i);
    for (const absent of ["Contacts", "calendar", "files"]) {
      expect(FINDER_SCOPE_NOTE).toContain(absent);
    }
  });
});
