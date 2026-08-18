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
//   secrets    generate the 4 random secrets → gitignored .env → `wrangler secret put`
//   deploy     `npm run -w services/<w> deploy` in binding-graph order
//
// Opt-in, NOT part of `all`:
//   explorer   turn s21's read-only mirror on (`--off` withdraws it)
//   doctor     read-only: does the DEPLOYED world still match this file?
//
// Auth: uses your ambient wrangler credentials (`npx wrangler login`, or
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment). No secret
// values are ever printed or passed on argv.

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
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
// The OAuth AS's own namespace (s02 T3). SEPARATE from ROUTES on purpose: the
// binding name is fixed by @cloudflare/workers-oauth-provider, and every
// authorization code, token issuance, refresh rotation and DCR registration is
// a write here. Sharing it with the route table would put minted credentials in
// the same keyspace as cached routing data.
const OAUTH_KV_TITLE = "OAUTH_KV";

import { MIGRATIONS } from "./migrations.mjs";

const SCHEMAS = ["packages/mailstore/sql/data-plane.sql", "packages/mailstore/sql/control-plane.sql"];

// Deploy order IS the binding graph, derived from the wrangler configs:
//
//   submit         no deps
//   jmap           services: submit          · declares AccountDO
//   agent          services: submit          · durable_objects script_name: jmap
//   ingest         services: AGENT -> agent  · durable_objects script_name: jmap
//   provision      services: BUREAU -> bureau   (s26 T4, POST /provider-keys)
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
// `oauth` precedes `agent`, which binds OAUTH to validate access tokens —
// the same edge, and the same failure if reversed (deploying against a
// service that does not exist yet), as bureau-before-agent.
export const DEPLOY_ORDER = ["submit", "jmap", "bureau", "oauth", "agent", "ingest", "provision", "anglebrackets"];

const cfg = (w) => `services/${w}/wrangler.jsonc`;
// Configs that carry resource ids to wire. anglebrackets has no KV binding —
// its wire is a no-op for KV, which the rewrite handles by simply not matching.
const CONFIGS = DEPLOY_ORDER.map(cfg);

// Secrets we generate: name → { bytes, workers }. INTERNAL_TOKEN is ONE value
// shared across all its workers (the /internal/* + agent-poke shared secret).
export const GENERATED = {
  // `provision` joined this list in s26 T4: `POST /provider-keys` seals a
  // tenant's provider key by calling the Bureau's `/internal/*` surface, which
  // is gated on this shared value. It grants provision no new READ: the Bureau
  // has no route that returns a secret to anyone holding it.
  INTERNAL_TOKEN: { bytes: 24, workers: ["jmap", "submit", "ingest", "agent", "bureau", "provision"] },
  SHARE_SIGNING_KEY: { bytes: 32, workers: ["jmap"] },
  ADMIN_TOKEN: { bytes: 24, workers: ["provision"] },
  // ONE key, ONE home (s04 T3a, arch.md OQ1). This list having exactly one entry
  // is the platform guarantee behind "you can only compute with what you have":
  // add `agent` back here and the agent worker can unseal every credential
  // again, and the Bureau stops being a boundary.
  VAULT_MASTER_KEY: { bytes: 32, workers: ["bureau"] },
};

// Secrets you supply (paste into .env). Missing required → warn + skip;
// missing optional → quiet skip. We only install them; we never generate them.
export const EXTERNAL = {
  CF_API_TOKEN: {
    workers: ["provision"],
    required: true,
    note: "Zone:Edit + Email Routing:Edit + DNS:Edit",
  },
  SES_ACCESS_KEY_ID: {
    workers: ["provision", "submit"],
    required: true,
    note: "IAM: ses:SendRawEmail (+ identity mgmt on provision)",
  },
  SES_SECRET_ACCESS_KEY: { workers: ["provision", "submit"], required: true, note: "" },
  CF_EMAIL_API_TOKEN: {
    workers: ["submit"],
    required: false,
    note: "only if RELAY=cloudflare (Workers Paid)",
  },
  GATEWAY_TOKEN: {
    workers: ["agent"],
    required: false,
    note: "only if an AI Gateway alias exists",
  },
};

// ───────────────── s21, the explorer — opt-in, and NOT in ALL ───────────────
//
// `node infra/bootstrap.mjs explorer` automates, step for step, the "TO TURN IT
// ON" runbook in `services/jmap/wrangler.jsonc`. That comment is the
// specification; this is the implementation, and running this is now the
// supported way to do it.
//
// ⚠️ NO MIGRATION IS NEEDED, AND NOBODY SHOULD ADD ONE LATER.
// The explore cookie is a STATELESS HMAC — `explore/cookie.ts` mints
// `<base64url(principal, scopes, expiry)>.<hmac>` and verifies it with a key,
// so there is no session table to create and nothing to clean up. In-flight
// PKCE state lives in the EXISTING `ROUTES` KV under `explore:pkce:<state>`
// with a 600s TTL. Every document the explorer serves comes out of the JMAP
// method registry against the EXISTING `DB` binding. So: no new tables, no new
// D1/KV/R2 resources, nothing for `resources`, `schemas` or `migrate` to do.
// If you are here because you think the explorer needs a migration, it does
// not — read `services/jmap/src/explore/cookie.ts` first.
//
// Why it is absent from ALL: a default `node infra/bootstrap.mjs` must never
// switch on a read-everything surface. Turning the explorer on is a decision,
// so it is a command.
const EXPLORE_ZONE = "bullmoose.cc";
const EXPLORE_HOSTNAME = `explore.${EXPLORE_ZONE}`;
const EXPLORE_WORKER = "jmap"; // src/explore/ lives in the jmap worker
const EXPLORE_ISSUER_DEFAULT = "https://auth.bullmoose.cc";
const EXPLORE_COOKIE_NAME = "bm_explore"; // must match explore/cookie.ts

// The DNS record. AAAA to the RFC 6666 discard prefix, PROXIED — not a CNAME
// to app.bullmoose.cc, and the difference is the FAILURE mode.
//
// Both work while the Worker route exists: a proxied record is answered at the
// edge and the origin is never contacted, so the record's target is a
// placeholder either way. They diverge exactly when the route does not exist —
// which is the state this whole design is built around (`--off`, a rolled-back
// deploy, a `wrangler deploy` from a branch where the route is still
// commented). With a CNAME to app.bullmoose.cc, `explore.bullmoose.cc` then
// falls through to whatever app.bullmoose.cc serves: the Pages app, HTTP 200,
// on the hostname whose entire premise is "a deployment that does not want it
// serves NOTHING". With 100:: there is no origin to fall through to and the
// edge fails closed.
//
// It also makes `--off` unambiguous: deleting a record pointed at 100:: cannot
// be confused with deleting one of the app's own records.
const EXPLORE_DNS = {
  type: "AAAA",
  name: EXPLORE_HOSTNAME,
  content: "100::",
  proxied: true,
  ttl: 1, // "automatic"; ignored for proxied records but required by the API
};

// The explorer's configuration, in the shape of GENERATED/EXTERNAL above but
// deliberately a SEPARATE table: everything in GENERATED is minted and pushed
// by a default run, and none of this may be.
//
// Only EXPLORE_COOKIE_KEY is really a secret. The other three go through
// `wrangler secret put` for a different reason, spelled out in the wrangler
// runbook: a `vars` entry would be COMMITTED, and committing EXPLORE_HOST — the
// master switch — is the same as turning the explorer on for every deployment
// of this repo.
export const EXPLORE_SECRETS = {
  EXPLORE_COOKIE_KEY: { bytes: 32, workers: [EXPLORE_WORKER], generated: true },
  EXPLORE_HOST: { workers: [EXPLORE_WORKER] },
  EXPLORE_CLIENT_ID: { workers: [EXPLORE_WORKER] },
  // A public client (PKCE binds the code) needs none; stored only if the AS
  // returned one, in which case explore/oauth.ts switches to client_secret_post.
  EXPLORE_CLIENT_SECRET: { workers: [EXPLORE_WORKER], optional: true },
};

