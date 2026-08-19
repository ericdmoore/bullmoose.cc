import { describe, expect, it } from "vitest";
import { mintToken } from "@bullmoose/auth-core";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv } from "@bullmoose/test-fakes";
import worker, { type Env } from "./index";
import { registerEmailMethods } from "./methods/email";
import type { RequestContext } from "./methods/common";

// Part-addressed blob downloads (`<rawBlobId>~<partId>`, blobParts.ts).
//
// The bug this file keeps dead, observed live in production: Mailtemi ignores
// `bodyValues` entirely — it walks `bodyStructure`/`textBody`/`htmlBody` and
// downloads every part by `blobId` through the session's download template.
// PR #230's text/html leaves carried `blobId: null`, the client filled the
// template with the literal string "null" (`GET /api/download/<acct>/null/…`),
// and every message body spun forever while subjects and previews rendered.
//
// So these tests drive the WORKER ENTRYPOINT (`worker.fetch`) for the
// download half — the exact door Mailtemi knocks on — and the real Email
// methods for the JMAP half, over @bullmoose/test-fakes.

const TENANT = "t_bm";
const ACCOUNT = "a_eric";

/** text + html alternative with a real attachment — the everyday shape.
 *  The text carries non-ASCII so the charset pin is load-bearing, not décor. */
const MULTIPART_RAW = [
  'From: "Sender" <sender@example.com>',
  "To: eric@bullmoose.cc",
  "Subject: part download fixture",
  "Message-ID: <part-dl-1@example.com>",
  "Date: Wed, 19 Aug 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Héllo — the plain-text bödy, ünïcode and all.",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Héllo <b>hätml</b> — ünïcode too.</p>",
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

const TEXT_ONLY_RAW = [
  "From: sender@example.com",
  "To: eric@bullmoose.cc",
  "Subject: text only",
  "Date: Wed, 19 Aug 2026 12:00:00 +0000",
  "",
  "just text",
  "",
].join("\r\n");

type Part = {
  partId: string | null;
  blobId: string | null;
  type: string;
  name: string | null;
  subParts?: Part[];
};

interface Harness {
  env: Env;
  store: Mailstore;
  /** Store raw RFC 5322 bytes and import them the way ingest would. */
  importRaw(raw: string): Promise<{ id: string; rawBlobId: string }>;
  /** Email/get through the real method registry. */
  get(args: Record<string, unknown>): Promise<{ list: Array<Record<string, unknown>> }>;
  /** Authenticated GET of a download path, through the real worker entrypoint. */
  download(path: string): Promise<Response>;
  /** The same GET with no credential at all. */
  downloadAnon(path: string): Promise<Response>;
}

async function harness(): Promise<Harness> {
  const minted = await mintToken();
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
  });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(["mail"]),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  const env = w.env as Env;

  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: ["read", "draft"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, ctx) as Promise<T>;

  const store = new Mailstore(w.env.DB, w.env.BLOBS);

  return {
    env,
    store,
    importRaw: async (raw) => {
      const bytes = new TextEncoder().encode(raw);
      const rawBlobId = await store.putBlob(
        TENANT,
        ACCOUNT,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      const res = await call<{ created: Record<string, { id: string }>; notCreated: Record<string, unknown> }>(
        "Email/import",
        { accountId: ACCOUNT, emails: { m: { blobId: rawBlobId, mailboxIds: { mb_inbox: true } } } },
      );
      if (!res.created.m) throw new Error(`import failed: ${JSON.stringify(res.notCreated)}`);
      return { id: res.created.m.id, rawBlobId };
    },
    get: (args) => call<{ list: Array<Record<string, unknown>> }>("Email/get", { accountId: ACCOUNT, ...args }),
    download: (path) =>
      worker.fetch(
        new Request(`https://jmap.bullmoose.cc${path}`, {
          headers: { Authorization: `Bearer ${minted.token}` },
        }),
        env,
      ),
    downloadAnon: (path) => worker.fetch(new Request(`https://jmap.bullmoose.cc${path}`), env),
  };
}

