// The boundary cascade, stages 1–4 + wiring (s12 waves 1-A + 2-C).
//
// Cost-ordered, each stage emitting ACCEPT (skip remaining rejection stages,
// go to stamping), REJECT (edge or quarantine, naming the firing stage),
// SCREEN (the Bayes mid-band holding for the classifier), or CONTINUE (next
// stage sees only the survivors).
//
//   1. sender sets  — bloom-fronted membership: known-good → ACCEPT,
//                     deny-listed domain → REJECT-AT-EDGE (5xx, zero storage,
//                     counters not chains), blocked book → REJECT-STORE
//                     (quarantine mailbox + chain row)
//   2. envelope auth — hard DMARC fail per the topmost Authentication-Results
//                     header → REJECT-STORE 'auth:dmarc'
//   3. sieve rules   — the account's stored ruleset (sieve_rules, wave 2-C);
//                     empty/absent/unreadable → NO rules, every message passes
//   4. Bayes         — the account's trained state (bayes_state, wave 2-C);
//                     absent/corrupt → null → skip. Two thresholds: ≥ reject
//                     → REJECT-STORE 'bayes@score'; ≤ clean → CONTINUE;
//                     between → SCREEN, the mid-band that escalates to the
//                     LLM classifier (stage 5, run by services/agent) when
//                     the tenant has a bouncer binding — and DELIVERS
//                     normally when it does not (no held mail without a
//                     classifier to come for it)
//
// DefaultCase is pinned: with no deny rows, no blocked books, no bloom, no
// default contacts book, no stored rules, no trained state and no bouncer
// binding, every stage returns CONTINUE with a null sender class, and
// delivery is byte-identical to pre-s12 ingest (boundary.test.ts proves it
// against the real handler).
//
// Fail-open discipline: this file sits on the delivery hot path, so every D1
// read it adds is wrapped — a shard that predates the s12 migrations, or a
// query that throws, degrades to "no verdict" (CONTINUE) with a console
// error, never a bounce. The deny tiers are deny-only, so failing open is an
// availability bruise in the SPAM direction only; it can never leak mail.

import {
  Mailstore,
  listSieveRules,
  loadBayesState,
  normalizeAddress,
} from "@bullmoose/mailstore";
import {
  bayesClassify,
  sieveVerdict,
  type BayesState,
  type BoundaryMessage,
  type SieveRule,
} from "./boundaryContract";
import {
  bloomAdd,
  bloomCreate,
  bloomDeserialize,
  bloomHas,
  bloomSerialize,
  type BloomFilter,
} from "./bloom";

export interface BoundaryEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace;
}

/**
 * One verdict shape for every stage. `senderClass` is stage 1's alone —
 * later stages never author it (the s11 T6 facet column it feeds has exactly
 * one author class per facet). SCREEN (wave 2-C) is the Bayes mid-band: hold
 * in quarantine with a 'screened' chain row and enqueue the classifier — or,
 * when the tenant has no bouncer binding, deliver normally (fail open).
 */
export interface BoundaryVerdict {
  action: "ACCEPT" | "CONTINUE" | "REJECT_EDGE" | "REJECT_STORE" | "SCREEN";
  /** ACCEPT → 'known'; stage-1 CONTINUE → 'unknown' | null; otherwise null. */
  senderClass: "known" | "unknown" | null;
  /** The firing stage, on rejects and screens ('deny-list', 'auth:dmarc', ...). */
  stage?: string;
  /** The SMTP 5xx line, on REJECT_EDGE. */
  smtpReply?: string;
}

const CONTINUE: BoundaryVerdict = { action: "CONTINUE", senderClass: null };

/** Lowercase, strip a surrounding <>, trim. "" for the null sender. */
export function normalizeSender(raw: string): string {
  const s = normalizeAddress(raw);
  return s === "<>" ? "" : s.replace(/^</, "").replace(/>$/, "");
}

