import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { Mailstore, ftsMatchQuery, FTS_BODY_LIMIT, type NewEmail } from "./index";

/**
 * Full-text search over `emails_fts` (common/004).
 *
 * Before this, `emails_fts` was declared in the schema and written by nobody:
 * `Email/query`'s `text` condition was a leading-wildcard LIKE over
 * subject/preview/from_json/to_json. That had two costs — a full table scan per
 * search, and message BODIES that were not searchable at all past the 256-char
 * preview.
 *
 * These tests run real `node:sqlite` on the live `data-plane.sql`, so the FTS5
 * table under test is the table wrangler applies. Two things they pin that a
 * mock could not: that FTS5 with `contentless_delete=1` is actually available
 * (the whole design rests on it), and that a destroyed message really leaves
 * the index.
 */

const ACCOUNT = "t_bm__a_fts";
const OTHER = "t_bm__a_other";

function store() {
  const { db, env } = fakeEnv();
  return { db, store: new Mailstore(db, env.BLOBS) };
}

let seq = 0;
const email = (over: Partial<NewEmail> = {}): NewEmail => ({
  id: `e_${++seq}`,
  blobId: "b_1",
  threadId: `th_${seq}`,
  messageId: null,
  inReplyTo: null,
  subject: "Weekly status",
  from: [{ name: "Ada Lovelace", email: "ada@example.test" }],
  to: [{ email: "team@example.test" }],
  cc: [],
  bcc: [],
  preview: "",
  size: 1024,
  receivedAt: 1_700_000_000_000 + seq,
  hasAttachment: false,
  attachments: [],
  mailboxIds: ["mb_inbox"],
  keywords: [],
  ...over,
});

const search = async (s: Mailstore, text: string, accountId = ACCOUNT) =>
  (await s.queryEmails(accountId, { filter: { text } })).ids;

// ---- the headline: bodies are searchable now -----------------------------

describe("body text", () => {
  it("finds a word that appears ONLY in the body — the gap common/004 was filed for", async () => {
    const { store: s } = store();
    await s.insertEmail(ACCOUNT, {
      ...email({ subject: "Weekly status", preview: "Nothing to see in the first line." }),
      // 300 chars of filler, so `chandelier` sits well past the 256-char
      // preview cut that used to be the whole searchable body.
      bodyText: `${"filler ".repeat(50)}chandelier`,
    });

    expect(await search(s, "chandelier")).toHaveLength(1);
  });

  it("still finds subject, sender and recipient hits — no regression on the LIKE it replaces", async () => {
    const { store: s } = store();
    const id = email({
      subject: "Quarterly planning",
      from: [{ name: "Grace Hopper", email: "grace@example.test" }],
      to: [{ email: "board@example.test" }],
      bodyText: "unrelated body",
    });
    await s.insertEmail(ACCOUNT, id);

    expect(await search(s, "Quarterly")).toEqual([id.id]);
    expect(await search(s, "grace@example.test")).toEqual([id.id]);
    expect(await search(s, "Grace Hopper")).toEqual([id.id]);
    expect(await search(s, "board@example.test")).toEqual([id.id]);
    // cc is matched too — JMAP's `text` is "any address".
    expect(await search(s, "nobody@example.test")).toEqual([]);
  });

  it("indexes cc addresses", async () => {
    const { store: s } = store();
    const e = email({ cc: [{ name: "Alan Turing", email: "alan@example.test" }] });
    await s.insertEmail(ACCOUNT, e);
    expect(await search(s, "alan@example.test")).toEqual([e.id]);
  });

  it("falls back to preview when a caller supplies no bodyText", async () => {
    // Every pre-common/004 call site still compiles and still gets the old
    // coverage rather than an empty index entry.
    const { store: s } = store();
    const e = email({ preview: "budget approved by finance", subject: "Re:" });
    await s.insertEmail(ACCOUNT, e);
    expect(await search(s, "budget")).toEqual([e.id]);
  });

  it("truncates a pathological body at FTS_BODY_LIMIT", async () => {
    const { store: s } = store();
    const e = email({ bodyText: `haystack ${"a ".repeat(FTS_BODY_LIMIT)}needle` });
    await s.insertEmail(ACCOUNT, e);
    // Everything inside the cut is indexed…
    expect(await search(s, "haystack")).toEqual([e.id]);
    // …and the word past it is not, deliberately and documented.
    expect(await search(s, "needle")).toEqual([]);
  });
});

// ---- index consistency ---------------------------------------------------

