import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES_PER_EMAIL, MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import worker, { type Env } from "../index";
import { listShareRecords, SHARE_DEFAULT_TTL } from "../shares";
import { registerEmailMethods } from "./email";
import { registerFileNodeMethods } from "./filenode";
import { SENT_ATTACHMENTS_DIR_NAME } from "./outboundSidestep";
import type { RequestContext } from "./common";

// The attachment sidestep, OUTBOUND half (s03.B T3).
//
// The contract under test, in the order the design states it:
//
//   1. It fires ONLY when the create would otherwise be refused `tooLarge`.
//      Under the cap, the MIME is byte-identical to before the sidestep
//      existed and not one FileNode, share record, or KV write happens.
//   2. When it fires, the create SUCCEEDS: every non-inline attachment
//      becomes a FileNode under "Sent attachments" plus an expiring link,
//      and the body gains a block naming each file, its size, its link, and
//      the expiry date — phrased as the capability URL it is ("anyone with
//      a link"), never as recipient-only access.
//   3. The links go through the REAL share door: minted through the same
//      code as POST /api/share/*, recorded in KV before being uttered, and
//      served by GET /share/* exactly as a recipient would fetch them.
//   4. stored == wire: the stored blob IS what submission puts on the wire,
//      so "no oversized parts on the MIME" is asserted against the blob.
//
// Harness is @bullmoose/test-fakes: real SQLite on the live schema, real R2
// semantics, real AccountDO changelog — and the round-trip test drives the
// WORKER ENTRYPOINT for the download, unauthenticated, like any recipient.

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const MAILBOX = "mb_drafts";
const ORIGIN = "https://app.example";

/** Big enough that TWO bust the 10 MB cap; small enough to allocate freely. */
const HALF_PLUS = Math.ceil(MAX_ATTACHMENT_BYTES_PER_EMAIL / 2) + 1;

type SetError = { type: string; description?: string; properties?: string[] };
type SetResult = {
  oldState: string;
  newState: string;
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, SetError>;
};

function harness(opts: { configured?: boolean; origin?: string | undefined } = {}) {
  const w = fakeEnv();
  if (opts.configured !== false) w.env.SHARE_SIGNING_KEY = "test-signing-key";
  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);
  registerFileNodeMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["read", "draft", "files"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
    ...("origin" in opts ? (opts.origin !== undefined ? { origin: opts.origin } : {}) : { origin: ORIGIN }),
  };

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;

  const seedBlob = (content: string | Uint8Array) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return store.putBlob(
      TENANT,
      ACCOUNT,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  };

  const draft = (spec: Record<string, unknown>) =>
    call<SetResult>("Email/set", {
      accountId: ACCOUNT,
      create: {
        d: {
          mailboxIds: { [MAILBOX]: true },
          keywords: { $draft: true },
          from: [{ email: "eric@bullmoose.cc" }],
          to: [{ email: "someone@example.com" }],
          subject: "the photos",
          textBody: [{ partId: "t" }],
          bodyValues: { t: { value: "here you go" } },
          ...spec,
        },
      },
    });

  /** The raw RFC 5322 bytes of a created draft — the wire copy. */
  const rawOf = async (created: Record<string, unknown>) => {
    const obj = await store.getBlob(TENANT, ACCOUNT, created.blobId as string);
    return new TextDecoder().decode(await obj!.arrayBuffer());
  };

  /** The message as a re-fetching client sees it. */
  const refetch = (id: string) =>
    call<{ list: Array<Record<string, unknown>> }>("Email/get", {
      accountId: ACCOUNT,
      ids: [id],
      properties: ["bodyValues", "textBody", "htmlBody", "hasAttachment", "attachments"],
      fetchAllBodyValues: true,
    });

  const bodyText = async (id: string, want: "textBody" | "htmlBody" = "textBody") => {
    const res = await refetch(id);
    const email = res.list[0]!;
    const parts = email[want] as Array<{ partId: string }>;
    const values = email.bodyValues as Record<string, { value: string }>;
    return parts.map((p) => values[p.partId]!.value).join("\n");
  };

  const fileNodes = async () => {
    const res = await call<{ list: Array<Record<string, unknown>> }>("FileNode/get", {
      accountId: ACCOUNT,
      ids: null,
    });
    return res.list;
  };

  /** Unauthenticated GET of an absolute URL — a share-link recipient. */
  const open = (url: string) => worker.fetch(new Request(url), w.env as Env);

  return { w, ctx, store, call, seedBlob, draft, rawOf, refetch, bodyText, fileNodes, open };
}

