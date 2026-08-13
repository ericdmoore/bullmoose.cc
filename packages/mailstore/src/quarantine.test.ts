import { describe, expect, it } from "vitest";
import { fakeD1, fakeR2, type FakeD1 } from "@bullmoose/test-fakes";
import { Mailstore, type NewEmail } from "./index";

/**
 * The s12 quarantine chain + the rescue write path (wave 1-A).
 *
 * The chain discipline under test is book_membership_log's: message and
 * 'shunted' row commit in ONE batch or neither, rescues append (never
 * rewrite), and the graduated-domain demotion is the ONE deny-list write a
 * rescue may perform — the human correction wins over the graduation loop,
 * and over nothing else.
 */

const ACCOUNT = "t_bm__a_q";
const SENDER = "sender@spamfarm.test";
const DOMAIN = "spamfarm.test";

function harness() {
  const db = fakeD1();
  const store = new Mailstore(db, fakeR2().bucket);
  return { db, store };
}

const email = (id: string, mailboxIds: string[]): NewEmail => ({
  id,
  blobId: "b_x",
  threadId: `th_${id}`,
  messageId: `<${id}@spamfarm.test>`,
  inReplyTo: null,
  subject: "one weird trick",
  from: [{ email: SENDER }],
  to: [{ email: "ada@example.test" }],
  cc: [],
  bcc: [],
  preview: "p",
  size: 10,
  receivedAt: 1,
  hasAttachment: false,
  attachments: [],
  mailboxIds,
  keywords: [],
});

/** One shunted message in the quarantine mailbox, chain row and all. */
async function shunt(
  store: Mailstore,
  emailId = "e_q1",
  stage = "blocked-book:personal",
): Promise<{ emailId: string; quarantineId: string }> {
  const quarantineId = await store.ensureRoleMailbox(ACCOUNT, "quarantine", "Quarantine");
  await store.insertQuarantinedEmail(ACCOUNT, email(emailId, [quarantineId]), {
    event: "shunted",
    sender: SENDER,
    domain: DOMAIN,
    stage,
    emailId,
    at: 1000,
  });
  return { emailId, quarantineId };
}

