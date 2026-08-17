import { describe, expect, it } from "vitest";
import { fakeD1, fakeKV, type FakeD1 } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

/**
 * `PATCH /agent-bindings/{id}` — the binding config write surface (s10 T4).
 *
 * Before this route the only post-create write on a binding was
 * `UPDATE agent_bindings SET enabled`, so every other config control was a
 * field that rendered and never changed. The tests here are written against the
 * four claims that make the route safe rather than merely present:
 *
 *  - the TYPED CORE is the whole contract; an unknown key is a 400 and the
 *    untyped remainder (persona, pipeline, digestTargets …) survives every
 *    write untouched — asserted by reading the stored blob back, not by
 *    trusting the response;
 *  - a target book that is not `write_policy = 'governed'` is REFUSED, because
 *    re-pointing at an open book silently unbinds the agent (it can then write
 *    its own reach). The refusal is asserted together with "the column did not
 *    move", since a refusal that still wrote would be a refusal in name only;
 *  - NULL is allowed and is reported as FAIL-CLOSED in words, never as a
 *    quiet clear;
 *  - a re-point appends a provenance row with actor and old→new, and a no-op
 *    appends nothing. Both halves matter: a chain that records non-events is as
 *    unreadable as one with holes.
 */

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "bullmoose.cc";
const TENANT = "t_bm";

interface Harness {
  db: FakeD1;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Bullmoose", status: "active", created_at: 1 }]);
  db.seed("domains", [
    { domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "zone1", created_at: 1 },
  ]);
  const env: Env = {
    DB: db,
    ROUTES: kv.ns,
    ADMIN_TOKEN,
    SES_REGION: "us-east-1",
    INGEST_WORKER_NAME: "bullmoose-ingest",
    CF_API_TOKEN: "cf",
    SES_ACCESS_KEY_ID: "ak",
    SES_SECRET_ACCESS_KEY: "sk",
  };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://provision.bullmoose.cc${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  return { db, env, call };
}

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** The agent-specific remainder every test proves survives a write. */
const REMAINDER = {
  persona: "you are photos@, terse and kind",
  pipeline: "reply",
  digestTargets: ["eric@bullmoose.cc"],
  modelAliases: { fast: "@local/llama" },
  maxTokens: 4096,
};

interface Fixture {
  h: Harness;
  accountId: string;
  bindingId: string;
  governed: string;
  open: string;
}

/**
 * One account, one binding pointed at a GOVERNED book, plus an OPEN book on the
 * same account as the wrong-policy target. Books are seeded directly — the
 * provisioning precedent (`provisionBouncer` writes address_books the same way)
 * and the same shape the Mailstore chokepoint reads.
 */
async function fixture(config: Record<string, unknown> = {}): Promise<Fixture> {
  const h = harness();
  await h.call("POST", "/accounts", {
    tenantId: TENANT,
    domain: DOMAIN,
    localpart: "photos",
    displayName: "Photos",
  });
  const accountId = (
    await body<{ accounts: Array<{ id: string }> }>(await h.call("GET", "/accounts"))
  ).accounts[0]!.id;

  const now = Date.now();
  h.db.seed("address_books", [
    {
      id: "ab_governed",
      account_id: accountId,
      name: "Photos may email",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: now,
      updated_at: now,
      write_policy: "governed",
    },
    {
      id: "ab_open",
      account_id: accountId,
      name: "Working contacts",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: now,
      updated_at: now,
      write_policy: "open",
    },
    {
      id: "ab_propose",
      account_id: accountId,
      name: "Eric's contacts",
      sort_order: 0,
      is_default: 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: now,
      updated_at: now,
      write_policy: "propose",
    },
  ]);

  const bindingId = (
    await body<{ bindingId: string }>(
      await h.call("POST", "/agent-bindings", {
        email: `photos@${DOMAIN}`,
        name: "photos",
        config: {
          replyMode: "draft",
          allowedSenders: ["eric@bullmoose.cc"],
          ...REMAINDER,
          ...config,
        },
        recipientsBookId: "ab_governed",
      }),
    )
  ).bindingId;

  return { h, accountId, bindingId, governed: "ab_governed", open: "ab_open" };
}

/** The stored row, read the way the runtime reads it. */
function storedBinding(f: Fixture) {
  return f.h.db.query(
    `SELECT enabled, config_json, recipients_book_id FROM agent_bindings WHERE account_id = ? AND id = ?`,
    f.accountId,
    f.bindingId,
  )[0] as { enabled: number; config_json: string; recipients_book_id: string | null };
}

