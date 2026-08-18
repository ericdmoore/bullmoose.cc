import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerNoteMethods } from "./note";
import type { RequestContext } from "./common";

// s18 N1 — the Note substrate. A Note is a document YOU AUTHOR: standalone, no
// anchor, no class, no status. The load-bearing rules these tests hold:
//
//   • it is NOT an Annotation — `anchor`/`class`/`confidence`/`status` are
//     refused BY NAME, with a sentence naming the other entity;
//   • it is OWNED — another account's note is indistinguishable from one that
//     never existed, in every method, wording included;
//   • it carries the federation IDENTITY (stable id, immutable owner,
//     monotonic revision) and federates NOTHING.

const ACCOUNT = "a_eric";
const OTHER = "a_stranger";
const TENANT = "t_bm";

function harness(opts: { scopes?: string[]; agent?: { binding?: string; invocation?: string } } = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  w.db.seedAccount({
    accountId: OTHER,
    tenantId: TENANT,
    principalId: "p_stranger",
    loginEmail: "stranger@example.test",
    displayName: "Stranger",
  });
  const registry = new MethodRegistry<RequestContext>();
  registerNoteMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: opts.scopes ?? ["mail"],
      // Only ACCOUNT is reachable. OTHER exists in the database and is not on
      // the principal — the shape of a real second tenant.
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  return { w, call, ctx, registry };
}

interface SetResult {
  created: Record<string, { id: string; owner: string; revision: number }>;
  notCreated: Record<string, { type: string; description?: string; properties?: string[] }>;
  updated: Record<string, null>;
  notUpdated: Record<string, { type: string; description?: string }>;
  destroyed: string[];
  notDestroyed: Record<string, { type: string; description?: string }>;
}

interface GetResult {
  list: Array<Record<string, unknown>>;
  notFound: string[];
}

const note = (over: Record<string, unknown> = {}) => ({
  title: "Board order",
  body: "Sergio quoted $750 for the boards. Ask about the load calc.",
  ...over,
});

const writeOne = async (h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) =>
  (await h.call<SetResult>("Note/set", { create: { n: note(over) } })).created.n!.id;

describe("Note/set — write a document you own", () => {
  it("creates a note with a stable id, an owner and revision 1", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Note/set", { create: { n: note() } });
    const made = res.created.n!;
    expect(made.id).toMatch(/^nt_/);
    // The federation identity, present from the first write (s18 N3 seam).
    expect(made.owner).toBe("eric@bullmoose.cc");
    expect(made.revision).toBe(1);

    const got = await h.call<GetResult>("Note/get", { ids: null });
    expect(got.list).toHaveLength(1);
    const n = got.list[0]!;
    expect(n.title).toBe("Board order");
    expect(n.body).toMatch(/load calc/);
    expect(n.owner).toBe("eric@bullmoose.cc");
    expect(n.revision).toBe(1);
    // Not an annotation, and the projection has no vocabulary for one.
    expect(n).not.toHaveProperty("anchor");
    expect(n).not.toHaveProperty("class");
    expect(n).not.toHaveProperty("status");
  });

  it("edits bump the revision and the writer, and never re-author the note", async () => {
    const h = harness({ agent: { binding: "emily" } });
    const id = await writeOne(h);
    const res = await h.call<SetResult>("Note/set", { update: { [id]: { body: "…and the hinges." } } });
    expect(res.updated).toHaveProperty(id);

    const n = (await h.call<GetResult>("Note/get", { ids: [id] })).list[0]!;
    expect(n.revision).toBe(2);
    expect(n.body).toBe("…and the hinges.");
    expect(n.title).toBe("Board order"); // an absent field is left alone
    // A binding wrote it, but a note belongs to the PERSON: owner unchanged,
    // the binding recorded beside it.
    expect(n.owner).toBe("eric@bullmoose.cc");
    expect(n.lastWriterBinding).toBe("emily");
  });

  it("destroys a note — a document you own has a delete verb", async () => {
    const h = harness();
    const id = await writeOne(h);
    const res = await h.call<SetResult>("Note/set", { destroy: [id] });
    expect(res.destroyed).toEqual([id]);
    expect(h.w.db.query(`SELECT id FROM notes`)).toEqual([]);

    const again = await h.call<SetResult>("Note/set", { destroy: [id] });
    expect(again.destroyed).toEqual([]);
    expect(again.notDestroyed[id]?.description).toMatch(/no note with that id/);
  });

  it("REFUSES an empty note, an over-long title and an over-long body", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Note/set", {
      create: {
        empty: { title: "", body: "" },
        longTitle: note({ title: "x".repeat(501) }),
        longBody: note({ body: "x".repeat(64_001) }),
      },
    });
    expect(res.notCreated.empty?.description).toMatch(/needs a title or a body/);
    expect(res.notCreated.longTitle?.description).toMatch(/title is longer/);
    expect(res.notCreated.longBody?.type).toBe("tooLarge");
    // "/files is where documents live" — the s18 Decision 4 boundary, said out
    // loud rather than silently truncating.
    expect(res.notCreated.longBody?.description).toMatch(/files/);
  });

  it("REFUSES to let a client set the server's own fields", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Note/set", {
      create: { forged: note({ id: "nt_mine", owner: "someone@else.test", revision: 99 }) },
    });
    expect(res.notCreated.forged?.description).toMatch(/set by the server/);
    expect(Object.keys(res.created)).toEqual([]);
  });

  it("requires a write scope — a read-only token cannot write a note", async () => {
    const h = harness({ scopes: ["read"] });
    await expect(h.call("Note/set", { create: { n: note() } })).rejects.toThrow();
    // …and reads still work on the same token: the gate is per verb, not per
    // realm.
    await expect(h.call("Note/get", { ids: null })).resolves.toBeTruthy();
  });
});

