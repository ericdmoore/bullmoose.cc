import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import {
  applyTriage,
  archivePatch,
  describeRefusal,
  destroyEmails,
  flaggedPatch,
  movePatch,
  scopesForPatch,
  seenPatch,
  trashPatch,
} from "./triage";
import type { Email } from "./types";

const ACCOUNT = "acct-fake";

describe("patch construction", () => {
  it("marks read and unread with a keyword patch", () => {
    expect(seenPatch(true)).toEqual({ "keywords/$seen": true });
    expect(seenPatch(false)).toEqual({ "keywords/$seen": null });
  });

  it("flags and unflags", () => {
    expect(flaggedPatch(true)).toEqual({ "keywords/$flagged": true });
    expect(flaggedPatch(false)).toEqual({ "keywords/$flagged": null });
  });

  it("moves by adding the destination and removing every current mailbox at once", () => {
    // The server refuses a patch that would leave a message in no mailbox, so
    // the add and the removes have to travel together.
    const email = { mailboxIds: { "mb-inbox": true, "mb-project": true } } as Pick<Email, "mailboxIds">;
    expect(movePatch(email, "mb-archive")).toEqual({
      "mailboxIds/mb-archive": true,
      "mailboxIds/mb-inbox": null,
      "mailboxIds/mb-project": null,
    });
  });

  it("does not remove the destination it is adding", () => {
    const email = { mailboxIds: { "mb-archive": true } } as Pick<Email, "mailboxIds">;
    expect(movePatch(email, "mb-archive")).toEqual({ "mailboxIds/mb-archive": true });
  });

  it("archives out of the Inbox while keeping other filing", () => {
    const email = { mailboxIds: { "mb-inbox": true, "mb-project": true } } as Pick<Email, "mailboxIds">;
    expect(archivePatch(email, "mb-inbox", "mb-archive")).toEqual({
      "mailboxIds/mb-archive": true,
      "mailboxIds/mb-inbox": null,
    });
  });

  it("archives to nothing when Inbox and Archive are the same mailbox", () => {
    const email = { mailboxIds: { "mb-inbox": true } } as Pick<Email, "mailboxIds">;
    expect(archivePatch(email, "mb-inbox", "mb-inbox")).toEqual({});
  });

  it("treats delete as a MOVE to Trash, which is recoverable", () => {
    const email = { mailboxIds: { "mb-inbox": true } } as Pick<Email, "mailboxIds">;
    expect(trashPatch(email, "mb-trash")).toEqual({
      "mailboxIds/mb-trash": true,
      "mailboxIds/mb-inbox": null,
    });
  });
});

describe("scope prediction (mirror of requiredScopesForEmailSet)", () => {
  it("charges annotate for a keywords-only patch", () => {
    expect(scopesForPatch(seenPatch(true))).toEqual(["annotate"]);
  });

  it("charges move for a mailbox patch", () => {
    expect(scopesForPatch({ "mailboxIds/x": true })).toEqual(["move"]);
  });

  it("charges BOTH when a patch touches mailboxes and keywords", () => {
    // The server had this exact bug: a ternary charged only `move`, so a
    // move-scoped token could flip keywords for free by bundling them in.
    expect(scopesForPatch({ "mailboxIds/x": true, "keywords/$seen": true }).sort()).toEqual(["annotate", "move"]);
  });

  it("fails closed on an empty patch", () => {
    expect(scopesForPatch({})).toEqual(["annotate"]);
  });
});