/** Lowercase, no leading/trailing dots — the domain_deny_list normal form. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

export function senderDomainOf(sender: string): string {
  const at = sender.lastIndexOf("@");
  return at < 0 ? "" : normalizeDomain(sender.slice(at + 1));
}

// ---------------------------------------------------------------------------
// The bloom: a derived index over the union of ALL blocked tiers, in KV.
//
//   boundary:bloom:current      {version, build} — the pointer, read per
//                               message (same cost class as the route lookup)
//   boundary:bloom:v<version>   the serialized filter, read only when the
//                               isolate cache is stale
//
// `build` is a fresh uuid per rebuild; the isolate cache keys on it, so a
// version check is exact even across racing rebuilds. NO bloom published at
// all (fresh deploy, or a rebuild has never run) means the exact checks run
// unconditionally — the bloom is a fast path, not the source of truth, and
// its absence must not silently disable blocking.

const BLOOM_CURRENT_KEY = "boundary:bloom:current";
const bloomKeyOf = (version: number) => `boundary:bloom:v${version}`;
/** Per-tenant config naming the tenant-wide blocked book: {accountId, bookId}. */
const tenantBlockedKeyOf = (tenantId: string) => `boundary:tenant-blocked:${tenantId}`;
const TENANT_BLOCKED_PREFIX = "boundary:tenant-blocked:";

interface BloomPointer {
  version: number;
  build: string;
}

let isolateBloom: { build: string; filter: BloomFilter } | null = null;

/** Tests only: the isolate cache outlives a test's fake KV. */
export function __resetBoundaryBloomCache(): void {
  isolateBloom = null;
}

/**
 * The current filter, or null when none is published (→ exact checks run).
 * One KV get per message when cached; one more on version change.
 */
async function loadBloom(kv: KVNamespace): Promise<BloomFilter | null> {
  let pointer: BloomPointer | null = null;
  try {
    pointer = await kv.get<BloomPointer>(BLOOM_CURRENT_KEY, "json");
  } catch {
    return null;
  }
  if (!pointer || typeof pointer.version !== "number" || typeof pointer.build !== "string") {
    return null;
  }
  if (isolateBloom?.build === pointer.build) return isolateBloom.filter;
  try {
    const serialized = await kv.get(bloomKeyOf(pointer.version));
    if (serialized === null) return null; // torn publish — fall back to exact checks
    const filter = bloomDeserialize(serialized);
    isolateBloom = { build: pointer.build, filter };
    return filter;
  } catch (err) {
    console.error(`boundary bloom v${pointer.version} unreadable: ${err}`);
    return null;
  }
}

/**
 * Rebuild the derived index from its canonical sources and publish it.
 *
 * Union of: every domain_deny_list domain (all tenants on the shard — the
 * bloom is shard-wide; scoping is the exact checks' job, a cross-tenant hit
 * only costs one exact lookup) + every member of every blocked book (by the
 * 'Blocked' naming convention and by tenant config). MUST be called after any
 * write that ADDS a blocked entry — an addition the bloom has not seen is a
 * false negative, the one error class blooms cannot have. Removals can wait:
 * a stale POSSIBLY_YES falls through to the exact checks and costs nothing.
 */