// Role-based aliases for the EXTERNAL credentials.
//
// bootstrap names these after the VENDOR (`CF_API_TOKEN`, `SES_ACCESS_KEY_ID`).
// The operator's own `.env` names them after the ROLE, with the vendor as data:
//
//   BULLMOOSE_OUTBOUND_PROVIDER=ses
//   BULLMOOSE_OUTBOUND_TOKEN=…
//
// That is the better scheme and it is worth adopting rather than translating.
// A vendor baked into a variable name is a decision you cannot revisit without
// a rename, and `docs/DEPLOY.md` already contemplates RELAY=cloudflare as an
// alternative to SES — so the vendor was always going to be data eventually.
//
// Canonical names still win when both are present; these only fill gaps, so an
// existing .env keeps working and nobody has to migrate to be unblocked.
const ALIASES = {
  CF_API_TOKEN: ["BULLMOOSE_RUNTIME_TOKEN"],
  SES_ACCESS_KEY_ID: ["BULLMOOSE_OUTBOUND_TOKEN"],
  SES_SECRET_ACCESS_KEY: ["BULLMOOSE_OUTBOUND_SECRET"],
};

// The token wrangler itself needs. Not a worker secret — it authenticates the
// CLI. Read from the role-named key so one file is genuinely enough, which was
// the point of collapsing to a single .env.
// Order matters, and it is NOT alphabetical or name-intuitive.
//
// ⚠️ On this deployment the names are INVERTED relative to what the tokens can
// do: BULLMOOSE_RUNTIME_TOKEN carries Workers Scripts access, and
// BULLMOOSE_DPELOY_TOKEN does not. An earlier version of this list preferred
// the "DPELOY" one on the strength of its NAME and every `wrangler secret put`
// failed with `10000 Authentication error` while the token itself verified
// fine — a valid token that simply cannot touch that resource, which is the
// most misleading shape of this failure.
//
// So: prefer an explicit CLOUDFLARE_API_TOKEN, then the key that empirically
// holds Workers access here. `secrets` verifies the pick before using it
// (see loadEnv) rather than trusting this order.
const WRANGLER_TOKEN_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "BULLMOOSE_RUNTIME_TOKEN",
  "BULLMOOSE_DEPLOY_TOKEN",
  "BULLMOOSE_DPELOY_TOKEN",
];

// ONE env file, at the repo root. It was `.env.deploy`; it is `.env` because a
// second dotfile is a second place to look and a second thing to forget to copy
// to a new machine. `.gitignore` already covers `.env`.
//
// `.env.deploy` is still read ONCE as a migration path (see loadEnv) — a machine
// that has the old file must not be told its secrets are missing, because the
// consequence of "missing" here is minting fresh ones over the live values.
const ENV_FILE = ".env";
const ENV_LEGACY = ".env.deploy";

// ─────────────────────────────── plumbing ───────────────────────────────────

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const YES = args.includes("--yes");
const phaseArg = args.find((a) => !a.startsWith("-")) ?? "all";
const isWin = process.platform === "win32";

