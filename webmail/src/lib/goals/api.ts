// The Goals doors (s20 T6) — one module, the `lib/approvals/api.ts` split
// applied again: the injected `JmapClient` is composed, never a second client,
// and `capabilityForMethod` routes `Goal/*` under the agent URN already, so
// `using[]` is right without this module knowing about capabilities at all.
//
// FOUR doors, and three of them are calls that already existed:
//
//   list      `Goal/query` + `Goal/get`. Everything derived server-side.
//   state     `Goal/set` — graduate ONE checkpoint class, or cancel.
//   plan      `ActionProposal/set` — the plan-approval checkpoint, decided
//             INLINE. This is the whole of "the venue moves, the ledger does
//             not": the redline sends the ordinary approve-with-editedPayload
//             (or the ordinary needsInfo), so the identical proposal, decision
//             and provenance rows are written as if it had gone through the
//             queue. There is no goal-specific decision endpoint, and there
//             must never be one.
//   create    `Goal/set` create, against a binding the account actually has.
//
// Every refusal comes back as a sentence, never a throw — a server without the
// methods, a mailbox with no agent, a scope wall. A goal surface that fails
// must fail the way the margin does: in place, quietly, saying what happened.

import type { JmapClient } from "../jmap/JmapClient";
import { describeRefusal } from "../mail/triage";
import { pickVerbBinding } from "../verbs/contract";
import type { CheckpointClass, Goal, PlanPayload } from "./types";

export type GoalOutcome<T> = { ok: true; value: T } | { ok: false; message: string; forbidden: boolean };

const refused = <T>(message: string, forbidden = false): GoalOutcome<T> => ({ ok: false, message, forbidden });

/** A server that does not know the method — an older deployment. */
function unknownMethodSentence(detail: { type?: string }): string | null {
  return detail.type === "unknownMethod" ? "This mailbox's server does not offer goals yet." : null;
}

/** Read the roster and pick a binding, asked rather than assumed — #206's
 *  `AgentBinding/get` retired the `extractor` convention, and `pickVerbBinding`
 *  is the ONE place the preference order lives. A goal names the agent that
 *  holds its delegation, so guessing a name here would be inventing an
 *  authority chain. */
