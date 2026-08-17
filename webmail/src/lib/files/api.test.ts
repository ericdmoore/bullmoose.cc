import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { JmapRequestError } from "../jmap/JmapClient";
import type { Id, Invocation, UploadResult } from "../jmap/types";
import {
  createFolder,
  describeSetError,
  describeUploadFailure,
  destroyNode,
  filesAccounts,
  loadDirectories,
  loadDirectory,
  moveNode,
  planUploads,
  renameNode,
  uploadFile,
} from "./api";
import { installDemoFiles, sessionWithoutFiles, type DemoFilesBackend } from "./demoFiles";
import { NO_UPLOAD_SCOPE_NOTE, NO_WRITE_SCOPE_NOTE } from "./scope";
import type { FileNode } from "./types";

const ACCOUNT = "acct-fake";
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

/**
 * A fake that records the ORDER of everything it was asked to do — method
 * names and blob uploads in one sequence. The upload-then-create ordering is
 * the one rule in `api.ts` that cannot be checked by looking at arguments, so
 * it needs a client that remembers what happened first.
 */
class RecordingFake extends FakeJmapClient {
  readonly log: string[] = [];
  /** Set to make the blob upload fail the way a 403 does. */
  uploadError?: Error;

  override async request(calls: Invocation[]): Promise<Invocation[]> {
    for (const [name] of calls) this.log.push(name);
    return super.request(calls);
  }

  override async upload(
    accountId: Id,
    body: Blob | Uint8Array,
    type: string,
  ): Promise<UploadResult> {
    this.log.push("upload");
    if (this.uploadError) throw this.uploadError;
    return super.upload(accountId, body, type);
  }
}

function harness(opts: Parameters<typeof installDemoFiles>[1] = {}): {
  client: RecordingFake;
  backend: DemoFilesBackend;
} {
  const client = new RecordingFake();
  const backend = installDemoFiles(client, { now: NOW, ...opts });
  return { client, backend };
}

const bytes = (n = 8): Uint8Array => new Uint8Array(n).fill(7);

describe("filesAccounts", () => {
  it("lists accounts that advertise the Files capability, primary first", async () => {
    const { client } = harness();
    const accounts = filesAccounts(await client.session());
    expect(accounts.map((a) => a.id)).toEqual([ACCOUNT]);
    expect(accounts[0]?.isPrimary).toBe(true);
  });

  it("returns NOTHING for a session without the capability — the degrade signal", async () => {
    const client = new FakeJmapClient({ session: sessionWithoutFiles() });
    expect(filesAccounts(await client.session())).toEqual([]);
  });
});