const c = {
  dim: "\x1b[2m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  yel: "\x1b[33m",
  cyn: "\x1b[36m",
  rst: "\x1b[0m",
};
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
    console.log(
      `  ${paint(c.dim, "+")} ${paint(c.dim, [bin, ...cmdArgs].join(" ") + (input !== undefined ? " < ‹stdin›" : ""))}`,
    );
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

export function wireText(text, d1Id, kvId, extraKv = {}) {
  let out = text;
  let changed = false;
  if (d1Id) {
    out = out.replace(/("database_id"\s*:\s*")[^"]*(")/g, (m, a, b) => {
      if (m === `${a}${d1Id}${b}`) return m;
      changed = true;
      return `${a}${d1Id}${b}`;
    });
  }
  // KV ids are written per BINDING NAME, not per file (s02 T3). The old
  // regex anchored only on "kv_namespaces" and took the first "id" after it,
  // which was correct while exactly one namespace existed anywhere in the
  // tree — and silently wrong the moment a second appeared: the oauth
  // worker's OAUTH_KV would have been wired to the ROUTES id, and an AS
  // sharing the route table's namespace is a data-mixing bug that no test
  // in this repo would have caught.
  for (const [binding, id] of Object.entries({ ROUTES: kvId, ...extraKv })) {
    if (!id) continue;
    const re = new RegExp(`("binding"\\s*:\\s*"${binding}"[\\s\\S]{0,200}?"id"\\s*:\\s*")[^"]*(")`);
    out = out.replace(re, (m, a, b) => {
      if (m === `${a}${id}${b}`) return m;
      changed = true;
      return `${a}${id}${b}`;
    });
  }
  return { text: out, changed };
}

// ────────────── explorer: the JSONC comment/uncomment (pure) ────────────────
//
// The two lines `services/jmap/wrangler.jsonc` keeps commented out. Written as
// literals rather than matched loosely, because the toggle has to be
// REVERSIBLE to the byte: uncomment → comment → uncomment must reproduce the
// committed file exactly, or `explorer --off` leaves a diff nobody asked for.
// `explorer.test.ts` asserts that round trip against the real file.
export const EXPLORE_TOGGLES = [
  {
    what: "route",
    line: `, { "pattern": "${EXPLORE_HOSTNAME}/*", "zone_name": "${EXPLORE_ZONE}" }`,
  },
  { what: "OAUTH binding", line: `, { "binding": "OAUTH", "service": "bullmoose-oauth" }` },
];

/**
 * Comment or uncomment the explorer's route and service binding.
 *
 * ⚠️ WHY THIS EDITS A COMMITTED FILE INSTEAD OF CALLING THE ROUTES API.
 *
 * `wrangler deploy` RECONCILES routes from config: it adds what the config
 * lists and REMOVES routes on the script that the config does not. A route
 * created out of band through the Cloudflare API would therefore survive
 * exactly until the next deploy of this worker and then vanish — silently, in
 * a deploy that was about something else entirely, with the DNS record and the
 * secrets still in place and the explorer simply gone. That is the worst shape
 * of drift: nothing failed, nothing logged, and the thing that turned it off
 * was unrelated. The config IS the route table, so the config is what changes.
 *
 * The operator then commits this diff, and that is a feature rather than a
 * chore: the switch lives in git, `git log -- services/jmap/wrangler.jsonc`
 * says who turned a read-everything surface on and when, and a reviewer sees
 * it. An API call leaves no such trace anywhere.
 *
 * Idempotent: a line already in the requested state is reported and left
 * alone, and `changed:false` comes back with the ORIGINAL text object.
 */
export function exploreSwitch(text, on) {
  const lines = text.split("\n");
  const toggled = [];
  const already = [];
  const missing = [];
  let changed = false;
  for (const t of EXPLORE_TOGGLES) {
    const i = lines.findIndex((l) => {
      const s = l.trim();
      return s === t.line || s === `// ${t.line}`;
    });
    // Not found at all: the file drifted from these literals. Say so rather
    // than writing a second copy of the line in, which would break the config.
    if (i < 0) {
      missing.push(t.what);
      continue;
    }
    const line = lines[i];
    const indent = line.slice(0, line.length - line.trimStart().length);
    const want = on ? `${indent}${t.line}` : `${indent}// ${t.line}`;
    if (line === want) {
      already.push(t.what);
      continue;
    }
    lines[i] = want;
    toggled.push(t.what);
    changed = true;
  }
  // Return the original string when nothing moved, so "no change" is provably
  // no change rather than a split/join that happened to round-trip.
  return { text: changed ? lines.join("\n") : text, changed, toggled, already, missing };
}

/**
 * Should this run register an OAuth client, and with what?
 *
 * ⚠️ THE IDEMPOTENCE HERE IS LOAD-BEARING, which is why it is a pure function
 * with its own test rather than an `if` buried in the phase.
 *
 * Dynamic client registration has no natural key and no list endpoint the
 * operator can reach: register twice and the second call mints a second client
 * that nobody can enumerate and nobody will remember to revoke — a live
 * credential-issuing registration, pointed at the explorer's redirect URI,
 * orphaned on the AS forever. `explore/oauth.ts` makes the same argument for
 * why the request path uses a pre-registered id: "registering per cold start
 * would leave a growing tail of client registrations nobody can enumerate or
 * revoke". A re-run of this phase is exactly that hazard at human speed.
 *
 * So: EXPLORE_CLIENT_ID present ⇒ never register. No cleverness, no probe of
 * the AS, no "verify then re-register" — the only safe re-registration is none.
 */
export function exploreRegistrationPlan(env, host = EXPLORE_HOSTNAME) {
  const issuer = (env.EXPLORE_ISSUER ?? EXPLORE_ISSUER_DEFAULT).replace(/\/+$/, "");
  if (env.EXPLORE_CLIENT_ID) {
    return { register: false, issuer, reason: "EXPLORE_CLIENT_ID is already set" };
  }
  return {
    register: true,
    issuer,
    url: `${issuer}/register`,
    // A PUBLIC client by default. The explorer redeems the code server-side,
    // but PKCE S256 is what binds the code to this client (explore/oauth.ts),
    // and a secret adds a thing to store and rotate without adding a check
    // that PKCE does not already make. If the AS returns a client_secret
    // anyway, the phase stores it and oauth.ts uses client_secret_post.
    body: {
      client_name: "bullmoose explorer",
      redirect_uris: [`https://${host}/oauth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

// ───────────────────────────── .env I/O ─────────────────────────────────────

function loadEnv() {
  const env = {};
  // Prefer .env; fall back to the legacy name so an existing machine keeps
  // working and, more importantly, does NOT read as "no secrets present" —
  // that is the state the rotation guard turns into a refusal, and without
  // this fallback the guard would fire on the one machine that is correct.
  const from = existsSync(rel(ENV_FILE)) ? ENV_FILE : existsSync(rel(ENV_LEGACY)) ? ENV_LEGACY : null;
  if (!from) return env;
  for (const line of readFileSync(rel(from), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
    // Strip ONE matched pair of surrounding quotes. dotenv-style files often
    // carry them and a shell `source` would remove them, so a human who tested
    // with `set -a; . ./.env` sees a working value while this parser installed
    // a secret with literal `"` at both ends — a credential that is wrong in a
    // way nothing reports, because the API accepts any string.
    if (m) {
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  }
  if (from === ENV_LEGACY) {
    warn(`read ${ENV_LEGACY} — migrating to ${ENV_FILE}; delete the old file once this run succeeds`);
  }

  // Fill canonical names from role-named aliases. Canonical wins if both exist.
  for (const [canon, alts] of Object.entries(ALIASES)) {
    if (env[canon]) continue;
    const hit = alts.find((a) => env[a]);
    if (hit) {
      env[canon] = env[hit];
      info(`using ${hit} for ${canon}`);
    }
  }

  // Let wrangler authenticate from the same file. Without this, a machine with
  // a perfectly good token in .env still needs `wrangler login` — which is the
  // second place to look that collapsing to one file was meant to remove.
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    const k = WRANGLER_TOKEN_KEYS.find((n) => env[n]);
    if (k) {
      process.env.CLOUDFLARE_API_TOKEN = env[k];
      info(`wrangler will authenticate with ${k} from ${ENV_FILE}`);
    }
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID) {
    process.env.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  }

  return env;
}

function saveEnv(env) {
  const known = new Set([...Object.keys(GENERATED), ...Object.keys(EXTERNAL)]);
  const line = (k) => `${k}=${env[k] ?? ""}`;
  // The explorer's keys get a named block ONLY once one of them has a value.
  // A deployment that never ran `explorer` should not find four blank explorer
  // lines in its .env inviting it to fill them in; a deployment that did must
  // not find EXPLORE_COOKIE_KEY filed under "(preserved)", where it reads like
  // debris someone could tidy away. Deleting it signs out every session and,
  // worse, makes the next run look like a first run.
  const exploreKeys = Object.keys(EXPLORE_SECRETS).filter((k) => env[k]);
  for (const k of exploreKeys) known.add(k);
  const body = [
    "# ─────────────────────────────────────────────────────────────────────────",
    "#  bullmoose — the one env file.  GITIGNORED. chmod 600. Never commit.",
    "# ─────────────────────────────────────────────────────────────────────────",
    "#",
    "#  Back this up somewhere you will still have in a year. A machine without",
    "#  it reads as 'no secrets exist', and the honest response to that state is",
    "#  to mint new ones — which for VAULT_MASTER_KEY is unrecoverable. bootstrap",
    "#  refuses rather than doing it (--rotate overrides), but the refusal is a",
    "#  seatbelt, not a backup.",
    "#",
    "#  Names only in this header; values live below. `.env.example` is the",
    "#  committed, value-free copy of this shape.",
    "",
    "## ── GENERATED ────────────────────────────────────────────────────────────",
    "## Created once, reused on every re-run. Rotating them is not symmetric:",
    "##   VAULT_MASTER_KEY   every sealed credential becomes UNDECRYPTABLE. No recovery.",
    "##   SHARE_SIGNING_KEY  every outstanding share link stops verifying.",
    "##   ADMIN_TOKEN        stored admin credentials stop working.",
    "##   INTERNAL_TOKEN     survivable — all five workers get the same new value.",
    ...Object.keys(GENERATED).map(line),
    "",
    "## ── EXTERNAL ─────────────────────────────────────────────────────────────",
    "## You supply these. bootstrap installs them and never generates them.",
    ...Object.entries(EXTERNAL).map(([k, v]) => `${v.note ? `# ${v.note}\n` : ""}${line(k)}`),
  ];
  if (exploreKeys.length) {
    body.push(
      "",
      "## ── EXPLORER (s21, opt-in) ───────────────────────────────────────────────",
      "## Written by `bootstrap explorer`. Do not hand-edit:",
      "##   EXPLORE_COOKIE_KEY  replacing it signs out every explorer session.",
      "##   EXPLORE_CLIENT_ID   registering a second client orphans the first on",
      "##                       the AS, where nothing can enumerate it.",
      "## `bootstrap explorer --off` leaves both in place, on purpose — they are",
      "## inert without the route.",
      ...exploreKeys.map(line),
    );
  }
  const extras = Object.keys(env).filter((k) => !known.has(k));
  if (extras.length) body.push("", "## (preserved)", ...extras.map(line));
  if (DRY) {
    const explorePart = exploreKeys.length ? ` + ${exploreKeys.length} explorer` : "";
    info(
      `would write ${ENV_FILE} (${Object.keys(GENERATED).length} generated${explorePart} + ${extras.length} preserved)`,
    );
    return;
  }
  writeFileSync(rel(ENV_FILE), body.join("\n") + "\n");
  chmodSync(rel(ENV_FILE), 0o600);
}

// ─────────────────────────────── resolve ids ────────────────────────────────

function resolveIds({ mustExist = true } = {}) {
  if (DRY) return { d1Id: "‹d1-id›", kvId: "‹kv-id›", oauthKvId: "‹oauth-kv-id›" };
  const d1s = parseJson(wrangler(["d1", "list", "--json"], { capture: true }).stdout, []);
  const kvs = parseJson(wrangler(["kv", "namespace", "list"], { capture: true }).stdout, []);
  const d1 = (Array.isArray(d1s) ? d1s : []).find((x) => x?.name === D1_NAME);
  // Anchored with a "-" so OAUTH_KV cannot satisfy the ROUTES lookup and vice
  // versa: `endsWith` is what tolerates wrangler's "<worker>-ROUTES" naming,
  // and an unanchored match would happily return the wrong namespace.
  const kvList = Array.isArray(kvs) ? kvs : [];
  const matchKv = (title) => kvList.find((x) => x?.title === title || x?.title?.endsWith(`-${title}`));
  const kv = matchKv(KV_TITLE);
  const d1Id = firstOf(d1, ["uuid", "database_id", "id"]);
  const kvId = firstOf(kv, ["id", "namespace_id"]);
  const oauthKvId = firstOf(matchKv(OAUTH_KV_TITLE), ["id", "namespace_id"]);
  if (mustExist && (!d1Id || !kvId)) {
    die(`could not resolve ids (d1=${d1Id ?? "?"}, kv=${kvId ?? "?"}). Run the 'resources' phase first.`);
  }
  return { d1Id, kvId, oauthKvId };
}

// ─────────────────────────────── the phases ─────────────────────────────────

function resources() {
  step("resources — D1, R2, KV");
  const have = (list, pred) => (Array.isArray(list) ? list : []).some(pred);

  const d1s = parseJson(wrangler(["d1", "list", "--json"], { capture: true }).stdout, []);
  if (DRY || !have(d1s, (x) => x?.name === D1_NAME)) {
    wrangler(["d1", "create", D1_NAME]);
    ok(`D1 ${D1_NAME}`);
  } else ok(`D1 ${D1_NAME} (exists)`);

  const r2s = wrangler(["r2", "bucket", "list"], { capture: true }).stdout;
  if (DRY || !r2s.includes(R2_NAME)) {
    wrangler(["r2", "bucket", "create", R2_NAME]);
    ok(`R2 ${R2_NAME}`);
  } else ok(`R2 ${R2_NAME} (exists)`);

  const kvs = parseJson(wrangler(["kv", "namespace", "list"], { capture: true }).stdout, []);
  for (const title of [KV_TITLE, OAUTH_KV_TITLE]) {
    if (DRY || !have(kvs, (x) => x?.title === title || x?.title?.endsWith(`-${title}`))) {
      wrangler(["kv", "namespace", "create", title]);
      ok(`KV ${title}`);
    } else ok(`KV ${title} (exists)`);
  }
}

function wire() {
  step("wire — resource ids → services/*/wrangler.jsonc");
  const { d1Id, kvId, oauthKvId } = resolveIds();
  info(`d1 ${paint(c.dim, d1Id)}   kv ${paint(c.dim, kvId)}   oauth-kv ${paint(c.dim, oauthKvId ?? "—")}`);
  let n = 0;
  for (const path of CONFIGS) {
    const before = readFileSync(rel(path), "utf8");
    const { text, changed } = wireText(before, d1Id, kvId, { OAUTH_KV: oauthKvId });
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
    const r = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", m.check], {
      capture: true,
      allowFail: true,
    });
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
      const r = wrangler(["d1", "execute", D1_NAME, "--remote", "--command", sql, ...(YES ? ["--yes"] : [])], {
        capture: true,
        allowFail: true,
      });
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

/**
 * Install one secret on one worker, over stdin so it never lands in argv.
 *
 * The empty check applies in DRY too. It used to be `!DRY && …`, so a dry run
 * printed `wrangler secret put GATEWAY_TOKEN` and a ✓ for optional credentials
 * that are not set — installs that a real run would skip. A preview whose
 * entire job is "show me exactly what will happen" must not overstate; a reader
 * checking whether they had filled everything in would have been told yes.
 */
function putSecret(name, worker, value) {
  if (value === undefined || value === "") return false;
  wrangler(["secret", "put", name, "-c", cfg(worker)], { input: value });
  return true;
}

/**
 * Does the DEPLOYMENT already hold this secret? `wrangler secret list` returns
 * names only — never values — which is exactly enough to tell "first deploy"
 * from "about to clobber production". Shared by `secrets` and `explorer`, so
 * both rotation guards ask the same question the same way.
 */
function secretIsLive(name, workers) {
  for (const w of workers) {
    const r = wrangler(["secret", "list", "-c", cfg(w)], { capture: true, allowFail: true });
    if (r.status === 0 && new RegExp(`"name"\\s*:\\s*"${name}"`).test(r.stdout)) return true;
  }
  return false;
}

function secrets() {
  step("secrets — generate → .env → wrangler secret put");
  const env = loadEnv();

  // Generate only what's missing → re-runs reuse existing keys (no rotation).
  //
  // "Missing" means missing from .env, which is gitignored and therefore
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
      if (secretIsLive(name, spec.workers)) alreadySet.add(name);
    }
  }

  const clobber = [...alreadySet];
  if (clobber.length && !args.includes("--rotate")) {
    die(
      `refusing to rotate ${clobber.length} secret(s) already live: ${clobber.join(", ")}\n` +
        `  ${ENV_FILE} does not have them, but the deployment does — so this is a\n` +
        `  machine without the file, not a first deploy. Minting fresh values here\n` +
        `  would overwrite the live ones.\n` +
        (clobber.includes("VAULT_MASTER_KEY")
          ? `  VAULT_MASTER_KEY is UNRECOVERABLE: rotating it makes every sealed\n` +
            `  credential permanently undecryptable.\n`
          : "") +
        `  Recover ${ENV_FILE} from wherever the first deploy ran, or pass\n` +
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
  info(
    minted
      ? `minted ${minted} new secret${minted === 1 ? "" : "s"} into ${ENV_FILE}`
      : `reusing existing secrets in ${ENV_FILE}`,
  );

  // Generated: shared value fans out to each worker that reads it.
  for (const [name, spec] of Object.entries(GENERATED)) {
    for (const w of spec.workers) putSecret(name, w, env[name]);
    ok(`${name} → ${spec.workers.join(", ")}`);
  }

  // External: install what's present; nudge for missing required ones.
  for (const [name, spec] of Object.entries(EXTERNAL)) {
    const value = env[name];
    // `DRY ||` used to short-circuit this, so a dry run reported every optional
    // credential as installed whether or not it was set — the branch below that
    // says "skipped" was unreachable in preview. The whole point of --dry-run is
    // to answer "have I filled everything in", and it answered yes regardless.
    if (value !== undefined && value !== "") {
      for (const w of spec.workers) putSecret(name, w, value);
      ok(`${name} → ${spec.workers.join(", ")}`);
    } else if (spec.required) {
      warn(`${name} not set in ${ENV_FILE} — add it (${spec.note || "required"}) and re-run 'secrets'`);
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

// ────────────────────────────── explorer ────────────────────────────────────
//
// `node infra/bootstrap.mjs explorer [--off] [--dry-run] [--rotate]`
//
// The four steps of the wrangler.jsonc runbook, made idempotent and
// reversible. See the EXPLORE_* manifest block above for why there is no
// migration, why the DNS record is an AAAA to 100::, and why this is not part
// of `all`.
//
// s21's design is TWO switches, and neither alone is sufficient
// (`.plans/s21-explorer` open question 2):
//
//   switch 1  the route + the DNS record — without them nothing on the
//             internet resolves to, or is routed to, explore.bullmoose.cc.
//   switch 2  EXPLORE_HOST — without it `isExploreHost` is false for every
//             request, no cookie is read anywhere in the jmap worker, and none
//             of src/explore/ is reachable whatever the route says.
//
// `explorer` throws both. `explorer --off` throws only the first, deliberately
// — see the note it prints.

/** One Cloudflare REST call. Returns `{status, success, result, errors}`. */
async function cfApi(token, path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

const cfMessage = (r) => r?.errors?.[0]?.message ?? `HTTP ${r?.status ?? "?"}`;

/**
 * Step 1 — the DNS record.
 *
 * Returns true only if the record is in the requested state AFTERWARDS. A zone
 * lookup that fails REPORTS and returns false rather than guessing: the two
 * indistinguishable causes are "the token lacks DNS scope" and "this account
 * does not hold the zone", and inventing a record on a guess is how you end up
 * with a hostname pointed somewhere nobody chose.
 */
async function exploreDns(env, on) {
  if (DRY) {
    info(
      on
        ? `would ensure ${EXPLORE_DNS.type} ${EXPLORE_HOSTNAME} → ${EXPLORE_DNS.content} (proxied) in zone ${EXPLORE_ZONE}`
        : `would delete every DNS record for ${EXPLORE_HOSTNAME} in zone ${EXPLORE_ZONE}`,
    );
    return true;
  }

  // CF_API_TOKEN is the DNS-scoped one on this deployment (loadEnv fills it
  // from BULLMOOSE_RUNTIME_TOKEN via ALIASES). CLOUDFLARE_API_TOKEN is the
  // wrangler credential and may be a Workers-only token, so it is the last
  // resort rather than the first choice.
  const token = env.CF_API_TOKEN ?? env.BULLMOOSE_RUNTIME_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    warn(`no API token for DNS — set CF_API_TOKEN (DNS:Edit on ${EXPLORE_ZONE}) in ${ENV_FILE}. DNS untouched.`);
    return false;
  }

  const zones = await cfApi(token, `/zones?name=${encodeURIComponent(EXPLORE_ZONE)}`);
  if (!zones.success) {
    warn(
      `zone lookup for ${EXPLORE_ZONE} failed: ${cfMessage(zones)} — DNS untouched (token missing Zone:Read/DNS:Edit?)`,
    );
    return false;
  }
  const zoneId = zones.result?.[0]?.id;
  if (!zoneId) {
    warn(`zone ${EXPLORE_ZONE} is not on the account this token reaches — DNS untouched`);
    return false;
  }

  const found = await cfApi(token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(EXPLORE_HOSTNAME)}`);
  if (!found.success) {
    warn(`DNS read for ${EXPLORE_HOSTNAME} failed: ${cfMessage(found)} — DNS untouched`);
    return false;
  }
  const records = found.result ?? [];

  if (on) {
    if (records.length > 0) {
      const r = records[0];
      ok(`DNS ${EXPLORE_HOSTNAME} (exists: ${r.type} → ${r.content}${r.proxied ? ", proxied" : ""})`);
      // An unproxied record answers with its own content and never reaches a
      // Worker route — for 100:: that is a black hole, for a CNAME it is the
      // app. Either way the explorer would look deployed and serve nothing.
      if (!r.proxied) {
        warn(`that record is NOT proxied — a grey-cloud record never reaches a Worker route. Orange-cloud it.`);
        return false;
      }
      return true;
    }
    const made = await cfApi(token, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: EXPLORE_DNS,
    });
    if (!made.success) {
      warn(`could not create ${EXPLORE_DNS.type} ${EXPLORE_HOSTNAME}: ${cfMessage(made)}`);
      return false;
    }
    ok(`DNS ${EXPLORE_DNS.type} ${EXPLORE_HOSTNAME} → ${EXPLORE_DNS.content} (proxied)`);
    return true;
  }

  if (records.length === 0) {
    ok(`DNS ${EXPLORE_HOSTNAME} (already absent)`);
    return true;
  }
  let gone = 0;
  for (const r of records) {
    const del = await cfApi(token, `/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" });
    if (del.success || del.status === 404) gone++;
    else warn(`could not delete ${r.type} ${r.name}: ${cfMessage(del)}`);
  }
  ok(`DNS ${EXPLORE_HOSTNAME} removed (${gone}/${records.length}) — the hostname no longer resolves`);
  return gone === records.length;
}

/** Step 2 — the route and the OAUTH binding in services/jmap/wrangler.jsonc. */
function exploreConfigEdit(on) {
  const path = cfg(EXPLORE_WORKER);
  const before = readFileSync(rel(path), "utf8");
  const r = exploreSwitch(before, on);
  for (const what of r.missing) {
    warn(`${path}: no line matching the ${what} — the file drifted from bootstrap's literals; edit it by hand`);
  }
  for (const what of r.already) ok(`${path} ${what} (already ${on ? "on" : "off"})`);
  if (!r.changed) return r;
  if (DRY) {
    info(`would ${on ? "uncomment" : "comment out"} the ${r.toggled.join(" + ")} in ${path}`);
    return r;
  }
  writeFileSync(rel(path), r.text);
  ok(`${path} — ${on ? "uncommented" : "commented out"} the ${r.toggled.join(" + ")}`);
  return r;
}

/** Step 3 — register the OAuth client ONCE, and persist the id. */
async function exploreRegister(env) {
  const plan = exploreRegistrationPlan(env);
  if (!plan.register) {
    ok(`OAuth client (already registered — ${env.EXPLORE_CLIENT_ID})`);
    info("not re-registering: a second registration orphans a client the AS cannot enumerate or revoke");
    return false;
  }
  if (DRY) {
    info(`would POST ${plan.url} — public client, redirect ${plan.body.redirect_uris[0]}`);
    return false;
  }

  let res;
  try {
    res = await fetch(plan.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.body),
    });
  } catch (e) {
    warn(`could not reach ${plan.url} (${e}) — nothing registered; re-run this phase once the AS is up`);
    return false;
  }
  if (!res.ok) {
    warn(`${plan.url} returned ${res.status} — nothing registered, and nothing written to ${ENV_FILE}`);
    return false;
  }
  const body = await res.json().catch(() => null);
  const id = typeof body?.client_id === "string" && body.client_id.length > 0 ? body.client_id : null;
  if (!id) {
    warn(`${plan.url} returned no client_id — nothing stored`);
    return false;
  }

  env.EXPLORE_CLIENT_ID = id;
  if (typeof body.client_secret === "string" && body.client_secret.length > 0) {
    // Only if the AS decided to make it confidential. explore/oauth.ts reads
    // the presence of this value as "use client_secret_post"; nothing else
    // changes, and PKCE still binds the code either way.
    env.EXPLORE_CLIENT_SECRET = body.client_secret;
    info("the AS returned a client_secret — stored; the token call will use client_secret_post");
  }
  saveEnv(env);
  ok(`OAuth client registered at ${plan.issuer} → EXPLORE_CLIENT_ID saved to ${ENV_FILE}`);
  return true;
}

/** Step 4 — generate the cookie key if absent, then push the configuration. */
function exploreSecrets(env) {
  // EXPLORE_HOST is switch 2, and it is a value this script owns rather than
  // one the operator supplies — the hostname is fixed by the route literal in
  // wrangler.jsonc, so anything else would be a config that cannot work.
  if (!env.EXPLORE_HOST) env.EXPLORE_HOST = EXPLORE_HOSTNAME;

  // The same rotation guard `secrets` uses, for the same reason and with a
  // sharper edge: EXPLORE_COOKIE_KEY signs every live session, so minting a
  // fresh one over a live one signs out every explorer session at once, with
  // no error anywhere — the cookies simply stop verifying and everyone is
  // handed the sign-in page again. Survivable, unlike VAULT_MASTER_KEY, but it
  // must be a decision rather than a side effect of running this on a laptop
  // that never held .env.
  if (!env.EXPLORE_COOKIE_KEY && !DRY && !args.includes("--rotate")) {
    if (secretIsLive("EXPLORE_COOKIE_KEY", [EXPLORE_WORKER])) {
      die(
        `refusing to rotate EXPLORE_COOKIE_KEY: it is not in ${ENV_FILE}, but the\n` +
          `  ${EXPLORE_WORKER} worker already holds one — so this is a machine without the\n` +
          `  file, not a first run. Minting a fresh key here would silently sign out\n` +
          `  every live explorer session. Recover ${ENV_FILE}, or pass --rotate if you\n` +
          `  genuinely mean to replace it.`,
      );
    }
  }

  let minted = false;
  if (!env.EXPLORE_COOKIE_KEY) {
    env.EXPLORE_COOKIE_KEY = DRY
      ? `‹${EXPLORE_SECRETS.EXPLORE_COOKIE_KEY.bytes}-byte-hex›`
      : randomBytes(EXPLORE_SECRETS.EXPLORE_COOKIE_KEY.bytes).toString("hex");
    minted = true;
  }
  saveEnv(env);
  info(minted ? `minted EXPLORE_COOKIE_KEY into ${ENV_FILE}` : `reusing EXPLORE_COOKIE_KEY from ${ENV_FILE}`);

  for (const [name, spec] of Object.entries(EXPLORE_SECRETS)) {
    const value = env[name];
    if (value === undefined || value === "") {
      if (spec.optional) info(`${name} skipped (public client — PKCE binds the code)`);
      else if (DRY && name === "EXPLORE_CLIENT_ID") {
        // A dry run cannot have registered anything, so it genuinely does not
        // have this yet. Say so rather than reporting a problem that only
        // exists because this was a preview.
        info(`${name} not shown — a real run has it by now, from step 3`);
      } else warn(`${name} not set — sign-in will answer 503 "explorer_not_configured" until it is`);
      continue;
    }
    for (const w of spec.workers) putSecret(name, w, value);
    ok(`${name} → ${spec.workers.join(", ")}`);
  }
}

async function explorer() {
  const off = args.includes("--off");
  const env = loadEnv();

  if (off) {
    step("explorer — OFF: withdraw the route and the DNS record");
    // DNS first: deleting the record takes effect at once, whereas the config
    // edit only bites on the next deploy. Killing the faster switch first
    // shortens the window in which the explorer is still answering.
    await exploreDns(env, false);
    exploreConfigEdit(false);
    console.log(
      `\n  ${paint(c.yel, "what --off does NOT undo, and why")}\n` +
        `    • the OAuth client registration on ${(env.EXPLORE_ISSUER ?? EXPLORE_ISSUER_DEFAULT).replace(/\/+$/, "")}\n` +
        `      still exists, and EXPLORE_CLIENT_ID stays in ${ENV_FILE}. Kept on purpose:\n` +
        `      it is what makes turning the explorer back on idempotent instead of\n` +
        `      minting a second, unenumerable client. To revoke it for real:\n` +
        `        curl -X POST ${(env.EXPLORE_ISSUER ?? EXPLORE_ISSUER_DEFAULT).replace(/\/+$/, "")}/revoke \\\n` +
        `          -H 'authorization: Bearer bm_‹your device token›' \\\n` +
        `          -H 'content-type: application/json' \\\n` +
        `          -d '{"clientId":"${env.EXPLORE_CLIENT_ID ?? "‹EXPLORE_CLIENT_ID›"}"}'\n` +
        `      then clear EXPLORE_CLIENT_ID from ${ENV_FILE}.\n` +
        `    • the secrets pushed to the ${EXPLORE_WORKER} worker (EXPLORE_HOST,\n` +
        `      EXPLORE_CLIENT_ID, EXPLORE_COOKIE_KEY) are still set.\n` +
        `\n    Both are INERT without a route: nothing on the internet resolves to\n` +
        `    ${EXPLORE_HOSTNAME}, and no request can arrive carrying that Host, so\n` +
        `    cookieAuthAllowed is false for every request the worker ever sees.\n` +
        `    To throw the second switch as well:\n` +
        `      npx wrangler secret delete EXPLORE_HOST -c ${cfg(EXPLORE_WORKER)}\n`,
    );
    console.log(
      `  ${paint(c.cyn, "next:")} commit ${cfg(EXPLORE_WORKER)}, then ${paint(c.cyn, "node infra/bootstrap.mjs deploy")}`,
    );
    return;
  }

  step(`explorer — s21: ${EXPLORE_HOSTNAME}, read-only, off unless this runs`);
  const dnsOk = await exploreDns(env, true);
  exploreConfigEdit(true);
  await exploreRegister(env);
  exploreSecrets(env);

  console.log("");
  if (!dnsOk && !DRY) {
    warn(`DNS is the one step that did NOT complete — ${EXPLORE_HOSTNAME} will not resolve.`);
    warn(
      `  Add a PROXIED ${EXPLORE_DNS.type} for \`explore\` → ${EXPLORE_DNS.content} by hand, or fix the token and re-run.`,
    );
  }
  console.log(
    `  ${paint(c.cyn, "one thing left:")} ${paint(c.grn, "node infra/bootstrap.mjs deploy")}\n` +
      `    The route lives in ${cfg(EXPLORE_WORKER)} and only a deploy publishes it —\n` +
      `    nothing above changed what is currently serving. Commit that file too:\n` +
      `    the switch belongs in git, and the next deploy from a checkout without\n` +
      `    it would reconcile the route straight back off.`,
  );
}

// ─────────────────────────────── doctor ─────────────────────────────────────
//
// Every phase above CHANGES the world. `doctor` only asks whether the world
// still matches what we think we deployed — because three separate incidents in
// one week were deployment-state drift rather than code, and each presented as
// something else:
//
//   • ADMIN_TOKEN rotated → every cached admin credential silently invalid,
//     surfacing as a bare 401 at some later moment.
//   • the jmap worker moved to custom-domain routes → the _jmap._tcp SRV record
//     kept pointing at a workers.dev host that had stopped serving, so
//     autodiscovery handed clients a 404 HTML page.
//   • the apex answered /.well-known/jmap with 200 and the homepage, which is
//     worse than a 404: it tells a client it FOUND the server.
//
// None of those is visible in the code. All three are one line of output here.

/**
 * A `bm_explore` cookie value for the CSRF probe, in the exact wire format
 * `explore/cookie.ts` mints: `<base64url(json)>.<hex hmac-sha256>`.
 *
 * Signed with the real key when .env has it, so the request is refused by the
 * HOST check rather than bouncing off a bad signature — the layer this probe is
 * about. It names a principal that cannot exist, so it can never authorize
 * anything even if every check were removed. Without the key, an all-zero
 * signature still exercises the same path.
 */
function exploreProbeCookie(env) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      p: "p_doctor_probe_not_a_real_principal",
      s: ["read"],
      e: Date.now() + 60_000,
    }),
  ).toString("base64url");
  const sig = env.EXPLORE_COOKIE_KEY
    ? createHmac("sha256", env.EXPLORE_COOKIE_KEY).update(payload).digest("hex")
    : "0".repeat(64);
  return `${payload}.${sig}`;
}

