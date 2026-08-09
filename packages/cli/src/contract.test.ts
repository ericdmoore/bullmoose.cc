import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The composition smoke test — sVOL `016`'s acceptance signal, wired into
 * `npm test` so the contract cannot regress silently.
 *
 * `.plans/s05-cli-crud/devPlan.md`: *"a composition smoke script that actually
 * pipes … That script is the real acceptance signal — the contract in arch.md
 * §1 is about behaviour under pipes, which unit tests alone can't observe."*
 *
 * It is exactly right that unit tests cannot observe it. A process cannot see
 * its own EPIPE, its own exit code, or whether `--ids | xargs` composes; those
 * are properties of the process boundary. So `smoke/contract.mjs` builds the
 * CLI, starts a loopback stub server (`smoke/server.mjs`), and drives the real
 * binary through a real `sh` with real pipes — `head` closing the read end
 * early, `xargs` fanning ids back in, `awk` reading columns. This wrapper runs
 * it and surfaces its report.
 *
 * Run it alone (much faster feedback than the whole suite):
 *   npm run -w @bullmoose/cli smoke
 */

const SCRIPT = fileURLToPath(new URL("../smoke/contract.mjs", import.meta.url));

describe("the I/O contract, under real pipes", () => {
  it(
    "passes every clause of arch.md §1",
    () => {
      const run = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        timeout: 120_000,
        // Colour is one of the things under test; do not let a CI environment
        // preset decide the answer.
        env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "" },
      });

      const report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      // Assert on the report rather than only the exit code, so a failure names
      // the clause that broke instead of saying "exit 1".
      expect(report, report).not.toMatch(/^FAIL /m);
      expect(run.status, report).toBe(0);

      // Guard against the script passing vacuously — an empty run also has no
      // FAIL lines and exits 0.
      const checks = [...report.matchAll(/^ok {3}§/gm)].length;
      expect(checks, `only ${checks} clause checks ran:\n${report}`).toBeGreaterThanOrEqual(30);
    },
    // Builds the package and spawns ~40 processes; ~4s locally, generous here.
    120_000,
  );
});