const ok = (res: SetResult) => {
  if (!res.created.d) throw new Error(`create failed: ${JSON.stringify(res.notCreated)}`);
  return res.created.d;
};

const urlsIn = (text: string) => [...text.matchAll(/https:\/\/\S+/g)].map((m) => m[0]);

// ---- rule 1: fires only when the send would otherwise be refused ----------

describe("the sidestep fires only over the cap", () => {
  it("leaves an under-cap create untouched — attachment on the wire, no nodes, no links", async () => {
    const h = harness();
    const blobId = await h.seedBlob("PDF-BYTES");
    const created = ok(await h.draft({ attachments: [{ blobId, type: "application/pdf", name: "report.pdf" }] }));

    // The wire copy is what it always was: a real attachment part.
    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(raw).toContain(btoa("PDF-BYTES"));

    // And not one side effect: no block, no FileNode, no share record.
    expect(await h.bodyText(created.id as string)).not.toContain("Anyone with a link");
    expect(await h.fileNodes()).toEqual([]);
    expect(await listShareRecords(h.w.env.ROUTES, ACCOUNT)).toEqual([]);
  });

  it("still refuses tooLarge when sharing is not configured", async () => {
    const h = harness({ configured: false });
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1));
    const res = await h.draft({ attachments: [{ blobId: big, name: "huge.bin" }] });
    expect(res.notCreated.d!.type).toBe("tooLarge");
    expect(res.notCreated.d!.properties).toEqual(["attachments"]);
    expect(await h.fileNodes()).toEqual([]);
  });

  it("still refuses tooLarge for a caller with no request origin (the agent bridge)", async () => {
    const h = harness({ origin: undefined });
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1));
    const res = await h.draft({ attachments: [{ blobId: big, name: "huge.bin" }] });
    expect(res.notCreated.d!.type).toBe("tooLarge");
  });

  it("still refuses tooLarge when only inline (cid) parts bust the cap — body furniture cannot become a link", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(9));
    const res = await h.draft({
      htmlBody: [{ partId: "t" }],
      textBody: null,
      bodyValues: { t: { value: '<img src="cid:pic1">' } },
      attachments: [{ blobId: big, type: "image/png", name: "pic.png", cid: "pic1" }],
    });
    expect(res.notCreated.d!.type).toBe("tooLarge");
    expect(await h.fileNodes()).toEqual([]);
  });
});

// ---- rule 2 + 3: over the cap, the create succeeds with honest links ------

