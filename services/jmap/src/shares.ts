/**
 * Share-link records — the state that makes revocation and enumeration
 * possible at all (sVOL unit `010` §2).
 *
 * THE PROBLEM. Share links were stateless HMAC: `handleShareCreate` signed
 * `tenant:account:blob:name:exp` and returned a URL, and NOTHING was written
 * down. The system did not know the link existed. That makes revocation
 * impossible for the same reason it makes enumeration impossible — there is
 * no record — so both features are one fix, not two.
 *
 * THE DECISION: KV, not a `shares` table.
 *
 *  1. A share record's useful life is EXACTLY the link's remaining life. KV's
 *     `expiration` reaps it at that instant, for free. A D1 table would
 *     need a sweeper — and this repo has no cron and no migration framework
 *     (`tools/README.md:10-11`), so the table is a migration plus a job that
 *     does not exist. KV's expiry is the whole lifecycle, already built.
 *  2. It bounds growth without anyone maintaining it: at most
 *     `SHARE_MAX_TTL` (90 days) plus `KV_MIN_TTL` of records can be live,
 *     whatever the mint rate, because a record outlives the link it describes
 *     by at most KV's floor (see `shareTombstoneExpiry`).
 *  3. `GET /share/*` is public and unauthenticated — the one route in this
 *     worker an anonymous internet client can reach. A D1 read there puts the
 *     mail database on the hot path of an anonymous request. KV does not.
 *  4. No schema change keeps the unit at **E2**. `packages/cli/src/admin.ts`
 *     anticipated a `shares` table ("needs the shares table"); that intent is
 *     recorded and declined, with reasons, in the unit file.
 *
 * THE COST, stated rather than discovered: KV is eventually consistent, so a
 * revocation can take up to ~60s to be visible at every edge. That is the
 * honest price of (1)-(4) and it is what the CLI prints on a successful
 * revoke. For a kill switch whose current implementation is "wait 90 days",
 * a minute is not the weak part.
 *
 * DENY BY DEFAULT. A download is served only if its record is present and
 * unrevoked. Fail-open (serve unless a tombstone says otherwise) was
 * rejected: it cannot answer "what links are live?", which is half the unit,
 * and it makes losing a KV key equivalent to un-revoking. The consequence is
 * that `shareId` is bound into the HMAC payload and every link minted before
 * this change stops verifying — a deliberate one-time flush, argued in the
 * unit file's Open Question #5.
 *
 * KEYSPACE. These live in the existing `ROUTES` namespace under `share:`,
 * alongside `login:` throttle windows. The unit recommended a SEPARATE
 * namespace; that is not available — `infra/bootstrap.mjs`'s `wireText`
 * rewrites only the FIRST `"id"` after `"kv_namespaces"` (a non-global
 * regex), so a second binding would deploy with an unwired id. The prefix is
 * the isolation mechanism this repo actually has.
 */

/** One minted share link. The `sig` is NOT stored — this is not a key store. */
export interface ShareRecord {
  shareId: string;
  tenantId: string;
  accountId: string;
  blobId: string;
  /** Filename as signed, after `/`-stripping. */
  name: string;
  /** Content type carried on the URL, when the minter supplied one. */
  type?: string;
  /** Link expiry, epoch SECONDS — the same value inside the HMAC payload. */
  exp: number;
  /** epoch ms */
  createdAt: number;
  /** epoch ms; present iff revoked. */
  revokedAt?: number;
}

const PREFIX = "share:";

/** KV's floor on expiry; anything sooner than this is rejected outright. */
const KV_MIN_TTL = 60;

export function shareKey(accountId: string, shareId: string): string {
  return `${PREFIX}${accountId}:${shareId}`;
}

export function accountPrefix(accountId: string): string {
  return `${PREFIX}${accountId}:`;
}