describe("applyTriage", () => {
  it("triages a whole selection in ONE Email/set", async () => {
    const { client, emails } = createDemoBackend();
    const ids = emails.slice(0, 3).map((e) => e.id);
    const before = client.sentBatches.length;

    const result = await applyTriage(client, ACCOUNT, Object.fromEntries(ids.map((id) => [id, seenPatch(true)])));

    expect(client.sentBatches.length).toBe(before + 1);
    expect(client.sentBatches.at(-1)).toHaveLength(1);
    expect(result.updated.sort()).toEqual(ids.sort());
    for (const id of ids) expect(emails.find((e) => e.id === id)?.keywords.$seen).toBe(true);
  });

  it("archives a message out of the Inbox", async () => {
    const { client, emails } = createDemoBackend();
    const target = emails[0] as Email;
    await applyTriage(client, ACCOUNT, {
      [target.id]: archivePatch(target, "mb-inbox", "mb-archive"),
    });
    expect(target.mailboxIds["mb-archive"]).toBe(true);
    expect(target.mailboxIds["mb-inbox"]).toBeUndefined();
  });

  it("does nothing, and sends nothing, for an empty selection", async () => {
    const { client } = createDemoBackend();
    const result = await applyTriage(client, ACCOUNT, {});
    expect(result.updated).toEqual([]);
    expect(client.sentBatches).toHaveLength(0);
  });

  it("separates a per-id failure from a whole-call refusal", async () => {
    const { client, emails } = createDemoBackend();
    const good = (emails[0] as Email).id;
    const result = await applyTriage(client, ACCOUNT, {
      [good]: seenPatch(true),
      "e-does-not-exist": seenPatch(true),
    });
    expect(result.updated).toEqual([good]);
    expect(result.notUpdated).toEqual([{ id: "e-does-not-exist", type: "notFound" }]);
    expect(result.refusal).toBeUndefined();
  });

  it("refuses a keywords-only patch cleanly when the token lacks `annotate`", async () => {
    const { client, emails } = createDemoBackend({ scopes: ["read", "move"] });
    const target = emails[0] as Email;
    const result = await applyTriage(client, ACCOUNT, { [target.id]: flaggedPatch(true) });

    expect(result.updated).toEqual([]);
    expect(result.refusal?.type).toBe("forbidden");
    expect(result.refusal?.requiredScopes).toEqual(["annotate"]);
    expect(result.refusal?.message).toContain("annotate");
    // And nothing changed underneath.
    expect(target.keywords.$flagged).toBeUndefined();
  });

  it("refuses a move cleanly when the token has only `annotate`", async () => {
    const { client, emails } = createDemoBackend({ scopes: ["read", "annotate"] });
    const target = emails[0] as Email;
    const result = await applyTriage(client, ACCOUNT, {
      [target.id]: archivePatch(target, "mb-inbox", "mb-archive"),
    });
    expect(result.refusal?.requiredScopes).toEqual(["move"]);
    expect(target.mailboxIds["mb-inbox"]).toBe(true);
  });

  it("passes ifInState through so a stale view cannot clobber a concurrent change", async () => {
    const { client, emails } = createDemoBackend();
    await applyTriage(client, ACCOUNT, { [(emails[0] as Email).id]: seenPatch(true) }, { ifInState: "0" });
    const args = client.sentBatches.at(-1)?.[0]?.[1] as { ifInState?: string };
    expect(args.ifInState).toBe("0");
  });
});

describe("destroyEmails", () => {
  it("permanently removes messages and reports which", async () => {
    const { client, emails } = createDemoBackend();
    const id = (emails[0] as Email).id;
    const result = await destroyEmails(client, ACCOUNT, [id]);
    expect(result.updated).toEqual([id]);
    expect(emails.find((e) => e.id === id)).toBeUndefined();
  });

  it("refuses without the delete scope, naming it", async () => {
    const { client, emails } = createDemoBackend({ scopes: ["read", "annotate", "move"] });
    const id = (emails[0] as Email).id;
    const result = await destroyEmails(client, ACCOUNT, [id]);
    expect(result.refusal?.requiredScopes).toEqual(["delete"]);
    expect(emails.find((e) => e.id === id)).toBeDefined();
  });
});

describe("describeRefusal", () => {
  it("names the missing permission instead of echoing an error code", () => {
    const refusal = describeRefusal({ type: "forbidden" }, ["move"]);
    expect(refusal.message).toContain("“move”");
    expect(refusal.message).toContain("permission");
  });

  it("explains a state mismatch as something to retry", () => {
    expect(describeRefusal({ type: "stateMismatch" }, ["annotate"]).message).toMatch(/refresh/i);
  });

  it("falls back to the server's own description for anything else", () => {
    expect(describeRefusal({ type: "serverFail", description: "disk on fire" }, []).message).toBe("disk on fire");
  });
});
