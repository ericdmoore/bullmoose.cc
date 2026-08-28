import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEPLOY_ORDER } from "./bootstrap.mjs";
import { NOT_INCLUDED } from "./stackBundle.mjs";

// A worker can exist in services/ and ship to nobody, and nothing says so.
//
// deployOrder.test.ts already pins that CI and bootstrap agree with EACH
// OTHER — but both are lists of what IS deployed, so a service missing from
// both is invisible to it. That is exactly how a new worker goes unnoticed:
// it passes its own tests, it works under `wrangler dev`, and it is simply
// never deployed anywhere. The gap was found while adding services/webpreview
// as the third such service; demo-keys had been sitting in it.
//
// So: every worker is either DEPLOYED or deliberately EXCLUDED WITH A REASON.
// Silence is the one option removed.

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** Every services/<name> that is actually a deployable worker. */
function servicesWithConfigs(): string[] {
  return readdirSync(join(ROOT, "services"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(ROOT, "services", e.name, "wrangler.jsonc")))
    .map((e) => e.name)
    .sort();
}

describe("every worker in services/ is accounted for", () => {
  it("is either in DEPLOY_ORDER or named in NOT_INCLUDED", () => {
    const unaccounted = servicesWithConfigs().filter((s) => !DEPLOY_ORDER.includes(s) && !(s in NOT_INCLUDED));
    expect(
      unaccounted,
      `services/${unaccounted.join(", ")} has a wrangler.jsonc but is in neither list.\n` +
        `Either add it to DEPLOY_ORDER in infra/bootstrap.mjs (and the matching\n` +
        `\`- name: Deploy <it>\` step in deploy-mail.yml), or add it to NOT_INCLUDED\n` +
        `in infra/stackBundle.mjs with the reason a stranger would want.`,
    ).toEqual([]);
  });

  it("nothing is in both lists", () => {
    // A worker that is deployed AND documented as excluded means the manifest
    // tells a stranger it is absent while the stack ships it.
    const both = DEPLOY_ORDER.filter((s) => s in NOT_INCLUDED);
    expect(both, `${both.join(", ")} is deployed but the manifest says it is not included`).toEqual([]);
  });

  it("every exclusion gives a reason, not just a name", () => {
    for (const [name, reason] of Object.entries(NOT_INCLUDED)) {
      expect(typeof reason, `${name}'s exclusion reason must be a string`).toBe("string");
      // "TODO" or "" is how an exclusion stops explaining itself.
      expect(reason.length, `${name} is excluded without a usable reason`).toBeGreaterThan(20);
    }
  });

  it("NOT_INCLUDED does not name a service that no longer exists", () => {
    const present = servicesWithConfigs();
    const ghosts = Object.keys(NOT_INCLUDED).filter((s) => !present.includes(s));
    expect(ghosts, `${ghosts.join(", ")} is excluded but services/ has no such worker`).toEqual([]);
  });
});
