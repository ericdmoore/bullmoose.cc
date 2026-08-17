import { describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore, type AttachmentMeta } from "@bullmoose/mailstore";
import { registerFileNodeMethods } from "../../jmap/src/methods/filenode";
import type { RequestContext } from "../../jmap/src/methods/common";
import worker, { type Env } from "./index";
import {
  ATTACHMENTS_ROLE,
  DEFAULT_SIDESTEP_MIN_BYTES,
  fileNameFor,
  isSidestepCandidate,
  sidestepThreshold,
  uniqueName,
} from "./sidestep";

/**
 * The attachment sidestep, inbound half (s03.B T3).
 *
 * Everything below the pure-function block drives the REAL worker through
 * `/dev/inject` — the same entry point `fts.test.ts` uses — over
 * `@bullmoose/test-fakes`: node:sqlite on the live schema (so `file_nodes`'
 * columns and its UNIQUE actually run), real R2, and the REAL AccountDO. That
 * matters for three of these assertions in particular:
 *
 *  · fail-open is tested by BREAKING the database under the real handler, not
 *    by calling a helper with a stub that throws;
 *  · the read-back goes through the shipped `FileNode/get` / `FileNode/query`,
 *    so "a file ingest created is reachable and authorized like any other
 *    file" is proven against the real authorization gate rather than asserted;
 *  · `FileNode/changes` is served by the real changelog, which is the only
 *    thing that catches a row that landed without a `commitChanges`.
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_ingest";
const OTHER_ACCOUNT = "t_bm__a_other";
const TOKEN = "internal-test-token";

/** Small enough to keep test MIME tiny; the real default is exercised purely. */
const TEST_THRESHOLD = "1024";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

function envFor(w: FakeWorker, extra: Partial<Env> = {}): Env {
  return {
    ...w.env,
    DEV_INJECT: "1",
    ATTACHMENT_SIDESTEP_BYTES: TEST_THRESHOLD,
    ...extra,
  } as unknown as Env;
}

async function route(w: FakeWorker, value: Record<string, unknown> = {}): Promise<void> {
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT, ...value }),
  );
}

interface DeliverResult {
  emailId?: string;
  rejected?: string;
  fileNodes?: string[];
}

