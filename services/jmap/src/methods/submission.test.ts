import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerSubmissionMethods } from "./submission";
import type { RequestContext } from "./common";

// EmailSubmission/set is the outbound identity boundary: whatever ends up
// in `envelope.mailFrom` is handed to the relay, and on the Cloudflare
// Email path (packages/outbound/src/index.ts) it becomes the outgoing
// message's actual From: header. These tests drive the registered method
// end-to-end — requireAccount → submitOne → SUBMIT.fetch — against a fake
// D1 / DO / relay, so a regression shows up as a real send, not a mock
// expectation. Per .plans/devPrinciples.md clients are injected, so this
// runs in plain Node with no workerd and no network.

// The fakes are @bullmoose/test-fakes (sVOL 002): real SQLite on the live
// schema, a real R2, and the REAL AccountDO behind ACCOUNT_DO. The fixture is
// now the ROW — seeded into the actual table Mailstore queries — rather than a
// canned answer to a SQL substring, so a query against the wrong table is an
// error instead of a pass.

// ---- fixtures ---------------------------------------------------------

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
  /** Pre-existing rows in `email_submissions`, for /get without a live send. */
  submissions?: Array<Record<string, unknown>>;
}

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

function harness(fx: Fixture, scopes: string[] = ["mail"]) {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: LOGIN_EMAIL, displayName: "Eric" });
  const withAccount = <T extends object>(rows: T[]) => rows.map((r) => ({ account_id: ACCOUNT, ...r }));
  w.db.seed("emails", withAccount(fx.emails ?? []));
  w.db.seed("email_mailboxes", withAccount(fx.emailMailboxes ?? []));
  w.db.seed("email_keywords", withAccount(fx.emailKeywords ?? []));
  w.db.seed("mailboxes", withAccount(fx.mailboxes ?? []));
  w.db.seed("identities", withAccount(fx.identities ?? []));
  w.db.seed("email_submissions", withAccount(fx.submissions ?? []));

  const registry = new MethodRegistry<RequestContext>();
  registerSubmissionMethods(registry);
  const handler = registry.get("EmailSubmission/set")!;
  const getHandler = registry.get("EmailSubmission/get")!;
  const changesHandler = registry.get("EmailSubmission/changes")!;

  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: LOGIN_EMAIL,
      scopes,
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };

  const call = (create: Record<string, unknown>) =>
    handler({ accountId: ACCOUNT, create }, ctx);
  const get = async (args: Record<string, unknown> = {}) =>
    (await getHandler({ accountId: ACCOUNT, ...args }, ctx)) as unknown as GetResponse;
  const changes = async (sinceState: string) =>
    (await changesHandler({ accountId: ACCOUNT, sinceState }, ctx)) as unknown as {
      created: string[];
      updated: string[];
      destroyed: string[];
    };

  return { call, get, changes, relayCalls: w.submit.calls, writes: w.db.writes, w };
}

