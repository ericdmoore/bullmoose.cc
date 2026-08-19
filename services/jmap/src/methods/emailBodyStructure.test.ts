import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import { mintToken } from "@bullmoose/auth-core";
import worker, { type Env } from "../index";
import { registerEmailMethods } from "./email";
import { registerSubmissionMethods } from "./submission";
import type { RequestContext } from "./common";

// The `bodyStructure` create form (RFC 8621 §4.6) on `Email/set`.
//
// §4.6 gives a client TWO ways to hand over a body on create: the simple
// textBody/htmlBody + bodyValues form (our webmail, CLI and agent), and a
// client-authored bodyStructure tree + bodyValues — the form IMAP-heritage
// clients like Mailtemi send. `createDraft` used to read ONLY the first form,
// so a Mailtemi message arrived at Gmail with a cryptographically empty body:
// both DKIM bh= values on the received copy hashed the empty canonicalized
// body. The subject survived; the body never existed on the wire.
//
// What must stay true forever after:
//
//   1. bodyStructure content reaches the STORED BLOB — the exact bytes the
//      submission relay is handed — and therefore the wire.
//   2. Body content never silently vanishes. A shape we cannot mail
//      faithfully refuses BY NAME; the only empty body that goes out is one
//      the client explicitly wrote.
//   3. A blobId leaf inside bodyStructure passes the same ownership boundary
//      as the `attachments` property: a foreign blob is indistinguishable
//      from a nonexistent one.
//   4. Where a blobId leaf LANDS is decided by disposition and tree
//      position, never by the fact that its bytes were uploaded. §4.6 lets a
//      body leaf carry its content by blobId — Mailtemi uploads its body
//      parts and references them exactly so — and routing every blobId leaf
//      to the attachment bucket put a real message on the wire as
//      multipart/mixed with an EMPTY inline text part and its actual body
//      behind two Content-Disposition: attachment parts ("Mail
//      Attachment.txt"/".html" in Apple Mail, no body at all; 2026-08-19).
//
// Harness is @bullmoose/test-fakes (sVOL 002): real SQLite on the live
// schema, real R2 key semantics, the real AccountDO, and a recording SUBMIT
// binding — so the submission leg proves which blobId was relayed.

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
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: "eric@login.example", displayName: "Eric" });
  w.db.seed("identities", [{ account_id: ACCOUNT, id: "id_1", email: "eric@bullmoose.cc", name: "Eric" }]);

  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);
  registerSubmissionMethods(registry);

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@login.example",
      scopes: ["mail"],
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

  /** An Email/set create carrying whatever body form the test supplies. */
  const draft = (body: Record<string, unknown>) =>
    call<SetResult>("Email/set", {
      accountId: ACCOUNT,
      create: {
        d: {
          mailboxIds: { [MAILBOX]: true },
          keywords: { $draft: true },
          from: [{ email: "eric@bullmoose.cc" }],
          to: [{ email: "someone@example.com" }],
          subject: "hello",
          ...body,
        },
      },
    });

  /** The raw RFC 5322 bytes of a created draft — what the relay would send. */
  const rawOf = async (created: Record<string, unknown>) => {
    const obj = await store.getBlob(TENANT, ACCOUNT, created.blobId as string);
    return new TextDecoder().decode(await obj!.arrayBuffer());
  };

  const submit = (emailId: string) =>
    call<{ created: Record<string, Record<string, unknown>>; notCreated: Record<string, SetError> }>(
      "EmailSubmission/set",
      { accountId: ACCOUNT, create: { s: { emailId, identityId: "id_1" } } },
    );

  return { w, store, call, seedBlob, draft, rawOf, submit };
}

const ok = (res: SetResult) => {
  if (!res.created.d) throw new Error(`create failed: ${JSON.stringify(res.notCreated)}`);
  return res.created.d;
};

const refused = (res: SetResult) => {
  if (res.created.d) throw new Error("expected a refusal, but the create succeeded");
  return res.notCreated.d!;
};

// ---- the wire evidence, replayed -------------------------------------------

