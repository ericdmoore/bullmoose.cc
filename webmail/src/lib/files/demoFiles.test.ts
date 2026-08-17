import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { FILENODE_CAP, hasCapability } from "../jmap/capabilities";
import { loadDirectory } from "./api";
import {
  createDemoFiles,
  demoFileNodes,
  filesDemoClient,
  installDemoFiles,
  sessionWithoutFiles,
} from "./demoFiles";
import { ATTACHMENTS_ROLE } from "./scope";

const ACCOUNT = "acct-fake";
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("the fixture drive", () => {
  const nodes = demoFileNodes(NOW);

  it("has exactly one role directory, and it is the sidestep's", () => {
    const roles = nodes.filter((n) => n.role !== null);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.name).toBe("Attachments");
    expect(roles[0]?.role).toBe(ATTACHMENTS_ROLE);
    // The claim this fixture exists to make: it is an ORDINARY directory.
    expect(roles[0]?.nodeType).toBe("directory");
    expect(roles[0]?.blobId).toBeNull();
  });

  it("holds files big enough to have crossed the sidestep threshold", () => {
    const inAttachments = nodes.filter((n) => n.parentId === "fn-attachments");
    // DEFAULT_SIDESTEP_MIN_BYTES is 5 MiB (sidestep.ts:62); a fixture whose
    // "filed attachments" are all tiny would not resemble a real drive.
    expect(inAttachments.some((n) => (n.size ?? 0) >= 5 * 1024 * 1024)).toBe(true);
  });

  it("nests two deep and includes an EMPTY folder", () => {
    expect(nodes.find((n) => n.id === "fn-roadmap")?.parentId).toBe("fn-projects");
    expect(nodes.some((n) => n.parentId === "fn-roadmap")).toBe(true);
    expect(nodes.some((n) => n.parentId === "fn-scratch")).toBe(false);
  });

  it("gives every file a blob and every directory none", () => {
    for (const n of nodes) {
      if (n.nodeType === "file") expect(n.blobId, n.name).toBeTruthy();
      else expect(n.blobId, n.name).toBeNull();
    }
  });

  it("is a fresh array each call, so one test cannot poison the next", () => {
    expect(demoFileNodes(NOW)).not.toBe(nodes);
  });
});

