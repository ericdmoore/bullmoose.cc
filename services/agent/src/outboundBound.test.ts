import { describe, expect, it } from "vitest";
import { Mailstore, type ContactWriter } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import agentWorker from "./index";

/**
 * s10 T1 — the outbound bound, driven through the REAL cloud drain.
 *
 * `allowedSenders` (inbound, index.ts) got its outbound twin: before any
 * submit, the binding's governing book (`recipients_book_id`) is resolved and
 * every recipient must match its membership by normalized EXACT equality.
 * The ledger pipeline is the vehicle because its pass-along forward is a
 * deterministic direct egress (no model call): an allowed run produces a
 * relayed envelope in `w.submit.calls`, a refused run produces a noted
 * invocation and NOTHING relayed — the Bureau's fail-closed shape, one realm
 * over.
 */

const ACCOUNT = "t_bm__a_allen";
const TENANT = "t_bm";
const SELF = "analyst@bullmoose.cc";
const SENDER = "human@example.com";
const BOOK = "ab_reach";

const HUMAN: ContactWriter = { principal: "eric@bullmoose.cc", kind: "human" };

const ledgerConfig = (digestTo: string) => JSON.stringify({ pipeline: "ledger", requireAuth: false, digestTo });

interface ScaffoldOpts {
  digestTo: string;
  /** null = binding has NO governing book (the fail-closed case). */
  recipientsBookId?: string | null;
  /** Seed the governing book row itself (default true when referenced). */
  seedBook?: boolean;
  /** Addresses seeded into the book, one individual card each. */
  members?: string[];
  /** Wire Message-ID the fake relay claims to have stamped (SES contract). */
  relayStampedMessageId?: string;
}

async function scaffold(opts: ScaffoldOpts) {
  const w = fakeEnv(
    opts.relayStampedMessageId === undefined ? {} : { relayStampedMessageId: opts.relayStampedMessageId },
  );
  const store = new Mailstore(w.env.DB, w.env.BLOBS);

  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Allen" });
  w.db.seed("identities", [{ id: "id_allen", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_allen",
      account_id: ACCOUNT,
      name: "allen",
      config_json: ledgerConfig(opts.digestTo),
      recipients_book_id: opts.recipientsBookId === null ? null : (opts.recipientsBookId ?? BOOK),
    },
  ]);
  if (opts.seedBook !== false && opts.recipientsBookId !== null) {
    w.db.seed("address_books", [
      {
        id: BOOK,
        account_id: ACCOUNT,
        name: "allen may email",
        sort_order: 0,
        is_default: 0,
        is_subscribed: 1,
        ctag: 0,
        created_at: 1,
        updated_at: 1,
        write_policy: "governed",
      },
    ]);
    for (const [i, address] of (opts.members ?? []).entries()) {
      await store.insertContactCard(
        ACCOUNT,
        {
          id: `cc_m${i}`,
          addressBookId: BOOK,
          uid: `u_m${i}`,
          card: { uid: `u_m${i}`, emails: { e: { address } } },
          nameFull: address,
          davName: null,
          createdAt: 1,
          updatedAt: 1,
        },
        HUMAN,
      );
    }
  }

  // A plain non-receipt message: the ledger pass-along FORWARDS it to
  // digestTo — the deterministic egress these tests observe.
  const raw = buildMime({
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    subject: "checking in",
    messageId: "msg-1@example.com",
    date: new Date(1_000_000),
    text: "hello there, nothing financial here",
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(TENANT, ACCOUNT, buf);
  const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
  await store.insertEmail(ACCOUNT, {
    id: "e_1",
    blobId,
    threadId: "t_1",
    messageId: "msg-1@example.com",
    inReplyTo: null,
    subject: "checking in",
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    cc: [],
    bcc: [],
    preview: "hello there",
    size: raw.byteLength,
    receivedAt: 1_000_000,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [inboxId],
    keywords: [],
  });

  let seq = 0;
  const invoke = async () => {
    const id = `inv_${++seq}`;
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_allen",
        binding_name: "allen",
        status: "pending",
        email_id: "e_1",
        context_json: "{}",
        created_at: seq,
      },
    ]);
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
    return w.db.query<{ status: string; note: string | null }>(
      `SELECT status, note FROM agent_invocations WHERE account_id = ? AND id = ?`,
      ACCOUNT,
      id,
    )[0]!;
  };

  return { w, store, invoke };
}

const relayed = (w: FakeWorker) => w.submit.calls.map((c) => c.rcptTo).flat();