describe("a Note is NOT an Annotation — the refusal that keeps them apart", () => {
  it("refuses an anchored note and names the entity the caller wants", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Note/set", {
      create: { anchored: note({ anchor: { realm: "Email", objectId: "e_1" } }) },
    });
    expect(res.notCreated.anchored?.description).toMatch(/Annotation\/set/);
    expect(res.notCreated.anchored?.properties).toEqual(["anchor"]);
    expect(Object.keys(res.created)).toEqual([]);
  });

  it("refuses class / confidence / status on create, listing every one", async () => {
    const h = harness();
    const res = await h.call<SetResult>("Note/set", {
      create: { claim: note({ class: "commitment", confidence: 0.9, status: "open" }) },
    });
    expect(res.notCreated.claim?.properties).toEqual(["class", "confidence", "status"]);
  });

  it("refuses an annotation-shaped UPDATE — you do not resolve a note", async () => {
    const h = harness();
    const id = await writeOne(h);
    const res = await h.call<SetResult>("Note/set", { update: { [id]: { status: "resolved" } } });
    expect(res.notUpdated[id]?.description).toMatch(/Annotation/);
    expect(res.notUpdated[id]?.description).toMatch(/status/);
  });

  it("refuses any write outside title and body", async () => {
    const h = harness();
    const id = await writeOne(h);
    const res = await h.call<SetResult>("Note/set", { update: { [id]: { owner: "someone@else.test" } } });
    expect(res.notUpdated[id]?.description).toMatch(/only title and body/);
    const n = (await h.call<GetResult>("Note/get", { ids: [id] })).list[0]!;
    expect(n.owner).toBe("eric@bullmoose.cc");
  });
});

describe("Note/query — the enumeration door for an unbounded collection", () => {
  it("returns this account's notes, most recently edited first", async () => {
    const h = harness();
    const a = await writeOne(h, { title: "First" });
    const b = await writeOne(h, { title: "Second" });
    // Editing `a` moves it to the front: the list is by last touch, which is
    // what a notes list means by "recent".
    await h.call<SetResult>("Note/set", { update: { [a]: { body: "edited" } } });
    h.w.db.sqlite.exec(`UPDATE notes SET updated_at = updated_at + 1000 WHERE id = '${a}'`);

    const res = await h.call<{ ids: string[] }>("Note/query", {});
    expect(res.ids).toEqual([a, b]);
  });

  it("filters by text over title AND body, with LIKE wildcards escaped", async () => {
    const h = harness();
    const hinges = await writeOne(h, { title: "Hinges", body: "brass, 3in" });
    const calc = await writeOne(h, { title: "Load calc", body: "Sergio owes the hinges spec" });
    await writeOne(h, { title: "Groceries", body: "milk" });

    const byTitle = await h.call<{ ids: string[] }>("Note/query", { filter: { text: "Load" } });
    expect(byTitle.ids).toEqual([calc]);
    // "hinges" appears in one title and one body — both come back.
    const byEither = await h.call<{ ids: string[] }>("Note/query", { filter: { text: "hinges" } });
    expect(new Set(byEither.ids)).toEqual(new Set([hinges, calc]));

    // A literal % must not become "match everything".
    const wild = await h.call<{ ids: string[] }>("Note/query", { filter: { text: "%" } });
    expect(wild.ids).toEqual([]);
  });

  it("an empty text filter is not a filter", async () => {
    const h = harness();
    await writeOne(h);
    const res = await h.call<{ ids: string[] }>("Note/query", { filter: { text: "   " } });
    expect(res.ids).toHaveLength(1);
  });
});

