import type { Invocation } from "../jmap/types";
import type { JmapClient } from "../jmap/JmapClient";
import { describeRefusal } from "../mail/triage";
import { parseAnnotation, type Annotation } from "./types";

/**
 * Load the OPEN annotations across every reachable account (s18 A4). Same batch
 * shape as `loadQueues` (approvals/api.ts): 2N invocations — `Annotation/query`
 * → `Annotation/get`, each get back-referencing its own query — in one POST, so
 * the Waiting-on and Commitments glances span a human's agents as well as their
 * own mailbox.
 *
 * ONE DIFFERENCE FROM THE QUEUE, on purpose: annotations are AMBIENT commentary,
 * not decisions waiting on you. A refused account (revoked grant, tombstoned
 * agent) is collected into `failures` and the rest still render — but even ALL
 * accounts refusing is just an empty glance here, never the hard error the
 * approvals queue throws. A home panel must not take the page down.
 */
export interface AnnotationsResult {
  annotations: Annotation[];
  failures: Record<string, string>;
}

export async function loadAnnotations(client: JmapClient, accountIds: string[]): Promise<AnnotationsResult> {
  if (accountIds.length === 0) return { annotations: [], failures: {} };

  const calls: Invocation[] = [];
  accountIds.forEach((accountId, i) => {
    calls.push(["Annotation/query", { accountId }, `q${i}`]);
    calls.push([
      "Annotation/get",
      { accountId, "#ids": { resultOf: `q${i}`, name: "Annotation/query", path: "/ids" } },
      `g${i}`,
    ]);
  });

  const responses = await client.request(calls);
  const annotations: Annotation[] = [];
  const failures: Record<string, string> = {};

  accountIds.forEach((accountId, i) => {
    const get = responses.find((r) => r[2] === `g${i}`);
    const query = responses.find((r) => r[2] === `q${i}`);
    if (!get || get[0] === "error") {
      const failed = query && query[0] === "error" ? query : get;
      const detail = (failed?.[1] ?? {}) as { type?: string; description?: string };
      failures[accountId] = detail.description ?? detail.type ?? "the server refused this account";
      return;
    }
    const args = get[1] as Record<string, unknown>;
    const list = Array.isArray(args.list) ? (args.list as Record<string, unknown>[]) : [];
    for (const raw of list) {
      const a = parseAnnotation(raw, accountId);
      if (a) annotations.push(a);
    }
  });

  return { annotations, failures };
}

// ── The margin's fetch + verbs (s18 A3) ─────────────────────────────────────

/**
 * Every state a margin renders: open claims carry verbs; resolved/dismissed
 * ones render muted, as the record of a judgment already made. The server's
 * query defaults to `open` and asks for a terminal status explicitly
 * (annotation.ts), so each status is its own query.
 */
const MARGIN_STATUSES = ["open", "resolved", "dismissed"] as const;

export interface MarginResult {
  annotations: Annotation[];
  /** First refusal seen, if any — the margin is ambient, so the caller may
   *  render nothing rather than an error; tests and debugging read this. */
  failure: string | null;
}

/**
 * Fetch a thread's annotations, batched: for each visible message id, one
 * `Annotation/query {objectId, status}` per margin status, each paired with a
 * back-referencing `Annotation/get` — 6N invocations in ONE POST, the
 * `loadThread` discipline ("a thread open is one round trip, not N").
 *
 * Anchors bind to the ORIGINAL message, so querying by the thread's own email
 * ids is complete: an annotation about a message quoted here but anchored
 * elsewhere deliberately does not appear (never a duplicate).
 */
export async function loadMarginAnnotations(
  client: JmapClient,
  accountId: string,
  emailIds: readonly string[],
): Promise<MarginResult> {
  if (emailIds.length === 0) return { annotations: [], failure: null };

  const calls: Invocation[] = [];
  const tags: string[] = [];
  emailIds.forEach((emailId, i) => {
    MARGIN_STATUSES.forEach((status, j) => {
      const q = `q${i}_${j}`;
      const g = `g${i}_${j}`;
      calls.push(["Annotation/query", { accountId, filter: { objectId: emailId, status } }, q]);
      calls.push(["Annotation/get", { accountId, "#ids": { resultOf: q, name: "Annotation/query", path: "/ids" } }, g]);
      tags.push(g);
    });
  });

  const responses = await client.request(calls);
  const annotations: Annotation[] = [];
  const seen = new Set<string>();
  let failure: string | null = null;

  for (const tag of tags) {
    const get = responses.find((r) => r[2] === tag);
    if (!get || get[0] === "error") {
      const detail = (get?.[1] ?? {}) as { type?: string; description?: string };
      failure = failure ?? detail.description ?? detail.type ?? "the server refused the annotation fetch";
      continue;
    }
    const args = get[1] as Record<string, unknown>;
    const list = Array.isArray(args.list) ? (args.list as Record<string, unknown>[]) : [];
    for (const raw of list) {
      const a = parseAnnotation(raw, accountId);
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        annotations.push(a);
      }
    }
  }

  return { annotations, failure };
}

export type CloseStatus = "resolved" | "dismissed";

export type CloseResult =
  | { ok: true }
  | {
      ok: false;
      /** A sentence a person can act on (the triage `describeRefusal` shape). */
      message: string;
      /** True when the session lacks the `annotate` scope — the caller greys
       *  the verbs rather than inviting the same refusal again. */
      forbidden: boolean;
    };

/**
 * Close a claim forward: Resolve (it came true / was handled) or Dismiss
 * ("not a real one" — the labeled negative the extractor trains on, s12's
 * rescue→Bayes shape). One status write; the body is never touched — the
 * server refuses anything else (annotation.ts, close-forward guard).
 */
export async function closeAnnotation(
  client: JmapClient,
  accountId: string,
  id: string,
  status: CloseStatus,
): Promise<CloseResult> {
  const [response] = await client.request([["Annotation/set", { accountId, update: { [id]: { status } } }, "s0"]]);
  if (!response) return { ok: false, message: "no response from the server", forbidden: false };

  if (response[0] === "error") {
    const detail = response[1] as { type?: string; description?: string };
    const refusal = describeRefusal(detail, ["annotate"]);
    return { ok: false, message: refusal.message, forbidden: refusal.type === "forbidden" };
  }

  const result = response[1] as {
    updated?: Record<string, unknown>;
    notUpdated?: Record<string, { type?: string; description?: string }>;
  };
  if (result.updated && id in result.updated) return { ok: true };
  const err = result.notUpdated?.[id];
  return {
    ok: false,
    message: err?.description ?? `The server refused: ${err?.type ?? "unknown"}.`,
    forbidden: false,
  };
}
