import { describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { budgetMonthStartMs, budgetPeriodKey } from "@bullmoose/scheduling";
import agentWorker from "./index";
import {
  frontierMarkerId,
  handleFrontierDigestForce,
  joinFrontier,
  renderFrontierDigest,
  sweepFrontierDigest,
  type FrontierRow,
} from "./frontierDigest";

/**
 * s26 T5b — Allen's frontier digest: the join (cost vs correction rate per
 * model per pipeline), the honest render, the once-per-(account, period)
 * marker, and the forced preview route.
 *
 * Written to BITE on the house rules:
 *   - NULL-vs-0 cost: an unpriced run is counted and reported, never summed
 *     as $0.00 — and a model that is ALL unpriced shows "—", not a zero;
 *   - idempotence: the month-roll digest fires once, and a re-run of the
 *     sweep in the same period is silent;
 *   - empty months produce nothing at all — no mail, no marker;
 *   - the forced route is a preview: re-runnable, marker untouched.
 */

const ACCOUNT = "t_bm__a_frontier";
const TENANT = "t_bm";
const SELF = "eric@bullmoose.cc";
const DAY = 24 * 3600_000;

// Fixed clock for the month-roll tests: 2026-08-15 UTC ⇒ the sweep digests
// 2026-07 (the previous UTC month).
const NOW = Date.UTC(2026, 7, 15);
const JULY = Date.UTC(2026, 6, 1);
const PERIOD = "2026-07";

const EXTRACT_CONFIG = JSON.stringify({ pipeline: "extract", frontier: { exploreRate: 0.1 } });
const REPLY_CONFIG = JSON.stringify({ pipeline: "reply" });

function world() {
  const w = fakeEnv();
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT, displayName: "Eric" });
  w.db.seed("identities", [{ id: "id_self", account_id: ACCOUNT, email: SELF }]);
  w.db.seed("agent_bindings", [
    { id: "bind_scout", account_id: ACCOUNT, name: "scout", config_json: EXTRACT_CONFIG },
    { id: "bind_photos", account_id: ACCOUNT, name: "photos", config_json: REPLY_CONFIG },
  ]);
  return w;
}

/** A done, model-stamped invocation — what finish() leaves behind. */
function seedRun(
  w: FakeWorker,
  o: {
    id: string;
    bindingId?: string;
    emailId?: string | null;
    doneAt: number;
    provider?: string;
    model?: string;
    costMicros?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    arm?: "exploit" | "explore";
    accountId?: string;
  },
) {
  w.db.seed("agent_invocations", [
    {
      id: o.id,
      account_id: o.accountId ?? ACCOUNT,
      binding_id: o.bindingId ?? "bind_scout",
      binding_name: o.bindingId === "bind_photos" ? "photos" : "scout",
      status: "done",
      email_id: o.emailId === undefined ? `e_${o.id}` : o.emailId,
      context_json: "{}",
      result_json: o.arm ? JSON.stringify({ note: "extracted", arm: o.arm }) : JSON.stringify({ note: "ok" }),
      created_at: o.doneAt - 1000,
      claimed_at: o.doneAt - 500,
      done_at: o.doneAt,
      provider: o.provider ?? "workers-ai",
      model: o.model ?? "llama-3.1-8b",
      cost_micros: o.costMicros === undefined ? 100 : o.costMicros,
      tokens_in: o.tokensIn === undefined ? 1000 : o.tokensIn,
      tokens_out: o.tokensOut === undefined ? 200 : o.tokensOut,
    },
  ]);
}

/** An agent-authored annotation on `emailId`, in a given lifecycle status. */
let annSeq = 0;
function seedAnnotation(w: FakeWorker, emailId: string, status: "open" | "resolved" | "dismissed") {
  annSeq += 1;
  w.db.seed("annotations", [
    {
      id: `an_${annSeq}`,
      account_id: ACCOUNT,
      author_kind: "agent",
      author: "scout",
      anchor_json: JSON.stringify({ realm: "Email", objectId: emailId }),
      class: "commitment",
      body: "will send the calc Friday",
      confidence: 0.8,
      status,
      source_ref: emailId,
      created_at: 1,
      updated_at: 1,
    },
  ]);
}