describe("index consistency", () => {
  it("removes the index row when a message is destroyed", async () => {
    const { db, store: s } = store();
    const e = email({ bodyText: "the manuscript is in the vault" });
    await s.insertEmail(ACCOUNT, e);
    expect(await search(s, "manuscript")).toEqual([e.id]);

    await s.destroyEmail(ACCOUNT, e.id);

    expect(await search(s, "manuscript")).toEqual([]);
    // Not merely filtered out by the join — the rows are gone.
    expect(db.count("emails_fts_map", "email_id = ?", e.id)).toBe(0);
    expect(db.query(`SELECT rowid FROM emails_fts WHERE emails_fts MATCH 'manuscript'`)).toHaveLength(0);
  });

  it("re-indexing a message replaces its entry instead of duplicating it", async () => {
    const { db, store: s } = store();
    const e = email({ bodyText: "first draft" });
    await s.insertEmail(ACCOUNT, e);
    const docid = db.query<{ docid: number }>(
      `SELECT docid FROM emails_fts_map WHERE account_id = ? AND email_id = ?`,
      ACCOUNT,
      e.id,
    )[0]!.docid;

    await s.reindexEmailText(ACCOUNT, e.id, {
      subject: e.subject,
      fromText: "ada@example.test",
      toText: "",
      bodyText: "second draft",
    });

    expect(await search(s, "second")).toEqual([e.id]);
    expect(await search(s, "first")).toEqual([]);
    expect(db.count("emails_fts_map", "account_id = ? AND email_id = ?", ACCOUNT, e.id)).toBe(1);
    // The SAME docid — a new one would orphan the old index entries.
    expect(
      db.query<{ docid: number }>(
        `SELECT docid FROM emails_fts_map WHERE account_id = ? AND email_id = ?`,
        ACCOUNT,
        e.id,
      )[0]!.docid,
    ).toBe(docid);
  });

  it("scopes results to the searching account", async () => {
    const { store: s } = store();
    const mine = email({ bodyText: "shibboleth" });
    const theirs = email({ bodyText: "shibboleth" });
    await s.insertEmail(ACCOUNT, mine);
    await s.insertEmail(OTHER, theirs);

    expect(await search(s, "shibboleth")).toEqual([mine.id]);
    expect(await search(s, "shibboleth", OTHER)).toEqual([theirs.id]);
  });
});

// ---- the filter/sort/pagination contract is unchanged --------------------

describe("query contract", () => {
  it("sorts and paginates full-text hits like any other filter", async () => {
    const { store: s } = store();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = email({ bodyText: "quarterly telemetry digest", receivedAt: 1000 + i });
      ids.push(e.id);
      await s.insertEmail(ACCOUNT, e);
    }
    const newestFirst = [...ids].reverse();

    const page1 = await s.queryEmails(ACCOUNT, {
      filter: { text: "telemetry" },
      limit: 2,
      calculateTotal: true,
    });
    expect(page1.ids).toEqual(newestFirst.slice(0, 2));
    expect(page1.total).toBe(5);

    const page2 = await s.queryEmails(ACCOUNT, {
      filter: { text: "telemetry" },
      position: 2,
      limit: 2,
    });
    expect(page2.ids).toEqual(newestFirst.slice(2, 4));

    const ascending = await s.queryEmails(ACCOUNT, {
      filter: { text: "telemetry" },
      sort: [{ property: "receivedAt", isAscending: true }],
      limit: 3,
    });
    expect(ascending.ids).toEqual(ids.slice(0, 3));
  });

  it("composes with the AND/OR/NOT tree and with non-text conditions", async () => {
    const { store: s } = store();
    const hit = email({ bodyText: "aardvark", hasAttachment: true, keywords: ["$flagged"] });
    const noAttachment = email({ bodyText: "aardvark", hasAttachment: false });
    const other = email({ bodyText: "buffalo", hasAttachment: true });
    for (const e of [hit, noAttachment, other]) await s.insertEmail(ACCOUNT, e);

    expect((await s.queryEmails(ACCOUNT, { filter: { text: "aardvark", hasAttachment: true } })).ids).toEqual([hit.id]);

    expect(
      (
        await s.queryEmails(ACCOUNT, {
          filter: { operator: "OR", conditions: [{ text: "aardvark" }, { text: "buffalo" }] },
        })
      ).ids.sort(),
    ).toEqual([hit.id, noAttachment.id, other.id].sort());

    expect(
      (
        await s.queryEmails(ACCOUNT, {
          filter: { operator: "NOT", conditions: [{ text: "aardvark" }] },
        })
      ).ids,
    ).toEqual([other.id]);

    expect((await s.queryEmails(ACCOUNT, { filter: { text: "aardvark", hasKeyword: "$flagged" } })).ids).toEqual([
      hit.id,
    ]);
  });

  it("leaves the non-text conditions on their original columns", async () => {
    // `subject`/`from`/`to` stay LIKE (substring), which is a DIFFERENT and
    // still-supported contract from the tokenized `text` condition.
    const { store: s } = store();
    const e = email({ subject: "Reforestation", from: [{ email: "sam@example.test" }] });
    await s.insertEmail(ACCOUNT, e);

    expect((await s.queryEmails(ACCOUNT, { filter: { subject: "forest" } })).ids).toEqual([e.id]);
    expect((await s.queryEmails(ACCOUNT, { filter: { from: "am@exam" } })).ids).toEqual([e.id]);
    // …whereas `text` is whole-token, so the same fragment does NOT match.
    expect(await search(s, "forest")).toEqual([]);
  });
});

