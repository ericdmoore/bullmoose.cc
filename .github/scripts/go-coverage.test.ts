import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CI script, deliberately not part of the TS program
import { merge, parseProfile, summaryEntry, toRepoPath } from "./go-coverage.mjs";

const MODULE = "github.com/ericdmoore/bullmoose.cc";

describe("parseProfile", () => {
  it("1. sums blocks per file and counts statements, not lines", () => {
    const p = parseProfile(
      ["mode: set", `${MODULE}/cli-go/a.go:10.2,12.3 2 1`, `${MODULE}/cli-go/a.go:20.2,21.3 3 0`].join("\n"),
    );
    expect(p.get(`${MODULE}/cli-go/a.go`)).toEqual({ total: 5, covered: 2 });
  });

  it("2. ANY non-zero count is covered — a hot loop is not 'more covered'", () => {
    // Treating the execution count as a weight would let one heavily-exercised
    // block paper over an untested branch beside it.
    const p = parseProfile(["mode: count", `${MODULE}/cli-go/a.go:1.1,2.2 4 400`].join("\n"));
    expect(p.get(`${MODULE}/cli-go/a.go`)).toEqual({ total: 4, covered: 4 });
  });

  it("3. ignores the header and any malformed tail rather than throwing", () => {
    expect(parseProfile("mode: set\n\ngarbage line\n").size).toBe(0);
    expect(parseProfile("").size).toBe(0);
  });
});

describe("toRepoPath", () => {
  it("10. strips the module prefix so packageOf can bucket it", () => {
    expect(toRepoPath(`${MODULE}/cli-go/internal/cmd/local.go`, MODULE)).toBe("cli-go/internal/cmd/local.go");
  });

  it("11. leaves an unrecognised path alone rather than mangling it", () => {
    expect(toRepoPath("some/other/thing.go", MODULE)).toBe("some/other/thing.go");
  });
});

describe("summaryEntry", () => {
  it("20. reports lines from statements, and does NOT invent branches or functions", () => {
    // The ratchet gates on lines. Guessing the other two would put fiction in
    // a file people read when a number surprises them.
    const e = summaryEntry({ total: 8, covered: 6 });
    expect(e.lines).toEqual({ total: 8, covered: 6, skipped: 0, pct: 75 });
    expect(e.branches.total).toBe(0);
    expect(e.functions.total).toBe(0);
  });

  it("21. an empty file is 100%, matching the ratchet's own floorPct", () => {
    expect(summaryEntry({ total: 0, covered: 0 }).lines.pct).toBe(100);
  });
});

describe("merge", () => {
  it("30. adds Go files without disturbing the JS entries", () => {
    const existing = { "/repo/packages/mime/src/x.ts": { lines: { total: 1, covered: 1, skipped: 0, pct: 100 } } };
    const out = merge(existing, `mode: set\n${MODULE}/cli-go/a.go:1.1,2.2 2 1\n`, {
      modulePrefix: MODULE,
      root: "/repo",
    });
    expect(out["/repo/packages/mime/src/x.ts"]).toBe(existing["/repo/packages/mime/src/x.ts"]);
    expect(out["/repo/cli-go/a.go"].lines).toEqual({ total: 2, covered: 2, skipped: 0, pct: 100 });
  });
});