describe("the fake mirrors the server's warts", () => {
  const harness = () => {
    const client = new FakeJmapClient();
    const backend = installDemoFiles(client, { now: NOW });
    return { client, backend };
  };

  it("throws cannotCalculateChanges on queryChanges, exactly as the server does", async () => {
    const { client } = harness();
    const [response] = await client.request([
      ["FileNode/queryChanges", { accountId: ACCOUNT }, "c"],
    ]);
    expect(response![0]).toBe("error");
    expect((response![1] as { type: string }).type).toBe("cannotCalculateChanges");
  });

  it("reports canCalculateChanges: false on query", async () => {
    const { client } = harness();
    const result = await client.requestOne("FileNode/query", {
      accountId: ACCOUNT,
      filter: { parentId: null },
    });
    expect(result.canCalculateChanges).toBe(false);
  });

  it("returns the WHOLE account for `ids: []`, the wart api.ts routes around", async () => {
    const { client, backend } = harness();
    const result = await client.requestOne("FileNode/get", { accountId: ACCOUNT, ids: [] });
    expect((result.list as unknown[]).length).toBe(backend.nodes.length);
  });

  it("refuses a file create with no blobId and a directory create WITH one", async () => {
    const { client } = harness();
    const result = await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      create: {
        a: { name: "no-blob.txt", nodeType: "file", parentId: null },
        b: { name: "bad-dir", nodeType: "directory", parentId: null, blobId: "blob-1" },
      },
    });
    const notCreated = result.notCreated as Record<string, { type: string; properties?: string[] }>;
    expect(notCreated.a?.properties).toEqual(["blobId"]);
    expect(notCreated.b?.properties).toEqual(["blobId"]);
  });

  it("refuses server-set properties on a create", async () => {
    const { client } = harness();
    const result = await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      create: { a: { name: "x", nodeType: "directory", myRights: {} } },
    });
    expect((result.notCreated as Record<string, { type: string }>).a?.type).toBe(
      "invalidProperties",
    );
  });

  it("refuses an update to an immutable path", async () => {
    const { client } = harness();
    const result = await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      update: { "fn-readme": { size: 5 } },
    });
    expect((result.notUpdated as Record<string, { type: string }>)["fn-readme"]?.type).toBe(
      "invalidProperties",
    );
  });

  it("collides case-SENSITIVELY by default and case-insensitively on request", async () => {
    const { client } = harness();
    const sensitive = await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      create: { a: { name: "projects", nodeType: "directory", parentId: null } },
    });
    expect(Object.keys(sensitive.created as object)).toEqual(["a"]);

    const insensitive = await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      compareCaseInsensitively: true,
      create: { b: { name: "PROJECTS", nodeType: "directory", parentId: null } },
    });
    expect((insensitive.notCreated as Record<string, { type: string }>).b?.type).toBe(
      "alreadyExists",
    );
  });

  it("advances its state only when something actually changed", async () => {
    const { client, backend } = harness();
    const before = backend.state();
    await client.requestOne("FileNode/set", { accountId: ACCOUNT, destroy: ["nope"] });
    expect(backend.state()).toBe(before);
    await client.requestOne("FileNode/set", {
      accountId: ACCOUNT,
      create: { a: { name: "Fresh", nodeType: "directory", parentId: null } },
    });
    expect(backend.state()).not.toBe(before);
  });

  it("refuses every write with `forbidden` when canWrite is off", async () => {
    const client = new FakeJmapClient();
    installDemoFiles(client, { now: NOW, canWrite: false });
    const [response] = await client.request([["FileNode/set", { accountId: ACCOUNT }, "w"]]);
    expect((response![1] as { type: string }).type).toBe("forbidden");
    // …while reads still work: "look but do not touch" is a real state.
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.refusal).toBeUndefined();
    expect(page.children.length).toBeGreaterThan(0);
  });
});

describe("sessionWithoutFiles / filesDemoClient", () => {
  it("removes the capability from the session AND from the account", () => {
    const session = sessionWithoutFiles();
    expect(hasCapability(session, FILENODE_CAP)).toBe(false);
    for (const account of Object.values(session.accounts)) {
      expect(hasCapability({ capabilities: account.accountCapabilities }, FILENODE_CAP)).toBe(
        false,
      );
    }
    expect(session.primaryAccounts[FILENODE_CAP]).toBeUndefined();
  });

  it("?filecap=0 hands back a client with no Files realm at all", async () => {
    const client = filesDemoClient(new FakeJmapClient(), "?demo=1&filecap=0");
    expect(hasCapability(await client.session(), FILENODE_CAP)).toBe(false);
    const [response] = await client.request([["FileNode/query", { accountId: ACCOUNT }, "q"]]);
    expect((response![1] as { type: string }).type).toBe("unknownMethod");
  });

  it("?readonly=1 hands back a readable drive whose writes are refused", async () => {
    const client = filesDemoClient(new FakeJmapClient(), "?demo=1&readonly=1");
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.children.length).toBeGreaterThan(0);
    const [response] = await client.request([["FileNode/set", { accountId: ACCOUNT }, "w"]]);
    expect((response![1] as { type: string }).type).toBe("forbidden");
  });

  it("plain ?demo=1 is a full drive", async () => {
    const client = filesDemoClient(new FakeJmapClient(), "?demo=1");
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.children.map((n) => n.name)).toContain("Attachments");
  });

  it("createDemoFiles hands back the mutable node list for assertions", async () => {
    const backend = createDemoFiles({ now: NOW });
    expect(backend.nodes.length).toBeGreaterThan(5);
    expect(backend.state()).toBe("0");
  });
});
