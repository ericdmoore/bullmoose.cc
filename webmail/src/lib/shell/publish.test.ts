import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLECTIONS_EVENT,
  STALE_AFTER_MS,
  hrefWithParam,
  isStale,
  publishCollections,
  publishedAtLabel,
  publishedHref,
  readPublished,
  urlParam,
  type PublishedItem,
} from "./publish";

// s25 T4 — the publish contract, driven with the same stubs
// tokenInUrl.test.ts uses: a Map-backed localStorage and a recorded event
// sink. The tray renders exactly what `readPublished` returns, so what these
// tests hold is the tray's whole data diet.

let store: Map<string, string>;
let events: CustomEvent[];

beforeEach(() => {
  store = new Map();
  events = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("dispatchEvent", (ev: Event) => {
    events.push(ev as CustomEvent);
    return true;
  });
});
afterEach(() => vi.unstubAllGlobals());

const ITEMS: PublishedItem[] = [
  { id: "inbox", label: "Inbox", count: 12, href: "/mail?c=inbox" },
  { id: "sent", label: "Sent", href: "/mail?c=sent" },
];

describe("publishCollections / readPublished", () => {
  it("round-trips items and the publish instant through bm.collections.<realm>", () => {
    publishCollections("mail", ITEMS, 1_000_000);
    expect(store.has("bm.collections.mail")).toBe(true);
    expect(readPublished("mail")).toEqual({ realm: "mail", items: ITEMS, at: 1_000_000 });
  });

  it("dispatches bm:collections naming the realm, so a mounted tray repaints", () => {
    publishCollections("approvals", ITEMS);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(COLLECTIONS_EVENT);
    expect(events[0]!.detail).toEqual({ realm: "approvals" });
  });

  it("a realm that never published reads as undefined — absence, not an error", () => {
    expect(readPublished("contacts")).toBeUndefined();
  });

  it("keeps realms apart: mail's publish is invisible to contacts", () => {
    publishCollections("mail", ITEMS);
    expect(readPublished("contacts")).toBeUndefined();
  });

  it("survives garbage in storage: bad JSON and mis-shaped records read as absent", () => {
    store.set("bm.collections.mail", "{not json");
    expect(readPublished("mail")).toBeUndefined();
    store.set("bm.collections.mail", JSON.stringify({ realm: "mail", items: "nope", at: 5 }));
    expect(readPublished("mail")).toBeUndefined();
    store.set("bm.collections.mail", JSON.stringify({ realm: "mail", items: [], at: "yesterday" }));
    expect(readPublished("mail")).toBeUndefined();
    // A record published under a different realm name never leaks across.
    store.set("bm.collections.mail", JSON.stringify({ realm: "contacts", items: [], at: 5 }));
    expect(readPublished("mail")).toBeUndefined();
  });

  it("drops unsafe items without failing the record — the tray never links off-path", () => {
    store.set(
      "bm.collections.mail",
      JSON.stringify({
        realm: "mail",
        at: 7,
        items: [
          ITEMS[0],
          { id: "evil1", label: "x", href: "javascript:alert(1)" },
          { id: "evil2", label: "x", href: "https://evil.example/" },
          { id: "evil3", label: "x", href: "//evil.example/" },
          { id: "", label: "x", href: "/mail" },
          { id: "shapeless", href: "/mail" },
        ],
      }),
    );
    expect(readPublished("mail")).toEqual({ realm: "mail", items: [ITEMS[0]], at: 7 });
  });

  it("fails soft when storage throws (private mode): publish is a no-op, read is absent", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => publishCollections("mail", ITEMS)).not.toThrow();
    expect(readPublished("mail")).toBeUndefined();
  });
});

describe("staleness", () => {
  it("draws the line at ten minutes", () => {
    expect(STALE_AFTER_MS).toBe(10 * 60 * 1000);
    expect(isStale({ at: 1000 }, 1000 + STALE_AFTER_MS)).toBe(false);
    expect(isStale({ at: 1000 }, 1000 + STALE_AFTER_MS + 1)).toBe(true);
  });

  it("stamps a wall-clock label a human can check against their own clock", () => {
    const label = publishedAtLabel(Date.UTC(2026, 7, 18, 9, 12));
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/\d/);
    expect(publishedAtLabel(Number.NaN)).toBe("");
  });
});

describe("hrefWithParam — the T3 detail links", () => {
  it("carries the existing ?q=/?demo= along with the new param", () => {
    expect(hrefWithParam("/mail", "thread", "T1", "?q=hello&demo=1")).toBe("/mail?q=hello&demo=1&thread=T1");
  });

  it("overrides a previous value of the same param instead of doubling it", () => {
    expect(hrefWithParam("/approvals", "p", "b", "?p=a")).toBe("/approvals?p=b");
  });

  it("encodes the id — URLSearchParams, never string concat", () => {
    expect(hrefWithParam("/contacts", "card", "a&b=c", "")).toBe("/contacts?card=a%26b%3Dc");
  });
});

describe("publishedHref — the tray's collection links", () => {
  it("is /path?c=<id>, freshly built: transient ?q=/?thread= must NOT outlive the page", () => {
    expect(publishedHref("/mail", "inbox", "?q=hello&thread=T1")).toBe("/mail?c=inbox");
  });

  it("carries ?demo= so a demo session's tray stays in the demo", () => {
    expect(publishedHref("/approvals", "pending", "?demo=1&q=x")).toBe("/approvals?demo=1&c=pending");
  });

  it("encodes the collection id", () => {
    expect(publishedHref("/mail", "a b", "")).toBe("/mail?c=a+b");
  });
});

describe("urlParam — the mount-time read", () => {
  it("reads a param, and absence is undefined", () => {
    expect(urlParam("thread", "?thread=T1&q=x")).toBe("T1");
    expect(urlParam("thread", "?q=x")).toBeUndefined();
    expect(urlParam("thread", "")).toBeUndefined();
  });
});
