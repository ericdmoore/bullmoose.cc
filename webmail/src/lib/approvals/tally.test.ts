import { describe, expect, it } from "vitest";
import { tally } from "./tally";

// #225's saved views ask the same question twice ("by agent", "by realm"), so
// they share one counter — a list that ordered one differently from the other
// would read as a bug in whichever the reader met second.

const rows = [
  { agent: "emily", realm: "Email" },
  { agent: "allen", realm: "Email" },
  { agent: "emily", realm: "Calendar" },
  { agent: "", realm: "Email" },
];

describe("tally", () => {
  it("counts per value, busiest first", () => {
    expect(tally(rows, (r) => r.agent)).toEqual([
      { name: "emily", count: 2 },
      { name: "allen", count: 1 },
    ]);
  });

  it("breaks ties by name, so the list is stable between renders", () => {
    const tied = [{ v: "b" }, { v: "a" }];
    expect(tally(tied, (r) => r.v).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("an unattributed row joins no facet — never an empty-named view", () => {
    expect(tally(rows, (r) => r.agent).some((x) => x.name === "")).toBe(false);
    expect(tally(rows, (r) => r.realm)).toEqual([
      { name: "Email", count: 3 },
      { name: "Calendar", count: 1 },
    ]);
  });
});
