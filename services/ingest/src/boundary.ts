// The boundary cascade, stages 1–2 + wiring (s12 wave 1-A).
//
// Cost-ordered, each stage emitting ACCEPT (skip remaining rejection stages,
// go to stamping), REJECT (edge or quarantine, naming the firing stage), or
// CONTINUE (next stage sees only the survivors). Stages 3–4 are wired against
// the s12-B contract (boundaryContract.ts) and are pass-through until the
// `@bullmoose/boundary` engines land.
//
//   1. sender sets  — bloom-fronted membership: known-good → ACCEPT,
//                     deny-listed domain → REJECT-AT-EDGE (5xx, zero storage,
//                     counters not chains), blocked book → REJECT-STORE
//                     (quarantine mailbox + chain row)
//   2. envelope auth — hard DMARC fail per the topmost Authentication-Results
//                     header → REJECT-STORE 'auth:dmarc'
//   3. sieve rules   — real engine (@bullmoose/boundary); no rules stored yet
//                     so every message passes until wave 2 wires rule storage
//   4. Bayes         — real engine; no trained per-account state stored yet
//                     (null → skip), trained by wave 2's rescue/report labels
//
// DefaultCase is pinned: with no deny rows, no blocked books, no bloom and no
// default contacts book, every stage returns CONTINUE with a null sender
// class, and delivery is byte-identical to pre-s12 ingest (boundary.test.ts
// proves it against the real handler).
//
// Fail-open discipline: this file sits on the delivery hot path, so every D1
// read it adds is wrapped — a shard that predates the s12 migrations, or a
// query that throws, degrades to "no verdict" (CONTINUE) with a console
// error, never a bounce. The deny tiers are deny-only, so failing open is an
// availability bruise in the SPAM direction only; it can never leak mail.

import { Mailstore, normalizeAddress } from "@bullmoose/mailstore";
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
 * one author class per facet).
 */
export interface BoundaryVerdict {
  action: "ACCEPT" | "CONTINUE" | "REJECT_EDGE" | "REJECT_STORE";
  /** ACCEPT → 'known'; stage-1 CONTINUE → 'unknown' | null; otherwise null. */
  senderClass: "known" | "unknown" | null;
  /** The firing stage, on rejects ('deny-list', 'auth:dmarc', ...). */
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
 * The industrial tier's ONLY per-message write: one daily-counter upsert,
 * never a chain row — an attacker must not be able to make us pay a chain
 * INSERT per spam message. Failure is logged and the reject stands.
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
// Stages 3–4 — wired against the s12-B contract, pass-through until the
// engines land.

/** Rule storage lands with s12-B; until then the configured set is empty. */
const NO_SIEVE_RULES: SieveRule[] = [];

export function stage3Sieve(rules: SieveRule[], msg: BoundaryMessage): BoundaryVerdict {
  const r = sieveVerdict(rules, msg);
  if (r.verdict === "FAIL") {
    return { action: "REJECT_STORE", senderClass: null, stage: `sieve:${r.ruleId ?? "unknown"}` };
  }
  return CONTINUE;
}

/** Two thresholds, not one: ≥ T_reject rejects, ≤ T_clean is clean, between
 * is the mid-band that will escalate to the LLM stage (s12, later wave —
 * until it exists the mid-band passes through, deliberately). */
export const BAYES_T_REJECT = 0.97;
export const BAYES_T_CLEAN = 0.03;

export function stage4Bayes(state: BayesState | null, msg: BoundaryMessage): BoundaryVerdict {
  if (state === null) return CONTINUE; // no trained per-account state stored (s12-B)
  const { score } = bayesClassify(state, msg);
  if (score >= BAYES_T_REJECT) {
    return { action: "REJECT_STORE", senderClass: null, stage: `bayes@${score.toFixed(2)}` };
  }
  // ≤ T_clean is clean; the mid-band between the thresholds passes through
  // until the escalation stage exists. Both are CONTINUE today.
  return CONTINUE;
}

/**
 * Stages 2–4 over one parsed message (stage 1 already ran, envelope-only,
 * and returned CONTINUE). Each stage sees only the survivors of the last.
 */
export function runBoundaryStages2to4(msg: BoundaryMessage): BoundaryVerdict {
  const s2 = stage2EnvelopeAuth(msg);
  if (s2.action !== "CONTINUE") return s2;
  const s3 = stage3Sieve(NO_SIEVE_RULES, msg);
  if (s3.action !== "CONTINUE") return s3;
  const s4 = stage4Bayes(null, msg);
  if (s4.action !== "CONTINUE") return s4;
  return CONTINUE;
}
