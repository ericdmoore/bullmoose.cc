// Every read the receipt makes, in one module — the `lib/activity/api.ts` and
// `lib/approvals/api.ts` split applied again: injected clients, composed, never
// constructed here.
//
// ## Two doors, because no single one answers the question
//
// This surface deliberately invents NO server method (s36's own lesson from
// s03.E: two complete screens against data that was not reachable). It is built
// entirely over what already ships, and the seam is worth stating because it is
// also the shape of what is missing.
//
//   `/console/agents/{accountId}` (HttpConsoleClient, owner-only) is the ONLY
//   door to a binding's runs and its money. It carries `cost_micros`, the skip
//   marker in `note`, the per-binding queue aggregate, and `budgets.spendPerMonth`
//   as `economics.budgetMicros`.
//
//   JMAP (`ActionProposal/*`, `Annotation/*`) is the only door to what those
//   runs PRODUCED. `AgentInvocation/get` does not project cost at all, and
//   `AgentInvocation/query` filters on status alone and returns the OLDEST 64 —
//   so it cannot answer "what happened recently" even approximately.
//
// ⚠️ The console's invocation list is capped at 25 rows per ACCOUNT, newest
// first, with no time filter and no per-binding filter. That is not a bug here,
// it is the read's contract — and it is why `InvocationMix.truncated` exists and
// why the outcome mix is presented as a sample rather than a count. The fix is
// server-side and is written up in the PR, not worked around here: a client that
// paginated its way to a census over a read never designed for one would be
// inventing an answer the way this surface exists not to.

import type { AgentConsoleClient, AgentSummary } from "../console/ConsoleClient";
import type { AgentDossier } from "../console/types";
import { parseAnnotation, type Annotation } from "../annotations/types";
import { parseProposal, type ActionProposal } from "../approvals/types";
import { JmapRequestError, type JmapClient } from "../jmap/JmapClient";
import type { Invocation } from "../jmap/types";

/**
 * Every annotation status, asked for BY NAME. `Annotation/query` defaults to
 * `open` — *"what does the agent think is live", not a graveyard of decided
 * ones* — which is right for the margin and wrong here: a receipt that counted
 * only open claims would hide every dismissal, and the dismissals are the
 * labelled negatives ("Not a real one") that say whether the extraction was any
 * good.
 */
export const ANNOTATION_STATUSES = ["open", "resolved", "dismissed"] as const;

export interface ReceiptData {
  agents: AgentSummary[];
  dossiers: AgentDossier[];
  proposals: ActionProposal[];
  annotations: Annotation[];
  /** accountId → why its dossier could not be read. */
  dossierFailures: Record<string, string>;
  /** accountId → why its produced work could not be read. */
  producedFailures: Record<string, string>;
}

/**
 * The whole receipt: one console call per agent account, then ONE JMAP POST
 * carrying every proposal and annotation read for every one of them.
 *
 * Failure rules, mirroring `loadActivity`'s severity ladder:
 *   • one account's dossier failing → that agent's runs and budget are missing;
 *     say so, keep serving the others.
 *   • one account's produced read failing → its bindings render with the runs
 *     they have and NO produced counts, flagged incomplete. A zero there would
 *     be a fabricated measurement, which is the one thing this page may not do.
 *   • the JMAP batch failing outright → all produced reads are marked failed,
 *     never silently zeroed.
 *   • every dossier failing → throw. There is nothing to render and no honest
 *     way to imply otherwise.
 */
export async function loadReceipt(client: JmapClient, reads: AgentConsoleClient): Promise<ReceiptData> {
  const agents = await reads.listAgents();
  if (agents.length === 0) {
    return {
      agents,
      dossiers: [],
      proposals: [],
      annotations: [],
      dossierFailures: {},
      producedFailures: {},
    };
  }

  type DossierRead =
    | { ok: true; accountId: string; dossier: AgentDossier }
    | { ok: false; accountId: string; error: string };

  const settled: DossierRead[] = await Promise.all(
    agents.map(async (a): Promise<DossierRead> => {
      try {
        return { ok: true, accountId: a.accountId, dossier: await reads.agentDossier(a.accountId) };
      } catch (err) {
        return { ok: false, accountId: a.accountId, error: message(err) };
      }
    }),
  );

  const dossiers: AgentDossier[] = [];
  const dossierFailures: Record<string, string> = {};
  for (const s of settled) {
    if (s.ok) dossiers.push(s.dossier);
    else dossierFailures[s.accountId] = s.error;
  }
  if (dossiers.length === 0) {
    throw new JmapRequestError(Object.values(dossierFailures)[0] ?? "no agent dossier could be read");
  }

  const accountIds = dossiers.map((d) => d.accountId);
  const produced = await loadProduced(client, accountIds);

  return { agents, dossiers, ...produced, dossierFailures };
}