export async function rebuildBoundaryBloom(
  env: BoundaryEnv,
): Promise<{ version: number; entries: number }> {
  const store = new Mailstore(env.DB, env.BLOBS);
  const entries = new Set<string>();

  try {
    const { results } = await env.DB.prepare(`SELECT domain FROM domain_deny_list`).all<{
      domain: string;
    }>();
    for (const r of results) entries.add(normalizeDomain(r.domain));
  } catch {
    /* pre-migration shard: no deny tier to index */
  }

  const books = new Map<string, { accountId: string; bookId: string }>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT account_id, id FROM address_books WHERE LOWER(name) = 'blocked'`,
    ).all<{ account_id: string; id: string }>();
    for (const r of results) books.set(`${r.account_id}/${r.id}`, { accountId: r.account_id, bookId: r.id });
  } catch {
    /* no address_books on this shard */
  }
  const configured = await env.ROUTES.list({ prefix: TENANT_BLOCKED_PREFIX });
  for (const key of configured.keys) {
    const cfg = await env.ROUTES.get<{ accountId: string; bookId: string }>(key.name, "json");
    if (cfg?.accountId && cfg?.bookId) books.set(`${cfg.accountId}/${cfg.bookId}`, cfg);
  }
  for (const { accountId, bookId } of books.values()) {
    for (const address of await store.bookMembership(accountId, bookId)) {
      entries.add(normalizeAddress(address));
    }
  }

  const filter = bloomCreate(entries.size);
  for (const e of entries) bloomAdd(filter, e);

  const current = await env.ROUTES.get<BloomPointer>(BLOOM_CURRENT_KEY, "json");
  const version = (current?.version ?? 0) + 1;
  const build = crypto.randomUUID();
  // Filter first, pointer second — a reader that races the publish either
  // keeps the old version or finds the new one complete.
  await env.ROUTES.put(bloomKeyOf(version), bloomSerialize(filter));
  await env.ROUTES.put(BLOOM_CURRENT_KEY, JSON.stringify({ version, build }));
  return { version, entries: entries.size };
}

// ---------------------------------------------------------------------------
// Stage 1 — sender sets (envelope-only: runs BEFORE the MIME parse, so a
// deny-listed domain exits at the SMTP edge having cost us nothing).

async function inDenyList(db: D1Database, tenantId: string, domain: string): Promise<boolean> {
  if (domain === "") return false;
  try {
    const row = await db
      .prepare(`SELECT 1 AS hit FROM domain_deny_list WHERE tenant_id = ? AND domain = ?`)
      .bind(tenantId, domain)
      .first<{ hit: number }>();
    return row?.hit === 1;
  } catch (err) {
    // Pre-migration shard, or D1 hiccup: an empty deny list, said out loud.
    console.error(`deny-list check degraded to empty (${err instanceof Error ? err.message : err})`);
    return false;
  }
}

/**
 * One daily-counter upsert, never a chain row. Two callers, one table:
 *
 *   · REJECT-AT-EDGE (deny-listed domains) — the industrial tier's ONLY
 *     per-message write; an attacker must not be able to make us pay a chain
 *     INSERT per spam message.
 *   · expensive-stage REJECT-STORE (sieve/bayes, wave 2-C) — these messages
 *     already paid the parse and the quarantine batch, and their counts are
 *     what the GRADUATION sweep aggregates ("N Bayes/sieve rejects, no
 *     rescues" → the domain graduates into the deny list).
 *
 * Failure is logged and the reject stands.
 */
export async function bumpDenyCounter(
  db: D1Database,
  domain: string,
  now = Date.now(),
): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await db
      .prepare(
        `INSERT INTO deny_counters (domain, day, count) VALUES (?, ?, 1)
         ON CONFLICT (domain, day) DO UPDATE SET count = count + 1`,
      )
      .bind(domain, day)
      .run();
  } catch (err) {
    console.error(`deny counter bump failed for ${domain}: ${err instanceof Error ? err.message : err}`);
  }
}

/** The recipient account's personal blocked book, by the naming convention. */
async function personalBlockedBookId(db: D1Database, accountId: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT id FROM address_books WHERE account_id = ? AND LOWER(name) = 'blocked'`)
      .bind(accountId)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** The recipient account's known-good book = its DEFAULT contacts book. */
