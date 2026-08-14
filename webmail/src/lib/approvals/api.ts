// Every JMAP call `/approvals` makes, in one module — composing the injected
// `JmapClient` (no second client, invariant §6.1). `capabilityForMethod`
// already routes `ActionProposal/*` under `urn:bullmoose:params:jmap:agent`
// (../jmap/capabilities.ts:72-73), so `using[]` is right without this module
// knowing about capabilities at all.

import type { Invocation } from "../jmap/types";
import { JmapRequestError, type JmapClient } from "../jmap/JmapClient";
import { parseProposal, type ActionProposal, type RejectReason } from "./types";

export interface QueueResult {
  proposals: ActionProposal[];
  /** The account state — the `ifInState` for the next decision. */
  state: string;
}

/** The merged queue: rows from every reachable account, and the per-account
 *  state each row's decision must guard on (`ifInState` is per account — one
 *  string could only ever be right for one of them). */
export interface MergedQueueResult {
  proposals: ActionProposal[];
  states: Record<string, string>;
  /** accountId → why its queue could not be read. Partial failure must be
   *  VISIBLE: silently dropping an account reproduces the T7 bug exactly. */
  failures: Record<string, string>;
}

/**
 * One round trip: `ActionProposal/query` (no filter — the server's default is
 * everything, newest first, capped at 256; actionProposal.ts:141-156) into
 * `ActionProposal/get` off the back-reference. The client narrows and orders
 * (`clocks.ts` `orderQueue`) because urgency is a UI ordering, not a server
 * filter — the server's query only knows `status`.
 */
export async function loadQueue(client: JmapClient, accountId: string): Promise<QueueResult> {
  const { get } = await client.queryThenGet(accountId, "ActionProposal/query", {}, "ActionProposal/get");
  const list = Array.isArray(get.list) ? (get.list as Record<string, unknown>[]) : [];
  return {
    proposals: list
      .map((raw) => parseProposal(raw, accountId))
      .filter((p): p is ActionProposal => p !== null),
    state: typeof get.state === "string" ? get.state : "",
  };
}

/**
 * The queue as a HUMAN has it (s10 T7): every account they can reach, in ONE
 * round trip.
 *
 * A human's agents each live on their own account under their own principal,
 * so a single-account queue can never show them their agents' work — that was
 * the bug. The fix is a batch, not a loop of requests: 2N invocations
 * (query→get per account, each `get` back-referencing its own `query` by call
 * id) in one POST, which is what the batching client exists for.
 *
 * ONE ACCOUNT'S FAILURE MUST NOT TAKE THE QUEUE DOWN. A revoked grant, a
 * tombstoned agent account or a server that refuses one account still leaves
 * every other proposal decidable, so per-account errors are collected and
 * reported beside the rows rather than thrown.
 */
export async function loadQueues(
  client: JmapClient,
  accountIds: string[],
): Promise<MergedQueueResult> {
  if (accountIds.length === 0) return { proposals: [], states: {}, failures: {} };

  const calls: Invocation[] = [];
  accountIds.forEach((accountId, i) => {
    calls.push(["ActionProposal/query", { accountId }, `q${i}`]);
    calls.push([
      "ActionProposal/get",
      { accountId, "#ids": { resultOf: `q${i}`, name: "ActionProposal/query", path: "/ids" } },
      `g${i}`,
    ]);
  });

  const responses = await client.request(calls);
  const proposals: ActionProposal[] = [];
  const states: Record<string, string> = {};
  const failures: Record<string, string> = {};

  accountIds.forEach((accountId, i) => {
    const get = responses.find((r) => r[2] === `g${i}`);
    const query = responses.find((r) => r[2] === `q${i}`);
    if (!get || get[0] === "error") {
      // Prefer the QUERY's refusal when the get merely failed to resolve its
      // back-reference: the first error is the real one (`unsupportedFilter`
      // upstream of an `invalidResultReference` is the shape that misleads).
      const failed = query && query[0] === "error" ? query : get;
      const detail = (failed?.[1] ?? {}) as { type?: string; description?: string };
      failures[accountId] = detail.description ?? detail.type ?? "the server refused this account";
      return;
    }
    const args = get[1] as Record<string, unknown>;
    const list = Array.isArray(args.list) ? (args.list as Record<string, unknown>[]) : [];
    for (const raw of list) {
      // The row's own `accountId` wins; the request's is the pre-T7 fallback.
      const p = parseProposal(raw, accountId);
      if (p) proposals.push(p);
    }
    states[accountId] = typeof args.state === "string" ? args.state : "";
  });

  // Every account refused is a queue that shows nothing and explains nothing —
  // the failure mode this task exists to end. Surface it as a hard error.
  if (Object.keys(failures).length === accountIds.length) {
    throw new JmapRequestError(Object.values(failures)[0] ?? "the approvals queue could not be read");
  }
  return { proposals, states, failures };
}