/** 128 bits — this id travels in a URL and is quoted back to revoke. */
export function newShareId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return `sh_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Write (or overwrite) a record, expiring it with the link.
 *
 * The death date is derived from `exp` on every write, so a revoke tombstone
 * inherits the ORIGINAL link's death date rather than extending it: the
 * tombstone only has to outlive the thing it kills, which is exactly the
 * property that bounds this keyspace.
 *
 * ONE exception, and it is KV's, not ours: a link with less than KV_MIN_TTL
 * left cannot be stored at its own death date, because KV rejects the write
 * outright. Revoking a link with 5s to live still has to deny those 5s, so the
 * record is floored to the minimum and the tombstone outlives the link by up
 * to KV_MIN_TTL. `shareTombstoneExpiry` is that rule, written once — the
 * keyspace stays bounded either way, just by 60s rather than by 0.
 *
 * Absolute `expiration` rather than relative `expirationTtl` on purpose: a TTL
 * is resolved against the clock at WRITE time, which is a second read of a
 * clock we already read to compute it. When a tick fell between the two reads
 * the record outlived `exp` by a second — rare, real, and the cause of a
 * genuinely confusing flake. An absolute instant is a pure function of `nowMs`.
 */
export function shareTombstoneExpiry(exp: number, nowMs: number): number {
  const floor = Math.floor(nowMs / 1000) + KV_MIN_TTL;
  return Math.max(exp, floor);
}

export async function putShareRecord(kv: KVNamespace, rec: ShareRecord, nowMs: number = Date.now()): Promise<void> {
  await kv.put(shareKey(rec.accountId, rec.shareId), JSON.stringify(rec), {
    expiration: shareTombstoneExpiry(rec.exp, nowMs),
  });
}

export async function getShareRecord(kv: KVNamespace, accountId: string, shareId: string): Promise<ShareRecord | null> {
  if (!shareId) return null;
  const raw = await kv.get(shareKey(accountId, shareId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShareRecord;
  } catch {
    // A record we cannot parse is a record we cannot honour. Deny-by-default
    // means treating it as absent, which fails closed.
    return null;
  }
}

/**
 * Every record still in KV for this account, newest mint first.
 *
 * Two costs, named rather than discovered:
 *
 *  - `list` returns keys, not values, so this is one `get` per share. Fine for
 *    an interactive `share list` and for the delete guard; it is NOT something
 *    to call in a loop or on the public download path (which reads exactly one
 *    key by name, deliberately).
 *  - The list is PAGINATED and the cursor is followed to completion. Taking
 *    only the first page would silently under-report an account with many
 *    links — and "the listing quietly omitted the leaked one" is the specific
 *    way this feature would be worse than useless.
 */
export async function listShareRecords(kv: KVNamespace, accountId: string): Promise<ShareRecord[]> {
  const prefix = accountPrefix(accountId);
  const out: ShareRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as ShareRecord);
      } catch {
        /* skip an unparseable record rather than failing the whole listing */
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export type RevokeOutcome = "revoked" | "alreadyRevoked" | "notFound";

/**
 * Tombstone a record rather than deleting it.
 *
 * Under deny-by-default a deleted key and a revoked key both refuse the
 * download, so this changes nothing for the public route — it exists for the
 * OPERATOR: `share list` can then show "revoked" instead of the link silently
 * vanishing, which is the difference between "the revoke worked" and "did I
 * type the id right?". The tombstone still dies with the link.
 */
export async function revokeShareRecord(
  kv: KVNamespace,
  accountId: string,
  shareId: string,
  nowMs: number = Date.now(),
): Promise<{ outcome: RevokeOutcome; record?: ShareRecord }> {
  const rec = await getShareRecord(kv, accountId, shareId);
  if (!rec) return { outcome: "notFound" };
  if (rec.revokedAt !== undefined) return { outcome: "alreadyRevoked", record: rec };
  const revoked: ShareRecord = { ...rec, revokedAt: nowMs };
  await putShareRecord(kv, revoked, nowMs);
  return { outcome: "revoked", record: revoked };
}

/** Unrevoked and unexpired — i.e. this link would still resolve. */
export function isLive(rec: ShareRecord, nowMs: number = Date.now()): boolean {
  return rec.revokedAt === undefined && rec.exp * 1000 > nowMs;
}

/** Live links pointing at one blob — what makes a blob delete refusable. */
export async function liveSharesForBlob(
  kv: KVNamespace,
  accountId: string,
  blobId: string,
  nowMs: number = Date.now(),
): Promise<ShareRecord[]> {
  const all = await listShareRecords(kv, accountId);
  return all.filter((r) => r.blobId === blobId && isLive(r, nowMs));
}
