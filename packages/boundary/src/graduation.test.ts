import { describe, expect, it } from "vitest";
import { DEFAULT_GRADUATION_POLICY, graduationDue, type GraduationPolicy } from "./graduation.js";

const row = (domain: string, rejects: number, rescues: number) => ({ domain, rejects, rescues });

describe("graduationDue — thresholds", () => {
  const P = DEFAULT_GRADUATION_POLICY;

  it("defaults are the spec's: minRejects 10, maxRescues 0", () => {
    expect(P).toEqual({ minRejects: 10, maxRescues: 0 });
  });

  type Row = [name: string, rejects: number, rescues: number, policy: GraduationPolicy, due: boolean];
  const rows: Row[] = [
    ["exactly minRejects, no rescues → due (boundary equality)", 10, 0, P, true],
    ["one short of minRejects → not due", 9, 0, P, false],
    ["far past minRejects → due", 500, 0, P, true],
    ["zero rejects → not due", 0, 0, P, false],
    ["ONE rescue blocks graduation forever under maxRescues 0", 100, 1, P, false],
    ["rescues at maxRescues → due (boundary equality)", 10, 2, { minRejects: 10, maxRescues: 2 }, true],
    ["rescues past maxRescues → not due", 10, 3, { minRejects: 10, maxRescues: 2 }, false],
    ["higher minRejects raises the bar", 10, 0, { minRejects: 20, maxRescues: 0 }, false],
  ];
  it.each(rows)("%s", (_name, rejects, rescues, policy, due) => {
    expect(graduationDue([row("spam-farm.biz", rejects, rescues)], policy)).toEqual(
      due ? ["spam-farm.biz"] : [],
    );
  });

  it("empty input → empty output", () => {
    expect(graduationDue([], P)).toEqual([]);
  });

  it("mixed rows: only the qualifying domains, in input order", () => {
    const out = graduationDue(
      [
        row("a.example", 12, 0), // due
        row("b.example", 3, 0), // under threshold
        row("c.example", 40, 1), // rescued — blocked
        row("d.example", 10, 0), // due, at the boundary
      ],
      P,
    );
    expect(out).toEqual(["a.example", "d.example"]);
  });

  it("duplicate domain rows dedupe to the first qualifying appearance", () => {
    const out = graduationDue([row("a.example", 12, 0), row("a.example", 99, 0)], P);
    expect(out).toEqual(["a.example"]);
  });
});