/** The `/get` response, typed only as far as the assertions need. */
interface GetResponse {
  accountId: string;
  state: string;
  list: Array<Record<string, unknown>>;
  notFound: string[];
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

// =======================================================================
// EmailSubmission/get — sVOL 005
//
// The gap this closes is a registry inconsistency, not a feature: `/set`
// commits created ids to the AccountDO changelog and `/changes` reports
// them, so the server has always told clients WHICH submissions changed
// while offering no method to read them. The first suite below is that
// exact sequence — /set → /changes → /get — because it is what a
// conformant client runs and what dead-ended before this unit.
//
// The second suite is the more important one. `/get` must not claim a
// delivery outcome it cannot know: SES bounce/complaint events land in a
// KV suppression list keyed by RECIPIENT (services/submit/src/index.ts)
// and are never correlated back onto a submission's relay_message_id, so
// there is no per-recipient status to report. `deliveryStatus: null` is
// the honest answer and these tests pin it as a deliberate choice rather
// than an oversight a future patch can quietly "fix" with a synthesized
// "unknown" map.
// =======================================================================

const submissionRow = (over: Record<string, unknown> = {}) => ({
  id: "es_seeded",
  email_id: "e_1",
  identity_id: "id_1",
  envelope_json: JSON.stringify({ mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com"] }),
  undo_status: "final",
  relay_message_id: "relay-1",
  send_at: 1_700_000_000_000,
  ...over,
});

describe("EmailSubmission/get — the /changes → /get round trip", () => {
  it("resolves every id /changes reported, with the envelope that was sent", async () => {
    const h = harness(draftFixture());

    const set = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: {
          mailFrom: { email: IDENTITY_EMAIL },
          rcptTo: [{ email: "to@example.com" }, { email: "bcc@example.com" }],
        },
      },
    });
    const submissionId = (set.created as Record<string, { id: string }>).s!.id;

    // Exactly the sequence a conformant client runs: ask what changed since
    // the pre-write state, then read those ids.
    const delta = await h.changes(set.oldState as string);
    expect(delta.created).toEqual([submissionId]);

    const got = await h.get({ ids: delta.created });
    expect(got.notFound).toEqual([]);
    expect(got.list).toHaveLength(1);
    expect(got.list[0]).toMatchObject({
      id: submissionId,
      emailId: "e_1",
      identityId: "id_1",
      threadId: "t_1",
      envelope: {
        mailFrom: { email: IDENTITY_EMAIL, parameters: null },
        rcptTo: [
          { email: "to@example.com", parameters: null },
          { email: "bcc@example.com", parameters: null },
        ],
      },
    });
  });

  it("returns the state /set committed, not one computed some other way", async () => {
    // /set commits through the AccountDO (commitChanges); a row inserted by a
    // future path that skips that commit, or a /get that derives state
    // independently, shows up HERE rather than as an unexplained client
    // resync months later.
    const h = harness(draftFixture());

    const set = await h.call({
      s: { emailId: "e_1", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } },
    });

    const got = await h.get({ ids: [(set.created as Record<string, { id: string }>).s!.id] });
    expect(got.state).toBe(set.newState);
    expect(got.state).not.toBe(set.oldState);
  });