const storedConfig = (f: Fixture) =>
  JSON.parse(storedBinding(f).config_json) as Record<string, unknown>;

const chain = (f: Fixture) =>
  f.h.db.query(
    `SELECT event, old_value, new_value, actor, via_proposal_id, at FROM binding_lifecycle
      WHERE account_id = ? AND binding_id = ? ORDER BY id`,
    f.accountId,
    f.bindingId,
  ) as Array<Record<string, unknown>>;

const patch = (f: Fixture, b: unknown) => f.h.call("PATCH", `/agent-bindings/${f.bindingId}`, b);

// ── the typed core writes ────────────────────────────────────────────────

describe("PATCH /agent-bindings/{id} — each typed field", () => {
  it("writes replyMode, and the runtime's own read sees it", async () => {
    const f = await fixture();
    const res = await patch(f, { replyMode: "send" });
    expect(res.status).toBe(200);
    const out = await body<{ changed: boolean; updated: string[]; replyMode: string }>(res);
    expect(out.changed).toBe(true);
    expect(out.updated).toEqual(["replyMode"]);
    expect(out.replyMode).toBe("send");
    expect(storedConfig(f).replyMode).toBe("send");
  });

  it("writes allowedSenders, normalized and de-duplicated", async () => {
    const f = await fixture();
    const out = await body<{ allowedSenders: string[] }>(
      await patch(f, {
        allowedSenders: ["  Bob@Example.COM ", "bob@example.com", "kid@school.test"],
      }),
    );
    // Normalized EXACT match is the gate's rule, so the stored list has to be
    // normalized: an unnormalized entry never matches and silently narrows.
    expect(out.allowedSenders).toEqual(["bob@example.com", "kid@school.test"]);
    expect(storedConfig(f).allowedSenders).toEqual(["bob@example.com", "kid@school.test"]);
  });

  it("writes enabled, and ingest's own enqueue query honours it immediately", async () => {
    const f = await fixture();
    const armed = () =>
      f.h.db.query(
        `SELECT id FROM agent_bindings
          WHERE account_id = ? AND enabled = 1 AND trigger_on = 'mailbox-delivery'`,
        f.accountId,
      );
    expect(armed()).toHaveLength(1);
    const out = await body<{ enabled: boolean; pendingInvocations: number }>(
      await patch(f, { enabled: false }),
    );
    expect(out.enabled).toBe(false);
    expect(out.pendingInvocations).toBe(0);
    expect(armed()).toHaveLength(0);
  });

  it("re-points recipientsBookId at another GOVERNED book", async () => {
    const f = await fixture();
    const now = Date.now();
    f.h.db.seed("address_books", [
      {
        id: "ab_second",
        account_id: f.accountId,
        name: "Second event",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: now,
        updated_at: now,
        write_policy: "governed",
      },
    ]);
    const out = await body<{
      outbound: { state: string; governingBookId: string; failClosed: boolean };
    }>(await patch(f, { recipientsBookId: "ab_second" }));
    expect(out.outbound).toMatchObject({
      state: "book",
      governingBookId: "ab_second",
      failClosed: false,
    });
    expect(storedBinding(f).recipients_book_id).toBe("ab_second");
  });

  it("writes several fields in one call", async () => {
    const f = await fixture();
    const out = await body<{ updated: string[] }>(
      await patch(f, { enabled: false, replyMode: "send", allowedSenders: ["a@b.test"] }),
    );
    expect(out.updated.sort()).toEqual(["allowedSenders", "enabled", "replyMode"]);
    const row = storedBinding(f);
    expect(row.enabled).toBe(0);
    expect(JSON.parse(row.config_json)).toMatchObject({
      replyMode: "send",
      allowedSenders: ["a@b.test"],
    });
  });
});

// ── the blob remainder ───────────────────────────────────────────────────