describe("the Mailtemi create form: bodyStructure + bodyValues", () => {
  it("carries the body onto the stored blob AND out through the submission relay", async () => {
    const h = harness();
    // Reconstructed from the 2026-08-19 incident: a single text/plain leaf
    // whose content rides in bodyValues — the create our server used to
    // flatten to a headers-only message.
    const BODY = "Hi from Mailtemi. This text MUST reach the wire.";
    const created = ok(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "1" },
        bodyValues: { "1": { value: BODY } },
      }),
    );

    // The stored blob — the exact bytes EmailSubmission relays — has a body.
    const raw = await h.rawOf(created);
    const [headers = "", ...bodyParts] = raw.split("\r\n\r\n");
    expect(headers).toContain("Subject: hello");
    // The DKIM-relevant assertion: the canonicalized body is NOT empty.
    expect(bodyParts.join("\r\n\r\n").trim()).not.toBe("");
    // Base64 of the full body fits one 76-column line, so it appears verbatim.
    expect(raw).toContain(btoa(BODY));
    const parsed = await PostalMime.parse(raw);
    expect(parsed.text).toContain(BODY);

    // The submission leg: the relay is handed THIS blobId, whose bytes were
    // just proven to carry the body.
    const sub = await h.submit(created.id as string);
    expect(sub.created.s).toBeTruthy();
    expect(h.w.submit.bodies).toHaveLength(1);
    expect(h.w.submit.bodies[0]!.blobId).toBe(created.blobId);
    expect(h.w.submit.calls[0]).toEqual({
      mailFrom: "eric@bullmoose.cc",
      rcptTo: ["someone@example.com"],
    });
  });

  it("maps a full IMAP-heritage tree: mixed › related › alternative + cid + attachment", async () => {
    const h = harness();
    const png = await h.seedBlob("PNG-BYTES");
    const pdf = await h.seedBlob("%PDF-1.7 fake");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            {
              type: "multipart/related",
              subParts: [
                {
                  type: "multipart/alternative",
                  subParts: [
                    { type: "text/plain", partId: "t" },
                    { type: "text/html", partId: "h" },
                  ],
                },
                { type: "image/png", blobId: png, cid: "img1", disposition: "inline" },
              ],
            },
            { type: "application/pdf", blobId: pdf, name: "doc.pdf", disposition: "attachment" },
          ],
        },
        bodyValues: {
          t: { value: "plain words" },
          h: { value: '<p>rich words <img src="cid:img1"></p>' },
        },
      }),
    );

    const raw = await h.rawOf(created);
    const parsed = await PostalMime.parse(raw);
    expect(parsed.text).toContain("plain words");
    expect(parsed.html).toContain("rich words");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("multipart/related");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Content-ID: <img1>");
    expect(raw).toContain('filename="doc.pdf"');

    // Stored metadata follows the same rules as the `attachments` property:
    // the paperclip is decided by disposition, and both parts round-trip.
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(true);
    expect(row!.attachments.map((a) => a.type).sort()).toEqual(["application/pdf", "image/png"]);
  });

  it("respects charset on a blobId text leaf — wire header only, bare type in meta", async () => {
    const h = harness();
    const txt = await h.seedBlob("hola");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { type: "text/plain", partId: "t" },
            { type: "text/plain", charset: "iso-8859-1", blobId: txt, name: "n.txt", disposition: "attachment" },
          ],
        },
        bodyValues: { t: { value: "see attached" } },
      }),
    );
    const raw = await h.rawOf(created);
    // The blob's bytes pass through verbatim, so the client's charset is real
    // information — it rides the part's Content-Type…
    expect(raw).toContain("Content-Type: text/plain; charset=iso-8859-1");
    // …but JMAP's `type` is the bare media type, so meta stays parameter-free.
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.attachments[0]!.type).toBe("text/plain");
  });

  it("flattens sequential text parts in document order — content is never dropped", async () => {
    const h = harness();
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { type: "text/plain", partId: "a" },
            { type: "text/plain", partId: "b" },
          ],
        },
        bodyValues: { a: { value: "FIRST-PART" }, b: { value: "SECOND-PART" } },
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    const first = parsed.text!.indexOf("FIRST-PART");
    const second = parsed.text!.indexOf("SECOND-PART");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it("defaults an untyped partId leaf to text/plain, and indexes the body for search", async () => {
    const h = harness();
    const created = ok(
      await h.draft({
        bodyStructure: { partId: "1" },
        bodyValues: { "1": { value: "zanzibar quill" } },
      }),
    );
    expect((await h.rawOf(created)).length).toBeGreaterThan(0);
    const q = await h.call<{ ids: string[] }>("Email/query", {
      accountId: ACCOUNT,
      filter: { text: "zanzibar" },
    });
    expect(q.ids).toContain(created.id);
  });

  it("still allows an EXPLICITLY empty body — that is the client's right", async () => {
    const h = harness();
    const created = ok(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "1" },
        bodyValues: { "1": { value: "" } },
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    expect(parsed.text ?? "").toBe("");
  });
});