  it("re-inflates the envelope into the shape /set accepts", async () => {
    // The row stores the flattened form the relay wants; RFC 8621 §7 puts
    // EmailSubmissionAddress objects on the wire. Read → re-submit has to
    // work without the client reshaping anything.
    const h = harness(draftFixture({ submissions: [submissionRow()] }));

    const got = await h.get({ ids: ["es_seeded"] });
    const envelope = got.list[0]!.envelope as {
      mailFrom: { email: string };
      rcptTo: Array<{ email: string }>;
    };

    const replay = await h.call({
      s: { emailId: "e_1", identityId: "id_1", envelope },
    });
    expect(replay.notCreated).toEqual({});
    expect(h.relayCalls).toEqual([{ mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com"] }]);
  });
});

describe("EmailSubmission/get — it does not claim a delivery status it cannot know", () => {
  it("returns deliveryStatus null rather than a synthesized 'unknown' map", async () => {
    // Nothing correlates SES events back to a submission (they become KV
    // suppression keys on the RECIPIENT). A fabricated per-recipient map
    // would be spec-legal — so nothing would ever flag it — and a future
    // surface would render "unknown" as though the server had checked.
    const h = harness(draftFixture({ submissions: [submissionRow()] }));

    const got = await h.get({ ids: ["es_seeded"] });
    expect(got.list[0]!.deliveryStatus).toBeNull();
    expect(got.list[0]!.dsnBlobIds).toEqual([]);
    expect(got.list[0]!.mdnBlobIds).toEqual([]);
  });

  it("echoes undoStatus from the row instead of hardcoding 'final'", async () => {
    // Today the column only ever holds 'final' and that is TRUE — the row is
    // written only after the relay accepted, so the send cannot be undone.
    // Hardcoding it would read identically today and lie the moment delayed
    // send lands, so seed the value the product cannot yet produce.
    const h = harness(
      draftFixture({
        submissions: [
          submissionRow(),
          submissionRow({ id: "es_pending", undo_status: "pending", send_at: 1_700_000_001_000 }),
          submissionRow({ id: "es_canceled", undo_status: "canceled", send_at: 1_700_000_002_000 }),
        ],
      }),
    );

    const got = await h.get({ ids: ["es_seeded", "es_pending", "es_canceled"] });
    const byId = new Map(got.list.map((s) => [s.id as string, s.undoStatus]));
    expect(byId.get("es_seeded")).toBe("final");
    expect(byId.get("es_pending")).toBe("pending");
    expect(byId.get("es_canceled")).toBe("canceled");
  });

  it("does not leak the relay's message id", async () => {
    // relay_message_id is stored (it is the correlation key a future
    // delivery-status unit needs) but is not an RFC 8621 property.
    const h = harness(draftFixture({ submissions: [submissionRow()] }));

    const got = await h.get({ ids: ["es_seeded"] });
    expect(JSON.stringify(got.list[0])).not.toContain("relay-1");
  });
});

describe("EmailSubmission/get — ids, accounts, and scope", () => {
  it("returns every submission for the account when ids is null", async () => {
    const h = harness(
      draftFixture({
        submissions: [
          submissionRow(),
          submissionRow({ id: "es_2", send_at: 1_700_000_005_000 }),
        ],
      }),
    );

    const got = await h.get({ ids: null });
    expect(got.list.map((s) => s.id)).toEqual(["es_2", "es_seeded"]); // newest first
    expect(got.notFound).toEqual([]);
  });

  it("returns nothing for ids: [] — an empty request, not a request for everything", async () => {
    const h = harness(draftFixture({ submissions: [submissionRow()] }));

    const got = await h.get({ ids: [] });
    expect(got.list).toEqual([]);
    expect(got.notFound).toEqual([]);
  });

  it("never returns another account's submission, and reports its id as notFound", async () => {
    const h = harness(draftFixture({ submissions: [submissionRow()] }));
    // Seeded straight past `withAccount` so it belongs to someone else.
    h.w.db.seed("email_submissions", [
      { account_id: "a_someone_else", ...submissionRow({ id: "es_theirs" }) },
    ]);

    const got = await h.get({ ids: ["es_seeded", "es_theirs"] });
    expect(got.list.map((s) => s.id)).toEqual(["es_seeded"]);
    expect(got.notFound).toEqual(["es_theirs"]);

    const all = await h.get({ ids: null });
    expect(all.list.map((s) => s.id)).toEqual(["es_seeded"]);
  });

  it("resolves threadId from the email, and reads null once the email is gone", async () => {
    const h = harness(
      draftFixture({
        submissions: [submissionRow(), submissionRow({ id: "es_orphan", email_id: "e_gone" })],
      }),
    );

    const got = await h.get({ ids: ["es_seeded", "es_orphan"] });
    const byId = new Map(got.list.map((s) => [s.id as string, s.threadId]));
    expect(byId.get("es_seeded")).toBe("t_1");
    // The LEFT JOIN must not drop the row — an orphaned submission is still a
    // submission, and `email_submissions` declares no foreign key.
    expect(byId.get("es_orphan")).toBeNull();
  });

  it("honours `properties`, always including id", async () => {
    const h = harness(draftFixture({ submissions: [submissionRow()] }));

    const got = await h.get({ ids: ["es_seeded"], properties: ["undoStatus"] });
    expect(got.list[0]).toEqual({ id: "es_seeded", undoStatus: "final" });
  });

  it("a send-scoped token may create submissions AND read them back — send implies read", async () => {
    // common/027: any write capability implies `read` — you must be able to see
    // what you send. `send` is the write here, so the same token that creates a
    // submission may also read it. This USED to be a deliberate refusal
    // ('token lacks the "read" scope'); 027 closed it. `send` still stays its
    // own irreversible capability and implies ONLY read — never move/delete.
    const h = harness(draftFixture({ submissions: [submissionRow()] }), ["send"]);

    // The same token CAN send — this is a read gate, not an account gate.
    const set = await h.call({
      s: { emailId: "e_1", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } },
    });
    expect(set.notCreated).toEqual({});

    const got = await h.get({ ids: ["es_seeded"] });
    expect(got.list.map((s) => s.id)).toContain("es_seeded");
  });
});
