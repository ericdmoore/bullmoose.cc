// Row presentation rules: what a tier MEANS at the approve button, how a
// payload summarizes into one line, and the capability gate the whole section
// hides behind. Pure, tested, and the reason the island can stay markup-only.

import { hasAgentCapability } from "../jmap/capabilities";
import type { Session } from "../jmap/types";

import type { ActionProposal, ProposalTier, RejectReason } from "./types";

// The queue's ACCOUNT rules live in `accounts.ts` (s10 T7) — which accounts it
// spans and what each one may decide. Re-exported here because every caller
// already imports this module for the row wording, and splitting the import
// would be churn without a boundary behind it.
export {
  accountLabel,
  approvalsAccountId,
  approvalsAccounts,
  rowAuthority,
  type ApprovalsAccount,
  type RowAuthority,
} from "./accounts";

// ── the gate ──────────────────────────────────────────────────────────────

export type ApprovalsGateState = "open" | "no-capability";

export interface ApprovalsGate {
  state: ApprovalsGateState;
  reason: string;
}

/**
 * The plain-client floor (s03-webAccess/arch.md §8.6), same shape as
 * `lib/console/gate.ts`: with `urn:bullmoose:params:jmap:agent` absent this
 * section is an explanation, not an error and not a dead region. Its own
 * function rather than a reuse of `consoleGate` because the wording is the
 * surface — "no agents to govern" and "no proposals to decide" are different
 * sentences.
 */
export function approvalsGate(session: Pick<Session, "capabilities"> | undefined): ApprovalsGate {
  if (!session) return { state: "no-capability", reason: "no session yet" };
  if (!hasAgentCapability(session)) {
    return {
      state: "no-capability",
      // Not an error string: a server without the capability is the supported
      // plain-client configuration, and nothing proposes work there.
      reason:
        "This server does not advertise the bullmoose agent capability, so no agent can " +
        "propose work and there is nothing to approve. Mail, contacts and calendar are unaffected.",
    };
  }
  return { state: "open", reason: "agent capability advertised" };
}

// ── tiers at the buttons ──────────────────────────────────────────────────

/** Short pill text — the reversibility claim, visible on every row. */
export function tierLabel(tier: ProposalTier): string {
  switch (tier) {
    case 1:
      return "tier 1 · reversible";
    case 2:
      return "tier 2 · retractable";
    case 3:
      return "tier 3 · irreversible";
  }
}

/**
 * What the approve button SAYS, which must match what approving DOES
 * (arch.md §2, actionProposal.ts:38-47):
 *   tier 1 — applied immediately, an undo handle is kept;
 *   tier 2 — enters the hold tray as `held`; NOTHING egresses, because
 *            committing out of the tray is s03.D T2 and is not built;
 *   tier 3 — the real thing, immediately: the server reuses the actual send
 *            gate, so the label must not soften it.
 */
export function approveVerb(tier: ProposalTier): string {
  switch (tier) {
    case 1:
      return "Approve — applies now, undoable";
    case 2:
      return "Approve — nothing sent yet; sends after a short hold (yankable)";
    case 3:
      return "Approve & send — irreversible";
  }
}

/** The fine print under a tier-3 row: where the guarantee actually lives. */
export const TIER3_CAPABILITY_NOTE =
  "Approving this calls the real send gate and requires your send capability — " +
  "an agent token is refused by the same check (actionProposal.ts:252-266), so " +
  "irreversible egress is a human click every time.";

/**
 * The hold tray's honest label, updated as s03.D T2 lands (2026-08-15).
 * COMMIT is wired: the agent cron sweeps held rows whose window has closed
 * and egresses them (`commitDueHeldProposals`), so a held reply now sends
 * within ~window + cron interval. YANK exists as an API verb
 * (`status: "yanked"`, held-only, window-open-only) but this UI has no
 * button for it yet — the note says so rather than hiding that the tray
 * has a working exit and a keyboard-only escape hatch.
 */
export const HOLD_UNWIRED_NOTE =
  "sends automatically when the hold window closes; yank via API — the button lands next";

// ── the no-thanks signal (arch.md §3) ─────────────────────────────────────

