// WHICH accounts the approvals queue spans, and what the human may DO on each
// (s10 T7). Pure and tested; the island renders what these functions decide.
//
// The bug, observed live: EditorEmily produced a real `pending` proposal and
// `/approvals` said "Nothing is waiting on you." Agents are separate
// PRINCIPALS by design, so the proposal lived on the agent's account while the
// queue read exactly one — the session's mail primary. Every layer was
// correct; the composition was not.
//
// The queue is HUMAN-scoped by intent, so it must be human-scoped by
// implementation: every account the session lists that advertises the agent
// capability — owned first, then the agent accounts a supervisory grant opens.
// The session is the only honest source for that list, because reach is
// computed server-side from grants (`reachableAccounts`) and changes the
// moment one is revoked.

import { AGENT_CAP, MAIL_CAP, hasAgentCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";

/** One account the queue reads, with the authority the SERVER reported. */
export interface ApprovalsAccount {
  accountId: string;
  /** The account's display name — what a row is labelled with. */
  name: string;
  /** Owned (true) vs reached through a grant (false). */
  isPersonal: boolean;
  /** `ActionProposal/set`: approve / decline / needsInfo / correct dueAt. */
  mayDecide: boolean;
  /** The tier-3 wall: approving an irreversible egress needs `send`. */
  mayApproveIrreversible: boolean;
}

/**
 * Every account whose proposals belong in this human's queue.
 *
 * Owned accounts sort first (yours before your agents'), then by name, so the
 * list is stable across reloads — the order a queue renders in must not depend
 * on object key order.
 *
 * The two authority flags come from the session's per-account agent capability
 * (`services/jmap/src/session.ts`), which computes them with the same
 * `authorizeAccount` call the method gate runs. ABSENT ⇒ `true`: an older
 * server does not report them, and the client's flags are a courtesy — the
 * server is the gate, and a UI that hid a button a server would have honoured
 * is its own kind of lie. Present-and-false is the honest hide.
 */
export function approvalsAccounts(
  session: Pick<Session, "capabilities" | "accounts">,
): ApprovalsAccount[] {
  if (!hasAgentCapability(session)) return [];
  const out: ApprovalsAccount[] = [];
  for (const [accountId, account] of Object.entries(session.accounts)) {
    const caps = account.accountCapabilities as Record<string, unknown> | undefined;
    if (!caps || !Object.prototype.hasOwnProperty.call(caps, AGENT_CAP)) continue;
    const agentCap = (caps[AGENT_CAP] ?? {}) as Record<string, unknown>;
    out.push({
      accountId,
      name: account.name || accountId,
      isPersonal: account.isPersonal,
      mayDecide: flag(agentCap.mayDecide),
      mayApproveIrreversible: flag(agentCap.mayApproveIrreversible),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.isPersonal) - Number(a.isPersonal) ||
      a.name.localeCompare(b.name) ||
      a.accountId.localeCompare(b.accountId),
  );
}

/** Unreported ⇒ true (see `approvalsAccounts`); anything else is read strictly. */
function flag(v: unknown): boolean {
  return v === undefined ? true : v === true;
}

/**
 * Which account the queue reads when only ONE will do — the home view's
 * decision surface and the pre-T7 anchor. The live session keys
 * `primaryAccounts` by the IETF capabilities only (session.ts — no agent
 * entry), so the mail primary is the honest anchor, with the first account as
 * the fallback a grant-only session gets.
 */
export function approvalsAccountId(session: Pick<Session, "primaryAccounts" | "accounts">): string {
  return session.primaryAccounts[MAIL_CAP] ?? Object.keys(session.accounts)[0] ?? "";
}

/** Account id → the row's label, for a merged queue. */
export function accountLabel(accounts: ApprovalsAccount[], accountId: string): string {
  return accounts.find((a) => a.accountId === accountId)?.name ?? accountId;
}

/**
 * What the row may OFFER, per proposal — the honesty rule of a merged queue:
 * *a proposal from an account you merely read must not offer a decide button
 * you cannot use.*
 *
 * Three states, and they are different sentences:
 *  - decidable            — the ordinary row, every verb live.
 *  - watch-only           — no `draft` on that account: the supervisory grant
 *                           (or the token) carries read alone. No verbs at all.
 *  - decidable-but-tier-3 — `draft` without `send`: decline and needsInfo are
 *                           real, approve is not, because the capability wall
 *                           would refuse it (actionProposal.ts). Hiding the
 *                           whole row would hide a question that is genuinely
 *                           waiting; hiding only approve is the truth.
 */
export interface RowAuthority {
  canApprove: boolean;
  canDecline: boolean;
  /** Non-empty exactly when something is withheld — render it verbatim. */
  note: string;
}

export function rowAuthority(
  proposal: { tier: number },
  account: Pick<ApprovalsAccount, "name" | "mayDecide" | "mayApproveIrreversible"> | undefined,
): RowAuthority {
  // An account the session did not list is not decidable by us — the server
  // would refuse, and pretending otherwise costs a round trip to find out.
  if (!account) {
    return {
      canApprove: false,
      canDecline: false,
      note: "This proposal is on an account this session cannot reach — nothing here can act on it.",
    };
  }
  if (!account.mayDecide) {
    return {
      canApprove: false,
      canDecline: false,
      note:
        `Watch-only: you can see ${account.name}'s proposals but not decide them. ` +
        "The grant that shares this account does not carry the deciding scope.",
    };
  }
  if (proposal.tier === 3 && !account.mayApproveIrreversible) {
    return {
      canApprove: false,
      canDecline: true,
      note:
        `Approving this would send as ${account.name}, and your access to that account does not ` +
        "carry the send capability — declining or asking for more information still works.",
    };
  }
  return { canApprove: true, canDecline: true, note: "" };
}
