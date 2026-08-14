import { describe, expect, it } from "vitest";
import { Mailstore, QUARANTINE_NAME, QUARANTINE_ROLE, loadBayesState } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { LLM_LABELS_TRAIN, classifyScreened, parseClassifierVerdict } from "./bouncerClassify";
import agentWorker from "./index";
import type { BindingConfig, Env, InvocationCost } from "./models";

/**
 * The mid-band classifier (s12 wave 2-C, cascade stage 5): a screened
 * message + a bouncer-classify invocation, run through the REAL drain
 * (the proposals.test.ts pattern). The verdict discipline under test:
 *
 *   spam    → stays held, 'shunted' stage 'llm:spam' (a JUDGMENT landed)
 *   notSpam → released, 'released' stage 'llm:notSpam'
 *   unsure  → stays held, a second 'screened' row 'llm:unsure', NEVER trains —
 *             and the sweep turns it into a human proposal (midBandProposal)
 *   garbage → parses as unsure (defensively), i.e. holds and asks
 *
 * The unsure row is the s12 rework: wave 2-C released on unsure ("an unsure
 * model must not hold a human's mail"), which is bouncer deciding, in spam's
 * favour, exactly where it cannot decide. A human CAN decide it, so it becomes
 * a question instead of a coin flip — s11 T9's "proposal when something can".
 * The EVENT is what encodes the difference: 'shunted' = decided,
 * 'screened' = still nobody's judgment, which is what the sweep selects on.
 *
 * and the training pin: LLM_LABELS_TRAIN ships FALSE — model verdicts train
 * nothing unless the operator flips it — proven by asserting no bayes_state
 * row after spam/notSpam runs, with the flag-on path covered via the opts
 * override.
 */

const ACCOUNT = "t_bm__a_bouncer";
const TENANT = "t_bm";
const SENDER = "sender@elsewhere.test";
const DOMAIN = "elsewhere.test";
const EMAIL_ID = "e_screened";

const RAW_MIME = [
  "From: Sender <sender@elsewhere.test>",
  "To: Ada <ada@example.test>",
  "Subject: maybe important",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Quarterly casino numbers, no rush.",
].join("\r\n");

const BOUNCER_CONFIG: BindingConfig & { kind: string } = {
  kind: "bouncer",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "workers-ai", model: "@cf/test-classifier" }] },
};

/** The whole stage: account, bouncer binding, a screened message with a real
 * blob, and the pending invocation ingest would have enqueued. `response` is
 * what the fake Workers AI model answers. */
async function scaffold(
  response: string,
  opts: { config?: Record<string, unknown> } = {},
): Promise<{ w: FakeWorker; store: Mailstore; quarantineId: string }> {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT });
  w.db.seed("agent_bindings", [
    {
      id: "bind_bouncer",
      account_id: ACCOUNT,
      name: "bouncer",
      config_json: JSON.stringify(opts.config ?? BOUNCER_CONFIG),
    },
  ]);
  w.env.AI = {
    run: async () => ({ response, usage: { prompt_tokens: 42, completion_tokens: 1 } }),
  } as unknown as Ai;

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const raw = new TextEncoder().encode(RAW_MIME);
  const blobId = await store.putBlob(TENANT, ACCOUNT, raw.buffer as ArrayBuffer);
  const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);
  await store.insertQuarantinedEmail(
    ACCOUNT,
    {
      id: EMAIL_ID,
      blobId,
      threadId: "th_scr",
      messageId: `<scr@${DOMAIN}>`,
      inReplyTo: null,
      subject: "maybe important",
      from: [{ email: SENDER }],
      to: [{ email: "ada@example.test" }],
      cc: [],
      bcc: [],
      preview: "Quarterly casino numbers, no rush.",
      size: raw.byteLength,
      receivedAt: 1,
      hasAttachment: false,
      attachments: [],
      mailboxIds: [quarantineId],
      keywords: [],
    },
    { event: "screened", sender: SENDER, domain: DOMAIN, stage: "bayes-mid@0.50", emailId: EMAIL_ID, at: 1000 },
  );
  w.db.seed("agent_invocations", [
    {
      id: "inv_classify",
      account_id: ACCOUNT,
      binding_id: "bind_bouncer",
      binding_name: "bouncer",
      status: "pending",
      email_id: EMAIL_ID,
      context_json: JSON.stringify({
        kind: "bouncer-classify",
        accountId: ACCOUNT,
        tenantId: TENANT,
        emailId: EMAIL_ID,
        sender: SENDER,
        domain: DOMAIN,
        stage: "bayes-mid@0.50",
      }),
      created_at: 2,
    },
  ]);
  return { w, store, quarantineId };
}