async function doctor() {
  step("doctor — is the deployed world still the one we think we deployed?");
  let bad = 0;
  const fail = (what, detail) => {
    bad++;
    console.log(`  ✗ ${what}\n      ${detail}`);
  };
  const pass = (what, detail = "") => console.log(`  ✓ ${what}${detail ? `  ${detail}` : ""}`);

  // loadEnv() rather than a module-level binding: doctor is read-only and must
  // reflect what is in .env RIGHT NOW, not what was there when the module loaded.
  const env = loadEnv();
  const site = process.env.BULLMOOSE_APP_ORIGIN ?? "https://app.bullmoose.cc";
  const apex = process.env.BULLMOOSE_APEX ?? "https://bullmoose.cc";

  // ---- 1. autodiscovery: a client with only an address must find us --------
  // RFC 8620 §2.2 is SRV then the well-known path. The failure that bit us was
  // not "unreachable" — it was "reachable and wrong", so assert the CONTENT.
  try {
    const r = await fetch(`${apex}/.well-known/jmap`, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    if (r.status >= 300 && r.status < 400 && loc.includes("/.well-known/jmap")) {
      pass("apex autodiscovery", `${r.status} → ${loc}`);
    } else if (r.status === 200 && (r.headers.get("content-type") ?? "").includes("html")) {
      fail(
        "apex autodiscovery",
        `200 with HTML — a client reads that as "found the server". Expected a redirect to ${site}/.well-known/jmap`,
      );
    } else {
      fail("apex autodiscovery", `${r.status} ${r.headers.get("content-type") ?? ""} — expected a redirect`);
    }
  } catch (e) {
    fail("apex autodiscovery", String(e));
  }

  // ---- 2. the session resource answers as JSON, not as a page -------------
  try {
    const r = await fetch(`${site}/.well-known/jmap`);
    const ct = r.headers.get("content-type") ?? "";
    if (r.status === 401 && ct.includes("json")) pass("session endpoint", "401 JSON (unauthenticated, correct)");
    else if (ct.includes("html"))
      fail("session endpoint", `${r.status} HTML — the worker route is not serving this path; Pages is`);
    else pass("session endpoint", `${r.status} ${ct}`);
  } catch (e) {
    fail("session endpoint", String(e));
  }

  // ---- 3. every worker route actually reaches a worker --------------------
  for (const path of ["/api/", "/auth/login", "/console/agents"]) {
    try {
      const r = await fetch(`${site}${path}`);
      const ct = r.headers.get("content-type") ?? "";
      if (ct.includes("html"))
        fail(`route ${path}`, `${r.status} HTML — falls through to Pages, so the worker route is missing`);
      else pass(`route ${path}`, `${r.status} ${ct.split(";")[0]}`);
    } catch (e) {
      fail(`route ${path}`, String(e));
    }
  }

  // ---- 3b. the explorer (s21) — CONDITIONAL, because OFF is correct -------
  //
  // Most of this script asserts that something IS deployed. The explorer is the
  // one surface whose absence is a valid, and default, state — so an unset
  // EXPLORE_HOST reports "off" and moves on rather than counting as a problem.
  // A doctor that failed here would train everyone to ignore its output.
  const exploreHost = process.env.BULLMOOSE_EXPLORE_HOST ?? env.EXPLORE_HOST;
  if (!exploreHost) {
    console.log(`  · explorer          off (EXPLORE_HOST unset in ${ENV_FILE}) — skipped`);
  } else {
    const exploreOrigin = `https://${exploreHost}`;
    let reachable = true;

    // (a) the host resolves, a worker answers, and the answer is a refusal.
    // 200 is the interesting failure: either Pages is serving this hostname
    // (the route is missing, so the CNAME/AAAA is pointed at nothing of ours)
    // or something authenticated a request that carried no credential.
    try {
      const r = await fetch(`${exploreOrigin}/`, { redirect: "manual" });
      const ct = (r.headers.get("content-type") ?? "").split(";")[0];
      const csp = r.headers.get("content-security-policy") ?? "";
      if (r.status !== 401) {
        fail(
          "explorer /",
          `${r.status} ${ct} — an unauthenticated / must be 401. 200 means Pages is answering this hostname, or something authorized a request with no credential.`,
        );
      } else if (!csp.includes("default-src 'none'")) {
        // The sign-in page is the ONE scrap of HTML the explorer serves, and it
        // carries `default-src 'none'`. A 401 without it came from somewhere
        // other than src/explore/ — which is worth knowing, because it means
        // the request is not reaching the code this check is about.
        fail("explorer /", `401 but without the sign-in page's CSP — that refusal did not come from src/explore/`);
      } else {
        pass("explorer /", "401 sign-in page");
      }
    } catch (e) {
      reachable = false;
      fail(
        "explorer host",
        `${exploreHost} did not answer (${e}) — no DNS record, or the record is grey-cloud and never reaches the route`,
      );
    }

    // (b) read-only, refused BEFORE any credential is looked at.
    if (reachable) {
      try {
        const r = await fetch(`${exploreOrigin}/`, { method: "POST" });
        const allow = r.headers.get("allow") ?? "";
        if (r.status === 405 && allow.includes("GET")) pass("explorer read-only", "POST / → 405 allow: GET");
        else
          fail(
            "explorer read-only",
            `POST / → ${r.status} — non-GET must be refused on this host before authentication`,
          );
      } catch (e) {
        fail("explorer read-only", String(e));
      }
    }

    // (c) ⚠️ THE SECURITY-RELEVANT ONE: the explore cookie is refused on the
    // API origin.
    //
    // `cookieAuthAllowed` honours a cookie only when the Host header is the
    // explore hostname AND the method is GET. Drop either half and
    // app.bullmoose.cc/api/jmap gains an ambient credential — every page on the
    // internet could then make a signed-in browser POST `Email/set destroy`.
    // `explore/csrf.test.ts` pins it in unit tests; this asks the DEPLOYED
    // worker, which is the only place the guard can be missing while the tests
    // are green (a stale deploy, a rolled-back file, a hand-edited script).
    //
    // What this can and cannot see, stated plainly: the probe cookie is signed
    // with the real key when .env has it, but it names a principal that does
    // not exist, so a worker WITHOUT the host check would still 401 at the
    // grant lookup. The shape that bites is 200 — and 200 is exactly the
    // catastrophic shape, because it means a cookie alone carried authority on
    // the API origin. HTML here bites too: it means the route is gone.
    const probe = `${EXPLORE_COOKIE_NAME}=${exploreProbeCookie(env)}`;
    const csrfProbes = [
      ["GET /.well-known/jmap", `${site}/.well-known/jmap`, { method: "GET" }],
      // The attack shape itself. Unauthenticated it is refused before the body
      // is parsed, so this changes nothing on the deployment.
      ["POST /api/jmap", `${site}/api/jmap`, { method: "POST", body: '{"using":[],"methodCalls":[]}' }],
    ];
    for (const [label, target, init] of csrfProbes) {
      try {
        const r = await fetch(target, {
          ...init,
          headers: {
            cookie: probe,
            ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
          },
        });
        const ct = (r.headers.get("content-type") ?? "").split(";")[0];
        // HTML is judged BEFORE the status, because a 200 of HTML is Pages
        // answering (the worker route is missing) — a real problem, but a
        // different one, and reporting it as "the cookie was accepted" would
        // send someone hunting a CSRF hole that is not there.
        if (ct.includes("html")) {
          fail(
            `explore cookie on API origin (${label})`,
            `${r.status} HTML — Pages is answering this path, so the worker route is missing. Nothing here proves anything about the cookie guard.`,
          );
        } else if (r.status === 200) {
          fail(
            `explore cookie on API origin (${label})`,
            `200 — the explore cookie was ACCEPTED on ${site}. cookieAuthAllowed's Host check is not in the deployed worker; /api/ is CSRF-able. Redeploy services/jmap now.`,
          );
        } else if (r.headers.get("set-cookie")) {
          fail(
            `explore cookie on API origin (${label})`,
            `${r.status} but it set a cookie — the API origin must never mint one`,
          );
        } else if (r.status === 401) {
          pass(`explore cookie on API origin (${label})`, "401 — refused, as it must be");
        } else {
          fail(`explore cookie on API origin (${label})`, `${r.status} ${ct} — expected 401`);
        }
      } catch (e) {
        fail(`explore cookie on API origin (${label})`, String(e));
      }
    }
  }

  // ---- 4. the admin token in .env is the one the worker accepts -----------
  // The rotation failure mode: .env and the worker disagree, and nothing says so
  // until a human runs an admin command and reads a bare 401.
  const adminUrl = process.env.BULLMOOSE_PROVISION_URL ?? env.BULLMOOSE_PROVISION_URL;
  if (!env.ADMIN_TOKEN) console.log("  · admin token       not in " + ENV_FILE + " — skipped");
  else if (!adminUrl) console.log("  · admin token       set BULLMOOSE_PROVISION_URL to check it — skipped");
  else {
    try {
      const r = await fetch(`${adminUrl}/agent-bindings`, {
        headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      });
      if (r.status === 401)
        fail(
          "admin token",
          `401 — ${ENV_FILE}'s ADMIN_TOKEN is not the one provision holds. Rotated? Re-run \`bullmoose admin init\` on every machine that uses the admin API.`,
        );
      else pass("admin token", `${r.status}`);
    } catch (e) {
      fail("admin token", String(e));
    }
  }

  // ---- 5. what the deployed workers are actually DOING --------------------
  // Cloudflare's GraphQL analytics. The first signal in this script that is
  // about behaviour rather than shape: a worker can be deployed, routed and
  // reachable while erroring on every request.
  const token = env.BULLMOOSE_RUNTIME_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) console.log("  · worker traffic    needs CLOUDFLARE_ACCOUNT_ID + a runtime token — skipped");
  else {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const query = `query { viewer { accounts(filter:{accountTag:"${account}"}) {
      workersInvocationsAdaptive(limit:50, filter:{datetime_geq:"${since}"}) {
        sum { requests errors } dimensions { scriptName } } } } }`;
    try {
      const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const j = await r.json();
      const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      const ours = rows.filter((x) => String(x.dimensions.scriptName).startsWith("bullmoose"));
      if (!ours.length) console.log("  · worker traffic    no bullmoose requests in 24h");
      for (const x of ours) {
        const { requests, errors } = x.sum;
        const line = `${String(x.dimensions.scriptName).padEnd(24)} ${requests} req, ${errors} err`;
        if (errors > 0) fail("worker errors", line);
        else pass("traffic", line);
      }
    } catch (e) {
      console.log(`  · worker traffic    unavailable (${e})`);
    }
  }

  console.log(bad === 0 ? "\ndone — doctor: nothing to report" : `\ndone — doctor: ${bad} problem(s) above`);
  if (bad > 0) process.exitCode = 1;
}

