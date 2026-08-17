import type { Invocation } from "../jmap/types";
import type { JmapClient } from "../jmap/JmapClient";
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