async function defaultBookId(db: D1Database, accountId: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT id FROM address_books WHERE account_id = ? AND is_default = 1`)
      .bind(accountId)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function isBookMember(store: Mailstore, accountId: string, bookId: string, sender: string): Promise<boolean> {
  try {
    return (await store.bookMembership(accountId, bookId)).has(sender);
  } catch (err) {
    console.error(`book membership check degraded to empty (${err instanceof Error ? err.message : err})`);
    return false;
  }
}

/**
 * Stage 1. Membership sources, in tier order once the bloom says
 * POSSIBLY_YES (blocked beats known-good: an explicit block on a contact is
 * still a block, and over-blocking is visible in quarantine and rescuable):
 *
 *   a. domain_deny_list (tenant-scoped, exact domain)  → REJECT_EDGE
 *   b. tenant blocked book (KV `boundary:tenant-blocked:<tenantId>` names
 *      {accountId, bookId} — operator-set config, the simplest honest
 *      mechanism until bouncer@'s account exists)      → REJECT_STORE
 *   c. personal blocked book (a book named 'Blocked',
 *      case-insensitive, on the recipient account)     → REJECT_STORE
 *
 * Then known-good: membership in the recipient's DEFAULT contacts book →
 * ACCEPT with sender_class='known'. Otherwise CONTINUE — 'unknown' when a
 * default book exists to be absent from, null when the account has no
 * known-good set at all (the DefaultCase: a classification against no set is
 * no classification, and the stamp stays NULL exactly as ingest stamps today).
 */
export async function stage1SenderSets(
  env: BoundaryEnv,
  route: { accountId: string; tenantId: string },
  envelopeFrom: string,
): Promise<BoundaryVerdict> {
  const store = new Mailstore(env.DB, env.BLOBS);
  const sender = normalizeSender(envelopeFrom);
  const domain = senderDomainOf(sender);

  const bloom = await loadBloom(env.ROUTES);
  const maybeBlocked =
    bloom === null || // no derived index published → the exact checks decide
    (domain !== "" && bloomHas(bloom, domain)) ||
    (sender !== "" && bloomHas(bloom, sender));

  if (maybeBlocked) {
    if (await inDenyList(env.DB, route.tenantId, domain)) {
      return {
        action: "REJECT_EDGE",
        senderClass: null,
        stage: "deny-list",
        smtpReply: "550 5.7.1 sender address rejected",
      };
    }
    if (sender !== "") {
      const tenantCfg = await env.ROUTES.get<{ accountId: string; bookId: string }>(
        tenantBlockedKeyOf(route.tenantId),
        "json",
      );
      if (
        tenantCfg?.accountId &&
        tenantCfg?.bookId &&
        (await isBookMember(store, tenantCfg.accountId, tenantCfg.bookId, sender))
      ) {
        return { action: "REJECT_STORE", senderClass: null, stage: "blocked-book:tenant" };
      }
      const personal = await personalBlockedBookId(env.DB, route.accountId);
      if (personal !== null && (await isBookMember(store, route.accountId, personal, sender))) {
        return { action: "REJECT_STORE", senderClass: null, stage: "blocked-book:personal" };
      }
    }
  }

  const knownGood = await defaultBookId(env.DB, route.accountId);
  if (knownGood === null) return CONTINUE;
  if (sender !== "" && (await isBookMember(store, route.accountId, knownGood, sender))) {
    return { action: "ACCEPT", senderClass: "known" };
  }
  return { action: "CONTINUE", senderClass: "unknown" };
}

// ---------------------------------------------------------------------------
// Stage 2 — envelope auth.
//
// What the platform actually provides: Cloudflare Email Routing verifies
// SPF/DKIM/DMARC at its MX and PREPENDS an Authentication-Results header to
// the raw message before invoking this worker — that header is present in
// `message.raw` and survives the parse; the ForwardableEmailMessage object
// itself exposes no structured auth result. Trust model (RFC 8601 §1.6):
// only the TOPMOST Authentication-Results header is ours — every hop
// prepends, so an attacker's forged header can only sit BELOW the one our
// MX added and is never consulted. Conservative by construction: only an
// explicit `dmarc=fail` in that header rejects; pass, none, absent, or any
// value we do not recognize → CONTINUE, recording nothing.

export function stage2EnvelopeAuth(msg: BoundaryMessage): BoundaryVerdict {
  const topmost = msg.headers.find((h) => h.key === "authentication-results");
  if (!topmost) return CONTINUE;
  if (/\bdmarc\s*=\s*fail\b/i.test(topmost.value)) {
    return { action: "REJECT_STORE", senderClass: null, stage: "auth:dmarc" };
  }
  return CONTINUE;
}

// ---------------------------------------------------------------------------
// Stages 3–4 — the real engines over the account's STORED inputs (wave 2-C):
// sieve_rules and bayes_state, both loaded fail-open by @bullmoose/mailstore
// (missing table / corrupt row / oversized row → no rules / null state, with
// a console.error — never a delivery error).

export function stage3Sieve(rules: SieveRule[], msg: BoundaryMessage): BoundaryVerdict {
  const r = sieveVerdict(rules, msg);
  if (r.verdict === "FAIL") {
    return { action: "REJECT_STORE", senderClass: null, stage: `sieve:${r.ruleId ?? "unknown"}` };
  }
  return CONTINUE;
}

/** Two thresholds, not one: ≥ T_reject rejects, ≤ T_clean is clean, between
 * is the MID-BAND that escalates to the LLM classifier (SCREEN). */
export const BAYES_T_REJECT = 0.97;
export const BAYES_T_CLEAN = 0.03;

export function stage4Bayes(state: BayesState | null, msg: BoundaryMessage): BoundaryVerdict {
  if (state === null) return CONTINUE; // no trained per-account state — fail open
  const { score } = bayesClassify(state, msg);
  if (score >= BAYES_T_REJECT) {
    return { action: "REJECT_STORE", senderClass: null, stage: `bayes@${score.toFixed(2)}` };
  }
  if (score > BAYES_T_CLEAN) {
    // The mid-band IS the escalation channel (bayes.ts): not a reject — a
    // request for the model's judgment. The wiring in index.ts holds the
    // message ('screened') only when a bouncer binding exists to answer.
    return { action: "SCREEN", senderClass: null, stage: `bayes-mid@${score.toFixed(2)}` };
  }
  return CONTINUE;
}

/**
 * Stages 2–4 over one parsed message (stage 1 already ran, envelope-only,
 * and returned CONTINUE). Each stage sees only the survivors of the last.
 * The stored inputs load per message: rules and state are one small D1 read
 * each, and only for stage-1 survivors (ACCEPT fast-paths never pay it).
 */
export async function runBoundaryStages2to4(
  db: D1Database,
  accountId: string,
  msg: BoundaryMessage,
): Promise<BoundaryVerdict> {
  const s2 = stage2EnvelopeAuth(msg);
  if (s2.action !== "CONTINUE") return s2;
  const s3 = stage3Sieve(await listSieveRules(db, accountId), msg);
  if (s3.action !== "CONTINUE") return s3;
  const s4 = stage4Bayes(await loadBayesState(db, accountId), msg);
  if (s4.action !== "CONTINUE") return s4;
  return CONTINUE;
}

// ---------------------------------------------------------------------------
// The deny-list write path (wave 2-C) — bouncer@'s working data.

/** The stages whose rejects the graduation loop counts: the EXPENSIVE ones. */
export const EXPENSIVE_STAGE = /^(sieve:|bayes@)/;

/**
 * Add a domain to the industrial deny tier and republish the derived bloom —
 * the ONE write path for deny-list additions (directives, feed refreshes, and
 * the graduation sweep all land here; wave 2-D calls it for FN reports).
 *
 * Tenant resolution: the deny list is tenant-scoped (wave 1-A pin), so the
 * row needs a tenant. Pass `opts.tenantId` when the caller knows it (a
 * directive names the directing account's tenant); otherwise the tenants
 * that have quarantine chain rows for this domain — the tenants whose mail
 * it actually hit — each get the entry. No tenant resolvable → logged no-op.
 *
 * `INSERT OR IGNORE`: an existing entry (any source) is never overwritten —
 * a graduation must not repaint a 'directive' row, and re-adding is a no-op.
 * The bloom rebuilds only when a row actually landed; pass
 * `rebuildBloom: false` to batch several adds under ONE rebuild (the sweep
 * does — rebuild once per sweep, not per domain).
 */
export async function addDenyDomain(
  env: BoundaryEnv,
  domain: string,
  source: "directive" | "graduated" | "feed",
  evidence: string | null,
  opts: { tenantId?: string; rebuildBloom?: boolean } = {},
): Promise<{ added: boolean; tenants: string[] }> {
  const normalized = normalizeDomain(domain);
  if (normalized === "") return { added: false, tenants: [] };

  let tenants: string[];
  if (opts.tenantId !== undefined) {
    tenants = [opts.tenantId];
  } else {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT a.tenant_id AS tenant_id
       FROM quarantine_events q JOIN accounts a ON a.id = q.account_id
       WHERE q.domain = ?`,
    )
      .bind(normalized)
      .all<{ tenant_id: string }>();
    tenants = results.map((r) => r.tenant_id);
  }
  if (tenants.length === 0) {
    console.error(`addDenyDomain(${normalized}, ${source}): no tenant resolvable — not added`);
    return { added: false, tenants: [] };
  }

  let added = false;
  for (const tenantId of tenants) {
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO domain_deny_list (tenant_id, domain, added_at, source, evidence)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(tenantId, normalized, Date.now(), source, evidence)
      .run();
    if (res.meta.changes > 0) added = true;
  }
  // An addition the bloom has not seen is a false negative — the one error
  // class blooms cannot have — so additions MUST republish (rebuild header).
  if (added && opts.rebuildBloom !== false) await rebuildBoundaryBloom(env);
  return { added, tenants };
}

