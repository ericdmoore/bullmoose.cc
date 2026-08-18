import { describe, expect, it } from "vitest";
import { CLEAR_LEAD, nameMatches, rankRecipients, resolveRecipient } from "./resolve";

// s20 T3 — the one inference that can put the right words in front of the
// wrong person. The properties asserted here are the constraint, restated:
//
//   • the ranking reads BOTH sources (address book, correspondence history)
//     and says which one each candidate came from, in words;
//   • a clear lead resolves, and carries its evidence;
//   • anything less refuses — `ambiguous` hands back candidates and NO choice,
//     which is what keeps the composer's ask button disabled;
//   • a name it has never seen is asked about, never invented.

const NOW = Date.UTC(2026, 7, 18);
const daysAgo = (n: number) => NOW - n * 86_400_000;

describe("nameMatches — the filter that keeps a body mention from becoming a person", () => {
  it("matches on the name and on the address's local part", () => {
    expect(nameMatches("sergio", "Sergio Ramos", "sr@boards.example")).toBe(true);
    expect(nameMatches("sergio", null, "sergio.ramos@boards.example")).toBe(true);
    expect(nameMatches("ramos", "Sergio Ramos", "sr@boards.example")).toBe(true);
  });

  it("does not match the sender of a message that merely mentions them", () => {
    expect(nameMatches("sergio", "Alice Chen", "alice@example.com")).toBe(false);
  });
});

describe("resolveRecipient — what it does with a name", () => {
  it("resolves one candidate and says where the address came from", () => {
    const res = resolveRecipient(
      "Sergio",
      [{ email: "sergio@boards.example", name: "Sergio Ramos" }],
      [
        { email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_new", at: daysAgo(3) },
        { email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_old", at: daysAgo(40) },
      ],
      { now: NOW },
    );
    expect(res.status).toBe("resolved");
    expect(res.chosen?.email).toBe("sergio@boards.example");
    expect(res.chosen?.via).toBe("address-book+history");
    expect(res.chosen?.evidence).toContain("in your address book");
    expect(res.chosen?.evidence).toContain("2 messages between you");
    // The newest exchange is the background the ask carries — never the oldest.
    expect(res.chosen?.anchorEmailId).toBe("e_new");
    expect(res.message).toContain("Change it if I have the wrong one");
  });

  it("resolves from mail history alone when the address book knows nobody", () => {
    const res = resolveRecipient(
      "Sergio",
      [],
      [{ email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_1", at: daysAgo(2) }],
      { now: NOW },
    );
    expect(res.status).toBe("resolved");
    expect(res.chosen?.via).toBe("history");
    expect(res.chosen?.evidence).toContain("1 message between you");
  });

  // THE CONSTRAINT. Two people match and neither leads: no choice is made, and
  // the candidates come back with their evidence so a human can make it.
  it("refuses to choose between two close matches", () => {
    const res = resolveRecipient(
      "Sergio",
      [
        { email: "sergio.ramos@boards.example", name: "Sergio Ramos" },
        { email: "sergio.vidal@old.example", name: "Sergio Vidal" },
      ],
      [
        { email: "sergio.ramos@boards.example", name: "Sergio Ramos", emailId: "e_1", at: daysAgo(10) },
        { email: "sergio.ramos@boards.example", name: "Sergio Ramos", emailId: "e_2", at: daysAgo(12) },
        { email: "sergio.vidal@old.example", name: "Sergio Vidal", emailId: "e_3", at: daysAgo(20) },
      ],
      { now: NOW },
    );
    expect(res.status).toBe("ambiguous");
    expect(res.chosen).toBeNull();
    expect(res.candidates).toHaveLength(2);
    expect(res.message).toContain("I will not choose for you");
    // Both are offered with the evidence that makes them tellable apart.
    expect(res.candidates.map((c) => c.evidence).join(" ")).toContain("in your address book");
  });

  it("resolves when the lead IS clear — the ambiguity rule is a threshold, not a veto", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      email: "sergio@boards.example",
      name: "Sergio Ramos",
      emailId: `e_${i}`,
      at: daysAgo(i + 1),
    }));
    const res = resolveRecipient(
      "Sergio",
      [{ email: "sergio@boards.example", name: "Sergio Ramos" }],
      [...history, { email: "sergio.vidal@old.example", name: "Sergio Vidal", emailId: "e_x", at: daysAgo(400) }],
      { now: NOW },
    );
    expect(res.status).toBe("resolved");
    expect(res.chosen?.email).toBe("sergio@boards.example");
    const [top, second] = res.candidates;
    expect(top!.score - second!.score).toBeGreaterThanOrEqual(CLEAR_LEAD);
  });

  it("asks for an address when it has never seen the name", () => {
    const res = resolveRecipient("Sergio", [], [], { now: NOW });
    expect(res.status).toBe("unknown");
    expect(res.chosen).toBeNull();
    expect(res.message).toContain("Type their address");
  });

  it("has nothing to resolve when the human wrote an address", () => {
    const res = resolveRecipient("sergio@boards.example", [], [], { now: NOW });
    expect(res.status).toBe("address");
    expect(res.candidates).toEqual([]);
  });

  it("asks who it is for when the sentence named nobody", () => {
    expect(resolveRecipient(null, [], [], { now: NOW })).toMatchObject({ status: "none", chosen: null });
  });

  it("never proposes you to yourself", () => {
    const res = resolveRecipient(
      "eric",
      [{ email: "eric@bullmoose.cc", name: "Eric Moore" }],
      [{ email: "eric@bullmoose.cc", name: "Eric Moore", emailId: "e_1", at: daysAgo(1) }],
      { now: NOW, exclude: ["Eric@bullmoose.cc"] },
    );
    expect(res.status).toBe("unknown");
  });
});

describe("rankRecipients", () => {
  it("drops the senders of messages that merely mention the name", () => {
    const ranked = rankRecipients(
      "Sergio",
      [],
      [
        { email: "alice@example.com", name: "Alice Chen", emailId: "e_1", at: daysAgo(1) },
        { email: "sergio@boards.example", name: "Sergio Ramos", emailId: "e_1", at: daysAgo(1) },
      ],
      { now: NOW },
    );
    expect(ranked.map((c) => c.email)).toEqual(["sergio@boards.example"]);
  });

  it("merges a person's addresses by address and keeps both offered", () => {
    const ranked = rankRecipients(
      "Sergio",
      [
        { email: "sergio@boards.example", name: "Sergio Ramos" },
        { email: "sergio@home.example", name: "Sergio Ramos" },
      ],
      [],
      { now: NOW },
    );
    expect(ranked).toHaveLength(2);
    expect(ranked.every((c) => c.via === "address-book")).toBe(true);
    expect(ranked.every((c) => c.anchorEmailId === null)).toBe(true);
  });

  it("orders stably, so a lookup does not reshuffle itself between keystrokes", () => {
    const cards = [
      { email: "b@x.example", name: "Sergio B" },
      { email: "a@x.example", name: "Sergio A" },
    ];
    const first = rankRecipients("Sergio", cards, [], { now: NOW }).map((c) => c.email);
    const again = rankRecipients("Sergio", [...cards].reverse(), [], { now: NOW }).map((c) => c.email);
    expect(first).toEqual(again);
  });
});
