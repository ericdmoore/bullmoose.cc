import { beforeEach, describe, expect, it } from "vitest";
import { QUARANTINE_ROLE } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { __resetBoundaryBloomCache, rebuildBoundaryBloom } from "./boundary";
import worker, { type Env } from "./index";

/**
 * The s12 boundary cascade, proven against the REAL handler — worker.email()
 * for the edge-reject and DefaultCase pins (that path owns setReject), the
 * /dev/inject fetch path for row-level verdict assertions (the fts.test.ts /
 * facetStamp.test.ts precedent; both funnel into the same deliver()).
 *
 * The three tier verdicts under test map 1:1 onto the readme's table:
 *   deny-listed domain   → REJECT-AT-EDGE: 5xx, ZERO storage, a daily counter
 *                          and NEVER a chain row (counters-not-chains)
 *   blocked book         → REJECT-STORE: full message in the quarantine
 *                          mailbox + a 'shunted' chain row naming the stage
 *   known-good (default
 *   contacts book)       → ACCEPT fast-path, sender_class='known', remaining
 *                          rejection stages skipped
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_boundary";
const TOKEN = "internal-test-token";
const SENDER = "sender@elsewhere.test";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function scaffold(): Promise<FakeWorker> {
  const w = fakeEnv();
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
  // A live binding, so "no invocation was created" is a real assertion and
  // not the vacuous absence of any binding at all.
  w.db.seed("agent_bindings", [
    { id: "bind_b", account_id: ACCOUNT, name: "emily", config_json: "{}" },
  ]);
  return w;
}

let bookSeq = 0;
/** An address book with one individual card per member address. */
function seedBook(
  w: FakeWorker,
  opts: { accountId: string; name: string; isDefault?: boolean; members: string[] },
): string {
  const id = `ab_${++bookSeq}`;
  w.db.seed("address_books", [
    {
      id,
      account_id: opts.accountId,
      name: opts.name,
      sort_order: 0,
      is_default: opts.isDefault ? 1 : 0,
      is_subscribed: 1,
      ctag: 0,
      created_at: 1,
      updated_at: 1,
      write_policy: "open",
    },
  ]);
  w.db.seed(
    "contact_cards",
    opts.members.map((address, i) => ({
      id: `${id}_c${i}`,
      account_id: opts.accountId,
      address_book_id: id,
      uid: `${id}-u${i}`,
      card_json: JSON.stringify({ uid: `${id}-u${i}`, kind: "individual", emails: { e0: { address } } }),
      created_at: 1,
      updated_at: 1,
    })),
  );
  return id;
}

const boundaryEnv = (w: FakeWorker) => ({ DB: w.env.DB, BLOBS: w.env.BLOBS, ROUTES: w.env.ROUTES });

/** Raw RFC 5322. `topHeaders` are PREPENDED — where our MX's headers sit. */
const mime = (opts: { subject?: string; body?: string; topHeaders?: string[] } = {}) =>
  [
    ...(opts.topHeaders ?? []),
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject ?? "hello"}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@elsewhere.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Quarterly numbers, no rush.",
  ].join("\r\n");

interface InjectResult {
  rejected?: string;
  emailId?: string;
  invocations?: number;
  quarantined?: string;
}

async function inject(w: FakeWorker, raw: string, from = SENDER): Promise<InjectResult> {
  const res = await worker.fetch(
    new Request(
      `https://ingest.test/dev/inject?from=${encodeURIComponent(from)}&to=ada@example.test`,
      { method: "POST", headers: { "x-internal-token": TOKEN }, body: raw },
    ),
    { ...w.env, DEV_INJECT: "1" } as unknown as Env,
    ctx(),
  );
  return (await res.json()) as InjectResult;
}

