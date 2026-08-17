import { describe, expect, it } from "vitest";
import { QUARANTINE_NAME, QUARANTINE_ROLE } from "@bullmoose/mailstore";
import { fakeD1, fakeKV, type FakeD1, type FakeKV } from "@bullmoose/test-fakes";
import worker from "./index";
import type { Env } from "./index";

// common/024 (P1) — `POST /accounts` twice for one address used to succeed
// twice: a SECOND account, plus `INSERT OR REPLACE INTO routes`, which in
// SQLite is delete-then-insert. Mail moved to account #2; account #1 kept every
// message it had ever received and became unreachable by any address. Nothing
// errored.
//
// The assertion that actually matters in every test below is the one on
// `SELECT target FROM routes`. A duplicate create that returns the wrong status
// is a papercut; a duplicate create that MOVES the route is the data loss.
//
// Driven through the worker's fetch so the admin-token check, the route table
// and the handler are all real. The D1 fake is @bullmoose/test-fakes — real
// SQLite over the live schema, so `PRIMARY KEY (domain, localpart)`,
// `UNIQUE (account_id, email)` and every `REFERENCES` clause are enforced
// exactly as D1 enforces them, and `batch()` is a real transaction.

const ADMIN_TOKEN = "admin-secret";
const DOMAIN = "bullmoose.cc";
const TENANT = "t_bm";

interface Harness {
  db: FakeD1;
  kv: FakeKV;
  post: (body: Record<string, unknown>) => Promise<Response>;
}