// ---- refusals: nothing silently vanishes -----------------------------------

describe("shapes that cannot be mailed faithfully refuse by name", () => {
  it("refuses bodyStructure alongside textBody/htmlBody, naming the conflict", async () => {
    const h = harness();
    const err = refused(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "1" },
        textBody: [{ partId: "t" }],
        bodyValues: { "1": { value: "a" }, t: { value: "b" } },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure", "textBody"]);
    expect(err.description).toContain("mutually exclusive");
  });

  it("tolerates vestigial EMPTY lists next to bodyStructure — no content, no conflict", async () => {
    const h = harness();
    const created = ok(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "1" },
        bodyValues: { "1": { value: "still mailed" } },
        textBody: [],
        attachments: [],
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    expect(parsed.text).toContain("still mailed");
  });

  it("refuses a dangling partId in bodyStructure — the empty-body bug, named", async () => {
    const h = harness();
    const err = refused(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "ghost" },
        bodyValues: {},
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/partId", "bodyValues/ghost"]);
  });

  it("refuses a dangling partId in textBody too — the OLD form silently mailed empty", async () => {
    const h = harness();
    const err = refused(await h.draft({ textBody: [{ partId: "nope" }], bodyValues: {} }));
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["textBody/0/partId", "bodyValues/nope"]);
  });

  it("refuses bodyValues that nothing references — supplied content may not vanish", async () => {
    const h = harness();
    const err = refused(await h.draft({ bodyValues: { t: { value: "I would have been lost" } } }));
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyValues"]);
    expect(err.description).toContain("empty body");
  });

  it("still allows a create with NO body properties at all — RFC 5322 bodies are optional", async () => {
    const h = harness();
    const created = ok(await h.draft({}));
    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-Type: text/plain");
  });

  it("refuses a partId leaf of a type bodyValues cannot faithfully become", async () => {
    const h = harness();
    const err = refused(
      await h.draft({
        bodyStructure: { type: "text/markdown", partId: "m" },
        bodyValues: { m: { value: "# heading" } },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/type"]);
    expect(err.description).toContain("text/markdown");
  });

  it("refuses partId AND blobId on one leaf", async () => {
    const h = harness();
    const blob = await h.seedBlob("bytes");
    const err = refused(
      await h.draft({
        bodyStructure: { type: "text/plain", partId: "1", blobId: blob },
        bodyValues: { "1": { value: "x" } },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/partId", "bodyStructure/blobId"]);
  });

  it("refuses a leaf with neither partId nor blobId", async () => {
    const h = harness();
    const err = refused(await h.draft({ bodyStructure: { type: "text/plain" } }));
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure"]);
  });

  it("refuses a multipart without subParts", async () => {
    const h = harness();
    const err = refused(await h.draft({ bodyStructure: { type: "multipart/mixed", subParts: [] } }));
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/subParts"]);
  });

  it("refuses partId content posing as an attachment", async () => {
    const h = harness();
    const err = refused(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { type: "text/plain", partId: "t" },
            { type: "text/plain", partId: "f", name: "note.txt", disposition: "attachment" },
          ],
        },
        bodyValues: { t: { value: "body" }, f: { value: "file contents" } },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/subParts/1/disposition"]);
  });

  it("refuses a tree nested past any honest mail shape", async () => {
    const h = harness();
    let node: Record<string, unknown> = { type: "text/plain", partId: "t" };
    for (let i = 0; i < 10; i++) node = { type: "multipart/mixed", subParts: [node] };
    const err = refused(await h.draft({ bodyStructure: node, bodyValues: { t: { value: "deep" } } }));
    expect(err.type).toBe("invalidProperties");
    expect(err.description).toContain("deeper");
  });

  it("refuses two parts in textBody instead of silently mailing only the first", async () => {
    const h = harness();
    const err = refused(
      await h.draft({
        textBody: [{ partId: "a" }, { partId: "b" }],
        bodyValues: { a: { value: "kept" }, b: { value: "previously dropped" } },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["textBody"]);
  });
});

// ---- the authorization boundary holds inside the tree ----------------------

describe("blobId leaves inside bodyStructure cross the same ownership boundary", () => {
  it("a foreign blob is indistinguishable from a nonexistent one, and nothing lands", async () => {
    const h = harness();
    const secret = "ALLEN-PRIVATE-LEDGER";
    const victimBlob = await h.seedBlob(secret, VICTIM);
    const res = await h.draft({
      bodyStructure: {
        type: "multipart/mixed",
        subParts: [
          { type: "text/plain", partId: "t" },
          { type: "application/pdf", blobId: victimBlob, name: "steal.pdf" },
        ],
      },
      bodyValues: { t: { value: "gimme" } },
    });
    expect(res.created).toEqual({});
    expect(res.notCreated.d!.type).toBe("blobNotFound");
    expect(res.notCreated.d!.properties).toEqual(["bodyStructure/subParts/1/blobId"]);
    const q = await h.call<{ ids: string[] }>("Email/query", { accountId: ACCOUNT });
    expect(q.ids).toEqual([]);
  });

  it("a size-ceiling breach blames bodyStructure, the property that carried the parts", async () => {
    const h = harness();
    const { MAX_ATTACHMENT_BYTES_PER_EMAIL } = await import("@bullmoose/jmap-core");
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1));
    const res = await h.draft({
      bodyStructure: {
        type: "multipart/mixed",
        subParts: [
          { type: "text/plain", partId: "t" },
          { blobId: big, name: "huge.bin" },
        ],
      },
      bodyValues: { t: { value: "body" } },
    });
    expect(res.notCreated.d!.type).toBe("tooLarge");
    expect(res.notCreated.d!.properties).toEqual(["bodyStructure"]);
  });
});

// ---- the webmail form is untouched -----------------------------------------

describe("the textBody/htmlBody form still works exactly as before", () => {
  it("webmail's shape — typed parts + bodyValues — round-trips", async () => {
    const h = harness();
    const created = ok(
      await h.draft({
        bodyValues: { t: { value: "plain" }, h: { value: "<b>rich</b>" } },
        textBody: [{ partId: "t", type: "text/plain" }],
        htmlBody: [{ partId: "h", type: "text/html" }],
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    expect(parsed.text).toContain("plain");
    expect(parsed.html).toContain("<b>rich</b>");
  });
});

// ---- body content by blobId: the upload-then-reference create --------------

/**
 * Upload through the REAL route (`POST /api/upload/{accountId}`, RFC 8620
 * §6.1) — worker entrypoint, bearer auth and all — so the blobId the test
 * references is the one Mailtemi would actually hold after its upload leg.
 */
async function uploadReal(h: ReturnType<typeof harness>, content: string, type: string): Promise<string> {
  const minted = await mintToken();
  h.w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: `p_${ACCOUNT}`, // seedAccount's default principal
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "upload",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(), // recent → no last_used write to add noise
    },
  ]);
  const res = await worker.fetch(
    new Request(`https://jmap.bullmoose.cc/api/upload/${ACCOUNT}`, {
      method: "POST",
      body: content,
      headers: { Authorization: `Bearer ${minted.token}`, "content-type": type },
    }),
    h.w.env as Env,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { blobId: string }).blobId;
}

describe("a blobId leaf with inline-or-absent disposition IS the body (the 2026-08-19 shape)", () => {
  it("mails Mailtemi's exact create as an inline body — alternative, zero attachment parts", async () => {
    const h = harness();
    const TEXT = "Hi from Mailtemi — this text must render INLINE.";
    const HTML = "<p>Hi from Mailtemi — this html must render <b>INLINE</b>.</p>";
    // The client's actual sequence: upload both body parts, then reference
    // them as typed, disposition-less blobId leaves.
    const txt = await uploadReal(h, TEXT, "text/plain");
    const htm = await uploadReal(h, HTML, "text/html");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/alternative",
          subParts: [
            { type: "text/plain", blobId: txt },
            { type: "text/html", blobId: htm },
          ],
        },
      }),
    );

    // What the wire carried before this rule: multipart/mixed, an empty
    // inline text part, and the real body as two attachment parts.
    const raw = await h.rawOf(created);
    expect(raw).toContain("multipart/alternative");
    expect(raw).not.toContain("multipart/mixed");
    expect(raw).not.toContain("Content-Disposition: attachment");
    const parsed = await PostalMime.parse(raw);
    expect((parsed.text ?? "").trim()).toBe(TEXT);
    expect(parsed.html).toContain("<b>INLINE</b>");
    expect(parsed.attachments).toHaveLength(0);

    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(false);
    expect(row!.attachments).toEqual([]);
  });

  it("concatenates a blob-carried text leaf with partId siblings in document order", async () => {
    const h = harness();
    const blob = await h.seedBlob("SECOND-FROM-BLOB");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { type: "text/plain", partId: "a" },
            { type: "text/plain", blobId: blob, disposition: "inline" },
          ],
        },
        bodyValues: { a: { value: "FIRST-FROM-BODYVALUES" } },
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    const first = parsed.text!.indexOf("FIRST-FROM-BODYVALUES");
    const second = parsed.text!.indexOf("SECOND-FROM-BLOB");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('keeps a text leaf with disposition: "attachment" an attachment — type does not decide', async () => {
    const h = harness();
    const blob = await h.seedBlob("meeting notes, as a FILE");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/mixed",
          subParts: [
            { type: "text/plain", partId: "t" },
            { type: "text/plain", blobId: blob, name: "notes.txt", disposition: "attachment" },
          ],
        },
        bodyValues: { t: { value: "see attached notes" } },
      }),
    );
    const raw = await h.rawOf(created);
    expect(raw).toContain("Content-Disposition: attachment");
    expect(raw).toContain('filename="notes.txt"');
    const parsed = await PostalMime.parse(raw);
    expect((parsed.text ?? "").trim()).toBe("see attached notes");
    expect(parsed.attachments).toHaveLength(1);
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.hasAttachment).toBe(true);
  });

  it("keeps a cid-referenced text leaf a related part — a cid is resolved from the HTML, not read as body", async () => {
    const h = harness();
    const blob = await h.seedBlob("snippet body");
    const created = ok(
      await h.draft({
        bodyStructure: {
          type: "multipart/related",
          subParts: [
            { type: "text/html", partId: "h" },
            { type: "text/plain", blobId: blob, cid: "frag1" },
          ],
        },
        bodyValues: { h: { value: '<p>see <a href="cid:frag1">fragment</a></p>' } },
      }),
    );
    const raw = await h.rawOf(created);
    expect(raw).toContain("multipart/related");
    expect(raw).toContain("Content-ID: <frag1>");
    // The meta round-trip is the proof of ROUTING: the part went through the
    // attachment bucket (a related part, cid + inline, no paperclip) — it was
    // not folded into the body buckets.
    const row = await h.store.getEmailRow(ACCOUNT, created.id as string);
    expect(row!.attachments.map((a) => ({ cid: a.cid, disposition: a.disposition }))).toEqual([
      { cid: "frag1", disposition: "inline" },
    ]);
    expect(row!.hasAttachment).toBe(false);
  });

  it("decodes an inline body blob per its declared charset — latin-1 in, faithful text out", async () => {
    const h = harness();
    // "café" in ISO-8859-1: é is the single byte 0xE9, which is NOT valid
    // UTF-8 — decoding this blob as the default charset would mojibake.
    const blob = await h.seedBlob(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    const created = ok(
      await h.draft({
        bodyStructure: { type: "text/plain", charset: "iso-8859-1", blobId: blob },
      }),
    );
    const parsed = await PostalMime.parse(await h.rawOf(created));
    expect((parsed.text ?? "").trim()).toBe("café");
  });

  it("refuses a charset it cannot decode by name, rather than mailing mojibake", async () => {
    const h = harness();
    const blob = await h.seedBlob("whatever");
    const err = refused(
      await h.draft({
        bodyStructure: { type: "text/plain", charset: "x-carrier-pigeon", blobId: blob },
      }),
    );
    expect(err.type).toBe("invalidProperties");
    expect(err.properties).toEqual(["bodyStructure/charset"]);
    expect(err.description).toContain("x-carrier-pigeon");
  });

  it("an inline body blob crosses the same ownership boundary — foreign is nonexistent", async () => {
    const h = harness();
    const victimBlob = await h.seedBlob("ALLEN-PRIVATE-BODY", VICTIM);
    const res = await h.draft({
      bodyStructure: { type: "text/plain", blobId: victimBlob },
    });
    expect(res.created).toEqual({});
    expect(res.notCreated.d!.type).toBe("blobNotFound");
    expect(res.notCreated.d!.properties).toEqual(["bodyStructure/blobId"]);
  });

  it("an inline body blob counts against the same size ceiling as attachments", async () => {
    const h = harness();
    const { MAX_ATTACHMENT_BYTES_PER_EMAIL } = await import("@bullmoose/jmap-core");
    const big = await h.seedBlob(new Uint8Array(MAX_ATTACHMENT_BYTES_PER_EMAIL + 1));
    const res = await h.draft({
      bodyStructure: { type: "text/plain", blobId: big },
    });
    expect(res.notCreated.d!.type).toBe("tooLarge");
    expect(res.notCreated.d!.properties).toEqual(["bodyStructure"]);
  });
});