/** A ForwardableEmailMessage good enough for worker.email(). */
function fakeMessage(raw: string, from = SENDER) {
  const rejections: string[] = [];
  const forwards: string[] = [];
  const msg = {
    from,
    to: "ada@example.test",
    raw: new Response(raw).body,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: (reason: string) => rejections.push(reason),
    forward: async (addr: string) => {
      forwards.push(addr);
    },
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
  return { msg, rejections, forwards };
}

const roleMailboxId = (w: FakeWorker, role: string): string | null =>
  w.db.query<{ id: string }>(
    `SELECT id FROM mailboxes WHERE account_id = ? AND role = ?`,
    ACCOUNT,
    role,
  )[0]?.id ?? null;

const mailboxesOf = (w: FakeWorker, emailId: string): string[] =>
  w.db
    .query<{ mailbox_id: string }>(
      `SELECT mailbox_id FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
      ACCOUNT,
      emailId,
    )
    .map((r) => r.mailbox_id);

const seedDeny = (w: FakeWorker, domain: string, source = "feed") =>
  w.db.seed("domain_deny_list", [
    { tenant_id: TENANT, domain, added_at: 1, source, evidence: null },
  ]);

beforeEach(() => __resetBoundaryBloomCache());

// ---------------------------------------------------------------------------

describe("stage 1 — REJECT-AT-EDGE (industrial tier)", () => {
  it("deny-listed domain: setReject fires, NOTHING is stored, the counter bumps — twice", async () => {
    const w = await scaffold();
    seedDeny(w, "elsewhere.test");
    await rebuildBoundaryBloom(boundaryEnv(w));

    for (const expectedCount of [1, 2]) {
      const { msg, rejections, forwards } = fakeMessage(mime());
      await worker.email(msg, w.env as unknown as Env, ctx());
      expect(rejections).toEqual(["550 5.7.1 sender address rejected"]);
      expect(forwards).toEqual([]);

      // Zero storage: no email row, no R2 object, no invocation.
      expect(w.db.count("emails")).toBe(0);
      expect(w.blobs.objects.size).toBe(0);
      expect(w.db.count("agent_invocations")).toBe(0);
      // Counters, NOT chains: the industrial tier's only per-message write.
      expect(w.db.count("quarantine_events")).toBe(0);
      const day = new Date().toISOString().slice(0, 10);
      expect(
        w.db.query<{ count: number }>(
          `SELECT count FROM deny_counters WHERE domain = ? AND day = ?`,
          "elsewhere.test",
          day,
        )[0]?.count,
      ).toBe(expectedCount);
    }
  });

  it("the deny list is tenant-scoped: another tenant's entry does not fire", async () => {
    const w = await scaffold();
    w.db.seed("domain_deny_list", [
      { tenant_id: "t_other", domain: "elsewhere.test", added_at: 1, source: "feed", evidence: null },
    ]);
    await rebuildBoundaryBloom(boundaryEnv(w)); // shard-wide bloom DOES contain it…
    const res = await inject(w, mime());
    expect(res.rejected).toBeUndefined(); // …but the exact check scopes by tenant
    expect(res.emailId).toBeDefined();
    expect(w.db.count("deny_counters")).toBe(0);
  });

  it("with NO bloom published, the exact checks still decide (bloom is a fast path, not the source of truth)", async () => {
    const w = await scaffold();
    seedDeny(w, "elsewhere.test");
    const res = await inject(w, mime());
    expect(res.rejected).toBe("550 5.7.1 sender address rejected");
  });
});

describe("stage 1 — the bloom fronts the blocked union", () => {
  it("ABS_NO skips the exact checks; a rebuild (new version) picks the entry up", async () => {
    const w = await scaffold();
    // v1 is built while the deny list is EMPTY…
    const v1 = await rebuildBoundaryBloom(boundaryEnv(w));
    expect(v1).toEqual({ version: 1, entries: 0 });
    // …then the domain lands without a rebuild: ABS_NO must let it through
    // (that IS the contract — the hot path pays nothing for legit mail, and
    // every write path that ADDS a blocked entry must rebuild).
    seedDeny(w, "elsewhere.test");
    const before = await inject(w, mime());
    expect(before.rejected).toBeUndefined();

    const v2 = await rebuildBoundaryBloom(boundaryEnv(w));
    expect(v2).toEqual({ version: 2, entries: 1 });
    // Same isolate, new version: the per-message version check reloads.
    const after = await inject(w, mime());
    expect(after.rejected).toBe("550 5.7.1 sender address rejected");
  });
});

describe("stage 1 — REJECT-STORE (blocked books)", () => {
  it("personal blocked book: stored in the QUARANTINE mailbox with a 'shunted' chain row; no invocation, no forward", async () => {
    const w = await scaffold();
    // deliver-AND-forward configured — a shunted message must NOT propagate.
    await w.env.ROUTES.put(
      "route:example.test:ada",
      JSON.stringify({
        kind: "mailbox",
        accountId: ACCOUNT,
        tenantId: TENANT,
        forwardTo: ["backup@gmail.test"],
      }),
    );
    seedBook(w, { accountId: ACCOUNT, name: "Blocked", members: [SENDER] });
    await rebuildBoundaryBloom(boundaryEnv(w));

    const { msg, rejections, forwards } = fakeMessage(mime({ subject: "one weird trick" }));
    await worker.email(msg, w.env as unknown as Env, ctx());

    expect(rejections).toEqual([]); // accepted at SMTP — rescuable, never bounced
    expect(forwards).toEqual([]);

    const emailId = w.db.query<{ id: string }>(`SELECT id FROM emails WHERE account_id = ?`, ACCOUNT)[0]!.id;
    const quarantineId = roleMailboxId(w, QUARANTINE_ROLE);
    expect(quarantineId).not.toBeNull();
    expect(mailboxesOf(w, emailId)).toEqual([quarantineId]);
    expect(roleMailboxId(w, "inbox")).toBeNull(); // inbox never even created
    // The mailbox it lands in is the REGISTERED role under OUR name (s12): a
    // standards client applies its spam handling to `junk`, and would treat an
    // invented role as an ordinary folder. Asserted on the row rather than on
    // the constant, so a lazily-created mailbox cannot drift from provisioning.
    expect(
      w.db.query<{ role: string; name: string }>(
        `SELECT role, name FROM mailboxes WHERE account_id = ? AND id = ?`,
        ACCOUNT,
        quarantineId,
      ),
    ).toEqual([{ role: "junk", name: "Quarantined" }]);

    const events = w.db.query<{
      event: string;
      sender: string;
      domain: string;
      stage: string;
      email_id: string;
      actor: string | null;
    }>(`SELECT event, sender, domain, stage, email_id, actor FROM quarantine_events WHERE account_id = ?`, ACCOUNT);
    expect(events).toEqual([
      {
        event: "shunted",
        sender: SENDER,
        domain: "elsewhere.test",
        stage: "blocked-book:personal",
        email_id: emailId,
        actor: null,
      },
    ]);

    expect(w.db.count("agent_invocations")).toBe(0); // never reaches the lobby
    expect(w.db.count("deny_counters")).toBe(0); // counters are the industrial tier's
  });

  it("tenant blocked book, named by KV config, fires for a recipient on another account", async () => {
    const w = await scaffold();
    const bouncerAccount = "t_bm__a_bouncer";
    const bookId = seedBook(w, { accountId: bouncerAccount, name: "HouseBlocked", members: [SENDER] });
    await w.env.ROUTES.put(
      `boundary:tenant-blocked:${TENANT}`,
      JSON.stringify({ accountId: bouncerAccount, bookId }),
    );
    await rebuildBoundaryBloom(boundaryEnv(w)); // KV-configured books are unioned in

    const res = await inject(w, mime());
    expect(res.quarantined).toBe("blocked-book:tenant");
    expect(w.db.count("quarantine_events", "stage = ?", "blocked-book:tenant")).toBe(1);
  });

  it("blocked beats known-good: an explicit block on a contact still blocks", async () => {
    const w = await scaffold();
    seedBook(w, { accountId: ACCOUNT, name: "Contacts", isDefault: true, members: [SENDER] });
    seedBook(w, { accountId: ACCOUNT, name: "Blocked", members: [SENDER] });
    await rebuildBoundaryBloom(boundaryEnv(w));

    const res = await inject(w, mime());
    expect(res.quarantined).toBe("blocked-book:personal");
    expect(res.invocations).toBeUndefined();
  });
});

describe("stage 1 — known-good ACCEPT and the unknown CONTINUE", () => {
  it("default-book member → inbox, sender_class='known', and the remaining rejection stages are SKIPPED", async () => {
    const w = await scaffold();
    seedBook(w, { accountId: ACCOUNT, name: "Contacts", isDefault: true, members: [SENDER] });
    // A dmarc=fail that stage 2 would quarantine — ACCEPT must skip it.
    const res = await inject(
      w,
      mime({ topHeaders: ["Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=fail"] }),
    );
    expect(res.quarantined).toBeUndefined();
    expect(res.invocations).toBe(1);
    expect(
      w.db.query<{ sender_class: string }>(
        `SELECT sender_class FROM agent_invocations WHERE account_id = ?`,
        ACCOUNT,
      )[0]!.sender_class,
    ).toBe("known");
  });

  it("a default book exists but the sender is not in it → delivered, sender_class='unknown'", async () => {
    const w = await scaffold();
    seedBook(w, { accountId: ACCOUNT, name: "Contacts", isDefault: true, members: ["friend@known.test"] });
    const res = await inject(w, mime());
    expect(res.invocations).toBe(1);
    expect(
      w.db.query<{ sender_class: string | null }>(
        `SELECT sender_class FROM agent_invocations WHERE account_id = ?`,
        ACCOUNT,
      )[0]!.sender_class,
    ).toBe("unknown");
  });
});

describe("stage 2 — envelope auth (Authentication-Results)", () => {
  it("topmost dmarc=fail → quarantined, stage 'auth:dmarc'", async () => {
    const w = await scaffold();
    const res = await inject(
      w,
      mime({
        topHeaders: [
          "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass header.d=elsewhere.test; dmarc=fail header.from=elsewhere.test",
        ],
      }),
    );
    expect(res.quarantined).toBe("auth:dmarc");
    const events = w.db.query<{ stage: string; email_id: string }>(
      `SELECT stage, email_id FROM quarantine_events WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(events).toEqual([{ stage: "auth:dmarc", email_id: res.emailId! }]);
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, QUARANTINE_ROLE)]);
  });

  it("dmarc=pass → delivered; header absent → delivered (pass/absent record nothing)", async () => {
    const w = await scaffold();
    const pass = await inject(
      w,
      mime({ topHeaders: ["Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass"] }),
    );
    expect(pass.quarantined).toBeUndefined();
    const absent = await inject(w, mime());
    expect(absent.quarantined).toBeUndefined();
    expect(w.db.count("quarantine_events")).toBe(0);
  });

  it("only the TOPMOST header is trusted: an attacker's dmarc=fail below ours is ignored", async () => {
    const w = await scaffold();
    const res = await inject(
      w,
      mime({
        topHeaders: [
          "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass",
          "Authentication-Results: evil.example; dmarc=fail",
        ],
      }),
    );
    expect(res.quarantined).toBeUndefined();
    expect(res.invocations).toBe(1);
  });

  it("dmarc=none is not a fail signal (conservative: explicit fail only)", async () => {
    const w = await scaffold();
    const res = await inject(
      w,
      mime({ topHeaders: ["Authentication-Results: mx.cloudflare.net; dmarc=none"] }),
    );
    expect(res.quarantined).toBeUndefined();
  });
});

