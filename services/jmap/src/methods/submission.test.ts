import { afterEach, describe, expect, it, vi } from "vitest";
import { MethodRegistry, dispatch, type Invocation } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorkerOptions } from "@bullmoose/test-fakes";
import { registerEmailMethods } from "./email";
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

const DRAFTS_MB = {
  id: "mb_drafts",
  parent_id: null,
  name: "Drafts",
  role: "drafts",
  sort_order: 1,
};
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

function harness(fx: Fixture, scopes: string[] = ["mail"], envOpts: FakeWorkerOptions = {}) {
  const w = fakeEnv(envOpts);
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

  const call = (create: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    handler({ accountId: ACCOUNT, create, ...extra }, ctx);
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
    expect(h.relayCalls).toEqual([{ mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com", "bcc@example.com"] }]);
    expect(storedEnvelope(h.writes)?.mailFrom).toBe(IDENTITY_EMAIL);
  });

  it("compares case-insensitively", async () => {
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: {
          mailFrom: { email: IDENTITY_EMAIL.toUpperCase() },
          rcptTo: [{ email: "x@y.z" }],
        },
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
    expect(h.relayCalls).toEqual([{ mailFrom: IDENTITY_EMAIL, rcptTo: ["to@example.com", "cc@example.com"] }]);
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
        envelope: {
          mailFrom: { email: IDENTITY_EMAIL },
          rcptTo: [{ email: "victim@example.com" }],
        },
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
        submissions: [submissionRow(), submissionRow({ id: "es_2", send_at: 1_700_000_005_000 })],
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
    h.w.db.seed("email_submissions", [{ account_id: "a_someone_else", ...submissionRow({ id: "es_theirs" }) }]);

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

// ---- stored == wire: the Message-ID reconcile -------------------------

describe("EmailSubmission/set — the stored Message-ID adopts the relay's wire id", () => {
  // The exact shape SES substitutes, pinned against the 2026-08-19 Gmail
  // specimen: our raw message left stamped `<uuid@bullmoose.cc>` and arrived
  // as `<{sesMessageId}@us-west-2.amazonses.com>`, Message-ID inside both
  // validating DKIM h= lists. Stamping harder cannot win; reconciling from
  // the relay's answer is the only honest direction.
  const SES_WIRE_ID = "010101a01ba9762b-e5f1e023-e0f0-41d5-a521-0eecaf2a634b-000000@us-west-2.amazonses.com";

  const send = (h: ReturnType<typeof harness>) =>
    h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: { mailFrom: { email: IDENTITY_EMAIL }, rcptTo: [{ email: "to@example.com" }] },
      },
    });

  it("rewrites the email row's message_id to the id the relay put on the wire", async () => {
    const h = harness(draftFixture(), ["mail"], { relayStampedMessageId: SES_WIRE_ID });

    const res = await send(h);
    expect(res.notCreated).toEqual({});

    const row = await new Mailstore(h.w.env.DB, h.w.env.BLOBS).getEmailRow(ACCOUNT, "e_1");
    expect(row?.messageId).toBe(SES_WIRE_ID);
  });

  it("announces the email as updated, so clients drop their cached (stale) id", async () => {
    const h = harness(draftFixture(), ["mail"], { relayStampedMessageId: SES_WIRE_ID });

    const res = await send(h);
    expect(res.notCreated).toEqual({});

    const ch = await h.w.accountDo.changes(ACCOUNT, "Email", res.oldState as string);
    expect(ch.updated).toContain("e_1");
  });

  it("leaves the stored id alone when the relay reports nothing (a relay that preserves the header)", async () => {
    // Default fake submit: `{relayMessageId}` only — the Cloudflare/mock
    // contract, where the wire carries the blob's own Message-ID and the
    // stored value is already the wire value.
    const h = harness(draftFixture());

    const res = await send(h);
    expect(res.notCreated).toEqual({});

    const row = await new Mailstore(h.w.env.DB, h.w.env.BLOBS).getEmailRow(ACCOUNT, "e_1");
    expect(row?.messageId).toBe("<m1@bullmoose.cc>"); // the seeded value, untouched
    const ch = await h.w.accountDo.changes(ACCOUNT, "Email", res.oldState as string);
    expect(ch.updated).not.toContain("e_1");
  });

  it("reconciled id and onSuccessUpdateEmail patch announce ONE Email update, not two", async () => {
    const h = harness(draftFixture(), ["mail"], { relayStampedMessageId: SES_WIRE_ID });

    const res = await h.call(
      {
        s: {
          emailId: "e_1",
          identityId: "id_1",
          envelope: { mailFrom: { email: IDENTITY_EMAIL }, rcptTo: [{ email: "to@example.com" }] },
        },
      },
      // The standard "clear $draft on success" dance, so this send both
      // reconciles the Message-ID AND patches the email.
      { onSuccessUpdateEmail: { "#s": { "keywords/$draft": null } } },
    );
    expect(res.notCreated).toEqual({});

    const ch = await h.w.accountDo.changes(ACCOUNT, "Email", res.oldState as string);
    expect(ch.updated.filter((id: string) => id === "e_1")).toHaveLength(1);
  });
});

// =======================================================================
// RFC 8620 §3.3 creation references — the batched create + submit round
// trip. A single request `[Email/set create "big", EmailSubmission/set
// {emailId: "#big"}]` is how batching clients send mail; before the
// dispatcher grew a creation-id map this failed `invalidProperties
// "email #big not found"` — found live, third-party client, 2026-08-19.
// =======================================================================

const draftCreateSpec = {
  mailboxIds: { [DRAFTS_MB.id]: true },
  keywords: { $draft: true },
  from: [{ email: IDENTITY_EMAIL }],
  to: [{ email: "someone@example.com" }],
  subject: "batched",
  textBody: [{ partId: "t" }],
  bodyValues: { t: { value: "hello" } },
};

/** A registry with BOTH Email and EmailSubmission methods, driven through
 * the real dispatcher — creation references resolve there or nowhere. */
function dispatchHarness(fx: Fixture = draftFixture()) {
  const h = harness(fx);
  const registry = new MethodRegistry<RequestContext>();
  registerEmailMethods(registry);
  registerSubmissionMethods(registry);
  const ctx: RequestContext = {
    env: h.w.env,
    principal: {
      username: LOGIN_EMAIL,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: "t_bm", name: "Eric" }],
    },
  };
  const run = (methodCalls: Invocation[], createdIds?: Record<string, string>) =>
    dispatch({ using: [], methodCalls, ...(createdIds ? { createdIds } : {}) }, registry, ctx, "0");
  return { ...h, run };
}

