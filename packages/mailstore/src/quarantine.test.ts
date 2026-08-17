import { describe, expect, it } from "vitest";
import { bayesClassify, type BoundaryMessage } from "@bullmoose/boundary";
import { fakeD1, fakeR2, type FakeD1 } from "@bullmoose/test-fakes";
import {
  Mailstore,
  QUARANTINE_NAME,
  QUARANTINE_ROLE,
  loadBayesState,
  type NewEmail,
} from "./index";

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
  const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
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
      {
        tenant_id: "t_bm",
        domain: DOMAIN,
        added_at: 1,
        source: "graduated",
        evidence: "20×bayes@0.99, 0 rescues",
      },
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
    await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
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
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
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

// ---- s12 wave 2-C: the rescue is a 'ham' label -----------------------------

const RAW_MIME = [
  "From: Sender <sender@spamfarm.test>",
  "To: Ada <ada@example.test>",
  "Subject: one weird trick",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Legitimate quarterly numbers attached, no rush.",
].join("\r\n");

describe("rescueQuarantined trains the Bayes filter (rescue = ham label)", () => {
  /** A shunted message whose raw blob is REAL — trainable. */
  async function shuntWithBlob(store: Mailstore): Promise<string> {
    const raw = new TextEncoder().encode(RAW_MIME);
    const blobId = await store.putBlob("t_bm", ACCOUNT, raw.buffer as ArrayBuffer);
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
    await store.insertQuarantinedEmail(
      ACCOUNT,
      { ...email("e_train", [quarantineId]), blobId, size: raw.byteLength },
      {
        event: "shunted",
        sender: SENDER,
        domain: DOMAIN,
        stage: "bayes@0.99",
        emailId: "e_train",
        at: 1000,
      },
    );
    return "e_train";
  }

  it("records a 'ham' label from the stored raw message; the verdict shifts", async () => {
    const { db, store } = harness();
    const emailId = await shuntWithBlob(store);
    expect(await loadBayesState(db, ACCOUNT)).toBeNull(); // untrained before

    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out.rescued).toBe(true);

    const state = await loadBayesState(db, ACCOUNT);
    expect(state).not.toBeNull();
    expect(state!.hamCount).toBe(1);
    expect(state!.spamCount).toBe(0);
    // Tokenized from the RAW message + the chain row's envelope identities.
    expect(state!.tokens["quarterly"]).toEqual({ s: 0, h: 1 });
    expect(state!.tokens[`from:${SENDER}`]).toEqual({ s: 0, h: 1 });

    // The labeled correction moves a re-classify of the same material below
    // the untrained 0.5 — the escape hatch fed the filter.
    const reMsg: BoundaryMessage = {
      from: SENDER,
      fromDomain: DOMAIN,
      subject: "one weird trick",
      textBody: "Legitimate quarterly numbers attached, no rush.",
      headers: {},
      sizeBytes: 100,
      hasAttachments: false,
    };
    expect(bayesClassify(state!, reMsg).score).toBeLessThan(0.5);
  });

  it("skips SILENTLY when the blob is unfetchable — the rescue itself still lands", async () => {
    const { db, store } = harness();
    const { emailId } = await shunt(store); // blobId 'b_x' points at nothing
    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out.rescued).toBe(true);
    expect(db.count("bayes_state")).toBe(0); // no label, no error
  });

  it("skips silently on a shard with no bayes_state table (fail open)", async () => {
    const { db, store } = harness();
    db.sqlite.exec("DROP TABLE bayes_state");
    const emailId = await shuntWithBlob(store);
    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out.rescued).toBe(true); // training failure never fails the rescue
  });
});

// ---- s12 wave 2-C: the machine's release path ------------------------------

