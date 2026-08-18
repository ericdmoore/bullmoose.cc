// Every JMAP call `/activity` makes, in one module — composing the injected
// `JmapClient` (no second client, invariant §6.1), the same shape as
// `../approvals/api.ts` `loadQueues` because it reads the same substrate the
// same way: one batch, every reachable account, partial failure VISIBLE.
//
// Two sources per account:
//   • `ActionProposal/query` (no filter — the server's default is everything,
//     newest first, capped at 256) into `ActionProposal/get`, partitioned
//     client-side to the DECIDED statuses (types.ts) — the rows s24 T4
//     deliberately removed from the live queue.
//   • `Watch/query {filter:{status:"fired"}}` into `Watch/get` — the watches
//     the cron already fired (services/jmap/src/methods/watch.ts: armed-only
//     is the default view, so a terminal status must be asked for by name).
//
// The feed is read-only, so — unlike the queue — no per-account `state` is
// kept: there is no decision here to guard with `ifInState`.

import type { Invocation } from "../jmap/types";
import { JmapRequestError, type JmapClient } from "../jmap/JmapClient";
import { parseDecided, parseFiredWatch, type ActivityItem } from "./types";

export interface ActivityResult {
  /** Merged, unordered — `orderFeed` (feed.ts) is the caller's job. */
  items: ActivityItem[];
  /** accountId → why part or all of its activity could not be read. Partial
   *  failure must be VISIBLE (the s10 T7 lesson): silently dropping an
   *  account turns "what happened in my name" into a partial answer that
   *  presents as a complete one. */
  failures: Record<string, string>;
  /** True when NO account served the Watch methods — an older server. The
   *  feed then says "proposals only" instead of implying no watch ever
   *  fired. */
  watchesUnavailable: boolean;
}

/**
 * The whole retrospective in ONE round trip: 4N invocations (proposal
 * query→get and watch query→get per account, each `get` back-referencing its
 * own `query` by call id) in a single POST.
 *
 * Failure rules, in order of severity:
 *   • one account's PROPOSAL read failing → its rows are missing; say so in
 *     `failures`, keep serving every other account.
 *   • one account's WATCH read failing → same, appended to that account's
 *     failure note (its decided proposals still render).
 *   • every account's watch read failing → `watchesUnavailable`, NOT a
 *     failure wall: a server predating Watch is a supported configuration.
 *   • every account's proposal read failing → throw. A feed that shows
 *     nothing and explains nothing is the failure mode this section exists
 *     to end.
 */
export async function loadActivity(client: JmapClient, accountIds: string[]): Promise<ActivityResult> {
  if (accountIds.length === 0) return { items: [], failures: {}, watchesUnavailable: false };

  const calls: Invocation[] = [];
  accountIds.forEach((accountId, i) => {
    calls.push(["ActionProposal/query", { accountId }, `pq${i}`]);
    calls.push([
      "ActionProposal/get",
      { accountId, "#ids": { resultOf: `pq${i}`, name: "ActionProposal/query", path: "/ids" } },
      `pg${i}`,
    ]);
    calls.push(["Watch/query", { accountId, filter: { status: "fired" } }, `wq${i}`]);
    calls.push([
      "Watch/get",
      { accountId, "#ids": { resultOf: `wq${i}`, name: "Watch/query", path: "/ids" } },
      `wg${i}`,
    ]);
  });

  const responses = await client.request(calls);
  const items: ActivityItem[] = [];
  const failures: Record<string, string> = {};
  let proposalFailures = 0;
  let watchFailures = 0;

  const errorText = (failed: Invocation | undefined): string => {
    const detail = (failed?.[1] ?? {}) as { type?: string; description?: string };
    return detail.description ?? detail.type ?? "the server refused this call";
  };
  /** The get, unless it failed — then prefer the QUERY's refusal: the first
   *  error is the real one (`unsupportedFilter` upstream of an
   *  `invalidResultReference` is the shape that misleads). */
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
      failures[accountId] = failures[accountId] ? `${failures[accountId]}; ${text}` : text;
    };

    const proposals = resolve(`pg${i}`, `pq${i}`);
    if ("error" in proposals) {
      proposalFailures += 1;
      note(proposals.error);
    } else {
      for (const raw of proposals.list) {
        const item = parseDecided(raw, accountId);
        if (item) items.push(item);
      }
    }

    const watches = resolve(`wg${i}`, `wq${i}`);
    if ("error" in watches) {
      watchFailures += 1;
      // Named per account only when SOME account serves watches — when none
      // does, the one honest sentence is the roster-wide `watchesUnavailable`,
      // not N copies of "unknownMethod".
      note(`watches: ${watches.error}`);
    } else {
      for (const raw of watches.list) {
        const item = parseFiredWatch(raw, accountId);
        if (item) items.push(item);
      }
    }
  });

  const watchesUnavailable = watchFailures === accountIds.length;
  if (watchesUnavailable) {
    // Drop the per-account watch notes: the roster-wide flag carries it.
    for (const accountId of accountIds) {
      const cleaned = (failures[accountId] ?? "")
        .split("; ")
        .filter((part) => part.length > 0 && !part.startsWith("watches: "))
        .join("; ");
      if (cleaned) failures[accountId] = cleaned;
      else delete failures[accountId];
    }
  }

  if (proposalFailures === accountIds.length) {
    throw new JmapRequestError(Object.values(failures)[0] ?? "the activity feed could not be read");
  }
  return { items, failures, watchesUnavailable };
}