// ---- FTS5 is a query language; user input is not -------------------------

describe("escaping user input", () => {
  it("treats FTS5 operators as literal words, not syntax", () => {
    expect(ftsMatchQuery("foo AND bar")).toBe('"foo" "AND" "bar"');
    expect(ftsMatchQuery("a OR b")).toBe('"a" "OR" "b"');
    expect(ftsMatchQuery("NEAR(a b)")).toBe('"NEAR(a" "b)"');
    expect(ftsMatchQuery("subject:urgent")).toBe('"subject:urgent"');
    expect(ftsMatchQuery("wild*")).toBe('"wild*"');
    expect(ftsMatchQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it("returns null when nothing in the input is tokenizable", () => {
    expect(ftsMatchQuery('"')).toBeNull();
    expect(ftsMatchQuery("   ")).toBeNull();
    expect(ftsMatchQuery("-- !!!")).toBeNull();
    expect(ftsMatchQuery("")).toBeNull();
  });

  it("keeps non-latin scripts", () => {
    expect(ftsMatchQuery("日本語 café")).toBe('"日本語" "café"');
  });

  it("does not 500 — or silently boolean-surprise — on operator-shaped input", async () => {
    const { store: s } = store();
    const both = email({ bodyText: "alpha and omega" });
    const onlyAlpha = email({ bodyText: "alpha only" });
    await s.insertEmail(ACCOUNT, both);
    await s.insertEmail(ACCOUNT, onlyAlpha);

    // If `AND` leaked through as an operator this would return BOTH rows.
    // As three literal words it returns only the message containing all three.
    expect(await search(s, "alpha AND omega")).toEqual([both.id]);
    // Same for OR: not a union.
    expect(await search(s, "alpha OR zebra")).toEqual([]);
  });

  it("survives quotes, stars and parentheses without throwing", async () => {
    const { store: s } = store();
    const e = email({ bodyText: 'she said "hello" (loudly) * 3' });
    await s.insertEmail(ACCOUNT, e);

    for (const q of ['"', '""', "*", "a*", "(", "NEAR(hello loudly)", "^hello", "hello -loudly"]) {
      await expect(s.queryEmails(ACCOUNT, { filter: { text: q } })).resolves.toBeDefined();
    }
    expect(await search(s, '"hello"')).toEqual([e.id]);
    expect(await search(s, "(loudly)")).toEqual([e.id]);
  });

  it("falls back to LIKE for punctuation-only input, preserving the old behaviour", async () => {
    const { store: s } = store();
    const e = email({ subject: "a -- b" });
    await s.insertEmail(ACCOUNT, e);
    // FTS5 cannot express this query at all; LIKE still can.
    expect(await search(s, "--")).toEqual([e.id]);
  });
});

// ---- the backfill's work queue -------------------------------------------

describe("backfill support", () => {
  it("reports messages that predate the index, and stops reporting them once indexed", async () => {
    const { db, store: s } = store();
    await s.insertEmail(ACCOUNT, email({ bodyText: "already indexed" }));

    // A row written before common/004: metadata, no index entry.
    db.seed("emails", [
      {
        id: "e_legacy",
        account_id: ACCOUNT,
        blob_id: "b_legacy",
        thread_id: "th_legacy",
        subject: "Ancient history",
        from_json: "[]",
        to_json: "[]",
        cc_json: "[]",
        bcc_json: "[]",
        preview: "a dusty preview",
        size: 10,
        received_at: 1,
      },
    ]);

    expect(await s.unindexedEmailCount(ACCOUNT)).toBe(1);
    expect(await s.unindexedEmailIds(ACCOUNT, 10)).toEqual([{ accountId: ACCOUNT, id: "e_legacy" }]);
    expect(await search(s, "Ancient")).toEqual([]);

    await s.reindexEmailText(ACCOUNT, "e_legacy", {
      subject: "Ancient history",
      fromText: "",
      toText: "",
      bodyText: "a dusty preview",
    });

    expect(await s.unindexedEmailCount(ACCOUNT)).toBe(0);
    expect(await search(s, "Ancient")).toEqual(["e_legacy"]);
    expect(await search(s, "dusty")).toEqual(["e_legacy"]);
  });

  it("is idempotent — a second backfill pass over the same message changes nothing", async () => {
    const { db, store: s } = store();
    const e = email({ bodyText: "run me twice" });
    await s.insertEmail(ACCOUNT, e);

    const text = { subject: e.subject, fromText: "", toText: "", bodyText: "run me twice" };
    await s.reindexEmailText(ACCOUNT, e.id, text);
    await s.reindexEmailText(ACCOUNT, e.id, text);

    expect(await search(s, "twice")).toEqual([e.id]);
    expect(db.count("emails_fts_map")).toBe(1);
  });
});
