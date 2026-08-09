import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import { registerAgentMethods } from "../../jmap/src/methods/agent";
import type { RequestContext } from "../../jmap/src/methods/common";

/**
 * The cloud runtime picks up an on-demand invocation exactly like a
 * mail-triggered one (sVOL 007 done-when #6).
 *
 * This is the end-to-end edge the unit is really about: a `pending` row created
 * by the JMAP `AgentInvocation/set` create path is drained by the REAL cloud
 * worker (`services/agent` default export, POST /drain) on the same path a
 * delivered message's invocation takes — no new trigger type, no poke. To make
 * "exactly like" a claim with a test on it, both an on-demand row (via the JMAP
 * method) and a mail-triggered row (via ingest's exact INSERT) are queued and
 * drained in one pass; both must reach `done` with a reply draft.
 *
 * The interlock's other half is here too: a `pending` row against a DISABLED
 * binding (queued, then disabled) is HELD by the drain's `b.enabled = 1` gate,
 * never processed — the mirror of the create-time refusal in the JMAP test.
 */

const ACCOUNT = "t_bm__a_emily";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";

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

  // Account spine (drain JOINs accounts a ON … a.deleted_at IS NULL) + identity
  // (the reply pipeline needs a self address to send from).
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);

  w.db.seed("agent_bindings", [
    { id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: REPLY_CONFIG },
    { id: "bind_off", account_id: ACCOUNT, name: "off", enabled: 0, config_json: REPLY_CONFIG },
  ]);

  // A real message with a real blob — the reply pipeline fetches and parses it.
  const raw = buildMime({
    from: [{ email: SENDER }],
    to: [{ email: SELF }],
    subject: "please review",
    messageId: `msg-1@example.com`,
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

  const statusOf = (id: string) =>
    w.db.query<{ status: string; result_json: string | null }>(
      "SELECT status, result_json FROM agent_invocations WHERE account_id = ? AND id = ?",
      ACCOUNT,
      id,
    )[0];

  return { w, store, emailId, drain, statusOf };
}

describe("the cloud drain treats an on-demand invocation like a mail-triggered one", () => {
  it("drains a JMAP-created invocation to done, same pass as an ingest-created one", async () => {
    const s = await scaffold();

    // (1) on-demand: created through the REAL JMAP create path.
    const registry = new MethodRegistry<RequestContext>();
    registerAgentMethods(registry);
    const ctx: RequestContext = {
      env: s.w.env,
      principal: {
        username: "emily@login.example",
        scopes: ["read", "draft"],
        accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Emily" }],
      },
    };
    const created = (await registry.get("AgentInvocation/set")!(
      { accountId: ACCOUNT, create: { c: { bindingName: "emily", emailId: s.emailId } } },
      ctx,
    )) as { created: Record<string, { id: string }> };
    const onDemandId = created.created.c!.id;

    // (2) mail-triggered: ingest's exact INSERT shape (context carries envelopeTo).
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_mail",
        account_id: ACCOUNT,
        binding_id: "bind_emily",
        binding_name: "emily",
        status: "pending",
        email_id: s.emailId,
        context_json: JSON.stringify({ emailId: s.emailId, threadId: "t_1", envelopeTo: SELF }),
        created_at: 1,
      },
    ]);

    // Both are pending before the drain.
    expect(s.statusOf(onDemandId)!.status).toBe("pending");
    expect(s.statusOf("inv_mail")!.status).toBe("pending");

    const { handled } = await s.drain();
    expect(handled).toBe(2);

    // Both reached done, each with a reply draft — indistinguishable outcomes.
    const onDemand = s.statusOf(onDemandId)!;
    const mail = s.statusOf("inv_mail")!;
    expect(onDemand.status).toBe("done");
    expect(mail.status).toBe("done");
    expect(JSON.parse(onDemand.result_json!).replyId).toBeTruthy();
    expect(JSON.parse(mail.result_json!).replyId).toBeTruthy();

    // Two reply drafts landed in Drafts (one per invocation).
    const drafts = s.w.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM email_keywords WHERE account_id = ? AND keyword = '$agent'`,
      ACCOUNT,
    )[0]!;
    expect(drafts.n).toBe(2);
  });

  it("HOLDS a pending invocation against a disabled binding (the drain's enabled gate)", async () => {
    const s = await scaffold();
    // Queued while enabled, then the binding was disabled (bind_off). The drain
    // must never touch it — the mirror of the create-time refusal.
    s.w.db.seed("agent_invocations", [
      {
        id: "inv_held",
        account_id: ACCOUNT,
        binding_id: "bind_off",
        binding_name: "off",
        status: "pending",
        email_id: s.emailId,
        context_json: JSON.stringify({ emailId: s.emailId }),
        created_at: 1,
      },
    ]);

    const { handled } = await s.drain();
    expect(handled).toBe(0);
    expect(s.statusOf("inv_held")!.status).toBe("pending");
  });
});