describe("EmailSubmission/set — #creationId back-references (RFC 8620 §3.3)", () => {
  it("create draft + submit it, one request: emailId '#big' resolves to the created draft", async () => {
    const h = dispatchHarness();

    const res = await h.run([
      ["Email/set", { accountId: ACCOUNT, create: { big: draftCreateSpec } }, "0"],
      [
        "EmailSubmission/set",
        {
          accountId: ACCOUNT,
          create: { s: { emailId: "#big", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } } },
          onSuccessUpdateEmail: { "#s": { "keywords/$draft": null } },
        },
        "1",
      ],
    ]);

    const [emailSet, subSet] = res.methodResponses as [Invocation, Invocation];
    expect(emailSet[0]).toBe("Email/set");
    expect(subSet[0]).toBe("EmailSubmission/set");

    const draftId = (emailSet[1].created as Record<string, { id: string }>).big!.id;
    const created = (subSet[1].created as Record<string, { id: string; undoStatus: string }>).s;
    expect(created?.undoStatus).toBe("final");
    expect(h.relayCalls).toEqual([{ mailFrom: IDENTITY_EMAIL, rcptTo: ["x@y.z"] }]);

    // The submission row points at the resolved draft, not at a literal "#big".
    const [row] = h.w.db.query<{ email_id: string }>(
      `SELECT email_id FROM email_submissions WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      created!.id,
    );
    expect(row?.email_id).toBe(draftId);

    // And the onSuccess patch landed on the resolved draft too.
    expect(
      h.w.db.count("email_keywords", "account_id = ? AND email_id = ? AND keyword = '$draft'", ACCOUNT, draftId),
    ).toBe(0);
  });

  it("an unresolvable ref is refused BY NAME, before anything relays", async () => {
    const h = dispatchHarness();

    const res = await h.run([
      ["EmailSubmission/set", { accountId: ACCOUNT, create: { s: { emailId: "#big", identityId: "id_1" } } }, "0"],
    ]);

    const [subSet] = res.methodResponses as [Invocation];
    expect(subSet[0]).toBe("EmailSubmission/set");
    const err = (subSet[1].notCreated as Record<string, { type: string; description?: string }>).s;
    expect(err?.type).toBe("invalidProperties");
    expect(err?.description).toContain("#big");
    expect(h.relayCalls).toEqual([]);
  });

  it("request.createdIds seeds the map (a ref minted in a PRIOR request resolves)", async () => {
    const h = dispatchHarness();

    const res = await h.run(
      [
        [
          "EmailSubmission/set",
          {
            accountId: ACCOUNT,
            create: { s: { emailId: "#big", identityId: "id_1", envelope: { rcptTo: [{ email: "x@y.z" }] } } },
          },
          "0",
        ],
      ],
      { big: "e_1" }, // e_1 is the seeded draft
    );

    expect(h.relayCalls).toHaveLength(1);
    // Per spec the response echoes the merged map — the seed plus this
    // request's own creation.
    const created = ((res.methodResponses[0] as Invocation)[1].created as Record<string, { id: string }>).s!;
    expect(res.createdIds).toEqual({ big: "e_1", s: created.id });
  });

  it("a request without createdIds gets no createdIds in the response", async () => {
    const h = dispatchHarness();
    const res = await h.run([["Email/set", { accountId: ACCOUNT, create: { big: draftCreateSpec } }, "0"]]);
    expect(res.createdIds).toBeUndefined();
  });
});

// =======================================================================
// onSuccessDestroyEmail (RFC 8621 §7.5) — "discard the draft once it
// sends". Before this existed the argument was silently ignored and every
// send-and-discard client accumulated ghost drafts.
// =======================================================================

describe("EmailSubmission/set — onSuccessDestroyEmail", () => {
  it("destroys the sent draft via '#cid', through the changelog", async () => {
    const h = harness(draftFixture());

    const res = await h.call(
      {
        s: {
          emailId: "e_1",
          identityId: "id_1",
          envelope: { mailFrom: { email: IDENTITY_EMAIL }, rcptTo: [{ email: "x@y.z" }] },
        },
      },
      { onSuccessDestroyEmail: ["#s"] },
    );

    expect(res.notCreated).toEqual({});
    expect(h.relayCalls).toHaveLength(1);
    expect(h.w.db.count("emails", "account_id = ? AND id = 'e_1'", ACCOUNT)).toBe(0);

    // Clients learn about it the same way they learn about any change.
    const emails = await h.w.accountDo.changes(ACCOUNT, "Email", res.oldState as string);
    expect(emails.destroyed).toContain("e_1");
    expect(emails.updated).not.toContain("e_1");
    const boxes = await h.w.accountDo.changes(ACCOUNT, "Mailbox", res.oldState as string);
    expect(boxes.updated).toContain(DRAFTS_MB.id);
  });

  it("does not destroy when the send failed, and ignores unknown refs", async () => {
    const h = harness(draftFixture());

    const res = await h.call(
      { s: { emailId: "e_1", identityId: "id_nope" } },
      { onSuccessDestroyEmail: ["#s", "#never-existed", "es_unknown"] },
    );

    expect((res.notCreated as Record<string, { type: string }>).s?.type).toBe("invalidProperties");
    expect(h.relayCalls).toEqual([]);
    expect(h.w.db.count("emails", "account_id = ? AND id = 'e_1'", ACCOUNT)).toBe(1);
  });
});

// =======================================================================
// Delayed send (RFC 8621 §7, capability maxDelayedSend) — the window in
// which "cancel" can mean something. Found live: a client's undo button
// against undoStatus:final, with maxDelayedSend advertised as 0, so undo
// could never exist. A future release time holds the row `pending` on the
// AccountDO alarm; `undoStatus: "canceled"` wins or loses a compare-and-
// swap against the relay claim, and the loser hears about it honestly.
// =======================================================================

describe("EmailSubmission/set — delayed send", () => {
  const T0 = Date.parse("2026-08-19T12:00:00.000Z");
  const HOLD = 60_000;
  const SEND_AT = new Date(T0 + HOLD).toISOString();

  const frozen = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  };
  afterEach(() => vi.useRealTimers());

  type H = ReturnType<typeof harness>;
  const createHeld = async (h: H, extra: Record<string, unknown> = {}) => {
    const res = await h.call(
      { s: { emailId: "e_1", identityId: "id_1", sendAt: SEND_AT, envelope: { rcptTo: [{ email: "x@y.z" }] } } },
      extra,
    );
    const created = (res.created as Record<string, { id: string; undoStatus: string; sendAt: string }>).s;
    return { res, id: created?.id as string, created };
  };
  const rowOf = (h: H, id: string) =>
    h.w.db.query<{ undo_status: string; relay_message_id: string | null; send_at: number }>(
      `SELECT undo_status, relay_message_id, send_at FROM email_submissions WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0];
  const cancel = (h: H, id: string, extra: Record<string, unknown> = {}) =>
    h.call({}, { update: { [id]: { undoStatus: "canceled" } }, ...extra });

  it("a future sendAt holds the send: no relay, pending row, armed alarm", async () => {
    frozen();
    const h = harness(draftFixture());

    const { res, id, created } = await createHeld(h);

    expect(res.notCreated).toEqual({});
    expect(created).toMatchObject({ undoStatus: "pending", sendAt: SEND_AT });
    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, id)).toMatchObject({ undo_status: "pending", relay_message_id: null, send_at: T0 + HOLD });
    expect(h.w.accountDo.alarmAt(ACCOUNT)).toBe(T0 + HOLD);

    // /get reads it back as a submission a client could still cancel.
    const got = await h.get({ ids: [id] });
    expect(got.list[0]).toMatchObject({ id, undoStatus: "pending", sendAt: SEND_AT });
  });

  it("the RFC 8621/4865 spelling — HOLDFOR on envelope.mailFrom.parameters — holds too", async () => {
    frozen();
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        envelope: { mailFrom: { email: IDENTITY_EMAIL, parameters: { holdfor: "120" } }, rcptTo: [{ email: "x@y.z" }] },
      },
    });

    const created = (res.created as Record<string, { id: string; undoStatus: string }>).s!;
    expect(created.undoStatus).toBe("pending");
    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, created.id)?.send_at).toBe(T0 + 120_000);
  });

  it("the alarm relays at sendAt, and deferred onSuccessUpdateEmail fires at RELAY time", async () => {
    frozen();
    const h = harness(draftFixture());

    const { res, id } = await createHeld(h, { onSuccessUpdateEmail: { "#s": { "keywords/$draft": null } } });

    // The hold is the whole point: while the send is cancelable the draft
    // must still LOOK like a draft — the patch has not been applied.
    expect(h.w.db.count("email_keywords", "account_id = ? AND email_id = 'e_1' AND keyword = '$draft'", ACCOUNT)).toBe(
      1,
    );

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toEqual([{ mailFrom: IDENTITY_EMAIL, rcptTo: ["x@y.z"] }]);
    expect(rowOf(h, id)).toMatchObject({ undo_status: "final", relay_message_id: "relay-1" });
    expect(h.w.db.count("email_keywords", "account_id = ? AND email_id = 'e_1' AND keyword = '$draft'", ACCOUNT)).toBe(
      0,
    );

    // Both the flip to final and the deferred patch reach the changelog.
    const subs = await h.w.accountDo.changes(ACCOUNT, "EmailSubmission", res.newState as string);
    expect(subs.updated).toContain(id);
    const emails = await h.w.accountDo.changes(ACCOUNT, "Email", res.newState as string);
    expect(emails.updated).toContain("e_1");
  });

  it("pending → canceled: the alarm then never relays, and deferred destroy never fires", async () => {
    frozen();
    const h = harness(draftFixture());

    const { res, id } = await createHeld(h, { onSuccessDestroyEmail: ["#s"] });
    const res2 = await cancel(h, id);

    expect((res2.updated as Record<string, unknown>)[id]).toBeNull();
    expect(rowOf(h, id)?.undo_status).toBe("canceled");
    const subs = await h.w.accountDo.changes(ACCOUNT, "EmailSubmission", res.newState as string);
    expect(subs.updated).toContain(id);

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, id)?.undo_status).toBe("canceled");
    expect(h.w.db.count("emails", "account_id = ? AND id = 'e_1'", ACCOUNT)).toBe(1);
  });

  it("after the alarm has fired, cancel refuses with cannotUnsend", async () => {
    frozen();
    const h = harness(draftFixture());

    const { id } = await createHeld(h);
    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);
    expect(h.relayCalls).toHaveLength(1);

    const res2 = await cancel(h, id);

    expect((res2.notUpdated as Record<string, { type: string }>)[id]?.type).toBe("cannotUnsend");
    expect(rowOf(h, id)?.undo_status).toBe("final");
    expect(h.relayCalls).toHaveLength(1); // and certainly no second relay
  });

  it("cancel of an immediate (final) submission refuses with cannotUnsend", async () => {
    const h = harness(draftFixture({ submissions: [submissionRow()] }));
    const res = await h.call({}, { update: { es_seeded: { undoStatus: "canceled" } } });
    expect((res.notUpdated as Record<string, { type: string }>).es_seeded?.type).toBe("cannotUnsend");
  });

  it("cancel is idempotent: an already-canceled submission updates cleanly", async () => {
    const h = harness(
      draftFixture({ submissions: [submissionRow({ id: "es_c", undo_status: "canceled", relay_message_id: null })] }),
    );
    const res = await h.call({}, { update: { es_c: { undoStatus: "canceled" } } });
    expect((res.updated as Record<string, unknown>).es_c).toBeNull();
  });

  it("update accepts exactly {undoStatus: 'canceled'} and nothing else", async () => {
    const h = harness(
      draftFixture({ submissions: [submissionRow({ id: "es_p", undo_status: "pending", relay_message_id: null })] }),
    );

    const res = await h.call(
      {},
      {
        update: {
          es_p: { undoStatus: "final" },
          "#nope": { undoStatus: "canceled" },
        },
      },
    );

    const notUpdated = res.notUpdated as Record<string, { type: string }>;
    expect(notUpdated.es_p?.type).toBe("invalidProperties");
    expect(notUpdated["#nope"]?.type).toBe("notFound");
    expect(rowOf(h, "es_p")?.undo_status).toBe("pending");

    const res2 = await h.call({}, { update: { es_p: { sendAt: SEND_AT } } });
    expect((res2.notUpdated as Record<string, { type: string }>).es_p?.type).toBe("invalidProperties");
  });

  it("a sendAt beyond maxDelayedSend is refused by name", async () => {
    frozen();
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        sendAt: new Date(T0 + 3 * 86_400_000).toISOString(),
        envelope: { rcptTo: [{ email: "x@y.z" }] },
      },
    });

    const err = (res.notCreated as Record<string, { type: string; description?: string }>).s;
    expect(err?.type).toBe("invalidProperties");
    expect(err?.description).toContain("maxDelayedSend");
    expect(h.relayCalls).toEqual([]);
    expect(h.w.db.count("email_submissions", "account_id = ?", ACCOUNT)).toBe(0);
  });

  it("a sendAt in the past means now: relayed immediately, final", async () => {
    frozen();
    const h = harness(draftFixture());

    const res = await h.call({
      s: {
        emailId: "e_1",
        identityId: "id_1",
        sendAt: new Date(T0 - 1000).toISOString(),
        envelope: { rcptTo: [{ email: "x@y.z" }] },
      },
    });

    expect((res.created as Record<string, { undoStatus: string }>).s?.undoStatus).toBe("final");
    expect(h.relayCalls).toHaveLength(1);
  });

  it("deferred onSuccessDestroyEmail destroys the draft at relay time, not accept time", async () => {
    frozen();
    const h = harness(draftFixture());

    const { res, id } = await createHeld(h, { onSuccessDestroyEmail: ["#s"] });
    expect(h.w.db.count("emails", "account_id = ? AND id = 'e_1'", ACCOUNT)).toBe(1);

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toHaveLength(1);
    expect(rowOf(h, id)?.undo_status).toBe("final");
    expect(h.w.db.count("emails", "account_id = ? AND id = 'e_1'", ACCOUNT)).toBe(0);
    const emails = await h.w.accountDo.changes(ACCOUNT, "Email", res.newState as string);
    expect(emails.destroyed).toContain("e_1");
  });

  it("the undo dance: cancel + onSuccessUpdateEmail by plain id applies the patch NOW", async () => {
    frozen();
    const h = harness(draftFixture());

    const { id } = await createHeld(h);
    const res2 = await cancel(h, id, { onSuccessUpdateEmail: { [id]: { "keywords/$restored": true } } });

    expect((res2.updated as Record<string, unknown>)[id]).toBeNull();
    expect(
      h.w.db.count("email_keywords", "account_id = ? AND email_id = 'e_1' AND keyword = '$restored'", ACCOUNT),
    ).toBe(1);
  });

  it("a draft destroyed during the hold resolves to canceled, never a relay of dead bytes", async () => {
    frozen();
    const h = harness(draftFixture());

    const { res, id } = await createHeld(h);
    await new Mailstore(h.w.env.DB, h.w.env.BLOBS).destroyEmail(ACCOUNT, "e_1");

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, id)?.undo_status).toBe("canceled");
    const subs = await h.w.accountDo.changes(ACCOUNT, "EmailSubmission", res.newState as string);
    expect(subs.updated).toContain(id);
  });

  it("a transient relay failure re-queues with backoff and stays cancellable", async () => {
    frozen();
    const h = harness(draftFixture());
    const { id } = await createHeld(h);

    const binding = h.w.env.SUBMIT as unknown as { fetch: (...a: unknown[]) => Promise<Response> };
    const realFetch = binding.fetch;
    binding.fetch = async () => new Response("boom", { status: 500 });

    const fireAt = T0 + HOLD + 1;
    vi.setSystemTime(fireAt);
    await h.w.accountDo.runAlarm(ACCOUNT);

    // Claim reverted, retry armed — the user can still cancel while we wait.
    expect(rowOf(h, id)?.undo_status).toBe("pending");
    expect(h.w.accountDo.alarmAt(ACCOUNT)).toBe(fireAt + 60_000);

    binding.fetch = realFetch;
    vi.setSystemTime(fireAt + 60_001);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toHaveLength(1);
    expect(rowOf(h, id)?.undo_status).toBe("final");
  });

  it("a cancel during the retry window wins: the retry relays nothing", async () => {
    frozen();
    const h = harness(draftFixture());
    const { id } = await createHeld(h);

    const binding = h.w.env.SUBMIT as unknown as { fetch: (...a: unknown[]) => Promise<Response> };
    const realFetch = binding.fetch;
    binding.fetch = async () => new Response("boom", { status: 500 });
    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);
    binding.fetch = realFetch;

    const res2 = await cancel(h, id);
    expect((res2.updated as Record<string, unknown>)[id]).toBeNull();

    vi.setSystemTime(T0 + HOLD + 1 + 60_001);
    await h.w.accountDo.runAlarm(ACCOUNT);
    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, id)?.undo_status).toBe("canceled");
  });

  it("a relay-stamped Message-ID reconciles at relay time — delayed sends thread like immediate ones", async () => {
    frozen();
    const SES_ID = "<ses-stamped@wire.example>";
    const h = harness(draftFixture(), ["mail"], { relayStampedMessageId: SES_ID });

    const { res, id } = await createHeld(h);
    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(rowOf(h, id)?.undo_status).toBe("final");
    const row = await new Mailstore(h.w.env.DB, h.w.env.BLOBS).getEmailRow(ACCOUNT, "e_1");
    // normalizeMessageId stores the bare form, same as the immediate path.
    expect(row?.messageId).toBe("ses-stamped@wire.example");
    const emails = await h.w.accountDo.changes(ACCOUNT, "Email", res.newState as string);
    expect(emails.updated).toContain("e_1");
  });

  it("gives up after MAX attempts on an unreachable relay: canceled, said out loud", async () => {
    frozen();
    const h = harness(
      draftFixture({ submissions: [submissionRow({ id: "es_p", undo_status: "pending", relay_message_id: null })] }),
    );

    // Inject the queue entry directly with attempts already at the brink —
    // the accept path can never mint one this way, but nine failed passes do.
    await h.w.env.ACCOUNT_DO.get(h.w.env.ACCOUNT_DO.idFromName(ACCOUNT)).fetch("https://do/delay", {
      method: "POST",
      body: JSON.stringify({
        submissionId: "es_p",
        accountId: ACCOUNT,
        tenantId: "t_bm",
        emailId: "e_1",
        envelope: { mailFrom: IDENTITY_EMAIL, rcptTo: ["x@y.z"] },
        fireAt: T0 + HOLD,
        principal: LOGIN_EMAIL,
        onSuccessPatch: null,
        onSuccessDestroy: false,
        attempts: 9,
      }),
    });

    const binding = h.w.env.SUBMIT as unknown as { fetch: (...a: unknown[]) => Promise<Response> };
    binding.fetch = async () => {
      throw new Error("network down");
    };

    const before = await h.w.accountDo.state(ACCOUNT);
    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(h.relayCalls).toEqual([]);
    expect(rowOf(h, "es_p")?.undo_status).toBe("canceled");
    const subs = await h.w.accountDo.changes(ACCOUNT, "EmailSubmission", before);
    expect(subs.updated).toContain("es_p");
  });

  it("deferred patch: full-replace form applies, an unusable path is skipped, the send still lands", async () => {
    frozen();
    const h = harness(draftFixture());

    const { id } = await createHeld(h, {
      onSuccessUpdateEmail: { "#s": { keywords: { $sent: true }, "bogus/deep/path": true } },
    });

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(rowOf(h, id)?.undo_status).toBe("final");
    expect(h.w.db.count("email_keywords", "account_id = ? AND email_id = 'e_1' AND keyword = '$sent'", ACCOUNT)).toBe(
      1,
    );
    expect(h.w.db.count("email_keywords", "account_id = ? AND email_id = 'e_1' AND keyword = '$draft'", ACCOUNT)).toBe(
      0,
    );
  });

  it("a deferred patch that would leave the email in no mailbox is skipped, never fails the send", async () => {
    frozen();
    const h = harness(draftFixture());

    const { id } = await createHeld(h, { onSuccessUpdateEmail: { "#s": { [`mailboxIds/${DRAFTS_MB.id}`]: null } } });

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(rowOf(h, id)?.undo_status).toBe("final");
    expect(h.relayCalls).toHaveLength(1);
    expect(
      h.w.db.count("email_mailboxes", "account_id = ? AND email_id = 'e_1' AND mailbox_id = ?", ACCOUNT, DRAFTS_MB.id),
    ).toBe(1);
  });

  it("a permanent relay refusal (422 suppression) resolves to canceled, not an eternal pending", async () => {
    frozen();
    const h = harness(draftFixture());
    const { res, id } = await createHeld(h);

    const binding = h.w.env.SUBMIT as unknown as { fetch: (...a: unknown[]) => Promise<Response> };
    binding.fetch = async () => new Response(JSON.stringify({ error: "recipients suppressed" }), { status: 422 });

    vi.setSystemTime(T0 + HOLD + 1);
    await h.w.accountDo.runAlarm(ACCOUNT);

    expect(rowOf(h, id)?.undo_status).toBe("canceled");
    const subs = await h.w.accountDo.changes(ACCOUNT, "EmailSubmission", res.newState as string);
    expect(subs.updated).toContain(id);

    // And it does not come back: a later pass has nothing left to do.
    vi.setSystemTime(T0 + HOLD + 120_000);
    await h.w.accountDo.runAlarm(ACCOUNT);
    expect(rowOf(h, id)?.undo_status).toBe("canceled");
  });
});
