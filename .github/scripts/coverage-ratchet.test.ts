import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CI script, deliberately not part of the TS program
import { aggregate, evaluate, floorPct, lowered, nextBaseline, packageOf, run } from "./coverage-ratchet.mjs";

/**
 * The ratchet gates every PR, so the ways it could be WRONG are the ways it
 * would get switched off: flapping on unchanged code, or failing work that is
 * actually correct. Each case below pins one of those.
 */

const summaryFor = (files: Record<string, [number, number]>, root: string) => {
  const out: Record<string, unknown> = {};
  let covered = 0;
  let total = 0;
  for (const [file, [c, t]] of Object.entries(files)) {
    covered += c;
    total += t;
    const m = { covered: c, total: t, skipped: 0, pct: t === 0 ? 100 : (c / t) * 100 };
    out[join(root, file)] = { lines: m, statements: m, functions: m, branches: m };
  }
  const tot = { covered, total, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 };
  out.total = { lines: tot, statements: tot, functions: tot, branches: tot };
  return out;
};

describe("grouping and arithmetic", () => {
  it("groups a covered file by its first two path segments", () => {
    expect(packageOf("services/jmap/src/methods/email.ts")).toBe("services/jmap");
    expect(packageOf("packages/auth-core/src/index.ts")).toBe("packages/auth-core");
  });

  it("folds absolute summary keys into per-package line totals", () => {
    const root = "/repo";
    const summary = summaryFor(
      {
        "packages/mime/src/a.ts": [90, 100],
        "packages/mime/src/b.ts": [10, 100],
        "services/jmap/src/index.ts": [50, 50],
      },
      root,
    );
    expect(aggregate(summary, root)).toEqual({
      "packages/mime": { covered: 100, total: 200 },
      "services/jmap": { covered: 50, total: 50 },
    });
  });

  it("floors, and does not produce float artefacts", () => {
    // (83 / 100) * 100 is 83.00000000000001 in IEEE754; integer math first.
    expect(floorPct({ covered: 83, total: 100 })).toBe(83);
    expect(floorPct({ covered: 8299, total: 10_000 })).toBe(82);
    expect(floorPct({ covered: 1, total: 1 })).toBe(100);
    // A package with nothing measurable cannot regress.
    expect(floorPct({ covered: 0, total: 0 })).toBe(100);
  });
});

