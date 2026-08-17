import { describe, expect, it } from "vitest";
import { Mailstore, QUARANTINE_NAME, QUARANTINE_ROLE } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import agentWorker from "./index";
import {
  MID_BAND_KIND,
  midBandMarkerKind,
  midBandPeriodKey,
  proposeMidBandHolds,
} from "./midBandProposal";
import type { Env } from "./models";

/**
 * s12 — the mid-band becomes a PROPOSAL, not a pile.
 *
 * Driven end to end rather than by seeding a verdict: every held message here
 * goes through the REAL drain (the classifier runs, answers, and writes its own
 * chain row), and only then does the sweep look at what is left. A test that
 * seeded `verdict: unsure` directly would keep passing if the classifier
 * stopped holding — which is precisely the coupling that matters.
 *
 * The four properties:
 *
 *   BATCHED     N undecided messages produce exactly ONE proposal naming all N
 *               — never N proposals. (T9's lesson: a per-item proposal is an
 *               alert storm wearing a decision's clothes.)
 *   IDEMPOTENT  a second sweep in the same period produces NOTHING. The marker
 *               is a period-scoped `alert_kind` on the classify invocation,
 *               written with a guarded UPDATE — T9's mechanism verbatim.
 *   NOTHING TO DECIDE, NOTHING ASKED   confident spam and confident notSpam
 *               are decisions bouncer CAN make, and neither reaches the queue.
 *   NEW HOLDS ASK AGAIN   a message held after the first ask is a NEW question
 *               (its own marker), so it is not made to wait a whole period.
 */

const ACCOUNT = "t_bm__a_ada";
const TENANT = "t_bm";
const DOMAIN = "elsewhere.test";

