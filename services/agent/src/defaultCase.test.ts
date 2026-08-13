import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";

/**
 * DefaultCase is structural (s11 T6, jobs-and-facets.md §1): an invocation
 * with NO facets — every s11 column NULL — is claimed and processed EXACTLY
 * as before the columns existed. Facets tighten, never strand; and in THIS
 * wave they do not even tighten, because the eligibility gate is T2.
 *
 * Two guarantees, each held by a different kind of assertion:
 *
 *  1. BEHAVIOR: the real cloud drain (`POST /drain`, the same worker
 *     production runs) claims an unfaceted pending row and completes it with
 *     a reply draft — the onDemandDrain outcome, unchanged.
 *  2. STRUCTURE: the claim path's SQL is byte-identical to what shipped
 *     before s11. The claim UPDATE is asserted as an exact string and every
 *     statement the drain issued is swept for facet column names. This is
 *     deliberately brittle: if T2 (or anyone) wires facets into claiming,
 *     this test fails and the change has to be made on purpose, here.
 */

const ACCOUNT = "t_bm__a_default";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";

const FACET_COLUMNS = ["due_at", "privacy", "sender_class", "effort_prior", "requires_json"];

/** The exact claim UPDATE `drain` has always issued (services/agent/src/index.ts). */
const CLAIM_SQL =
  "UPDATE agent_invocations SET status = 'running', claimed_at = ?\n" +
  "         WHERE account_id = ? AND id = ? AND status = 'pending'";

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
  w.db.seed("agent_bindings", [
    { id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: REPLY_CONFIG },
  ]);

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

  it("issues the exact pre-s11 claim UPDATE, and no drain statement names a facet column", async () => {
    const s = await scaffold();
    s.seedInvocation("inv_plain");
    await s.drain();

    // The optimistic claim, byte for byte. An innocent reformat fails this
    // on purpose — "claiming behavior unchanged" is the T6 guarantee, and an
    // exact string is the strongest structural witness a test can hold.
    const claims = s.w.db.writes.filter((q) => q.sql.includes("SET status = 'running'"));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sql).toBe(CLAIM_SQL);

    // Nothing the drain prepared — selection, claim, run, finalisation —
    // mentions any facet column. The columns exist in the schema this test
    // runs on (the live data-plane.sql), so this proves coexistence, not
    // absence: present in the table, invisible to the claim path.
    for (const sql of s.w.db.queries) {
      for (const col of FACET_COLUMNS) {
        expect(sql, `drain statement must not name ${col}`).not.toContain(col);
      }
    }
  });

  it("a FACETED invocation is claimed identically in this wave — stamping changed nothing about claiming", async () => {
    // The gate that will read these is T2. Until it lands, a pinned, due,
    // vision-requiring row and a bare row must be indistinguishable to the
    // drain — nothing this wave built may change claiming behavior. T2
    // supersedes this case deliberately when mayClaim arrives.
    const s = await scaffold();
    s.seedInvocation("inv_faceted", {
      due_at: Date.UTC(2027, 0, 15, 17, 0),
      privacy: "pinned",
      sender_class: "known",
      effort_prior: "high",
      requires_json: JSON.stringify({ contextTokens: 512, vision: true }),
    });

    const { handled } = await s.drain();
    expect(handled).toBe(1);
    const row = s.w.db.query<{ status: string; privacy: string; due_at: number }>(
      `SELECT status, privacy, due_at FROM agent_invocations WHERE account_id = ? AND id = 'inv_faceted'`,
      ACCOUNT,
    )[0]!;
    expect(row.status).toBe("done");
    // …and the facets rode through the run untouched.
    expect(row.privacy).toBe("pinned");
    expect(row.due_at).toBe(Date.UTC(2027, 0, 15, 17, 0));
  });
});
