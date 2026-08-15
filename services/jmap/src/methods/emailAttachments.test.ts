import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { MAX_ATTACHMENT_BYTES_PER_EMAIL, MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerEmailMethods } from "./email";
import type { RequestContext } from "./common";

// Attachments on `Email/set create` (RFC 8621 §4.1.4 / §4.6).
//
// Until this landed, `createDraft` wrote `hasAttachment: false, attachments: []`
// unconditionally: a draft composed over JMAP could not carry a file at all.
// Two things about the fix need proving over and over:
//
//   1. A `blobId` is CLIENT-SUPPLIED. Attaching someone else's blob would make
//      Email/set a cross-account read primitive — compose a draft citing the
//      victim's blobId, read the victim's file out of the message you own.
//   2. `hasAttachment` follows the INBOUND convention (`importOne`, ingest):
//      disposition decides, so a cid image the HTML displays does not raise a
//      paperclip on a message with no real attachment.
//
// Harness is @bullmoose/test-fakes (sVOL 002): real SQLite on the live schema,
// real R2 semantics for blob keys — which matters more here than usual, since
// the account scoping of an R2 key IS the authorization boundary under test.

const ACCOUNT = "a_eric";
const VICTIM = "a_allen";
const TENANT = "t_bm";
const MAILBOX = "mb_drafts";

type SetError = { type: string; description?: string; properties?: string[] };
type SetResult = {
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, SetError>;
};

function harness() {
  const w = fakeEnv();
  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["read", "draft"],
      // The victim's account is deliberately NOT on this principal: the
      // attacker cannot name it as `accountId`, which is exactly why they
      // would try to reach it through a blobId instead.
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;

  const seedBlob = (content: string | Uint8Array, account = ACCOUNT) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return store.putBlob(
      TENANT,
      account,
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
          subject: "hello",
          textBody: [{ partId: "t" }],
          bodyValues: { t: { value: "see attached" } },
          ...spec,
        },
      },
    });

  /** The raw RFC 5322 bytes of a created draft. */
  const rawOf = async (created: Record<string, unknown>) => {
    const obj = await store.getBlob(TENANT, ACCOUNT, created.blobId as string);
    return new TextDecoder().decode(await obj!.arrayBuffer());
  };

  const get = (id: string) =>
    call<{ list: Array<Record<string, unknown>> }>("Email/get", {
      accountId: ACCOUNT,
      ids: [id],
    });

  return { w, ctx, store, call, seedBlob, draft, rawOf, get };
}

const ok = (res: SetResult) => {
  if (!res.created.d) throw new Error(`create failed: ${JSON.stringify(res.notCreated)}`);
  return res.created.d;
};

// ---- the no-attachment path must not move ---------------------------------

describe("a draft with no attachments is unchanged", () => {
  it("emits byte-identical MIME to a draft created before attachments existed", async () => {
    const h = harness();
    const created = ok(await h.draft({}));
    const raw = await h.rawOf(created);

    // Everything but Date/Message-ID, which are generated per call.
    expect(raw.split("\r\n").filter((l) => !/^(Date|Message-ID):/.test(l))).toEqual([
      "From: eric@bullmoose.cc",
      "To: someone@example.com",
      "Subject: hello",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "c2VlIGF0dGFjaGVk",
    ]);
    expect(raw).not.toContain("multipart");
  });

  it("still stores hasAttachment false and an empty attachments list", async () => {
    const h = harness();
    const created = ok(await h.draft({}));
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(false);
    expect(row!.attachments).toEqual([]);
  });
});

// ---- the security boundary ------------------------------------------------