describe("the gate", () => {
  const base = { slack: 2, packages: { "packages/a": 80, "packages/b": 50 } };

  it("passes when every package sits on its floor", () => {
    const got = evaluate({ "packages/a": { covered: 80, total: 100 }, "packages/b": { covered: 50, total: 100 } }, base);
    expect(got.ok).toBe(true);
  });

  it("fails when a package drops below its floor", () => {
    const got = evaluate({ "packages/a": { covered: 79, total: 100 }, "packages/b": { covered: 50, total: 100 } }, base);
    expect(got.ok).toBe(false);
    expect(got.failures.map((f: { name: string; status: string }) => [f.name, f.status])).toEqual([
      ["packages/a", "regressed"],
    ]);
  });

  it("does NOT flap on sub-point drift — the whole point of whole percent", () => {
    // 80.99% → 80.01%: a real fall, entirely inside one percentage point, and
    // exactly the shape of noise that makes people delete a coverage gate.
    const got = evaluate(
      { "packages/a": { covered: 8001, total: 10_000 }, "packages/b": { covered: 50, total: 100 } },
      base,
    );
    expect(got.ok).toBe(true);
  });

  it("lets a modest gain land without touching the baseline", () => {
    const got = evaluate({ "packages/a": { covered: 82, total: 100 }, "packages/b": { covered: 50, total: 100 } }, base);
    expect(got.ok).toBe(true);
  });

  it("asks for a gain beyond the slack to be recorded, so the floor advances", () => {
    // Without this the ratchet is only ever a floor: coverage climbs to 90,
    // nobody writes it down, and it is free to slide back to 80.
    const got = evaluate({ "packages/a": { covered: 90, total: 100 }, "packages/b": { covered: 50, total: 100 } }, base);
    expect(got.ok).toBe(false);
    expect(got.failures[0]).toMatchObject({ name: "packages/a", status: "unrecorded", pct: 90 });
  });

  it("reports a brand-new package without blocking it", () => {
    // Adding a module that resists unit tests is legitimate work. It shows up
    // in the summary and gets a floor at the next `npm run coverage:baseline`.
    const got = evaluate(
      {
        "packages/a": { covered: 80, total: 100 },
        "packages/b": { covered: 50, total: 100 },
        "services/new": { covered: 0, total: 400 },
      },
      base,
    );
    expect(got.ok).toBe(true);
    expect(got.rows.find((r: { name: string }) => r.name === "services/new")).toMatchObject({ status: "new", pct: 0 });
  });

  it("reports a deleted package without blocking it", () => {
    const got = evaluate({ "packages/a": { covered: 80, total: 100 } }, base);
    expect(got.ok).toBe(true);
    expect(got.rows.find((r: { name: string }) => r.name === "packages/b")).toMatchObject({ status: "gone" });
  });

  it("KNOWN COST: deleting a well-covered file inside a package still trips it", () => {
    // packages/a is 80/100. Delete a file that was 20/20 — no test was removed,
    // yet the package reads 60/80 = 75%. No percentage metric escapes this; the
    // answer is the escape hatch (lower the floor in the same PR, in the diff),
    // not a cleverer number. Pinned here so the cost stays known rather than
    // rediscovered by whoever hits it.
    const got = evaluate({ "packages/a": { covered: 60, total: 80 }, "packages/b": { covered: 50, total: 100 } }, base);
    expect(got.ok).toBe(false);
    expect(got.failures[0]).toMatchObject({ status: "regressed", pct: 75 });
  });
});

describe("lowering a floor is allowed, and loud", () => {
  it("names every floor the branch moved down", () => {
    const before = { packages: { "packages/a": 80, "packages/b": 50 } };
    const after = { packages: { "packages/a": 70, "packages/b": 60 } };
    expect(lowered(before, after)).toEqual([{ name: "packages/a", from: 80, to: 70 }]);
  });

  it("keeps the note and slack when the baseline is rewritten", () => {
    const prev = { note: "hand-written", slack: 5, packages: { "packages/a": 1 } };
    expect(nextBaseline({ "packages/a": { covered: 9, total: 10 } }, prev)).toEqual({
      note: "hand-written",
      slack: 5,
      packages: { "packages/a": 90 },
    });
  });
});

describe("end to end, over real files", () => {
  const fixture = (files: Record<string, [number, number]>, baseline: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
    const cov = join(dir, "summary.json");
    const bl = join(dir, "baseline.json");
    writeFileSync(cov, JSON.stringify(summaryFor(files, dir)));
    writeFileSync(bl, JSON.stringify(baseline));
    return { root: dir, coverage: cov, baseline: bl };
  };

  it("fails, with a pasteable replacement baseline, when coverage falls", () => {
    const f = fixture({ "packages/a/src/x.ts": [70, 100] }, { slack: 2, packages: { "packages/a": 80 } });
    const got = run(f);
    expect(got.ok).toBe(false);
    expect(got.log).toContain("::error::");
    expect(got.markdown).toContain("below floor");
    // The remedy has to be copy-pasteable or people will just delete the check.
    expect(got.markdown).toContain('"packages/a": 70');
  });

  it("passes when coverage rises within the slack", () => {
    const f = fixture({ "packages/a/src/x.ts": [82, 100] }, { slack: 2, packages: { "packages/a": 80 } });
    expect(run(f).ok).toBe(true);
  });

  it("does not fail the build merely because no baseline exists yet", () => {
    const f = fixture({ "packages/a/src/x.ts": [82, 100] }, {});
    const got = run({ ...f, baseline: join(f.root, "absent.json") });
    expect(got.ok).toBe(true);
    expect(got.log).toContain("nothing to ratchet against");
  });
});
