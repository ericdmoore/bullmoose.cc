import { describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { Mailstore } from "@bullmoose/mailstore";
import worker, { type Env } from "./index";

/**
 * Ingest is where the full-text index gets written (common/004).
 *
 * `packages/mailstore/src/search.test.ts` proves the index itself behaves;
 * these tests prove the two things only this worker can: that a REAL delivered
 * message ends up searchable by a word from paragraph four, and that the
 * backfill route can retrofit an index onto a database that already has mail.
 *
 * Both drive the worker's `fetch`, not `deliver` directly, so the internal-token
 * guard on the backfill route is exercised rather than bypassed.
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_ingest";
const TOKEN = "internal-test-token";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

function envFor(w: FakeWorker): Env {
  return { ...w.env, DEV_INJECT: "1" } as unknown as Env;
}

async function route(w: FakeWorker): Promise<void> {
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
}

/** Deliver one raw message through the worker's dev-inject path. */
async function deliver(w: FakeWorker, raw: string): Promise<string> {
  const res = await worker.fetch(
    new Request("https://ingest.test/dev/inject?from=sender@elsewhere.test&to=ada@example.test", {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    envFor(w),
    ctx(),
  );
  const body = (await res.json()) as { emailId?: string; rejected?: string };
  expect(body.rejected).toBeUndefined();
  return body.emailId as string;
}

const mime = (opts: { subject: string; body: string; contentType?: string }) =>
  [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject}`,
    "Message-ID: <" + Math.random().toString(36).slice(2) + "@elsewhere.test>",
    `Content-Type: ${opts.contentType ?? "text/plain; charset=utf-8"}`,
    "",
    opts.body,
  ].join("\r\n");

const search = async (w: FakeWorker, text: string) =>
  (await new Mailstore(w.env.DB, w.env.BLOBS).queryEmails(ACCOUNT, { filter: { text } })).ids;

describe("delivery populates the full-text index", () => {
  it("makes a word from deep in the body searchable", async () => {
    const w = fakeEnv();
    await route(w);

    // `hydrangea` sits ~500 characters in — past the 256-char preview that
    // used to be the entire searchable body.
    const id = await deliver(
      w,
      mime({
        subject: "Garden notes",
        body: `${"Lorem ipsum dolor sit amet. ".repeat(20)}The hydrangea finally bloomed.`,
      }),
    );

    expect(await search(w, "hydrangea")).toEqual([id]);
    // …and the pre-existing coverage still works.
    expect(await search(w, "Garden")).toEqual([id]);
    expect(await search(w, "sender@elsewhere.test")).toEqual([id]);
  });

  it("indexes an HTML-only message, which has no text/plain part at all", async () => {
    const w = fakeEnv();
    await route(w);

    const id = await deliver(
      w,
      mime({
        subject: "Newsletter",
        contentType: "text/html; charset=utf-8",
        body: "<html><head><style>.x{color:red}</style></head><body><p>Still <b>relevant</b>.</p></body></html>",
      }),
    );

    expect(await search(w, "relevant")).toEqual([id]);
    // Markup and stylesheet contents are not words.
    expect(await search(w, "color")).toEqual([]);
    expect(await search(w, "body")).toEqual([]);
  });

  it("drops the index entry when the message is destroyed", async () => {
    const w = fakeEnv();
    await route(w);
    const id = await deliver(w, mime({ subject: "Ephemeral", body: "codeword marmoset" }));
    expect(await search(w, "marmoset")).toEqual([id]);

    await new Mailstore(w.env.DB, w.env.BLOBS).destroyEmail(ACCOUNT, id);

    expect(await search(w, "marmoset")).toEqual([]);
    expect(w.db.count("emails_fts_map")).toBe(0);
  });
});

describe("POST /admin/fts/backfill", () => {
  const backfill = (w: FakeWorker, query = "", token: string | null = TOKEN) =>
    worker.fetch(
      new Request(`https://ingest.test/admin/fts/backfill${query}`, {
        method: "POST",
        headers: token === null ? {} : { "x-internal-token": token },
      }),
      envFor(w),
      ctx(),
    );

  /** A delivered message, stripped back to its pre-common/004 state. */
  async function unindex(w: FakeWorker): Promise<void> {
    w.db.sqlite.exec("DELETE FROM emails_fts_map");
    w.db.sqlite.exec("DELETE FROM emails_fts");
  }

  it("refuses without the internal token", async () => {
    const w = fakeEnv();
    expect((await backfill(w, "", null)).status).toBe(200);
    expect(await (await backfill(w, "", null)).text()).toBe("bullmoose-ingest");
    expect(await (await backfill(w, "", "wrong")).text()).toBe("bullmoose-ingest");
  });

  it("re-indexes messages that predate the index, bodies and all", async () => {
    const w = fakeEnv();
    await route(w);
    const id = await deliver(w, mime({ subject: "Old mail", body: `${"padding ".repeat(60)}pterodactyl` }));
    await unindex(w);
    expect(await search(w, "pterodactyl")).toEqual([]);

    const result = (await (await backfill(w)).json()) as {
      scanned: number;
      indexed: number;
      remaining: number;
      deep: boolean;
    };

    expect(result).toMatchObject({ scanned: 1, indexed: 1, remaining: 0, deep: true });
    // The deep pass re-read the raw message from R2 — `pterodactyl` is far
    // past the 256-char preview, so only a real body reparse can find it.
    expect(await search(w, "pterodactyl")).toEqual([id]);
  });

  it("deep=0 skips R2 and indexes metadata + preview only", async () => {
    const w = fakeEnv();
    await route(w);
    await deliver(w, mime({ subject: "Old mail", body: `${"padding ".repeat(60)}pterodactyl` }));
    await unindex(w);

    const result = (await (await backfill(w, "?deep=0")).json()) as {
      indexed: number;
      deep: boolean;
    };
    expect(result).toMatchObject({ indexed: 1, deep: false });

    expect(await search(w, "Old mail")).toHaveLength(1);
    expect(await search(w, "padding")).toHaveLength(1); // preview reaches this
    expect(await search(w, "pterodactyl")).toEqual([]); // …but not this
  });

  it("is idempotent and resumable — remaining only ever shrinks", async () => {
    const w = fakeEnv();
    await route(w);
    for (let i = 0; i < 3; i++) {
      await deliver(w, mime({ subject: `Message ${i}`, body: `unique${i} content` }));
    }
    await unindex(w);

    const first = (await (await backfill(w, "?limit=2")).json()) as {
      indexed: number;
      remaining: number;
    };
    expect(first).toMatchObject({ indexed: 2, remaining: 1 });

    const second = (await (await backfill(w, "?limit=2")).json()) as {
      indexed: number;
      remaining: number;
    };
    expect(second).toMatchObject({ indexed: 1, remaining: 0 });

    // A pass over a fully indexed database does nothing at all.
    const third = (await (await backfill(w)).json()) as { scanned: number; indexed: number };
    expect(third).toMatchObject({ scanned: 0, indexed: 0 });

    for (let i = 0; i < 3; i++) expect(await search(w, `unique${i}`)).toHaveLength(1);
    expect(w.db.count("emails_fts_map")).toBe(3);
  });

  it("scopes to one account when asked", async () => {
    const w = fakeEnv();
    await route(w);
    await deliver(w, mime({ subject: "Mine", body: "narwhal" }));
    await unindex(w);
    w.db.seed("emails", [
      {
        id: "e_other",
        account_id: "t_bm__a_someone_else",
        blob_id: "b_x",
        thread_id: "th_x",
        subject: "Theirs",
        from_json: "[]",
        to_json: "[]",
        cc_json: "[]",
        bcc_json: "[]",
        preview: "narwhal",
        size: 1,
        received_at: 1,
      },
    ]);

    const scoped = (await (await backfill(w, `?account=${ACCOUNT}&deep=0`)).json()) as {
      indexed: number;
      remaining: number;
    };
    expect(scoped).toMatchObject({ indexed: 1, remaining: 0 });

    // The other account's message is untouched. `limit=0` is the status call:
    // it reports across every account and indexes nothing.
    const all = (await (await backfill(w, "?limit=0")).json()) as {
      scanned: number;
      remaining: number;
    };
    expect(all).toMatchObject({ scanned: 0, remaining: 1 });
    expect(w.db.count("emails_fts_map", "account_id = ?", "t_bm__a_someone_else")).toBe(0);
  });
});
