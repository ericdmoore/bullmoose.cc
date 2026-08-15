import { afterEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, fakeKV } from "@bullmoose/test-fakes";
import worker, { type Env } from "./index";
import {
  listShareRecords,
  putShareRecord,
  shareKey,
  shareTombstoneExpiry,
  type ShareRecord,
} from "./shares";

/**
 * sVOL `010` — blob lifecycle: enumerate, delete, revoke.
 *
 * These drive the WORKER ENTRYPOINT (`worker.fetch`) over `@bullmoose/test-fakes`:
 * real `node:sqlite` on the live schema, the R2 fake, and the KV fake that
 * honours `expirationTtl` at read time. Nothing is stubbed between the request
 * and the store, so a route that forgot its scope gate or a revocation that
 * never reached KV fails here rather than passing.
 *
 * THE ASSERTION THAT MATTERS is `handleShareDownload` refusing AFTER a revoke.
 * Revocation is exactly the kind of control a shallow test fake-passes: assert
 * only that `POST …/revoke` returns 200 and you have tested that an endpoint
 * exists, not that anything was revoked. So every revoke test below re-fetches
 * the PUBLIC share URL — unauthenticated, exactly as a recipient would — and
 * additionally asserts the R2 object is still present, which proves the refusal
 * came from the kill switch and not from the bytes having been deleted.
 */

const TENANT = "t_bm";
const ACCOUNT = "a_eric";
const OTHER = "a_other";
const KEY = "test-share-signing-key";

interface Harness {
  env: Env;
  w: ReturnType<typeof fakeEnv>;
  /** Authenticated call as the harness's token. */
  call(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** Unauthenticated GET of an absolute URL — a share-link recipient. */
  open(url: string): Promise<Response>;
}

async function harness(scopes: string[] = ["mail"], configured = true): Promise<Harness> {
  const minted = await mintToken();
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
  });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(), // recent → no last_used write to add noise
    },
  ]);
  if (configured) w.env.SHARE_SIGNING_KEY = KEY;

  const env = w.env as Env;
  return {
    env,
    w,
    call: (method, path, init = {}) =>
      worker.fetch(
        new Request(`https://jmap.bullmoose.cc${path}`, {
          method,
          ...init,
          headers: { Authorization: `Bearer ${minted.token}`, ...(init.headers ?? {}) },
        }),
        env,
      ),
    open: (url) => worker.fetch(new Request(url), env),
  };
}