describe("loadDirectory", () => {
  it("reads a folder, its breadcrumb and its children in ONE round trip", async () => {
    const { client } = harness();
    const page = await loadDirectory(client, ACCOUNT, "fn-roadmap");

    // One request carrying three calls — invariant §6.5. `sentBatches` is the
    // batch list, so length 1 is the assertion that matters.
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]?.map((c) => c[0])).toEqual([
      "FileNode/get",
      "FileNode/query",
      "FileNode/get",
    ]);
    expect(page.dir?.name).toBe("2026 roadmap");
    expect(page.trail.crumbs.map((c) => c.name)).toEqual(["Files", "Projects", "2026 roadmap"]);
    expect(page.trail.truncated).toBe(false);
    expect(page.children.map((n) => n.name)).toEqual(["budget.csv", "roadmap.md"]);
    expect(page.total).toBe(2);
  });

  it("never sends `ids: []` — an empty list means THE WHOLE ACCOUNT", async () => {
    // mailstore:3310-3328 treats a zero-length id list as "no filter", so a
    // listing that sent one would silently fetch every node in the account and
    // render the whole drive as the contents of one folder.
    const { client } = harness();
    await loadDirectory(client, ACCOUNT, null);
    await loadDirectory(client, ACCOUNT, "fn-projects");
    for (const batch of client.sentBatches) {
      for (const [name, args] of batch) {
        if (name !== "FileNode/get") continue;
        expect(Array.isArray(args.ids) && (args.ids as string[]).length === 0).toBe(false);
      }
    }
  });

  it("lists the top level with no ancestor call at all", async () => {
    const { client } = harness();
    const page = await loadDirectory(client, ACCOUNT, null);
    const names = client.sentBatches[0]!.map((c) => c[0]);
    expect(names).toEqual(["FileNode/query", "FileNode/get"]);
    expect(page.dir).toBeUndefined();
    expect(page.trail.crumbs).toHaveLength(1);
    // Directories first, then files — the client ordering (`tree.ts`). Note
    // "porch" before "README": `localeCompare` is case-insensitive at its
    // primary strength, while the server's `ORDER BY name` is SQLite BINARY
    // (uppercase first). Both orders are stable; they are just not the same
    // one, which is exactly why `PARTIAL_SORT_NOTE` exists.
    expect(page.children.map((n) => n.name)).toEqual([
      "Attachments",
      "Projects",
      "Scratch",
      "porch-2026.jpeg",
      "README.txt",
    ]);
  });

  it("renders the sidestep's Attachments folder as an ORDINARY directory", async () => {
    const { client } = harness();
    const root = await loadDirectory(client, ACCOUNT, null);
    const attachments = root.children.find((n) => n.name === "Attachments")!;
    expect(attachments.nodeType).toBe("directory");
    expect(attachments.role).toBe("attachments");

    // …and it opens like any other folder, with a breadcrumb and children.
    const inside = await loadDirectory(client, ACCOUNT, attachments.id);
    expect(inside.trail.crumbs.map((c) => c.name)).toEqual(["Files", "Attachments"]);
    expect(inside.children.map((n) => n.name)).toContain("Q3 board deck.pdf");
  });

  it("shows an EMPTY folder as empty — not as the whole account", async () => {
    // The sharp one. An empty folder back-references to `FileNode/get { ids: [] }`,
    // and the server answers a zero-length id list with EVERY node in the
    // account (`mailstore:3310-3328`). Trust `list` and "Scratch" renders the
    // entire drive. `loadDirectory` resolves through the query's ids instead —
    // delete that guard and this test fails with twelve children.
    const { client, backend } = harness();
    const page = await loadDirectory(client, ACCOUNT, "fn-scratch");
    expect(backend.nodes.length).toBeGreaterThan(5); // there IS a drive to leak
    expect(page.children).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.refusal).toBeUndefined();
  });

  it("pages children and reports the true total", async () => {
    const { client } = harness();
    const page = await loadDirectory(client, ACCOUNT, "fn-attachments", { limit: 2 });
    expect(page.children).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it("DEGRADES on a scope refusal instead of throwing", async () => {
    const { client } = harness({ canRead: false });
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.refusal?.type).toBe("forbidden");
    expect(page.refusal?.message).toMatch(/not allowed to read files/);
    expect(page.children).toEqual([]);
  });

  it("degrades on a server with no FileNode methods at all", async () => {
    const client = new FakeJmapClient({ session: sessionWithoutFiles() });
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.refusal?.type).toBe("unknownMethod");
    expect(page.refusal?.message).toMatch(/does not implement the Files methods/);
  });
});

describe("loadDirectories (move destinations)", () => {
  it("fetches every directory in one query→get and flags no truncation", async () => {
    const { client } = harness();
    const { directories, truncated } = await loadDirectories(client, ACCOUNT);
    expect(directories.map((d) => d.name).sort()).toEqual([
      "2026 roadmap",
      "Attachments",
      "Projects",
      "Scratch",
    ]);
    expect(truncated).toBe(false);
    expect(client.sentBatches).toHaveLength(1);
  });
});

describe("createFolder", () => {
  it("issues ONE FileNode/set create with nodeType directory, the parent and the name", async () => {
    const { client, backend } = harness();
    const result = await createFolder(client, ACCOUNT, "fn-projects", "Invoices");
    expect(result.error).toBeUndefined();
    expect(result.id).toBeTruthy();

    const [call] = client.sentBatches.at(-1)!;
    expect(call![0]).toBe("FileNode/set");
    expect(call![1]).toEqual({
      accountId: ACCOUNT,
      create: { d0: { name: "Invoices", nodeType: "directory", parentId: "fn-projects" } },
    });
    // …and a directory create carries NO blobId: the server refuses one that does.
    expect(Object.keys((call![1] as { create: Record<string, object> }).create.d0!)).not.toContain(
      "blobId",
    );

    const made = backend.nodes.find((n) => n.id === result.id)!;
    expect(made.nodeType).toBe("directory");
    expect(made.parentId).toBe("fn-projects");
  });

  it("creates at the top level with parentId null", async () => {
    const { client, backend } = harness();
    const result = await createFolder(client, ACCOUNT, null, "Archive");
    expect(backend.nodes.find((n) => n.id === result.id)?.parentId).toBeNull();
  });

  it("REFUSES a blank name before the round trip", async () => {
    // The mutation that proves this bites: let a blank name through in
    // `createFolder` and this test fails on both counts.
    const { client } = harness();
    const result = await createFolder(client, ACCOUNT, null, "   ");
    expect(result.error?.type).toBe("invalidProperties");
    expect(result.error?.description).toBe("A name is required.");
    expect(client.sentBatches).toHaveLength(0);
    expect(client.log).toEqual([]);
  });

  it("refuses a name with a slash, and one over 255 characters, without asking", async () => {
    const { client } = harness();
    expect((await createFolder(client, ACCOUNT, null, "a/b")).error?.type).toBe(
      "invalidProperties",
    );
    expect((await createFolder(client, ACCOUNT, null, "x".repeat(256))).error?.type).toBe(
      "invalidProperties",
    );
    expect(client.sentBatches).toHaveLength(0);
  });

  it("sends the TRIMMED name", async () => {
    const { client, backend } = harness();
    const result = await createFolder(client, ACCOUNT, null, "  Archive  ");
    expect(backend.nodes.find((n) => n.id === result.id)?.name).toBe("Archive");
  });

  it("surfaces the server's alreadyExists refusal legibly instead of renaming", async () => {
    const { client, backend } = harness();
    const before = backend.nodes.length;
    const result = await createFolder(client, ACCOUNT, null, "Projects");
    expect(result.id).toBeUndefined();
    expect(result.error?.type).toBe("alreadyExists");
    expect(backend.nodes).toHaveLength(before);
    const sentence = describeSetError(
      result.error!,
      backend.nodes.find((n) => n.name === "Projects")!,
    );
    expect(sentence).toMatch(/already something called “Projects” here/);
  });

  it("reports a write-scope refusal as a sentence, not an exception", async () => {
    const { client } = harness({ canWrite: false });
    const result = await createFolder(client, ACCOUNT, null, "Archive");
    expect(result.refusal?.type).toBe("forbidden");
    expect(result.refusal?.message).toBe(NO_WRITE_SCOPE_NOTE);
  });
});

