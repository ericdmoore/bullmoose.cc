import { describe, expect, it } from "vitest";
import {
  cacheEpochMatches,
  mergeMutable,
  MUTABLE_PROPERTIES,
  partitionIds,
  planCacheSync,
  type CachedEmail,
} from "./cachePolicy";
import type { Email } from "./types";

const email = (id: string, over: Partial<Email> = {}): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ email: "a@b.c" }],
    to: [],
    subject: "Subject",
    receivedAt: "2026-08-21T00:00:00Z",
    preview: "preview",
    hasAttachment: false,
    size: 10,
    ...over,
  }) as Email;

const cached = (e: Email, epoch = "e1"): CachedEmail => ({ email: e, epoch, cachedAt: 0 });

describe("partitionIds", () => {
  it("1. asks the wire only for what is missing", () => {
    const store = new Map([["a", cached(email("a"))]]);
    const { hits, misses } = partitionIds(["a", "b"], store);
    expect(hits.map((e) => e.id)).toEqual(["a"]);
    expect(misses).toEqual(["b"]);
  });

  it("2. a full hit means no request at all", () => {
    const store = new Map([["a", cached(email("a"))]]);
    expect(partitionIds(["a"], store).misses).toEqual([]);
  });
});

describe("mergeMutable", () => {
  it("10. takes the flags and the mailboxes", () => {
    const merged = mergeMutable(email("a"), { keywords: { $seen: true }, mailboxIds: { archive: true } });
    expect(merged.keywords).toEqual({ $seen: true });
    expect(merged.mailboxIds).toEqual({ archive: true });
  });

  it("11. a TRUNCATED body can never overwrite a full one", () => {
    // The prefetch path fetches with a small maxBodyValueBytes. A wider merge
    // would let those 4KB replace a complete body already in hand, so the
    // cache would get quietly worse the more it was used — a bug that shows up
    // as messages mysteriously cut short, long after the code that caused it.
    const full = email("a", { subject: "The real subject" }) as Email & { bodyValues: unknown };
    full.bodyValues = { 1: { value: "the whole message", isTruncated: false } };
    const merged = mergeMutable(full, {
      keywords: { $seen: true },
      subject: "truncated",
      bodyValues: { 1: { value: "the who…", isTruncated: true } },
    } as Partial<Email>);
    expect((merged as typeof full).bodyValues).toEqual({ 1: { value: "the whole message", isTruncated: false } });
    expect(merged.subject).toBe("The real subject");
  });

  it("12. absent flags leave what is cached alone", () => {
    const merged = mergeMutable(email("a", { keywords: { $flagged: true } }), {});
    expect(merged.keywords).toEqual({ $flagged: true });
  });

  it("13. only id, keywords and mailboxIds are ever declared mutable", () => {
    // RFC 8621 §4.1. If this list ever grows, the cache stops being correct
    // by construction and every "never revalidate" claim here needs revisiting.
    expect([...MUTABLE_PROPERTIES]).toEqual(["id", "keywords", "mailboxIds"]);
  });
});

describe("planCacheSync", () => {
  const changes = { created: ["new"], updated: ["a", "gone"], destroyed: ["d", "unknown"], newState: "s2" };

  it("20. refreshes flags only for messages we actually hold", () => {
    const plan = planCacheSync(changes, new Set(["a", "d"]));
    expect(plan.refreshFlags).toEqual(["a"]);
  });

  it("21. drops only what we hold", () => {
    expect(planCacheSync(changes, new Set(["a", "d"])).drop).toEqual(["d"]);
  });

  it("22. never speculatively downloads new arrivals", () => {
    // `created` is deliberately unused: pulling every new message in the
    // background is a download nobody asked for, on a connection we may not
    // own. The list query fetches it when it is actually wanted.
    const plan = planCacheSync(changes, new Set());
    expect(plan.refreshFlags).toEqual([]);
    expect(plan.drop).toEqual([]);
  });
});

describe("cacheEpochMatches — the security gate", () => {
  it("30. reads only a cache written by this sign-in", () => {
    expect(cacheEpochMatches("e1", "e1")).toBe(true);
    expect(cacheEpochMatches("e1", "e2")).toBe(false);
  });

  it("31. NO session means nothing may be read, whatever is on disk", () => {
    // The case that matters. signOut() clears the epoch first, so even if the
    // wipe fails or is still in flight, the mail left behind is unreadable.
    // Twelve islands bounce to /login on a revoked token without calling
    // signOut at all; this is what covers them.
    expect(cacheEpochMatches("e1", null)).toBe(false);
    expect(cacheEpochMatches(null, null)).toBe(false);
  });
});