describe("releaseQuarantined — the classifier's exit (screened → released)", () => {
  /** One SCREENED message (the mid-band hold, not a judged shunt). */
  async function screen(store: Mailstore, emailId = "e_scr"): Promise<string> {
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
    await store.insertQuarantinedEmail(ACCOUNT, email(emailId, [quarantineId]), {
      event: "screened",
      sender: SENDER,
      domain: DOMAIN,
      stage: "bayes-mid@0.55",
      emailId,
      at: 1000,
    });
    return emailId;
  }

  it("moves to the inbox and appends 'released' with the deciding stage", async () => {
    const { db, store } = harness();
    const emailId = await screen(store);

    const out = await store.releaseQuarantined(ACCOUNT, emailId, "llm:notSpam");
    expect(out.released).toBe(true);

    const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
    expect(mailboxesOf(db, emailId)).toEqual([inboxId]);
    expect(out.mailboxIds).toContain(inboxId);

    const events = await store.quarantineEvents(ACCOUNT);
    expect(events.map((e) => e.event)).toEqual(["screened", "released"]);
    expect(events[1]).toMatchObject({
      event: "released",
      sender: SENDER,
      domain: DOMAIN,
      stage: "llm:notSpam",
      emailId,
      actor: null, // the machine, not a human — that is what 'rescued' is for
    });
    // A release trains NOTHING (LLM labels are the agent's flag-gated call).
    expect(db.count("bayes_state")).toBe(0);
  });

  it("refuses when the message is not held — a raced human rescue already won", async () => {
    const { store } = harness();
    const emailId = await screen(store);
    await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");

    const out = await store.releaseQuarantined(ACCOUNT, emailId, "llm:notSpam");
    expect(out.released).toBe(false);
    expect((await store.quarantineEvents(ACCOUNT)).map((e) => e.event)).toEqual([
      "screened",
      "rescued", // no 'released' row on top of the human's rescue
    ]);
  });

  it("never demotes deny-list entries (that is the RESCUE's human-correction power)", async () => {
    const { db, store } = harness();
    db.seedAccount({ accountId: ACCOUNT, tenantId: "t_bm" });
    db.seed("domain_deny_list", [
      {
        tenant_id: "t_bm",
        domain: DOMAIN,
        added_at: 1,
        source: "graduated",
        evidence: "10×rejects, 0 rescues",
      },
    ]);
    const emailId = await screen(store);
    await store.releaseQuarantined(ACCOUNT, emailId, "llm:unsure");
    expect(db.count("domain_deny_list", "domain = ?", DOMAIN)).toBe(1); // untouched
  });

  it("rescuing a SCREENED message names the screening stage, not 'unknown'", async () => {
    // A mid-band hold never gets a 'shunted' row — nothing judged it — so a
    // rescue that read only 'shunted' rows fell back to the header From and a
    // stage of "unknown": the chain answering "rescued from what" with a
    // shrug, on exactly the messages a human is now asked about.
    const { store } = harness();
    const emailId = await screen(store);
    const out = await store.rescueQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(out.rescued).toBe(true);

    const events = await store.quarantineEvents(ACCOUNT);
    expect(events[1]).toMatchObject({
      event: "rescued",
      sender: SENDER, // the ENVELOPE sender the hold recorded
      domain: DOMAIN,
      stage: "bayes-mid@0.55",
      actor: "eric@moore.coffee",
    });
  });
});

// ---- s12: the human CONFIRMING a hold (the decline half) --------------------

describe("confirmQuarantined — 'yes, that is spam'", () => {
  async function screened(store: Mailstore, emailId = "e_scr"): Promise<string> {
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
    await store.insertQuarantinedEmail(ACCOUNT, email(emailId, [quarantineId]), {
      event: "screened",
      sender: SENDER,
      domain: DOMAIN,
      stage: "bayes-mid@0.55",
      emailId,
      at: 1000,
    });
    return emailId;
  }

  it("leaves the message where it is and writes the judgment the hold never had", async () => {
    const { db, store } = harness();
    const emailId = await screened(store);
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);

    expect(await store.confirmQuarantined(ACCOUNT, emailId, "eric@moore.coffee")).toEqual({
      confirmed: true,
    });
    // No move: the boundary put it in the right place, and the human agreed.
    expect(mailboxesOf(db, emailId)).toEqual([quarantineId]);
    const events = await store.quarantineEvents(ACCOUNT);
    expect(events.map((e) => e.event)).toEqual(["screened", "shunted"]);
    expect(events[1]).toMatchObject({
      event: "shunted",
      sender: SENDER,
      domain: DOMAIN,
      stage: "human:spam",
      actor: "eric@moore.coffee",
    });
    // The decider is stamped on the message, like a rescuer is.
    expect(
      db.query<{ p: string | null }>(
        `SELECT last_writer_principal AS p FROM emails WHERE account_id = ? AND id = ?`,
        ACCOUNT,
        emailId,
      )[0]!.p,
    ).toBe("eric@moore.coffee");
  });

  it("is idempotent: a decided message cannot be confirmed twice", async () => {
    const { store } = harness();
    const emailId = await screened(store);
    await store.confirmQuarantined(ACCOUNT, emailId, "eric@moore.coffee");
    expect(await store.confirmQuarantined(ACCOUNT, emailId, "eric@moore.coffee")).toEqual({
      confirmed: false,
    });
    expect((await store.quarantineEvents(ACCOUNT)).map((e) => e.event)).toEqual([
      "screened",
      "shunted",
    ]);
  });

  it("refuses a message a human already rescued — their correction wins", async () => {
    const { store } = harness();
    const emailId = await screened(store);
    await store.rescueQuarantined(ACCOUNT, emailId, "ada@example.test");
    expect(await store.confirmQuarantined(ACCOUNT, emailId, "eric@moore.coffee")).toEqual({
      confirmed: false,
    });
    expect((await store.quarantineEvents(ACCOUNT)).map((e) => e.event)).toEqual([
      "screened",
      "rescued",
    ]);
  });

  it("trains the filter as SPAM from the stored raw message (the mirror of a rescue's ham)", async () => {
    const { db, store } = harness();
    const raw = new TextEncoder().encode(RAW_MIME);
    const blobId = await store.putBlob("t_bm", ACCOUNT, raw.buffer as ArrayBuffer);
    const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
    await store.insertQuarantinedEmail(
      ACCOUNT,
      { ...email("e_conf", [quarantineId]), blobId, size: raw.byteLength },
      {
        event: "screened",
        sender: SENDER,
        domain: DOMAIN,
        stage: "bayes-mid@0.55",
        emailId: "e_conf",
        at: 1000,
      },
    );

    await store.confirmQuarantined(ACCOUNT, "e_conf", "eric@moore.coffee");
    const state = await loadBayesState(db, ACCOUNT);
    expect(state!.spamCount).toBe(1);
    expect(state!.hamCount).toBe(0);
    expect(state!.tokens["quarterly"]).toEqual({ s: 1, h: 0 });
  });
});