async function deliver(w: FakeWorker, raw: string, env = envFor(w)): Promise<DeliverResult> {
  const res = await worker.fetch(
    new Request("https://ingest.test/dev/inject?from=sender@elsewhere.test&to=ada@example.test", {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    env,
    ctx(),
  );
  const body = (await res.json()) as DeliverResult;
  expect(body.rejected).toBeUndefined();
  expect(body.emailId).toBeTruthy();
  return body;
}

/** `bytes` bytes of `fill`, base64'd with the 76-column wrapping MIME wants. */
function base64Body(bytes: number, fill: string): string {
  return Buffer.alloc(bytes, fill)
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
}

function mimeWithAttachment(opts: {
  bytes: number;
  filename?: string;
  fill?: string;
  type?: string;
  disposition?: "attachment" | "inline";
  subject?: string;
  extra?: { bytes: number; filename: string; fill: string };
}): string {
  const filename = opts.filename ?? "big.pdf";
  const part = (o: {
    bytes: number;
    filename: string;
    fill: string;
    type?: string;
    disposition?: string;
  }) => [
    "--BOUND",
    `Content-Type: ${o.type ?? "application/pdf"}; name="${o.filename}"`,
    `Content-Disposition: ${o.disposition ?? "attachment"}; filename="${o.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(o.bytes, o.fill),
  ];
  return [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject ?? "Here is the file"}`,
    `Message-ID: <${crypto.randomUUID()}@elsewhere.test>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    ...part({
      bytes: opts.bytes,
      filename,
      fill: opts.fill ?? "A",
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.disposition !== undefined ? { disposition: opts.disposition } : {}),
    }),
    ...(opts.extra ? part(opts.extra) : []),
    "--BOUND--",
    "",
  ].join("\r\n");
}

const plainMime = (subject = "No files here") =>
  [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@elsewhere.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Just words.",
  ].join("\r\n");

/** The attachment metadata as it was actually stored, straight out of D1. */
function storedAttachments(w: FakeWorker, emailId: string): AttachmentMeta[] {
  const row = w.db.query<{ attachments_json: string }>(
    `SELECT attachments_json FROM emails WHERE account_id = ? AND id = ?`,
    ACCOUNT,
    emailId,
  )[0]!;
  return JSON.parse(row.attachments_json) as AttachmentMeta[];
}

/** A FileNode JMAP surface over the SAME bindings the worker just wrote to. */
function jmap(w: FakeWorker, opts: { scopes?: string[]; accounts?: string[] } = {}) {
  const registry = new MethodRegistry<RequestContext>();
  registerFileNodeMethods(registry);
  const requestCtx: RequestContext = {
    env: w.env,
    principal: {
      username: "ada@login.example",
      scopes: opts.scopes ?? ["read", "files"],
      accounts: (opts.accounts ?? [ACCOUNT]).map((accountId) => ({
        accountId,
        tenantId: TENANT,
        name: "Ada",
      })),
    },
  };
  return <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!(args, requestCtx) as Promise<T>;
}

// ---- the rule itself, as pure functions ------------------------------------

describe("the threshold is a policy value, resolved route → env → default", () => {
  it("defaults conservatively when nothing is configured", () => {
    expect(sidestepThreshold({}, {})).toBe(DEFAULT_SIDESTEP_MIN_BYTES);
    expect(sidestepThreshold({ ATTACHMENT_SIDESTEP_BYTES: "" }, {})).toBe(
      DEFAULT_SIDESTEP_MIN_BYTES,
    );
  });

  it("takes the deployment env var, and the per-account route value over it", () => {
    expect(sidestepThreshold({ ATTACHMENT_SIDESTEP_BYTES: "2048" }, {})).toBe(2048);
    expect(sidestepThreshold({ ATTACHMENT_SIDESTEP_BYTES: "2048" }, { sidestepBytes: 99 })).toBe(
      99,
    );
  });

  it("treats 0 — and a typo — as OFF rather than as the default", () => {
    expect(sidestepThreshold({ ATTACHMENT_SIDESTEP_BYTES: "0" }, {})).toBe(0);
    expect(sidestepThreshold({}, { sidestepBytes: 0 })).toBe(0);
    expect(sidestepThreshold({ ATTACHMENT_SIDESTEP_BYTES: "lots" }, {})).toBe(0);
  });
});

describe("the candidate rule is size, plus the inline exclusion", () => {
  const att = (over: Partial<AttachmentMeta>): AttachmentMeta => ({
    blobId: "b1",
    type: "application/pdf",
    name: "x.pdf",
    size: 10,
    cid: null,
    disposition: "attachment",
    ...over,
  });

  it("is inclusive at the threshold and excludes everything under it", () => {
    expect(isSidestepCandidate(att({ size: 1024 }), 1024)).toBe(true);
    expect(isSidestepCandidate(att({ size: 1023 }), 1024)).toBe(false);
  });

  it("never fires for a cid: inline part, however big", () => {
    expect(isSidestepCandidate(att({ size: 50_000_000, disposition: "inline" }), 1024)).toBe(false);
  });

  it("fires at the real default for a genuinely large attachment only", () => {
    expect(isSidestepCandidate(att({ size: 6 * 1024 * 1024 }), DEFAULT_SIDESTEP_MIN_BYTES)).toBe(
      true,
    );
    // A 2 MB phone photo stays where it is.
    expect(isSidestepCandidate(att({ size: 2 * 1024 * 1024 }), DEFAULT_SIDESTEP_MIN_BYTES)).toBe(
      false,
    );
  });

  it("is off entirely at threshold 0", () => {
    expect(isSidestepCandidate(att({ size: 50_000_000 }), 0)).toBe(false);
  });
});

describe("names survive a hostile MIME filename", () => {
  const att = (name: string | null): AttachmentMeta => ({
    blobId: "abcdef123456",
    type: "application/pdf",
    name,
    size: 1,
    cid: null,
    disposition: "attachment",
  });

  it("keeps ordinary names, including spaces and unicode", () => {
    expect(fileNameFor(att("Q3 réport (final).pdf"))).toBe("Q3 réport (final).pdf");
  });

  it("strips path separators and control characters", () => {
    expect(fileNameFor(att("../../etc/passwd"))).toBe(".._.._etc_passwd");
    expect(fileNameFor(att("in\u0000voice\r\n.pdf"))).toBe("in_voice_.pdf");
  });

  it("falls back to a recognizable name when there is none", () => {
    expect(fileNameFor(att(null))).toBe("attachment-abcdef12");
    expect(fileNameFor(att("   "))).toBe("attachment-abcdef12");
    expect(fileNameFor(att("."))).toBe("attachment-abcdef12");
  });

  it("suffixes collisions before the extension, so a .pdf stays a .pdf", () => {
    expect(uniqueName("big.pdf", new Set())).toBe("big.pdf");
    expect(uniqueName("big.pdf", new Set(["big.pdf"]))).toBe("big (2).pdf");
    expect(uniqueName("big.pdf", new Set(["big.pdf", "big (2).pdf"]))).toBe("big (3).pdf");
    expect(uniqueName("notes", new Set(["notes"]))).toBe("notes (2)");
    // A dotfile has no extension to preserve.
    expect(uniqueName(".env", new Set([".env"]))).toBe(".env (2)");
  });
});

// ---- delivery: both sides of the threshold ---------------------------------

describe("delivery side-steps a large attachment into Files", () => {
  it("creates a FileNode under the Attachments role and cross-links the message", async () => {
    const w = fakeEnv();
    await route(w);
    const call = jmap(w);
    const { state: before } = await call<{ state: string }>("FileNode/get", {
      accountId: ACCOUNT,
      ids: [],
    });

    const res = await deliver(w, mimeWithAttachment({ bytes: 2048, filename: "big.pdf" }));

    // 1. the node exists, is a file, and points at the attachment's blob
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    const nodes = await store.getFileNodes(ACCOUNT);
    const dir = nodes.find((n) => n.role === ATTACHMENTS_ROLE)!;
    expect(dir).toMatchObject({ nodeType: "directory", name: "Attachments", parentId: null });
    const file = nodes.find((n) => n.nodeType === "file")!;
    expect(file).toMatchObject({
      parentId: dir.id,
      name: "big.pdf",
      nodeType: "file",
      size: 2048,
      type: "application/pdf",
    });
    // The folder counts as created too — it is a node the client has not seen.
    expect(res.fileNodes).toEqual([dir.id, file.id]);

    // 2. the message keeps its attachment AND names the node
    const attachments = storedAttachments(w, res.emailId!);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      blobId: file.blobId,
      size: 2048,
      name: "big.pdf",
      fileNodeId: file.id,
    });

    // 3. one blob, two references — the bytes were not copied
    expect(w.blobs.objects.size).toBe(2); // the raw message + the attachment

    // 4. the write reached the changelog, not just the table
    const changes = await call<{ created: string[] }>("FileNode/changes", {
      accountId: ACCOUNT,
      sinceState: before,
    });
    expect(changes.created).toEqual(expect.arrayContaining([dir.id, file.id]));
  });

  it("leaves a small attachment inline-only, and creates no folder at all", async () => {
    const w = fakeEnv();
    await route(w);

    const res = await deliver(w, mimeWithAttachment({ bytes: 512, filename: "small.pdf" }));

    expect(w.db.count("file_nodes")).toBe(0);
    expect(res.fileNodes).toBeUndefined();
    const attachments = storedAttachments(w, res.emailId!);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "small.pdf", size: 512 });
    expect(attachments[0]!.fileNodeId).toBeUndefined();
  });

  it("ignores a huge inline part — body furniture is not a file", async () => {
    const w = fakeEnv();
    await route(w);

    const res = await deliver(
      w,
      mimeWithAttachment({
        bytes: 4096,
        filename: "banner.png",
        type: "image/png",
        disposition: "inline",
      }),
    );

    expect(w.db.count("file_nodes")).toBe(0);
    expect(res.fileNodes).toBeUndefined();
  });

  it("honours a per-account threshold on the route over the worker's own", async () => {
    const w = fakeEnv();
    // This account wants everything filed; the deployment default would not.
    await route(w, { sidestepBytes: 256 });

    await deliver(w, mimeWithAttachment({ bytes: 512, filename: "small.pdf" }));
    expect(w.db.count("file_nodes", "node_type = 'file'")).toBe(1);
  });

  it("is off when the threshold is 0, however large the attachment", async () => {
    const w = fakeEnv();
    await route(w, { sidestepBytes: 0 });

    const res = await deliver(w, mimeWithAttachment({ bytes: 8192, filename: "huge.pdf" }));
    expect(w.db.count("file_nodes")).toBe(0);
    expect(res.fileNodes).toBeUndefined();
  });

  it("renames a colliding filename and reuses the node for identical bytes", async () => {
    const w = fakeEnv();
    await route(w);

    await deliver(w, mimeWithAttachment({ bytes: 2048, filename: "big.pdf", fill: "A" }));
    // Same name, DIFFERENT bytes → a second node with a de-duplicated name.
    await deliver(w, mimeWithAttachment({ bytes: 2048, filename: "big.pdf", fill: "B" }));
    // Same name, SAME bytes → content addressing makes it one object, so the
    // existing node is cross-linked rather than a third "big (3).pdf" minted.
    const third = await deliver(
      w,
      mimeWithAttachment({ bytes: 2048, filename: "big.pdf", fill: "A" }),
    );

    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    const files = (await store.getFileNodes(ACCOUNT)).filter((n) => n.nodeType === "file");
    expect(files.map((f) => f.name).sort()).toEqual(["big (2).pdf", "big.pdf"]);
    expect(third.fileNodes).toBeUndefined(); // nothing NEW was created
    expect(storedAttachments(w, third.emailId!)[0]!.fileNodeId).toBe(
      files.find((f) => f.name === "big.pdf")!.id,
    );
    // One Attachments folder, not one per message.
    expect(w.db.count("file_nodes", "role = ?", ATTACHMENTS_ROLE)).toBe(1);
  });

  it("stamps ingest as the writer on every row it creates (s03.A provenance)", async () => {
    const w = fakeEnv();
    await route(w);
    await deliver(w, mimeWithAttachment({ bytes: 2048 }));

    const rows = w.db.query<{
      node_type: string;
      last_writer_principal: string | null;
      last_writer_binding: string | null;
      last_writer_invocation: string | null;
    }>(
      `SELECT node_type, ${"last_writer_principal, last_writer_binding, last_writer_invocation"}
        FROM file_nodes WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(rows).toHaveLength(2); // the folder and the file
    for (const r of rows) {
      expect(r.last_writer_principal).toBe("system:ingest");
      expect(r.last_writer_binding).toBeNull();
      expect(r.last_writer_invocation).toBeNull();
    }
    // The MESSAGE keeps writing NULL provenance — this changed what a file
    // records, not what delivery records.
    const email = w.db.query<{ last_writer_principal: string | null }>(
      `SELECT last_writer_principal FROM emails WHERE account_id = ?`,
      ACCOUNT,
    )[0]!;
    expect(email.last_writer_principal).toBeNull();
  });
});