const rawMime = (n: number) =>
  [
    `From: Sender ${n} <sender${n}@${DOMAIN}>`,
    "To: Ada <ada@example.test>",
    `Subject: maybe important ${n}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Quarterly casino numbers, no rush.",
  ].join("\r\n");

const BOUNCER_CONFIG = {
  kind: "bouncer",
  defaultModel: "cheap",
  modelAliases: { cheap: [{ provider: "workers-ai", model: "@cf/test-classifier" }] },
};

interface Stage {
  w: FakeWorker;
  store: Mailstore;
  quarantineId: string;
  /** Hold message #n in the mid-band and enqueue its classify invocation. */
  hold: (n: number) => Promise<string>;
  drain: () => Promise<void>;
  proposals: () => Array<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    rationale: string;
    expires_at: number | null;
    tier: number;
    status: string;
    account_id: string;
  }>;
  markers: () => Array<{ id: string; alert_kind: string | null }>;
}

/** The whole stage: an account, a bouncer binding, and a fake model that
 * answers `response` to every classify call. */
async function stage(
  response: string,
  opts: { bouncerAccount?: string; noModelMenu?: boolean } = {},
): Promise<Stage> {
  const w = fakeEnv();
  const bouncerAccount = opts.bouncerAccount ?? ACCOUNT;
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT });
  if (bouncerAccount !== ACCOUNT) w.db.seedAccount({ accountId: bouncerAccount, tenantId: TENANT });
  w.db.seed("agent_bindings", [
    {
      id: "bind_bouncer",
      account_id: bouncerAccount,
      name: "bouncer",
      config_json: JSON.stringify(opts.noModelMenu ? { kind: "bouncer" } : BOUNCER_CONFIG),
    },
  ]);
  w.env.AI = {
    run: async () => ({ response, usage: { prompt_tokens: 42, completion_tokens: 1 } }),
  } as unknown as Ai;

  const store = new Mailstore(w.env.DB, w.env.BLOBS);
  const quarantineId = await store.ensureRoleMailbox(ACCOUNT, QUARANTINE_ROLE, QUARANTINE_NAME);

  const hold = async (n: number): Promise<string> => {
    const emailId = `e_held_${n}`;
    const raw = new TextEncoder().encode(rawMime(n));
    const blobId = await store.putBlob(TENANT, ACCOUNT, raw.buffer as ArrayBuffer);
    await store.insertQuarantinedEmail(
      ACCOUNT,
      {
        id: emailId,
        blobId,
        threadId: `th_${n}`,
        messageId: `<held${n}@${DOMAIN}>`,
        inReplyTo: null,
        subject: `maybe important ${n}`,
        from: [{ email: `sender${n}@${DOMAIN}` }],
        to: [{ email: "ada@example.test" }],
        cc: [],
        bcc: [],
        preview: "Quarterly casino numbers, no rush.",
        bodyText: "Quarterly casino numbers, no rush.",
        size: raw.byteLength,
        receivedAt: 1000 + n,
        hasAttachment: false,
        attachments: [],
        mailboxIds: [quarantineId],
        keywords: [],
      },
      {
        event: "screened",
        sender: `sender${n}@${DOMAIN}`,
        domain: DOMAIN,
        stage: "bayes-mid@0.50",
        emailId,
        at: 1000 + n,
      },
    );
    w.db.seed("agent_invocations", [
      {
        id: `inv_classify_${n}`,
        account_id: bouncerAccount,
        binding_id: "bind_bouncer",
        binding_name: "bouncer",
        status: "pending",
        email_id: emailId,
        context_json: JSON.stringify({
          kind: "bouncer-classify",
          accountId: ACCOUNT,
          tenantId: TENANT,
          emailId,
          sender: `sender${n}@${DOMAIN}`,
          domain: DOMAIN,
          stage: "bayes-mid@0.50",
        }),
        created_at: 2,
      },
    ]);
    return emailId;
  };

  const drain = async (): Promise<void> => {
    const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    await agentWorker.fetch!(
      new Request("https://agent.internal/drain", {
        method: "POST",
        headers: { "x-internal-token": w.env.INTERNAL_TOKEN },
      }),
      w.env as never,
      execCtx,
    );
  };

  const proposals = () =>
    w.db
      .query<{
        id: string;
        kind: string;
        payload_json: string;
        rationale: string;
        expires_at: number | null;
        tier: number;
        status: string;
        account_id: string;
      }>(
        `SELECT id, kind, payload_json, rationale, expires_at, tier, status, account_id FROM agent_proposals ORDER BY created_at, id`,
      )
      .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));

  const markers = () =>
    w.db.query<{ id: string; alert_kind: string | null }>(
      `SELECT id, alert_kind FROM agent_invocations WHERE id LIKE 'inv_classify_%' ORDER BY id`,
    );

  return { w, store, quarantineId, hold, drain, proposals, markers };
}

const env = (w: FakeWorker) => w.env as unknown as Env;

// ---------------------------------------------------------------------------

describe("undecided mail becomes ONE question", () => {
  it("3 unsure holds → exactly one proposal naming all 3, and a second sweep asks nothing", async () => {
    const s = await stage("unsure");
    const ids = [await s.hold(1), await s.hold(2), await s.hold(3)];
    await s.drain(); // the classifier shrugs at all three

    // Precondition: all three are still held and still UNDECIDED (the
    // classifier wrote 'screened', not 'shunted' — nothing has judged them).
    expect(s.w.db.count("email_mailboxes", "mailbox_id = ?", s.quarantineId)).toBe(3);

    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 1 });

    const rows = s.proposals();
    expect(rows).toHaveLength(1); // ONE, not three
    const p = rows[0]!;
    expect(p.kind).toBe(MID_BAND_KIND);
    expect(p.tier).toBe(1);
    expect(p.status).toBe("pending");
    expect(p.payload.heldCount).toBe(3);
    expect(p.payload.emailIds).toEqual(ids);
    // The row has to be decidable without opening the mail: who it is from,
    // what it says, and which stage held it.
    expect(p.payload.messages).toMatchObject([
      {
        emailId: ids[0],
        sender: `sender1@${DOMAIN}`,
        subject: "maybe important 1",
        stage: "bayes-mid@0.50",
      },
      { emailId: ids[1], sender: `sender2@${DOMAIN}` },
      { emailId: ids[2], sender: `sender3@${DOMAIN}` },
    ]);
    expect(p.rationale).toMatch(/could not classify/);
    expect(p.rationale).toMatch(/edit `emailIds`/);
    // The proposal expires at the PERIOD boundary (T9's discipline): an
    // unanswered ask is superseded by the next period's, never left to rot.
    expect(p.expires_at).toBe(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1),
    );

    // THE IDEMPOTENCE BITE. Every candidate now carries this period's marker,
    // so the second sweep — the one the hourly cron runs an hour later — finds
    // nothing to ask about and stays silent.
    expect(s.markers().map((m) => m.alert_kind)).toEqual(
      Array(3).fill(midBandMarkerKind(midBandPeriodKey(Date.now()))),
    );
    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 0 });
    expect(s.proposals()).toHaveLength(1);
  });

  it("says WHEN the classifier never ran — a model outage is not a judgment", async () => {
    // `unsure` covers two different facts: the model looked and could not
    // tell, and the model never answered at all. The proposal has to
    // distinguish them, or a human reads an outage as evidence about their
    // mail.
    const s = await stage("ignored", { noModelMenu: true });
    await s.hold(1);
    await s.drain();
    await proposeMidBandHolds(env(s.w));

    const p = s.proposals()[0]!;
    expect(p.rationale).toMatch(/None of these got a real classifier verdict/);
    expect(p.rationale).toMatch(/our plumbing, not about the mail/);
    expect((p.payload.messages as Array<{ note?: string }>)[0]!.note).toMatch(
      /no model candidates/,
    );
  });

  it("a hold that arrives AFTER the ask is a new question, not a re-ask", async () => {
    const s = await stage("unsure");
    await s.hold(1);
    await s.drain();
    await proposeMidBandHolds(env(s.w));
    expect(s.proposals()).toHaveLength(1);

    // Mail does not wait for tomorrow to be asked about: the marker is per
    // MESSAGE, so the next sweep raises a proposal for the new hold ALONE.
    await s.hold(2);
    await s.drain();
    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 1 });
    const named = s.proposals().map((r) => r.payload.emailIds as string[]);
    expect(named).toHaveLength(2);
    // The property that matters: each message is named EXACTLY ONCE across the
    // two asks. The second proposal is about the new hold, not a re-run of the
    // first question with an extra line.
    expect(named.flat().sort()).toEqual(["e_held_1", "e_held_2"]);
    expect(named.map((n) => n.length)).toEqual([1, 1]);
  });

  it("the proposal lands on the RECIPIENT's account, not on bouncer@'s", async () => {
    // The classify invocation lives on bouncer@'s account (ingest puts it
    // there — bouncer watches the whole tenant's boundary), but the question
    // is about a human's own mail and has to appear in the queue that human
    // logs into.
    const s = await stage("unsure", { bouncerAccount: "t_bm__a_bouncer" });
    await s.hold(1);
    await s.drain();
    await proposeMidBandHolds(env(s.w));

    const rows = s.proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBe(ACCOUNT);
    // ...and the carrier invocation is on the same account, `done` on arrival
    // with no cost (nothing was asked of a model to raise the question).
    const carrier = s.w.db.query<{
      account_id: string;
      status: string;
      cost_micros: number | null;
      binding_name: string;
    }>(
      `SELECT account_id, status, cost_micros, binding_name FROM agent_invocations WHERE id = ?`,
      rows[0]!.id,
    )[0]!;
    expect(carrier).toMatchObject({
      account_id: ACCOUNT,
      status: "done",
      cost_micros: 0,
      binding_name: "bouncer",
    });
  });
});

describe("nothing to decide, nothing asked", () => {
  it("confident spam produces NO proposal — a shunt is a decision, not a chore", async () => {
    const s = await stage("spam");
    await s.hold(1);
    await s.hold(2);
    await s.drain();

    // Held, judged, chained — and silent. Bouncer decided; a human who wants
    // to know can ask it (conversation 2), which is not the same as being
    // handed a queue item.
    expect(s.w.db.count("email_mailboxes", "mailbox_id = ?", s.quarantineId)).toBe(2);
    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("confident notSpam produces NO proposal — it is already in the Inbox", async () => {
    const s = await stage("notSpam");
    await s.hold(1);
    await s.drain();
    expect(s.w.db.count("email_mailboxes", "mailbox_id = ?", s.quarantineId)).toBe(0);
    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
  });

  it("DefaultCase: no holds at all ⇒ the sweep writes nothing", async () => {
    const s = await stage("unsure");
    expect(await proposeMidBandHolds(env(s.w))).toEqual({ asked: 0 });
    expect(s.proposals()).toEqual([]);
    expect(s.w.db.count("agent_invocations")).toBe(0);
  });

  it("a message rescued between the verdict and the sweep is not asked about", async () => {
    const s = await stage("unsure");
    await s.hold(1);
    await s.hold(2);
    await s.drain();
    // The human got there first — their correction already won, and asking
    // them about mail they already pulled out would be noise.
    await s.store.rescueQuarantined(ACCOUNT, "e_held_1", "eric@moore.coffee");

    await proposeMidBandHolds(env(s.w));
    const rows = s.proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.emailIds).toEqual(["e_held_2"]);
  });
});