describe("ownership — another account's note is indistinguishable from nonexistent", () => {
  /** A note that genuinely exists, in an account this principal cannot reach. */
  const seedForeignNote = (h: ReturnType<typeof harness>, id = "nt_foreign") => {
    h.w.db.seed("notes", [
      {
        id,
        account_id: OTHER,
        owner: "stranger@example.test",
        title: "Their private note",
        body: "SECRET",
        revision: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    return id;
  };

  it("Note/get returns it as notFound and NEVER its content", async () => {
    const h = harness();
    const foreign = seedForeignNote(h);
    const mine = await writeOne(h);

    const res = await h.call<GetResult>("Note/get", { ids: [mine, foreign] });
    expect(res.list.map((n) => n.id)).toEqual([mine]);
    expect(res.notFound).toEqual([foreign]);
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("Note/get with ids:null and Note/query never enumerate it", async () => {
    const h = harness();
    seedForeignNote(h);
    const mine = await writeOne(h);

    expect((await h.call<GetResult>("Note/get", { ids: null })).list.map((n) => n.id)).toEqual([mine]);
    expect((await h.call<{ ids: string[] }>("Note/query", {})).ids).toEqual([mine]);
    // …not even with a filter that matches its text exactly.
    expect((await h.call<{ ids: string[] }>("Note/query", { filter: { text: "SECRET" } })).ids).toEqual([]);
  });

  it("Note/set cannot edit or destroy it, and says only 'no note with that id'", async () => {
    const h = harness();
    const foreign = seedForeignNote(h);

    const edit = await h.call<SetResult>("Note/set", { update: { [foreign]: { body: "mine now" } } });
    expect(edit.notUpdated[foreign]).toEqual({ type: "notFound", description: "no note with that id" });

    const kill = await h.call<SetResult>("Note/set", { destroy: [foreign] });
    expect(kill.notDestroyed[foreign]).toEqual({ type: "notFound", description: "no note with that id" });

    // Untouched, in both directions.
    const row = h.w.db.query<{ body: string; revision: number }>(
      `SELECT body, revision FROM notes WHERE id = ?`,
      foreign,
    )[0]!;
    expect(row.body).toBe("SECRET");
    expect(row.revision).toBe(1);
  });

  it("naming the other account outright is accountNotFound, not a refusal that leaks", async () => {
    const h = harness();
    seedForeignNote(h);
    await expect(h.call("Note/get", { accountId: OTHER, ids: null })).rejects.toThrow(/accountNotFound/i);
  });
});

describe("the changelog", () => {
  it("commits creates, updates and destroys on a `Note` collection", async () => {
    // A row that lands without `commitChanges` reads back on a direct `get`
    // and is invisible to every incremental consumer — the one bug only a
    // /changes assertion catches.
    const h = harness();
    const kept = await writeOne(h, { title: "Kept" });
    const doomed = await writeOne(h, { title: "Doomed" });
    const afterCreates = await h.w.accountDo.state(ACCOUNT);

    await h.call<SetResult>("Note/set", { update: { [kept]: { title: "Boards" } } });
    await h.call<SetResult>("Note/set", { destroy: [doomed] });

    // From state 0 the DO collapses: both creates are creates, and
    // create→destroy inside one window cancels out entirely.
    const all = await h.w.accountDo.changes(ACCOUNT, "Note");
    expect(all.created).toEqual([kept]);
    expect(all.destroyed).toEqual([]);

    // From after the creates, the edit and the delete are what happened.
    const since = await h.w.accountDo.changes(ACCOUNT, "Note", afterCreates);
    expect(since.updated).toEqual([kept]);
    expect(since.destroyed).toEqual([doomed]);
  });

  it("a set that changed nothing commits nothing", async () => {
    const h = harness();
    await h.call<SetResult>("Note/set", { create: { bad: { title: "", body: "" } } });
    const changes = await h.w.accountDo.changes(ACCOUNT, "Note");
    expect(changes.created).toEqual([]);
  });
});
