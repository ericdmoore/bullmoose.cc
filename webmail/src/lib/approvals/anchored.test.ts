import { describe, expect, it } from "vitest";
import { indexByAnchor, offersForThread, withoutOffer } from "./anchored";
import type { ActionProposal } from "./types";

const offer = (id: string, objectId: string, status = "pending"): ActionProposal =>
  ({ id, status, kind: "verb-schedule", subject: { realm: "Email", objectId } }) as unknown as ActionProposal;

describe("indexByAnchor", () => {
  it("1. groups offers by the message they are about", () => {
    const ix = indexByAnchor([offer("p1", "e1"), offer("p2", "e1"), offer("p3", "e2")]);
    expect(ix.get("e1")?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(ix.get("e2")?.map((p) => p.id)).toEqual(["p3"]);
  });

  it("2. a DECIDED offer never appears beside a message", () => {
    // The margin's claim is "this needs you". A settled offer sitting there
    // makes that claim false, and teaches the reader to stop believing it.
    const ix = indexByAnchor([offer("done", "e1", "approved"), offer("no", "e1", "rejected")]);
    expect(ix.get("e1")).toBeUndefined();
  });

  it("3. an offer anchored to nothing is dropped, not crashed on", () => {
    const orphan = { id: "x", status: "pending", kind: "verb-schedule" } as unknown as ActionProposal;
    expect(() => indexByAnchor([orphan])).not.toThrow();
    expect(indexByAnchor([orphan]).size).toBe(0);
  });
});

describe("offersForThread", () => {
  it("10. gathers across every message in the thread, in reading order", () => {
    const ix = indexByAnchor([offer("p2", "e2"), offer("p1", "e1")]);
    expect(offersForThread(ix, ["e1", "e2"]).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("11. never offers the same proposal twice in one thread", () => {
    // A message can appear twice in a thread's id list. Showing its offer
    // twice means the reader decides one and watches the other sit there
    // looking unanswered.
    const ix = indexByAnchor([offer("p1", "e1")]);
    expect(offersForThread(ix, ["e1", "e1"]).map((p) => p.id)).toEqual(["p1"]);
  });

  it("12. a thread with nothing pending gets an empty list, not undefined", () => {
    expect(offersForThread(indexByAnchor([]), ["e1"])).toEqual([]);
  });
});

describe("withoutOffer — the local tombstone", () => {
  it("20. a decided offer does not flash back on the next paint", () => {
    // The index is a snapshot and cannot delta-sync (ActionProposal/query
    // advertises canCalculateChanges: false), so the client must forget an
    // answered offer itself or it reappears until the next full load.
    const ix = indexByAnchor([offer("p1", "e1"), offer("p2", "e1")]);
    const after = withoutOffer(ix, "p1");
    expect(after.get("e1")?.map((p) => p.id)).toEqual(["p2"]);
  });

  it("21. an anchor with nothing left disappears entirely", () => {
    const after = withoutOffer(indexByAnchor([offer("p1", "e1")]), "p1");
    expect(after.has("e1")).toBe(false);
  });

  it("22. forgetting an id that is not there changes nothing", () => {
    const ix = indexByAnchor([offer("p1", "e1")]);
    expect(
      withoutOffer(ix, "nope")
        .get("e1")
        ?.map((p) => p.id),
    ).toEqual(["p1"]);
  });
});