async function resolveBinding(client: JmapClient, accountId: string): Promise<GoalOutcome<string>> {
  let response;
  try {
    [response] = await client.request([["AgentBinding/get", { accountId, ids: null }, "b0"]]);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if (response?.[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    const refusal = describeRefusal(detail, ["read"]);
    return refused(unknownMethodSentence(detail) ?? refusal.message, refusal.type === "forbidden");
  }
  const list = (response?.[1] as { list?: { id: string; name: string; enabled: boolean }[] } | undefined)?.list ?? [];
  const picked = pickVerbBinding(list);
  if (picked) return { ok: true, value: picked.id };
  return refused(
    list.length === 0
      ? "No agent is set up on this mailbox yet, so there is nobody to delegate to."
      : "Every agent on this mailbox is switched off. Turn one back on and a goal has somewhere to run.",
  );
}

/** The roster, newest first. `Goal/get` with `ids: null` is one round trip and
 *  the server already caps it at 256 — a client-side query would be a second
 *  call for an ordering the server already applies. */
export async function loadGoals(client: JmapClient, accountId: string): Promise<GoalOutcome<Goal[]>> {
  let response;
  try {
    [response] = await client.request([["Goal/get", { accountId, ids: null }, "g0"]]);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if (!response) return refused("no response from the server");
  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    const refusal = describeRefusal(detail, ["read"]);
    return refused(unknownMethodSentence(detail) ?? refusal.message, refusal.type === "forbidden");
  }
  return { ok: true, value: ((response[1] as { list?: Goal[] }).list ?? []) as Goal[] };
}

export interface NewGoal {
  statement: string;
  contact: string[];
  mayNot: string[];
  doneWhen: string;
  budgetUsd: number | null;
  escalateAfterDays: number | null;
}

/** State a goal. The contract is sent as the human authored it — the server
 *  compiles it and stores both, so the face and the enforcement can be
 *  compared rather than assumed equal. */
export async function createGoal(
  client: JmapClient,
  accountId: string,
  spec: NewGoal,
): Promise<GoalOutcome<{ id: string }>> {
  const statement = spec.statement.trim();
  if (!statement) return refused("What do you want to be true? That sentence is the goal.");
  const doneWhen = spec.doneWhen.trim();
  // Refused here, before any round trip, for the reason the server refuses it:
  // a delegation with no done-ness is a standing instruction to keep going,
  // which is the thing a goal exists to replace.
  if (!doneWhen) return refused("What does done look like? A goal with no done-ness never ends.");

  const binding = await resolveBinding(client, accountId);
  if (!binding.ok) return binding;

  const contract = {
    may: { tools: [], contact: spec.contact.map((c) => c.trim()).filter(Boolean) },
    mayNot: spec.mayNot.map((m) => m.trim()).filter(Boolean),
    escalateWhen:
      spec.escalateAfterDays && spec.escalateAfterDays > 0
        ? { afterMs: Math.round(spec.escalateAfterDays * 86_400_000) }
        : null,
    doneWhen,
    budgetUsd: spec.budgetUsd,
  };

  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("Goal/set", {
      accountId,
      create: { g: { bindingId: binding.value, statement, contract } },
    });
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  const created = (result.created as Record<string, { id?: string }> | undefined)?.g;
  if (created?.id) return { ok: true, value: { id: created.id } };
  const err = (result.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.g;
  return refused(err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`, err?.type === "forbidden");
}

/** Graduate or demote ONE checkpoint class. Per class, never globally — a goal
 *  that graduated wholesale is the silently-widening autonomy this product
 *  exists to prevent. */
export async function setCheckpoint(
  client: JmapClient,
  accountId: string,
  goalId: string,
  cls: CheckpointClass,
  mode: "manual" | "auto",
): Promise<GoalOutcome<null>> {
  return updateGoal(client, accountId, goalId, { checkpoints: { [cls]: mode } });
}

/** Revoke the standing authority. Pending tasks stop; the record stays. */
export async function cancelGoal(client: JmapClient, accountId: string, goalId: string): Promise<GoalOutcome<null>> {
  return updateGoal(client, accountId, goalId, { status: "cancelled" });
}

async function updateGoal(
  client: JmapClient,
  accountId: string,
  goalId: string,
  patch: Record<string, unknown>,
): Promise<GoalOutcome<null>> {
  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("Goal/set", { accountId, update: { [goalId]: patch } });
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if ((result.updated as Record<string, unknown> | undefined)?.[goalId] !== undefined) {
    return { ok: true, value: null };
  }
  const err = (result.notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.[goalId];
  return refused(err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`, err?.type === "forbidden");
}

/** The `goal-plan` proposal's payload — the sketch the human redlines. */
export async function loadPlanPayload(
  client: JmapClient,
  accountId: string,
  proposalId: string,
): Promise<GoalOutcome<PlanPayload>> {
  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("ActionProposal/get", {
      accountId,
      ids: [proposalId],
      properties: ["id", "kind", "payload", "rationale", "status"],
    });
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  const row = (result.list as Array<{ payload?: PlanPayload }> | undefined)?.[0];
  if (!row) return refused("That plan is no longer in your queue.");
  return { ok: true, value: row.payload ?? {} };
}

/**
 * DECIDE THE PLAN — and note what this function does NOT do: it does not know
 * about goals.
 *
 * It sends the ordinary `ActionProposal/set` verb the approvals queue sends,
 * with the ordinary `editedPayload`. That is the entire mechanism behind "an
 * edit that leaves nothing unresolved IS the approval, and the same rows are
 * written as if it had gone through the queue" — there is nothing goal-shaped
 * on the wire, so there is nothing that could write a different ledger.
 */
export async function decidePlan(
  client: JmapClient,
  accountId: string,
  proposalId: string,
  verdict:
    | { status: "approved"; editedPayload?: Record<string, unknown> }
    | { status: "info-requested"; question: string }
    | { status: "rejected"; reason?: "wrongContent" | "wrongAction" | "unsafe"; note?: string },
): Promise<GoalOutcome<null>> {
  const patch: Record<string, unknown> = { status: verdict.status };
  if (verdict.status === "approved" && verdict.editedPayload) patch.editedPayload = verdict.editedPayload;
  if (verdict.status === "info-requested") patch.question = verdict.question;
  if (verdict.status === "rejected" && (verdict.reason || verdict.note)) {
    patch.decision = {
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.note ? { note: verdict.note } : {}),
    };
  }

  let result: Record<string, unknown>;
  try {
    result = await client.requestOne("ActionProposal/set", { accountId, update: { [proposalId]: patch } });
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  if ((result.updated as Record<string, unknown> | undefined)?.[proposalId] !== undefined) {
    return { ok: true, value: null };
  }
  const err = (result.notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.[proposalId];
  return refused(
    // The server's own sentences are good ones — an attenuation refusal names
    // the axis and the ceiling — so they are passed through verbatim rather
    // than paraphrased into something softer.
    err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`,
    err?.type === "forbidden",
  );
}