// ---------------------------------------------------------------------------
// Stage 5's doorbell — is there a classifier to escalate the mid-band to?

export interface BouncerBinding {
  id: string;
  name: string;
  accountId: string;
}

/**
 * The tenant's bouncer binding: an ENABLED agent_bindings row on any of the
 * tenant's accounts, named 'bouncer' (case-insensitive) or carrying the
 * config marker `"kind": "bouncer"`. First match in (account_id, id) order —
 * deterministic. NULL — including every load error — means the mid-band
 * DELIVERS normally: fail open, no held mail without a classifier coming.
 */
export async function resolveBouncerBinding(
  db: D1Database,
  tenantId: string,
): Promise<BouncerBinding | null> {
  type Row = { id: string; account_id: string; name: string; config_json: string };
  let rows: Row[];
  try {
    const { results } = await db
      .prepare(
        `SELECT b.id, b.account_id, b.name, b.config_json
         FROM agent_bindings b JOIN accounts a ON a.id = b.account_id
         WHERE a.tenant_id = ? AND b.enabled = 1
         ORDER BY b.account_id, b.id`,
      )
      .bind(tenantId)
      .all<Row>();
    rows = results;
  } catch {
    // Control plane not on this binding: the id-prefix convention holds
    // (provisioning mints `${tenantId}__a_${rand}` — the tenantOf degrade).
    try {
      const { results } = await db
        .prepare(
          `SELECT id, account_id, name, config_json FROM agent_bindings
           WHERE enabled = 1 ORDER BY account_id, id`,
        )
        .all<Row>();
      rows = results.filter((r) => r.account_id.startsWith(`${tenantId}__`));
    } catch (err) {
      console.error(`bouncer binding lookup degraded to none (${err instanceof Error ? err.message : err})`);
      return null;
    }
  }
  for (const r of rows) {
    let kind: unknown;
    try {
      kind = (JSON.parse(r.config_json || "{}") as { kind?: unknown }).kind;
    } catch {
      /* unreadable config: the name can still nominate it */
    }
    if (r.name.toLowerCase() === "bouncer" || kind === "bouncer") {
      return { id: r.id, name: r.name, accountId: r.account_id };
    }
  }
  return null;
}