function leaves(part: Part): Part[] {
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

const MISSING = `b_${"0".repeat(64)}`;

// ---------------------------------------------------------------------------

describe("the round trip: bodyStructure → download every leaf", () => {
  it("every leaf has a non-null blobId, and each downloads to the right bytes and content-type", async () => {
    const h = await harness();
    const { id } = await h.importRaw(MULTIPART_RAW);

    const res = await h.get({
      ids: [id],
      properties: ["bodyStructure", "bodyValues"],
      fetchAllBodyValues: true,
    });
    const email = res.list[0]!;
    const all = leaves(email.bodyStructure as Part);
    expect(all).toHaveLength(3); // text + html + pdf
    for (const leaf of all) expect(leaf.blobId).toBeTruthy();

    const bodyValues = email.bodyValues as Record<string, { value: string; isTruncated: boolean }>;

    // Download each leaf exactly as a template-filling client would:
    // /api/download/{accountId}/{blobId}/{name}?type={type} — name is the
    // literal "null" when the part has none, which is what Mailtemi sends.
    for (const leaf of all) {
      const dl = await h.download(
        `/api/download/${ACCOUNT}/${leaf.blobId}/${leaf.name ?? "null"}?type=${encodeURIComponent(leaf.type)}`,
      );
      expect(dl.status).toBe(200);
      const bytes = new Uint8Array(await dl.arrayBuffer());

      if (leaf.partId !== null) {
        // THE consistency invariant: the bytes the download door serves for a
        // part are the same string the JMAP path serves in bodyValues —
        // decoded once from the same raw blob, byte-for-byte as UTF-8.
        const value = bodyValues[leaf.partId]!;
        expect(value.isTruncated).toBe(false);
        expect(new TextDecoder().decode(bytes)).toBe(value.value);
        expect(bytes).toEqual(new TextEncoder().encode(value.value));
        expect(dl.headers.get("content-type")).toBe(`${leaf.type}; charset=utf-8`);
      } else {
        // The attachment leaf is a real stored blob — whole-blob path, unchanged.
        expect(new TextDecoder().decode(bytes)).toContain("%PDF-1.4");
        expect(dl.headers.get("content-type")).toBe("application/pdf");
      }
    }
  });

  it("serves the part's true type + charset when the client sends no {type} at all", async () => {
    const h = await harness();
    const { rawBlobId } = await h.importRaw(MULTIPART_RAW);
    const dl = await h.download(`/api/download/${ACCOUNT}/${rawBlobId}~h/null`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await dl.text()).toContain("<b>hätml</b>");
  });

  it("download is the FULL part even when bodyValues was truncated", async () => {
    const h = await harness();
    const { id, rawBlobId } = await h.importRaw(MULTIPART_RAW);

    const truncated = await h.get({
      ids: [id],
      properties: ["bodyValues"],
      fetchTextBodyValues: true,
      maxBodyValueBytes: 8,
    });
    const short = (truncated.list[0]!.bodyValues as Record<string, { value: string; isTruncated: boolean }>).t!;
    expect(short.isTruncated).toBe(true);

    const full = await h.get({ ids: [id], properties: ["bodyValues"], fetchTextBodyValues: true });
    const whole = (full.list[0]!.bodyValues as Record<string, { value: string; isTruncated: boolean }>).t!;
    expect(whole.isTruncated).toBe(false);

    const dl = await h.download(`/api/download/${ACCOUNT}/${rawBlobId}~t/null`);
    expect(dl.status).toBe(200);
    const served = await dl.text();
    expect(served).toBe(whole.value);
    expect(served.length).toBeGreaterThan(short.value.length);
  });

  it("resolves a percent-encoded separator (%7E) to the same part", async () => {
    const h = await harness();
    const { rawBlobId } = await h.importRaw(MULTIPART_RAW);
    const literal = await h.download(`/api/download/${ACCOUNT}/${rawBlobId}~t/null`);
    const encoded = await h.download(`/api/download/${ACCOUNT}/${rawBlobId}%7Et/null`);
    expect(encoded.status).toBe(200);
    expect(await encoded.text()).toBe(await literal.text());
  });
});

describe("part addresses that do not resolve — same 404 shape as a missing blob, never a 500", () => {
  it("missing base blob, unknown partId, and a part the message lacks all 404 identically", async () => {
    const h = await harness();
    const { rawBlobId: textOnly } = await h.importRaw(TEXT_ONLY_RAW);

    const missingWhole = await h.download(`/api/download/${ACCOUNT}/${MISSING}/null`);
    expect(missingWhole.status).toBe(404);
    const shape = await missingWhole.text();

    for (const bad of [
      `${MISSING}~t`, // base blob does not exist
      `${textOnly}~x`, // partId this server never mints
      `${textOnly}~h`, // partId the message does not have (no html part)
      `${textOnly}~`, // dangling separator — not a part address, not a blob
      "null", // Mailtemi's literal-null regression itself
    ]) {
      const res = await h.download(`/api/download/${ACCOUNT}/${bad}/null`);
      expect(res.status, `blobId ${bad}`).toBe(404);
      expect(await res.text(), `blobId ${bad}`).toBe(shape);
    }
  });

  it("keeps the whole-blob authorization: no credential → 401, foreign account → 404 before any blob work", async () => {
    const h = await harness();
    const { rawBlobId } = await h.importRaw(MULTIPART_RAW);

    const anon = await h.downloadAnon(`/api/download/${ACCOUNT}/${rawBlobId}~t/null`);
    expect(anon.status).toBe(401);

    const foreign = await h.download(`/api/download/a_other/${rawBlobId}~t/null`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "unknown account" });
  });
});
