import { describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import worker, { type Env } from "./index";

/**
 * Ingest stamps the mechanical facets on a REAL enqueue (s11 T1/T6).
 *
 * Drives the worker's `fetch` (`/dev/inject`), not `deliver` directly, the
 * same as fts.test.ts — so what is asserted is what a delivered message
 * actually produces: the unchanged pending invocation row, PLUS the boundary
 * stamp (due_at, requires_json, floor-composed privacy) and the deliberate
 * NULLs (sender_class, effort_prior — the s12 boundary agent's to author;
 * ingest has no sender verdict today and must not invent one).
 */

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_facets";
const TOKEN = "internal-test-token";

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function scaffold(bindingConfig: Record<string, unknown> = {}): Promise<FakeWorker> {
  const w = fakeEnv();
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
  w.db.seed("agent_bindings", [
    {
      id: "bind_f",
      account_id: ACCOUNT,
      name: "emily",
      config_json: JSON.stringify(bindingConfig),
    },
  ]);
  return w;
}

async function deliver(w: FakeWorker, raw: string): Promise<void> {
  const res = await worker.fetch(
    new Request("https://ingest.test/dev/inject?from=sender@elsewhere.test&to=ada@example.test", {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    { ...w.env, DEV_INJECT: "1" } as unknown as Env,
    ctx(),
  );
  const body = (await res.json()) as { rejected?: string; invocations?: number };
  expect(body.rejected).toBeUndefined();
  expect(body.invocations).toBe(1);
}

interface FacetRow {
  status: string;
  due_at: number | null;
  privacy: string | null;
  sender_class: string | null;
  effort_prior: string | null;
  requires_json: string | null;
}

const invocationRow = (w: FakeWorker): FacetRow =>
  w.db.query<FacetRow>(
    `SELECT status, due_at, privacy, sender_class, effort_prior, requires_json
     FROM agent_invocations WHERE account_id = ?`,
    ACCOUNT,
  )[0]!;

const plain = (opts: { subject: string; body: string }) =>
  [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject}`,
    "Message-ID: <m1@elsewhere.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
  ].join("\r\n");

/** text part + one PNG attachment, for the vision derivation. */
const withImage = (opts: { subject: string; body: string }) =>
  [
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    `Subject: ${opts.subject}`,
    "Message-ID: <m2@elsewhere.test>",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    "--B",
    "Content-Type: image/png",
    'Content-Disposition: attachment; filename="chart.png"',
    "Content-Transfer-Encoding: base64",
    "",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
    "--B--",
  ].join("\r\n");

describe("a real enqueue stamps the mechanical facets", () => {
  it("stamps due_at, floor-composed privacy and requires_json; judged facets stay NULL", async () => {
    const w = await scaffold({ privacyFloor: "internal" });
    const body = "Can you review the attached chart by 2027-03-05? Thanks!";
    await deliver(w, withImage({ subject: "chart review", body }));

    const row = invocationRow(w);
    expect(row.status).toBe("pending"); // the enqueue itself is unchanged
    expect(row.due_at).toBe(Date.UTC(2027, 2, 5, 17, 0)); // deterministic extraction, EOD UTC
    // Ingest stamps NO privacy of its own; the composed class IS the floor.
    expect(row.privacy).toBe("internal");
    // s12's to author — a stamped value here would mean ingest invented a classifier.
    expect(row.sender_class).toBeNull();
    expect(row.effort_prior).toBeNull();
    const requires = JSON.parse(row.requires_json!) as { contextTokens: number; vision?: boolean };
    expect(requires.vision).toBe(true); // image/* attachment → vision
    expect(requires.contextTokens).toBe(Math.ceil(body.length / 4)); // ~4 chars/token over the TEXT, not raw bytes
  });

  it("no floor, no deadline, no image → only contextTokens; everything else NULL", async () => {
    const w = await scaffold({});
    const body = "Quarterly numbers attached, no rush.";
    await deliver(w, plain({ subject: "numbers", body }));

    const row = invocationRow(w);
    expect(row.due_at).toBeNull(); // never-urgent
    expect(row.privacy).toBeNull(); // no stamp, no floor → no facet (DefaultCase corner)
    expect(row.sender_class).toBeNull();
    expect(row.effort_prior).toBeNull();
    expect(JSON.parse(row.requires_json!)).toEqual({ contextTokens: Math.ceil(body.length / 4) });
  });

  it("a pinned floor survives regardless of message content — the floor rule, live", async () => {
    const w = await scaffold({ privacyFloor: "pinned" });
    await deliver(w, plain({ subject: "hello", body: "totally public chit-chat, by Friday" }));
    expect(invocationRow(w).privacy).toBe("pinned");
  });
});