describe("fail-closed: unbound means CANNOT SEND, never unrestricted", () => {
  it("a binding with no recipients_book_id is refused, noted like the allowedSenders skip", async () => {
    const s = await scaffold({ digestTo: "eric@moore.coffee", recipientsBookId: null });
    const inv = await s.invoke();
    expect(inv.status).toBe("done");
    expect(inv.note).toMatch(/outbound bound.*no governing book/);
    expect(s.w.submit.calls).toEqual([]);
  });

  it("a recipients_book_id pointing at a missing book is refused", async () => {
    const s = await scaffold({ digestTo: "eric@moore.coffee", seedBook: false });
    const inv = await s.invoke();
    expect(inv.note).toMatch(/governing book ab_reach does not exist/);
    expect(s.w.submit.calls).toEqual([]);
  });

  it("an EMPTY governing book cannot send to anyone", async () => {
    const s = await scaffold({ digestTo: "eric@moore.coffee", members: [] });
    const inv = await s.invoke();
    expect(inv.note).toMatch(/not in the governing book: eric@moore.coffee/);
    expect(s.w.submit.calls).toEqual([]);
  });
});

describe("exact-match: normalized equality, never LIKE", () => {
  it("bob@evil.com does not match a book holding bob@good.com", async () => {
    const s = await scaffold({ digestTo: "bob@evil.com", members: ["bob@good.com"] });
    const inv = await s.invoke();
    expect(inv.note).toMatch(/not in the governing book: bob@evil\.com/);
    expect(s.w.submit.calls).toEqual([]);
  });

  it("Bob@GOOD.com case-folds to match bob@good.com", async () => {
    const s = await scaffold({ digestTo: "Bob@GOOD.com", members: ["bob@good.com"] });
    const inv = await s.invoke();
    expect(inv.note).not.toMatch(/outbound bound/);
    expect(s.w.submit.calls).toHaveLength(1);
  });

  it("plus-tags do NOT auto-match: bob+tag@good.com ≠ bob@good.com", async () => {
    const s = await scaffold({ digestTo: "bob+tag@good.com", members: ["bob@good.com"] });
    const inv = await s.invoke();
    expect(inv.note).toMatch(/not in the governing book: bob\+tag@good\.com/);
    expect(s.w.submit.calls).toEqual([]);
  });

  it("a superstring domain is refused — no substring semantics anywhere", async () => {
    const s = await scaffold({ digestTo: "bob@good.com.evil.io", members: ["bob@good.com"] });
    const inv = await s.invoke();
    expect(inv.note).toMatch(/not in the governing book/);
    expect(s.w.submit.calls).toEqual([]);
  });
});

describe("groups: contact-group members count as members", () => {
  it("a recipient reachable only through a group in the book is allowed", async () => {
    const s = await scaffold({ digestTo: "carol@x.com", members: [] });
    // carol's card lives OUTSIDE the book; the book holds a group naming her.
    await s.store.insertContactCard(
      ACCOUNT,
      {
        id: "cc_carol",
        addressBookId: "ab_other",
        uid: "u_carol",
        card: { uid: "u_carol", emails: { e: { address: "carol@x.com" } } },
        nameFull: "Carol",
        davName: null,
        createdAt: 1,
        updatedAt: 1,
      },
      HUMAN,
    );
    await s.store.insertContactCard(
      ACCOUNT,
      {
        id: "cc_fam",
        addressBookId: BOOK,
        uid: "u_fam",
        card: { uid: "u_fam", kind: "group", members: { u_carol: true } },
        nameFull: "family",
        davName: null,
        createdAt: 1,
        updatedAt: 1,
      },
      HUMAN,
    );
    const inv = await s.invoke();
    expect(inv.note).not.toMatch(/outbound bound/);
    expect(relayed(s.w)).toEqual(["carol@x.com"]);
  });
});

