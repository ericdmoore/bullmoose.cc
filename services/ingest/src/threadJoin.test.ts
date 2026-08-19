import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { registerSubmissionMethods } from "../../jmap/src/methods/submission";
import type { RequestContext } from "../../jmap/src/methods/common";
import worker, { type Env } from "./index";

/**
 * The self-send thread join — the user-visible fix for the Message-ID
 * divergence bug (found live 2026-08-19, third-party client testing).
 *
 * The mechanism, as verified against production: `Email/set` stamps a
 * `Message-ID:` header into the draft's MIME, but SES SUBSTITUTES its own id
 * on the wire ("If you provide a Message-ID header, Amazon SES overrides the
 * header with its own value" — SES Developer Guide, header fields; confirmed
 * by a Gmail-received specimen whose DKIM h= covered the substituted id). So
 * the account's Sent copy was stored under one id while its delivered
 * self-copy arrived under another: no correlation, two threads, and clients
 * rendered near-duplicate disconnected rows.
 *
 * This file proves the whole repaired loop against the REAL handlers — the
 * jmap worker's EmailSubmission/set and the ingest worker's deliver(), over
 * one shared fake environment:
 *
 *   1. send: the relay reports the wire id, the Sent row adopts it;
 *   2. deliver: the self-copy carries that wire id and JOINS the Sent
 *      copy's thread (resolveThreadId's own-Message-ID join) — two rows,
 *      one thread, NO dedup/merge;
 *   3. reply: a message In-Reply-To the wire id joins the same thread —
 *      before the reconcile, every reply to outbound mail forked a thread,
 *      because nothing stored matched the id the world was replying to.
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_selfsend";
const TOKEN = "internal-test-token";
const SELF = "ada@example.test";
/** What SES actually stamps: `{sesMessageId}@{region}.amazonses.com`. */
const SES_WIRE_ID = "010101a01ba9762b-e5f1e023-e0f0-41d5-a521-0eecaf2a634b-000000@us-west-2.amazonses.com";
/** What the draft's MIME was stamped with before the relay substituted. */
const DRAFT_ID = "f5838bfa-0000-4000-8000-000000000000@example.test";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function scaffold(): Promise<FakeWorker> {
  const w = fakeEnv({ relayStampedMessageId: SES_WIRE_ID });
  w.db.seedAccount({ accountId: ACCOUNT, loginEmail: SELF, displayName: "Ada" });
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
  w.db.seed("mailboxes", [
    { id: "mb_drafts", account_id: ACCOUNT, parent_id: null, name: "Drafts", role: "drafts", sort_order: 1 },
  ]);
  w.db.seed("identities", [{ id: "id_1", account_id: ACCOUNT, email: SELF, name: "Ada" }]);
  // The draft, as Email/set create left it: stamped with OUR Message-ID.
  w.db.seed("emails", [
    {
      id: "e_draft",
      account_id: ACCOUNT,
      blob_id: "b_draft",
      thread_id: "t_sent",
      message_id: DRAFT_ID,
      in_reply_to: null,
      subject: "note to self",
      from_json: JSON.stringify([{ email: SELF }]),
      to_json: JSON.stringify([{ email: SELF }]),
      cc_json: "[]",
      bcc_json: "[]",
      preview: "note",
      size: 42,
      received_at: 1,
      has_attachment: 0,
      attachments_json: "[]",
    },
  ]);
  w.db.seed("email_mailboxes", [{ account_id: ACCOUNT, email_id: "e_draft", mailbox_id: "mb_drafts" }]);
  w.db.seed("email_keywords", [{ account_id: ACCOUNT, email_id: "e_draft", keyword: "$draft" }]);
  return w;
}

/** Send the seeded draft through the REAL EmailSubmission/set. */
async function send(w: FakeWorker): Promise<void> {
  const registry = new MethodRegistry<RequestContext>();
  registerSubmissionMethods(registry);
  const jmapCtx: RequestContext = {
    env: w.env,
    principal: {
      username: SELF,
      scopes: ["mail"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Ada" }],
    },
  };
  const res = (await registry.get("EmailSubmission/set")!(
    {
      accountId: ACCOUNT,
      create: { s: { emailId: "e_draft", identityId: "id_1", envelope: { rcptTo: [{ email: SELF }] } } },
    },
    jmapCtx,
  )) as { notCreated: Record<string, unknown> };
  expect(res.notCreated).toEqual({});
}

/** Deliver one raw message through the ingest worker's dev-inject path. */
async function deliver(w: FakeWorker, raw: string): Promise<string> {
  const res = await worker.fetch(
    new Request(`https://ingest.test/dev/inject?from=${SELF}&to=${SELF}`, {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    { ...w.env, DEV_INJECT: "1" } as unknown as Env,
    ctx(),
  );
  const body = (await res.json()) as { emailId?: string; rejected?: string };
  expect(body.rejected).toBeUndefined();
  return body.emailId as string;
}

const mime = (headers: string[], body: string) =>
  [`From: Ada <${SELF}>`, `To: Ada <${SELF}>`, ...headers, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n",
  );

describe("self-send: the delivered copy threads WITH the Sent copy", () => {
  it("send adopts the wire id; the delivered copy joins the Sent copy's thread", async () => {
    const w = await scaffold();
    const store = new Mailstore(w.env.DB, w.env.BLOBS);

    await send(w);
    // The reconcile: the Sent row now holds the id the world received.
    const sent = await store.getEmailRow(ACCOUNT, "e_draft");
    expect(sent?.messageId).toBe(SES_WIRE_ID);

    // The delivered self-copy, exactly as SES hands it back: SES's id, no
    // In-Reply-To — it is a copy, not a reply.
    const deliveredId = await deliver(
      w,
      mime(["Subject: note to self", `Message-ID: <${SES_WIRE_ID}>`], "note to self"),
    );

    const delivered = await store.getEmailRow(ACCOUNT, deliveredId);
    expect(delivered?.threadId).toBe("t_sent"); // ONE thread…
    expect(deliveredId).not.toBe("e_draft"); // …two rows: a join, not a dedup
    expect(delivered?.messageId).toBe(SES_WIRE_ID);
  });

  it("a reply citing the wire id joins that same thread", async () => {
    // Before the reconcile this was the silent half of the bug: the
    // recipient replies In-Reply-To the SES id, no stored message_id
    // matches it, and the reply founds a disconnected thread.
    const w = await scaffold();
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    await send(w);

    const replyId = await deliver(
      w,
      mime(
        [
          "Subject: Re: note to self",
          "Message-ID: <reply-1@elsewhere.test>",
          `In-Reply-To: <${SES_WIRE_ID}>`,
          `References: <${SES_WIRE_ID}>`,
        ],
        "replying to you",
      ),
    );
    expect((await store.getEmailRow(ACCOUNT, replyId))?.threadId).toBe("t_sent");
  });

  it("an unrelated message still gets its own thread — the join needs a match, not a vibe", async () => {
    const w = await scaffold();
    const store = new Mailstore(w.env.DB, w.env.BLOBS);
    await send(w);

    const strangerId = await deliver(w, mime(["Subject: hello", "Message-ID: <fresh-1@elsewhere.test>"], "unrelated"));
    const stranger = await store.getEmailRow(ACCOUNT, strangerId);
    expect(stranger?.threadId).not.toBe("t_sent");
  });
});
