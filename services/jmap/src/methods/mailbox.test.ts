import { describe, expect, it } from "vitest";
import { MethodRegistry, mailCapability } from "@bullmoose/jmap-core";
import { registerMailboxMethods, requiredScopesForMailboxSet } from "./mailbox";
import type { RequestContext } from "./common";
import type { Env } from "../index";

// Mailbox/set was the largest capability gap in the repo (sVOL 004): the
// session advertised maxMailboxDepth, maxSizeMailboxName and
// mayCreateTopLevelMailbox, and Mailbox/get returned mayCreateChild,
// mayRename and mayDelete: role === null, with NO method to act on any of
// it. These tests drive the registered method end-to-end — requireAccountScopes
// → Mailstore → AccountDO commit — against a stateful fake D1 and a fake DO
// that keeps a real changelog, so the assertions that matter are behavioural:
//
//   * a create must be visible to Mailbox/CHANGES, not just Mailbox/get.
//     A row that lands in D1 without commitChanges reads back fine on a
//     direct get and is invisible to every incremental consumer — that is
//     a write-path bug that presents as a sync bug (_context.md §3).
//   * destroying the Inbox must be refused and must leave it intact, or
//     ingest's ensureRoleMailbox silently re-creates it under a new id.
//   * the advertised limits must actually bite.
//
// Fakes are local and self-contained on purpose: sVOL 002 is consolidating
// the repo's four divergent fake-D1 helpers in parallel.

// ---- fakes ------------------------------------------------------------

interface MailboxRec {
  id: string;
  account_id: string;
  parent_id: string | null;
  name: string;
  role: string | null;
  sort_order: number;
}

interface EmailRec {
  id: string;
  account_id: string;
  blob_id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  subject: string;
  from_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  preview: string;
  size: number;
  received_at: number;
  has_attachment: number;
  attachments_json: string;
}

interface Tables {
  mailboxes: MailboxRec[];
  emails: EmailRec[];
  email_mailboxes: Array<{ account_id: string; email_id: string; mailbox_id: string }>;
  email_keywords: Array<{ account_id: string; email_id: string; keyword: string }>;
}

/**
 * A STATEFUL fake D1: writes mutate the tables so a later read sees them.
 * That is load-bearing here — half these tests assert on what survived a
 * failed operation, which a write-recording fake cannot express.
 */
