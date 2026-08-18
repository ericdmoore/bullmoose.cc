import { describe, expect, it } from "vitest";
import { newSession, type FinderSession } from "./session";
import {
  SESSION_CAP,
  SESSIONS_KEY,
  SAVED_KEY,
  loadSaved,
  loadSessions,
  persistSaved,
  persistSessions,
  recordRun,
  removeSaved,
  upsertSaved,
  upsertSession,
  type KV,
  type SavedQuery,
} from "./store";

// The Finder's localStorage stores (s20 T5), tested in plain Node through the
// injected KV seam — no jsdom, no global stubbing. The parsing tests treat
// stored JSON as what it is: untrusted input that must never take the page
// down or let one corrupt row discard its neighbours.

const kv = (initial: Record<string, string> = {}): KV & { raw: Map<string, string> } => {
  const raw = new Map(Object.entries(initial));
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => void raw.set(k, v),
  };
};

const NOW = () => Date.parse("2026-08-15T12:00:00Z");

const savedEntry = (partial: Partial<SavedQuery> = {}): SavedQuery => ({
  id: "q-1",
  name: "invoices",
  query: "invoice",
  refinements: [],
  savedAt: "2026-08-01T00:00:00.000Z",
  ...partial,
});

describe("upsertSession — the recency shelf", () => {
  it("prepends, dedupes by id, and caps at twenty", () => {
    let list: FinderSession[] = [];
    for (let i = 0; i < SESSION_CAP + 5; i++) list = upsertSession(list, newSession(`q${i}`, NOW));
    expect(list).toHaveLength(SESSION_CAP);
    expect(list[0]?.query).toBe(`q${SESSION_CAP + 4}`);

    // Re-running a session MOVES it to the top rather than duplicating it.
    const again = list[3]!;
    const next = upsertSession(list, again);
    expect(next[0]?.id).toBe(again.id);
    expect(next.filter((s) => s.id === again.id)).toHaveLength(1);
  });
});

describe("saved queries", () => {
  it("upserts newest-first without a cap, and removes by id", () => {
    const a = savedEntry({ id: "q-a", name: "a" });
    const b = savedEntry({ id: "q-b", name: "b" });
    const list = upsertSaved(upsertSaved([], a), b);
    expect(list.map((s) => s.id)).toEqual(["q-b", "q-a"]);
    expect(removeSaved(list, "q-a").map((s) => s.id)).toEqual(["q-b"]);
  });

  it("recordRun stamps count AND time together — the pair is what makes the badge honest", () => {
    const list = [savedEntry({ id: "q-a" }), savedEntry({ id: "q-b" })];
    const next = recordRun(list, "q-a", 12, "2026-08-15T12:00:00.000Z");
    expect(next[0]).toMatchObject({ id: "q-a", lastCount: 12, lastRunAt: "2026-08-15T12:00:00.000Z" });
    // A run is not a re-save: order and the other entry are untouched.
    expect(next.map((s) => s.id)).toEqual(["q-a", "q-b"]);
    expect(next[1]?.lastCount).toBeUndefined();
  });
});

describe("persistence round-trip", () => {
  it("stores under bm.finder.* and loads back what it stored", () => {
    const store = kv();
    const session = newSession("elk", NOW);
    persistSessions([session], store);
    persistSaved([savedEntry()], store);
    expect(store.raw.has(SESSIONS_KEY)).toBe(true);
    expect(store.raw.has(SAVED_KEY)).toBe(true);
    expect(loadSessions(store)).toEqual([session]);
    expect(loadSaved(store)).toEqual([savedEntry()]);
  });

  it("survives with no storage at all (SSR, privacy mode)", () => {
    expect(loadSessions(undefined)).toEqual([]);
    expect(loadSaved(undefined)).toEqual([]);
    expect(() => persistSessions([newSession("x", NOW)], undefined)).not.toThrow();
  });
});

describe("parsing — stored JSON is untrusted input", () => {
  it("returns empty for garbage, non-JSON and non-arrays", () => {
    expect(loadSessions(kv({ [SESSIONS_KEY]: "not json{" }))).toEqual([]);
    expect(loadSessions(kv({ [SESSIONS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadSaved(kv({ [SAVED_KEY]: "42" }))).toEqual([]);
  });

  it("drops malformed rows individually — one corrupt entry keeps its neighbours", () => {
    const good = newSession("elk", NOW);
    const stored = JSON.stringify([good, { id: 7 }, null, { query: "no id" }]);
    expect(loadSessions(kv({ [SESSIONS_KEY]: stored }))).toEqual([good]);
  });

  it("refuses a session whose refinements carry an unknown kind", () => {
    const bad = { ...newSession("elk", NOW), refinements: [{ kind: "regex", value: ".*" }] };
    expect(loadSessions(kv({ [SESSIONS_KEY]: JSON.stringify([bad]) }))).toEqual([]);
  });

  it("caps an over-long stored session list on load", () => {
    const many = Array.from({ length: SESSION_CAP + 10 }, (_, i) => newSession(`q${i}`, NOW));
    expect(loadSessions(kv({ [SESSIONS_KEY]: JSON.stringify(many) }))).toHaveLength(SESSION_CAP);
  });
});