// ---- reachable and authorized like any other file --------------------------

describe("a side-stepped file is an ordinary FileNode", () => {
  async function deliverOne(w: FakeWorker) {
    await route(w);
    const res = await deliver(w, mimeWithAttachment({ bytes: 2048, filename: "big.pdf" }));
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    const file = (await store.getFileNodes(ACCOUNT)).find((n) => n.nodeType === "file")!;
    return { res, file };
  }

  it("reads back through FileNode/get with the files scope", async () => {
    const w = fakeEnv();
    const { file } = await deliverOne(w);

    const got = await jmap(w)<{ list: Array<Record<string, unknown>>; notFound: string[] }>(
      "FileNode/get",
      { accountId: ACCOUNT, ids: [file.id] },
    );
    expect(got.notFound).toEqual([]);
    expect(got.list[0]).toMatchObject({
      id: file.id,
      name: "big.pdf",
      nodeType: "file",
      blobId: file.blobId,
      size: 2048,
      type: "application/pdf",
      shareWith: null,
    });
  });

  it("is findable by the Attachments role through FileNode/query", async () => {
    const w = fakeEnv();
    const { file } = await deliverOne(w);
    const call = jmap(w);

    const dirQuery = await call<{ ids: string[] }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { role: ATTACHMENTS_ROLE },
    });
    expect(dirQuery.ids).toHaveLength(1);
    const inFolder = await call<{ ids: string[] }>("FileNode/query", {
      accountId: ACCOUNT,
      filter: { parentId: dirQuery.ids[0], nodeType: "file" },
    });
    expect(inFolder.ids).toEqual([file.id]);
  });

  it("obeys the SAME scope gate as every other FileNode — no new authority path", async () => {
    const w = fakeEnv();
    const { file } = await deliverOne(w);
    const get = (scopes: string[]) =>
      jmap(w, { scopes })("FileNode/get", { accountId: ACCOUNT, ids: [file.id] });

    // `filenode.ts` gates reads on ("read","files"), and since common/027 the
    // `files` realm scope satisfies `read` on its own. Both spellings work; a
    // token holding neither does not. The point is that a file ingest created
    // is gated by that existing rule and by nothing of its own — there is no
    // ingest-shaped back door into the Files realm.
    await expect(get([])).rejects.toMatchObject({ type: "forbidden" });
    await expect(get(["files"])).resolves.toMatchObject({ notFound: [] });
    await expect(get(["read", "files"])).resolves.toMatchObject({ notFound: [] });
  });

  it("is invisible to another account — both at the gate and in the query", async () => {
    const w = fakeEnv();
    const { file } = await deliverOne(w);

    // (a) a principal who cannot see this account at all
    await expect(
      jmap(w, { accounts: [OTHER_ACCOUNT] })("FileNode/get", {
        accountId: ACCOUNT,
        ids: [file.id],
      }),
    ).rejects.toMatchObject({ type: "accountNotFound" });

    // (b) a principal who owns BOTH accounts, asking the OTHER one for the id.
    // The gate passes here, so this is the account scoping on the row itself.
    const both = jmap(w, { accounts: [ACCOUNT, OTHER_ACCOUNT] });
    const got = await both<{ list: unknown[]; notFound: string[] }>("FileNode/get", {
      accountId: OTHER_ACCOUNT,
      ids: [file.id],
    });
    expect(got.list).toEqual([]);
    expect(got.notFound).toEqual([file.id]);
    const q = await both<{ ids: string[] }>("FileNode/query", { accountId: OTHER_ACCOUNT });
    expect(q.ids).toEqual([]);
  });
});