/** Upload through the real route, so the blobId is the one production mints. */
async function upload(h: Harness, body: string): Promise<string> {
  const res = await h.call("POST", `/api/upload/${ACCOUNT}`, {
    body,
    headers: { "content-type": "text/plain" },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { blobId: string }).blobId;
}

interface Minted {
  url: string;
  shareId: string;
  expiresAt: string;
}

async function mintShare(
  h: Harness,
  blobId: string,
  name = "report.txt",
  extra: Record<string, unknown> = {},
): Promise<Minted> {
  const res = await h.call("POST", `/api/share/${ACCOUNT}/${blobId}`, {
    body: JSON.stringify({ name, ...extra }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Minted;
}

/** An email row referencing a blob — the thing that makes a delete refusable. */
function seedEmail(
  h: Harness,
  opts: { id: string; rawBlobId: string; attachments?: Array<{ blobId: string }> },
): void {
  h.w.db.seed("emails", [
    {
      id: opts.id,
      account_id: ACCOUNT,
      blob_id: opts.rawBlobId,
      thread_id: `th_${opts.id}`,
      size: 10,
      received_at: 1,
      attachments_json: JSON.stringify(
        (opts.attachments ?? []).map((a) => ({
          blobId: a.blobId,
          type: "text/plain",
          name: "a.txt",
          size: 10,
          cid: null,
          disposition: "attachment",
        })),
      ),
    },
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("share revocation — the kill switch", () => {
  it("a minted link resolves, and a revoked one stops resolving", async () => {
    const h = await harness();
    const blobId = await upload(h, "the quarterly numbers");
    const share = await mintShare(h, blobId);

    const before = await h.open(share.url);
    expect(before.status).toBe(200);
    expect(await before.text()).toBe("the quarterly numbers");

    const revoke = await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);
    expect(revoke.status).toBe(200);
    expect((await revoke.json()) as Record<string, unknown>).toMatchObject({
      shareId: share.shareId,
      revoked: true,
      alreadyRevoked: false,
      blobId,
    });

    // The whole unit, in three lines: the SAME url, the SAME recipient, refused.
    const after = await h.open(share.url);
    expect(after.status).toBe(403);

    // …and refused because it was revoked, not because the bytes vanished.
    // A `deleteBlob` masquerading as a revoke would pass every assertion above.
    expect(h.w.blobs.objects.size).toBe(1);
    const stillThere = await h.call("GET", `/api/download/${ACCOUNT}/${blobId}`);
    expect(stillThere.status).toBe(200);
    expect(await stillThere.text()).toBe("the quarterly numbers");
  });

  it("revocation is recorded in KV, not just reported in the response", async () => {
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));

    const key = shareKey(ACCOUNT, share.shareId);
    const minted = JSON.parse(h.w.kv.store.get(key)!.value) as ShareRecord;
    expect(minted.revokedAt).toBeUndefined();
    expect(minted.blobId).toMatch(/^b_/);
    // The record dies WITH the link it describes — that is what bounds this
    // keyspace and removes the need for a sweeper. Exact, not ≤: the expiry is
    // an absolute instant computed from `exp`, so there is no clock to race.
    // (This assertion used to be `toBeLessThanOrEqual` against a relative TTL
    // and flaked whenever a second ticked between the two clock reads.)
    expect(h.w.kv.store.get(key)!.expiration).toBe(minted.exp);

    await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);

    const tombstone = JSON.parse(h.w.kv.store.get(key)!.value) as ShareRecord;
    expect(tombstone.revokedAt).toBeGreaterThan(0);
    // The tombstone inherits the link's death date rather than extending it.
    expect(h.w.kv.store.get(key)!.expiration).toBe(minted.exp);
  });

  // The regime the assertion above cannot reach, because a mintable link is
  // always longer-lived than KV's floor. Revoking a link with seconds to live
  // still has to DENY those seconds, so the record is floored to KV_MIN_TTL
  // and outlives the link — bounded, deliberate, and previously untested.
  describe("shareTombstoneExpiry — the KV floor is the only thing that extends a record", () => {
    const NOW_MS = 1_770_000_000_000; // pinned: the function must be pure in nowMs
    const nowSec = Math.floor(NOW_MS / 1000);

    it("a long-lived link dies exactly with the link", () => {
      expect(shareTombstoneExpiry(nowSec + 3600, NOW_MS)).toBe(nowSec + 3600);
    });

    it("a link inside the floor is extended to the floor, never dropped", () => {
      // 5s of life left: KV will not store that, and forgetting the record
      // would silently UN-revoke the link for its last 5 seconds.
      expect(shareTombstoneExpiry(nowSec + 5, NOW_MS)).toBe(nowSec + 60);
    });

    it("an already-expired link still gets the floor, not a past instant", () => {
      // A past `expiration` is a write KV discards immediately — same
      // un-revoke hazard, arrived at from the other side.
      expect(shareTombstoneExpiry(nowSec - 300, NOW_MS)).toBe(nowSec + 60);
    });

    it("is pure in nowMs — the same inputs give the same instant", () => {
      // The property that killed the flake: no second read of the clock.
      const a = shareTombstoneExpiry(nowSec + 3600, NOW_MS);
      const b = shareTombstoneExpiry(nowSec + 3600, NOW_MS + 999);
      expect(a).toBe(b);
    });

    it("writes an ABSOLUTE expiration, never a relative TTL", async () => {
      // Without this the fix is untestable and would rot straight back: the KV
      // fake normalizes `expirationTtl` into an `expiration` on the way in, so
      // a revert to the racing relative form is INVISIBLE in the store and
      // passes every other assertion in this file. Only the options object as
      // handed to `put` distinguishes them, so that is what gets asserted.
      const seen: Array<Record<string, unknown> | undefined> = [];
      const recorder = {
        async put(_k: string, _v: string, o?: Record<string, unknown>) {
          seen.push(o);
        },
      } as unknown as KVNamespace;

      await putShareRecord(
        recorder,
        {
          shareId: "sh_abs",
          tenantId: "t_x",
          accountId: ACCOUNT,
          blobId: "b_1",
          name: "n",
          exp: nowSec + 3600,
          createdAt: NOW_MS,
        },
        NOW_MS,
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveProperty("expiration", nowSec + 3600);
      expect(seen[0]).not.toHaveProperty("expirationTtl");
    });
  });

  it("revoking twice is idempotent and still refuses", async () => {
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));

    await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);
    const second = await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({
      alreadyRevoked: true,
    });
    expect((await h.open(share.url)).status).toBe(403);
  });

  it("revoking one link does not touch another link to the same blob", async () => {
    const h = await harness();
    const blobId = await upload(h, "shared bytes");
    const a = await mintShare(h, blobId, "a.txt");
    const b = await mintShare(h, blobId, "b.txt");
    expect(a.shareId).not.toBe(b.shareId);

    await h.call("POST", `/api/shares/${ACCOUNT}/${a.shareId}/revoke`);

    expect((await h.open(a.url)).status).toBe(403);
    expect((await h.open(b.url)).status).toBe(200);
  });

  it("a revoked link and a forged signature are indistinguishable", async () => {
    // Done-when #4: the endpoint must not be an oracle for which share ids
    // exist. Same status AND same bytes, or a prober can enumerate.
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));
    await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);

    const revoked = await h.open(share.url);
    const forged = await h.open(share.url.replace(/sig=[0-9a-f]+/, `sig=${"0".repeat(64)}`));

    expect(revoked.status).toBe(forged.status);
    expect(await revoked.text()).toBe(await forged.text());
  });

  it("stripping the share id from the url is refused the same way", async () => {
    // `sid` is inside the HMAC payload, so removing it breaks the signature —
    // and must NOT produce a distinguishable 400.
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));

    const stripped = await h.open(share.url.replace(/&sid=[^&]+/, ""));
    const forged = await h.open(share.url.replace(/sig=[0-9a-f]+/, `sig=${"0".repeat(64)}`));
    expect(stripped.status).toBe(403);
    expect(await stripped.text()).toBe(await forged.text());
  });

  it("substituting another live share id is refused — the id is signed", async () => {
    const h = await harness();
    const blobId = await upload(h, "shared bytes");
    const a = await mintShare(h, blobId, "a.txt");
    const b = await mintShare(h, blobId, "b.txt");
    await h.call("POST", `/api/shares/${ACCOUNT}/${a.shareId}/revoke`);

    // Holder of the revoked link swaps in the un-revoked link's id.
    const swapped = await h.open(a.url.replace(a.shareId, b.shareId));
    expect(swapped.status).toBe(403);
  });

  it("a link whose record is gone is refused — deny by default", async () => {
    // KV loss, or a record reaped early, must fail CLOSED. Serving a link the
    // system can no longer account for is the exact state this unit ends.
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));
    expect((await h.open(share.url)).status).toBe(200);

    h.w.kv.store.delete(shareKey(ACCOUNT, share.shareId));
    expect((await h.open(share.url)).status).toBe(403);
  });

  it("an expired link's record disappears on its own — no sweeper", async () => {
    // Done-when #6. The KV fake evaluates expiry at READ time against
    // Date.now(), so this is the real TTL semantics, not a simulated one.
    vi.useFakeTimers();
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"), "report.txt", { ttlSeconds: 60 });
    expect(await listShareRecords(h.env.ROUTES, ACCOUNT)).toHaveLength(1);

    vi.setSystemTime(Date.now() + 61_000);

    expect(await listShareRecords(h.env.ROUTES, ACCOUNT)).toHaveLength(0);
    expect((await h.open(share.url)).status).toBe(410); // expiry beats the record
  });

  it("mints are unrevocable-by-accident: no record means the mint failed", async () => {
    // The record is written BEFORE the URL is returned, so a caller never
    // holds a link the system has not recorded.
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));
    expect(h.w.kv.store.has(shareKey(ACCOUNT, share.shareId))).toBe(true);
  });
});

