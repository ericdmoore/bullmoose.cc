// The journey, not the units.
//
// `api.test.ts` checks each call in isolation; this file drives the SEQUENCE
// the island performs — bootstrap, list, navigate, create, upload, rename,
// move, delete, and the two ways the section degrades — against the same demo
// backend `/files?demo=1` runs on. It is the closest thing to opening the page
// that a suite with no jsdom can be, and it is what would have caught the
// class of bug s03.C T2 hit: every unit green while the screen was useless.
//
// The one thing it deliberately does NOT do is import `FilesApp.tsx`. vitest
// runs in plain Node (`vitest.config.ts`), so a `.tsx` island is untestable
// here by construction; the answer is that the island holds no rules, and this
// file is the proof that everything it calls composes.

import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { FILENODE_CAP, hasCapability } from "../jmap/capabilities";
import {
  createFolder,
  destroyNode,
  downloadNode,
  filesAccounts,
  loadDirectories,
  loadDirectory,
  moveNode,
  planUploads,
  renameNode,
  uploadFile,
} from "./api";
import { filesDemoClient } from "./demoFiles";
import { NO_CAPABILITY_NOTE, NO_WRITE_SCOPE_NOTE } from "./scope";
import { moveTargets } from "./tree";

const ACCOUNT = "acct-fake";

const openDemo = (search = "?demo=1") => filesDemoClient(new FakeJmapClient(), search);

describe("a session in Files, start to finish", () => {
  it("browses, creates, uploads, renames, moves and deletes", async () => {
    const client = openDemo();

    // ── bootstrap: the session decides whether the section renders at all ──
    const session = await client.session();
    expect(hasCapability(session, FILENODE_CAP)).toBe(true);
    const accounts = filesAccounts(session);
    expect(accounts).toHaveLength(1);
    const accountId = accounts[0]!.id;

    // ── the root ────────────────────────────────────────────────────────
    let page = await loadDirectory(client, accountId, null);
    expect(page.refusal).toBeUndefined();
    expect(page.trail.crumbs.map((c) => c.name)).toEqual(["Files"]);
    const attachments = page.children.find((n) => n.role === "attachments")!;
    expect(attachments.name).toBe("Attachments");

    // ── into the sidestep's folder, which behaves like any other ────────
    page = await loadDirectory(client, accountId, attachments.id);
    expect(page.trail.crumbs.map((c) => c.name)).toEqual(["Files", "Attachments"]);
    expect(page.children.map((n) => n.name)).toContain("Q3 board deck.pdf");

    // ── two levels down, with a full breadcrumb ─────────────────────────
    const projects = (await loadDirectory(client, accountId, null)).children.find(
      (n) => n.name === "Projects",
    )!;
    const roadmap = (await loadDirectory(client, accountId, projects.id)).children.find(
      (n) => n.name === "2026 roadmap",
    )!;
    page = await loadDirectory(client, accountId, roadmap.id);
    expect(page.trail.crumbs.map((c) => c.name)).toEqual(["Files", "Projects", "2026 roadmap"]);

    // ── new folder, inside the folder currently open ────────────────────
    const made = await createFolder(client, accountId, roadmap.id, "  Invoices  ");
    expect(made.error).toBeUndefined();
    page = await loadDirectory(client, accountId, roadmap.id);
    const invoices = page.children.find((n) => n.id === made.id)!;
    expect(invoices.name).toBe("Invoices");
    expect(invoices.nodeType).toBe("directory");
    // Folders sort ahead of the two files already there.
    expect(page.children[0]!.name).toBe("Invoices");

    // ── upload two files with the SAME name in one batch ────────────────
    const files = [
      { name: "receipt.pdf", size: 3, type: "application/pdf", body: new Blob(["one"]) },
      { name: "receipt.pdf", size: 3, type: "application/pdf", body: new Blob(["two"]) },
    ];
    const planned = planUploads(
      files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      page.children,
    );
    expect(planned.map((p) => p.name)).toEqual(["receipt.pdf", "receipt (2).pdf"]);
    for (const [i, plan] of planned.entries()) {
      const result = await uploadFile(client, accountId, invoices.id, {
        name: plan.name,
        size: files[i]!.size,
        type: files[i]!.type,
        body: files[i]!.body,
      });
      expect(result.error, plan.name).toBeUndefined();
      expect(result.refusal, plan.name).toBeUndefined();
    }

    page = await loadDirectory(client, accountId, invoices.id);
    expect(page.children.map((n) => n.name)).toEqual(["receipt (2).pdf", "receipt.pdf"]);
    expect(page.total).toBe(2);

    // ── the bytes come back out ─────────────────────────────────────────
    const first = page.children.find((n) => n.name === "receipt.pdf")!;
    const got = await downloadNode(client, accountId, first);
    expect(new TextDecoder().decode(got.bytes)).toBe("one");

    // ── rename ──────────────────────────────────────────────────────────
    expect((await renameNode(client, accountId, first.id, "receipt-jan.pdf")).error).toBeUndefined();
    page = await loadDirectory(client, accountId, invoices.id);
    expect(page.children.map((n) => n.name)).toContain("receipt-jan.pdf");

    // ── move it up a level, choosing from the offered destinations ──────
    const { directories } = await loadDirectories(client, accountId);
    const renamed = page.children.find((n) => n.name === "receipt-jan.pdf")!;
    const targets = moveTargets(directories, renamed);
    expect(targets.some((t) => t.id === roadmap.id)).toBe(true);
    expect((await moveNode(client, accountId, renamed.id, roadmap.id)).error).toBeUndefined();
    page = await loadDirectory(client, accountId, roadmap.id);
    expect(page.children.map((n) => n.name)).toContain("receipt-jan.pdf");

    // ── delete a non-empty folder: refused once, then confirmed ─────────
    const refused = await destroyNode(client, accountId, invoices.id);
    expect(refused.error?.type).toBe("fileNodeHasChildren");
    expect((await destroyNode(client, accountId, invoices.id, true)).error).toBeUndefined();
    page = await loadDirectory(client, accountId, roadmap.id);
    expect(page.children.some((n) => n.id === invoices.id)).toBe(false);
    // …and the file that was moved OUT of it survived.
    expect(page.children.some((n) => n.name === "receipt-jan.pdf")).toBe(true);
  });
});

