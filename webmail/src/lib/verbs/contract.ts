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
 * `create` requires a bindingId or bindingName, so the door asks the account
 * which bindings it has and uses one that is enabled.
 *
 * v1 named `extractor` by convention, because no method listed an account's
 * bindings. `AgentBinding/get` (s26, #206) is that method, so the convention
 * is retired: `pickVerbBinding` below reads the roster and chooses. The
 * preference order is not arbitrary — an account may run several bindings,
 * and the one whose job is cheap per-message model calls is the right host
 * for a verb, which is what `extractor` was always a proxy for.
 *
 * When the roster is empty (or every binding is disabled) the bar says so in
 * a sentence — no verbs, no guessing, no throw. That refusal is still the
 * honest degradation; it is just now told the truth by the server instead of
 * inferred from one missing name.
 */

/** The binding a verb prefers, by name, when an account runs more than one.
 *  Anything enabled will serve; this only decides who goes first. */
export const VERB_BINDING_PREFERENCE = ["extractor"] as const;

/** Pick the binding a verb should run on, or `undefined` when none can.
 *  Pure over the `AgentBinding/get` projection so it is testable without a
 *  client: disabled bindings are never chosen (a disabled binding is inert by
 *  contract — #199), preferred names win, and otherwise the first enabled one
 *  in the server's own order is taken rather than a name we invented. */
export function pickVerbBinding<T extends { id: string; name: string; enabled: boolean }>(
  bindings: readonly T[],
): T | undefined {
  const live = bindings.filter((b) => b.enabled);
  for (const preferred of VERB_BINDING_PREFERENCE) {
    const hit = live.find((b) => b.name === preferred);
    if (hit) return hit;
  }
  return live[0];
}

/** The verbs that compile to an agent invocation. Watch does not: it arms
 *  through `Watch/set`, the CRUD s20 T1 already shipped.
 *
 *  `compose` (s20 T3) is the composer's intent mode — the only one of the
 *  four that acts on no message at all, which is why its invocation carries
 *  no `emailId` unless the lookup found background worth naming.
 *
 *  `schedule` (s20 wave 6) is #202's deferral, closed: it reads the message in
 *  front of you and proposes a HOLD on your own calendar. It was held back
 *  because `applyProposal` had no case to land an approval in; it has one now
 *  (`verb-schedule`, services/jmap actionProposal.ts), so the button exists. */
export type AgentVerb = "answer" | "bring-in" | "compose" | "schedule";

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
  if (verb === "answer") return "Asked. The draft reply will appear in your approvals when it is written.";
  if (verb === "compose") return composeAskedMessage(person ?? "them");
  if (verb === "schedule") return scheduleAskedMessage();
  return `Asked. A draft bringing ${person ?? "them"} in will appear in your approvals when it is written.`;
}

/**
 * What the message view says once a Schedule ask has been sent.
 *
 * Three facts, and the last two are the ones a calendar verb must never leave
 * a person guessing about: where the answer will appear, that approving is
 * what puts anything anywhere, and that NOBODY IS INVITED — a hold reaches
 * your own calendar and stops there. It also says "a hold", never "your
 * meeting": the agent may well come back having found no time at all, and a
 * sentence that promised a meeting would have promised the one thing this
 * verb refuses to manufacture.
 */
export function scheduleAskedMessage(): string {
  return (
    "Asked. A proposed hold will appear in your approvals when it is written — you approve it onto your own " +
    "calendar, and nobody is invited."
  );
}

/**
 * What the composer says once an intent has been sent (s20 T3).
 *
 * Three facts, and the third is the one that must never be dropped: where the
 * draft will appear, who it is to, and that NOTHING has been sent. T3 ends at
 * an editable draft by construction — approval writes into your own Drafts and
 * your own composer does the sending — so the sentence says so out loud rather
 * than leaving a person to wonder what they just set in motion.
 */
export function composeAskedMessage(to: string): string {
  return (
    `Asked. A draft to ${to} will appear in your approvals when it is written — ` +
    "you edit it there, and nothing is sent until you send it."
  );
}
