#!/usr/bin/env node
// bullmoose deploy bootstrap — one command, five idempotent phases.
//
//   node infra/bootstrap.mjs [phase] [--dry-run] [--yes]
//
//   phase ∈ resources | wire | schemas | secrets | deploy | all   (default: all)
//   --dry-run   print every command/edit without touching cloud or files
//   --yes       pass through to wrangler prompts (d1 execute confirmation)
//
// This file is the single source of truth for the deploy: resource names,
// the schema list, the worker deploy order (binding graph), and the
// secret→worker matrix all live in the MANIFEST block below. Keep them here,
// not scattered across docs — the runbook (docs/DEPLOY.md) narrates; this runs.
//
// Phases:
//   resources  create D1 + R2 + KV (skips any that already exist)
//   wire       write the live database_id / KV id into all services/*/wrangler.jsonc
//   schemas    apply the mailstore SQL to D1 (idempotent — every DDL is IF NOT EXISTS)
//   secrets    generate the 4 random secrets → gitignored .env.deploy → `wrangler secret put`
//   deploy     `npm run -w services/<w> deploy` in binding-graph order
//
// Auth: uses your ambient wrangler credentials (`npx wrangler login`, or
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment). No secret
// values are ever printed or passed on argv.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// Repo root is the parent of this infra/ dir; every path below is relative to it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => resolve(ROOT, p);

// ─────────────────────────── MANIFEST (edit here) ───────────────────────────

const D1_NAME = "bullmoose-mail-shard0"; // data plane; control plane shares it (MVP)
const R2_NAME = "bullmoose-mail-blobs"; // raw messages, attachments, contact photos
const KV_TITLE = "ROUTES"; // route table hot copy + suppression list

import { MIGRATIONS } from "./migrations.mjs";

const SCHEMAS = [
  "packages/mailstore/sql/data-plane.sql",
  "packages/mailstore/sql/control-plane.sql",
];

// Deploy order IS the binding graph, derived from the wrangler configs:
//
//   submit         no deps
//   jmap           services: submit          · declares AccountDO
//   agent          services: submit          · durable_objects script_name: jmap
//   ingest         services: AGENT -> agent  · durable_objects script_name: jmap
//   provision      no deps
//   anglebrackets  durable_objects script_name: jmap
//
// agent MUST precede ingest — services/ingest/wrangler.jsonc:28 binds
// `bullmoose-agent`, so on a clean account ingest deploys against a service
// that does not exist yet. This list previously had ingest at 3 and agent at
// 5, which only ever worked because agent already existed from a prior run.
// bureau BEFORE agent: services/agent/wrangler.jsonc binds BUREAU ->
// bullmoose-bureau, so on a clean account the reverse order deploys agent
// against a service that does not exist yet. Same class of dependency as
// agent-before-ingest (infra/011); docs/DEPLOY.md §2 and
// .github/workflows/deploy-mail.yml must stay in sync with this list.
const DEPLOY_ORDER = ["submit", "jmap", "bureau", "agent", "ingest", "provision", "anglebrackets"];

const cfg = (w) => `services/${w}/wrangler.jsonc`;
// Configs that carry resource ids to wire. anglebrackets has no KV binding —
// its wire is a no-op for KV, which the rewrite handles by simply not matching.
const CONFIGS = DEPLOY_ORDER.map(cfg);

// Secrets we generate: name → { bytes, workers }. INTERNAL_TOKEN is ONE value
// shared across all its workers (the /internal/* + agent-poke shared secret).
const GENERATED = {
  INTERNAL_TOKEN: { bytes: 24, workers: ["jmap", "submit", "ingest", "agent", "bureau"] },
  SHARE_SIGNING_KEY: { bytes: 32, workers: ["jmap"] },
  ADMIN_TOKEN: { bytes: 24, workers: ["provision"] },
  // ONE key, ONE home (s04 T3a, arch.md OQ1). This list having exactly one entry
  // is the platform guarantee behind "you can only compute with what you have":
  // add `agent` back here and the agent worker can unseal every credential
  // again, and the Bureau stops being a boundary.
  VAULT_MASTER_KEY: { bytes: 32, workers: ["bureau"] },
};

