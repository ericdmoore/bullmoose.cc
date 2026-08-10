import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { createDemoBackend } from "../jmap/demo";
import {
  defaultExpanded,
  loadThread,
  renderMessage,
  threadAttachments,
  ThreadViewError,
} from "./threadView";
import type { Email } from "./types";

const ACCOUNT = "acct-fake";

function email(partial: Partial<Email> & Pick<Email, "id">): Email {
  return {
    blobId: "b",
    threadId: "t",
    mailboxIds: { "mb-inbox": true },
    keywords: {},
    size: 1,
    receivedAt: "2026-07-01T00:00:00.000Z",
    messageId: null,
    inReplyTo: null,
    from: [{ name: "Ada", email: "ada@x.test" }],
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

describe("loadThread — one round trip (invariant §6.5)", () => {
  it("opens a thread with a single batched request", async () => {
    const { client } = createDemoBackend();
    const detail = await loadThread(client, ACCOUNT, "t-elk");

    expect(client.sentBatches).toHaveLength(1);
    const batch = client.sentBatches[0] as Array<[string, Record<string, unknown>, string]>;
    expect(batch.map((c) => c[0])).toEqual(["Thread/get", "Email/get"]);
    expect(detail.emails).toHaveLength(2);
  });

  it("maps the thread's emailIds through a `*` back-reference, not a second call", async () => {
    const { client } = createDemoBackend();
    await loadThread(client, ACCOUNT, "t-elk");
    const get = (client.sentBatches[0] as Array<[string, Record<string, unknown>, string]>)[1];
    expect(get?.[1]["#ids"]).toEqual({
      resultOf: "t",
      name: "Thread/get",
      path: "/list/*/emailIds",
    });
  });

  it("returns messages oldest-first — reading order, not query order", async () => {
    const { client } = createDemoBackend();
    const detail = await loadThread(client, ACCOUNT, "t-elk");
    const times = detail.emails.map((e) => Date.parse(e.receivedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(detail.emails[0]?.id).toBe("e-thread-1");
  });

  it("asks for bodies, and gets them", async () => {
    const { client } = createDemoBackend();
    const detail = await loadThread(client, ACCOUNT, "t-welcome");
    expect(detail.emails[0]?.bodyValues?.t?.value).toContain("JMAP");
  });

  it("reports ids the thread claimed but Email/get did not return", async () => {
    const fake = new FakeJmapClient({
      handlers: {
        "Thread/get": () => ({ list: [{ id: "t", emailIds: ["a", "b"] }], notFound: [] }),
        "Email/get": () => ({ list: [email({ id: "a" })], notFound: ["b"] }),
      },
    });
    const detail = await loadThread(fake, ACCOUNT, "t");
    expect(detail.notFound).toEqual(["b"]);
    expect(detail.emails).toHaveLength(1);
  });

  it("surfaces a method-level error rather than rendering an empty thread", async () => {
    const fake = new FakeJmapClient({
      handlers: { "Thread/get": () => ["error", { type: "forbidden" }] },
    });
    await expect(loadThread(fake, ACCOUNT, "t")).rejects.toBeInstanceOf(ThreadViewError);
  });
});

describe("renderMessage", () => {
  it("prefers the HTML part and sanitizes it", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        htmlBody: [{ partId: "h", blobId: null, type: "text/html" }],
        bodyValues: { h: { value: '<p>hi</p><script>alert(1)</script>' } },
      }),
    );
    expect(rendered.isHtml).toBe(true);
    expect(rendered.html).toBe("<p>hi</p>");
    expect(rendered.html).not.toContain("script");
  });

  it("blocks remote images by default and counts them", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        htmlBody: [{ partId: "h", blobId: null, type: "text/html" }],
        bodyValues: { h: { value: '<img src="https://t.test/p.gif">' } },
      }),
    );
    expect(rendered.blockedRemoteCount).toBe(1);
    expect(rendered.html).not.toMatch(/\ssrc=/);
  });

  it("loads them once the message opts in", () => {
    const message = email({
      id: "a",
      htmlBody: [{ partId: "h", blobId: null, type: "text/html" }],
      bodyValues: { h: { value: '<img src="https://t.test/p.gif">' } },
    });
    const rendered = renderMessage(message, { allowRemoteContent: true });
    expect(rendered.blockedRemoteCount).toBe(0);
    expect(rendered.html).toContain('src="https://t.test/p.gif"');
  });

  it("splits the quoted reply out of an HTML body", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        htmlBody: [{ partId: "h", blobId: null, type: "text/html" }],
        bodyValues: { h: { value: "<p>mine</p><blockquote><p>yours</p></blockquote>" } },
      }),
    );
    expect(rendered.html).toBe("<p>mine</p>");
    expect(rendered.quotedHtml).toContain("yours");
  });

  it("escapes a plain-text body instead of trusting it", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
        bodyValues: { t: { value: "<img src=x onerror=alert(1)>" } },
      }),
    );
    expect(rendered.isHtml).toBe(false);
    // The payload survives as visible TEXT — which is correct — but never as an
    // element, so there is no <img> for the browser to try to load and fail.
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.html).not.toMatch(/<img/);
  });

  it("splits the quoted reply out of a plain-text body", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
        bodyValues: {
          t: { value: "Monday works.\n\nOn 2026-07-01, Grace <g@x.test> wrote:\n> Kicking off." },
        },
      }),
    );
    expect(rendered.html).toContain("Monday works.");
    expect(rendered.html).not.toContain("Kicking off");
    expect(rendered.quotedHtml).toContain("Kicking off");
  });

  it("surfaces server-side truncation instead of showing a silently short body", () => {
    const rendered = renderMessage(
      email({
        id: "a",
        textBody: [{ partId: "t", blobId: null, type: "text/plain" }],
        bodyValues: { t: { value: "start of a long mail", isTruncated: true } },
      }),
    );
    expect(rendered.truncated).toBe(true);
  });

  it("falls back to the preview when there is no body at all", () => {
    const rendered = renderMessage(email({ id: "a", preview: "only a preview" }));
    expect(rendered.html).toContain("only a preview");
  });
});