function fakeD1(tables: Tables) {
  const idsIn = (sql: string, args: unknown[], fixed: number): string[] =>
    sql.includes(" IN (") ? (args.slice(fixed) as string[]) : [];

  /**
   * Writes. Split from the reads because "DELETE FROM mailboxes" also
   * contains "FROM mailboxes" — a substring router that tests the SELECT
   * shapes first silently turns every delete into a no-op read, and the
   * suite then passes against a method that deletes nothing.
   */
  const mutate = (sql: string, args: unknown[]): { results: unknown[] } => {
    if (sql.startsWith("INSERT INTO mailboxes")) {
      const [id, account_id, parent_id, name, role, sort_order] = args as [
        string,
        string,
        string | null,
        string,
        string | null,
        number,
      ];
      // data-plane.sql: CREATE UNIQUE INDEX mailboxes_role ON
      // mailboxes (account_id, role) WHERE role IS NOT NULL.
      if (role !== null && tables.mailboxes.some((m) => m.account_id === account_id && m.role === role)) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: mailboxes.account_id, mailboxes.role");
      }
      tables.mailboxes.push({ id, account_id, parent_id, name, role, sort_order });
      return { results: [] };
    }
    if (sql.startsWith("UPDATE mailboxes SET")) {
      const cols = (/SET ([\s\S]*?) WHERE/.exec(sql)?.[1] ?? "")
        .split(",")
        .map((c) => c.trim().split(" ")[0]!);
      const id = args[args.length - 1] as string;
      const accountId = args[args.length - 2] as string;
      const row = tables.mailboxes.find((m) => m.account_id === accountId && m.id === id);
      if (row) cols.forEach((c, i) => ((row as unknown as Record<string, unknown>)[c] = args[i]));
      return { results: [] };
    }
    if (sql.startsWith("DELETE FROM mailboxes")) {
      const [accountId, id] = args as [string, string];
      tables.mailboxes = tables.mailboxes.filter(
        (m) => !(m.account_id === accountId && m.id === id),
      );
      return { results: [] };
    }
    if (sql.startsWith("INSERT INTO email_mailboxes")) {
      const [account_id, email_id, mailbox_id] = args as [string, string, string];
      tables.email_mailboxes.push({ account_id, email_id, mailbox_id });
      return { results: [] };
    }
    if (sql.startsWith("DELETE FROM email_mailboxes")) {
      const [accountId, emailId] = args as [string, string];
      tables.email_mailboxes = tables.email_mailboxes.filter(
        (r) => !(r.account_id === accountId && r.email_id === emailId),
      );
      return { results: [] };
    }
    if (sql.startsWith("DELETE FROM email_keywords")) {
      const [accountId, emailId] = args as [string, string];
      tables.email_keywords = tables.email_keywords.filter(
        (r) => !(r.account_id === accountId && r.email_id === emailId),
      );
      return { results: [] };
    }
    if (sql.startsWith("DELETE FROM emails")) {
      const [accountId, id] = args as [string, string];
      tables.emails = tables.emails.filter((e) => !(e.account_id === accountId && e.id === id));
      return { results: [] };
    }
    throw new Error(`fake D1: unrouted write: ${sql}`);
  };

  const exec = (sql: string, args: unknown[]): { results: unknown[] } => {
    const acct = args[0] as string;

    if (sql.startsWith("INSERT") || sql.startsWith("UPDATE") || sql.startsWith("DELETE")) {
      return mutate(sql, args);
    }

    // -- mailboxes --
    if (sql.includes("FROM mailboxes")) {
      const wanted = idsIn(sql, args, 1);
      let rows = tables.mailboxes.filter((m) => m.account_id === acct);
      if (sql.includes("AND role = ?")) rows = rows.filter((m) => m.role === args[1]);
      else if (wanted.length > 0) rows = rows.filter((m) => wanted.includes(m.id));
      rows = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      return { results: rows };
    }

    // -- email_mailboxes --
    if (sql.includes("SELECT email_id FROM email_mailboxes")) {
      const [accountId, mailboxId] = args as [string, string];
      return {
        results: tables.email_mailboxes
          .filter((r) => r.account_id === accountId && r.mailbox_id === mailboxId)
          .map((r) => ({ email_id: r.email_id })),
      };
    }
    if (sql.includes("SELECT email_id, mailbox_id FROM email_mailboxes")) {
      const wanted = idsIn(sql, args, 1);
      return {
        results: tables.email_mailboxes.filter(
          (r) => r.account_id === acct && wanted.includes(r.email_id),
        ),
      };
    }

    // -- email_keywords --
    if (sql.includes("SELECT email_id, keyword FROM email_keywords")) {
      const wanted = idsIn(sql, args, 1);
      return {
        results: tables.email_keywords.filter(
          (r) => r.account_id === acct && wanted.includes(r.email_id),
        ),
      };
    }

    // -- emails --
    if (sql.includes("FROM emails WHERE account_id")) {
      const wanted = idsIn(sql, args, 1);
      return { results: tables.emails.filter((e) => e.account_id === acct && wanted.includes(e.id)) };
    }

    // -- Mailbox/get counts --
    if (sql.includes("FROM email_mailboxes em")) {
      const [accountId, mailboxId] = args as [string, string];
      const inBox = tables.email_mailboxes.filter(
        (r) => r.account_id === accountId && r.mailbox_id === mailboxId,
      );
      const unread = inBox.filter(
        (r) =>
          !tables.email_keywords.some(
            (k) => k.account_id === accountId && k.email_id === r.email_id && k.keyword === "$seen",
          ),
      ).length;
      return { results: [{ total: inBox.length, unread }] };
    }

    return { results: [] };
  };

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    return {
      sql,
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        return (exec(sql, bound).results[0] as Record<string, unknown> | undefined) ?? null;
      },
      async all() {
        return exec(sql, bound);
      },
      async run() {
        exec(sql, bound);
        return { meta: { changes: 1 } };
      },
      _exec: () => exec(sql, bound),
    };
  };

  const batch = async (stmts: Array<{ _exec: () => { results: unknown[] } }>) =>
    stmts.map((s) => s._exec());

  return { prepare, batch };
}

