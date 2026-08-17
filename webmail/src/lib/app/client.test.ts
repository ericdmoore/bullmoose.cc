import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBase, homeTarget, readApiBase, resolveClient, signOut, storeSession, urlWithoutToken } from "./client";

// The resolver reads three browser globals and Node has none of them, so each
// test builds the browser it wants. `location` is a plain object rather than a
// URL because the code only ever reads `search`, `origin` and `href` — and the
// fake `history` writes `href` back, which is exactly what a real
// `replaceState` does and the only way to observe the strip.

const TOKEN = "bm_0123456789ab_" + "f".repeat(48);
const OTHER = "bm_ba9876543210_" + "e".repeat(48);
const ORIGIN = "https://app.bullmoose.cc";

interface FakeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  map: Map<string, string>;
}

function fakeStorage(seed: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

let store: FakeStorage;
let loc: { search: string; origin: string; href: string };
let replaceState: ReturnType<typeof vi.fn>;
let pushState: ReturnType<typeof vi.fn>;

function browser(search: string, seed: Record<string, string> = {}) {
  store = fakeStorage(seed);
  loc = { search, origin: ORIGIN, href: `${ORIGIN}/mail${search}` };
  replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    loc.href = url;
    loc.search = new URL(url).search;
  });
  pushState = vi.fn();
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", { state: null, replaceState, pushState });
}

beforeEach(() => browser(""));
afterEach(() => vi.unstubAllGlobals());

describe("resolveClient — what a stranger sees", () => {
  it("resolves LIVE from a stored token", () => {
    browser("", { "bullmoose.token": TOKEN });
    const resolved = resolveClient();
    expect(resolved.mode).toBe("live");
    expect(resolved.mode === "live" && resolved.client).toBeTruthy();
  });

  it("resolves UNAUTHENTICATED with no token — not demo data", () => {
    // The s07 T1 regression this file exists for. The old behaviour returned a
    // demo backend here, so a first-time visitor to a public origin saw a
    // convincing mailbox of fake mail with nothing telling them to sign in.
    const resolved = resolveClient();
    expect(resolved.mode).toBe("unauthenticated");
    expect(resolved).not.toHaveProperty("client");
    expect(resolved).not.toHaveProperty("demo");
  });

  it("gives demo data ONLY when it is asked for", () => {
    const resolved = resolveClient("?demo=1");
    expect(resolved.mode).toBe("demo");
    expect(resolved.mode === "demo" && resolved.demo).toBeTruthy();
    expect(resolved.reason).toBe("?demo=1");
  });

  it("honours ?demo=1 over a stored token, so the demo is always reachable", () => {
    browser("?demo=1", { "bullmoose.token": TOKEN });
    expect(resolveClient("?demo=1").mode).toBe("demo");
  });

  it("sends a malformed stored token to the door, not into a 401", () => {
    browser("", { "bullmoose.token": "tk_0123456789ab" });
    const resolved = resolveClient();
    expect(resolved.mode).toBe("unauthenticated");
    expect(resolved.reason).toMatch(/bm_/);
  });

  it("treats storage that throws as no session, and does not crash", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    });
    expect(resolveClient().mode).toBe("unauthenticated");
  });
});

describe("resolveClient — the ?token= dev affordance", () => {
  it("accepts a token from the query string and persists it", () => {
    browser(`?token=${TOKEN}`);
    expect(resolveClient(`?token=${TOKEN}`).mode).toBe("live");
    expect(store.map.get("bullmoose.token")).toBe(TOKEN);
  });

  it("STRIPS it from the address bar on read", () => {
    browser(`?token=${TOKEN}`);
    resolveClient(`?token=${TOKEN}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(loc.href).toBe(`${ORIGIN}/mail`);
    expect(loc.href).not.toContain("bm_");
  });

  it("keeps the other params while dropping the token", () => {
    browser(`?demo=0&token=${TOKEN}&api=https%3A%2F%2Fjmap.test`);
    resolveClient(`?demo=0&token=${TOKEN}&api=https%3A%2F%2Fjmap.test`);
    const after = new URL(loc.href);
    expect(after.searchParams.get("token")).toBeNull();
    expect(after.searchParams.get("demo")).toBe("0");
    expect(after.searchParams.get("api")).toBe("https://jmap.test");
  });

  it("replaces rather than pushes — the strip must not create the entry it removes", () => {
    browser(`?token=${TOKEN}`);
    resolveClient(`?token=${TOKEN}`);
    expect(pushState).not.toHaveBeenCalled();
  });

  it("strips a MALFORMED ?token= too — a bad credential is still a credential", () => {
    browser("?token=bm_nope");
    expect(resolveClient("?token=bm_nope").mode).toBe("unauthenticated");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(loc.href).not.toContain("bm_nope");
  });

  it("does not touch the URL when there is no token in it", () => {
    browser("", { "bullmoose.token": TOKEN });
    resolveClient();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("prefers the URL token over the stored one, and overwrites storage", () => {
    browser(`?token=${OTHER}`, { "bullmoose.token": TOKEN });
    resolveClient(`?token=${OTHER}`);
    expect(store.map.get("bullmoose.token")).toBe(OTHER);
  });
});

describe("the API base", () => {
  it("defaults to this origin", () => {
    expect(defaultBase()).toBe(ORIGIN);
  });

  it("falls back to the published API when there is no usable origin", () => {
    vi.stubGlobal("location", { search: "", origin: "file://", href: "file:///index.html" });
    expect(defaultBase()).toBe("https://api.bullmoose.cc");
  });

  it("persists ?api= alongside the token", () => {
    browser(`?token=${TOKEN}&api=https://jmap.test`);
    resolveClient(`?token=${TOKEN}&api=https://jmap.test`);
    expect(store.map.get("bullmoose.apiBase")).toBe("https://jmap.test");
    expect(readApiBase()).toBe("https://jmap.test");
  });

  it("storeSession leaves an existing base alone when none is given", () => {
    browser("", { "bullmoose.apiBase": "https://jmap.test" });
    storeSession(TOKEN);
    expect(store.map.get("bullmoose.apiBase")).toBe("https://jmap.test");
    expect(store.map.get("bullmoose.token")).toBe(TOKEN);
  });
});

describe("signOut", () => {
  it("clears the session, and the next resolve shows the door", () => {
    browser("", { "bullmoose.token": TOKEN, "bullmoose.apiBase": "https://jmap.test" });
    expect(resolveClient().mode).toBe("live");
    signOut();
    expect(store.map.has("bullmoose.token")).toBe(false);
    expect(store.map.has("bullmoose.apiBase")).toBe(false);
    expect(resolveClient().mode).toBe("unauthenticated");
  });
});

describe("homeTarget", () => {
  it("routes a session to the mail section", () => {
    browser("", { "bullmoose.token": TOKEN });
    expect(homeTarget(resolveClient())).toBe("/mail");
  });

  it("routes no session to the door", () => {
    expect(homeTarget(resolveClient())).toBe("/login");
  });

  it("carries ?demo=1 across, or the destination would bounce back here", () => {
    expect(homeTarget(resolveClient("?demo=1"))).toBe("/mail?demo=1");
  });
});

describe("urlWithoutToken", () => {
  it("removes only the token", () => {
    expect(urlWithoutToken(`${ORIGIN}/mail?a=1&token=${TOKEN}&b=2`)).toBe(`${ORIGIN}/mail?a=1&b=2`);
  });

  it("returns null when there is nothing to strip, so no history is touched", () => {
    expect(urlWithoutToken(`${ORIGIN}/mail?a=1`)).toBeNull();
    expect(urlWithoutToken("not a url")).toBeNull();
  });
});