// ───────────────────────────────── driver ───────────────────────────────────

export const PHASES = { resources, wire, schemas, migrate, secrets, deploy, explorer, doctor };
// migrate sits BETWEEN schemas and deploy, and that position is the point.
// `schemas` cannot upgrade an existing database -- every DDL is IF NOT EXISTS,
// which is idempotent for CREATING and silently declines to UPGRADE -- and two
// of the migrations (accounts.deleted_at, grants.revoked_at) are ones
// verifyBearer filters on, so a worker deployed against a database missing them
// authenticates nobody. Running it after `deploy` would be too late.
//
// ⚠️ TWO PHASES ARE DELIBERATELY ABSENT FROM THIS LIST, for opposite reasons:
//
//   doctor    changes nothing and asserts nothing about code; a deploy run has
//             no business also grading the deployment.
//   explorer  changes something a default run must never change. It publishes
//             a hostname that mirrors, read-only, everything the caller can
//             see (`.plans/s21-explorer` open question 2: "a deployment that
//             does not want it must serve NOTHING"). Adding it here would turn
//             that on for every deployment of this repo, and the person it
//             surprised would be the one who ran the ordinary deploy command.
//             `infra/explorer.test.ts` pins the exclusion.
export const ALL = ["resources", "wire", "schemas", "migrate", "secrets", "deploy"];