describe("the two honest degrades", () => {
  it("no capability: the section says so and offers nothing", async () => {
    // `?filecap=0` is the browser-drivable version of this — a server with no
    // Files realm. The gate is key PRESENCE, which is why the demo removes the
    // key rather than setting it false.
    const client = openDemo("?demo=1&filecap=0");
    const session = await client.session();

    // This is exactly the condition FilesApp renders `NO_CAPABILITY_NOTE` for,
    // and it fires BEFORE any request is made — nothing 400s, nothing is dead.
    expect(hasCapability(session, FILENODE_CAP)).toBe(false);
    expect(filesAccounts(session)).toEqual([]);
    expect(NO_CAPABILITY_NOTE).toMatch(/does not advertise/);
    expect(NO_CAPABILITY_NOTE).toMatch(/Nothing is broken/);
  });

  it("no `files` scope: reads still work, writes are refused with a sentence", async () => {
    const client = openDemo("?demo=1&readonly=1");
    const accountId = filesAccounts(await client.session())[0]!.id;

    // The drive is readable…
    const page = await loadDirectory(client, accountId, null);
    expect(page.refusal).toBeUndefined();
    expect(page.children.length).toBeGreaterThan(0);

    // …and every write comes back as one sentence, not an exception. The
    // island flips `writeRefused` on this and stops offering the controls.
    for (const attempt of [
      createFolder(client, accountId, null, "Archive"),
      renameNode(client, accountId, page.children[0]!.id, "Renamed"),
      moveNode(client, accountId, page.children[0]!.id, null),
      destroyNode(client, accountId, page.children[0]!.id),
    ]) {
      const result = await attempt;
      expect(result.refusal?.type).toBe("forbidden");
      expect(result.refusal?.message).toBe(NO_WRITE_SCOPE_NOTE);
    }
  });

  it("a read refusal empties the list without throwing", async () => {
    const client = new FakeJmapClient();
    const { installDemoFiles } = await import("./demoFiles");
    installDemoFiles(client, { canRead: false });
    const page = await loadDirectory(client, ACCOUNT, null);
    expect(page.refusal?.type).toBe("forbidden");
    expect(page.children).toEqual([]);
    expect(page.trail.crumbs).toHaveLength(1);
  });
});
