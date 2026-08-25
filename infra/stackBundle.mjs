// s46 T1 — the stack, packaged as downloads.
//
// `bullmoose cloud install` (s46) downloads instead of builds: no Node, no
// checkout — the same move that freed the CLI itself. That only works if the
// deployable stack EXISTS as artifacts somewhere, and this script is what
// makes them: worker bundles, their wrangler configs, the D1 schema, the
// upgrade migrations, the built webmail, one manifest, one checksums file.
//
// Run by .github/workflows/release-stack.yml on a `stack/v*` tag; runnable
// locally the same way (wrangler --dry-run needs no account):
//
//   npm run -w webmail build
//   node infra/stackBundle.mjs --version dev-local --outdir dist/stack
//
// Layout under --outdir (mirrors the popcorn/cli bucket layout, uploaded to
// dl.bullmoose.cc/stack/<version>/ with latest.txt flipped LAST):
//
//   manifest.json                 what everything is, with sha256s and _links
//   checksums.txt                 sha256 of every other file, written last
//   workers/<name>/index.js       the bundle wrangler would upload
//   workers/<name>/wrangler.jsonc the config, verbatim — bindings, routes,
//                                 DO migrations; the installer's plan step
//                                 parses THIS rather than a second dialect
//   schema/control-plane.sql      fresh-install DDL (idempotent CREATEs)
//   schema/data-plane.sql
//   migrations.json               infra/migrations.mjs minus the test-only
//                                 `absent` blocks — what `cloud update` runs
//   webmail.tar.gz                the built Astro output, uploaded to R2 and
//                                 served by services/webhost
//
// Deliberately NOT shipped:
//   - sourcemaps. The bundles are public by decision (that is what lets a
//     stranger run the stack); the .map files embed the repo's full source
//     text via sourcesContent, which is a different decision nobody made.
//   - services/demo-keys and services/webpreview. Absent from DEPLOY_ORDER on
//     purpose; NOT_INCLUDED below is the registry, and the manifest carries it
//     so a reader of dl.bullmoose.cc learns the exclusions there rather than
//     by diffing services/ against deployOrder.

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DEPLOY_ORDER, EXTERNAL, GENERATED } from "./bootstrap.mjs";
import { MIGRATIONS } from "./migrations.mjs";

const ROOT = join(import.meta.dirname, "..");

/**
 * Workers that exist in services/ and are deliberately NOT part of the
 * published stack, each with the reason a stranger would want.
 *
 * Kept as an explicit registry rather than a comment because
 * infra/servicesAccountedFor.test.ts asserts every services/*\/wrangler.jsonc
 * is either in DEPLOY_ORDER or named here. A new worker that is in neither is
 * the shape that goes unnoticed: it works locally, ships to nobody, and
 * nothing says so.
 */
export const NOT_INCLUDED = {
  "demo-keys": "absent from DEPLOY_ORDER; needs its own resource/secret story (.feedback/fromClaude/infra/013)",
  sitehost:
    "this site, not the product — it serves bullmoose.cc's own marketing + guides pages from a bucket only this repo fills (ships from .github/workflows/deploy.yml)",
  webpreview:
    "this repository's review tooling, not product — it serves pull-request previews on preview-*.bullmoose.cc, and an install has no pull requests to preview (ships from .github/workflows/deploy-webpreview.yml)",
};
const DOWNLOAD_BASE = "https://dl.bullmoose.cc/stack";

/**
 * The migrations, stripped for shipping. `absent` builds the broken database
 * a round-trip TEST needs and must never travel: shipping it hands `cloud
 * update` a list of statements that DESTROY schema if anything ever confuses
 * the two. `check`/`up` are plain SQL strings by that module's own contract
 * (D1 and node:sqlite alike), so JSON carries them losslessly.
 */
export function shippableMigrations(migrations) {
  return migrations.map(({ id, why, blocks, check, up }) => ({ id, why, blocks, check, up }));
}

