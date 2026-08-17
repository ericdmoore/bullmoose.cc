import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ALL, DEPLOY_ORDER } from "./bootstrap.mjs";

// Two lists name the same thing and neither knew about the other: the workers
// `infra/bootstrap.mjs` deploys, and the workers `.github/workflows/
// deploy-mail.yml` deploys. They drifted, and the drift was invisible for the
// worst possible reason — the missing one still WORKED.
//
// `bullmoose-oauth` was in bootstrap's DEPLOY_ORDER and in no CI step. It had
// been deployed by hand once, so auth.bullmoose.cc answered and nothing looked
// broken; meanwhile nine commits' worth of authorization-server changes —
// including token revocation — merged to main and never reached production.
// A worker that is deployed but never REdeployed is the quietest failure in
// this repo: green CI, green tests, stale authorization.
//
// So: the two orders must be identical, element for element. Not "the same
// set" — the ORDER carries the service-binding dependencies (a binding to a
// worker that was never deployed fails the deploy that declares it), and a set
// comparison would let oauth land after agent and fail on a fresh account.

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOW = join(ROOT, ".github/workflows/deploy-mail.yml");

/** The workers CI deploys, in the order its steps run. */
function ciDeployOrder(): string[] {
  const yml = readFileSync(WORKFLOW, "utf8");
  // Deliberately a line scan rather than a YAML parse: what matters is the
  // order the steps appear in the file, which is the order they run.
  return [...yml.matchAll(/^\s*-\s*name:\s*Deploy\s+(\S+)\s*$/gm)].map((m) => m[1]!);
}

describe("the deploy order is the same in both places that declare it", () => {
  it("CI deploys exactly the workers bootstrap deploys, in the same order", () => {
    const ci = ciDeployOrder();
    expect(
      ci.length,
      "found no `- name: Deploy <worker>` steps — did the workflow move?",
    ).toBeGreaterThan(0);
    expect(
      ci,
      `deploy-mail.yml and infra/bootstrap.mjs disagree.\n` +
        `  CI:        ${ci.join(" → ")}\n` +
        `  bootstrap: ${DEPLOY_ORDER.join(" → ")}\n` +
        `A worker in bootstrap but not CI still WORKS until someone changes it — ` +
        `it just silently stops being redeployed. That is how services/oauth ran ` +
        `nine commits behind main.`,
    ).toEqual([...DEPLOY_ORDER]);
  });

  it("every deployed worker has a wrangler config where the step says it does", () => {
    for (const w of DEPLOY_ORDER) {
      const cfg = join(ROOT, "services", w, "wrangler.jsonc");
      expect(
        () => readFileSync(cfg, "utf8"),
        `${w} is deployed but ${cfg} is missing`,
      ).not.toThrow();
    }
  });

  it("`deploy` is a phase in ALL — the default run still ships every worker", () => {
    // The counterpart hazard: someone fixes a drift by removing a worker from
    // bootstrap rather than adding it to CI.
    expect(ALL).toContain("deploy");
  });
});
