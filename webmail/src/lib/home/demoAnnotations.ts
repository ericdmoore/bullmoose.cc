import type { FakeJmapClient } from "../jmap/FakeJmapClient";

// Sample annotations for the demo home (s18 A4). Registers `Annotation/query` +
// `Annotation/get` on the fake client so the Waiting-on and Commitments glances
// have something to show under `?demo`, composed into `installHomeDemo` beside
// the approvals and calendar fakes. Mirrors the server's open-status default
// and its class/objectId filters (annotation.ts).

const ACCOUNT = "acct-fake"; // the demo session's single account (FakeJmapClient)
const DAY = 86_400_000;

/** The rows, newest first. One resolved commitment proves the open filter. */
export function demoAnnotationRows(now: number): Record<string, unknown>[] {
  return [
    {
      id: "an_commit_1",
      accountId: ACCOUNT,
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e_bob" },
      class: "commitment",
      body: "You told Bob you'd send the assembled-board load calc by Friday",
      confidence: 0.82,
      status: "open",
      rationale: "“I'll get it to you Friday.”",
      sourceRef: "e_bob",
      createdAt: now - 1 * DAY,
      updatedAt: now - 1 * DAY,
    },
    {
      id: "an_wait_1",
      accountId: ACCOUNT,
      authorKind: "agent",
      author: "waiting-on",
      anchor: { realm: "Email", objectId: "e_sergio" },
      class: "task",
      body: 'Waiting on sergio@example.com\'s reply to "selling assembled boards"',
      confidence: null,
      status: "open",
      rationale: null,
      sourceRef: "e_sergio",
      createdAt: now - 4 * DAY,
      updatedAt: now - 4 * DAY,
    },
    {
      // Resolved: it must NOT show in either glance (the open-status default).
      id: "an_done",
      accountId: ACCOUNT,
      authorKind: "agent",
      author: "scribe",
      anchor: { realm: "Email", objectId: "e_old" },
      class: "commitment",
      body: "You said you'd forward the invoice — done",
      confidence: 0.9,
      status: "resolved",
      rationale: null,
      sourceRef: "e_old",
      createdAt: now - 9 * DAY,
      updatedAt: now - 2 * DAY,
    },
  ];
}

export function installAnnotationsDemo(client: FakeJmapClient, now: number): void {
  const rows = demoAnnotationRows(now);
  client.setHandler("Annotation/query", (args) => {
    const filter = (args.filter ?? {}) as { class?: string; status?: string; objectId?: string };
    const status = filter.status ?? "open";
    const ids = rows
      .filter((r) => r.status === status)
      .filter((r) => !filter.class || r.class === filter.class)
      .filter((r) => !filter.objectId || (r.anchor as { objectId?: string } | undefined)?.objectId === filter.objectId)
      .map((r) => r.id as string);
    return { accountId: ACCOUNT, queryState: "1", ids };
  });
  client.setHandler("Annotation/get", (args) => {
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;
    const list = ids ? rows.filter((r) => ids.includes(r.id as string)) : rows;
    return { accountId: ACCOUNT, state: "1", list, notFound: [] };
  });
}
