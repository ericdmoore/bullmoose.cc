import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error — bootstrap is plain .mjs, deliberately outside the TS program
import { ALL, PHASES, exploreRegistrationPlan, exploreSwitch } from "./bootstrap.mjs";

/**
 * `bootstrap explorer` turns s21 on. Three of its four steps talk to the
 * network and cannot be asserted here without a live account — so this file
 * tests the parts that are DECIDABLE, which happen to be the parts where a
 * mistake is silent:
 *
 *   • the wrangler.jsonc edit is reversible to the byte, so `--off` leaves no
 *     stray diff and `on → off → on` is a no-op;
 *   • `explorer` is not in ALL, so an ordinary deploy never publishes a
 *     read-everything hostname;
 *   • a second run does not register a second OAuth client, which would orphan
 *     a credential-issuing registration nobody can enumerate;
 *   • `--dry-run` writes nothing and — asserted by killing `fetch` in the
 *     child — calls nothing.
 *
 * Each of those is a property whose failure produces no error message at all.
 */

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = resolve(ROOT, "services/jmap/wrangler.jsonc");
const committed = readFileSync(CONFIG, "utf8");

/** Whole-line `//` comments out, so JSON.parse can judge the result. */
function stripJsonc(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("exploreSwitch — the route/binding toggle in services/jmap/wrangler.jsonc", () => {
  it("1. the committed file is OFF, which is the whole design", () => {
    // If this ever fails, the explorer got committed in the on state and every
    // deployment of this repo publishes explore.bullmoose.cc on its next
    // deploy. `.plans/s21-explorer` open question 2: off by default is not a
    // preference, it is the reason a read-everything surface is tolerable.
    const parsed = JSON.parse(stripJsonc(committed));
    expect(JSON.stringify(parsed.routes)).not.toContain("explore.bullmoose.cc");
    expect(JSON.stringify(parsed.services)).not.toContain("OAUTH");
  });

  it("2. turning it on uncomments exactly the route and the OAUTH binding", () => {
    const on = exploreSwitch(committed, true);
    expect(on.changed).toBe(true);
    expect(on.toggled.sort()).toEqual(["OAUTH binding", "route"]);
    expect(on.missing).toEqual([]);

    const parsed = JSON.parse(stripJsonc(on.text));
    expect(parsed.routes).toContainEqual({
      pattern: "explore.bullmoose.cc/*",
      zone_name: "bullmoose.cc",
    });
    expect(parsed.services).toContainEqual({ binding: "OAUTH", service: "bullmoose-oauth" });
  });

  it("3. it changes ONLY those two lines", () => {
    const on = exploreSwitch(committed, true);
    const before = committed.split("\n");
    const after = on.text.split("\n");
    expect(after.length).toBe(before.length);
    const moved = before.map((l, i) => [i, l, after[i]] as const).filter(([, a, b]) => a !== b);
    expect(moved.length).toBe(2);
    // And the only thing that moved is the comment marker.
    for (const [, a, b] of moved) expect(a).toBe(b!.replace(/^(\s*)/, "$1// "));
  });

  it("4. uncomment → comment → uncomment reproduces the original bytes", () => {
    // The property `--off` depends on. A toggle that re-indented, dropped a
    // trailing newline or normalised the leading comma would leave a diff on
    // every on/off cycle, and the operator would stop reading those diffs.
    const on = exploreSwitch(committed, true);
    const off = exploreSwitch(on.text, false);
    expect(off.changed).toBe(true);
    expect(off.text).toBe(committed);

    const onAgain = exploreSwitch(off.text, true);
    expect(onAgain.text).toBe(on.text);
  });

  it("5. is idempotent in both directions — a second call changes nothing", () => {
    const on = exploreSwitch(committed, true);
    const again = exploreSwitch(on.text, true);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(on.text);
    expect(again.already.sort()).toEqual(["OAUTH binding", "route"]);

    const stillOff = exploreSwitch(committed, false);
    expect(stillOff.changed).toBe(false);
    expect(stillOff.text).toBe(committed);
    expect(stillOff.already.sort()).toEqual(["OAUTH binding", "route"]);
  });

  it("6. reports a missing anchor instead of inventing a line", () => {
    // A file that drifted from bootstrap's literals must produce a warning, not
    // a second copy of the route appended somewhere plausible.
    const drifted = committed.replace(/^.*"binding": "OAUTH".*$/m, "");
    const r = exploreSwitch(drifted, true);
    expect(r.missing).toEqual(["OAUTH binding"]);
    expect(r.toggled).toEqual(["route"]);
  });
});

describe("exploreRegistrationPlan — registering twice is the hazard", () => {
  it("7. a first run registers a PUBLIC client at the fixed redirect URI", () => {
    const plan = exploreRegistrationPlan({});
    expect(plan.register).toBe(true);
    expect(plan.url).toBe("https://auth.bullmoose.cc/register");
    expect(plan.body.token_endpoint_auth_method).toBe("none");
    expect(plan.body.redirect_uris).toEqual(["https://explore.bullmoose.cc/oauth/callback"]);
  });

  it("8. a second run does NOT register again once EXPLORE_CLIENT_ID is set", () => {
    // THE test. Dynamic client registration has no natural key and the AS
    // offers the operator no way to list clients, so a re-registration leaves a
    // live, credential-issuing client pointed at the explorer's redirect URI
    // that nobody can find or revoke. Nothing about that failure is visible:
    // the phase prints a cheerful ✓ either way.
    const plan = exploreRegistrationPlan({ EXPLORE_CLIENT_ID: "client_already_registered" });
    expect(plan.register).toBe(false);
    expect(plan.url).toBeUndefined();
    expect(plan.body).toBeUndefined();
  });

  it("9. honours EXPLORE_ISSUER and strips its trailing slash", () => {
    const plan = exploreRegistrationPlan({ EXPLORE_ISSUER: "https://auth.example.test/" });
    expect(plan.url).toBe("https://auth.example.test/register");
  });
});

describe("the phase is opt-in", () => {
  it("10. `explorer` exists as a phase", () => {
    // Guards the next test from passing vacuously: "absent from ALL" is worth
    // nothing if the phase is absent from everything.
    expect(typeof PHASES.explorer).toBe("function");
  });

  it("11. `explorer` is NOT in ALL", () => {
    // A default `node infra/bootstrap.mjs` must never turn on a surface that
    // mirrors, read-only, everything the caller can see. If someone adds it
    // here for convenience, the person surprised by a live
    // explore.bullmoose.cc is whoever ran the ordinary deploy command.
    expect(ALL).not.toContain("explorer");
    // doctor is out for its own reasons (read-only); assert it too so the list
    // cannot quietly grow either kind of phase.
    expect(ALL).not.toContain("doctor");
    expect(ALL).toEqual(["resources", "wire", "schemas", "migrate", "secrets", "deploy"]);
  });
});

describe("--dry-run touches nothing", () => {
  it("12. writes no file and makes no network call", () => {
    // `--dry-run` is the only safe way to inspect this phase against a real
    // account, so "it previews" has to be true of the NETWORK as well as the
    // filesystem: a dry run that registered an OAuth client, or created a DNS
    // record, would have done the two things that are hardest to undo.
    //
    // Enforced rather than reviewed: the child gets a preload that replaces
    // `fetch` with a throw, so any call at all fails the run.
    const preloadDir = mkdtempSync(resolve(tmpdir(), "bm-explorer-dry-"));
    const preload = resolve(preloadDir, "nofetch.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = () => { throw new Error("NETWORK CALL DURING --dry-run"); };\n`,
    );

    const envPath = resolve(ROOT, ".env");
    const envBefore = existsSync(envPath) ? readFileSync(envPath) : null;

    const out = execFileSync(
      process.execPath,
      ["--import", `file://${preload}`, resolve(ROOT, "infra/bootstrap.mjs"), "explorer", "--dry-run"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    // The config is byte-identical — the edit was previewed, not applied.
    expect(readFileSync(CONFIG, "utf8")).toBe(committed);
    // .env is neither created nor rewritten.
    const envAfter = existsSync(envPath) ? readFileSync(envPath) : null;
    expect(envAfter === null ? null : envAfter.toString("base64")).toBe(
      envBefore === null ? null : envBefore.toString("base64"),
    );

    // And it actually ran all four steps rather than bailing early — otherwise
    // "no writes" would be true for an uninteresting reason.
    expect(out).toContain("explore.bullmoose.cc");
    expect(out).toContain("would ensure AAAA");
    expect(out).toContain("would uncomment");
    expect(out).toContain("would POST https://auth.bullmoose.cc/register");
    expect(out).toContain("node infra/bootstrap.mjs deploy");
  });

  it("13. --off previews the reversal and still writes nothing", () => {
    const preloadDir = mkdtempSync(resolve(tmpdir(), "bm-explorer-off-"));
    const preload = resolve(preloadDir, "nofetch.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = () => { throw new Error("NETWORK CALL DURING --dry-run"); };\n`,
    );

    const out = execFileSync(
      process.execPath,
      [
        "--import",
        `file://${preload}`,
        resolve(ROOT, "infra/bootstrap.mjs"),
        "explorer",
        "--off",
        "--dry-run",
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(readFileSync(CONFIG, "utf8")).toBe(committed);
    expect(out).toContain("would delete every DNS record");
    // The honesty requirement: --off must say what it leaves behind.
    expect(out).toContain("what --off does NOT undo");
    expect(out).toContain("/revoke");
  });
});
