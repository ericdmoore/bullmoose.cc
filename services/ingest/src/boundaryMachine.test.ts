import { beforeEach, describe, expect, it } from "vitest";
import { putSieveRules, QUARANTINE_ROLE, saveBayesState, type BayesState } from "@bullmoose/mailstore";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { __resetBoundaryBloomCache, resolveBouncerBinding } from "./boundary";
import worker, { type Env } from "./index";

/**
 * s12 wave 2-C — the MACHINE inputs wired into the cascade, proven against
 * the real handler (the boundary.test.ts /dev/inject pattern; that file's
 * wave 1-A pins are deliberately untouched):
 *
 *   stage 3 reads the account's STORED ruleset (sieve_rules) — absent/corrupt
 *           → no rules, exactly as before the wave;
 *   stage 4 reads the account's TRAINED state (bayes_state) — absent/corrupt
 *           → null → skip; two thresholds: reject / clean / the MID-BAND;
 *   stage 5's doorway: a mid-band message is HELD ('screened' + a
 *           bouncer-classify invocation, one batch) only when the tenant has
 *           a bouncer binding — otherwise it DELIVERS normally (fail open:
 *           no held mail without a classifier coming for it).
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_machine";
const TOKEN = "internal-test-token";
const SENDER = "sender@elsewhere.test";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function scaffold(): Promise<FakeWorker> {
  const w = fakeEnv();
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
  // A live mailbox-delivery binding, so "no invocation" / "which invocation"
  // assertions are real (the boundary.test.ts precedent).
  w.db.seed("agent_bindings", [{ id: "bind_emily", account_id: ACCOUNT, name: "emily", config_json: "{}" }]);
  return w;
}

/** Register the tenant's bouncer binding (accounts row + agent_bindings). */
function seedBouncer(w: FakeWorker, opts: { name?: string; config?: Record<string, unknown> } = {}): void {
  w.db.seedAccount({ accountId: ACCOUNT, tenantId: TENANT });
  w.db.seed("agent_bindings", [
    {
      id: "bind_bouncer",
      account_id: ACCOUNT,
      name: opts.name ?? "bouncer",
      config_json: JSON.stringify(opts.config ?? {}),
    },
  ]);
}

const mime = (opts: { subject?: string; body?: string } = {}) =>
  [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject ?? "hello"}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@elsewhere.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Quarterly numbers, no rush.",
  ].join("\r\n");

interface InjectResult {
  rejected?: string;
  emailId?: string;
  invocations?: number;
  quarantined?: string;
  screened?: string;
}

