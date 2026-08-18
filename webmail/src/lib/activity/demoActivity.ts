// The demo backend for `/activity?demo=1` — built by COMPOSING the approvals
// installer (the `demoHome.ts` pattern) rather than cloning its fixtures:
//
//   • decided proposals — `installApprovalsDemo`'s own history rows (approved
//     after edit, declined, declined under the retired taxonomy, expired),
//     plus ONE new fixture: a yanked reply, because the yank verb landed
//     server-side (s03.D T2) and this page is the only surface that renders
//     the outcome.
//   • fired watches — the `Watch/query|get` handlers the fake client does not
//     otherwise carry, mirroring the server's semantics warts included
//     (services/jmap/src/methods/watch.ts): armed-only is the DEFAULT view, a
//     terminal status must be asked for by name, deadline order, cap 256.
//
// One realm per module, attached through `FakeJmapClient.setHandler`, so
// parallel section work never edits one shared fake.

import type { FakeJmapClient, MethodHandler } from "../jmap/FakeJmapClient";
import { demoProposals, installApprovalsDemo, type ApprovalsDemoBackend } from "../approvals/demoApprovals";
import type { ActionProposal } from "../approvals/types";

const ACCOUNT = "acct-fake";
const USERNAME = "fake@bullmoose.test";

export interface ActivityDemoOptions {
  /** Anchor for the fixtures' clocks; defaults to wall time. */
  now?: number;
}

/** A Watch row as the fake serves it — the server's `toJmap` shape. */
export interface DemoWatchRow extends Record<string, unknown> {
  id: string;
  conditionType: string;
  condition: Record<string, unknown>;
  deadlineAt: number;
  actionType: string;
  action: Record<string, unknown>;
  status: string;
  sourceRef: string | null;
  createdAt: number;
  firedAt: number | null;
  proposalId: string | null;
}

/**
 * The yanked row: a tier-2 reply approved into the hold tray, then pulled
 * back inside the window. `status: "yanked"` does not fit the approvals
 * client type on purpose — that queue never renders one — so the cast below
 * is the wire being more honest than the narrow type, exactly the case
 * `parseDecided` (types.ts) exists for.
 */
export function demoYankedProposal(now: number): ActionProposal {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const hour = 3600_000;
  return {
    id: "ap-yanked-sergio",
    accountId: ACCOUNT,
    agent: "Emily",
    kind: "reply-draft",
    tier: 2,
    subject: { realm: "Email", objectId: "e-boards" },
    payload: {
      to: "sergio@example.test",
      self: "eric@bullmoose.test",
      subject: "Re: Board order — confirming quantities",
      text: "Confirming 40 boards at the quoted price. Go ahead.\n\n— Eric",
      mode: "send",
    },
    editedPayload: null,
    rationale: "Sergio asked for written confirmation; the thread has the quote and the quantities.",
    evidence: [{ realm: "Email", objectId: "e-boards", note: "the quote being confirmed" }],
    status: "yanked",
    decision: { by: USERNAME, note: "quantities were wrong — pulled it back to recount" },
    createdAt: iso(now - 8 * hour),
    decidedAt: iso(now - 6 * hour),
    holdUntil: iso(now - 6 * hour + 5 * 60_000),
    expiresAt: iso(now - 6 * hour),
    dueAt: null,
    question: null,
    amendments: [],
    invocationStatus: "done",
    claimedAt: null,
    costMicros: 1730,
    tokensIn: 1204,
    tokensOut: 288,
    costModel: "openrouter/minimax/minimax-m3",
  } as unknown as ActionProposal;
}

/**
 * Two fired and one still armed — the armed one exists to PROVE the filter:
 * it must never reach the feed, exactly as the server's default view never
 * shows a graveyard.
 */
export function demoWatches(now: number): DemoWatchRow[] {
  const hour = 3600_000;
  const day = 24 * hour;
  return [
    {
      // no-reply-from, fired, produced a follow-up proposal (s20 T1's loop).
      id: "w-sergio-boards",
      conditionType: "no-reply-from",
      condition: { sender: "sergio@example.test", threadId: "e-boards" },
      deadlineAt: now - 5 * hour,
      actionType: "draft-followup",
      action: { to: "sergio@example.test", subject: "Re: Board order" },
      status: "fired",
      sourceRef: "email:e-boards",
      createdAt: now - 3 * day,
      firedAt: now - 5 * hour,
      proposalId: "ap-reply-elk",
      accountId: ACCOUNT,
    },
    {
      // deadline watch, fired, notify-only — no proposal to point at.
      id: "w-invoice-ack",
      conditionType: "deadline",
      condition: { note: "billing to acknowledge invoice 0042" },
      deadlineAt: now - 2 * day,
      actionType: "notify",
      action: {},
      status: "fired",
      sourceRef: "email:e-invoice",
      createdAt: now - 6 * day,
      firedAt: now - 2 * day,
      proposalId: null,
      accountId: ACCOUNT,
    },
    {
      // ARMED — must not appear on /activity; it belongs to the live surfaces.
      id: "w-grace-agenda",
      conditionType: "no-reply-from",
      condition: { sender: "grace@example.test" },
      deadlineAt: now + 2 * day,
      actionType: "notify",
      action: {},
      status: "armed",
      sourceRef: "email:e-thread-1",
      createdAt: now - hour,
      firedAt: null,
      proposalId: null,
      accountId: ACCOUNT,
    },
  ];
}

export interface ActivityDemoBackend {
  approvals: ApprovalsDemoBackend;
  watches: DemoWatchRow[];
}

/** Attach both sources to a running demo client. */
export function installActivityDemo(client: FakeJmapClient, opts: ActivityDemoOptions = {}): ActivityDemoBackend {
  const now = opts.now ?? Date.now();
  const approvals = installApprovalsDemo(client, {
    now,
    proposals: [...demoProposals(now), demoYankedProposal(now)],
  });
  const watches = demoWatches(now);

  const byDeadlineAsc = (a: DemoWatchRow, b: DemoWatchRow): number =>
    a.deadlineAt - b.deadlineAt || a.id.localeCompare(b.id);

  const query: MethodHandler = (args) => {
    const filter = (args.filter as { status?: string } | null | undefined) ?? null;
    // Mirrors the server: only ARMED is the default view — a roster of
    // watches is "what am I waiting on", not a graveyard of fired ones.
    const status = filter?.status ?? "armed";
    const rows = watches.filter((w) => w.status === status).sort(byDeadlineAsc);
    return {
      accountId: ACCOUNT,
      queryState: "0",
      ids: rows.slice(0, 256).map((w) => w.id),
    };
  };

  const get: MethodHandler = (args) => {
    const ids = args.ids as string[] | null | undefined;
    const rows = ids == null ? watches.slice(0, 256) : watches.filter((w) => ids.includes(w.id));
    return {
      accountId: ACCOUNT,
      state: "0",
      list: rows,
      notFound: (ids ?? []).filter((id) => !watches.some((w) => w.id === id)),
    };
  };

  client.setHandler("Watch/query", query);
  client.setHandler("Watch/get", get);
  return { approvals, watches };
}