describe("share enumeration", () => {
  it("lists every live link for the account, including its expiry", async () => {
    const h = await harness();
    const blobId = await upload(h, "x");
    const a = await mintShare(h, blobId, "a.txt");
    const b = await mintShare(h, blobId, "b.txt");

    const res = await h.call("GET", `/api/shares/${ACCOUNT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shares: Array<{ shareId: string; name: string; live: boolean; expiresAt: string }>;
    };
    expect(body.shares.map((s) => s.shareId).sort()).toEqual([a.shareId, b.shareId].sort());
    expect(body.shares.every((s) => s.live)).toBe(true);
    expect(body.shares.map((s) => s.expiresAt)).toContain(a.expiresAt);
  });

  it("shows a revoked link as not live rather than hiding it", async () => {
    const h = await harness();
    const share = await mintShare(h, await upload(h, "x"));
    await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);

    const body = (await (await h.call("GET", `/api/shares/${ACCOUNT}`)).json()) as {
      shares: Array<{ shareId: string; live: boolean; revokedAt?: string }>;
    };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0]!.live).toBe(false);
    expect(body.shares[0]!.revokedAt).toBeTruthy();
  });

  it("enumerates links minted by `send`, not only ones minted deliberately", async () => {
    // Done-when #2. `packages/cli/src/main.ts` mints a link for any asset over
    // --link-max during a normal markdown send, via this same route — so if
    // the route records, the send path is covered for free. That is the only
    // reason enumeration is worth anything: the unknown links are the sent ones.
    const h = await harness();
    const sent = await mintShare(h, await upload(h, "big.pdf bytes"), "big.pdf", {
      type: "application/pdf",
      ttlSeconds: 30 * 24 * 3600,
    });
    const body = (await (await h.call("GET", `/api/shares/${ACCOUNT}`)).json()) as {
      shares: Array<{ shareId: string; name: string; type?: string }>;
    };
    expect(body.shares).toEqual([
      expect.objectContaining({ shareId: sent.shareId, name: "big.pdf", type: "application/pdf" }),
    ]);
  });

  it("returns 404 for an account the principal cannot reach", async () => {
    // Assert the BODY, not just the status: the worker's catch-all is also a
    // 404, so a status-only assertion passes just as well when the route does
    // not exist at all. That is the fake-catch-all failure mode `fakeD1`'s
    // header warns about, in HTTP form.
    const h = await harness();
    const list = await h.call("GET", `/api/shares/${OTHER}`);
    expect(list.status).toBe(404);
    expect(await list.json()).toEqual({ error: "unknown account" });

    const revoke = await h.call("POST", `/api/shares/${OTHER}/sh_x/revoke`);
    expect(revoke.status).toBe(404);
    expect(await revoke.json()).toEqual({ error: "unknown account" });
  });

  it("404s an unknown share id rather than reporting a successful revoke", async () => {
    const h = await harness();
    const res = await h.call("POST", `/api/shares/${ACCOUNT}/sh_nope/revoke`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown share" });
  });
});

describe("share enumeration paginates", () => {
  it("follows the cursor — a truncated listing would hide the leaked link", () => {
    // `@bullmoose/test-fakes`' KV answers every `list` in one page, so the
    // cursor branch is unreachable through it. Rather than hand-roll a second
    // KV — the thing sVOL 002 exists to stop — this WRAPS the shared fake and
    // overrides only `list`, chunking it two keys at a time. Every other
    // semantic (expiry, get, put) stays the real one.
    const inner = fakeKV();
    const paged = {
      ...inner.ns,
      get: (key: string) => inner.ns.get(key),
      list: async (opts?: { prefix?: string; cursor?: string }) => {
        const all = [...inner.store.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).sort();
        const start = opts?.cursor ? Number(opts.cursor) : 0;
        const slice = all.slice(start, start + 2);
        const next = start + 2;
        return next >= all.length
          ? { keys: slice.map((name) => ({ name })), list_complete: true as const }
          : { keys: slice.map((name) => ({ name })), list_complete: false as const, cursor: String(next) };
      },
    } as unknown as KVNamespace;

    const five = Array.from({ length: 5 }, (_, i) => ({
      shareId: `sh_${i}`,
      tenantId: TENANT,
      accountId: ACCOUNT,
      blobId: "b_1",
      name: `f${i}.txt`,
      exp: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Date.now() + i,
    }));

    return (async () => {
      for (const rec of five) await putShareRecord(paged, rec);
      const listed = await listShareRecords(paged, ACCOUNT);
      expect(listed.map((r) => r.shareId).sort()).toEqual(five.map((r) => r.shareId).sort());
    })();
  });
});

describe("blob enumeration", () => {
  it("reports objects and sizes for the account", async () => {
    const h = await harness();
    await upload(h, "one");
    await upload(h, "two two");

    const res = await h.call("GET", `/api/blobs/${ACCOUNT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      blobs: Array<{ blobId: string; size: number; uploaded: string }>;
      totalSize: number;
    };
    expect(body.blobs).toHaveLength(2);
    expect(body.blobs.map((b) => b.size).sort((x, y) => x - y)).toEqual([3, 7]);
    expect(body.totalSize).toBe(10);
    expect(body.blobs.every((b) => b.blobId.startsWith("b_"))).toBe(true);
    expect(body.blobs.every((b) => !b.blobId.includes("/"))).toBe(true);
  });

  it("does not leak another account's objects through the prefix", async () => {
    const h = await harness();
    await upload(h, "mine");
    h.w.blobs.put(`mail/${TENANT}/${OTHER}/blobs/b_theirs`, "not mine");

    const body = (await (await h.call("GET", `/api/blobs/${ACCOUNT}`)).json()) as {
      blobs: Array<{ blobId: string }>;
    };
    expect(body.blobs.map((b) => b.blobId)).not.toContain("b_theirs");
    expect(body.blobs).toHaveLength(1);
  });

  it("honours ?limit", async () => {
    const h = await harness();
    await upload(h, "one");
    await upload(h, "two");
    const body = (await (await h.call("GET", `/api/blobs/${ACCOUNT}?limit=1`)).json()) as {
      blobs: unknown[];
    };
    expect(body.blobs).toHaveLength(1);
  });

  it("returns 404 for an account the principal cannot reach", async () => {
    const h = await harness();
    const res = await h.call("GET", `/api/blobs/${OTHER}`);
    expect(res.status).toBe(404);
    // …and specifically "unknown account", not the worker's catch-all 404.
    expect(await res.json()).toEqual({ error: "unknown account" });
  });
});

describe("blob delete", () => {
  it("deletes an unreferenced blob", async () => {
    const h = await harness();
    const blobId = await upload(h, "orphan");

    const res = await h.call("DELETE", `/api/blobs/${ACCOUNT}/${blobId}`);
    expect(res.status).toBe(200);
    expect(h.w.blobs.objects.size).toBe(0);
    expect((await h.call("GET", `/api/download/${ACCOUNT}/${blobId}`)).status).toBe(404);
  });

  it("REFUSES a blob that still backs a message, and the message still downloads", async () => {
    // Done-when #5, and the assertion that catches a missing refcount. A
    // delete that "worked" proves nothing; this proves the guard exists.
    const h = await harness();
    const blobId = await upload(h, "raw rfc5322 bytes");
    seedEmail(h, { id: "em_1", rawBlobId: blobId });

    const res = await h.call("DELETE", `/api/blobs/${ACCOUNT}/${blobId}`);
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "blob in use",
      referencedBy: ["em_1"],
    });

    const still = await h.call("GET", `/api/download/${ACCOUNT}/${blobId}`);
    expect(still.status).toBe(200);
    expect(await still.text()).toBe("raw rfc5322 bytes");
  });

  it("REFUSES a blob referenced only as an attachment of another message", async () => {
    // Content addressing means two identical attachments in two messages are
    // ONE object — the case where a naive delete is a correctness bug, not a
    // policy choice. The reference lives in attachments_json, not blob_id.
    const h = await harness();
    const attachment = await upload(h, "invoice.pdf bytes");
    seedEmail(h, {
      id: "em_1",
      rawBlobId: "b_some_other_raw",
      attachments: [{ blobId: attachment }],
    });

    const res = await h.call("DELETE", `/api/blobs/${ACCOUNT}/${attachment}`);
    expect(res.status).toBe(409);
    expect((await res.json()) as { referencedBy: string[] }).toMatchObject({
      referencedBy: ["em_1"],
    });
    expect(h.w.blobs.objects.size).toBe(1);
  });

  it("is not fooled by a blob id that only appears in another account's mail", async () => {
    const h = await harness();
    const blobId = await upload(h, "mine");
    h.w.db.seedAccount({ accountId: OTHER, tenantId: TENANT, principalId: "p_other" });
    h.w.db.seed("emails", [
      {
        id: "em_other",
        account_id: OTHER,
        blob_id: blobId,
        thread_id: "th_o",
        size: 1,
        received_at: 1,
      },
    ]);

    expect((await h.call("DELETE", `/api/blobs/${ACCOUNT}/${blobId}`)).status).toBe(200);
  });

  it("REFUSES a blob with a live share link, and accepts it once revoked", async () => {
    // Silently deleting would turn the link into a 410 with no explanation.
    // Refusing names the share the operator has to kill first.
    const h = await harness();
    const blobId = await upload(h, "shared bytes");
    const share = await mintShare(h, blobId);

    const refused = await h.call("DELETE", `/api/blobs/${ACCOUNT}/${blobId}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()) as Record<string, unknown>).toMatchObject({
      error: "blob shared",
      shareIds: [share.shareId],
    });

    await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`);
    expect((await h.call("DELETE", `/api/blobs/${ACCOUNT}/${blobId}`)).status).toBe(200);
    expect(h.w.blobs.objects.size).toBe(0);
  });

  it("404s a blob that is not there", async () => {
    const h = await harness();
    const res = await h.call("DELETE", `/api/blobs/${ACCOUNT}/b_nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "blob not found" });
  });
});

describe("scope gates — no new endpoint is ungated", () => {
  it("a read-scoped token may enumerate but may not delete or revoke", async () => {
    const h = await harness(["read"]);
    // Uploading needs `draft`, so seed R2 under the account prefix directly.
    h.w.blobs.put(`mail/${TENANT}/${ACCOUNT}/blobs/b_seed`, "bytes");

    expect((await h.call("GET", `/api/blobs/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("GET", `/api/shares/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("DELETE", `/api/blobs/${ACCOUNT}/b_seed`)).status).toBe(403);
    expect((await h.call("POST", `/api/shares/${ACCOUNT}/sh_x/revoke`)).status).toBe(403);
    // Refused by the gate, not by the store: nothing was removed.
    expect(h.w.blobs.objects.size).toBe(1);
  });

  it("a delete-scoped token may delete, revoke AND enumerate — delete implies read", async () => {
    // common/027: any write capability implies `read`, and `delete` is a write,
    // so a delete-scoped token satisfies the read-gated enumeration endpoints
    // too. It still cannot MINT a link — that gates on `draft`, which `delete`
    // does not confer (delete is not an order over the other verbs).
    const h = await harness(["delete"]);
    expect((await h.call("GET", `/api/blobs/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("GET", `/api/shares/${ACCOUNT}`)).status).toBe(200);
    // Reaches the handler (404 = "no such share"), i.e. the delete gate let it past.
    expect((await h.call("POST", `/api/shares/${ACCOUNT}/sh_x/revoke`)).status).toBe(404);
    // But delete does NOT imply draft: minting a link is still refused.
    expect((await h.call("POST", `/api/share/${ACCOUNT}/b_x`, { body: "{}" })).status).toBe(403);
  });

  it("a realm-scoped token reads but cannot delete — the read edge, not the wildcard", async () => {
    // The update to common/001. `hasScope` no longer returns true for every
    // non-"admin" scope, but common/027 opened ONE edge: any write/realm
    // capability implies `read`. So a `contacts` token now CAN enumerate — yet
    // it still cannot DELETE or revoke (those gate on `delete`, which no realm
    // scope confers). The wildcard stays closed; only the read edge opened.
    const h = await harness(["contacts"]);
    expect((await h.call("GET", `/api/blobs/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("GET", `/api/shares/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("DELETE", `/api/blobs/${ACCOUNT}/b_x`)).status).toBe(403);
    expect((await h.call("POST", `/api/shares/${ACCOUNT}/sh_x/revoke`)).status).toBe(403);
  });

  it("the `mail` bundle covers all four, so revoke is never harder than mint", async () => {
    const h = await harness(["mail"]);
    const share = await mintShare(h, await upload(h, "x"));
    expect((await h.call("POST", `/api/shares/${ACCOUNT}/${share.shareId}/revoke`)).status).toBe(200);
  });

  it("an unauthenticated caller gets 401, not a listing", async () => {
    const h = await harness();
    await mintShare(h, await upload(h, "x")); // there IS something to leak
    const res = await worker.fetch(
      new Request(`https://jmap.bullmoose.cc/api/shares/${ACCOUNT}`),
      h.env,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("shareId");
    // Paired with the authenticated call so the 401 means "auth runs before
    // routing" rather than "this path does not exist".
    expect((await h.call("GET", `/api/shares/${ACCOUNT}`)).status).toBe(200);
  });

  it("refuses an unsupported method on the new paths", async () => {
    const h = await harness();
    expect((await h.call("PUT", `/api/blobs/${ACCOUNT}`)).status).toBe(405);
    expect((await h.call("DELETE", `/api/shares/${ACCOUNT}`)).status).toBe(405);
  });
});

describe("sharing not configured", () => {
  it("share list and revoke answer 501, matching mint and download", async () => {
    const h = await harness(["mail"], false);
    expect((await h.call("GET", `/api/shares/${ACCOUNT}`)).status).toBe(501);
    expect((await h.call("POST", `/api/shares/${ACCOUNT}/sh_x/revoke`)).status).toBe(501);
    expect((await h.call("POST", `/api/share/${ACCOUNT}/b_x`, { body: "{}" })).status).toBe(501);
  });

  it("blob enumeration and delete still work — they need no signing key", async () => {
    const h = await harness(["mail"], false);
    h.w.blobs.put(`mail/${TENANT}/${ACCOUNT}/blobs/b_seed`, "bytes");
    expect((await h.call("GET", `/api/blobs/${ACCOUNT}`)).status).toBe(200);
    expect((await h.call("DELETE", `/api/blobs/${ACCOUNT}/b_seed`)).status).toBe(200);
  });
});
