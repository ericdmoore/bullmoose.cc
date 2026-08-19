import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerEmailMethods } from "./email";
import type { RequestContext } from "./common";

// `Email/get` for REAL third-party clients (Mailtemi et al.).
//
// The bug this file exists to keep dead: a client that renders a message by
// walking `bodyStructure` and downloading parts got NOTHING from this server —
// `bodyStructure`, `replyTo`, `sender`, `references`, `headers` and `header:*`
// were silently dropped (requested-but-absent keys), and the text parts it did
// return carried `blobId: null` with no tree to find them in. Our own webmail
// renders from `bodyValues`, which is why the LIST worked and every message
// body was blank.
//
// Harness is @bullmoose/test-fakes: real SQLite, real R2 key semantics, the
// real AccountDO — so `Email/import` builds rows exactly the way ingest does
// (per-attachment content-addressed blobs), and what these tests see is what
// Mailtemi sees.

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const MAILBOX = "mb_inbox";

function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;

  /** Store raw RFC 5322 bytes and import them the way himalaya/ingest would. */
  const importRaw = async (raw: string): Promise<string> => {
    const bytes = new TextEncoder().encode(raw);
    const blobId = await store.putBlob(
      TENANT,
      ACCOUNT,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const res = await call<{ created: Record<string, { id: string }>; notCreated: Record<string, unknown> }>(
      "Email/import",
      { accountId: ACCOUNT, emails: { m: { blobId, mailboxIds: { [MAILBOX]: true } } } },
    );
    if (!res.created.m) throw new Error(`import failed: ${JSON.stringify(res.notCreated)}`);
    return res.created.m.id;
  };

  const get = (args: Record<string, unknown>) =>
    call<{ list: Array<Record<string, unknown>> }>("Email/get", { accountId: ACCOUNT, ...args });

  return { w, store, call, importRaw, get };
}

type Part = {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  subParts?: Part[];
};

/** text + html alternative with a real attachment — the everyday shape. */
const MULTIPART_RAW = [
  'From: "Reply Sender" <sender@example.com>',
  'Reply-To: "Actual Target" <replies@example.com>',
  "Sender: <mailer@example.com>",
  "To: eric@bullmoose.cc",
  "Subject: multipart fixture",
  "Message-ID: <fix-1@example.com>",
  "In-Reply-To: <parent@example.com>",
  "References: <root@example.com> <parent@example.com>",
  "Date: Wed, 19 Aug 2026 10:00:00 +0000",
  "List-Id: Test List <list.example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello plain text.",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hello <b>html</b>.</p>",
  "--ALT--",
  "--MIX",
  'Content-Type: application/pdf; name="doc.pdf"',
  'Content-Disposition: attachment; filename="doc.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--MIX--",
  "",
].join("\r\n");

const HTML_ONLY_RAW = [
  "From: sender@example.com",
  "To: eric@bullmoose.cc",
  "Subject: html only",
  "Date: Wed, 19 Aug 2026 11:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>only html here</p>",
  "",
].join("\r\n");

const TEXT_ONLY_RAW = [
  "From: sender@example.com",
  "To: eric@bullmoose.cc",
  "Subject: text only",
  "Date: Wed, 19 Aug 2026 12:00:00 +0000",
  "",
  "just text",
  "",
].join("\r\n");

// ---- Fix 1: bodyStructure, and part content that actually resolves --------

