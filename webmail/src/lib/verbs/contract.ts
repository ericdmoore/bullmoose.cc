// s20 T2 — the verbs' pure half: who a verb acts on, what contract a Watch
// arms with, and the sentences the message view says about it. Everything here
// is a function of its arguments, so the component stays markup and the rules
// are tested as rules (the lib/approvals split, applied again).
//
// The verbs beside Reply/Forward are the human ASKING, in place, on the
// message they are reading — the other direction from every agent surface
// shipped so far, which notices things AT you on a sweep. Reply, Reply all and
// Forward are untouched beside them: prose is the escape hatch and the
// precision tool, and removing it would be ideology (s20 T2).

import type { Email, EmailAddress } from "../mail/types";

/**
 * The binding an `AgentInvocation/set` create names for a verb.
 *
 * `create` requires a bindingId or bindingName, and there is no JMAP method
 * that LISTS an account's bindings (`AgentBinding` has only `/set`; the roster
 * lives behind the owner-only console projection, which a thread view has no
 * business fetching). So the door names the one binding an opted-in account
 * reliably has: `extractor`, provisioned per-account by `POST /extractor`,
 * whose whole job is cheap per-message model calls. It is the SAME binding
 * `watchCompose.resolveComposeBinding` falls back to on the server, for the
 * same reason.
 *
 * When it is absent the server answers `notFound` and the bar says so in a
 * sentence — no verbs, no guessing, no throw. That refusal is the honest
 * degradation, and closing it properly means a binding-list read, which is
 * named as follow-up work rather than smuggled in here.
 */
export const VERB_BINDING_NAME = "extractor";

/** The verbs that compile to an agent invocation. Watch does not: it arms
 *  through `Watch/set`, the CRUD s20 T1 already shipped. */
export type AgentVerb = "answer" | "bring-in";

/**
 * The default Watch contract a bare "watch this" arms (s20 T1, decision 1):
 * reply-by +4 business days → draft a follow-up. A draft in the queue costs
 * nothing, and a watch that fires into a proposal is reversible by
 * construction — nothing egresses until a human approves the draft it
 * produces.
 */
export const WATCH_BUSINESS_DAYS = 4;

/** Skip Saturdays and Sundays. Holidays are not modelled — a follow-up
 *  reminder that lands a day early is a smaller wrong than a calendar this
 *  codebase would then have to keep. */
export function addBusinessDays(from: number, days: number): number {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
}

/** Is this something we can actually address a draft to? */
export function isAddress(value: string): boolean {
  const s = value.trim();
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}

/**
 * Who a verb acts on: the message's sender, falling back to its first
 * recipient for a message you sent.
 *
 * Honest about its limits — the thread view has no identity list, so it cannot
 * tell "from me" from "from them" and does not pretend to. What it can do is
 * NAME the address it resolved, everywhere it matters (the button's title, the
 * confirmation sentence), so a wrong guess is visible before it is armed
 * rather than after.
 */
export function verbCounterparty(email: Pick<Email, "from" | "to">): string | null {
  const pick = (list: EmailAddress[] | undefined): string | null => {
    const hit = (list ?? []).find((a) => typeof a.email === "string" && a.email.includes("@"));
    return hit ? hit.email : null;
  };
  return pick(email.from) ?? pick(email.to);
}

/** The `Watch/set` create spec for "watch this message". */
export interface WatchSpec {
  conditionType: "no-reply-from";
  condition: { sender: string; threadId: string };
  deadlineAt: number;
  actionType: "draft-followup";
  action: { to: string };
  sourceRef: string;
}

/**
 * Compile "watch this" into the contract. `no-reply-from` is the condition
 * that makes the feature trustworthy rather than noisy: being ANSWERED is
 * silence — a reply arriving before the deadline expires the watch clean, with
 * no follow-up and no ping (s20 T1).
 */
export function watchSpecFor(email: Pick<Email, "id" | "threadId" | "from" | "to">, now: number): WatchSpec | null {
  const sender = verbCounterparty(email);
  if (!sender) return null;
  return {
    conditionType: "no-reply-from",
    condition: { sender, threadId: email.threadId },
    deadlineAt: addBusinessDays(now, WATCH_BUSINESS_DAYS),
    actionType: "draft-followup",
    action: { to: sender },
    sourceRef: email.id,
  };
}

/** The sentence shown once a watch is armed. Names the person and the date —
 *  a contract you cannot read is a contract you cannot trust. */
export function watchArmedMessage(spec: WatchSpec): string {
  const when = new Date(spec.deadlineAt).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return (
    `Watching for a reply from ${spec.condition.sender}. If none arrives by ${when}, ` +
    `a follow-up draft goes to your approvals — and if they reply first, the watch closes quietly.`
  );
}

/** What the message view says while an ask is in flight, and after it lands. */
export function askSentMessage(verb: AgentVerb, person?: string): string {
  return verb === "answer"
    ? "Asked. The draft reply will appear in your approvals when it is written."
    : `Asked. A draft bringing ${person ?? "them"} in will appear in your approvals when it is written.`;
}
