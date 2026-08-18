// Thread grouping for the Finder's list column (s20 T5). Result rows group
// by `threadId` — a find lands you in a CONVERSATION, and five hits from one
// thread rendered as five unrelated rows would make the user re-do the
// grouping in their head. Pure: hits in, ordered groups out.

import type { FinderHit } from "./run";

export interface ThreadGroup {
  threadId: string;
  /** The newest hit's subject — the thread's current name, not its oldest. */
  subject: string;
  /** ISO of the newest hit — the group's sort key. */
  latest: string;
  /** Newest first within the group, matching the server's own sort. */
  hits: FinderHit[];
}

/** Group hits by thread; groups newest-activity-first, hits newest-first
 *  within each. Stable for equal timestamps (insertion order holds). */
export function groupByThread(hits: readonly FinderHit[]): ThreadGroup[] {
  const byThread = new Map<string, FinderHit[]>();
  for (const hit of hits) {
    const list = byThread.get(hit.threadId);
    if (list) list.push(hit);
    else byThread.set(hit.threadId, [hit]);
  }

  const groups: ThreadGroup[] = [];
  for (const [threadId, members] of byThread) {
    const sorted = [...members].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const newest = sorted[0]!;
    groups.push({ threadId, subject: newest.subject, latest: newest.receivedAt, hits: sorted });
  }
  return groups.sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest));
}