async function inject(w: FakeWorker, raw: string, from = SENDER): Promise<InjectResult> {
  const res = await worker.fetch(
    new Request(`https://ingest.test/dev/inject?from=${encodeURIComponent(from)}&to=ada@example.test`, {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    { ...w.env, DEV_INJECT: "1" } as unknown as Env,
    ctx(),
  );
  return (await res.json()) as InjectResult;
}

const roleMailboxId = (w: FakeWorker, role: string): string | null =>
  w.db.query<{ id: string }>(`SELECT id FROM mailboxes WHERE account_id = ? AND role = ?`, ACCOUNT, role)[0]?.id ??
  null;

const mailboxesOf = (w: FakeWorker, emailId: string): string[] =>
  w.db
    .query<{ mailbox_id: string }>(
      `SELECT mailbox_id FROM email_mailboxes WHERE account_id = ? AND email_id = ?`,
      ACCOUNT,
      emailId,
    )
    .map((r) => r.mailbox_id);

// Bayes fixtures. With spamCount == hamCount, UNSEEN tokens contribute
// exactly zero, so the score is driven only by the seeded evidence tokens —
// deterministic against arbitrary message wording.
const spamState = (): BayesState => ({
  spamCount: 20,
  hamCount: 20,
  tokens: { casino: { s: 20, h: 0 }, "domain:elsewhere.test": { s: 20, h: 0 } },
});
const hamState = (): BayesState => ({
  spamCount: 20,
  hamCount: 20,
  tokens: { casino: { s: 0, h: 20 }, "domain:elsewhere.test": { s: 0, h: 20 } },
});
/** The honest untrained state: everything scores exactly 0.5 → MID-BAND. */
const emptyState = (): BayesState => ({ spamCount: 0, hamCount: 0, tokens: {} });

beforeEach(() => __resetBoundaryBloomCache());

describe("stage 3 — the account's stored sieve ruleset", () => {
  it("a stored reject rule fires: quarantined with stage 'sieve:<ruleId>'", async () => {
    const w = await scaffold();
    await putSieveRules(w.env.DB, ACCOUNT, [
      {
        id: "no-winners",
        all: [{ kind: "contains", field: "subject", value: "winner" }],
        action: "reject",
      },
    ]);

    const res = await inject(w, mime({ subject: "You are a WINNER!!!" }));
    expect(res.quarantined).toBe("sieve:no-winners");
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, QUARANTINE_ROLE)]);
    expect(w.db.query<{ stage: string }>(`SELECT stage FROM quarantine_events WHERE account_id = ?`, ACCOUNT)).toEqual([
      { stage: "sieve:no-winners" },
    ]);
    // Sieve rejects are EXPENSIVE-stage rejects: the graduation counter bumps.
    expect(
      w.db.query<{ count: number }>(`SELECT count FROM deny_counters WHERE domain = ?`, "elsewhere.test")[0]?.count,
    ).toBe(1);

    // A non-matching message still flows.
    const clean = await inject(w, mime({ subject: "quarterly sync" }));
    expect(clean.quarantined).toBeUndefined();
    expect(clean.invocations).toBe(1);
  });

  it("an explicit PASS rule short-circuits later reject rules (first match wins)", async () => {
    const w = await scaffold();
    await putSieveRules(w.env.DB, ACCOUNT, [
      {
        id: "allow-sender",
        all: [{ kind: "glob", field: "from", value: "*@elsewhere.test" }],
        action: "pass",
      },
      {
        id: "no-winners",
        all: [{ kind: "contains", field: "subject", value: "winner" }],
        action: "reject",
      },
    ]);
    const res = await inject(w, mime({ subject: "winner winner" }));
    expect(res.quarantined).toBeUndefined();
    expect(res.emailId).toBeDefined();
  });

  it("a corrupt rules row fails OPEN: no rules, message delivered", async () => {
    const w = await scaffold();
    w.db.seed("sieve_rules", [{ account_id: ACCOUNT, rules_json: "{corrupt", updated_at: 1 }]);
    const res = await inject(w, mime({ subject: "WINNER" }));
    expect(res.quarantined).toBeUndefined();
    expect(res.emailId).toBeDefined();
    expect(w.db.count("quarantine_events")).toBe(0);
  });
});

describe("stage 4 — the account's trained Bayes state, two thresholds", () => {
  it("spam-trained evidence ≥ T_reject: quarantined 'bayes@…', counter bumped", async () => {
    const w = await scaffold();
    await saveBayesState(w.env.DB, ACCOUNT, spamState());

    const res = await inject(w, mime({ body: "casino" }));
    expect(res.quarantined).toMatch(/^bayes@/);
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, QUARANTINE_ROLE)]);
    expect(
      w.db.query<{ count: number }>(`SELECT count FROM deny_counters WHERE domain = ?`, "elsewhere.test")[0]?.count,
    ).toBe(1);
    expect(w.db.count("agent_invocations")).toBe(0); // judged spam never reaches the lobby
  });

  it("ham-trained evidence ≤ T_clean: delivered clean, nothing held", async () => {
    const w = await scaffold();
    await saveBayesState(w.env.DB, ACCOUNT, hamState());
    const res = await inject(w, mime({ body: "casino" }));
    expect(res.quarantined).toBeUndefined();
    expect(res.screened).toBeUndefined();
    expect(res.invocations).toBe(1);
  });

  it("a corrupt state row fails OPEN: stage 4 skips even with a bouncer present", async () => {
    const w = await scaffold();
    seedBouncer(w);
    w.db.seed("bayes_state", [{ account_id: ACCOUNT, state_json: "{corrupt", updated_at: 1 }]);
    const res = await inject(w, mime());
    expect(res.screened).toBeUndefined();
    expect(res.quarantined).toBeUndefined();
    expect(res.emailId).toBeDefined();
  });
});

