import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { registerSubmissionMethods } from "./submission";
import type { RequestContext } from "./common";
import type { Env } from "../index";

// EmailSubmission/set is the outbound identity boundary: whatever ends up
// in `envelope.mailFrom` is handed to the relay, and on the Cloudflare
// Email path (packages/outbound/src/index.ts) it becomes the outgoing
// message's actual From: header. These tests drive the registered method
// end-to-end — requireAccount → submitOne → SUBMIT.fetch — against a fake
// D1 / DO / relay, so a regression shows up as a real send, not a mock
// expectation. Per .plans/devPrinciples.md clients are injected, so this
// runs in plain Node with no workerd and no network.

// ---- fakes ------------------------------------------------------------

interface Fixture {
  emails?: Array<Record<string, unknown>>;
  emailMailboxes?: Array<{ email_id: string; mailbox_id: string }>;
  emailKeywords?: Array<{ email_id: string; keyword: string }>;
  mailboxes?: Array<{
    id: string;
    parent_id: string | null;
    name: string;
    role: string | null;
    sort_order: number;
  }>;
  identities?: Array<{ id: string; email: string; name: string }>;
}

/** A fake D1 that routes by SQL and records every write for assertions. */
function fakeD1(fx: Fixture) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];

  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes("FROM emails WHERE account_id")) return fx.emails ?? [];
    if (sql.includes("FROM email_mailboxes")) return fx.emailMailboxes ?? [];
    if (sql.includes("FROM email_keywords")) return fx.emailKeywords ?? [];
    if (sql.includes("FROM mailboxes")) return fx.mailboxes ?? [];
    if (sql.includes("FROM identities")) return fx.identities ?? [];
    return [];
  };

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first() {
        return (rowsFor(sql)[0] as Record<string, unknown> | undefined) ?? null;
      },
      async all() {
        return { results: rowsFor(sql) };
      },
      async run() {
        writes.push({ sql, args: bound });
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  };

  const batch = async (stmts: Array<{ sql: string }>) =>
    stmts.map((s) => ({ results: rowsFor(s.sql) }));

  return { db: { prepare, batch }, writes };
}

/** AccountDO stand-in: only /state and /commit are reached from here. */
function fakeAccountDo() {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/state")) return jsonRes({ state: "s1" });
      if (url.endsWith("/commit")) return jsonRes({ oldState: "s1", newState: "s2" });
      return new Response("not found", { status: 404 });
    },
  };
  return { idFromName: (n: string) => n, get: () => stub };
}

/** The submit worker's /internal/submit, recording what it was handed. */
function fakeSubmit() {
  const calls: Array<{ mailFrom: string; rcptTo: string[] }> = [];
  const binding = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      const body = JSON.parse(String(init?.body)) as {
        envelope: { mailFrom: string; rcptTo: string[] };
      };
      calls.push(body.envelope);
      return jsonRes({ relayMessageId: "relay-1" });
    },
  };
  return { binding, calls };
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

// ---- fixtures ---------------------------------------------------------

const ACCOUNT = "a_eric";
const LOGIN_EMAIL = "eric@login.example";
const IDENTITY_EMAIL = "eric@bullmoose.cc";
const VICTIM = "billing@stripe.com";

const emailRow = (over: Record<string, unknown> = {}) => ({
  id: "e_1",
  blob_id: "b_1",
  thread_id: "t_1",
  message_id: "<m1@bullmoose.cc>",
  in_reply_to: null,
  subject: "hi",
  from_json: JSON.stringify([{ email: IDENTITY_EMAIL }]),
  to_json: JSON.stringify([{ email: "someone@example.com" }]),
  cc_json: "[]",
  bcc_json: "[]",
  preview: "hi",
  size: 42,
  received_at: 1,
  has_attachment: 0,
  attachments_json: "[]",
  ...over,
});

const DRAFTS_MB = { id: "mb_drafts", parent_id: null, name: "Drafts", role: "drafts", sort_order: 1 };
const INBOX_MB = { id: "mb_inbox", parent_id: null, name: "Inbox", role: "inbox", sort_order: 0 };

/** A well-formed draft: `$draft` + filed in the drafts role mailbox. */
const draftFixture = (over: Fixture = {}): Fixture => ({
  emails: [emailRow()],
  emailMailboxes: [{ email_id: "e_1", mailbox_id: DRAFTS_MB.id }],
  emailKeywords: [{ email_id: "e_1", keyword: "$draft" }],
  mailboxes: [DRAFTS_MB],
  identities: [{ id: "id_1", email: IDENTITY_EMAIL, name: "Eric" }],
  ...over,
});