const mailboxesOf = (db: FakeD1, emailId: string): string[] =>
  db
    .query<{ mailbox_id: string }>(
      `SELECT mailbox_id FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
      ACCOUNT,
      emailId,
    )
    .map((r) => r.mailbox_id);

describe("insertQuarantinedEmail — message + chain, one batch", () => {
  it("stores the message in the quarantine mailbox with its 'shunted' row", async () => {
    const { db, store } = harness();
    const { emailId, quarantineId } = await shunt(store);

    expect(mailboxesOf(db, emailId)).toEqual([quarantineId]);
    const events = await store.quarantineEvents(ACCOUNT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "shunted",
      sender: SENDER,
      domain: DOMAIN,
      stage: "blocked-book:personal",
      emailId,
      actor: null,
    });
  });

  it("is ATOMIC: no quarantine_events table → no email row either (the batch rolls back whole)", async () => {
    const { db, store } = harness();
    db.sqlite.exec("DROP TABLE quarantine_events");
    await expect(shunt(store)).rejects.toThrow();
    // Not a half-write: the message insert rolled back with the chain row.
    expect(db.count("emails")).toBe(0);
    expect(db.count("email_mailboxes")).toBe(0);
  });
});

describe("rescueQuarantined — the rescue write path", () => {
  it("moves the message to the inbox and appends the 'rescued' chain row, original stage preserved", async () => {
    const { db, store } = harness();
    const { emailId, quarantineId } = await shunt(store, "e_q1", "auth:dmarc");

    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out).toEqual({ rescued: true, demotedDomain: null });

    const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
    expect(mailboxesOf(db, emailId)).toEqual([inboxId]);
    expect(db.count("email_mailboxes", "mailbox_id = ?", quarantineId)).toBe(0);

    const events = await store.quarantineEvents(ACCOUNT);
    expect(events.map((e) => e.event)).toEqual(["shunted", "rescued"]); // append-only, both survive
    expect(events[1]).toMatchObject({
      event: "rescued",
      sender: SENDER,
      domain: DOMAIN,
      stage: "auth:dmarc", // "rescued from what" stays answerable
      emailId,
      actor: "eric@moore.coffee",
    });

    // The rescuer is stamped onto the message (the replaceEmailSets precedent).
    expect(
      db.query<{ p: string | null }>(
        `SELECT last_writer_principal AS p FROM emails WHERE account_id = ? AND id = ?`,
        ACCOUNT,
        emailId,
      )[0]!.p,
    ).toBe("eric@moore.coffee");
  });

  it("demotes a GRADUATED deny-list domain and resets its counters", async () => {
    const { db, store } = harness();
    // The authoritative tenant lookup path, not just the id-prefix fallback.
    db.seedAccount({ accountId: ACCOUNT, tenantId: "t_bm" });
    db.seed("domain_deny_list", [
      { tenant_id: "t_bm", domain: DOMAIN, added_at: 1, source: "graduated", evidence: "20×bayes@0.99, 0 rescues" },
    ]);
    db.seed("deny_counters", [
      { domain: DOMAIN, day: "2026-08-12", count: 41 },
      { domain: DOMAIN, day: "2026-08-13", count: 7 },
      { domain: "unrelated.test", day: "2026-08-13", count: 3 },
    ]);
    const { emailId } = await shunt(store);

    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out).toEqual({ rescued: true, demotedDomain: DOMAIN });
    expect(db.count("domain_deny_list", "domain = ?", DOMAIN)).toBe(0);
    expect(db.count("deny_counters", "domain = ?", DOMAIN)).toBe(0); // counter reset
    expect(db.count("deny_counters", "domain = ?", "unrelated.test")).toBe(1); // others untouched
  });

  it("does NOT demote 'feed' or 'directive' entries — a single rescue cannot overrule intent", async () => {
    const { db, store } = harness();
    db.seed("domain_deny_list", [
      { tenant_id: "t_bm", domain: DOMAIN, added_at: 1, source: "feed", evidence: null },
    ]);
    const { emailId } = await shunt(store);

    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out).toEqual({ rescued: true, demotedDomain: null });
    expect(db.count("domain_deny_list", "domain = ?", DOMAIN)).toBe(1);
  });

  it("a second rescue is a no-op: no second chain row, rescued=false", async () => {
    const { store } = harness();
    const { emailId } = await shunt(store);
    await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");

    const again = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(again).toEqual({ rescued: false, demotedDomain: null });
    expect((await store.quarantineEvents(ACCOUNT)).map((e) => e.event)).toEqual([
      "shunted",
      "rescued",
    ]);
  });

  it("refuses a message that was never quarantined (and an account with no quarantine mailbox)", async () => {
    const { store } = harness();
    // No quarantine mailbox at all:
    expect(await store.rescueQuarantined(ACCOUNT, "e_nope", "eric@moore.coffee")).toEqual({
      rescued: false,
      demotedDomain: null,
    });
    // Mailbox exists, message is elsewhere:
    const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
    await store.ensureRoleMailbox(ACCOUNT, "quarantine", "Quarantine");
    await store.insertEmail(ACCOUNT, email("e_inbox", [inboxId]));
    expect(await store.rescueQuarantined(ACCOUNT, "e_inbox", "eric@moore.coffee")).toEqual({
      rescued: false,
      demotedDomain: null,
    });
    expect(await store.quarantineEvents(ACCOUNT)).toEqual([]);
  });

  it("records the authorizing directive's Message-ID when one drove the rescue", async () => {
    const { store } = harness();
    const { emailId } = await shunt(store);
    await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee", {
      viaMessageId: "<directive-1@moore.coffee>",
    });
    const events = await store.quarantineEvents(ACCOUNT);
    expect(events[1]!.viaMessageId).toBe("<directive-1@moore.coffee>");
  });

  it("the sender-scoped audit query answers 'did you shunt mail from X?'", async () => {
    const { store } = harness();
    await shunt(store, "e_1");
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, "quarantine", "Quarantine");
    await store.insertQuarantinedEmail(ACCOUNT, email("e_2", [quarantineId]), {
      event: "shunted",
      sender: "other@elsewhere.test",
      domain: "elsewhere.test",
      stage: "auth:dmarc",
      emailId: "e_2",
      at: 2000,
    });

    const hits = await store.quarantineEvents(ACCOUNT, { sender: SENDER });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.emailId).toBe("e_1");
  });
});