describe("the mid-band (stage 5's doorway)", () => {
  it("WITH a bouncer binding: held as 'screened' + ONE bouncer-classify invocation enqueued", async () => {
    const w = await scaffold();
    seedBouncer(w);
    await saveBayesState(w.env.DB, ACCOUNT, emptyState()); // untrained → 0.50, the mid-band

    const res = await inject(w, mime({ subject: "maybe important" }));
    expect(res.screened).toBe("bayes-mid@0.50");
    expect(res.quarantined).toBeUndefined();
    expect(res.invocations).toBe(1); // the classifier's — and it pokes the agent

    // Held in the quarantine mailbox, chain row says SCREENED (not shunted:
    // nothing has judged it spam yet).
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, QUARANTINE_ROLE)]);
    const events = w.db.query<{ event: string; stage: string; email_id: string }>(
      `SELECT event, stage, email_id FROM quarantine_events WHERE account_id = ?`,
      ACCOUNT,
    );
    expect(events).toEqual([{ event: "screened", stage: "bayes-mid@0.50", email_id: res.emailId! }]);

    // Exactly ONE invocation — the classifier's, on the bouncer binding; the
    // mailbox-delivery binding (emily) gets nothing until the message is
    // judged clean.
    const invocations = w.db.query<{ binding_name: string; context_json: string; status: string }>(
      `SELECT binding_name, context_json, status FROM agent_invocations`,
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.binding_name).toBe("bouncer");
    expect(invocations[0]!.status).toBe("pending");
    expect(JSON.parse(invocations[0]!.context_json)).toMatchObject({
      kind: "bouncer-classify",
      accountId: ACCOUNT,
      tenantId: TENANT,
      emailId: res.emailId,
      sender: SENDER,
      domain: "elsewhere.test",
      stage: "bayes-mid@0.50",
    });

    // A screen is not a reject: the graduation counters do NOT move.
    expect(w.db.count("deny_counters")).toBe(0);
  });

  it("WITHOUT a bouncer binding: the mid-band DELIVERS normally (no hold without a classifier)", async () => {
    const w = await scaffold();
    await saveBayesState(w.env.DB, ACCOUNT, emptyState());

    const res = await inject(w, mime());
    expect(res.screened).toBeUndefined();
    expect(res.quarantined).toBeUndefined();
    expect(res.emailId).toBeDefined();
    expect(res.invocations).toBe(1); // emily's ordinary mailbox-delivery enqueue
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, "inbox")]);
    expect(w.db.count("quarantine_events")).toBe(0);
    expect(roleMailboxId(w, QUARANTINE_ROLE)).toBeNull();
  });

  it("the config marker `kind: 'bouncer'` nominates a binding regardless of name", async () => {
    const w = await scaffold();
    seedBouncer(w, { name: "doorman", config: { kind: "bouncer" } });
    expect(await resolveBouncerBinding(w.env.DB, TENANT)).toMatchObject({
      id: "bind_bouncer",
      name: "doorman",
      accountId: ACCOUNT,
    });
    // …and a DISABLED bouncer is no bouncer.
    w.db.sqlite.exec("UPDATE agent_bindings SET enabled = 0 WHERE id = 'bind_bouncer'");
    expect(await resolveBouncerBinding(w.env.DB, TENANT)).toBeNull();
  });

  it("DefaultCase: no trained state means NO screening holds, bouncer or not", async () => {
    const w = await scaffold();
    seedBouncer(w); // a bouncer exists — but there is nothing mid-band about
    const res = await inject(w, mime()); // an account with NO bayes_state row
    expect(res.screened).toBeUndefined();
    expect(res.quarantined).toBeUndefined();
    expect(mailboxesOf(w, res.emailId!)).toEqual([roleMailboxId(w, "inbox")]);
    expect(w.db.count("quarantine_events")).toBe(0);
  });
});