function harness(): Harness {
  const db = fakeD1();
  const kv = fakeKV();
  db.seed("tenants", [{ id: TENANT, name: "Bullmoose", status: "active", created_at: 1 }]);
  db.seed("domains", [{ domain: DOMAIN, tenant_id: TENANT, status: "active", cf_zone_id: "z1", created_at: 1 }]);

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

  const post = (body: Record<string, unknown>) =>
    worker.fetch(
      new Request("https://provision.bullmoose.cc/accounts", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  return { db, kv, post };
}

const create = (h: Harness, over: Record<string, unknown> = {}) =>
  h.post({ tenantId: TENANT, domain: DOMAIN, localpart: "eric", displayName: "Eric", ...over });

/** Where `routes` currently says mail for eric@bullmoose.cc should land. */
const routeTarget = (db: FakeD1, localpart = "eric"): string | undefined =>
  db.query<{ target: string }>(`SELECT target FROM routes WHERE domain = ? AND localpart = ?`, DOMAIN, localpart)[0]
    ?.target;

const kvRoute = (kv: FakeKV, localpart = "eric") => {
  const raw = kv.store.get(`route:${DOMAIN}:${localpart}`)?.value;
  return raw
    ? (JSON.parse(raw) as {
        kind: string;
        accountId: string;
        tenantId: string;
        forwardTo?: string[];
      })
    : undefined;
};

describe("POST /accounts — the address is unique as a delivery route", () => {
  it("creates the account, the route and the ingest key on a first call", async () => {
    const h = harness();
    const res = await create(h);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { accountId: string; address: string; created: boolean };
    expect(body).toMatchObject({ address: "eric@bullmoose.cc", created: true });
    expect(routeTarget(h.db)).toBe(body.accountId);
    expect(kvRoute(h.kv)).toEqual({ kind: "mailbox", accountId: body.accountId, tenantId: TENANT });
    expect(h.db.count("accounts")).toBe(1);
    // SIX role mailboxes, not seven: wave 1 seeded a second pile beside Junk
    // under an invented `role: 'quarantine'`. Held mail lives in the
    // REGISTERED junk role now, so a standards client handles it as spam.
    expect(h.db.count("mailboxes", "account_id = ?", body.accountId)).toBe(6);
    expect(h.db.count("mailboxes", "account_id = ? AND role = 'quarantine'", body.accountId)).toBe(0);

    // The seed and the mailstore's constants must agree — provision spells the
    // pair out rather than importing it (that dependency would pull the whole
    // store into this worker's bundle), so THIS is the link that keeps the two
    // from drifting apart.
    const held = h.db.query<{ role: string; name: string }>(
      `SELECT role, name FROM mailboxes WHERE account_id = ? AND role = ?`,
      body.accountId,
      QUARANTINE_ROLE,
    );
    expect(held).toEqual([{ role: QUARANTINE_ROLE, name: QUARANTINE_NAME }]);
    expect({ role: QUARANTINE_ROLE, name: QUARANTINE_NAME }).toEqual({
      role: "junk",
      name: "Quarantined",
    });
  });

  // ── THE defect ────────────────────────────────────────────────────────
  it("is idempotent: a second identical call returns the SAME account and does not move the route", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };
    const routeBefore = routeTarget(h.db);
    expect(routeBefore).toBe(first.accountId);

    const res = await create(h);
    const second = (await res.json()) as { accountId: string; created: boolean };

    // Same account back, explicitly flagged as not newly created.
    expect(res.status).toBe(200);
    expect(second.accountId).toBe(first.accountId);
    expect(second.created).toBe(false);

    // The assertion that matters: delivery never moved.
    expect(routeTarget(h.db)).toBe(routeBefore);
    expect(kvRoute(h.kv)?.accountId).toBe(first.accountId);

    // And no second account was built behind it.
    expect(h.db.count("accounts")).toBe(1);
    expect(h.db.count("identities", "email = ?", "eric@bullmoose.cc")).toBe(1);
    expect(h.db.count("mailboxes")).toBe(6);
    expect(h.db.count("routes")).toBe(1);
  });

  it("adopting writes nothing to D1 — no orphan account is even attempted", async () => {
    const h = harness();
    await create(h);
    const writesBefore = h.db.writes.length;

    await create(h);
    const added = h.db.writes.slice(writesBefore);
    // `writes` records ATTEMPTS, including statements a rolled-back batch ran,
    // so an empty slice proves the second call never started building account #2.
    expect(added).toEqual([]);
  });

  it("normalizes case, so ERIC@ does not slip past the guard as a second mailbox", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };

    const res = await create(h, { localpart: "ERIC" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { accountId: string }).toMatchObject({
      accountId: first.accountId,
      created: false,
    });
    expect(routeTarget(h.db)).toBe(first.accountId);
    expect(h.db.count("accounts")).toBe(1);
  });

  it("409s when the address already routes to a NON-mailbox, and repoints nothing", async () => {
    const h = harness();
    h.db.seed("routes", [{ domain: DOMAIN, localpart: "team", kind: "forward", target: "ops@example.com" }]);

    const res = await create(h, { localpart: "team" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("already routes somewhere"),
      existingRoute: { kind: "forward", target: "ops@example.com" },
    });

    expect(routeTarget(h.db, "team")).toBe("ops@example.com");
    expect(h.db.count("accounts")).toBe(0);
    // A rejected create must leave NOTHING behind — no KV key pointing at an
    // account that was never wired, and no stray principal either.
    expect(kvRoute(h.kv, "team")).toBeUndefined();
    expect(h.db.count("principals")).toBe(0);
  });

  it("409s when the route points at another tenant's account", async () => {
    const h = harness();
    h.db.seedAccount({ accountId: "other__a_1", tenantId: "t_other", loginEmail: "x@other.test" });
    h.db.seed("identities", [{ id: "i_other", account_id: "other__a_1", email: "eric@bullmoose.cc", name: "Eric" }]);
    h.db.seed("routes", [{ domain: DOMAIN, localpart: "eric", kind: "mailbox", target: "other__a_1" }]);

    const res = await create(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("t_other");
    expect(routeTarget(h.db)).toBe("other__a_1");
    expect(h.db.count("accounts", "tenant_id = ?", TENANT)).toBe(0);
  });

  it("409s when the route points at a mailbox that does not carry this address", async () => {
    const h = harness();
    h.db.seedAccount({ accountId: `${TENANT}__a_squatter`, tenantId: TENANT });
    h.db.seed("routes", [{ domain: DOMAIN, localpart: "eric", kind: "mailbox", target: `${TENANT}__a_squatter` }]);

    const res = await create(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("has no eric@bullmoose.cc identity");
    expect(routeTarget(h.db)).toBe(`${TENANT}__a_squatter`);
  });

  it("409s when the route target account has vanished, rather than taking the row over", async () => {
    const h = harness();
    h.db.seed("routes", [{ domain: DOMAIN, localpart: "eric", kind: "mailbox", target: `${TENANT}__a_ghost` }]);

    const res = await create(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("no longer exists");
    expect(routeTarget(h.db)).toBe(`${TENANT}__a_ghost`);
  });

  it("409s a retry that asks for a DIFFERENT principal than the one that owns the account", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };
    // A second, unrelated login that the retry tries to attach the address to.
    h.db.seed("principals", [
      {
        id: "p_someone_else",
        tenant_id: TENANT,
        login_email: "someone@bullmoose.cc",
        created_at: 1,
      },
    ]);

    const res = await create(h, { principalEmail: "someone@bullmoose.cc" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("owned by principal");
    expect(routeTarget(h.db)).toBe(first.accountId);
    expect(h.db.count("accounts")).toBe(1);
  });

  it("adopts a retry that names the SAME principal", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };

    const res = await create(h, { principalEmail: "eric@bullmoose.cc" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { accountId: string }).toMatchObject({
      accountId: first.accountId,
      created: false,
    });
    expect(routeTarget(h.db)).toBe(first.accountId);
  });
});

describe("POST /accounts — the ingest fast-path key stays consistent with `routes`", () => {
  // ingest resolves delivery through `route:{domain}:{localpart}` ONLY — there
  // is no D1 fallback in resolveRoute — so a missing key is a silent 550 on a
  // control plane that reports healthy. Adopting is the moment to heal it.
  it("repairs a route key that went missing between the batch and the put", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };
    h.kv.store.delete(`route:${DOMAIN}:eric`);

    const res = await create(h);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      created: false,
      repairedRouteKey: "missing",
    });
    expect(kvRoute(h.kv)).toEqual({
      kind: "mailbox",
      accountId: first.accountId,
      tenantId: TENANT,
    });
  });

  it("leaves an already-correct key untouched, so a hand-set forwardTo survives the retry", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };
    // deliver-and-forward is read by ingest and written by no code path here.
    await h.kv.ns.put(
      `route:${DOMAIN}:eric`,
      JSON.stringify({
        kind: "mailbox",
        accountId: first.accountId,
        tenantId: TENANT,
        forwardTo: ["eric@gmail.test"],
      }),
    );

    const res = await create(h);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("repairedRouteKey");
    expect(kvRoute(h.kv)?.forwardTo).toEqual(["eric@gmail.test"]);
  });

  it("reconciles a key that drifted off the routes row, and keeps forwardTo", async () => {
    const h = harness();
    const first = (await (await create(h)).json()) as { accountId: string };
    await h.kv.ns.put(
      `route:${DOMAIN}:eric`,
      JSON.stringify({
        kind: "mailbox",
        accountId: "t_bm__a_stale",
        tenantId: TENANT,
        forwardTo: ["eric@gmail.test"],
      }),
    );

    const res = await create(h);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      repairedRouteKey: "stale",
    });
    expect(kvRoute(h.kv)).toEqual({
      kind: "mailbox",
      accountId: first.accountId, // D1 is the durable record; KV follows it.
      tenantId: TENANT,
      forwardTo: ["eric@gmail.test"],
    });
  });
});