describe("uploadFile — the ordering that is not a preference", () => {
  it("uploads the bytes FIRST and only then creates the node", async () => {
    const { client, backend } = harness();
    const result = await uploadFile(client, ACCOUNT, "fn-scratch", {
      name: "notes.txt",
      size: 8,
      type: "text/plain",
      body: bytes(),
    });

    // The mutation that proves this bites: create the FileNode before the
    // upload and this equality fails.
    expect(client.log).toEqual(["upload", "FileNode/set"]);
    expect(result.error).toBeUndefined();

    const made = backend.nodes.find((n) => n.id === result.id)!;
    expect(made.nodeType).toBe("file");
    expect(made.parentId).toBe("fn-scratch");
    // The blobId in the create is the one the UPLOAD returned — the create
    // cannot invent it, and the server verifies it exists before inserting.
    expect(made.blobId).toBe("blob-1");
    expect(made.size).toBe(8);
    expect(made.type).toBe("text/plain");
  });

  it("creates NO node when the upload fails", async () => {
    const { client, backend } = harness();
    const before = backend.nodes.length;
    client.uploadError = new JmapRequestError("upload failed: HTTP 500", undefined, 500);

    const result = await uploadFile(client, ACCOUNT, null, {
      name: "notes.txt",
      size: 8,
      type: "text/plain",
      body: bytes(),
    });

    expect(result.id).toBeUndefined();
    expect(result.refusal?.type).toBe("uploadFailed");
    // Nothing was written and — the part that matters — no FileNode/set was
    // even attempted.
    expect(client.log).toEqual(["upload"]);
    expect(client.sentBatches).toEqual([]);
    expect(backend.nodes).toHaveLength(before);
  });

  it("names the draft-scope gap when the upload route 403s", async () => {
    const { client } = harness();
    client.uploadError = new JmapRequestError("upload failed: HTTP 403", undefined, 403);
    const result = await uploadFile(client, ACCOUNT, null, {
      name: "x.txt",
      size: 1,
      type: "text/plain",
      body: bytes(1),
    });
    expect(result.refusal?.message).toBe(NO_UPLOAD_SCOPE_NOTE);
    expect(result.refusal?.message).toMatch(/“draft”/);
  });

  it("defaults an unknown media type rather than sending an empty one", async () => {
    const { client, backend } = harness();
    const result = await uploadFile(client, ACCOUNT, null, {
      name: "mystery",
      size: 3,
      type: "",
      body: bytes(3),
    });
    expect(backend.nodes.find((n) => n.id === result.id)?.type).toBe("application/octet-stream");
  });

  it("cleans a path-shaped filename before it reaches the server", async () => {
    const { client, backend } = harness();
    const result = await uploadFile(client, ACCOUNT, null, {
      name: "sub/dir/report.pdf",
      size: 4,
      type: "application/pdf",
      body: bytes(4),
    });
    expect(backend.nodes.find((n) => n.id === result.id)?.name).toBe("sub_dir_report.pdf");
  });

  it("accepts a Blob body and streams it — a browser File is one", async () => {
    const { client, backend } = harness();
    const result = await uploadFile(client, ACCOUNT, null, {
      name: "blob.txt",
      size: 5,
      type: "text/plain",
      body: new Blob(["hello"]),
    });
    expect(backend.nodes.find((n) => n.id === result.id)?.size).toBe(5);
  });
});