interface LogEntry {
  seq: number;
  collection: string;
  created: string[];
  updated: string[];
  destroyed: string[];
}

/**
 * AccountDO stand-in with a REAL changelog: /commit appends and bumps the
 * state, /changes replays entries after `since`. Without this the "is the
 * write visible to Mailbox/changes" assertion could not be written, and
 * that is the assertion that catches a skipped commitChanges — a passing
 * Mailbox/get proves only that the row exists, which is exactly what the
 * broken version also proves.
 */
function fakeAccountDo() {
  const log: LogEntry[] = [];
  let seq = 0;

  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/state") return json({ state: String(seq) });
      if (url.pathname === "/commit") {
        const body = JSON.parse(String(init?.body)) as {
          entries: Array<{
            collection: string;
            created?: string[];
            updated?: string[];
            destroyed?: string[];
          }>;
        };
        const oldState = String(seq);
        seq++;
        for (const e of body.entries) {
          log.push({
            seq,
            collection: e.collection,
            created: e.created ?? [],
            updated: e.updated ?? [],
            destroyed: e.destroyed ?? [],
          });
        }
        return json({ oldState, newState: String(seq) });
      }
      if (url.pathname === "/changes") {
        const collection = url.searchParams.get("collection");
        const since = Number(url.searchParams.get("since"));
        const after = log.filter((e) => e.seq > since && e.collection === collection);
        return json({
          oldState: String(since),
          newState: String(seq),
          hasMoreChanges: false,
          created: after.flatMap((e) => e.created),
          updated: after.flatMap((e) => e.updated),
          destroyed: after.flatMap((e) => e.destroyed),
        });
      }
      return new Response("not found", { status: 404 });
    },
  };

  return { ns: { idFromName: (n: string) => n, get: () => stub }, log };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

// ---- fixtures ---------------------------------------------------------

const ACCOUNT = "t_bm__a_eric";

const mb = (over: Partial<MailboxRec> & { id: string; name: string }): MailboxRec => ({
  account_id: ACCOUNT,
  parent_id: null,
  role: null,
  sort_order: 0,
  ...over,
});

const INBOX = mb({ id: "mb_inbox", name: "Inbox", role: "inbox" });
const ARCHIVE = mb({ id: "mb_archive", name: "Archive", role: "archive" });

const emailRec = (id: string): EmailRec => ({
  id,
  account_id: ACCOUNT,
  blob_id: `b_${id}`,
  thread_id: `t_${id}`,
  message_id: `<${id}@bullmoose.cc>`,
  in_reply_to: null,
  subject: "hi",
  from_json: "[]",
  to_json: "[]",
  cc_json: "[]",
  bcc_json: "[]",
  preview: "hi",
  size: 10,
  received_at: 1,
  has_attachment: 0,
  attachments_json: "[]",
});