interface ProducedRead {
  proposals: ActionProposal[];
  annotations: Annotation[];
  producedFailures: Record<string, string>;
}

/**
 * The JMAP half, split out so it is drivable on its own: 2 calls per account
 * for proposals and 2 per annotation status, each `get` back-referencing its
 * own `query` by call id, all in ONE POST.
 */
export async function loadProduced(client: JmapClient, accountIds: readonly string[]): Promise<ProducedRead> {
  if (accountIds.length === 0) return { proposals: [], annotations: [], producedFailures: {} };

  const calls: Invocation[] = [];
  accountIds.forEach((accountId, i) => {
    calls.push(["ActionProposal/query", { accountId }, `pq${i}`]);
    calls.push([
      "ActionProposal/get",
      { accountId, "#ids": { resultOf: `pq${i}`, name: "ActionProposal/query", path: "/ids" } },
      `pg${i}`,
    ]);
    ANNOTATION_STATUSES.forEach((status, j) => {
      calls.push(["Annotation/query", { accountId, filter: { status } }, `aq${i}-${j}`]);
      calls.push([
        "Annotation/get",
        { accountId, "#ids": { resultOf: `aq${i}-${j}`, name: "Annotation/query", path: "/ids" } },
        `ag${i}-${j}`,
      ]);
    });
  });

  let responses: Invocation[];
  try {
    responses = await client.request(calls);
  } catch (err) {
    // The batch itself did not land. Every account is unreadable, and each one
    // says so — the alternative is N bindings rendering "produced nothing".
    const why = message(err);
    const producedFailures: Record<string, string> = {};
    for (const accountId of accountIds) producedFailures[accountId] = why;
    return { proposals: [], annotations: [], producedFailures };
  }

  const proposals: ActionProposal[] = [];
  const annotations: Annotation[] = [];
  const producedFailures: Record<string, string> = {};

  const errorText = (failed: Invocation | undefined): string => {
    const detail = (failed?.[1] ?? {}) as { type?: string; description?: string };
    return detail.description ?? detail.type ?? "the server refused this call";
  };
  /** The get, unless it failed — then the QUERY's refusal, which is the real
   *  one (an `unsupportedFilter` upstream of an `invalidResultReference` is the
   *  shape that misleads). Same rule as `loadActivity`. */
  const resolve = (getId: string, queryId: string): { list: Record<string, unknown>[] } | { error: string } => {
    const get = responses.find((r) => r[2] === getId);
    const query = responses.find((r) => r[2] === queryId);
    if (!get || get[0] === "error") {
      return { error: errorText(query && query[0] === "error" ? query : get) };
    }
    const args = get[1] as Record<string, unknown>;
    return { list: Array.isArray(args.list) ? (args.list as Record<string, unknown>[]) : [] };
  };

  accountIds.forEach((accountId, i) => {
    const note = (text: string): void => {
      producedFailures[accountId] = producedFailures[accountId] ? `${producedFailures[accountId]}; ${text}` : text;
    };

    const props = resolve(`pg${i}`, `pq${i}`);
    if ("error" in props) note(`proposals: ${props.error}`);
    else {
      for (const raw of props.list) {
        const p = parseProposal(raw, accountId);
        if (p) proposals.push(p);
      }
    }

    ANNOTATION_STATUSES.forEach((status, j) => {
      const ann = resolve(`ag${i}-${j}`, `aq${i}-${j}`);
      if ("error" in ann) {
        note(`${status} annotations: ${ann.error}`);
        return;
      }
      for (const raw of ann.list) {
        const a = parseAnnotation(raw, accountId);
        if (a) annotations.push(a);
      }
    });
  });

  return { proposals, annotations, producedFailures };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