describe("the untyped remainder survives every edit", () => {
  it("persona and the rest of config_json are preserved across a typed write", async () => {
    const f = await fixture();
    await patch(f, { replyMode: "send", allowedSenders: ["x@y.test"] });
    const cfg = storedConfig(f);
    // Every remainder key, value-for-value — this is the "do not CRUD a blob"
    // rule as an assertion: the route touched two keys and nothing else.
    for (const [k, v] of Object.entries(REMAINDER)) expect(cfg[k]).toEqual(v);
    expect(Object.keys(cfg).sort()).toEqual(
      [...Object.keys(REMAINDER), "replyMode", "allowedSenders"].sort(),
    );
  });

  it("names the preserved keys in the response, so the caller can see the blob survived", async () => {
    const f = await fixture();
    const out = await body<{ preserved: string[] }>(await patch(f, { replyMode: "send" }));
    expect(out.preserved.sort()).toEqual(Object.keys(REMAINDER).sort());
  });

  it("refuses an unparseable config_json rather than replacing it", async () => {
    const f = await fixture();
    f.h.db.sqlite.exec(
      `UPDATE agent_bindings SET config_json = '{not json' WHERE id = '${f.bindingId}'`,
    );
    const res = await patch(f, { replyMode: "send" });
    expect(res.status).toBe(409);
    expect((await body<{ error: string }>(res)).error).toMatch(/cannot parse/);
    // The damaged blob is still there: a repair path can still read it.
    expect(storedBinding(f).config_json).toBe("{not json");
  });
});

// ── the write-policy refusal ─────────────────────────────────────────────

describe("the target book must be write_policy = 'governed'", () => {
  it("refuses an OPEN book — re-pointing there would silently unbind the agent", async () => {
    const f = await fixture();
    const res = await patch(f, { recipientsBookId: f.open });
    expect(res.status).toBe(422);
    const out = await body<{ error: string; writePolicy: string; required: string }>(res);
    expect(out.writePolicy).toBe("open");
    expect(out.required).toBe("governed");
    expect(out.error).toMatch(/write_policy/);
    expect(out.error).toMatch(/governed/);
    // The refusal has to be a refusal: the column did not move.
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
    expect(chain(f)).toHaveLength(0);
  });

  it("refuses a 'propose' book too — only the full bound will do", async () => {
    const f = await fixture();
    const res = await patch(f, { recipientsBookId: "ab_propose" });
    expect(res.status).toBe(422);
    expect((await body<{ writePolicy: string }>(res)).writePolicy).toBe("propose");
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
  });

  it("refuses a book that does not exist on the binding's own account", async () => {
    const f = await fixture();
    // A governed book on ANOTHER account: the send gate's lookup is
    // account-scoped, so this would render as a bound and refuse every send.
    const now = Date.now();
    f.h.db.seed("address_books", [
      {
        id: "ab_elsewhere",
        account_id: "a_someone_else",
        name: "Someone else's",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: now,
        updated_at: now,
        write_policy: "governed",
      },
    ]);
    const res = await patch(f, { recipientsBookId: "ab_elsewhere" });
    expect(res.status).toBe(404);
    expect((await body<{ error: string }>(res)).error).toMatch(/BINDING'S OWN account/);
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
  });
});

// ── the NULL unbind ──────────────────────────────────────────────────────

describe("recipientsBookId: null unbinds, and says it is fail-closed", () => {
  it("allows the unbind and reports CANNOT SEND in words", async () => {
    const f = await fixture();
    const out = await body<{
      outbound: { state: string; governingBookId: null; failClosed: boolean; note: string };
    }>(await patch(f, { recipientsBookId: null }));
    expect(out.outbound.state).toBe("none");
    expect(out.outbound.governingBookId).toBeNull();
    expect(out.outbound.failClosed).toBe(true);
    expect(out.outbound.note).toMatch(/CANNOT SEND/);
    expect(out.outbound.note).not.toMatch(/unrestricted[^,]/);
    expect(storedBinding(f).recipients_book_id).toBeNull();
  });

  it("chains the unbind like any other re-point — a narrowing is still a change", async () => {
    const f = await fixture();
    await patch(f, { recipientsBookId: null });
    expect(chain(f)).toHaveLength(1);
    expect(chain(f)[0]).toMatchObject({ old_value: "ab_governed", new_value: null });
  });

  it("refuses the empty string — the shape that reads as unrestricted", async () => {
    const f = await fixture();
    const res = await patch(f, { recipientsBookId: "" });
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/CANNOT SEND|unrestricted/);
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
  });
});

// ── the provenance row ───────────────────────────────────────────────────