describe("blob ownership is the authorization boundary on create", () => {
  it("REFUSES a blobId owned by another account — the cross-account read primitive", async () => {
    // The attack, end to end: Allen has a private file. Eric knows (or
    // guesses, or was once told) its blobId. If Email/set resolved that id
    // without scoping the lookup to Eric's account, Eric would compose a draft
    // citing it and then read Allen's bytes straight out of his own message.
    const h = harness();
    const secret = "ALLEN-PRIVATE-SALARY-REVIEW";
    const victimBlob = await h.seedBlob(secret, VICTIM);

    const res = await h.draft({
      attachments: [{ blobId: victimBlob, type: "text/plain", name: "steal.txt" }],
    });

    // Refused — and refused with a type that says why, not a silent skip.
    expect(res.created).toEqual({});
    expect(res.notCreated.d!.type).toBe("blobNotFound");
    expect(res.notCreated.d!.properties).toEqual(["attachments/0/blobId"]);

    // And nothing landed: no draft row, and the secret exists nowhere in
    // ERIC's blob namespace — which is the only place he can read from.
    const q = await h.call<{ ids: string[] }>("Email/query", { accountId: ACCOUNT });
    expect(q.ids).toEqual([]);
    const ericsBytes = [...h.w.blobs.objects.values()]
      .filter((o) => o.key.startsWith(`mail/${TENANT}/${ACCOUNT}/`))
      .map((o) => new TextDecoder().decode(o.body));
    expect(ericsBytes.some((b) => b.includes(secret))).toBe(false);
    // The victim's own copy is of course still there — that is the point.
    expect(h.w.blobs.objects.get(`mail/${TENANT}/${VICTIM}/blobs/${victimBlob}`)).toBeDefined();
  });

  it("refuses a blobId that exists nowhere at all", async () => {
    const h = harness();
    const res = await h.draft({ attachments: [{ blobId: "b_nonexistent" }] });
    expect(res.notCreated.d!.type).toBe("blobNotFound");
  });

  it("refuses the WHOLE draft when one of several blobs is not ours", async () => {
    // The dangerous near-miss: dropping the bad part and sending the rest
    // leaves a user certain they attached a document they did not attach.
    const h = harness();
    const mine = await h.seedBlob("mine");
    const theirs = await h.seedBlob("theirs", VICTIM);
    const res = await h.draft({
      attachments: [{ blobId: mine }, { blobId: theirs }, { blobId: mine }],
    });
    expect(res.created).toEqual({});
    expect(res.notCreated.d!.type).toBe("blobNotFound");
    expect(res.notCreated.d!.properties).toEqual(["attachments/1/blobId"]);
  });

  it("still allows identical bytes the caller happens to hold a copy of", async () => {
    // putBlob is content-addressed, so two accounts holding the same bytes
    // share a blobId under two different R2 keys. Refusing that would be a
    // false positive: the caller is reading their OWN copy.
    const h = harness();
    const shared = "a public press release";
    await h.seedBlob(shared, VICTIM);
    const mine = await h.seedBlob(shared, ACCOUNT);
    const created = ok(await h.draft({ attachments: [{ blobId: mine, name: "pr.txt" }] }));
    expect(await h.rawOf(created)).toContain(btoa(shared));
  });
});

// ---- the size ceiling -----------------------------------------------------

describe("attachments are bounded before any bytes are loaded", () => {
  it("refuses with tooLarge when the total exceeds the advertised ceiling", async () => {
    const h = harness();
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1));
    const res = await h.draft({ attachments: [{ blobId: big, name: "huge.bin" }] });

    expect(res.created).toEqual({});
    // `tooLarge` and not `invalidProperties`: only this one is fixed by
    // attaching a smaller file, and the CLI maps it to a distinct exit code.
    expect(res.notCreated.d!.type).toBe("tooLarge");
    expect(res.notCreated.d!.properties).toEqual(["attachments"]);
  });

  it("sums across parts, so many small files cannot walk past the ceiling", async () => {
    const h = harness();
    const half = Math.ceil(MAX_ATTACHMENT_BYTES_PER_EMAIL / 2) + 1;
    const a = await h.seedBlob(new Uint8Array(half).fill(1));
    const b = await h.seedBlob(new Uint8Array(half).fill(2));
    const res = await h.draft({ attachments: [{ blobId: a }, { blobId: b }] });
    expect(res.notCreated.d!.type).toBe("tooLarge");
  });

  it("counts a repeated blobId once per occurrence — it is encoded twice", async () => {
    const h = harness();
    const half = Math.ceil(MAX_ATTACHMENT_BYTES_PER_EMAIL / 2) + 1;
    const one = await h.seedBlob(new Uint8Array(half).fill(3));
    const res = await h.draft({ attachments: [{ blobId: one }, { blobId: one }] });
    expect(res.notCreated.d!.type).toBe("tooLarge");
  });

  it("accepts a file right up to the ceiling", async () => {
    const h = harness();
    const atLimit = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL).fill(7));
    const created = ok(await h.draft({ attachments: [{ blobId: atLimit, name: "exact.bin" }] }));
    expect(created.id).toBeTruthy();
  });
});

// ---- structure + metadata -------------------------------------------------