// Secrets you supply (paste into .env.deploy). Missing required → warn + skip;
// missing optional → quiet skip. We only install them; we never generate them.
const EXTERNAL = {
  CF_API_TOKEN: { workers: ["provision"], required: true, note: "Zone:Edit + Email Routing:Edit + DNS:Edit" },
  SES_ACCESS_KEY_ID: { workers: ["provision", "submit"], required: true, note: "IAM: ses:SendRawEmail (+ identity mgmt on provision)" },
  SES_SECRET_ACCESS_KEY: { workers: ["provision", "submit"], required: true, note: "" },
  CF_EMAIL_API_TOKEN: { workers: ["submit"], required: false, note: "only if RELAY=cloudflare (Workers Paid)" },
  GATEWAY_TOKEN: { workers: ["agent"], required: false, note: "only if an AI Gateway alias exists" },
};

const ENV_DEPLOY = ".env.deploy"; // gitignored; holds generated + your pasted secrets

// ─────────────────────────────── plumbing ───────────────────────────────────

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const YES = args.includes("--yes");
const phaseArg = args.find((a) => !a.startsWith("-")) ?? "all";
const isWin = process.platform === "win32";

const c = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", cyn: "\x1b[36m", rst: "\x1b[0m" };
const paint = (col, s) => (process.stdout.isTTY ? `${col}${s}${c.rst}` : s);
const ok = (m) => console.log(`  ${paint(c.grn, "✓")} ${m}`);
const info = (m) => console.log(`  ${paint(c.cyn, "•")} ${m}`);
const warn = (m) => console.log(`  ${paint(c.yel, "⚠")} ${m}`);
const step = (m) => console.log(`\n${paint(c.cyn, "▸")} ${m}`);
const die = (m) => {
  console.error(`  ${paint(c.red, "✗")} ${m}`);
  process.exit(1);
};

// Run a command. capture=true returns stdout (stderr still streams); input pipes
// a value on stdin (for `secret put`, so it never lands in argv/history).
function run(bin, cmdArgs, { capture = false, input, allowFail = false } = {}) {
  if (DRY) {
    console.log(`  ${paint(c.dim, "+")} ${paint(c.dim, [bin, ...cmdArgs].join(" ") + (input !== undefined ? " < ‹stdin›" : ""))}`);
    return { status: 0, stdout: "" };
  }
  const r = spawnSync(bin, cmdArgs, {
    cwd: ROOT,
    input,
    encoding: "utf8",
    shell: isWin, // npm/npx need shell resolution on Windows
    stdio: capture ? ["pipe", "pipe", "inherit"] : input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
  });
  if (r.error) {
    if (allowFail) return { status: 1, stdout: "" };
    die(`could not run ${bin}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) die(`${bin} ${cmdArgs.slice(0, 3).join(" ")}… exited ${r.status}`);
  return { status: r.status ?? 0, stdout: r.stdout ?? "" };
}
const wrangler = (a, opts) => run("npx", ["wrangler", ...a], opts);

// wrangler prints a banner before JSON on some versions; slice from the first
// bracket so JSON.parse survives the noise.
function parseJson(text, fallback) {
  const i = text.search(/[[{]/);
  if (i < 0) return fallback;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return fallback;
  }
}
const firstOf = (obj, keys) => keys.map((k) => obj?.[k]).find((v) => typeof v === "string" && v.length > 0);

// ─────────────────────── wire: the JSONC id rewrite ─────────────────────────
// Pure + exported so it can be unit-tested without touching real files. Anchored
// regexes: database_id is unique; the KV id is anchored to "kv_namespaces" so it
// can't wander onto some other "id" field. A config lacking the block is left
// untouched (returns changed:false for that field).

export function wireText(text, d1Id, kvId) {
  let out = text;
  let changed = false;
  if (d1Id) {
    out = out.replace(/("database_id"\s*:\s*")[^"]*(")/g, (m, a, b) => {
      if (m === `${a}${d1Id}${b}`) return m;
      changed = true;
      return `${a}${d1Id}${b}`;
    });
  }
  if (kvId) {
    out = out.replace(/("kv_namespaces"[\s\S]*?"id"\s*:\s*")[^"]*(")/, (m, a, b) => {
      if (m === `${a}${kvId}${b}`) return m;
      changed = true;
      return `${a}${kvId}${b}`;
    });
  }
  return { text: out, changed };
}

// ─────────────────────────── .env.deploy I/O ────────────────────────────────

function loadEnv() {
  const env = {};
  if (!existsSync(rel(ENV_DEPLOY))) return env;
  for (const line of readFileSync(rel(ENV_DEPLOY), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function saveEnv(env) {
  const known = new Set([...Object.keys(GENERATED), ...Object.keys(EXTERNAL)]);
  const line = (k) => `${k}=${env[k] ?? ""}`;
  const body = [
    "# bullmoose deploy secrets — GITIGNORED, never commit.",
    "# Generated values are created once and reused on re-run (no silent rotation).",
    "# Paste the external credentials below, then: node infra/bootstrap.mjs secrets",
    "",
    "## GENERATED (openssl-equivalent random; leave as-is to keep keys stable)",
    ...Object.keys(GENERATED).map(line),
    "",
    "## EXTERNAL (you supply these)",
    ...Object.entries(EXTERNAL).map(([k, v]) => `${v.note ? `# ${v.note}\n` : ""}${line(k)}`),
  ];
  const extras = Object.keys(env).filter((k) => !known.has(k));
  if (extras.length) body.push("", "## (preserved)", ...extras.map(line));
  if (DRY) {
    info(`would write ${ENV_DEPLOY} (${Object.keys(GENERATED).length} generated + ${extras.length} preserved)`);
    return;
  }
  writeFileSync(rel(ENV_DEPLOY), body.join("\n") + "\n");
  chmodSync(rel(ENV_DEPLOY), 0o600);
}

// ─────────────────────────────── resolve ids ────────────────────────────────

function resolveIds({ mustExist = true } = {}) {
  if (DRY) return { d1Id: "‹d1-id›", kvId: "‹kv-id›" };
  const d1s = parseJson(wrangler(["d1", "list", "--json"], { capture: true }).stdout, []);
  const kvs = parseJson(wrangler(["kv", "namespace", "list"], { capture: true }).stdout, []);
  const d1 = (Array.isArray(d1s) ? d1s : []).find((x) => x?.name === D1_NAME);
  const kv = (Array.isArray(kvs) ? kvs : []).find((x) => x?.title === KV_TITLE || x?.title?.endsWith(KV_TITLE));
  const d1Id = firstOf(d1, ["uuid", "database_id", "id"]);
  const kvId = firstOf(kv, ["id", "namespace_id"]);
  if (mustExist && (!d1Id || !kvId)) {
    die(`could not resolve ids (d1=${d1Id ?? "?"}, kv=${kvId ?? "?"}). Run the 'resources' phase first.`);
  }
  return { d1Id, kvId };
}

// ─────────────────────────────── the phases ─────────────────────────────────

function resources() {
  step("resources — D1, R2, KV");
  const have = (list, pred) => (Array.isArray(list) ? list : []).some(pred);

  const d1s = parseJson(wrangler(["d1", "list", "--json"], { capture: true }).stdout, []);
  if (DRY || !have(d1s, (x) => x?.name === D1_NAME)) wrangler(["d1", "create", D1_NAME]), ok(`D1 ${D1_NAME}`);
  else ok(`D1 ${D1_NAME} (exists)`);

  const r2s = wrangler(["r2", "bucket", "list"], { capture: true }).stdout;
  if (DRY || !r2s.includes(R2_NAME)) wrangler(["r2", "bucket", "create", R2_NAME]), ok(`R2 ${R2_NAME}`);
  else ok(`R2 ${R2_NAME} (exists)`);

  const kvs = parseJson(wrangler(["kv", "namespace", "list"], { capture: true }).stdout, []);
  if (DRY || !have(kvs, (x) => x?.title === KV_TITLE || x?.title?.endsWith(KV_TITLE))) wrangler(["kv", "namespace", "create", KV_TITLE]), ok(`KV ${KV_TITLE}`);
  else ok(`KV ${KV_TITLE} (exists)`);
}

function wire() {
  step("wire — resource ids → services/*/wrangler.jsonc");
  const { d1Id, kvId } = resolveIds();
  info(`d1 ${paint(c.dim, d1Id)}   kv ${paint(c.dim, kvId)}`);
  let n = 0;
  for (const path of CONFIGS) {
    const before = readFileSync(rel(path), "utf8");
    const { text, changed } = wireText(before, d1Id, kvId);
    if (!changed) {
      ok(`${path} (already wired)`);
      continue;
    }
    if (DRY) info(`would rewrite ${path}`);
    else writeFileSync(rel(path), text);
    ok(`${path}`);
    n++;
  }
  info(`${DRY ? "would rewrite" : "rewrote"} ${n} config${n === 1 ? "" : "s"}`);
}

function schemas() {
  step("schemas — apply mailstore SQL to D1 (creates what is missing)");
  for (const sql of SCHEMAS) {
    wrangler(["d1", "execute", D1_NAME, "--remote", "--file", sql, ...(YES ? ["--yes"] : [])]);
    ok(sql);
  }
  if (!YES && !DRY) info("re-run with --yes to skip wrangler's execute confirmation");
  warn("a schema re-run CREATES what is missing; it cannot UPGRADE what exists — see `migrate`");
}

/**
 * Apply the DDL a schema re-run cannot perform, then prove it landed.
 *
 * Each entry in infra/migrations.mjs carries an executable `check` returning a
 * column `n` (applied iff n >= 1), so this never guesses from an error message.
 * Already-applied migrations are skipped, making the phase re-runnable, and any
 * check still failing AFTER its `up` ran is a hard stop rather than a warning —
 * silent partial application is the exact failure this phase exists to end.
 */
function migrate() {
  step("migrate — DDL a schema re-run cannot perform");

  const checkOne = (m) => {
    if (DRY) return null; // cannot read a remote DB in dry-run
    const r = wrangler(
      ["d1", "execute", D1_NAME, "--remote", "--json", "--command", m.check],
      { capture: true, allowFail: true },
    );
    if (r.status !== 0) return null;
    const parsed = parseJson(r.stdout, null);
    const rows = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
    const n = Array.isArray(rows) ? rows[0]?.n : undefined;
    return typeof n === "number" ? n >= 1 : null;
  };

  let applied = 0;
  const unknown = [];
  for (const m of MIGRATIONS) {
    const before = checkOne(m);
    if (before === true) {
      ok(`${m.id} — already applied`);
      continue;
    }
    if (before === null && !DRY) unknown.push(m.id);
    info(`${m.id} — ${m.why}`);
    for (const sql of m.up) {
      // SQLite has no ADD COLUMN IF NOT EXISTS, so a partially-applied group
      // re-runs into `duplicate column name`. That is success, not failure.
      const r = wrangler(
        ["d1", "execute", D1_NAME, "--remote", "--command", sql, ...(YES ? ["--yes"] : [])],
        { capture: true, allowFail: true },
      );
      if (r.status !== 0 && !/duplicate column name/i.test(r.stdout)) {
        die(`${m.id} failed on: ${sql.split("\n")[0].trim()}`);
      }
    }
    if (!DRY && checkOne(m) !== true) {
      die(`${m.id} ran but its check still fails — stopping before anything deploys against it`);
    }
    applied++;
    ok(`${m.id} — applied`);
  }

  if (unknown.length) {
    warn(`could not read state for: ${unknown.join(", ")} — applied blind, verify by hand`);
  }
  info(applied ? `${applied} migration(s) applied` : "nothing to do — every migration already applied");
}

function secrets() {
  step("secrets — generate → .env.deploy → wrangler secret put");
  const env = loadEnv();

  // Generate only what's missing → re-runs reuse existing keys (no rotation).
  //
  // "Missing" means missing from .env.deploy, which is gitignored and therefore
  // MACHINE-LOCAL. Run this from a laptop that never held the file — a fresh
  // clone, a new machine, CI — and every secret reads as missing, so this mints
  // new ones and the `put` below pushes them over the live values. That is not
  // a rotation anyone asked for, and for one of these it is unrecoverable:
  //
  //   INTERNAL_TOKEN      survivable — every worker gets the same new value
  //   SHARE_SIGNING_KEY   every outstanding share link stops verifying
  //   ADMIN_TOKEN         stored admin credentials stop working
  //   VAULT_MASTER_KEY    EVERY SEALED CREDENTIAL BECOMES UNDECRYPTABLE.
  //                       There is no recovery. The ciphertext is all there is.
  //
  // So before minting anything, ask the deployment what it already has.
  // `wrangler secret list` returns names only — never values — which is
  // exactly enough to tell "first deploy" from "about to clobber production".
  const alreadySet = new Set();
  if (!DRY) {
    for (const [name, spec] of Object.entries(GENERATED)) {
      if (env[name]) continue; // we have it locally; nothing to discover
      for (const w of spec.workers) {
        const r = wrangler(["secret", "list", "-c", cfg(w)], { capture: true, allowFail: true });
        if (r.status === 0 && new RegExp(`"name"\\s*:\\s*"${name}"`).test(r.stdout)) {
          alreadySet.add(name);
          break;
        }
      }
    }
  }

  const clobber = [...alreadySet];
  if (clobber.length && !args.includes("--rotate")) {
    die(
      `refusing to rotate ${clobber.length} secret(s) already live: ${clobber.join(", ")}\n` +
        `  ${ENV_DEPLOY} does not have them, but the deployment does — so this is a\n` +
        `  machine without the file, not a first deploy. Minting fresh values here\n` +
        `  would overwrite the live ones.\n` +
        (clobber.includes("VAULT_MASTER_KEY")
          ? `  VAULT_MASTER_KEY is UNRECOVERABLE: rotating it makes every sealed\n` +
            `  credential permanently undecryptable.\n`
          : "") +
        `  Recover ${ENV_DEPLOY} from wherever the first deploy ran, or pass\n` +
        `  --rotate if you genuinely mean to replace them.`,
    );
  }

  let minted = 0;
  for (const [name, spec] of Object.entries(GENERATED)) {
    if (!env[name]) {
      env[name] = DRY ? `‹${spec.bytes}-byte-hex›` : randomBytes(spec.bytes).toString("hex");
      minted++;
    }
  }
  saveEnv(env);
  info(minted ? `minted ${minted} new secret${minted === 1 ? "" : "s"} into ${ENV_DEPLOY}` : `reusing existing secrets in ${ENV_DEPLOY}`);

  const put = (name, worker, value) => {
    if (!DRY && (value === undefined || value === "")) return false;
    wrangler(["secret", "put", name, "-c", cfg(worker)], { input: value });
    return true;
  };

  // Generated: shared value fans out to each worker that reads it.
  for (const [name, spec] of Object.entries(GENERATED)) {
    for (const w of spec.workers) put(name, w, env[name]);
    ok(`${name} → ${spec.workers.join(", ")}`);
  }

  // External: install what's present; nudge for missing required ones.
  for (const [name, spec] of Object.entries(EXTERNAL)) {
    const value = env[name];
    if (DRY || (value !== undefined && value !== "")) {
      for (const w of spec.workers) put(name, w, value);
      ok(`${name} → ${spec.workers.join(", ")}`);
    } else if (spec.required) {
      warn(`${name} not set in ${ENV_DEPLOY} — add it (${spec.note || "required"}) and re-run 'secrets'`);
    } else {
      info(`${name} skipped (${spec.note || "optional"})`);
    }
  }
  warn("do NOT set DEV_BEARER_TOKEN in prod — unset, auth runs purely on the token table");
}

function deploy() {
  step("deploy — workers in binding-graph order");
  for (const w of DEPLOY_ORDER) {
    console.log(paint(c.dim, `  — ${w}`));
    run("npm", ["run", "-w", `services/${w}`, "deploy"]);
    ok(w);
  }
}

// ───────────────────────────────── driver ───────────────────────────────────

const PHASES = { resources, wire, schemas, migrate, secrets, deploy };
// migrate sits BETWEEN schemas and deploy, and that position is the point.
// `schemas` cannot upgrade an existing database -- every DDL is IF NOT EXISTS,
// which is idempotent for CREATING and silently declines to UPGRADE -- and two
// of the migrations (accounts.deleted_at, grants.revoked_at) are ones
// verifyBearer filters on, so a worker deployed against a database missing them
// authenticates nobody. Running it after `deploy` would be too late.
const ALL = ["resources", "wire", "schemas", "migrate", "secrets", "deploy"];

function help() {
  console.log(`bullmoose deploy bootstrap

  node infra/bootstrap.mjs [phase] [--dry-run] [--yes]

  phases:  ${ALL.join("  ")}   (default: all)
  --dry-run   show every command/edit; touch nothing
  --yes       auto-confirm wrangler's d1-execute prompt
  --rotate    allow the secrets phase to REPLACE values already live.
              Without it, a machine whose ${ENV_DEPLOY} is missing refuses
              rather than minting fresh secrets over production —
              VAULT_MASTER_KEY in particular is unrecoverable.

  auth: npx wrangler login   (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
  runbook: docs/DEPLOY.md`);
}

function main() {
  if (args.includes("-h") || args.includes("--help")) return help();
  if (phaseArg !== "all" && !PHASES[phaseArg]) die(`unknown phase '${phaseArg}'. one of: all ${ALL.join(" ")}`);

  const plan = phaseArg === "all" ? ALL : [phaseArg];
  console.log(`bullmoose bootstrap — ${paint(c.cyn, plan.join(" → "))}${DRY ? paint(c.yel, "  (dry-run)") : ""}`);

  // Liveness check — but NOT via `whoami` when the account is already explicit.
  //
  // `wrangler whoami` ENUMERATES the account list, which needs a broader
  // permission than anything this script actually does. A correctly-scoped
  // deploy token (Workers Scripts / D1 / KV / R2 : Edit) fails it with
  // "Failed to automatically retrieve account IDs for the logged in user"
  // while being perfectly able to run every command below — so using it as a
  // gate rejects exactly the tokens we want people to use, and tells them to
  // re-authenticate when authentication was never the problem.
  //
  // With CLOUDFLARE_ACCOUNT_ID set there is nothing to enumerate: the account
  // is named, and a wrong token will fail its first real call with a message
  // about that call. Wrangler says as much in the same error ("You can also
  // skip this account check by ... setting the value of CLOUDFLARE_ACCOUNT_ID").
  // Interactive `wrangler login` users have no CLOUDFLARE_ACCOUNT_ID, so they
  // keep the friendly up-front check.
  if (!DRY && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    const who = wrangler(["whoami"], { capture: true, allowFail: true });
    if (who.status !== 0) {
      die(
        "wrangler not authenticated — run `npx wrangler login`, or set " +
          "CLOUDFLARE_API_TOKEN together with CLOUDFLARE_ACCOUNT_ID (a scoped " +
          "token cannot list accounts, so it needs the id given explicitly)",
      );
    }
  }
  for (const p of plan) PHASES[p]();
  console.log(`\n${paint(c.grn, "done")} — ${plan.join(", ")}${DRY ? " (dry-run; nothing changed)" : ""}`);
}

// Only run when invoked directly — importing (for tests) must not execute.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
