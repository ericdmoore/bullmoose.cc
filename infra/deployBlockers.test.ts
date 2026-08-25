import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MIGRATIONS } from "./migrations.mjs";
import { PHASES } from "./bootstrap.mjs";

// On 2026-08-24 deploy-mail.yml shipped code whose queries name `ceremonies`
// and `emails.assurance_json` against a shard that had neither. The agent's
// cron threw every five minutes; ingest threw on every inbound message, so
// Email Routing bounced mail for ~14 hours — surfaced by a human receiving a
// bounce, not by an alarm.
//
// The knowledge was already in the repo. `emails-assurance-json` carried
// `blocks: "deploy"`, and migrations.test.ts pinned it with the sentence
// "ingest against an un-migrated shard fails EVERY delivery". Nothing in any
// deploy path read that field.
//
// migrations.test.ts pins WHICH migrations are blockers. This file pins that
// being a blocker MEANS something.

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

describe('`blocks: "deploy"` is enforced, not decorative', () => {
  it("bootstrap exposes a `blockers` phase", () => {
    expect(Object.keys(PHASES)).toContain("blockers");
  });

  it("the deploy phase runs it, so `bootstrap.mjs deploy` cannot skip the gate", () => {
    // Calling the deploy phase directly is exactly how someone reaches
    // production without passing through `migrate`.
    const src = readFileSync(join(ROOT, "infra/bootstrap.mjs"), "utf8");
    const deployFn = src.slice(src.indexOf("function deploy()"));
    const body = deployFn.slice(0, deployFn.indexOf("\n}"));
    expect(body, "deploy() does not call blockers()").toContain("blockers()");
  });

  it("CI gates on it BEFORE the first worker ships", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/deploy-mail.yml"), "utf8");
    const gate = wf.indexOf("bootstrap.mjs blockers");
    const firstDeploy = wf.indexOf("- name: Deploy ");
    expect(gate, "deploy-mail.yml never runs the blockers gate").toBeGreaterThan(-1);
    expect(firstDeploy).toBeGreaterThan(-1);
    expect(gate, "the gate must run before the first Deploy step, not after").toBeLessThan(firstDeploy);
  });

  it("every blocker carries the sentence the gate will print", () => {
    // The refusal is only actionable if it can say what breaks. An empty or
    // stub `why` turns a precise refusal into "something is wrong".
    for (const m of MIGRATIONS.filter((x) => x.blocks === "deploy")) {
      expect(typeof m.why, `${m.id} has no why`).toBe("string");
      expect(m.why.length, `${m.id}'s why is too thin to act on`).toBeGreaterThan(30);
      expect(typeof m.check, `${m.id} has no check for the gate to run`).toBe("string");
    }
  });

  it("the outage's own two migrations are still marked", () => {
    // Regression pin: whatever else changes, these two caused a mail outage
    // and must never quietly lose their blocker status.
    const ids = MIGRATIONS.filter((m) => m.blocks === "deploy").map((m) => m.id);
    expect(ids).toContain("emails-assurance-json");
  });
});

describe("the empirical check runs after what it checks", () => {
  it("the delivery smoke test runs AFTER every worker ships", () => {
    // It is testing the deploy that just happened; running it earlier would
    // test the previous one and report the wrong verdict.
    const wf = readFileSync(join(ROOT, ".github/workflows/deploy-mail.yml"), "utf8");
    const smoke = wf.indexOf("- name: Does mail actually deliver?");
    expect(smoke, "deploy-mail.yml never runs the delivery check").toBeGreaterThan(-1);
    expect(smoke, "the smoke test must run after the last Deploy step").toBeGreaterThan(
      wf.lastIndexOf("- name: Deploy "),
    );
  });

  it("an unconfigured smoke test exits 2 — it must never report success", () => {
    // The failure this whole arc was about: a marker nobody reads. A check
    // that silently passes when it did not run is the same bug wearing a
    // different hat.
    const src = readFileSync(join(ROOT, "tools/smoke-mail.mjs"), "utf8");
    expect(src).toContain("process.exit(2)");
    expect(src, "the unconfigured path must say why it is not a pass").toMatch(/must not report success/i);
  });
});

describe("workers are not silent", () => {
  it("every deployable worker has observability enabled", () => {
    // The 14-hour outage had to be diagnosed with `wrangler tail` and a
    // GraphQL analytics query because not one mail worker emitted logs. The
    // exception existed the whole time with nowhere to be read.
    const missing: string[] = [];
    for (const d of readdirSync(join(ROOT, "services"))) {
      const p = join(ROOT, "services", d, "wrangler.jsonc");
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      let cfg: { observability?: { enabled?: boolean } };
      try {
        cfg = JSON.parse(raw);
      } catch (e) {
        throw new Error(`services/${d}/wrangler.jsonc does not parse: ${(e as Error).message}`);
      }
      if (!cfg.observability?.enabled) missing.push(d);
    }
    expect(missing, `these workers would fail silently in production: ${missing.join(", ")}`).toEqual([]);
  });
});