/**
 * The verbs, as one write. `approve` optionally carries the human's
 * `editedPayload` — Edit is not a fourth verb but a richer approve, which is
 * exactly how the server models it (a decision patch that lands the edit
 * BESIDE the retained `payload`, actionProposal.ts:222-243). `info-requested`
 * is needsInfo (s10 T3): an ACTION carrying only the required human question —
 * deliberately no `reason` and no `note`, because it is not a reject and must
 * never produce a rejection record (decline-taxonomy.md).
 */
export type Verdict =
  | { status: "approved"; editedPayload?: Record<string, unknown>; note?: string }
  // `reason` is OPTIONAL because the server refuses one on the no-fault kinds
  // (`NO_FAULT_KINDS` — a budget decline is about the wallet, a held-mail
  // decline is an ANSWER). Requiring it here made those verbs unsendable.
  | { status: "rejected"; reason?: RejectReason; note?: string }
  | { status: "info-requested"; question: string };

export type DecideOutcome = { ok: true } | { ok: false; message: string };

export async function decide(
  client: JmapClient,
  accountId: string,
  id: string,
  verdict: Verdict,
  opts: { ifInState?: string } = {},
): Promise<DecideOutcome> {
  const decision: Record<string, unknown> = {};
  if (verdict.status === "rejected" && verdict.reason) decision.reason = verdict.reason;
  if (verdict.status !== "info-requested" && verdict.note) decision.note = verdict.note;

  const patch: Record<string, unknown> = {
    status: verdict.status,
    ...(Object.keys(decision).length > 0 ? { decision } : {}),
    ...(verdict.status === "approved" && verdict.editedPayload !== undefined
      ? { editedPayload: verdict.editedPayload }
      : {}),
    // needsInfo carries ONLY the question — the server refuses a decision on
    // this verb (actionProposal.ts), and this module never builds one for it.
    ...(verdict.status === "info-requested" ? { question: verdict.question } : {}),
  };

  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("ActionProposal/set", {
      accountId,
      ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
      update: { [id]: patch },
    });
  } catch (err) {
    // Method-level refusal (stateMismatch, forbidden at the base gate…).
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const updated = result.updated as Record<string, unknown> | undefined;
  if (updated && id in updated) return { ok: true };

  const notUpdated = (result.notUpdated as Record<string, { type?: string; description?: string }>)?.[id];
  return {
    ok: false,
    // Prefer the server's sentence — the tier-3 capability refusal, for one,
    // is worth showing verbatim rather than paraphrasing into something softer.
    message: notUpdated?.description ?? notUpdated?.type ?? "the server did not accept the decision",
  };
}

/**
 * s11 T1 — correct the inferred due date: a status-free `{ dueAt }` patch,
 * which the server treats as a CORRECTION (it writes `due_at` on the
 * invocation and leaves the proposal pending and undecided —
 * actionProposal.ts). Deliberately a separate function from `decide`, not a
 * fourth verdict: correcting the boundary's mis-read is not a decision, and
 * keeping the shapes apart here is what keeps a correction from ever
 * carrying a verdict by accident (the server refuses the combination too).
 *
 * `dueAt` is an ISO instant, or null to clear back to never-urgent.
 */
export async function correctDueAt(
  client: JmapClient,
  accountId: string,
  id: string,
  dueAt: string | null,
  opts: { ifInState?: string } = {},
): Promise<DecideOutcome> {
  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("ActionProposal/set", {
      accountId,
      ...(opts.ifInState ? { ifInState: opts.ifInState } : {}),
      update: { [id]: { dueAt } },
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const updated = result.updated as Record<string, unknown> | undefined;
  if (updated && id in updated) return { ok: true };
  const notUpdated = (result.notUpdated as Record<string, { type?: string; description?: string }>)?.[id];
  return {
    ok: false,
    message: notUpdated?.description ?? notUpdated?.type ?? "the server did not accept the correction",
  };
}