describe("DefaultCase — pinned against the real email() handler", () => {
  it("empty deny list + no books + no rules ⇒ the flow is byte-identical to pre-s12 ingest", async () => {
    const w = await scaffold();
    const { msg, rejections, forwards } = fakeMessage(mime({ subject: "numbers" }));
    await worker.email(msg, w.env as unknown as Env, ctx());

    expect(rejections).toEqual([]);
    expect(forwards).toEqual([]);

    // Exactly one stored email, in exactly the inbox.
    const emails = w.db.query<{ id: string }>(`SELECT id FROM emails WHERE account_id = ?`, ACCOUNT);
    expect(emails).toHaveLength(1);
    const inboxId = roleMailboxId(w, "inbox");
    expect(inboxId).not.toBeNull();
    expect(mailboxesOf(w, emails[0]!.id)).toEqual([inboxId]);

    // The only mailbox is the inbox — no quarantine mailbox materializes
    // until a shunt actually happens.
    expect(
      w.db.query<{ role: string }>(`SELECT role FROM mailboxes WHERE account_id = ?`, ACCOUNT).map((r) => r.role),
    ).toEqual(["inbox"]);

    // The enqueue is today's enqueue: pending, and every s12-authored column
    // NULL (sender_class is the one this wave COULD have written).
    const inv = w.db.query<{
      status: string;
      sender_class: string | null;
      effort_prior: string | null;
      privacy: string | null;
      due_at: number | null;
    }>(
      `SELECT status, sender_class, effort_prior, privacy, due_at FROM agent_invocations WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(inv).toEqual([
      { status: "pending", sender_class: null, effort_prior: null, privacy: null, due_at: null },
    ]);

    // No boundary table was touched, no boundary key was written.
    expect(w.db.count("quarantine_events")).toBe(0);
    expect(w.db.count("deny_counters")).toBe(0);
    expect(w.db.count("domain_deny_list")).toBe(0);
    expect([...w.kv.store.keys()].filter((k) => k.startsWith("boundary:"))).toEqual([]);
  });

  it("fails OPEN: a shard with no quarantine_events table delivers a would-be shunt to the inbox", async () => {
    const w = await scaffold();
    seedBook(w, { accountId: ACCOUNT, name: "Blocked", members: [SENDER] });
    await rebuildBoundaryBloom(boundaryEnv(w));
    // The pre-migration world: quarantine_events does not exist. The
    // REJECT-STORE batch fails whole and delivery must degrade to the inbox
    // (this is what makes quarantine-events-table a NON-blocking migration).
    w.db.sqlite.exec("DROP TABLE quarantine_events");

    const res = await inject(w, mime());
    expect(res.rejected).toBeUndefined();
    expect(res.quarantined).toBeUndefined();
    expect(res.emailId).toBeDefined();
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, "inbox")]);
  });
});