function harness(seed: Partial<Tables> = {}, scopes: string[] = ["mail"]) {
  const tables: Tables = {
    mailboxes: seed.mailboxes ?? [{ ...INBOX }, { ...ARCHIVE }],
    emails: seed.emails ?? [],
    email_mailboxes: seed.email_mailboxes ?? [],
    email_keywords: seed.email_keywords ?? [],
  };
  const db = fakeD1(tables);
  const doNs = fakeAccountDo();

  const registry = new MethodRegistry<RequestContext>();
  registerMailboxMethods(registry);

  const ctx: RequestContext = {
    env: {
      DB: db,
      BLOBS: {},
      ACCOUNT_DO: doNs.ns,
    } as unknown as Env,
    principal: {
      username: "eric@moore.coffee",
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };

  const call = (name: string, args: Record<string, unknown> = {}) =>
    registry.get(name)!({ accountId: ACCOUNT, ...args }, ctx);

  return {
    tables,
    log: doNs.log,
    set: (args: Record<string, unknown>) => call("Mailbox/set", args),
    get: () => call("Mailbox/get", { ids: null }),
    changes: (sinceState: string) => call("Mailbox/changes", { sinceState }),
    state: () => call("Mailbox/get", { ids: [] }).then((r) => String(r.state)),
  };
}

type SetRes = Record<string, unknown>;
/** A missing entry surfaces as `type: undefined`, which fails readably. */
type Err = { type?: string; description?: string };
const errAt = (bag: unknown, key: string): Err => (bag as Record<string, Err>)[key] ?? {};
const notCreated = (r: SetRes, cid: string): Err => errAt(r.notCreated, cid);
const notUpdated = (r: SetRes, id: string): Err => errAt(r.notUpdated, id);
const notDestroyed = (r: SetRes, id: string): Err => errAt(r.notDestroyed, id);
const createdId = (r: SetRes, cid: string) =>
  (r.created as Record<string, { id: string }>)[cid]?.id;

// ---- the gap this unit closes -----------------------------------------

describe("Mailbox/set is registered at all", () => {
  it("exists — folders were frozen at the six seeded role mailboxes", () => {
    const registry = new MethodRegistry<RequestContext>();
    registerMailboxMethods(registry);
    expect(registry.get("Mailbox/set")).toBeDefined();
  });
});

describe("Mailbox/set — create", () => {
  it("creates a top-level mailbox and reports it through Mailbox/changes", async () => {
    // done-when #2: the assertion that catches a raw-SQL / skipped-
    // choreography shortcut. Mailbox/get passing proves only that the row
    // exists — which is exactly what the broken version also proves.
    const h = harness();
    const before = await h.state();

    const res = await h.set({ create: { c1: { name: "Receipts" } } });
    const id = createdId(res, "c1");

    expect(res.notCreated).toEqual({});
    expect(id).toMatch(/^mb_/);
    expect(res.newState).not.toBe(before);

    const list = (await h.get()).list as Array<{ id: string; name: string }>;
    expect(list.find((m) => m.id === id)?.name).toBe("Receipts");

    const delta = await h.changes(before);
    expect(delta.created).toContain(id);
  });

  it("nests under a parent, including one created in the same call", async () => {
    const h = harness();
    const res = await h.set({
      create: {
        c1: { name: "Receipts" },
        c2: { name: "2026", parentId: "#c1" },
      },
    });

    expect(res.notCreated).toEqual({});
    const parent = createdId(res, "c1");
    const child = createdId(res, "c2");
    const list = (await h.get()).list as Array<{ id: string; parentId: string | null }>;
    expect(list.find((m) => m.id === child)?.parentId).toBe(parent);
  });

  it("rejects a parentId that names no mailbox", async () => {
    const h = harness();
    const res = await h.set({ create: { c1: { name: "X", parentId: "mb_nope" } } });
    expect(notCreated(res, "c1").type).toBe("invalidProperties");
    expect(h.tables.mailboxes).toHaveLength(2);
  });

  it("rejects server-set properties rather than silently dropping them", async () => {
    const h = harness();
    const res = await h.set({ create: { c1: { name: "X", id: "mb_mine" } } });
    expect(notCreated(res, "c1").type).toBe("invalidProperties");
  });

  it("accepts a role on create but refuses one already taken", async () => {
    const h = harness();
    const res = await h.set({
      create: {
        ok: { name: "Spam", role: "junk" },
        clash: { name: "Second Inbox", role: "inbox" },
        bogus: { name: "Weird", role: "nonsense" },
      },
    });
    expect(createdId(res, "ok")).toMatch(/^mb_/);
    expect(notCreated(res, "clash").type).toBe("invalidProperties");
    expect(notCreated(res, "bogus").type).toBe("invalidProperties");
  });

  it("maps a raw UNIQUE-constraint failure to invalidProperties, not serverFail", async () => {
    // The in-memory pre-check normally catches a role clash; this is the
    // race path, where SQLite's mailboxes_role index raises instead.
    const h = harness({ mailboxes: [] });
    const res = await h.set({
      create: { a: { name: "In", role: "inbox" }, b: { name: "In2", role: "inbox" } },
    });
    expect(createdId(res, "a")).toMatch(/^mb_/);
    expect(notCreated(res, "b").type).toBe("invalidProperties");
  });
});

describe("Mailbox/set — the advertised limits are now enforced", () => {
  it(`refuses a name longer than maxSizeMailboxName (${mailCapability.maxSizeMailboxName} octets)`, async () => {
    const h = harness();
    const res = await h.set({
      create: {
        ok: { name: "x".repeat(mailCapability.maxSizeMailboxName) },
        tooLong: { name: "x".repeat(mailCapability.maxSizeMailboxName + 1) },
      },
    });
    expect(res.notCreated).toHaveProperty("tooLong");
    expect(notCreated(res, "tooLong").type).toBe("invalidProperties");
    expect(createdId(res, "ok")).toMatch(/^mb_/);
  });

  it("measures the name limit in OCTETS, not UTF-16 code units", async () => {
    const h = harness();
    // "é" is 2 octets; 101 of them is 202 > 200 but only 101 characters.
    const res = await h.set({ create: { c1: { name: "é".repeat(101) } } });
    expect(notCreated(res, "c1").type).toBe("invalidProperties");
  });

  it(`refuses a child deeper than maxMailboxDepth (${mailCapability.maxMailboxDepth})`, async () => {
    // A legal chain exactly maxMailboxDepth deep, then one more.
    const chain: MailboxRec[] = [];
    for (let i = 0; i < mailCapability.maxMailboxDepth; i++) {
      chain.push(
        mb({ id: `mb_d${i}`, name: `d${i}`, parent_id: i === 0 ? null : `mb_d${i - 1}` }),
      );
    }
    const h = harness({ mailboxes: chain });

    const res = await h.set({
      create: {
        tooDeep: { name: "over", parentId: `mb_d${mailCapability.maxMailboxDepth - 1}` },
        fits: { name: "under", parentId: `mb_d${mailCapability.maxMailboxDepth - 2}` },
      },
    });

    expect(notCreated(res, "tooDeep").type).toBe("invalidProperties");
    expect(createdId(res, "fits")).toMatch(/^mb_/);
  });

  it("counts the whole moved SUBTREE against the depth limit, not just the node", async () => {
    // parent chain 9 deep + a 2-tall subtree at the top: moving the subtree
    // under d8 would put its child at depth 11.
    const rows: MailboxRec[] = [];
    for (let i = 0; i < 9; i++) {
      rows.push(mb({ id: `mb_d${i}`, name: `d${i}`, parent_id: i === 0 ? null : `mb_d${i - 1}` }));
    }
    rows.push(mb({ id: "mb_top", name: "top" }), mb({ id: "mb_kid", name: "kid", parent_id: "mb_top" }));
    const h = harness({ mailboxes: rows });

    const res = await h.set({ update: { mb_top: { parentId: "mb_d8" } } });

    expect(notUpdated(res, "mb_top").type).toBe("invalidProperties");
    expect(h.tables.mailboxes.find((m) => m.id === "mb_top")?.parent_id).toBeNull();
  });
});

describe("Mailbox/set — sibling name uniqueness (RFC 8621 §2.5)", () => {
  it("refuses a duplicate name under the same parent, case-insensitively", async () => {
    const h = harness();
    const res = await h.set({ create: { c1: { name: "inbox" } } });
    expect(notCreated(res, "c1").type).toBe("invalidProperties");
  });

  it("allows the same name under a different parent", async () => {
    const h = harness();
    const res = await h.set({
      create: {
        p: { name: "Receipts" },
        c: { name: "Inbox", parentId: "#p" },
      },
    });
    expect(res.notCreated).toEqual({});
  });

  it("checks against the POST-mutation sibling set within one call", async () => {
    // Two creations racing for the same name: the first wins, the second
    // must lose against a sibling that did not exist when the call began.
    const h = harness();
    const res = await h.set({ create: { a: { name: "Receipts" }, b: { name: "receipts" } } });
    expect(createdId(res, "a")).toMatch(/^mb_/);
    expect(notCreated(res, "b").type).toBe("invalidProperties");
  });

  it("lets a rename take a name a sibling vacated earlier in the same call", async () => {
    const rows = [mb({ id: "mb_a", name: "Alpha" }), mb({ id: "mb_b", name: "Beta" })];
    const h = harness({ mailboxes: rows });
    const res = await h.set({
      update: { mb_a: { name: "Gamma" }, mb_b: { name: "Alpha" } },
    });
    expect(res.notUpdated).toEqual({});
    expect(h.tables.mailboxes.find((m) => m.id === "mb_b")?.name).toBe("Alpha");
  });
});

describe("Mailbox/set — update: rename, reparent, reorder", () => {
  it("renames a role mailbox — the role is the contract, the name is a label", async () => {
    const h = harness();
    const res = await h.set({ update: { mb_trash: { name: "Bin" } } });
    expect(notUpdated(res, "mb_trash").type).toBe("notFound");

    const h2 = harness({ mailboxes: [mb({ id: "mb_trash", name: "Trash", role: "trash" })] });
    const ok = await h2.set({ update: { mb_trash: { name: "Bin" } } });
    expect(ok.notUpdated).toEqual({});
    const row = h2.tables.mailboxes.find((m) => m.id === "mb_trash");
    expect(row?.name).toBe("Bin");
    expect(row?.role).toBe("trash");
  });

  it("refuses to change role — re-roling launders a custom folder into the Inbox", async () => {
    const h = harness();
    const res = await h.set({ update: { mb_archive: { role: "inbox" } } });
    expect(notUpdated(res, "mb_archive").type).toBe("invalidProperties");
    expect(h.tables.mailboxes.find((m) => m.id === "mb_archive")?.role).toBe("archive");
  });

  it("reparents, and reports the update through Mailbox/changes", async () => {
    const rows = [mb({ id: "mb_a", name: "Alpha" }), mb({ id: "mb_b", name: "Beta" })];
    const h = harness({ mailboxes: rows });
    const before = await h.state();

    const res = await h.set({ update: { mb_b: { parentId: "mb_a", sortOrder: 3 } } });

    expect(res.notUpdated).toEqual({});
    const row = h.tables.mailboxes.find((m) => m.id === "mb_b");
    expect(row?.parent_id).toBe("mb_a");
    expect(row?.sort_order).toBe(3);
    expect((await h.changes(before)).updated).toContain("mb_b");
  });

  it("refuses a self-parent and a longer cycle", async () => {
    const rows = [
      mb({ id: "mb_a", name: "Alpha" }),
      mb({ id: "mb_b", name: "Beta", parent_id: "mb_a" }),
      mb({ id: "mb_c", name: "Gamma", parent_id: "mb_b" }),
    ];
    const h = harness({ mailboxes: rows });

    const self = await h.set({ update: { mb_a: { parentId: "mb_a" } } });
    expect(notUpdated(self, "mb_a").type).toBe("invalidProperties");

    const loop = await h.set({ update: { mb_a: { parentId: "mb_c" } } });
    expect(notUpdated(loop, "mb_a").type).toBe("invalidProperties");
    expect(h.tables.mailboxes.find((m) => m.id === "mb_a")?.parent_id).toBeNull();
  });

  it("refuses an unknown patch path and a bad sortOrder", async () => {
    const h = harness();
    const res = await h.set({
      update: { mb_archive: { colour: "red" }, mb_inbox: { sortOrder: -1 } },
    });
    expect(notUpdated(res, "mb_archive").type).toBe("invalidProperties");
    expect(notUpdated(res, "mb_inbox").type).toBe("invalidProperties");
  });

  it("refuses isSubscribed: false rather than accepting a property it discards", async () => {
    const h = harness();
    const res = await h.set({ update: { mb_archive: { isSubscribed: false } } });
    expect(notUpdated(res, "mb_archive").type).toBe("invalidProperties");
    // true is a no-op, not an error: Mailbox/get hardcodes isSubscribed true.
    const ok = await h.set({ update: { mb_archive: { isSubscribed: true } } });
    expect(ok.notUpdated).toEqual({});
  });
});

describe("Mailbox/set — destroy", () => {
  it("refuses to destroy a role mailbox and leaves it intact", async () => {
    // done-when #3. Destroy the Inbox and ingest's ensureRoleMailbox
    // re-creates it under a NEW id on the next delivery, orphaning every
    // client that cached the old one. Mailbox/get has always promised
    // mayDelete: role === null; this is where that becomes true.
    const h = harness();
    const res = await h.set({ destroy: ["mb_inbox"] });

    expect(res.destroyed).toEqual([]);
    expect(notDestroyed(res, "mb_inbox").type).toBe("forbidden");
    expect(notDestroyed(res, "mb_inbox").description).toContain("inbox");
    expect(h.tables.mailboxes.find((m) => m.id === "mb_inbox")).toBeDefined();

    const rights = ((await h.get()).list as Array<{ id: string; myRights: { mayDelete: boolean } }>)
      .find((m) => m.id === "mb_inbox")?.myRights;
    expect(rights?.mayDelete).toBe(false);
  });

  it("refuses to destroy a mailbox that has children", async () => {
    const rows = [
      mb({ id: "mb_p", name: "Parent" }),
      mb({ id: "mb_c", name: "Child", parent_id: "mb_p" }),
    ];
    const h = harness({ mailboxes: rows });
    const res = await h.set({ destroy: ["mb_p"] });

    expect(notDestroyed(res, "mb_p").type).toBe("mailboxHasChild");
    expect(h.tables.mailboxes).toHaveLength(2);
  });

  it("destroys an empty custom mailbox and reports it through Mailbox/changes", async () => {
    const h = harness({ mailboxes: [{ ...INBOX }, mb({ id: "mb_x", name: "Receipts" })] });
    const before = await h.state();

    const res = await h.set({ destroy: ["mb_x"] });

    expect(res.destroyed).toEqual(["mb_x"]);
    expect(h.tables.mailboxes.find((m) => m.id === "mb_x")).toBeUndefined();
    expect((await h.changes(before)).destroyed).toContain("mb_x");
  });

  it("refuses a mailbox holding mail without onDestroyRemoveEmails", async () => {
    const h = harness({
      mailboxes: [{ ...INBOX }, mb({ id: "mb_x", name: "Receipts" })],
      emails: [emailRec("e_1")],
      email_mailboxes: [{ account_id: ACCOUNT, email_id: "e_1", mailbox_id: "mb_x" }],
    });

    const res = await h.set({ destroy: ["mb_x"] });

    expect(notDestroyed(res, "mb_x").type).toBe("mailboxHasEmail");
    expect(h.tables.mailboxes.find((m) => m.id === "mb_x")).toBeDefined();
    expect(h.tables.emails).toHaveLength(1);
  });

  it("with onDestroyRemoveEmails destroys mail that is in no other mailbox, leaving no orphan rows", async () => {
    // done-when #4. A destroy that only ran DELETE FROM email_mailboxes
    // would leave `emails` rows that no query reaches and no client can
    // delete, because applyEmailPatch declares a mailbox-less email invalid.
    const h = harness({
      mailboxes: [{ ...INBOX }, mb({ id: "mb_x", name: "Receipts" })],
      emails: [emailRec("e_1")],
      email_mailboxes: [{ account_id: ACCOUNT, email_id: "e_1", mailbox_id: "mb_x" }],
      email_keywords: [{ account_id: ACCOUNT, email_id: "e_1", keyword: "$seen" }],
    });
    const before = await h.state();

    const res = await h.set({ destroy: ["mb_x"], onDestroyRemoveEmails: true });

    expect(res.destroyed).toEqual(["mb_x"]);
    expect(h.tables.emails).toEqual([]);
    expect(h.tables.email_mailboxes).toEqual([]);
    expect(h.tables.email_keywords).toEqual([]);

    // ...and the destroyed mail is reported in the SAME commit, so an
    // incremental client learns the messages are gone.
    const emailDelta = h.log.filter((e) => e.collection === "Email" && e.seq > Number(before));
    expect(emailDelta.flatMap((e) => e.destroyed)).toEqual(["e_1"]);
  });

  it("only UNFILES mail that is also in another mailbox — it does not destroy it", async () => {
    // maxMailboxesPerEmail is null: a message may live in several folders,
    // and removing one of them must not take the message with it.
    const h = harness({
      mailboxes: [{ ...INBOX }, mb({ id: "mb_x", name: "Receipts" })],
      emails: [emailRec("e_1")],
      email_mailboxes: [
        { account_id: ACCOUNT, email_id: "e_1", mailbox_id: "mb_x" },
        { account_id: ACCOUNT, email_id: "e_1", mailbox_id: "mb_inbox" },
      ],
    });

    const res = await h.set({ destroy: ["mb_x"], onDestroyRemoveEmails: true });

    expect(res.destroyed).toEqual(["mb_x"]);
    expect(h.tables.emails).toHaveLength(1);
    expect(h.tables.email_mailboxes).toEqual([
      { account_id: ACCOUNT, email_id: "e_1", mailbox_id: "mb_inbox" },
    ]);
  });
});

describe("Mailbox/set — batch and state semantics", () => {
  it("fails one object without taking the rest of the batch down", async () => {
    // done-when #5: all three limit violations arrive as per-object
    // SetErrors, with the good creations still landing.
    const h = harness();
    const res = await h.set({
      create: {
        good: { name: "Receipts" },
        dup: { name: "Archive" },
        noParent: { name: "Orphan", parentId: "mb_ghost" },
      },
      destroy: ["mb_inbox"],
    });

    expect(createdId(res, "good")).toMatch(/^mb_/);
    expect(Object.keys(res.notCreated as object).sort()).toEqual(["dup", "noParent"]);
    expect(Object.keys(res.notDestroyed as object)).toEqual(["mb_inbox"]);
  });

  it("honours ifInState", async () => {
    const h = harness();
    await expect(
      h.set({ ifInState: "not-the-state", create: { c1: { name: "X" } } }),
    ).rejects.toMatchObject({ type: "stateMismatch" });
    expect(h.tables.mailboxes).toHaveLength(2);
  });

  it("does not burn a state bump on a no-op call", async () => {
    const h = harness();
    const before = await h.state();
    const res = await h.set({});
    expect(res.newState).toBe(before);
    expect(h.log).toEqual([]);
  });
});

// ---- the scope gate ---------------------------------------------------

describe("requiredScopesForMailboxSet", () => {
  it("charges move for a create — not draft, which is compose", () => {
    const scopes = requiredScopesForMailboxSet({ create: { c1: { name: "X" } } });
    expect(scopes).toEqual(["move"]);
    expect(scopes).not.toContain("draft");
  });

  it("charges move for an update", () => {
    expect(requiredScopesForMailboxSet({ update: { mb_1: { name: "X" } } })).toEqual(["move"]);
  });

  it("charges delete for a destroy — onDestroyRemoveEmails destroys mail", () => {
    const scopes = requiredScopesForMailboxSet({ destroy: ["mb_1"] });
    expect(scopes).toEqual(["delete"]);
    expect(scopes).not.toContain("move");
  });

  it("charges both for a mixed call", () => {
    expect(
      requiredScopesForMailboxSet({ create: { c1: {} }, destroy: ["mb_1"] }).sort(),
    ).toEqual(["delete", "move"]);
  });

  it("asks for nothing on an empty call", () => {
    expect(requiredScopesForMailboxSet({})).toEqual([]);
    expect(requiredScopesForMailboxSet({ create: {}, destroy: [] })).toEqual([]);
  });
});

describe("Mailbox/set — the gate bites", () => {
  it("refuses a read-only token", async () => {
    // done-when #6.
    const h = harness({}, ["read"]);
    await expect(h.set({ create: { c1: { name: "Receipts" } } })).rejects.toMatchObject({
      type: "forbidden",
    });
    expect(h.tables.mailboxes).toHaveLength(2);
  });

  it("refuses a draft-scoped token — composing is not folder management", async () => {
    const h = harness({}, ["read", "annotate", "draft"]);
    await expect(h.set({ create: { c1: { name: "Receipts" } } })).rejects.toMatchObject({
      type: "forbidden",
    });
  });

  it("refuses a move-scoped token a DESTROY, which can remove mail", async () => {
    const h = harness({ mailboxes: [{ ...INBOX }, mb({ id: "mb_x", name: "Receipts" })] }, ["move"]);
    await expect(h.set({ destroy: ["mb_x"] })).rejects.toMatchObject({ type: "forbidden" });
    expect(h.tables.mailboxes).toHaveLength(2);

    // ...but allows it the create, so the split is real in both directions.
    const ok = await h.set({ create: { c1: { name: "Later" } } });
    expect(ok.notCreated).toEqual({});
  });
});
