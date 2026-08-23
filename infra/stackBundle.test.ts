import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildManifest, shippableMigrations } from "./stackBundle.mjs";
import { DEPLOY_ORDER, EXTERNAL, GENERATED } from "./bootstrap.mjs";
import { MIGRATIONS } from "./migrations.mjs";

// s46 T1. Two properties carry the safety story, so they get tests rather
// than trust: the test-only `absent` blocks never ship (they are statements
// that BUILD broken schema — handing them to `cloud update` is the exact
// confusion the strip exists to prevent), and the manifest cannot name a
// file the bundle does not contain (a manifest that lists phantom files
// turns the installer's download step into a 404 it would misread as "the
// mirror is broken").

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

describe("shippableMigrations", () => {
  it("strips `absent` from every real migration and keeps the rest verbatim", () => {
    const shipped = shippableMigrations(MIGRATIONS);
    expect(shipped).toHaveLength(MIGRATIONS.length);
    for (const [i, m] of shipped.entries()) {
      expect(m).not.toHaveProperty("absent");
      expect(m.id).toBe(MIGRATIONS[i]!.id); // order is the upgrade order
      expect(m.up).toEqual(MIGRATIONS[i]!.up);
      expect(typeof m.check).toBe("string"); // plain SQL, JSON-safe by that module's contract
    }
  });
});

describe("buildManifest", () => {
  const files = Object.fromEntries(
    DEPLOY_ORDER.flatMap((w) => [
      [`workers/${w}/index.js`, "aa"],
      [`workers/${w}/wrangler.jsonc`, "bb"],
    ]),
  );

  const build = (over: Record<string, unknown> = {}) =>
    buildManifest({
      version: "v1.2.3",
      gitSha: "abc",
      deployOrder: DEPLOY_ORDER,
      files,
      migrationCount: 3,
      generated: GENERATED,
      external: EXTERNAL,
      ...over,
    });

  it("carries the deploy order verbatim and links per the house JSON rule", () => {
    const m = build();
    expect(m.deployOrder).toEqual(DEPLOY_ORDER);
    expect(m.workers.map((w: { name: string }) => w.name)).toEqual(DEPLOY_ORDER);
    expect(m._links.self.href).toBe("https://dl.bullmoose.cc/stack/v1.2.3/manifest.json");
    expect(m._links.latest.href).toBe("https://dl.bullmoose.cc/stack/latest.txt");
  });

  it("refuses to name a file the bundle does not contain", () => {
    const missingOne = { ...files };
    delete missingOne["workers/jmap/index.js"];
    expect(() => build({ files: missingOne })).toThrow(/workers\/jmap\/index\.js/);
  });

  it("ships both halves of the secrets story, names and shapes only", () => {
    const m = build();
    // Verbatim from bootstrap.mjs — the installer mints `generated` locally
    // and asks the operator for `external`; the notes are the ask.
    expect(m.secrets.generated).toEqual(GENERATED);
    expect(m.secrets.external).toEqual(EXTERNAL);
    for (const spec of Object.values(m.secrets.generated) as Array<{ bytes: number; workers: string[] }>) {
      expect(spec.bytes).toBeGreaterThanOrEqual(24); // shapes, never values
    }
  });

  it("VAULT_MASTER_KEY has one home, in the manifest too", () => {
    // s04 T3a's platform guarantee, re-pinned at the layer every installer
    // reads: add a second worker here and every install on earth binds the
    // vault key into it. bootstrap.mjs documents the rule; the shipped
    // manifest must not be able to drift from it.
    expect(build().secrets.generated.VAULT_MASTER_KEY.workers).toEqual(["bureau"]);
  });
});

describe("the bundler's inputs exist", () => {
  // Cheap existence pins so a rename fails HERE, with the bundler named,
  // rather than in a tagged release run.
  it("every DEPLOY_ORDER worker has the wrangler config the bundler copies", () => {
    for (const w of DEPLOY_ORDER) {
      expect(existsSync(join(ROOT, `services/${w}/wrangler.jsonc`)), w).toBe(true);
    }
  });
  it("the schema files ship from where the bundler reads them", () => {
    for (const f of ["control-plane.sql", "data-plane.sql"]) {
      expect(existsSync(join(ROOT, "packages/mailstore/sql", f)), f).toBe(true);
    }
  });
});