describe("defaultExpanded", () => {
  it("opens the newest message", () => {
    const open = defaultExpanded([
      email({ id: "a", keywords: { $seen: true } }),
      email({ id: "b", keywords: { $seen: true } }),
    ]);
    expect([...open]).toEqual(["b"]);
  });

  it("also opens every unread message", () => {
    const open = defaultExpanded([
      email({ id: "a", keywords: {} }),
      email({ id: "b", keywords: { $seen: true } }),
      email({ id: "c", keywords: { $seen: true } }),
    ]);
    expect(open.has("a")).toBe(true);
    expect(open.has("c")).toBe(true);
    expect(open.has("b")).toBe(false);
  });
});

describe("threadAttachments", () => {
  it("collects real attachments across the thread and dedupes by blob", () => {
    const att = (blobId: string, name: string) => ({
      partId: null,
      blobId,
      size: 10,
      name,
      type: "application/pdf",
      cid: null,
      disposition: "attachment",
    });
    const list = threadAttachments([
      email({ id: "a", attachments: [att("b1", "one.pdf")] }),
      email({ id: "b", attachments: [att("b1", "one.pdf"), att("b2", "two.pdf")] }),
    ]);
    expect(list.map((a) => a.name)).toEqual(["one.pdf", "two.pdf"]);
  });

  it("leaves inline images out of the tray — they belong to the body", () => {
    const list = threadAttachments([
      email({
        id: "a",
        attachments: [
          {
            partId: null,
            blobId: "b1",
            size: 10,
            name: "logo.png",
            type: "image/png",
            cid: "logo@x",
            disposition: "inline",
          },
        ],
      }),
    ]);
    expect(list).toHaveLength(0);
  });
});