describe("bodyStructure on a real multipart message", () => {
  it("builds an honest tree: alternatives under mixed, attachment with its REAL blobId", async () => {
    const h = harness();
    const id = await h.importRaw(MULTIPART_RAW);
    const res = await h.get({
      ids: [id],
      properties: ["bodyStructure", "bodyValues", "textBody", "htmlBody", "attachments"],
      fetchAllBodyValues: true,
    });
    const email = res.list[0]!;
    const root = email.bodyStructure as Part;

    expect(root.type).toBe("multipart/mixed");
    expect(root.subParts).toHaveLength(2);

    const alt = root.subParts![0]!;
    expect(alt.type).toBe("multipart/alternative");
    const [text, html] = alt.subParts as [Part, Part];
    expect(text).toMatchObject({ partId: "t", blobId: null, type: "text/plain", charset: "utf-8" });
    expect(html).toMatchObject({ partId: "h", blobId: null, type: "text/html", charset: "utf-8" });
    expect(text.size).toBeGreaterThan(0);
    expect(html.size).toBeGreaterThan(0);

    const att = root.subParts![1]!;
    expect(att).toMatchObject({
      partId: null,
      type: "application/pdf",
      name: "doc.pdf",
      disposition: "attachment",
    });
    expect(att.blobId).toBeTruthy();

    // The tree's blobId is the SAME one the attachments property serves…
    const attachments = email.attachments as Array<{ blobId: string; size: number }>;
    expect(att.blobId).toBe(attachments[0]!.blobId);
    expect(att.size).toBe(attachments[0]!.size);

    // …and it actually resolves to the attachment's bytes (download path).
    const blob = await h.store.getBlob(TENANT, ACCOUNT, att.blobId!);
    expect(blob).not.toBeNull();
    expect(new TextDecoder().decode(await blob!.arrayBuffer())).toContain("%PDF-1.4");

    // Every partId the tree names resolves through bodyValues.
    const bodyValues = email.bodyValues as Record<string, { value: string }>;
    expect(bodyValues[text.partId!]!.value).toContain("Hello plain text.");
    expect(bodyValues[html.partId!]!.value).toContain("<b>html</b>");
  });

  it("a single-part message IS its own bodyStructure — no invented multipart", async () => {
    const h = harness();
    const id = await h.importRaw(TEXT_ONLY_RAW);
    const res = await h.get({ ids: [id], properties: ["bodyStructure"] });
    const root = res.list[0]!.bodyStructure as Part;
    expect(root.type).toBe("text/plain");
    expect(root.partId).toBe("t");
    expect(root.subParts).toBeUndefined();
  });
});

describe("textBody/htmlBody derivation (RFC 8621 §4.1.4)", () => {
  it("an html-only message surfaces its html part in BOTH lists, with its true type", async () => {
    const h = harness();
    const id = await h.importRaw(HTML_ONLY_RAW);
    const res = await h.get({ ids: [id], properties: ["textBody", "htmlBody"] });
    const email = res.list[0]!;
    expect(email.textBody).toMatchObject([{ partId: "h", type: "text/html" }]);
    expect(email.htmlBody).toMatchObject([{ partId: "h", type: "text/html" }]);
  });

  it("a text-only message surfaces its text part in BOTH lists", async () => {
    const h = harness();
    const id = await h.importRaw(TEXT_ONLY_RAW);
    const res = await h.get({ ids: [id], properties: ["textBody", "htmlBody"] });
    const email = res.list[0]!;
    expect(email.textBody).toMatchObject([{ partId: "t", type: "text/plain" }]);
    expect(email.htmlBody).toMatchObject([{ partId: "t", type: "text/plain" }]);
  });

  it("honors the fetch*BodyValues flags — and returns {} when none is set", async () => {
    const h = harness();
    const id = await h.importRaw(MULTIPART_RAW);

    const textOnly = await h.get({ ids: [id], properties: ["bodyValues"], fetchTextBodyValues: true });
    expect(Object.keys(textOnly.list[0]!.bodyValues as object)).toEqual(["t"]);

    const htmlOnly = await h.get({ ids: [id], properties: ["bodyValues"], fetchHTMLBodyValues: true });
    expect(Object.keys(htmlOnly.list[0]!.bodyValues as object)).toEqual(["h"]);

    const none = await h.get({ ids: [id], properties: ["bodyValues"] });
    expect(none.list[0]!.bodyValues).toEqual({});
  });
});

// ---- Fix 2: the header-derived properties ---------------------------------

