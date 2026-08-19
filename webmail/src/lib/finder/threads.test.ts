import { describe, expect, it } from "vitest";
import type { FinderHit } from "./run";
import { groupByThread } from "./threads";

// Thread grouping for the Finder's list column (s20 T5): a find lands you in
// a conversation, so hits group by threadId, newest activity first.

const hit = (partial: Partial<FinderHit> & Pick<FinderHit, "id" | "threadId" | "receivedAt">): FinderHit => ({
  subject: "(no subject)",
  sender: "Someone",
  senderEmail: "someone@example.test",
  preview: "",
  hasAttachment: false,
  ...partial,
});

describe("groupByThread", () => {
  it("groups hits by thread, newest-activity thread first, newest hit first within", () => {
    const groups = groupByThread([
      hit({ id: "m1", threadId: "t-a", receivedAt: "2026-07-01T09:00:00Z", subject: "Kickoff" }),
      hit({ id: "m2", threadId: "t-b", receivedAt: "2026-07-03T09:00:00Z", subject: "Invoice" }),
      hit({ id: "m3", threadId: "t-a", receivedAt: "2026-07-02T09:00:00Z", subject: "Re: Kickoff" }),
    ]);
    expect(groups.map((g) => g.threadId)).toEqual(["t-b", "t-a"]);
    expect(groups[1]?.hits.map((h) => h.id)).toEqual(["m3", "m1"]);
  });

  it("names the group after its NEWEST hit's subject — the thread's current name", () => {
    const groups = groupByThread([
      hit({ id: "m1", threadId: "t-a", receivedAt: "2026-07-01T09:00:00Z", subject: "Kickoff" }),
      hit({ id: "m2", threadId: "t-a", receivedAt: "2026-07-02T09:00:00Z", subject: "Re: Kickoff" }),
    ]);
    expect(groups[0]?.subject).toBe("Re: Kickoff");
    expect(groups[0]?.latest).toBe("2026-07-02T09:00:00Z");
  });

  it("returns nothing for no hits, and never mutates its input", () => {
    expect(groupByThread([])).toEqual([]);
    const input = [
      hit({ id: "m2", threadId: "t-a", receivedAt: "2026-07-02T09:00:00Z" }),
      hit({ id: "m1", threadId: "t-a", receivedAt: "2026-07-01T09:00:00Z" }),
    ];
    const before = [...input];
    groupByThread(input);
    expect(input).toEqual(before);
  });
});