describe("what the created message actually looks like", () => {
  it("wraps the body in multipart/mixed for one attachment", async () => {
    const h = harness();
    const blobId = await h.seedBlob("PDF-BYTES");
    const created = ok(
      await h.draft({
        attachments: [{ blobId, type: "application/pdf", name: "report.pdf" }],
      }),
    );
    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain("Content-Type: application/pdf");
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(raw).toContain(btoa("PDF-BYTES"));
  });

  it("carries several attachments in one message", async () => {
    const h = harness();
    const a = await h.seedBlob("AAA");
    const b = await h.seedBlob("BBB");
    const c = await h.seedBlob("CCC");
    const created = ok(
      await h.draft({
        attachments: [
          { blobId: a, type: "text/csv", name: "a.csv" },
          { blobId: b, type: "text/csv", name: "b.csv" },
          { blobId: c, type: "text/csv", name: "c.csv" },
        ],
      }),
    );
    const raw = await h.rawOf(created);
    for (const s of ["AAA", "BBB", "CCC"]) expect(raw).toContain(btoa(s));
    expect(raw.match(/^Content-Disposition: attachment;/gm)).toHaveLength(3);

    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.attachments.map((x) => x.name)).toEqual(["a.csv", "b.csv", "c.csv"]);
    expect(row!.hasAttachment).toBe(true);
  });

  it("puts a cid part in multipart/related and does NOT set hasAttachment", async () => {
    // The paperclip rule, matching the inbound path: an inline image the HTML
    // displays is not "an attachment" as a user means it.
    const h = harness();
    const blobId = await h.seedBlob("PNGDATA");
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "h" }],
        bodyValues: { h: { value: '<img src="cid:logo@bm">' } },
        textBody: undefined,
        attachments: [
          {
            blobId,
            type: "image/png",
            name: "logo.png",
            cid: "logo@bm",
            disposition: "inline",
          },
        ],
      }),
    );

    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-Type: multipart/related;");
    expect(raw).not.toContain("multipart/mixed");
    expect(raw).toContain("Content-ID: <logo@bm>");

    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(false);
    expect(row!.attachments).toHaveLength(1);
    expect(row!.attachments[0]!.disposition).toBe("inline");
  });

  it("sets hasAttachment when an inline image rides ALONGSIDE a real attachment", async () => {
    const h = harness();
    const logo = await h.seedBlob("PNGDATA");
    const pdf = await h.seedBlob("PDFDATA");
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "h" }],
        bodyValues: { h: { value: '<img src="cid:logo@bm">' } },
        textBody: undefined,
        attachments: [
          { blobId: logo, type: "image/png", name: "logo.png", cid: "logo@bm" },
          { blobId: pdf, type: "application/pdf", name: "report.pdf" },
        ],
      }),
    );

    const raw = await h.rawOf(created);
    // mixed OUTSIDE related: the top-level Content-Type is the mixed one.
    const topType = raw.split("\r\n").find((l) => l.startsWith("Content-Type:"));
    expect(topType).toMatch(/^Content-Type: multipart\/mixed;/);
    expect(raw).toContain("Content-Type: multipart/related;");

    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(true);
    expect(row!.attachments.map((a) => a.disposition)).toEqual(["inline", "attachment"]);
  });

  it("counts the attachment bytes in the reported size", async () => {
    const h = harness();
    const blobId = await h.seedBlob("x".repeat(3000));
    const bare = ok(await h.draft({}));
    const withFile = ok(await h.draft({ attachments: [{ blobId, name: "x.txt" }] }));
    expect(withFile.size as number).toBeGreaterThan((bare.size as number) + 3000);
  });
});

// ---- Email/get round trip -------------------------------------------------

describe("Email/get round-trips what Email/set created", () => {
  it("returns the attachments a create supplied, as EmailBodyParts", async () => {
    const h = harness();
    const blobId = await h.seedBlob("REPORT");
    const created = ok(
      await h.draft({
        attachments: [
          { blobId, type: "application/pdf", name: "q3.pdf", disposition: "attachment" },
        ],
      }),
    );

    const res = await h.get(created.id as string);
    const email = res.list[0]!;
    expect(email.hasAttachment).toBe(true);
    expect(email.attachments).toEqual([
      {
        partId: null,
        blobId,
        size: 6,
        name: "q3.pdf",
        type: "application/pdf",
        cid: null,
        disposition: "attachment",
        fileNodeId: null,
      },
    ]);
  });

  it("round-trips the cid and inline disposition of an embedded image", async () => {
    const h = harness();
    const blobId = await h.seedBlob("PNG");
    const created = ok(
      await h.draft({
        attachments: [{ blobId, type: "image/png", name: "logo.png", cid: "logo@bm" }],
      }),
    );
    const email = (await h.get(created.id as string)).list[0]!;
    expect(email.hasAttachment).toBe(false);
    expect(email.attachments).toMatchObject([
      { blobId, cid: "logo@bm", disposition: "inline", type: "image/png" },
    ]);
  });

  it("defaults an omitted type to application/octet-stream and name to null", async () => {
    const h = harness();
    const blobId = await h.seedBlob("bytes");
    const created = ok(await h.draft({ attachments: [{ blobId }] }));
    const email = (await h.get(created.id as string)).list[0]!;
    expect(email.attachments).toMatchObject([
      { type: "application/octet-stream", name: null, cid: null, disposition: "attachment" },
    ]);
  });
});