describe("POST /accounts — the primary key is the backstop the pre-check cannot be", () => {
  // The read and the write are separate D1 round-trips, so two concurrent
  // creates both clear the pre-check. `INSERT INTO routes` (not `INSERT OR
  // REPLACE`) is what settles it. Simulated by letting the route row appear
  // after the pre-check has already passed.
  it("rolls the whole batch back and 409s when another writer wins the race", async () => {
    const h = harness();
    let armed = true;

    // The competing request lands the instant the pre-check SELECT has run and
    // found nothing — the exact interleaving the pre-check cannot defend
    // against. Hooked through `bind()` as well as `first()` because D1's
    // `bind()` returns a NEW statement rather than mutating in place.
    const afterPreCheck = () => {
      if (!armed) return;
      armed = false;
      h.db.seedAccount({ accountId: `${TENANT}__a_winner`, tenantId: TENANT });
      h.db.seed("routes", [{ domain: DOMAIN, localpart: "eric", kind: "mailbox", target: `${TENANT}__a_winner` }]);
    };
    const hook = (stmt: D1PreparedStatement): D1PreparedStatement =>
      ({
        bind: (...a: unknown[]) => hook(stmt.bind(...a)),
        first: async (...a: unknown[]) => {
          const out = await (stmt.first as (...x: unknown[]) => Promise<unknown>)(...a);
          afterPreCheck();
          return out;
        },
        run: () => stmt.run(),
        all: () => stmt.all(),
        raw: (o?: { columnNames?: boolean }) => (stmt.raw as (x?: unknown) => Promise<unknown>)(o),
      }) as unknown as D1PreparedStatement;

    const realPrepare = h.db.prepare.bind(h.db);
    h.db.prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      return armed && sql.includes("FROM routes WHERE domain") ? hook(stmt) : stmt;
    };

    const res = await create(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("concurrently");

    // The winner's route is intact and the loser left nothing at all.
    expect(routeTarget(h.db)).toBe(`${TENANT}__a_winner`);
    expect(h.db.count("routes")).toBe(1);
    // D1 batches are atomic: the loser's account/identity/mailboxes all rolled
    // back. Only the winner's seeded account remains.
    expect(h.db.count("accounts")).toBe(1);
    expect(h.db.count("identities")).toBe(0);
    expect(h.db.count("mailboxes")).toBe(0);
    // And crucially it never reached the KV put, so ingest was never pointed
    // at the account that rolled back.
    expect(kvRoute(h.kv)).toBeUndefined();
  });
});
