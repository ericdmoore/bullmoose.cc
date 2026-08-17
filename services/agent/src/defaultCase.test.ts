import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { claimGateSql } from "@bullmoose/scheduling";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";

/**
 * DefaultCase is structural (s11 T6, jobs-and-facets.md §1): an invocation
 * with NO facets — every s11 column NULL — is claimed and processed EXACTLY
 * as before the columns existed, in the default world (no free runtime has
 * claimed recently — production today runs no homelab daemon). Facets
 * tighten, never strand.
 *
 * Two guarantees, each held by a different kind of assertion:
 *
 *  1. BEHAVIOR: the real cloud drain (`POST /drain`, the same worker
 *     production runs) claims an unfaceted pending row and completes it with
 *     a reply draft — the onDemandDrain outcome, unchanged. This case is the
 *     T6 contract and has been UNTOUCHED by T2.
 *  2. STRUCTURE: the claim UPDATE is pinned as an exact string. Pre-T2 that
 *     string was the bare optimistic guard and this case's job was to make
 *     wiring facets into claiming a deliberate act; T2 was that act, and the
 *     pin moved forward with it: the claim SQL is now guard + the SHARED
 *     eligibility gate (@bullmoose/scheduling claimGateSql — the same
 *     fragment the JMAP claim path appends), the drain READS facets only in
 *     that gate, and its writes still never AUTHOR a facet — facet
 *     authorship stays at the boundary.
 */

const ACCOUNT = "t_bm__a_default";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";

const FACET_COLUMNS = ["due_at", "privacy", "sender_class", "effort_prior", "requires_json"];

/** The exact claim UPDATE `drain` issues (services/agent/src/index.ts): the
 * pre-s11 optimistic guard + claimant recording + the shared T2 gate. */
const CLAIM_SQL =
  "UPDATE agent_invocations SET status = 'running', claimed_at = ?, claimant_free = 0, claimant_caps_json = NULL\n" +
  "         WHERE account_id = ? AND id = ? AND status = 'pending'" +
  claimGateSql("agent_invocations");

const REPLY_CONFIG = JSON.stringify({
  pipeline: "reply",
  persona: "You are Emily.",
  replyMode: "draft",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "mock", model: "m" }] },
});

async function scaffold() {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [{ id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: REPLY_CONFIG }]);

  const raw = buildMime({
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    subject: "please review",
    messageId: "msg-1@example.com",
    date: new Date(1_000_000),
    text: "Here is my draft, thoughts?",
  });
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const blobId = await store.putBlob(TENANT, ACCOUNT, buf);
  const inboxId = await store.ensureRoleMailbox(ACCOUNT, "inbox", "Inbox");
  const emailId = "e_thread";
  await store.insertEmail(ACCOUNT, {
    id: emailId,
    blobId,
    threadId: "t_1",
    messageId: "msg-1@example.com",
    inReplyTo: null,
    subject: "please review",
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    cc: [],
    bcc: [],
    preview: "Here is my draft, thoughts?",
    size: raw.byteLength,
    receivedAt: 1_000_000,
    hasAttachment: false,
    attachments: [],
    mailboxIds: [inboxId],
    keywords: [],
  });

  /** Ingest's historical INSERT shape — no facet column named, all default NULL. */
  const seedInvocation = (id: string, extra: Record<string, unknown> = {}) =>
    w.db.seed("agent_invocations", [
      {
        id,
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: emailId,
        context_json: JSON.stringify({ emailId, threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
        ...extra,
      },
    ]);

  const drain = async () => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
    return res.json() as Promise<{ handled: number }>;
  };

  return { w, seedInvocation, drain };
}

describe("DefaultCase — an unfaceted invocation behaves byte-identically to before s11", () => {
  it("is claimed and processed by the real drain, and the drain leaves every facet NULL", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_plain");

    const { handled } = await s.drain();
    expect(handled).toBe(1);

    const row = s.w.db.query<Record<string, unknown>>(
      `SELECT status, result_json, ${FACET_COLUMNS.join(", ")}
       FROM agent_invocations WHERE account_id = ? AND id = 'inv_plain'`,
      ACCOUNT,
    )[0]!;
    // The pre-s11 outcome, exactly: done, with a reply draft.
    expect(row.status).toBe("done");
    expect(JSON.parse(row.result_json as string).replyId).toBeTruthy();
    // The drain read the row, ran it and finalized it without ever WRITING a
    // facet — NULL in, NULL out. Facet authorship stays at the boundary.
    for (const col of FACET_COLUMNS) expect(row[col], col).toBeNull();
  });

  it("issues exactly the guarded claim UPDATE + the SHARED gate, and never WRITES a facet", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_plain");
    await s.drain();

    // The claim, byte for byte: optimistic guard + claimant recording + the
    // same claimGateSql fragment the JMAP claim path appends. An innocent
    // reformat — or a drain-only fork of the gate — fails this on purpose:
    // the two claim sites must keep sharing ONE gate definition. (Pre-T2
    // this pinned the bare guard; T2 is the deliberate change the old pin
    // existed to force through this file.)
    const claims = s.w.db.writes.filter((q) => q.sql.includes("SET status = 'running'"));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sql).toBe(CLAIM_SQL);

    // The drain READS facets (in the gate's WHERE) but never AUTHORS one:
    // no statement it writes SETs a facet column. Facet authorship stays at
    // the boundary (ingest/bouncer) — the claim path consumes, only.
    for (const { sql } of s.w.db.writes) {
      const whereAt = sql.search(/\bWHERE\b/i);
      const setClause = whereAt === -1 ? sql : sql.slice(0, whereAt);
      for (const col of FACET_COLUMNS) {
        expect(setClause, `a drain write must not SET ${col}`).not.toContain(col);
      }
    }
  });

  it("a pinned, far-due, vision-requiring row is NOT claimed by the paid drain — T2 superseded the pre-gate case here", async () => {
    // Until T2 this case pinned the opposite (facets invisible to claiming);
    // its comment promised "T2 supersedes this case deliberately when
    // mayClaim arrives". It has: the same row now sits for a free/local
    // runtime — privacy = 'pinned' alone guarantees that, whatever the
    // clock says — and the facets survive untouched for that claimant.
    const s = await scaffold();
    s.seedInvocation("inv_faceted", {
      due_at: Date.UTC(2027, 0, 15, 17, 0),
      privacy: "pinned",
      sender_class: "known",
      effort_prior: "high",
      requires_json: JSON.stringify({ contextTokens: 512, vision: true }),
    });

    const { handled } = await s.drain();
    expect(handled).toBe(0);
    const row = s.w.db.query<{ status: string; privacy: string; due_at: number }>(
      `SELECT status, privacy, due_at FROM agent_invocations WHERE account_id = ? AND id = 'inv_faceted'`,
      ACCOUNT,
    )[0]!;
    expect(row.status).toBe("pending");
    // …and the facets are exactly as stamped — held, not consumed.
    expect(row.privacy).toBe("pinned");
    expect(row.due_at).toBe(Date.UTC(2027, 0, 15, 17, 0));
  });
});