describe("widen → send → narrow is fully reconstructable", () => {
  it("membership gates each send, and the chain holds every transition with its actor", async () => {
    const s = await scaffold({ digestTo: "bob@good.com", members: [] });

    // Empty book: refused.
    expect((await s.invoke()).note).toMatch(/not in the governing book/);

    // WIDEN (human, through the chokepoint): now it sends.
    const bob = {
      id: "cc_bob",
      addressBookId: BOOK,
      uid: "u_bob",
      card: { uid: "u_bob", emails: { e: { address: "bob@good.com" } } },
      nameFull: "Bob",
      davName: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await s.store.insertContactCard(ACCOUNT, bob, HUMAN);
    expect((await s.invoke()).note).not.toMatch(/outbound bound/);
    expect(s.w.submit.calls).toHaveLength(1);

    // NARROW: refused again — and the removal is ON the chain, not a hole.
    await s.store.destroyContactCard(ACCOUNT, "cc_bob", HUMAN);
    expect((await s.invoke()).note).toMatch(/not in the governing book/);
    expect(s.w.submit.calls).toHaveLength(1);

    // Re-widen: allowed once more.
    await s.store.insertContactCard(
      ACCOUNT,
      {
        ...bob,
        id: "cc_bob2",
        uid: "u_bob2",
        card: { uid: "u_bob2", emails: { e: { address: "bob@good.com" } } },
      },
      HUMAN,
    );
    expect((await s.invoke()).note).not.toMatch(/outbound bound/);
    expect(s.w.submit.calls).toHaveLength(2);

    // The record of the window: added / removed / added-back, each attributed.
    const log = await s.store.bookMembershipLog(ACCOUNT, BOOK);
    expect(log.map((r) => ({ event: r.event, address: r.address, actor: r.actor }))).toEqual([
      { event: "added", address: "bob@good.com", actor: "eric@bullmoose.cc" },
      { event: "removed", address: "bob@good.com", actor: "eric@bullmoose.cc" },
      { event: "added", address: "bob@good.com", actor: "eric@bullmoose.cc" },
    ]);
  });
});

describe("the reply pipeline shares the gate", () => {
  it("a send-mode reply binding with no governing book proposes nothing and sends nothing", async () => {
    const w = fakeEnv();
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
    w.db.seed("identities", [{ id: "id_e", account_id: ACCOUNT, email: SELF }]);
    w.db.seed("agent_bindings", [
      {
        id: "bind_e",
        account_id: ACCOUNT,
        name: "emily",
        config_json: JSON.stringify({
          pipeline: "reply",
          replyMode: "send",
          defaultModel: "cheap",
          modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
        }),
        // recipients_book_id deliberately absent — fail-closed.
      },
    ]);
    const raw = buildMime({
      from: [{ email: SENDER }],
      to: [{ email: SELF }],
      subject: "hi",
      messageId: "m2@example.com",
      date: new Date(1_000_000),
      text: "please answer",
    });
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const blobId = await store.putBlob(TENANT, ACCOUNT, buf);
    const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
    await store.insertEmail(ACCOUNT, {
      id: "e_r",
      blobId,
      threadId: "t_r",
      messageId: "m2@example.com",
      inReplyTo: null,
      subject: "hi",
      from: [{ email: SENDER }],
      to: [{ email: SELF }],
      cc: [],
      bcc: [],
      preview: "please answer",
      size: raw.byteLength,
      receivedAt: 1_000_000,
      hasAttachment: false,
      attachments: [],
      mailboxIds: [inboxId],
      keywords: [],
    });
    w.db.seed("agent_invocations", [
      {
        id: "inv_r",
        account_id: ACCOUNT,
        binding_id: "bind_e",
        binding_name: "emily",
        status: "pending",
        email_id: "e_r",
        context_json: "{}",
        created_at: 1,
      },
    ]);
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
    const inv = w.db.query<{ status: string; note: string | null }>(
      `SELECT status, note FROM agent_invocations WHERE id = 'inv_r'`,
    )[0]!;
    expect(inv.status).toBe("done");
    expect(inv.note).toMatch(/outbound bound.*no governing book/);
    // Neither egress NOR a proposal: an unbounded agent does not even ask.
    expect(w.submit.calls).toEqual([]);
    expect(w.db.count("agent_proposals")).toBe(0);
  });
});

describe("stored == wire: the agent's Sent copy adopts the relay's Message-ID", () => {
  it("a ledger send stores its row under the id SES stamped, not the one buildMime did", async () => {
    // Same divergence as the human path (services/jmap submission.ts): SES
    // substitutes its own Message-ID for the header in the relayed blob, and
    // the human this agent mailed will reply citing the SES id. The ledger
    // inserts its Sent copy AFTER the relay answers, so the row is born with
    // the wire id — resolveThreadId then threads that reply home.
    const SES_WIRE_ID = "010101a01ba9762b-e5f1e023-e0f0-41d5-a521-0eecaf2a634b-000000@us-west-2.amazonses.com";
    const s = await scaffold({
      digestTo: "bob@good.com",
      members: ["bob@good.com"],
      relayStampedMessageId: SES_WIRE_ID,
    });

    const inv = await s.invoke();
    expect(inv.note).not.toMatch(/outbound bound/);
    expect(s.w.submit.calls).toHaveLength(1);

    const sent = s.w.db.query<{ message_id: string }>(
      `SELECT message_id FROM emails WHERE account_id = ? AND id != 'e_1'`,
      ACCOUNT,
    );
    expect(sent.map((r) => r.message_id)).toEqual([SES_WIRE_ID]);
  });
});