/**
 * The manifest — versioned, checksummed, and navigable with nothing but a
 * pretty-printer (_links, per the house JSON rule). `files` maps every
 * relative path in the bundle to its sha256; `deployOrder` rides verbatim
 * from bootstrap.mjs so there is no third copy of the binding graph to
 * drift (deployOrder.test.ts already pins the second).
 *
 * `secrets` is the other bootstrap knowledge the installer needs and the
 * wrangler configs do not carry: which secrets to MINT locally (s46's
 * custody rule — everything generated lands only in the user's account and
 * config, the project sees nothing) and which the operator must SUPPLY,
 * with the note that tells them what to go get. Names and shapes only —
 * the same names the public bundles already reference as env.*.
 */
export function buildManifest({ version, gitSha, deployOrder, files, migrationCount, generated, external }) {
  const workers = deployOrder.map((name) => ({
    name,
    bundle: `workers/${name}/index.js`,
    config: `workers/${name}/wrangler.jsonc`,
  }));
  for (const w of workers) {
    for (const f of [w.bundle, w.config]) {
      if (!(f in files)) throw new Error(`manifest lists ${f} but the bundle does not contain it`);
    }
  }
  return {
    manifestVersion: 1,
    version,
    gitSha,
    deployOrder,
    workers,
    schema: ["schema/control-plane.sql", "schema/data-plane.sql"],
    migrations: { file: "migrations.json", count: migrationCount },
    secrets: { generated, external },
    webmail: "webmail.tar.gz",
    notIncluded: NOT_INCLUDED,
    files,
    _links: {
      self: { href: `${DOWNLOAD_BASE}/${version}/manifest.json` },
      checksums: { href: `${DOWNLOAD_BASE}/${version}/checksums.txt` },
      latest: { href: `${DOWNLOAD_BASE}/latest.txt` },
    },
  };
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under dir, as sorted bundle-relative paths. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) throw new Error(`missing ${flag} <value>`);
    return args[i + 1];
  };
  const version = get("--version");
  const outdir = join(ROOT, get("--outdir"));

  // The webmail build is the workflow's step (it owns Node setup and the
  // build cache); packaging refuses honestly rather than shipping a stale or
  // absent app under a fresh version number.
  const webmailDist = join(ROOT, "webmail/dist");
  if (!existsSync(join(webmailDist, "index.html"))) {
    throw new Error("webmail/dist is not a built app — run `npm run -w webmail build` first");
  }

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  for (const name of DEPLOY_ORDER) {
    const dest = join(outdir, "workers", name);
    console.log(`bundling ${name}…`);
    execFileSync(
      "npx",
      ["--yes", "wrangler@4", "deploy", "-c", `services/${name}/wrangler.jsonc`, "--dry-run", `--outdir=${dest}`],
      {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    // wrangler emits the bundle plus a sourcemap and a README; only the
    // bundle ships (the .map embeds the repo's source — see header).
    for (const extra of readdirSync(dest)) {
      if (extra !== "index.js") rmSync(join(dest, extra), { recursive: true });
    }
    cpSync(join(ROOT, `services/${name}/wrangler.jsonc`), join(dest, "wrangler.jsonc"));
  }

  mkdirSync(join(outdir, "schema"), { recursive: true });
  for (const f of ["control-plane.sql", "data-plane.sql"]) {
    cpSync(join(ROOT, "packages/mailstore/sql", f), join(outdir, "schema", f));
  }
  writeFileSync(join(outdir, "migrations.json"), JSON.stringify(shippableMigrations(MIGRATIONS), null, 2) + "\n");
  execFileSync("tar", ["-czf", join(outdir, "webmail.tar.gz"), "-C", webmailDist, "."]);

  const files = {};
  for (const f of walk(outdir)) files[f] = sha256(join(outdir, f));
  const manifest = buildManifest({
    version,
    gitSha:
      process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    deployOrder: DEPLOY_ORDER,
    files,
    migrationCount: MIGRATIONS.length,
    generated: GENERATED,
    external: EXTERNAL,
  });
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // checksums.txt LAST, covering the manifest too — `sha256sum --check`
  // format, so verification is one standard command.
  const lines = walk(outdir)
    .filter((f) => f !== "checksums.txt")
    .map((f) => `${sha256(join(outdir, f))}  ${f}`);
  writeFileSync(join(outdir, "checksums.txt"), lines.join("\n") + "\n");

  const shipped = walk(outdir);
  const bytes = shipped.reduce((n, f) => n + statSync(join(outdir, f)).size, 0);
  console.log(`stack ${version}: ${shipped.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB at ${outdir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