describe("an over-cap create succeeds with links", () => {
  it("turns every attachment into a FileNode plus an expiring link, stated plainly in the body", async () => {
    const h = harness();
    const a = await h.seedBlob(new Uint8Array(HALF_PLUS).fill(1));
    const b = await h.seedBlob(new Uint8Array(HALF_PLUS).fill(2));
    const res = await h.draft({
      attachments: [
        { blobId: a, type: "image/jpeg", name: "IMG_0001.jpg" },
        { blobId: b, type: "image/jpeg", name: "IMG_0002.jpg" },
      ],
    });
    const created = ok(res);

    // RFC 8620 §5.3 transparency: the created response carries the properties
    // whose final value differs from what the client sent.
    expect(created.attachments).toEqual([]);
    expect(created.hasAttachment).toBe(false);

    // The wire copy carries NO oversized part — no attachment parts at all.
    const raw = await h.rawOf(created);
    expect(raw).not.toContain("Content-Disposition: attachment");
    expect(raw).not.toContain("multipart/mixed");

    // The body block: one line per file — name, human size, link — plus the
    // expiry date and the capability-URL phrasing.
    const text = await h.bodyText(created.id as string);
    expect(text).toContain("here you go");
    expect(text).toContain("2 attachments were too large");
    expect(text).toContain("IMG_0001.jpg (5.0 MB)");
    expect(text).toContain("IMG_0002.jpg (5.0 MB)");
    expect(text).toContain("Anyone with a link");

    // The expiry in the body is the expiry that was SIGNED — same date, and
    // exactly the default share TTL from mint time.
    const records = await listShareRecords(h.w.env.ROUTES, ACCOUNT);
    expect(records).toHaveLength(2);
    const exp = records[0]!.exp;
    expect(records[1]!.exp).toBe(exp);
    expect(exp - Math.floor(records[0]!.createdAt / 1000)).toBe(SHARE_DEFAULT_TTL);
    expect(text).toContain(`until ${new Date(exp * 1000).toISOString().slice(0, 10)} (UTC)`);

    // The sender's record: a "Sent attachments" folder holding both files.
    const nodes = await h.fileNodes();
    const dir = nodes.find((n) => n.name === SENT_ATTACHMENTS_DIR_NAME)!;
    expect(dir).toBeDefined();
    const files = nodes.filter((n) => n.parentId === dir.id);
    expect(files.map((n) => n.name).sort()).toEqual(["IMG_0001.jpg", "IMG_0002.jpg"]);
    expect(files.map((n) => n.blobId).sort()).toEqual([a, b].sort());

    // All three nodes announced through the changelog, so clients sync them.
    const delta = await h.call<{ created: string[] }>("FileNode/changes", {
      accountId: ACCOUNT,
      sinceState: res.oldState,
    });
    expect(delta.created.sort()).toEqual(nodes.map((n) => n.id as string).sort());

    // A re-fetch tells the same story the create response did.
    const got = (await h.refetch(created.id as string)).list[0]!;
    expect(got.hasAttachment).toBe(false);
    expect(got.attachments).toEqual([]);
  });

  it("Done-when: a >25 MB send produces a message whose link serves the real bytes until expiry", async () => {
    const h = harness();
    const bytes = new Uint8Array(26_000_000);
    bytes[0] = 42;
    bytes[25_999_999] = 7;
    const blobId = await h.seedBlob(bytes);
    const created = ok(await h.draft({ attachments: [{ blobId, type: "video/quicktime", name: "vacation.mov" }] }));

    const text = await h.bodyText(created.id as string);
    expect(text).toContain("vacation.mov (26.0 MB)");
    const url = urlsIn(text).find((u) => u.includes("/share/"))!;
    expect(url).toBeDefined();

    // Fetch it exactly as the recipient would: unauthenticated, through the
    // worker's public /share/* door.
    const res = await h.open(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/quicktime");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(26_000_000);
    expect(body[0]).toBe(42);
    expect(body[25_999_999]).toBe(7);
  });

  it("appends the block to BOTH body variants when both exist", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(3));
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "h" }],
        bodyValues: { t: { value: "plain words" }, h: { value: "<p>rich words</p>" } },
        attachments: [{ blobId: big, type: "application/zip", name: "site backup.zip" }],
      }),
    );
    const text = await h.bodyText(created.id as string);
    expect(text).toContain("plain words");
    expect(text).toContain("site backup.zip");
    const html = await h.bodyText(created.id as string, "htmlBody");
    expect(html).toContain("<p>rich words</p>");
    expect(html).toContain('<a href="');
    expect(html).toContain("site backup.zip</a>");
    expect(html).toContain("Anyone with a link");
  });

  it("creates a text body for an all-attachment send — the links must ride somewhere", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(4));
    const created = ok(
      await h.draft({
        textBody: null,
        bodyValues: null,
        attachments: [{ blobId: big, name: "raw.dump" }],
      }),
    );
    const text = await h.bodyText(created.id as string);
    expect(text).toContain("1 attachment was too large");
    expect(text).toContain("raw.dump");
    expect(text).toContain("Anyone with a link");
  });

  it("moves the big file but keeps a small cid image on the wire", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(5));
    const logo = await h.seedBlob("PNG-LOGO-BYTES");
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "t" }],
        textBody: null,
        bodyValues: { t: { value: '<img src="cid:logo1">' } },
        attachments: [
          { blobId: big, type: "application/zip", name: "everything.zip" },
          { blobId: logo, type: "image/png", name: "logo.png", cid: "logo1" },
        ],
      }),
    );

    // The cid part is still a real MIME part; the big one is not.
    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-ID: <logo1>");
    expect(raw).toContain(btoa("PNG-LOGO-BYTES"));
    expect(raw).not.toContain("Content-Disposition: attachment");

    // Metadata matches the wire: the inline part is the only attachment left.
    const got = (await h.refetch(created.id as string)).list[0]!;
    const metas = got.attachments as Array<{ name: string }>;
    expect(metas.map((m) => m.name)).toEqual(["logo.png"]);
    expect(got.hasAttachment).toBe(false);

    // Only the big file was linked.
    const html = await h.bodyText(created.id as string, "htmlBody");
    expect(html).toContain("everything.zip");
    expect(html).not.toContain("logo.png</a>");
  });

  it("side-steps the bodyStructure create form too, preserving the authored body", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(6));
    const created = ok(
      await h.draft({
        textBody: null,
        bodyValues: { "1": { value: "composed in Mailtemi" } },
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { partId: "1", type: "text/plain" },
            { blobId: big, type: "application/pdf", name: "scan.pdf", disposition: "attachment" },
          ],
        },
      }),
    );
    const text = await h.bodyText(created.id as string);
    expect(text).toContain("composed in Mailtemi");
    expect(text).toContain("scan.pdf");
    expect(text).toContain("Anyone with a link");
    expect(await h.rawOf(created)).not.toContain("Content-Disposition: attachment");
  });

  it("refuses tooLarge when a bodyStructure's own blob-carried BODY busts the cap", async () => {
    const h = harness();
    const bigBody = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(65));
    const res = await h.draft({
      textBody: null,
      bodyValues: null,
      bodyStructure: { blobId: bigBody, type: "text/plain" },
    });
    expect(res.notCreated.d!.type).toBe("tooLarge");
  });

  it("re-uses the FileNode when the same file is sent twice, but mints a fresh link", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1).fill(8));
    ok(await h.draft({ attachments: [{ blobId: big, name: "deck.key" }] }));
    ok(await h.draft({ attachments: [{ blobId: big, name: "deck.key" }] }));

    // One folder, ONE file — content addressing makes the resend the same
    // object, so no "deck (2).key" appears.
    const nodes = await h.fileNodes();
    expect(nodes.map((n) => n.name).sort()).toEqual(["Sent attachments", "deck.key"]);

    // But each message got its own revocable link.
    const records = await listShareRecords(h.w.env.ROUTES, ACCOUNT);
    expect(records).toHaveLength(2);
    expect(records[0]!.shareId).not.toBe(records[1]!.shareId);
  });

  it("uniques colliding names inside one send", async () => {
    const h = harness();
    const a = await h.seedBlob(new Uint8Array(HALF_PLUS).fill(11));
    const b = await h.seedBlob(new Uint8Array(HALF_PLUS).fill(12));
    const created = ok(
      await h.draft({
        attachments: [
          { blobId: a, name: "photo.jpg" },
          { blobId: b, name: "photo.jpg" },
        ],
      }),
    );
    const nodes = await h.fileNodes();
    const names = nodes.filter((n) => n.nodeType === "file").map((n) => n.name);
    expect(names.sort()).toEqual(["photo (2).jpg", "photo.jpg"]);
    const text = await h.bodyText(created.id as string);
    expect(text).toContain("photo.jpg");
    expect(text).toContain("photo (2).jpg");
  });
});
