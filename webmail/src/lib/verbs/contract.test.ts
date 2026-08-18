import { describe, expect, it } from "vitest";
import {
  WATCH_BUSINESS_DAYS,
  addBusinessDays,
  askSentMessage,
  isAddress,
  verbCounterparty,
  watchArmedMessage,
  watchSpecFor,
} from "./contract";
import type { Email } from "../mail/types";

// s20 T2 — the verbs' rules, tested as rules.

function email(o: Partial<Email> = {}): Pick<Email, "id" | "threadId" | "from" | "to"> {
  return {
    id: "e_1",
    threadId: "t_1",
    from: [{ name: "Sergio", email: "sergio@example.com" }],
    to: [{ name: "Eric", email: "eric@bullmoose.cc" }],
    ...o,
  } as Pick<Email, "id" | "threadId" | "from" | "to">;
}

describe("addBusinessDays", () => {
  it("skips weekends", () => {
    // Thursday 2026-08-13 + 4 business days = Wednesday 2026-08-19.
    const thu = Date.UTC(2026, 7, 13, 12);
    expect(new Date(addBusinessDays(thu, 4)).toISOString().slice(0, 10)).toBe("2026-08-19");
    // Friday + 1 = Monday, never Saturday.
    const fri = Date.UTC(2026, 7, 14, 12);
    expect(new Date(addBusinessDays(fri, 1)).getUTCDay()).toBe(1);
  });

  it("0 days is now", () => {
    const t = Date.UTC(2026, 7, 13, 12);
    expect(addBusinessDays(t, 0)).toBe(t);
  });
});

describe("verbCounterparty", () => {
  it("is the sender, falling back to the first recipient", () => {
    expect(verbCounterparty(email())).toBe("sergio@example.com");
    expect(verbCounterparty(email({ from: [] }))).toBe("eric@bullmoose.cc");
  });

  it("is null when there is nobody to act on — the verb goes quiet, not wrong", () => {
    expect(verbCounterparty(email({ from: [], to: [] }))).toBeNull();
    expect(verbCounterparty(email({ from: [{ name: null, email: "not-an-address" }], to: [] }))).toBeNull();
  });
});

describe("isAddress — asked for, never guessed", () => {
  it("accepts an address and refuses a name", () => {
    expect(isAddress("kim@x.test")).toBe(true);
    expect(isAddress("  kim@x.test  ")).toBe(true);
    expect(isAddress("Sergio")).toBe(false);
    expect(isAddress("@x.test")).toBe(false);
    expect(isAddress("kim@")).toBe(false);
    expect(isAddress("kim smith@x.test")).toBe(false);
  });
});

describe("watchSpecFor — T1's default contract, compiled", () => {
  it("is reply-by +4 business days → draft a follow-up, on this thread", () => {
    const now = Date.UTC(2026, 7, 13, 12); // a Thursday
    const spec = watchSpecFor(email(), now)!;
    expect(spec.conditionType).toBe("no-reply-from");
    expect(spec.condition).toEqual({ sender: "sergio@example.com", threadId: "t_1" });
    expect(spec.actionType).toBe("draft-followup");
    expect(spec.action).toEqual({ to: "sergio@example.com" });
    expect(spec.sourceRef).toBe("e_1");
    expect(spec.deadlineAt).toBe(addBusinessDays(now, WATCH_BUSINESS_DAYS));
  });

  it("no counterparty, no watch — nothing is armed against a guess", () => {
    expect(watchSpecFor(email({ from: [], to: [] }), Date.now())).toBeNull();
  });
});

describe("the sentences say what was actually arranged", () => {
  it("the armed message names the person, the date, and the quiet close", () => {
    const spec = watchSpecFor(email(), Date.UTC(2026, 7, 13, 12))!;
    const msg = watchArmedMessage(spec);
    expect(msg).toContain("sergio@example.com");
    // Being answered IS silence — the property that makes a watch trustworthy
    // rather than noisy (s20 T1).
    expect(msg).toContain("if they reply first, the watch closes quietly");
  });

  it("an ask is an ask, not an answer", () => {
    // The one dishonest thing this surface could do is imply the draft exists.
    expect(askSentMessage("answer")).toContain("will appear in your approvals");
    expect(askSentMessage("bring-in", "kim@x.test")).toContain("kim@x.test");
  });
});
