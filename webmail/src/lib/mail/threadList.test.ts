import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { createDemoBackend, demoEmails } from "../jmap/demo";
import { ThreadListStore, groupIntoThreads, REFRESH_CAP } from "./threadList";
import type { Email } from "./types";

const ACCOUNT = "acct-fake";

function email(partial: Partial<Email> & Pick<Email, "id">): Email {
  return {
    blobId: "b",
    threadId: partial.id,
    mailboxIds: { "mb-inbox": true },
    keywords: {},
    size: 1,
    receivedAt: "2026-07-01T00:00:00.000Z",
    messageId: null,
    inReplyTo: null,
    from: [{ name: null, email: "a@x.test" }],
    to: [],
    cc: [],
    bcc: [],
    subject: "s",
    sentAt: null,
    hasAttachment: false,
    preview: "",
    attachments: [],
    ...partial,
  } as Email;
}

describe("ThreadListStore — batching", () => {
  it("loads a page in ONE round trip: Email/query back-referenced into Email/get", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 10 });
    await store.reload();

    expect(client.sentBatches).toHaveLength(1);
    const batch = client.sentBatches[0] as Array<[string, Record<string, unknown>, string]>;
    expect(batch.map((c) => c[0])).toEqual(["Email/query", "Email/get"]);
    // The get names no ids of its own — it references the query's result.
    expect(batch[1]?.[1]).not.toHaveProperty("ids");
    expect(batch[1]?.[1]["#ids"]).toEqual({
      resultOf: "q",
      name: "Email/query",
      path: "/ids",
    });
  });

  it("renders rows in the QUERY's order even when Email/get returns them shuffled", async () => {
    const fake = new FakeJmapClient({
      handlers: {
        "Email/query": () => ({ ids: ["c", "a", "b"], queryState: "1", total: 3 }),
        "Email/get": (args) => ({
          // Deliberately reversed: `Email/get` promises no order.
          list: (args.ids as string[])
            .slice()
            .reverse()
            .map((id) => email({ id })),
          notFound: [],
        }),
      },
    });
    const store = new ThreadListStore(fake, ACCOUNT);
    await store.reload();
    expect(store.getEmails().map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("appends the next page without refetching the first", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 2 });
    await store.reload();
    expect(store.getEmails()).toHaveLength(2);
    expect(store.hasMore()).toBe(true);

    await store.loadMore();
    expect(store.getEmails()).toHaveLength(4);
    expect(new Set(store.getEmails().map((e) => e.id)).size).toBe(4);
  });

  it("stops asking once everything is loaded", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 100 });
    await store.reload();
    const batches = client.sentBatches.length;
    const result = await store.loadMore();
    expect(result.changed).toBe(false);
    expect(client.sentBatches).toHaveLength(batches);
  });
});

describe("ThreadListStore — sync WITHOUT Email/queryChanges", () => {
  // arch.md §4 planned this on queryChanges. The server always throws
  // cannotCalculateChanges and advertises canCalculateChanges: false, so the
  // store must use RFC 8620 §5.6's re-query fallback instead.
  it("never calls Email/queryChanges", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    await store.refresh();
    await store.loadMore();

    const methods = client.sentBatches.flat().map((call) => call[0]);
    expect(methods).not.toContain("Email/queryChanges");
    expect(methods).not.toContain("Mailbox/queryChanges");
  });

  it("refreshes correctly against a server whose queryChanges throws", async () => {
    const { client, emails } = createDemoBackend();
    // Prove the fake really does refuse, exactly as the server does.
    await expect(client.requestOne("Email/queryChanges", { accountId: ACCOUNT, sinceQueryState: "0" })).rejects.toThrow(
      /cannotCalculateChanges/,
    );

    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    const before = store.getRows().length;

    emails.push(
      email({
        id: "e-new",
        threadId: "t-new",
        subject: "New",
        receivedAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const result = await store.refresh();

    expect(result.changed).toBe(true);
    expect(store.getRows().length).toBe(before + 1);
    expect(store.getRows()[0]?.subject).toBe("New");
  });

  it("reports changed:false when a push concerned something else", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    const result = await store.refresh();
    expect(result.changed).toBe(false);
  });

  it("notices a keyword change, not just an added or removed row", async () => {
    const { client, emails } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    const target = emails[0] as Email;
    target.keywords = { ...target.keywords, $flagged: true };

    expect((await store.refresh()).changed).toBe(true);
  });

  it("coalesces a burst of pushes into one request", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    const before = client.sentBatches.length;

    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(client.sentBatches.length).toBe(before + 1);
  });

  it("bounds a refresh at REFRESH_CAP rather than re-reading an unbounded list", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      email({
        id: `e${i}`,
        threadId: `t${i}`,
        receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      }),
    );
    const { client } = createDemoBackend({ emails: many });
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 300 });
    await store.reload();
    await store.refresh();

    const lastQuery = client.sentBatches.at(-1)?.[0]?.[1] as { limit?: number };
    expect(lastQuery.limit).toBe(REFRESH_CAP);
    // Rows past the cap survive the refresh — the list must not jump.
    expect(store.getEmails()).toHaveLength(300);
  });
});