// ---- fail-open, against the real handler -----------------------------------

describe("the sidestep fails OPEN — mail is never the price of a Files failure", () => {
  it("delivers the message when the FileNode write throws", async () => {
    const w = fakeEnv();
    await route(w);
    // A shard that predates `file_nodes` — the same failure mode the s12
    // quarantine store fails open on, injected the same way: for real.
    w.db.sqlite.exec("DROP TABLE file_nodes");

    const res = await deliver(w, mimeWithAttachment({ bytes: 2048, filename: "big.pdf" }));

    // The message landed, intact, in the inbox.
    expect(res.emailId).toBeTruthy();
    expect(res.fileNodes).toBeUndefined();
    const row = w.db.query<{ subject: string; has_attachment: number }>(
      `SELECT subject, has_attachment FROM emails WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      res.emailId!,
    )[0]!;
    expect(row).toMatchObject({ subject: "Here is the file", has_attachment: 1 });

    // …with its attachment still downloadable, just with no file to point at.
    const attachments = storedAttachments(w, res.emailId!);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "big.pdf", size: 2048 });
    expect(attachments[0]!.fileNodeId ?? null).toBeNull();
    const blob = await new Mailstore(w.env.DB, w.env.BLOBS).getBlob(
      TENANT,
      ACCOUNT,
      attachments[0]!.blobId,
    );
    expect(blob).not.toBeNull();
  });

  it("keeps the files it did manage to create when a later one fails", async () => {
    const w = fakeEnv();
    await route(w);
    // Two attachments; the folder and the first file insert succeed, then the
    // table disappears mid-flight. Simulated by making the SECOND name collide
    // with a row the UNIQUE constraint will reject at insert time.
    w.db.sqlite.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON file_nodes
         WHEN NEW.name = 'second.pdf'
         BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );

    const res = await deliver(
      w,
      mimeWithAttachment({
        bytes: 2048,
        filename: "first.pdf",
        fill: "A",
        extra: { bytes: 2048, filename: "second.pdf", fill: "B" },
      }),
    );

    expect(res.emailId).toBeTruthy();
    const attachments = storedAttachments(w, res.emailId!);
    expect(attachments).toHaveLength(2);
    // First one filed and cross-linked; second one delivered inline-only.
    expect(res.fileNodes).toHaveLength(2); // the Attachments folder + first.pdf
    expect(attachments[0]!.fileNodeId).toBe(res.fileNodes![1]);
    expect(attachments[1]!.fileNodeId ?? null).toBeNull();
    // And what DID land was announced — no orphan row outside the changelog.
    expect(w.db.count("file_nodes", "node_type = 'file'")).toBe(1);
  });
});

// ---- DefaultCase -----------------------------------------------------------

describe("DefaultCase: mail with no attachments is unchanged", () => {
  it("stores exactly what it stored before T3, and touches nothing in Files", async () => {
    const w = fakeEnv();
    await route(w);
    const call = jmap(w);
    const { state: before } = await call<{ state: string }>("FileNode/get", {
      accountId: ACCOUNT,
      ids: [],
    });

    const res = await deliver(w, plainMime("No files here"));

    const row = w.db.query<{
      subject: string;
      has_attachment: number;
      attachments_json: string;
      last_writer_principal: string | null;
    }>(
      `SELECT subject, has_attachment, attachments_json, last_writer_principal
         FROM emails WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      res.emailId!,
    )[0]!;
    expect(row).toEqual({
      subject: "No files here",
      has_attachment: 0,
      attachments_json: "[]",
      last_writer_principal: null,
    });

    expect(res.fileNodes).toBeUndefined();
    expect(w.db.count("file_nodes")).toBe(0);
    const changes = await call<{ created: string[]; updated: string[]; destroyed: string[] }>(
      "FileNode/changes",
      { accountId: ACCOUNT, sinceState: before },
    );
    expect(changes).toMatchObject({ created: [], updated: [], destroyed: [] });
  });
});
