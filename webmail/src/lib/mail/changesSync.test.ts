import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_KEY, syncCachedFlags, type SyncPorts } from "./changesSync";
import type { Email } from "./types";

const email = (id: string, keywords: Record<string, boolean> = {}): Email =>
  ({
    id,
    threadId: "t",
    mailboxIds: { inbox: true },
    keywords,
    subject: "s",
    receivedAt: "2026-08-21T00:00:00Z",
  }) as Email;

function ports(seed: Email[]): SyncPorts & { store: Map<string, { email: Email }>; dropped: string[] } {
  const store = new Map(seed.map((e) => [e.id, { email: e }]));
  const dropped: string[] = [];
  return {
    store,
    dropped,
    cachedIds: async () => new Set(store.keys()),
    readEmails: async (ids) => new Map([...store].filter(([id]) => ids.includes(id))),
    writeEmails: async (emails) => {
      for (const e of emails) store.set(e.id, { email: e });
    },
    dropEmails: async (ids) => {
      for (const id of ids) {
        dropped.push(id);
        store.delete(id);
      }
    },
  };
}

const fakeStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), map };
};

describe("syncCachedFlags", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("1. refreshes ONLY the flags — never re-downloads a body", () => {
    const store = fakeStorage();
    store.map.set(STATE_KEY, "s1");
    vi.stubGlobal("localStorage", store);
    const p = ports([email("a"), email("b")]);
    const sent: string[] = [];
    const client = {
      request: async (calls: Array<[string, Record<string, unknown>, string]>) => {
        sent.push(calls[0]![0]);
        if (calls[0]![0] === "Email/changes") {
          return [["Email/changes", { created: [], updated: ["a"], destroyed: [], newState: "s2" }, "c"]];
        }
        // The properties asked for are the assertion that matters.
        expect(calls[0]![1].properties).toEqual(["id", "keywords", "mailboxIds"]);
        return [["Email/get", { list: [{ id: "a", keywords: { $seen: true } }] }, "g"]];
      },
    };
    return syncCachedFlags(client as never, "acc", p).then((r) => {
      expect(r.refreshed).toBe(1);
      expect(p.store.get("a")!.email.keywords).toEqual({ $seen: true });
      expect(sent).toEqual(["Email/changes", "Email/get"]);
      expect(store.map.get(STATE_KEY)).toBe("s2");
    });
  });

  it("2. drops what the server destroyed", async () => {
    const store = fakeStorage();
    store.map.set(STATE_KEY, "s1");
    vi.stubGlobal("localStorage", store);
    const p = ports([email("a"), email("gone")]);
    const client = {
      request: async () => [["Email/changes", { created: [], updated: [], destroyed: ["gone"], newState: "s2" }, "c"]],
    };
    const r = await syncCachedFlags(client as never, "acc", p);
    expect(r.dropped).toBe(1);
    expect(p.store.has("gone")).toBe(false);
  });

  it("3. cannotCalculateChanges drops the whole cache rather than trusting it", async () => {
    // RFC 8620 §5.2's own instruction. Serving messages whose flags we can no
    // longer reconcile is worse than re-fetching them: the reader would see
    // read/unread and mailbox state that quietly stopped being true.
    const store = fakeStorage();
    store.map.set(STATE_KEY, "s1");
    vi.stubGlobal("localStorage", store);
    const p = ports([email("a"), email("b")]);
    const client = { request: async () => [["error", { type: "cannotCalculateChanges" }, "c"]] };
    const r = await syncCachedFlags(client as never, "acc", p);
    expect(r.reset).toBe(true);
    expect(p.store.size).toBe(0);
  });

  it("4. a failed request leaves the cache alone — stale flags beat an empty mailbox", async () => {
    const store = fakeStorage();
    store.map.set(STATE_KEY, "s1");
    vi.stubGlobal("localStorage", store);
    const p = ports([email("a")]);
    const client = {
      request: async () => {
        throw new Error("offline");
      },
    };
    const r = await syncCachedFlags(client as never, "acc", p);
    expect(r).toEqual({ refreshed: 0, dropped: 0, reset: false });
    expect(p.store.size).toBe(1);
  });

  it("5. an empty cache just records where the server is", async () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    const client = { request: async () => [["Email/get", { state: "s9", list: [] }, "s"]] };
    const r = await syncCachedFlags(client as never, "acc", ports([]));
    expect(r.refreshed).toBe(0);
    expect(store.map.get(STATE_KEY)).toBe("s9");
  });
});