function harness(fx: Fixture) {
  const { db, writes } = fakeD1(fx);
  const submit = fakeSubmit();
  const registry = new MethodRegistry<RequestContext>();
  registerSubmissionMethods(registry);
  const handler = registry.get("EmailSubmission/set")!;

  const ctx: RequestContext = {
    env: {
      DB: db,
      BLOBS: {},
      ROUTES: {},
      ACCOUNT_DO: fakeAccountDo(),
      SUBMIT: submit.binding,
      INTERNAL_TOKEN: "tok",
    } as unknown as Env,
    principal: {
      username: LOGIN_EMAIL,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };

  const call = (create: Record<string, unknown>) =>
    handler({ accountId: ACCOUNT, create }, ctx);

  return { call, relayCalls: submit.calls, writes };
}

/** The envelope persisted by insertSubmission, for the audit-trail check. */
const storedEnvelope = (writes: Array<{ sql: string; args: unknown[] }>) => {
  const row = writes.find((w) => w.sql.includes("INSERT INTO email_submissions"));
  return row ? (JSON.parse(String(row.args[4])) as { mailFrom: string; rcptTo: string[] }) : null;
};

// ---- tests ------------------------------------------------------------

describe("EmailSubmission/set — envelope.mailFrom is bound to the identity", () => {
  it("rejects a mailFrom that does not match the identity, before it reaches the relay", async () => {
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: { mailFrom: { email: VICTIM }, rcptTo: [{ email: "victim@example.com" }] },
      },
    });

    expect(h.relayCalls).toEqual([]);
    expect(res.created).toEqual({});
    expect((res.notCreated as Record<string, { type: string }>).s?.type).toBe("invalidProperties");
  });

  it("accepts the CLI's shape unchanged: identityId + matching mailFrom + explicit rcptTo", async () => {
    // packages/cli/src/main.ts:486-487 sends exactly this, from the
    // identity it resolved via Identity/get. No-regression evidence.
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: {
          mailFrom: { email: IDENTITY_EMAIL },
          rcptTo: [{ email: "to@example.com" }, { email: "bcc@example.com" }],
        },
      },
    });

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toEqual([
      { mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com", "bcc@example.com"] },
    ]);
    expect(storedEnvelope(h.writes)?.mailFrom).toBe(IDENTITY_EMAIL);
  });

  it("compares case-insensitively", async () => {
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: { mailFrom: { email: IDENTITY_EMAIL.toUpperCase() }, rcptTo: [{ email: "x@y.z" }] },
      },
    });

    expect(res.notCreated).toEqual({});
    // The stored/relayed value is the identity's, not the client's casing.
    expect(h.relayCalls[0]?.mailFrom).toBe(IDENTITY_EMAIL);
  });

  it("falls back to the identity email and message recipients with no envelope", async () => {
    const h = harness(
      draftFixture({
        emails: [
          emailRow({
            to_json: JSON.stringify([{ email: "To@example.com" }]),
            cc_json: JSON.stringify([{ email: "cc@example.com" }]),
            bcc_json: JSON.stringify([{ email: "to@example.com" }]),
          }),
        ],
      }),
    );

    const res = await h.call({ s: { emailId: "e_1", identityId: "id_1" } });

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toEqual([
      { mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com", "cc@example.com"] },
    ]);
  });

  it("rejects an unknown identity", async () => {
    const h = harness(draftFixture());

    const res = await h.call({ s: { emailId: "e_1", identityId: "id_nope" } });

    expect(h.relayCalls).toEqual([]);
    expect((res.notCreated as Record<string, { type: string }>).s?.type).toBe("invalidProperties");
  });
});

describe("EmailSubmission/set — the synthesized default identity", () => {
  it("is not offered when the account has real identities", async () => {
    // Identity/get only synthesizes identity_default for an unprovisioned
    // account. Accepting it here regardless would let a client send as its
    // *login* email — a different address, and on a grant-reached account
    // a different person entirely.
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "identity_default",
        envelope: { mailFrom: { email: LOGIN_EMAIL }, rcptTo: [{ email: "x@y.z" }] },
      },
    });

    expect(h.relayCalls).toEqual([]);
    expect((res.notCreated as Record<string, { type: string }>).s?.type).toBe("invalidProperties");
  });

  it("works on an unprovisioned account, and is still bound to the login email", async () => {
    const fx = draftFixture({ identities: [] });

    const ok = harness(fx);
    const res = await ok.call({
      s: {
        emailId: "e_1",
        identityId: "identity_default",
        envelope: { mailFrom: { email: LOGIN_EMAIL }, rcptTo: [{ email: "x@y.z" }] },
      },
    });
    expect(res.notCreated).toEqual({});
    expect(ok.relayCalls).toEqual([{ mailFrom: LOGIN_EMAIL, rcptTo: ["x@y.z"] }]);

    const bad = harness(fx);
    const res2 = await bad.call({
      s: {
        emailId: "e_1",
        identityId: "identity_default",
        envelope: { mailFrom: { email: VICTIM }, rcptTo: [{ email: "x@y.z" }] },
      },
    });
    expect(bad.relayCalls).toEqual([]);
    expect((res2.notCreated as Record<string, { type: string }>).s?.type).toBe("invalidProperties");
  });
});

describe("EmailSubmission/set — only drafts may be submitted", () => {
  it("refuses a stored non-draft message (received mail cannot be re-relayed)", async () => {
    const h = harness(
      draftFixture({
        emailMailboxes: [{ email_id: "e_1", mailbox_id: INBOX_MB.id }],
        emailKeywords: [{ email_id: "e_1", keyword: "$seen" }],
        mailboxes: [INBOX_MB],
      }),
    );

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: { mailFrom: { email: IDENTITY_EMAIL }, rcptTo: [{ email: "victim@example.com" }] },
      },
    });

    expect(h.relayCalls).toEqual([]);
    expect((res.notCreated as Record<string, { type: string }>).s?.type).toBe("forbidden");
  });

  it("accepts a draft identified only by the $draft keyword", async () => {
    const h = harness(
      draftFixture({
        emailMailboxes: [{ email_id: "e_1", mailbox_id: INBOX_MB.id }],
        mailboxes: [INBOX_MB],
      }),
    );

    const res = await h.call({
      s: { emailId: "e_1", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } },
    });

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toHaveLength(1);
  });

  it("accepts a draft identified only by the drafts role mailbox", async () => {
    const h = harness(draftFixture({ emailKeywords: [] }));

    const res = await h.call({
      s: { emailId: "e_1", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } },
    });

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toHaveLength(1);
  });
});