describe("a book re-point appends a provenance row (s10 T2 discipline)", () => {
  it("records actor, timestamp and old→new, both legible", async () => {
    const f = await fixture();
    const now = Date.now();
    f.h.db.seed("address_books", [
      {
        id: "ab_next",
        account_id: f.accountId,
        name: "Next",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: now,
        updated_at: now,
        write_policy: "governed",
      },
    ]);
    const out = await body<{ provenance: Record<string, unknown> }>(
      await patch(f, { recipientsBookId: "ab_next" }),
    );
    expect(out.provenance).toMatchObject({
      record: "binding_lifecycle",
      event: "recipients-book-changed",
      from: "ab_governed",
      to: "ab_next",
      actor: "admin",
      viaProposalId: null,
    });

    const rows = chain(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "recipients-book-changed",
      old_value: "ab_governed",
      new_value: "ab_next",
      actor: "admin",
      via_proposal_id: null,
    });
    expect(rows[0]!.at).toBeGreaterThan(0);
  });

  it("is reconstructable after the fact: the whole sequence replays, including a widen→narrow window", async () => {
    const f = await fixture();
    const now = Date.now();
    f.h.db.seed("address_books", [
      {
        id: "ab_wide",
        account_id: f.accountId,
        name: "Wide",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: now,
        updated_at: now,
        write_policy: "governed",
      },
    ]);
    await patch(f, { recipientsBookId: "ab_wide" });
    await patch(f, { recipientsBookId: "ab_governed" });
    // Back where it started: current state says nothing happened, and the point
    // of an append-only chain is that the window is still visible.
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
    expect(chain(f).map((r) => [r.old_value, r.new_value])).toEqual([
      ["ab_governed", "ab_wide"],
      ["ab_wide", "ab_governed"],
    ]);
  });

  it("GET /agent-bindings/{id}/lifecycle reads the chain back", async () => {
    const f = await fixture();
    await patch(f, { recipientsBookId: null });
    const out = await body<{ events: Array<Record<string, unknown>> }>(
      await f.h.call("GET", `/agent-bindings/${f.bindingId}/lifecycle`),
    );
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      old_value: "ab_governed",
      new_value: null,
      actor: "admin",
    });
  });

  it("appends NOTHING when the book did not move", async () => {
    const f = await fixture();
    // A real change to another field, and a re-assert of the same book id in
    // the same call: neither is a re-point.
    await patch(f, { replyMode: "send", recipientsBookId: "ab_governed" });
    expect(storedConfig(f).replyMode).toBe("send");
    expect(chain(f)).toHaveLength(0);
  });
});

// ── idempotence and concurrency ──────────────────────────────────────────

