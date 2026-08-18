import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { installNotesDemo } from "./demoNotes";
import { createNote, destroyNote, loadNotes, updateNote } from "./api";
import { parseNote } from "./types";

// s18 N1 — the realm's fetch and its three writes, driven against the demo
// backend (which mirrors the server's semantics, refusals included). The
// properties that matter: one round trip per load, one account (never a
// fan-out — a note lives only in the account that authored it), and a refusal
// that reaches the user as a sentence rather than a stack trace.

const ACCOUNT = "acct-fake";

function demoClient() {
  const client = new FakeJmapClient();
  const backend = installNotesDemo(client, { now: 1_700_000_000_000 });
  return { client, backend };
}

describe("parseNote", () => {
  it("drops a row with no id and defaults everything else", () => {
    expect(parseNote({ title: "x" })).toBeNull();
    const n = parseNote({ id: "nt_1" }, "a_eric")!;
    expect(n).toMatchObject({ id: "nt_1", accountId: "a_eric", title: "", body: "", revision: 1 });
  });

  it("has no vocabulary for an annotation's fields", () => {
    // Two entities (s18): even a row carrying them parses as a plain note.
    const n = parseNote({ id: "nt_1", anchor: { realm: "Email", objectId: "e1" }, class: "commitment" })!;
    expect(n).not.toHaveProperty("anchor");
    expect(n).not.toHaveProperty("class");
  });
});

describe("loadNotes", () => {
  it("reads the account's notes in ONE round trip, newest edit first", async () => {
    const { client } = demoClient();
    const res = await loadNotes(client, ACCOUNT);
    expect(res.failure).toBeNull();
    expect(res.notes.map((n) => n.id)).toEqual(["nt-boards", "nt-shop", "nt-untitled"]);
    // query + get in a single POST (the `loadThread` discipline).
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]!.map((c) => c[0])).toEqual(["Note/query", "Note/get"]);
  });

  it("passes a text filter to the server rather than filtering after the fact", async () => {
    const { client } = demoClient();
    const res = await loadNotes(client, ACCOUNT, "  hinge  ");
    expect(res.notes.map((n) => n.id)).toEqual(["nt-untitled"]);
    expect(client.sentBatches[0]![0]![1]).toMatchObject({ filter: { text: "hinge" } });
  });

  it("omits the filter entirely when the query is blank", async () => {
    const { client } = demoClient();
    await loadNotes(client, ACCOUNT, "   ");
    expect(client.sentBatches[0]![0]![1]).not.toHaveProperty("filter");
  });

  it("names an older server rather than reporting a permissions problem", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "Note/query": () => ["error", { type: "unknownMethod" }],
        "Note/get": () => ["error", { type: "unknownMethod" }],
      },
    });
    const res = await loadNotes(client, ACCOUNT);
    expect(res.notes).toEqual([]);
    expect(res.failure).toMatch(/does not implement Note methods/);
  });

  it("turns a refusal into a sentence a person can act on", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "Note/query": () => ["error", { type: "forbidden", description: "token lacks the read scope" }],
        "Note/get": () => ["error", { type: "forbidden" }],
      },
    });
    const res = await loadNotes(client, ACCOUNT);
    expect(res.failure).toMatch(/not allowed/);
  });
});

describe("the three writes", () => {
  it("creates a note and the server stamps id, owner and revision 1", async () => {
    const { client, backend } = demoClient();
    const res = await createNote(client, ACCOUNT, { title: "New", body: "words" });
    expect(res.ok).toBe(true);
    const made = backend.notes.find((n) => n.title === "New")!;
    // The federation identity (s18 N3 seam) — never a client's to choose.
    expect(made.owner).toBe("fake@bullmoose.test");
    expect(made.revision).toBe(1);
  });

  it("refuses an empty note in the server's own words", async () => {
    const { client } = demoClient();
    const res = await createNote(client, ACCOUNT, { title: "", body: "" });
    expect(res).toMatchObject({ ok: false, message: "a note needs a title or a body", forbidden: false });
  });

  it("relays the Note-is-not-an-Annotation refusal VERBATIM", async () => {
    // The server's sentence names the other entity at the point of the
    // mistake; re-wording it here would throw away the only place a client
    // that reached for `anchor` is told what it actually wanted.
    const { client } = demoClient();
    const res = await client.request([
      ["Note/set", { accountId: ACCOUNT, create: { c: { title: "x", anchor: { realm: "Email" } } } }, "s0"],
    ]);
    const args = res[0]![1] as { notCreated: Record<string, { description: string }> };
    expect(args.notCreated.c!.description).toMatch(/Annotation\/set/);
  });

  it("saves an edit and bumps the revision", async () => {
    const { client, backend } = demoClient();
    const res = await updateNote(client, ACCOUNT, "nt-shop", { body: "moved the bench" });
    expect(res).toEqual({ ok: true, id: "nt-shop" });
    const row = backend.notes.find((n) => n.id === "nt-shop")!;
    expect(row.body).toBe("moved the bench");
    expect(row.revision).toBe(3);
  });

  it("reports an unknown id without inventing a note", async () => {
    const { client } = demoClient();
    const res = await updateNote(client, ACCOUNT, "nt-nope", { body: "x" });
    expect(res).toMatchObject({ ok: false, message: "no note with that id" });
  });

  it("destroys a note, and says so once it is already gone", async () => {
    const { client, backend } = demoClient();
    expect(await destroyNote(client, ACCOUNT, "nt-shop")).toEqual({ ok: true, id: "nt-shop" });
    expect(backend.notes.some((n) => n.id === "nt-shop")).toBe(false);
    expect(await destroyNote(client, ACCOUNT, "nt-shop")).toMatchObject({ ok: false });
  });

  it("flags a missing write scope so the caller can grey the verbs", async () => {
    const client = new FakeJmapClient({
      handlers: { "Note/set": () => ["error", { type: "forbidden" }] },
    });
    const res = await createNote(client, ACCOUNT, { title: "x", body: "" });
    expect(res).toMatchObject({ ok: false, forbidden: true });
    // The refusal names the scope the write actually needs.
    expect(res.ok === false && res.message).toMatch(/draft/);
  });
});