function help() {
  console.log(`bullmoose deploy bootstrap

  node infra/bootstrap.mjs [phase] [--dry-run] [--yes]

  phases:  ${ALL.join("  ")}   (default: all)\n  doctor      read-only: is the DEPLOYED world still the one we think we deployed?\n              (not part of a default run — it changes nothing and asserts nothing about code)
  explorer    turn s21's read-only mirror on at ${EXPLORE_HOSTNAME}:
              DNS record, route + OAUTH binding in ${cfg(EXPLORE_WORKER)},
              a one-time OAuth client registration, and the secrets. Every
              step skips itself if already done. NOT part of a default run —
              it publishes a read-everything surface, so it is a decision.
              \`explorer --off\` re-comments the config and deletes the record.
              Both finish with: node infra/bootstrap.mjs deploy
  --dry-run   show every command/edit; touch nothing
  --yes       auto-confirm wrangler's d1-execute prompt
  --off       with \`explorer\`: withdraw it (see that phase's own output for
              what it leaves behind, and why)
  --rotate    allow the secrets phase to REPLACE values already live.
              Without it, a machine whose ${ENV_FILE} is missing refuses
              rather than minting fresh secrets over production —
              VAULT_MASTER_KEY in particular is unrecoverable.
              Also gates EXPLORE_COOKIE_KEY, whose replacement silently signs
              out every live explorer session.

  auth: npx wrangler login   (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
  runbook: docs/DEPLOY.md`);
}