describe("planUploads", () => {
  const siblings = [
    { id: "x", name: "report.pdf" } as FileNode,
    { id: "y", name: "notes.txt" } as FileNode,
  ];

  it("leaves free names alone", () => {
    const planned = planUploads([{ name: "fresh.pdf", size: 1, type: "" }], siblings);
    expect(planned[0]?.name).toBe("fresh.pdf");
    expect(planned[0]?.renamedFrom).toBeUndefined();
  });

  it("auto-renames around an existing sibling and SAYS it did", () => {
    const planned = planUploads([{ name: "report.pdf", size: 1, type: "" }], siblings);
    expect(planned[0]?.name).toBe("report (2).pdf");
    expect(planned[0]?.renamedFrom).toBe("report.pdf");
  });

  it("renames within the batch too — two files of the same name in one drop", () => {
    const planned = planUploads(
      [
        { name: "shot.png", size: 1, type: "" },
        { name: "shot.png", size: 2, type: "" },
        { name: "shot.png", size: 3, type: "" },
      ],
      siblings,
    );
    expect(planned.map((p) => p.name)).toEqual(["shot.png", "shot (2).png", "shot (3).png"]);
  });

  it("is case-sensitive, like the server's collision check", () => {
    const planned = planUploads([{ name: "Report.pdf", size: 1, type: "" }], siblings);
    expect(planned[0]?.name).toBe("Report.pdf");
  });
});

describe("renameNode / moveNode / destroyNode", () => {
  it("renames through FileNode/set update { name }", async () => {
    const { client, backend } = harness();
    const result = await renameNode(client, ACCOUNT, "fn-readme", "READ-ME.txt");
    expect(result.error).toBeUndefined();
    expect(backend.nodes.find((n) => n.id === "fn-readme")?.name).toBe("READ-ME.txt");
    expect(client.sentBatches.at(-1)![0]![1]).toEqual({
      accountId: ACCOUNT,
      update: { "fn-readme": { name: "READ-ME.txt" } },
    });
  });

  it("refuses an invalid rename before the round trip", async () => {
    const { client } = harness();
    const result = await renameNode(client, ACCOUNT, "fn-readme", "  ");
    expect(result.error?.type).toBe("invalidProperties");
    expect(client.sentBatches).toHaveLength(0);
  });

  it("moves through FileNode/set update { parentId }", async () => {
    const { client, backend } = harness();
    await moveNode(client, ACCOUNT, "fn-readme", "fn-projects");
    expect(backend.nodes.find((n) => n.id === "fn-readme")?.parentId).toBe("fn-projects");
    await moveNode(client, ACCOUNT, "fn-readme", null);
    expect(backend.nodes.find((n) => n.id === "fn-readme")?.parentId).toBeNull();
  });

  it("refuses a move that would close a cycle, exactly as the server does", async () => {
    const { client } = harness();
    const result = await moveNode(client, ACCOUNT, "fn-projects", "fn-roadmap");
    expect(result.error?.type).toBe("invalidProperties");
    expect(result.error?.description).toMatch(/cycle/);
  });

  it("destroys a file", async () => {
    const { client, backend } = harness();
    const result = await destroyNode(client, ACCOUNT, "fn-readme");
    expect(result.error).toBeUndefined();
    expect(backend.nodes.some((n) => n.id === "fn-readme")).toBe(false);
  });

  it("refuses a non-empty folder until told twice — the server's own confirmation", async () => {
    const { client, backend } = harness();
    const refused = await destroyNode(client, ACCOUNT, "fn-projects");
    expect(refused.error?.type).toBe("fileNodeHasChildren");
    expect(backend.nodes.some((n) => n.id === "fn-projects")).toBe(true);
    expect(
      describeSetError(
        refused.error!,
        backend.nodes.find((n) => n.id === "fn-projects")!,
      ),
    ).toMatch(/not empty/);

    const done = await destroyNode(client, ACCOUNT, "fn-projects", true);
    expect(done.error).toBeUndefined();
    // …and it took its whole subtree with it.
    expect(backend.nodes.some((n) => n.id === "fn-roadmap-doc")).toBe(false);
  });
});

describe("describeUploadFailure", () => {
  it("maps the statuses that mean something specific", () => {
    expect(describeUploadFailure(new JmapRequestError("x", undefined, 403)).type).toBe("forbidden");
    expect(describeUploadFailure(new JmapRequestError("x", undefined, 404)).type).toBe(
      "accountNotFound",
    );
    expect(describeUploadFailure(new JmapRequestError("x", undefined, 413)).type).toBe("tooLarge");
  });

  it("says the bytes never landed for anything else, rather than a bare error", () => {
    const refusal = describeUploadFailure(new Error("network down"));
    expect(refusal.type).toBe("uploadFailed");
    expect(refusal.message).toMatch(/nothing was filed/);
  });
});