async function drain(w: FakeWorker): Promise<{ handled: number }> {
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
}

const mailboxesOf = (w: FakeWorker): string[] =>
  w.db
    .query<{ mailbox_id: string }>(
      `SELECT mailbox_id FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
      ACCOUNT,
      EMAIL_ID,
    )
    .map((r) => r.mailbox_id);

const events = (w: FakeWorker) =>
  w.db.query<{ event: string; stage: string; actor: string | null }>(
    `SELECT event, stage, actor FROM quarantine_events WHERE account_id = ? ORDER BY id`,
    ACCOUNT,
  );

const invocation = (w: FakeWorker) =>
  w.db.query<{
    status: string;
    result_json: string | null;
    provider: string | null;
    cost_micros: number | null;
  }>(
    `SELECT status, result_json, provider, cost_micros FROM agent_invocations WHERE id = 'inv_classify'`,
  )[0]!;

describe("parseClassifierVerdict — the strict enum, defensively", () => {
  it("accepts exactly the enum (case/punctuation-insensitively), nothing else", () => {
    expect(parseClassifierVerdict("spam")).toBe("spam");
    expect(parseClassifierVerdict(" Spam.\n")).toBe("spam");
    expect(parseClassifierVerdict("NOTSPAM")).toBe("notSpam");
    expect(parseClassifierVerdict("notSpam")).toBe("notSpam");
    expect(parseClassifierVerdict("not spam")).toBe("notSpam"); // whitespace strips
    expect(parseClassifierVerdict("unsure!")).toBe("unsure");
  });

  it("garbage → unsure: prose, empty, JSON, or a verdict buried in chatter", () => {
    expect(parseClassifierVerdict("")).toBe("unsure");
    expect(parseClassifierVerdict("I think this is spam because it mentions a casino")).toBe("unsure");
    expect(parseClassifierVerdict('{"verdict":"spam"}')).toBe("unsure");
    expect(parseClassifierVerdict("spammy")).toBe("unsure");
    expect(parseClassifierVerdict("definitely-not-spam-trust-me")).toBe("unsure");
  });
});

describe("bouncer-classify through the real drain", () => {
  it("spam: stays quarantined, screened→shunted 'llm:spam' on the chain, costed, NO training (flag off)", async () => {
    const { w, quarantineId } = await scaffold("spam");
    expect(LLM_LABELS_TRAIN).toBe(false); // the shipped default, pinned

    expect((await drain(w)).handled).toBe(1);

    expect(mailboxesOf(w)).toEqual([quarantineId]); // still held
    expect(events(w)).toEqual([
      { event: "screened", stage: "bayes-mid@0.50", actor: null },
      { event: "shunted", stage: "llm:spam", actor: null },
    ]);
    const inv = invocation(w);
    expect(inv.status).toBe("done");
    expect(JSON.parse(inv.result_json!)).toMatchObject({ kind: "bouncer-classify", verdict: "spam" });
    // s07 T5 machinery, free on workers-ai: 0, not NULL.
    expect(inv.provider).toBe("workers-ai");
    expect(inv.cost_micros).toBe(0);
    // Model verdicts do NOT train by default.
    expect(w.db.count("bayes_state")).toBe(0);
  });

  it("notSpam: released to the inbox, 'released' stage 'llm:notSpam', no training (flag off)", async () => {
    const { w, quarantineId } = await scaffold("notSpam");
    await drain(w);

    const inboxId = w.db.query<{ id: string }>(
      `SELECT id FROM mailboxes WHERE account_id = ? AND role = 'inbox'`,
      ACCOUNT,
    )[0]!.id;
    expect(mailboxesOf(w)).toEqual([inboxId]);
    expect(w.db.count("email_mailboxes", "mailbox_id = ?", quarantineId)).toBe(0);
    expect(events(w).map((e) => `${e.event}:${e.stage}`)).toEqual([
      "screened:bayes-mid@0.50",
      "released:llm:notSpam",
    ]);
    expect(w.db.count("bayes_state")).toBe(0);
    expect(JSON.parse(invocation(w).result_json!)).toMatchObject({ verdict: "notSpam", released: true });
  });

  it("unsure: STAYS held with a 'screened' row 'llm:unsure', and records NO label — never train on a shrug", async () => {
    const { w, quarantineId } = await scaffold("unsure");
    await drain(w);

    // Held, and — the load-bearing half — still UNDECIDED: the second row is
    // 'screened', not 'shunted'. An unsure classifier has not judged anything,
    // and the sweep asks a human precisely because nothing has.
    expect(mailboxesOf(w)).toEqual([quarantineId]);
    expect(events(w).map((e) => `${e.event}:${e.stage}`)).toEqual([
      "screened:bayes-mid@0.50",
      "screened:llm:unsure",
    ]);
    expect(w.db.count("bayes_state")).toBe(0);
    expect(JSON.parse(invocation(w).result_json!)).toMatchObject({
      verdict: "unsure",
      held: true,
    });
  });

  it("GARBAGE model output parses as unsure → holds and asks (the defensive-parse bite)", async () => {
    const { w, quarantineId } = await scaffold(
      "Well, considering the casino references, I would classify this as spam.",
    );
    await drain(w);
    // A non-answer must never SHUNT mail either: it is held, undecided, and
    // becomes a human question — the model does not get to convict by prose.
    expect(mailboxesOf(w)).toEqual([quarantineId]);
    expect(events(w).map((e) => `${e.event}:${e.stage}`)).toEqual([
      "screened:bayes-mid@0.50",
      "screened:llm:unsure",
    ]);
    expect(JSON.parse(invocation(w).result_json!)).toMatchObject({ verdict: "unsure" });
  });

  it("no model route at all: holds as unsure WITH THE REASON — the human hears 'we were down'", async () => {
    const { w, quarantineId } = await scaffold("ignored", { config: { kind: "bouncer" } });
    await drain(w);
    // The infrastructure degrade lands in the same place as a real shrug, on
    // purpose: silently delivering unscreened mail would hide an outage, and
    // the note is what carries "no classifier ran" into the proposal.
    expect(mailboxesOf(w)).toEqual([quarantineId]);
    const result = JSON.parse(invocation(w).result_json!) as {
      verdict: string;
      held?: boolean;
      note?: string;
    };
    expect(result.verdict).toBe("unsure");
    expect(result.held).toBe(true);
    expect(result.note).toMatch(/no model candidates/);
  });

  it("a human rescue that raced the classifier wins: spam verdict writes NO row over it", async () => {
    const { w, store } = await scaffold("spam");
    await store.rescueQuarantined(ACCOUNT, EMAIL_ID, "eric@moore.coffee");
    await drain(w);

    // screened → rescued, and NOTHING from the machine after the human.
    expect(events(w).map((e) => e.event)).toEqual(["screened", "rescued"]);
    expect(JSON.parse(invocation(w).result_json!)).toMatchObject({
      verdict: "spam",
      note: expect.stringContaining("already rescued"),
    });
  });
});

describe("LLM_LABELS_TRAIN — the operator's switch, exercised via the override", () => {
  const done = () => {
    const calls: Array<{ status: string; result: Record<string, unknown> }> = [];
    const fn = async (status: "done" | "failed", result: Record<string, unknown>, _cost?: InvocationCost) => {
      calls.push({ status, result });
    };
    return { calls, fn };
  };
  const context = {
    kind: "bouncer-classify",
    accountId: ACCOUNT,
    tenantId: TENANT,
    emailId: EMAIL_ID,
    sender: SENDER,
    domain: DOMAIN,
    stage: "bayes-mid@0.50",
  };
  const job = { id: "inv_direct", account_id: ACCOUNT, binding_name: "bouncer" };

  it("flag ON + spam: records a 'spam' label (and still holds the message)", async () => {
    const { w } = await scaffold("spam");
    const d = done();
    await classifyScreened(w.env as unknown as Env, job, BOUNCER_CONFIG, context, d.fn, {
      llmLabelsTrain: true,
    });
    expect(d.calls[0]).toMatchObject({ status: "done" });
    const state = await loadBayesState(w.env.DB, ACCOUNT);
    expect(state).not.toBeNull();
    expect(state!.spamCount).toBe(1);
    expect(state!.tokens["casino"]).toEqual({ s: 1, h: 0 }); // trained on the raw text
  });

  it("flag ON + notSpam: records a 'ham' label with the release", async () => {
    const { w } = await scaffold("notSpam");
    await classifyScreened(w.env as unknown as Env, job, BOUNCER_CONFIG, context, done().fn, {
      llmLabelsTrain: true,
    });
    const state = await loadBayesState(w.env.DB, ACCOUNT);
    expect(state!.hamCount).toBe(1);
    expect(state!.spamCount).toBe(0);
  });

  it("flag ON + unsure: STILL no label — unsure never trains, flag or no flag", async () => {
    const { w } = await scaffold("unsure");
    await classifyScreened(w.env as unknown as Env, job, BOUNCER_CONFIG, context, done().fn, {
      llmLabelsTrain: true,
    });
    expect(w.db.count("bayes_state")).toBe(0);
  });
});