// async because two phases are: `doctor` fetches, and `explorer` talks to the
// Cloudflare and OAuth APIs. They used not to be awaited, which was harmless
// only while doctor was the sole async phase AND always ran alone — its output
// still landed after main's closing "done" line.
async function main() {
  if (args.includes("-h") || args.includes("--help")) return help();
  if (phaseArg !== "all" && !PHASES[phaseArg])
    die(`unknown phase '${phaseArg}'. one of: all ${ALL.join(" ")} explorer doctor`);

  const plan = phaseArg === "all" ? ALL : [phaseArg];
  console.log(`bullmoose bootstrap — ${paint(c.cyn, plan.join(" → "))}${DRY ? paint(c.yel, "  (dry-run)") : ""}`);

  // Read .env BEFORE the liveness check below. loadEnv exports the wrangler
  // credentials into process.env, and the check consults them — so doing this
  // lazily inside `secrets` would mean a machine with a perfectly good token in
  // .env still failed the preflight it was supposed to satisfy.
  loadEnv();

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
  for (const p of plan) await PHASES[p]();
  console.log(`\n${paint(c.grn, "done")} — ${plan.join(", ")}${DRY ? " (dry-run; nothing changed)" : ""}`);
}

// Only run when invoked directly — importing (for tests) must not execute.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