const digestEmails = (w: FakeWorker, accountId = ACCOUNT) =>
  w.db.query<{ id: string; subject: string; to_json: string; from_json: string; preview: string }>(
    "SELECT id, subject, to_json, from_json, preview FROM emails WHERE account_id = ? ORDER BY received_at",
    accountId,
  );

const markers = (w: FakeWorker) =>
  w.db.query<{ id: string; status: string; cost_micros: number; result_json: string }>(
    "SELECT id, status, cost_micros, result_json FROM agent_invocations WHERE account_id = ? AND binding_name = 'frontier-digest'",
    ACCOUNT,
  );

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function forceRequest(body?: unknown, token = "internal-test-token") {
  return new Request("https://agent.bullmoose.cc/internal/frontier-digest", {
    method: "POST",
    headers: { "x-internal-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ---- the join math (pure) --------------------------------------------------

describe("joinFrontier — the join math", () => {
  it("groups by (pipeline, provider/model) and separates unpriced from free", () => {
    const rows = joinFrontier(
      [
        {
          pipeline: "extract",
          provider: "workers-ai",
          model: "m1",
          emailId: "e1",
          costMicros: 100,
          tokensIn: 10,
          tokensOut: 1,
        },
        {
          pipeline: "extract",
          provider: "workers-ai",
          model: "m1",
          emailId: "e2",
          costMicros: 0,
          tokensIn: 20,
          tokensOut: 2,
        },
        // NULL cost: an UNPRICED run — counted, never summed as 0.
        {
          pipeline: "extract",
          provider: "workers-ai",
          model: "m1",
          emailId: "e3",
          costMicros: null,
          tokensIn: null,
          tokensOut: null,
        },
        {
          pipeline: "extract",
          provider: "openrouter",
          model: "m2",
          emailId: "e4",
          costMicros: 900,
          tokensIn: 5,
          tokensOut: 5,
        },
      ],
      [],
    );
    expect(rows).toHaveLength(2);
    const m1 = rows.find((r) => r.model === "m1")!;
    // 3 runs, but only 2 priced — the $0 run IS priced (free is a price), the
    // NULL run is not, and the sum covers priced runs only.
    expect(m1).toMatchObject({ runs: 3, pricedRuns: 2, unpricedRuns: 1, costMicros: 100 });
    expect(m1.tokensIn).toBe(30); // NULL tokens count 0 toward the sum
    const m2 = rows.find((r) => r.model === "m2")!;
    expect(m2).toMatchObject({ runs: 1, pricedRuns: 1, unpricedRuns: 0, costMicros: 900 });
  });

  it("attributes annotation outcomes to the extract model that produced them", () => {
    const rows = joinFrontier(
      [
        {
          pipeline: "extract",
          provider: "p",
          model: "cheap",
          emailId: "e1",
          costMicros: 10,
          tokensIn: 0,
          tokensOut: 0,
        },
        {
          pipeline: "extract",
          provider: "p",
          model: "cheap",
          emailId: "e2",
          costMicros: 10,
          tokensIn: 0,
          tokensOut: 0,
        },
        { pipeline: "extract", provider: "p", model: "posh", emailId: "e3", costMicros: 90, tokensIn: 0, tokensOut: 0 },
      ],
      [
        { emailId: "e1", status: "dismissed" },
        { emailId: "e1", status: "resolved" },
        { emailId: "e2", status: "open" },
        { emailId: "e2", status: "resolved" },
        { emailId: "e3", status: "resolved" },
        // An annotation on an email NO invocation in the window extracted —
        // it belongs to another period's run and must not be counted here.
        { emailId: "e_elsewhere", status: "dismissed" },
      ],
    );
    const cheap = rows.find((r) => r.model === "cheap")!;
    expect(cheap.annotations).toEqual({ total: 4, dismissed: 1, resolved: 2, open: 1 });
    const posh = rows.find((r) => r.model === "posh")!;
    expect(posh.annotations).toEqual({ total: 1, dismissed: 0, resolved: 1, open: 0 });
  });

  it("non-extract pipelines carry NO outcome labels — there is no label source", () => {
    const rows = joinFrontier(
      [{ pipeline: "reply", provider: "p", model: "m", emailId: "e1", costMicros: 10, tokensIn: 0, tokensOut: 0 }],
      // Even if an annotation cites the same email, a reply run did not write
      // it — attribution goes through extract invocations only.
      [{ emailId: "e1", status: "dismissed" }],
    );
    expect(rows[0]!.annotations).toBeNull();
  });

  it("orders by pipeline, then cheapest per priced run; all-unpriced sorts LAST", () => {
    const rows = joinFrontier(
      [
        {
          pipeline: "extract",
          provider: "p",
          model: "pricey",
          emailId: null,
          costMicros: 900,
          tokensIn: 0,
          tokensOut: 0,
        },
        {
          pipeline: "extract",
          provider: "p",
          model: "cheap",
          emailId: null,
          costMicros: 10,
          tokensIn: 0,
          tokensOut: 0,
        },
        // An unknown price is NOT a low one — it cannot claim the frontier.
        {
          pipeline: "extract",
          provider: "p",
          model: "mystery",
          emailId: null,
          costMicros: null,
          tokensIn: 0,
          tokensOut: 0,
        },
        { pipeline: "classify", provider: "p", model: "z", emailId: null, costMicros: 5, tokensIn: 0, tokensOut: 0 },
      ],
      [],
    );
    expect(rows.map((r) => `${r.pipeline}:${r.model}`)).toEqual([
      "classify:z",
      "extract:cheap",
      "extract:pricey",
      "extract:mystery",
    ]);
  });
});

// ---- the render (pure) -----------------------------------------------------

function renderInput(rows: FrontierRow[], over: Partial<Parameters<typeof renderFrontierDigest>[0]> = {}) {
  return renderFrontierDigest({
    periodKey: PERIOD,
    startMs: JULY,
    endMs: Date.UTC(2026, 7, 1),
    partial: false,
    firstAssignmentAt: Date.UTC(2026, 4, 14),
    exploreNote: "scout 10%",
    rows,
    ...over,
  });
}

const ROW: FrontierRow = {
  pipeline: "extract",
  provider: "workers-ai",
  model: "llama-3.1-8b",
  runs: 12,
  pricedRuns: 10,
  unpricedRuns: 2,
  costMicros: 12_340,
  tokensIn: 40_120,
  tokensOut: 8_933,
  annotations: { total: 8, dismissed: 2, resolved: 4, open: 2 },
};

describe("renderFrontierDigest — the honest header and the frontier table", () => {
  it("carries the honesty header: since-date, explore rate, unpriced-not-zeroed", () => {
    const { subject, text } = renderInput([ROW]);
    expect(subject).toBe(`Frontier digest — ${PERIOD}`);
    expect(text).toContain("Period: 2026-07-01 to 2026-08-01 (UTC).");
    expect(text).toContain("Assignment data since 2026-05-14 (first recorded explore/exploit arm).");
    expect(text).toContain("Exploration rate as configured: scout 10%.");
    expect(text).toContain("Unpriced runs are counted, never zeroed");
    expect(text).toContain("it is never $0.00");
  });

  it("no assignments yet: says so instead of inventing a since-date", () => {
    const { text } = renderInput([ROW], { firstAssignmentAt: null });
    expect(text).toContain("No explore/exploit assignment recorded yet");
    expect(text).not.toContain("Assignment data since");
  });

  it("the table row: runs, µ$ totals over priced runs only, rates, open count", () => {
    const { text } = renderInput([ROW]);
    const line = text.split("\n").find((l) => l.includes("workers-ai/llama-3.1-8b") && !l.startsWith("*"))!;
    // 12 runs; total over the 10 PRICED runs, starred for the 2 unpriced;
    // µ$/run = 12,340 / 10 priced; dismiss 2/8 = 25%; resolve 4/8 = 50%.
    expect(line).toMatch(/12\s+12,340\*\s+1,234\s+25%\s+50%\s+2$/);
    // ...and the star is explained, with the real counts.
    expect(text).toContain(
      "* workers-ai/llama-3.1-8b: 2 of 12 runs unpriced (cost undetermined; excluded from µ$ figures).",
    );
    expect(text).toContain("tokens: 40,120 in / 8,933 out");
  });

  it("a model with ONLY unpriced runs shows —, never a flattering $0", () => {
    const { text } = renderInput([
      {
        ...ROW,
        runs: 3,
        pricedRuns: 0,
        unpricedRuns: 3,
        costMicros: 0,
        annotations: { total: 0, dismissed: 0, resolved: 0, open: 0 },
      },
    ]);
    const line = text.split("\n").find((l) => l.includes("workers-ai/llama-3.1-8b") && !l.startsWith("*"))!;
    expect(line).toContain("—*");
    expect(line).not.toMatch(/\b0\s+0\b.*%/); // no zero posing as a price
    expect(text).toContain("3 of 3 runs unpriced");
  });

  it("non-extract pipelines render — for outcome columns, and the caveat once", () => {
    const { text } = renderInput([
      ROW,
      { ...ROW, pipeline: "reply", runs: 4, pricedRuns: 4, unpricedRuns: 0, costMicros: 220, annotations: null },
    ]);
    expect(text).toContain("── reply ");
    const line = text
      .split("\n")
      .find((l, i, ls) => l.includes("workers-ai/llama-3.1-8b") && ls.slice(0, i).some((p) => p.includes("── reply")))!;
    expect(line).toMatch(/—\s+—\s+—$/);
    expect(text).toContain("apply to the extract pipeline only");
  });

  it("a forced month-to-date preview is labelled as such", () => {
    const { subject, text } = renderInput([ROW], { partial: true, endMs: Date.UTC(2026, 6, 18) });
    expect(subject).toBe(`Frontier digest — ${PERIOD} (month to date, forced preview)`);
    expect(text).toContain("Period: 2026-07-01 to 2026-07-18 (UTC, month to date).");
  });
});

// ---- the sweep: month roll + idempotence ----------------------------------

describe("sweepFrontierDigest — once per (account, period), when the month rolls", () => {
  it("digests the PREVIOUS UTC month into the account's own inbox, and marks it", async () => {
    const w = world();
    seedRun(w, { id: "i1", emailId: "e1", doneAt: JULY + 5 * DAY, costMicros: 120, arm: "exploit" });
    seedRun(w, { id: "i2", emailId: "e2", doneAt: JULY + 6 * DAY, costMicros: null, arm: "explore" });
    seedRun(w, { id: "i3", bindingId: "bind_photos", emailId: "e9", doneAt: JULY + 7 * DAY, costMicros: 400 });
    seedAnnotation(w, "e1", "dismissed");
    seedAnnotation(w, "e1", "resolved");
    seedAnnotation(w, "e2", "open");
    // This month's run belongs to NEXT month's digest, not this one.
    seedRun(w, { id: "i_now", emailId: "e_now", doneAt: NOW - DAY, costMicros: 777 });

    expect(await sweepFrontierDigest(w.env as never, NOW)).toEqual({ sent: 1 });

    const mail = digestEmails(w);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(`Frontier digest — ${PERIOD}`);
    // Self-digest: the account's own primary identity, both ends.
    expect(mail[0]!.to_json).toContain(SELF);
    expect(mail[0]!.from_json).toContain(SELF);
    expect(mail[0]!.preview).toContain("The price-quality frontier");
    // ...delivered to the INBOX (to be read), not a sent copy.
    const boxes = w.db.query<{ role: string }>(
      `SELECT mb.role FROM email_mailboxes em
        JOIN mailboxes mb ON mb.account_id = em.account_id AND mb.id = em.mailbox_id
       WHERE em.account_id = ? AND em.email_id = ?`,
      ACCOUNT,
      mail[0]!.id,
    );
    expect(boxes.map((b) => b.role)).toEqual(["inbox"]);

    // The marker: a done, cost-0 carrier row whose id IS the idempotence key,
    // pointing at the digest it produced.
    const mk = markers(w);
    expect(mk).toHaveLength(1);
    expect(mk[0]!.id).toBe(frontierMarkerId(PERIOD));
    expect(mk[0]!.status).toBe("done");
    expect(mk[0]!.cost_micros).toBe(0);
    expect(JSON.parse(mk[0]!.result_json)).toMatchObject({
      kind: "frontier-digest",
      periodKey: PERIOD,
      emailId: mail[0]!.id,
    });
  });

  it("is idempotent: a second sweep in the same period sends NOTHING", async () => {
    const w = world();
    seedRun(w, { id: "i1", emailId: "e1", doneAt: JULY + 5 * DAY });

    expect(await sweepFrontierDigest(w.env as never, NOW)).toEqual({ sent: 1 });
    expect(await sweepFrontierDigest(w.env as never, NOW)).toEqual({ sent: 0 });
    expect(await sweepFrontierDigest(w.env as never, NOW + 3 * DAY)).toEqual({ sent: 0 });
    expect(digestEmails(w)).toHaveLength(1);
    expect(markers(w)).toHaveLength(1);
  });

  it("an empty month is skipped silently — no mail, no marker", async () => {
    const w = world();
    // Model-stamped work exists, but not in the digested month.
    seedRun(w, { id: "i_old", emailId: "e_old", doneAt: JULY - 10 * DAY });
    seedRun(w, { id: "i_now", emailId: "e_now", doneAt: NOW - DAY });
    // A skip (no model call) inside the month is not a model run.
    w.db.seed("agent_invocations", [
      {
        id: "i_skip",
        account_id: ACCOUNT,
        binding_id: "bind_scout",
        binding_name: "scout",
        status: "done",
        context_json: "{}",
        created_at: JULY + DAY,
        done_at: JULY + DAY,
      },
    ]);

    expect(await sweepFrontierDigest(w.env as never, NOW)).toEqual({ sent: 0 });
    expect(digestEmails(w)).toHaveLength(0);
    expect(markers(w)).toHaveLength(0);
  });

  it("a NEW month rolls: the next period gets its own digest, once", async () => {
    const w = world();
    seedRun(w, { id: "i1", emailId: "e1", doneAt: JULY + 5 * DAY });
    seedRun(w, { id: "i2", emailId: "e2", doneAt: NOW - DAY }); // August work

    expect(await sweepFrontierDigest(w.env as never, NOW)).toEqual({ sent: 1 });
    // September 2nd: August has rolled — its digest fires exactly once.
    const SEPT = Date.UTC(2026, 8, 2);
    expect(await sweepFrontierDigest(w.env as never, SEPT)).toEqual({ sent: 1 });
    expect(await sweepFrontierDigest(w.env as never, SEPT)).toEqual({ sent: 0 });
    const subjects = digestEmails(w).map((m) => m.subject);
    expect(subjects).toEqual([`Frontier digest — 2026-07`, `Frontier digest — 2026-08`]);
  });

  it("runs from the real cron hook, wired at the end of the scheduled sweep", async () => {
    const w = world();
    // Previous month relative to the REAL clock — the cron path takes no `now`.
    const prevStart = budgetMonthStartMs(budgetMonthStartMs(Date.now()) - 1);
    seedRun(w, { id: "i1", emailId: "e1", doneAt: prevStart + 3 * DAY });

    await agentWorker.scheduled!(
      { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController,
      w.env as never,
      ctx,
    );
    const mail = digestEmails(w);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(`Frontier digest — ${budgetPeriodKey(prevStart)}`);
  });
});

// ---- the forced preview route ----------------------------------------------

describe("POST /internal/frontier-digest — the forced preview", () => {
  it("requires the internal token — without it the route does not exist", async () => {
    const w = world();
    const res = await agentWorker.fetch!(forceRequest({}, "wrong-token"), w.env as never, ctx);
    expect(res.status).toBe(404);
    expect(digestEmails(w)).toHaveLength(0);
  });

  it("defaults to a month-to-date preview of the CURRENT month, marker untouched", async () => {
    const w = world();
    seedRun(w, { id: "i1", emailId: "e1", doneAt: Date.now() - 60_000, costMicros: 250, arm: "explore" });
    seedAnnotation(w, "e1", "open");

    const res = await agentWorker.fetch!(forceRequest({}), w.env as never, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      forced: boolean;
      digests: Array<{ accountId: string; emailId: string }>;
    };
    expect(body.period).toBe(budgetPeriodKey(Date.now()));
    expect(body.forced).toBe(true);
    expect(body.digests).toHaveLength(1);
    expect(body.digests[0]).toMatchObject({ accountId: ACCOUNT });

    const mail = digestEmails(w);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.id).toBe(body.digests[0]!.emailId);
    expect(mail[0]!.subject).toContain("(month to date, forced preview)");
    // A preview consumes nothing: no marker, so the month-roll digest still fires.
    expect(markers(w)).toHaveLength(0);
  });

  it("is re-runnable — a preview is not an idempotence event", async () => {
    const w = world();
    seedRun(w, { id: "i1", emailId: "e1", doneAt: Date.now() - 60_000 });

    await agentWorker.fetch!(forceRequest({}), w.env as never, ctx);
    await agentWorker.fetch!(forceRequest({}), w.env as never, ctx);
    expect(digestEmails(w)).toHaveLength(2);
    expect(markers(w)).toHaveLength(0);
  });

  it("takes an explicit period and an accountId filter", async () => {
    const w = world();
    const OTHER = "t_bm__a_other";
    w.db.seedAccount({ accountId: OTHER, tenantId: TENANT, displayName: "Other" });
    w.db.seed("identities", [{ id: "id_other", account_id: OTHER, email: "other@bullmoose.cc" }]);

    const prevStart = budgetMonthStartMs(budgetMonthStartMs(Date.now()) - 1);
    const period = budgetPeriodKey(prevStart);
    seedRun(w, { id: "i1", emailId: "e1", doneAt: prevStart + DAY });
    seedRun(w, { id: "i2", emailId: "e2", doneAt: prevStart + DAY, accountId: OTHER });

    const res = await agentWorker.fetch!(forceRequest({ period, accountId: ACCOUNT }), w.env as never, ctx);
    const body = (await res.json()) as { period: string; digests: Array<{ accountId: string }> };
    expect(body.period).toBe(period);
    expect(body.digests).toEqual([expect.objectContaining({ accountId: ACCOUNT })]);
    expect(digestEmails(w)).toHaveLength(1);
    expect(digestEmails(w, OTHER)).toHaveLength(0);
    // A CLOSED month forced by hand renders as the full month, not a preview.
    expect(digestEmails(w)[0]!.subject).toBe(`Frontier digest — ${period}`);
  });

  it("refuses a malformed period out loud", async () => {
    const w = world();
    const res = await handleFrontierDigestForce(forceRequest({ period: "July 2026" }), w.env as never);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("YYYY-MM");
  });
});
