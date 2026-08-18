import { describe, expect, it } from "vitest";
import { createDemoBackend } from "./demo";

// s18 A3 — the mail demo's Annotation/* handlers, driven through the same
// client.request path the margin uses. The fake mirrors the server's warts on
// purpose (annotation.ts): OPEN is the default view, a claim is immutable
// (status-only patches), and a claim closes exactly once.

async function one(backend: ReturnType<typeof createDemoBackend>, call: [string, Record<string, unknown>]) {
  const [resp] = await backend.client.request([[call[0], call[1], "r0"]]);
  return resp!;
}

describe("demo Annotation/query + get", () => {
  it("defaults to OPEN claims and filters by the anchor's objectId", async () => {
    const backend = createDemoBackend();
    const q = await one(backend, ["Annotation/query", { accountId: "acct-fake", filter: { objectId: "e-thread-1" } }]);
    expect(q[0]).toBe("Annotation/query");
    const ids = (q[1] as { ids: string[] }).ids;
    // e-thread-1 carries an open decision AND a dismissed task; only the open one shows by default.
    expect(ids).toEqual(["an-elk-decision"]);

    const dismissed = await one(backend, [
      "Annotation/query",
      { accountId: "acct-fake", filter: { objectId: "e-thread-1", status: "dismissed" } },
    ]);
    expect((dismissed[1] as { ids: string[] }).ids).toEqual(["an-elk-task-dismissed"]);
  });

  it("anchors bind to the ORIGINAL message: the quoting reply has its own note, not a copy", async () => {
    const backend = createDemoBackend();
    const q = await one(backend, ["Annotation/query", { accountId: "acct-fake", filter: { objectId: "e-thread-2" } }]);
    expect((q[1] as { ids: string[] }).ids).toEqual(["an-elk-commitment"]);
  });

  it("get returns the rows by id", async () => {
    const backend = createDemoBackend();
    const g = await one(backend, ["Annotation/get", { accountId: "acct-fake", ids: ["an-invoice-task", "nope"] }]);
    const args = g[1] as { list: Array<{ id: string; rationale: unknown }>; notFound: string[] };
    expect(args.list.map((r) => r.id)).toEqual(["an-invoice-task"]);
    expect(args.list[0]!.rationale).toBeNull(); // renders "Why: not stated"
    expect(args.notFound).toEqual(["nope"]);
  });
});

describe("demo Annotation/set", () => {
  it("dismisses an open claim once — and refuses the second write (the judgment is recorded)", async () => {
    const backend = createDemoBackend();
    const before = backend.state();
    const first = await one(backend, [
      "Annotation/set",
      { accountId: "acct-fake", update: { "an-elk-commitment": { status: "dismissed" } } },
    ]);
    expect((first[1] as { updated: Record<string, null> }).updated).toHaveProperty("an-elk-commitment");
    expect(backend.annotations.find((r) => r.id === "an-elk-commitment")!.status).toBe("dismissed");
    expect(backend.state()).not.toBe(before); // the write moved the account state

    const second = await one(backend, [
      "Annotation/set",
      { accountId: "acct-fake", update: { "an-elk-commitment": { status: "resolved" } } },
    ]);
    const notUpdated = (second[1] as { notUpdated: Record<string, { description: string }> }).notUpdated;
    expect(notUpdated["an-elk-commitment"]!.description).toContain("already resolved, dismissed or unknown");
  });

  it("refuses to rewrite the claim — a patch touching body is not a correction", async () => {
    const backend = createDemoBackend();
    const resp = await one(backend, [
      "Annotation/set",
      { accountId: "acct-fake", update: { "an-elk-decision": { status: "resolved", body: "edited" } } },
    ]);
    const notUpdated = (resp[1] as { notUpdated: Record<string, { description: string }> }).notUpdated;
    expect(notUpdated["an-elk-decision"]!.description).toContain("immutable");
    expect(backend.annotations.find((r) => r.id === "an-elk-decision")!.status).toBe("open");
  });

  it("gates on the annotate scope, like the server", async () => {
    const backend = createDemoBackend({ scopes: ["read"] });
    const resp = await one(backend, [
      "Annotation/set",
      { accountId: "acct-fake", update: { "an-elk-decision": { status: "resolved" } } },
    ]);
    expect(resp[0]).toBe("error");
    expect((resp[1] as { type: string; description: string }).type).toBe("forbidden");
    expect((resp[1] as { description: string }).description).toContain("annotate");
  });

  it("refuses an unanchored create — no comment without an object", async () => {
    const backend = createDemoBackend();
    const resp = await one(backend, [
      "Annotation/set",
      { accountId: "acct-fake", create: { c0: { class: "task", body: "floating observation" } } },
    ]);
    const notCreated = (resp[1] as { notCreated: Record<string, { description: string }> }).notCreated;
    expect(notCreated.c0!.description).toContain("anchor");
    expect(backend.annotations.some((r) => r.body === "floating observation")).toBe(false);
  });

  it("a human-filed claim lands open, at no stated confidence", async () => {
    const backend = createDemoBackend();
    const resp = await one(backend, [
      "Annotation/set",
      {
        accountId: "acct-fake",
        create: {
          c0: {
            anchor: { realm: "Email", objectId: "e-welcome" },
            class: "commitment",
            body: "I said I'd reply to the welcome mail",
          },
        },
      },
    ]);
    const created = (resp[1] as { created: Record<string, { id: string; status: string }> }).created;
    expect(created.c0!.status).toBe("open");
    const row = backend.annotations.find((r) => r.id === created.c0!.id)!;
    expect(row.authorKind).toBe("human");
    expect(row.confidence).toBeNull();
  });
});