describe("replyTo / sender / references", () => {
  it("returns RFC 8621 shapes — replyTo is the one phone replies depend on", async () => {
    const h = harness();
    const id = await h.importRaw(MULTIPART_RAW);
    const res = await h.get({ ids: [id], properties: ["replyTo", "sender", "references", "messageId", "inReplyTo"] });
    const email = res.list[0]!;
    expect(email.replyTo).toEqual([{ name: "Actual Target", email: "replies@example.com" }]);
    expect(email.sender).toEqual([{ name: null, email: "mailer@example.com" }]);
    expect(email.references).toEqual(["root@example.com", "parent@example.com"]);
    expect(email.messageId).toEqual(["fix-1@example.com"]);
    expect(email.inReplyTo).toEqual(["parent@example.com"]);
  });

  it("is null, not absent, when the message has none", async () => {
    const h = harness();
    const id = await h.importRaw(TEXT_ONLY_RAW);
    const res = await h.get({ ids: [id], properties: ["replyTo", "sender", "references"] });
    const email = res.list[0]!;
    expect(email).toHaveProperty("replyTo", null);
    expect(email).toHaveProperty("sender", null);
    expect(email).toHaveProperty("references", null);
  });
});

describe("header:* request forms (RFC 8621 §4.1.3)", () => {
  it("serves Raw/Text/Addresses/MessageIds/Date forms under the EXACT requested key", async () => {
    const h = harness();
    const id = await h.importRaw(MULTIPART_RAW);
    const res = await h.get({
      ids: [id],
      properties: [
        "header:List-Id",
        "header:List-Id:asText",
        "header:Reply-To:asAddresses",
        "header:References:asMessageIds",
        "header:Date:asDate",
        "header:X-Missing",
        "header:X-Missing:asText:all",
      ],
    });
    const email = res.list[0]!;
    expect(email["header:List-Id"]).toBe(" Test List <list.example.com>");
    expect(email["header:List-Id:asText"]).toBe("Test List <list.example.com>");
    expect(email["header:Reply-To:asAddresses"]).toEqual([{ name: "Actual Target", email: "replies@example.com" }]);
    expect(email["header:References:asMessageIds"]).toEqual(["root@example.com", "parent@example.com"]);
    expect(email["header:Date:asDate"]).toBe("2026-08-19T10:00:00.000Z");
    // Absent header: null — or [] under :all. Present as keys either way.
    expect(email).toHaveProperty("header:X-Missing", null);
    expect(email["header:X-Missing:asText:all"]).toEqual([]);
  });

  it("the headers property lists every field with original casing", async () => {
    const h = harness();
    const id = await h.importRaw(TEXT_ONLY_RAW);
    const res = await h.get({ ids: [id], properties: ["headers"] });
    const headers = res.list[0]!.headers as Array<{ name: string; value: string }>;
    const names = headers.map((h2) => h2.name);
    expect(names).toContain("From");
    expect(names).toContain("Subject");
    expect(headers.find((h2) => h2.name === "Subject")!.value).toBe(" text only");
  });
});

describe("invalid properties are refused, never silently dropped (RFC 8620 §5.1)", () => {
  it("rejects an unknown property", async () => {
    const h = harness();
    await expect(h.get({ ids: [], properties: ["bogusProperty"] })).rejects.toMatchObject({
      type: "invalidArguments",
    });
  });

  it("rejects a malformed header form", async () => {
    const h = harness();
    await expect(h.get({ ids: [], properties: ["header:X-Thing:asBogus"] })).rejects.toMatchObject({
      type: "invalidArguments",
    });
    await expect(h.get({ ids: [], properties: ["header:"] })).rejects.toMatchObject({
      type: "invalidArguments",
    });
  });
});

describe("omitted properties → the RFC 8621 §4.4 default set", () => {
  it("includes references/sender/replyTo and the body lists; bodyValues is {} without fetch flags", async () => {
    const h = harness();
    const id = await h.importRaw(MULTIPART_RAW);
    const res = await h.get({ ids: [id] });
    const email = res.list[0]!;
    for (const p of ["references", "sender", "replyTo", "textBody", "htmlBody", "bodyValues", "attachments"]) {
      expect(email).toHaveProperty(p);
    }
    expect(email.bodyValues).toEqual({});
    expect(email.replyTo).toEqual([{ name: "Actual Target", email: "replies@example.com" }]);
    // bodyStructure and headers are NOT in the default set.
    expect(email).not.toHaveProperty("bodyStructure");
    expect(email).not.toHaveProperty("headers");
  });
});