describe("a no-op PATCH is a no-op", () => {
  it("writes nothing at all and says changed: false", async () => {
    const f = await fixture();
    const before = f.h.db.writes.length;
    const out = await body<{ changed: boolean; updated: string[]; provenance: null; note: string }>(
      await patch(f, { replyMode: "draft", allowedSenders: ["eric@bullmoose.cc"], enabled: true }),
    );
    expect(out.changed).toBe(false);
    expect(out.updated).toEqual([]);
    expect(out.provenance).toBeNull();
    expect(out.note).toMatch(/no-op/);
    // Not "wrote the same values" — wrote NOTHING. SQLite counts an identical
    // UPDATE as a change, so only the absence of the statement proves it.
    expect(f.h.db.writes.length).toBe(before);
  });

  it("is idempotent: applying the same change twice leaves one chain row", async () => {
    const f = await fixture();
    await patch(f, { recipientsBookId: null });
    const second = await body<{ changed: boolean }>(await patch(f, { recipientsBookId: null }));
    expect(second.changed).toBe(false);
    expect(chain(f)).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("refuses with 409 when the binding moved under the edit, and writes NEITHER half", async () => {
    const f = await fixture();
    // A second writer that commits between this route's read and its write.
    // The batch is intercepted, the row is moved underneath it, and only then
    // does the batch run — which is exactly the window the compare-and-swap
    // predicate exists to catch. Without it, this PATCH would write a blob
    // built from a stale pre-image and silently erase the other writer's edit.
    const db = f.h.db;
    let raced = false;
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          db.sqlite.exec(
            `UPDATE agent_bindings SET config_json = '{"persona":"the other writer"}' ` +
              `WHERE id = '${f.bindingId}'`,
          );
        }
        return db.batch(stmts);
      },
      exec: (q: string) => db.exec(q),
      dump: () => db.dump(),
      withSession: () => db.withSession(),
    } as unknown as D1Database;

    const res = await worker.fetch(
      new Request(`https://provision.bullmoose.cc/agent-bindings/${f.bindingId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ recipientsBookId: null }),
      }),
      { ...f.h.env, DB: racing },
    );
    expect(res.status).toBe(409);
    expect((await body<{ error: string }>(res)).error).toMatch(
      /changed between the read and the write/,
    );
    // The other writer's blob is intact, the book did not move, and — the half
    // that matters — no provenance row claims a change that never happened.
    expect(storedConfig(f)).toEqual({ persona: "the other writer" });
    expect(storedBinding(f).recipients_book_id).toBe("ab_governed");
    expect(chain(f)).toHaveLength(0);
  });
});

// ── the contract's edges ─────────────────────────────────────────────────

describe("the route accepts the typed core and nothing else", () => {
  it("400s an unknown key, naming it and the rule", async () => {
    const f = await fixture();
    const res = await patch(f, { replyMode: "send", persona: "a new persona" });
    expect(res.status).toBe(400);
    const out = await body<{ error: string; rejected: string[]; accepted: string[] }>(res);
    expect(out.rejected).toEqual(["persona"]);
    expect(out.accepted).toEqual(["enabled", "replyMode", "allowedSenders", "recipientsBookId"]);
    expect(out.error).toMatch(/TYPED CORE/);
    // Mixed calls do not half-apply: the legal field was not written either.
    expect(storedConfig(f).replyMode).toBe("draft");
    expect(storedConfig(f).persona).toBe(REMAINDER.persona);
  });

  it("400s the blob keys by name — pipeline, digestTargets, modelAliases", async () => {
    const f = await fixture();
    for (const key of ["pipeline", "digestTargets", "modelAliases", "maxTokens"]) {
      const res = await patch(f, { [key]: "whatever" });
      expect(res.status, key).toBe(400);
    }
    expect(storedConfig(f)).toMatchObject(REMAINDER);
  });

  it("400s an empty body rather than reporting a write it did not make", async () => {
    const f = await fixture();
    const res = await patch(f, {});
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/nothing to update/);
  });

  it("400s a replyMode the runtime does not enforce", async () => {
    const f = await fixture();
    for (const mode of ["reply", "SEND", "", null, 3]) {
      const res = await patch(f, { replyMode: mode });
      expect(res.status, String(mode)).toBe(400);
    }
    expect(storedConfig(f).replyMode).toBe("draft");
  });

  it("400s allowedSenders entries that are not addresses", async () => {
    const f = await fixture();
    for (const list of [["not-an-address"], ["a@b.test", "nope"], "a@b.test", [42]]) {
      const res = await patch(f, { allowedSenders: list });
      expect(res.status, JSON.stringify(list)).toBe(400);
    }
    expect(storedConfig(f).allowedSenders).toEqual(["eric@bullmoose.cc"]);
  });

  it("400s allowedSenders: [] — empty-but-present is read as NO GATE", async () => {
    const f = await fixture();
    const res = await patch(f, { allowedSenders: [] });
    expect(res.status).toBe(400);
    expect((await body<{ error: string }>(res)).error).toMatch(/NO GATE/);
    // null is the deliberate spelling, and it removes the key entirely.
    const out = await body<{ allowedSenders: null }>(await patch(f, { allowedSenders: null }));
    expect(out.allowedSenders).toBeNull();
    expect("allowedSenders" in storedConfig(f)).toBe(false);
  });

  it("400s a non-boolean enabled", async () => {
    const f = await fixture();
    expect((await patch(f, { enabled: "false" })).status).toBe(400);
    expect(storedBinding(f).enabled).toBe(1);
  });

  it("404s an unknown binding, through the same resolver the other verbs use", async () => {
    const f = await fixture();
    const res = await f.h.call("PATCH", "/agent-bindings/bind_nope", { replyMode: "send" });
    expect(res.status).toBe(404);
    expect((await body<{ error: string }>(res)).error).toMatch(/no agent binding bind_nope/);
  });

  it("refuses to enable a binding on a tombstoned account", async () => {
    const f = await fixture();
    f.h.db.sqlite.exec(`UPDATE accounts SET deleted_at = 1 WHERE id = '${f.accountId}'`);
    await f.h.call("POST", `/agent-bindings/${f.bindingId}/disable`);
    const res = await patch(f, { enabled: true });
    expect(res.status).toBe(409);
    expect((await body<{ error: string }>(res)).error).toMatch(/deleted/);
  });

  it("401s without the admin bearer — same gate as every other route", async () => {
    const f = await fixture();
    const res = await worker.fetch(
      new Request(`https://provision.bullmoose.cc/agent-bindings/${f.bindingId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replyMode: "send" }),
      }),
      f.h.env,
    );
    expect(res.status).toBe(401);
    expect(storedConfig(f).replyMode).toBe("draft");
    // …and the lifecycle read is behind the same gate.
    const chainRes = await worker.fetch(
      new Request(`https://provision.bullmoose.cc/agent-bindings/${f.bindingId}/lifecycle`),
      f.h.env,
    );
    expect(chainRes.status).toBe(401);
  });
});