/**
 * The three reasons, in the order the decline panel offers them, mirroring the
 * server's enum exactly (actionProposal.ts `REJECT_REASONS`). A reason earns
 * its place only if it changes what the agent does next, so the hints say what
 * each one STEERS rather than how annoyed the human is (decline-taxonomy.md).
 *
 * `unsafe` is last and `severe`, and that is not a severity ranking of the
 * other two: it is a different KIND of judgment. wrongContent and wrongAction
 * are quality feedback — this was done badly, this should not have been done.
 * `unsafe` says a boundary was crossed (private information left the account, or
 * the agent committed the human to something), which is weighted heavily, is
 * never tolerated twice, and is not a stronger way of saying "no". The panel
 * words it as the hard stop it is so it is never the reflex click.
 *
 * `notNow` is gone (decline-taxonomy.md): it was a grab-bag — "I'll do it
 * myself", "not due yet" (now a `dueAt` correction, which records nothing) and
 * "meh, later". Rows decided under it still render; see `describeReason`.
 */
export const REJECT_REASONS: ReadonlyArray<{
  reason: RejectReason;
  label: string;
  hint: string;
  /** The categorically-separate hard negative — styled and worded apart. */
  severe?: boolean;
}> = [
  {
    reason: "wrongContent",
    label: "Wrong content",
    hint: "right action, badly done — trains the drafter, keeps the trigger",
  },
  {
    reason: "wrongAction",
    label: "Wrong action",
    hint: "should not have been proposed at all — trains the classifier; rare by design",
  },
  {
    reason: "unsafe",
    label: "Unsafe — it leaked private information, or committed me to something",
    hint: "a hard stop, not a stronger no: weighted heavily and never tolerated twice",
    severe: true,
  },
];

/**
 * Kinds whose DECLINE says nothing about the agent, mirroring the server's
 * `NO_FAULT_KINDS` (actionProposal.ts) — which REFUSES a reject reason on
 * them, so a client that insists on one makes the verb unreachable:
 *
 *   `budget-overrun`     declining says "not this month" — about the wallet.
 *   `held-mail-review`   declining says "yes, that is spam" — an ANSWER, and
 *                        the agent was right to ask.
 *
 * The panel drops the reason list for these rather than offering three
 * choices the server will reject. (Found while wiring s12: the decline button
 * required a reason for every kind, which made a `budget-overrun` impossible
 * to decline from this client at all.)
 */
export const NO_FAULT_KINDS: ReadonlySet<string> = new Set([
  "budget-overrun",
  "held-mail-review",
  // s20 T1↔T4 — declining a watch-offer says "no, not this thread", a
  // preference about your own follow-ups, never "you were wrong to notice I'm
  // waiting". No fault reaches the agent.
  "watch-offer",
]);

/** Whether the decline panel must collect a reason before it can submit. */
export function declineNeedsReason(kind: string): boolean {
  return !NO_FAULT_KINDS.has(kind);
}

/**
 * Reasons the server once accepted and no longer does. Recorded decisions are
 * NOT migrated — a human's decision is a fact, and rewriting one to fit a later
 * taxonomy would be an audit hole — so the queue must still render them.
 */
export const RETIRED_REJECT_REASONS: ReadonlySet<string> = new Set(["notNow"]);

/**
 * How a RECORDED reason renders. Tolerant by construction: history is read, not
 * validated, so this never throws and never remaps.
 *
 *   a live reason    → its panel label ("Wrong content")
 *   a retired one    → itself, marked: "notNow (retired)"
 *   anything else    → itself, verbatim
 *
 * Showing a retired reason as itself is the point: "notNow" silently becoming
 * "Wrong action" would put a judgment in the human's mouth they never made, and
 * dropping it would erase why a proposal was declined.
 */
export function describeReason(reason: string): string {
  const known = REJECT_REASONS.find((r) => r.reason === reason);
  if (known) return known.label;
  if (RETIRED_REJECT_REASONS.has(reason)) return `${reason} (retired)`;
  return reason;
}

// ── one-line summaries ────────────────────────────────────────────────────

/**
 * The row's headline: what the agent wants to do, from the payload it wants
 * to do it with. `grant-request` renders through the same function because it
 * shares the queue (arch.md §1) — an agent asking for a permission and an
 * agent proposing a reply are the same interaction, so there is deliberately
 * no separate surface and no separate summarizer.
 */