// ---- Fix 3: stale sync cursors say "resync", not "retry" ------------------

describe("Email/changes with an unusable sinceState", () => {
  it("maps an opaque/foreign cursor to cannotCalculateChanges", async () => {
    const h = harness();
    await expect(
      h.call("Email/changes", { accountId: ACCOUNT, sinceState: "not-a-cursor-this-server-minted" }),
    ).rejects.toMatchObject({ type: "cannotCalculateChanges" });
  });

  it("maps a from-the-future cursor to cannotCalculateChanges (DO 409)", async () => {
    const h = harness();
    await expect(h.call("Email/changes", { accountId: ACCOUNT, sinceState: "999999" })).rejects.toMatchObject({
      type: "cannotCalculateChanges",
    });
  });

  it("still answers a genuine cursor", async () => {
    const h = harness();
    const id = await h.importRaw(TEXT_ONLY_RAW);
    const res = await h.call<{ created: string[]; newState: string }>("Email/changes", {
      accountId: ACCOUNT,
      sinceState: "0",
    });
    expect(res.created).toContain(id);
    expect(res.newState).not.toBe("0");
  });

  it("a missing sinceState is still an invalidArguments, not a resync", async () => {
    const h = harness();
    await expect(h.call("Email/changes", { accountId: ACCOUNT })).rejects.toMatchObject({
      type: "invalidArguments",
    });
  });
});

// ---- Email/set create: stored == wire, from the create side --------------

describe("Email/set create — client-stamped Message-ID and Date are respected", () => {
  // The invariant behind the self-send threading fix (threadJoin.test.ts in
  // services/ingest): whatever Message-ID the stored row claims must be the
  // one in the MIME that goes to the relay. A client that stamps its own id
  // (Mailtemi does) must find OUR store agreeing with it — generating a
  // fresh id over the client's would re-open the stored != wire divergence
  // at the very first step.

  const create = async (
    h: ReturnType<typeof harness>,
    extra: Record<string, unknown>,
  ): Promise<{ id: string; blob: string }> => {
    const res = await h.call<{
      created: Record<string, { id: string; blobId: string }>;
      notCreated: Record<string, unknown>;
    }>("Email/set", {
      accountId: ACCOUNT,
      create: {
        d: {
          mailboxIds: { [MAILBOX]: true },
          keywords: { $draft: true },
          from: [{ email: "eric@bullmoose.cc" }],
          to: [{ email: "someone@example.com" }],
          subject: "stamped",
          textBody: [{ partId: "t" }],
          bodyValues: { t: { value: "hello" } },
          ...extra,
        },
      },
    });
    if (!res.created.d) throw new Error(`create failed: ${JSON.stringify(res.notCreated)}`);
    const blob = await h.store.getBlob(TENANT, ACCOUNT, res.created.d.blobId);
    return { id: res.created.d.id, blob: await blob!.text() };
  };

  it("a client-supplied messageId is stored AND stamped into the MIME — identically", async () => {
    const h = harness();
    const { id, blob } = await create(h, { messageId: ["client-chosen@mailtemi.example"] });

    expect(blob).toContain("Message-ID: <client-chosen@mailtemi.example>");
    expect((await h.store.getEmailRow(ACCOUNT, id))?.messageId).toBe("client-chosen@mailtemi.example");
  });

  it("a client-supplied sentAt becomes the Date header", async () => {
    const h = harness();
    const { blob } = await create(h, { sentAt: "2026-08-19T10:00:00Z" });

    expect(blob).toContain("Date: Wed, 19 Aug 2026 10:00:00 +0000");
  });

  it("with neither supplied, we generate — and the generated id is stored == stamped too", async () => {
    const h = harness();
    const { id, blob } = await create(h, {});

    const row = await h.store.getEmailRow(ACCOUNT, id);
    expect(row?.messageId).toMatch(/@bullmoose\.cc$/); // ours, from the From domain
    expect(blob).toContain(`Message-ID: <${row?.messageId}>`);
  });
});
