#!/usr/bin/env node
// Deploy pre-flight: is this Cloudflare account ready for docs/DEPLOY.md?
//
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_ZONE_ID=... [DOMAIN=bullmoose.cc] \
//     node tools/preflight.mjs
//
// Read-only — never mutates anything. Token scopes for full coverage:
// Zone:Read, DNS:Read, Email Routing:Read, Workers Scripts:Read, D1:Read,
// Workers KV:Read, R2:Read. Missing scopes degrade to SKIP, not failure.

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const ZONE = process.env.CF_ZONE_ID;
const DOMAIN = process.env.DOMAIN ?? "bullmoose.cc";

if (!TOKEN || !ACCOUNT || !ZONE) {
  console.error("required env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID (optional: DOMAIN)");
  process.exit(1);
}

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const fail = (msg) => (failures++, console.log(`  ✗ ${msg}`));
const skip = (msg) => console.log(`  – SKIP ${msg}`);

async function cf(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

console.log(`pre-flight for ${DOMAIN} (zone ${ZONE.slice(0, 8)}…, account ${ACCOUNT.slice(0, 8)}…)\n`);

// 1. Token is alive at all
{
  const r = await cf("/user/tokens/verify");
  if (r.success) ok(`API token valid (status: ${r.result?.status})`);
  else {
    fail(`API token rejected (${r.status}) — nothing below can run`);
    process.exit(1);
  }
}

// 2. Zone: exists, active, right domain, right account
{
  const r = await cf(`/zones/${ZONE}`);
  if (!r.success) fail(`zone lookup failed (${r.status}) — token missing Zone:Read?`);
  else {
    const z = r.result;
    if (z.name !== DOMAIN) fail(`zone is ${z.name}, expected ${DOMAIN} (set DOMAIN= if intentional)`);
    else ok(`zone ${z.name} found`);
    if (z.status === "active") ok(`zone status: active`);
    else fail(`zone status: ${z.status} — must be active before Email Routing works`);
    if (z.account?.id === ACCOUNT) ok(`zone belongs to the given account`);
    else fail(`zone belongs to account ${z.account?.id ?? "?"} — CF_ACCOUNT_ID mismatch`);
    if (z.plan?.name) ok(`zone plan: ${z.plan.name}`);
  }
}

// 3. Existing MX records — Email Routing will manage MX; pre-existing
//    records mean mail currently flows somewhere else. Know before you cut.
{
  const r = await cf(`/zones/${ZONE}/dns_records?type=MX&per_page=50`);
  if (!r.success) skip(`DNS read (${r.status}) — token missing DNS:Read?`);
  else if (r.result.length === 0) ok(`no existing MX records — clean cutover`);
  else {
    const targets = r.result.map((rec) => `${rec.name}→${rec.content}`).join(", ");
    if (r.result.every((rec) => /mx\.cloudflare\.net$/.test(rec.content))) {
      ok(`MX already points at Cloudflare Email Routing (${r.result.length} records)`);
    } else {
      warn(`existing MX records found: ${targets}`);
      warn(`  onboarding will repoint mail delivery — confirm nothing depends on the old MX`);
    }
  }
}

// 4. Email Routing state on the zone
{
  const r = await cf(`/zones/${ZONE}/email/routing`);
  if (!r.success) skip(`Email Routing read (${r.status}) — token missing Email Routing:Read?`);
  else {
    const s = r.result;
    if (s.enabled === true) ok(`Email Routing already enabled (status: ${s.status ?? "?"})`);
    else warn(`Email Routing not yet enabled — 'admin domain add' will enable it`);
  }
}

// 5. workers.dev subdomain (first-light URLs live under it)
{
  const r = await cf(`/accounts/${ACCOUNT}/workers/subdomain`);
  if (!r.success) skip(`workers subdomain read (${r.status}) — token missing Workers Scripts:Read?`);
  else if (r.result?.subdomain) ok(`workers.dev subdomain: ${r.result.subdomain}.workers.dev`);
  else warn(`no workers.dev subdomain claimed — claim one in the dash before deploying`);
}

// 6. Name collisions with resources DEPLOY.md will create
{
  const r = await cf(`/accounts/${ACCOUNT}/workers/scripts`);
  if (!r.success) skip(`workers list (${r.status})`);
  else {
    const names = new Set((r.result ?? []).map((s) => s.id));
    const ours = ["bullmoose-jmap", "bullmoose-ingest", "bullmoose-submit", "bullmoose-provision"];
    const clash = ours.filter((n) => names.has(n));
    if (clash.length > 0) warn(`workers already deployed: ${clash.join(", ")} (re-deploy will overwrite)`);
    else ok(`no existing bullmoose-* workers (${names.size} other scripts on account)`);
  }
}
{
  const r = await cf(`/accounts/${ACCOUNT}/d1/database?per_page=100`);
  if (!r.success) skip(`D1 list (${r.status}) — token missing D1:Read?`);
  else {
    const hit = (r.result ?? []).find((d) => d.name === "bullmoose-mail-shard0");
    if (hit) warn(`D1 'bullmoose-mail-shard0' already exists (id ${hit.uuid}) — reuse it, don't recreate`);
    else ok(`D1 name 'bullmoose-mail-shard0' is free`);
  }
}
{
  const r = await cf(`/accounts/${ACCOUNT}/r2/buckets`);
  if (!r.success) skip(`R2 list (${r.status}) — token missing R2:Read (or R2 not enabled)?`);
  else {
    const hit = (r.result?.buckets ?? []).find((b) => b.name === "bullmoose-mail-blobs");
    if (hit) warn(`R2 bucket 'bullmoose-mail-blobs' already exists — reuse it`);
    else ok(`R2 bucket name 'bullmoose-mail-blobs' is free`);
  }
}

console.log(
  failures === 0
    ? `\nready: no blockers found — proceed with docs/DEPLOY.md`
    : `\n${failures} blocker(s) above — fix before deploying`,
);
process.exit(failures === 0 ? 0 : 2);