// ---- the bytes are real MIME, not a string that looks like it ------------

describe("the emitted message survives a real parser", () => {
  it("round-trips through postal-mime with body, inline image and file intact", async () => {
    // Every assertion above matches strings we produced. This one hands the
    // bytes to the SAME parser the inbound path uses, so a subtly malformed
    // boundary or a mis-encoded part cannot pass: a broken container parses
    // as zero attachments, not as an error.
    const h = harness();
    const logo = await h.seedBlob("PNGDATA");
    const pdf = await h.seedBlob("PDFDATA");
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "h" }],
        bodyValues: { h: { value: '<p>hi</p><img src="cid:logo@bm">' } },
        textBody: undefined,
        attachments: [
          { blobId: logo, type: "image/png", name: "logo.png", cid: "logo@bm" },
          { blobId: pdf, type: "application/pdf", name: "report.pdf" },
        ],
      }),
    );

    const obj = await h.store.getBlob(TENANT, ACCOUNT, created.blobId as string);
    const parsed = await PostalMime.parse(await obj!.arrayBuffer());

    expect(parsed.subject).toBe("hello");
    expect(parsed.html).toContain('<img src="cid:logo@bm">');
    expect(parsed.attachments).toHaveLength(2);

    const byName = new Map(parsed.attachments.map((a) => [a.filename, a]));
    const png = byName.get("logo.png")!;
    expect(png.mimeType).toBe("image/png");
    expect(png.disposition).toBe("inline");
    expect(png.contentId).toBe("<logo@bm>");
    expect(new TextDecoder().decode(png.content as ArrayBuffer)).toBe("PNGDATA");

    const doc = byName.get("report.pdf")!;
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.disposition).toBe("attachment");
    expect(new TextDecoder().decode(doc.content as ArrayBuffer)).toBe("PDFDATA");

    // The parse-side rule that decides the paperclip agrees with what we stored.
    expect(parsed.attachments.some((a) => a.disposition !== "inline")).toBe(true);
  });

  it("re-importing the draft reproduces the same hasAttachment verdict", async () => {
    // Email/import derives hasAttachment by parsing. Create and import are two
    // implementations of one rule, so they must not disagree about a message
    // that carries only an inline image.
    const h = harness();
    const logo = await h.seedBlob("PNGDATA");
    const created = ok(
      await h.draft({
        htmlBody: [{ partId: "h" }],
        bodyValues: { h: { value: '<img src="cid:logo@bm">' } },
        textBody: undefined,
        attachments: [{ blobId: logo, type: "image/png", name: "logo.png", cid: "logo@bm" }],
      }),
    );

    const imported = await h.call<{
      created: Record<string, { id: string }>;
      notCreated: Record<string, SetError>;
    }>("Email/import", {
      accountId: ACCOUNT,
      emails: { i: { blobId: created.blobId, mailboxIds: { [MAILBOX]: true } } },
    });
    const importedId = imported.created.i!.id;

    const before = await h.store.getEmailRow(ACCOUNT, created.id as string);
    const after = await h.store.getEmailRow(ACCOUNT, importedId);
    expect(after!.hasAttachment).toBe(before!.hasAttachment);
    expect(after!.hasAttachment).toBe(false);
  });
});

// ---- argument validation --------------------------------------------------

describe("malformed attachments are rejected as invalidProperties", () => {
  it("rejects a non-array", async () => {
    const h = harness();
    const res = await h.draft({ attachments: { blobId: "b_x" } });
    expect(res.notCreated.d!.type).toBe("invalidProperties");
    expect(res.notCreated.d!.properties).toEqual(["attachments"]);
  });

  it("rejects a part with no blobId", async () => {
    const h = harness();
    const res = await h.draft({ attachments: [{ type: "text/plain" }] });
    expect(res.notCreated.d!.type).toBe("invalidProperties");
    expect(res.notCreated.d!.properties).toEqual(["attachments/0/blobId"]);
  });

  it("rejects a non-string name rather than stringifying it into a header", async () => {
    const h = harness();
    const blobId = await h.seedBlob("x");
    const res = await h.draft({ attachments: [{ blobId, name: { evil: true } }] });
    expect(res.notCreated.d!.type).toBe("invalidProperties");
    expect(res.notCreated.d!.properties).toEqual(["attachments/0/name"]);
  });

  it("treats a null attachments property as no attachments", async () => {
    const h = harness();
    const created = ok(await h.draft({ attachments: null }));
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(false);
  });
});