export function summarizeProposal(p: ActionProposal): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (p.kind) {
    case "reply-draft":
      return `Reply to ${s(p.payload.to) || "(unknown recipient)"} — “${s(p.payload.subject)}”`;
    case "start-thread":
      return `Start a thread to ${s(p.payload.to) || "(unknown recipient)"} — “${s(p.payload.subject)}”`;
    case "create-contact": {
      const card = (p.payload.card ?? {}) as { name?: { full?: unknown } };
      return `Add contact ${s(card.name?.full) || "(unnamed)"}`;
    }
    case "create-event":
      return `Create event “${s(p.payload.title)}”`;
    case "watch-followup":
      // s20 T1 — a watch fired because someone did not reply in time.
      return `Follow up with ${s(p.payload.to) || "(unknown)"} — a watch you set came due`;
    case "watch-notify":
      return `Reminder — a watch you set came due`;
    case "unsubscribe":
      return `Unsubscribe from ${s(p.payload.listName) || s(p.payload.to) || p.subject.objectId}`;
    case "organize-files":
      return `Organize files under ${s(p.payload.target) || p.subject.objectId}`;
    case "budget-overrun": {
      // s11 T9 — LEAD WITH THE NUMBERS. This proposal is not a persuasion
      // surface: the whole decision is "how much is waiting, how much has been
      // spent, how much would it cost", so the row states those before it names
      // anything. An unknown estimate says "cost unknown" rather than a
      // plausible-looking zero — the agent has no paid history for this binding
      // and a guessed dollar figure would be the one lie that matters here.
      const n = num(p.payload.waitingCount);
      const spent = usdOrNull(p.payload.monthSpentMicros);
      const cap = usdOrNull(p.payload.capMicros);
      const clear = usdOrNull(p.payload.estimateMicros);
      const bound = usdOrNull(p.payload.overageMicros);
      const who = s(p.payload.bindingName) || s(p.payload.bindingId) || p.subject.objectId;
      const spend = spent && cap ? `${spent} of ${cap} spent` : "budget spent";
      return (
        `${n ?? "?"} waiting · ${spend} · ${clear ? `~${clear} to clear` : "cost unknown"}` +
        ` — approve ${bound ? `a ${bound}` : "an"} overage for ${who}`
      );
    }
    case "held-mail-review": {
      // s12 — LEAD WITH THE COUNT and name the verbs, because both are real
      // here: approve releases, decline confirms, and neither is a no-op. The
      // senders are the evidence a human actually decides on, so the row shows
      // the first couple rather than making them open the payload.
      const n =
        num(p.payload.heldCount) ??
        (Array.isArray(p.payload.emailIds) ? p.payload.emailIds.length : null);
      const msgs = Array.isArray(p.payload.messages)
        ? (p.payload.messages as Array<{ sender?: unknown }>)
        : [];
      const who = [...new Set(msgs.map((m) => s(m.sender)).filter(Boolean))];
      const from =
        who.length > 0
          ? ` from ${who.slice(0, 2).join(", ")}${who.length > 2 ? ` +${who.length - 2}` : ""}`
          : "";
      return `${n ?? "?"} held message${n === 1 ? "" : "s"}${from} — approve releases, decline confirms spam`;
    }
    case "watch-offer": {
      // s20 T1↔T4 — the anti-star. The agent noticed a question you sent that
      // went unanswered and offers to watch it. Lead with WHO and HOW LONG,
      // because that is the whole decision; approving arms a no-reply-from
      // Watch that closes itself if the reply lands first.
      const who = s(p.payload.to) || "(unknown recipient)";
      const about = s(p.payload.sentSubject);
      return `Waiting on ${who}${about ? ` — “${about}”` : ""} — watch & follow up?`;
    }
    case "grant-request": {
      // The allowlist widening (s10 T3): grantType "recipient" is "let me
      // email <address>" — approving APPLIES a contact write into the
      // governing book, so the summary must say who, not just what.
      if (s(p.payload.grantType) === "recipient") {
        const who = s(p.payload.address) || "(unknown address)";
        return `Asks to email ${who} — widens its allowlist`;
      }
      const scope = s(p.payload.scope) || "access";
      const target = s(p.payload.target) || s(p.payload.realm) || p.subject.realm;
      const days =
        typeof p.payload.durationDays === "number" ? ` for ${p.payload.durationDays} days` : "";
      return `Requests ${scope} on ${target}${days}`;
    }
    default:
      return `${p.kind} on ${p.subject.realm} ${p.subject.objectId}`;
  }
}

/** A payload number, or null when the field is absent or not a finite number.
 * Absent is not zero — every reader here has to be able to say "unknown". */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * micro-USD → "$1.23", or null when there is no honest number to print.
 * micro-USD is the unit the whole budget path speaks (`cost_micros`,
 * `spendPerMonth`, `amount_micros`); converting at the render edge keeps the
 * integer money integral everywhere it is compared.
 */
export function usdOrNull(v: unknown): string | null {
  const n = num(v);
  return n === null ? null : `$${(n / 1_000_000).toFixed(2)}`;
}

/** The body preview a reply-shaped payload carries, if any. */
export function payloadText(payload: Record<string, unknown>): string | null {
  return typeof payload.text === "string" && payload.text.length > 0 ? payload.text : null;
}
