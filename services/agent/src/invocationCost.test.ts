import { describe, expect, it } from "vitest";
import { Mailstore } from "@bullmoose/mailstore";
import { buildMime } from "@bullmoose/mime";
import { fakeEnv } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import type { ModelCandidate } from "./models";

/**
 * s07 T5, end-to-end: a drained invocation leaves the REAL cloud worker
 * (`services/agent` default export, POST /drain) with its cost stamped on the
 * agent_invocations row — provider, model, tokens, and cost_micros frozen at
 * capture by `finish()` (index.ts).
 *
 * Three rows, three meanings, and the distinction is the point:
 *   priced      cost_micros = round(tokens × per-leg $/M) — a real number
 *   free        cost_micros = 0 — a Workers AI run reads an honest "$0.00"
 *   unpriceable cost_micros = NULL — renders "not recorded", NEVER $0.00
 */

const ACCOUNT = "t_bm__a_emily";
const TENANT = "t_bm";
const SELF = "emily@bullmoose.cc";
const SENDER = "human@example.com";
const PRICING_KEY = "cache:modelsdev:slim";

async function scaffold(candidate: ModelCandidate) {
  const w = fakeEnv();
  const store = new Mailstore(w.env.DB, w.env.BLOBS);

  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Emily" });
  w.db.seed("identities", [{ id: "id_emily", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    {
      id: "bind_emily",
      account_id: ACCOUNT,
      name: "emily",
      config_json: JSON.stringify({
        pipeline: "reply",
        persona: "You are Emily.",
        replyMode: "draft",
        defaultModel: "cheap",
        modelAliases: { cheap: [candidate] },
      }),
    },
  ]);

  // A real message with a real blob — the reply pipeline fetches and parses it.
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
  await store.insertEmail(ACCOUNT, {
    id: "e_thread",
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

  w.db.seed("agent_invocations", [
    {
      id: "inv_1",
      account_id: ACCOUNT,
      binding_id: "bind_emily",
      binding_name: "emily",
      status: "pending",
      email_id: "e_thread",
      context_json: JSON.stringify({ emailId: "e_thread" }),
      created_at: 1,
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

  const row = () =>
    w.db.query<{
      status: string;
      provider: string | null;
      model: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      cost_micros: number | null;
    }>(
      `SELECT status, provider, model, tokens_in, tokens_out, cost_micros
       FROM agent_invocations WHERE account_id = ? AND id = 'inv_1'`,
      ACCOUNT,
    )[0]!;

  return { w, drain, row };
}

describe("the drain stamps invocation cost, frozen at capture", () => {
  it("records tokens, provider, model, and a computed cost_micros for a priced run", async () => {
    // The mock provider prices like a gateway model: by cache lookup on its
    // model id. Legs of ($2, $10)/M make the expected micros checkable
    // against the stamped token counts.
    const s = await scaffold({ provider: "mock", model: "mock-model" });
    await s.w.env.ROUTES.put(
      PRICING_KEY,
      JSON.stringify({
        fetchedAt: Date.now(),
        prices: { "mock-model": 32 },
        legs: { "mock-model": { input: 2, output: 10 } },
      }),
    );

    expect((await s.drain()).handled).toBe(1);
    const r = s.row();
    expect(r.status).toBe("done");
    expect(r.provider).toBe("mock");
    expect(r.model).toBe("mock-model");
    expect(r.tokens_in).toBeGreaterThan(0);
    expect(r.tokens_out).toBeGreaterThan(0);
    // The frozen figure is exactly the per-leg formula over the stamped
    // tokens — the receipt reproduces the answer.
    expect(r.cost_micros).toBe(Math.round(r.tokens_in! * 2 + r.tokens_out! * 10));
    expect(r.cost_micros).toBeGreaterThan(0);
  });

  it("records an honest 0 for a free workers-ai run — not NULL", async () => {
    const s = await scaffold({ provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    s.w.env.AI = {
      run: async () => ({ response: "sure thing", usage: { prompt_tokens: 9, completion_tokens: 4 } }),
    } as unknown as Ai;

    expect((await s.drain()).handled).toBe(1);
    const r = s.row();
    expect(r.status).toBe("done");
    expect(r.provider).toBe("workers-ai");
    expect(r.tokens_in).toBe(9);
    expect(r.tokens_out).toBe(4);
    expect(r.cost_micros).toBe(0); // known and genuinely free — renders "$0.00"
  });

  it("records NULL for an unpriceable run — not a flattering 0", async () => {
    // No pricing cache at all: the tokens are known, the price is not.
    const s = await scaffold({ provider: "mock", model: "mock-model" });

    expect((await s.drain()).handled).toBe(1);
    const r = s.row();
    expect(r.status).toBe("done");
    expect(r.provider).toBe("mock"); // the receipt is still kept…
    expect(r.tokens_in).toBeGreaterThan(0);
    expect(r.tokens_out).toBeGreaterThan(0);
    expect(r.cost_micros).toBeNull(); // …but the cost is undetermined
  });
});