describe("ThreadListStore — optimistic local edits", () => {
  it("applies a keyword patch locally and notifies subscribers", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    let notified = 0;
    store.onChange(() => notified++);

    const id = store.getEmails()[0]?.id as string;
    store.patchLocal(id, { keywords: { $seen: true } });

    expect(store.getEmails()[0]?.keywords.$seen).toBe(true);
    expect(notified).toBe(1);
  });

  it("removes archived rows before the server confirms, adjusting the total", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 100 });
    await store.reload();
    const total = store.getTotal() as number;
    const id = store.getEmails()[0]?.id as string;

    store.removeLocal([id]);
    expect(store.getEmails().some((e) => e.id === id)).toBe(false);
    expect(store.getTotal()).toBe(total - 1);
  });

  it("ignores a removal of rows it does not hold", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT);
    await store.reload();
    const total = store.getTotal();
    store.removeLocal(["not-here"]);
    expect(store.getTotal()).toBe(total);
  });
});

describe("groupIntoThreads", () => {
  it("collapses a thread onto the position of its newest message", () => {
    const rows = groupIntoThreads([
      email({ id: "b2", threadId: "t-b", receivedAt: "2026-07-03T00:00:00.000Z" }),
      email({ id: "a1", threadId: "t-a", receivedAt: "2026-07-02T00:00:00.000Z" }),
      email({ id: "b1", threadId: "t-b", receivedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.threadId)).toEqual(["t-b", "t-a"]);
    expect(rows[0]?.loadedCount).toBe(2);
    expect(rows[0]?.emailIds).toEqual(["b2", "b1"]);
  });

  it("marks a thread unread when ANY message in it is unread", () => {
    const rows = groupIntoThreads([
      email({ id: "n", threadId: "t", keywords: {} }),
      email({ id: "o", threadId: "t", keywords: { $seen: true } }),
    ]);
    expect(rows[0]?.unread).toBe(true);
  });

  it("takes the subject from the OLDEST loaded message, not the Re: on top", () => {
    const rows = groupIntoThreads([
      email({ id: "n", threadId: "t", subject: "Re: Kickoff" }),
      email({ id: "o", threadId: "t", subject: "Kickoff" }),
    ]);
    expect(rows[0]?.subject).toBe("Kickoff");
  });

  it("lists distinct participants in conversation order", () => {
    const rows = groupIntoThreads([
      email({ id: "n", threadId: "t", from: [{ name: "Bob", email: "b@x.test" }] }),
      email({ id: "m", threadId: "t", from: [{ name: "Ada", email: "a@x.test" }] }),
      email({ id: "o", threadId: "t", from: [{ name: "Ada", email: "a@x.test" }] }),
    ]);
    expect(rows[0]?.participants).toEqual(["Ada", "Bob"]);
  });

  it("groups the demo thread into a single row of two messages", async () => {
    const { client } = createDemoBackend({ emails: demoEmails() });
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 100 });
    await store.reload();
    const elk = store.getRows().find((r) => r.threadId === "t-elk");
    expect(elk?.loadedCount).toBe(2);
    expect(elk?.subject).toBe("Project Elk kickoff");
  });
});
