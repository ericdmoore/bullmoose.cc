// s20 T3 — turning "Sergio" into an address, in front of the person, with the
// evidence attached.
//
// This is the inference T3 exists to make honest. Every other guess the
// composer makes is a wording the human reads before they send; a RECIPIENT is
// the one that can put the right words in front of the wrong person. So the
// rule this module implements is not "pick the best match" — it is:
//
//   • rank candidates from the two places that actually know: the address book
//     and the mail you have already exchanged;
//   • say WHY each one is here, in words ("in your address book · 14 messages
//     between you"), because a ranking nobody can audit is a ranking nobody
//     should trust;
//   • when the lead is not clear, refuse to choose. `ambiguous` is a first
//     class outcome and the composer will not send an ask that carries it.
//     `bring-in` (s20 T2) refuses to resolve a name at all for this reason;
//     T3 goes one step further and resolves it WHERE THE HUMAN CAN SEE, which
//     is the only version of this that is allowed to exist.
//
// Pure functions over already-fetched material (`lookup.ts` does the reading),
// so the rule is testable as a rule.

/** How an address the ask carries was arrived at. Mirrored server-side by
 *  `RECIPIENT_VIA` in `services/agent/src/mailVerbs.ts`, so the approval row
 *  can repeat it. */
export type RecipientVia = "typed" | "address-book" | "history" | "address-book+history";

/** One address book hit. */
export interface CardSighting {
  email: string;
  name: string | null;
}

/** One address seen on one message you and they exchanged. */
export interface HistorySighting {
  email: string;
  name: string | null;
  /** The message it was seen on — the newest becomes the ask's background. */
  emailId: string;
  /** Epoch ms. */
  at: number;
}

export interface RecipientCandidate {
  email: string;
  name: string | null;
  via: Exclude<RecipientVia, "typed">;
  /** How many messages between you this lookup saw. Its window, not all time. */
  messages: number;
  lastAt: number | null;
  /** The most recent message involving them, offered to the agent as
   *  background. Null when the address book is the only thing that knows them. */
  anchorEmailId: string | null;
  score: number;
  /** Why this candidate is here, in words the composer shows verbatim. */
  evidence: string;
}

export type ResolutionStatus =
  /** The sentence named nobody. */
  | "none"
  /** The sentence carried an address; there is nothing to resolve. */
  | "address"
  /** One candidate, or one with a clear lead. */
  | "resolved"
  /** Two or more, too close to call. The composer must ask. */
  | "ambiguous"
  /** Nobody by that name in the address book or in your mail. */
  | "unknown";

export interface Resolution {
  status: ResolutionStatus;
  query: string | null;
  chosen: RecipientCandidate | null;
  candidates: RecipientCandidate[];
  /** The sentence shown under the recipient row. */
  message: string;
}

/**
 * How far ahead the top candidate must be to be called a resolution rather
 * than a coin toss. One whole point is roughly "one of them is in your address
 * book and the other is not", or "one of them you write to weekly and the
 * other you mailed once a year ago" — a gap a person would also call obvious.
 * Below it, the composer asks. Cheap to ask, expensive to be confidently
 * wrong.
 */
export const CLEAR_LEAD = 1;

const DAY = 86_400_000;

/** Is this a thing we could actually address a draft to? (verbs/contract.ts's
 *  `isAddress`, kept here so this module stays free of UI imports.) */
export function looksLikeAddress(value: string): boolean {
  const s = value.trim();
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}

function localPart(email: string): string {
  return email.split("@")[0] ?? email;
}

/** Does this sighting plausibly BE the person named? Loose on purpose — the
 *  cost of a spurious candidate is a visible extra chip, and the cost of a
 *  missing one is the human retyping an address they have used for years. */
export function nameMatches(query: string, name: string | null, email: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (looksLikeAddress(q)) return email.toLowerCase() === q;
  const haystacks = [
    name?.toLowerCase() ?? "",
    localPart(email)
      .toLowerCase()
      .replace(/[._-]+/g, " "),
  ];
  return haystacks.some((h) => h.split(/\s+/).some((word) => word.startsWith(q)) || h.includes(q));
}

interface Bucket {
  email: string;
  name: string | null;
  inBook: boolean;
  messages: number;
  lastAt: number | null;
  anchorEmailId: string | null;
}

/**
 * Rank the candidates for one name. Deterministic, and every term is one a
 * person would give out loud: the address book is the strongest single signal,
 * how much you write to someone is the next, and how recently breaks the tie.
 */
export function rankRecipients(
  query: string,
  cards: readonly CardSighting[],
  history: readonly HistorySighting[],
  opts: { now?: number; exclude?: readonly string[] } = {},
): RecipientCandidate[] {
  const now = opts.now ?? Date.now();
  const excluded = new Set((opts.exclude ?? []).map((e) => e.toLowerCase()));
  const buckets = new Map<string, Bucket>();

  const bucket = (email: string, name: string | null): Bucket | null => {
    const key = email.trim().toLowerCase();
    if (!key || !looksLikeAddress(key) || excluded.has(key)) return null;
    const found = buckets.get(key);
    if (found) {
      if (!found.name && name) found.name = name;
      return found;
    }
    const made: Bucket = {
      email: key,
      name: name ?? null,
      inBook: false,
      messages: 0,
      lastAt: null,
      anchorEmailId: null,
    };
    buckets.set(key, made);
    return made;
  };

  for (const card of cards) {
    // The server already matched these against the query across names,
    // nicknames, organizations and addresses — a card hit is a card hit.
    const b = bucket(card.email, card.name);
    if (b) b.inBook = true;
  }
  for (const seen of history) {
    // Mail is matched by full text, so a message that merely MENTIONS Sergio
    // comes back too. Its sender is not a candidate — only an address whose
    // own name or local part matches is.
    if (!nameMatches(query, seen.name, seen.email)) continue;
    const b = bucket(seen.email, seen.name);
    if (!b) continue;
    b.messages += 1;
    if (b.lastAt === null || seen.at > b.lastAt) {
      b.lastAt = seen.at;
      b.anchorEmailId = seen.emailId;
    }
  }

  const q = query.trim().toLowerCase();
  const out: RecipientCandidate[] = [];
  for (const b of buckets.values()) {
    let score = 0;
    if (b.inBook) score += 3;
    if ((b.name ?? "").toLowerCase() === q || localPart(b.email).toLowerCase() === q) score += 1.5;
    else if ((b.name ?? "").toLowerCase().startsWith(q) || localPart(b.email).toLowerCase().startsWith(q))
      score += 0.75;
    score += (Math.min(b.messages, 10) / 10) * 2;
    if (b.lastAt !== null) {
      const age = now - b.lastAt;
      if (age <= 30 * DAY) score += 1;
      else if (age <= 90 * DAY) score += 0.5;
      else if (age <= 365 * DAY) score += 0.25;
    }
    if (score === 0) continue;
    const via: Exclude<RecipientVia, "typed"> =
      b.inBook && b.messages > 0 ? "address-book+history" : b.inBook ? "address-book" : "history";
    out.push({
      email: b.email,
      name: b.name,
      via,
      messages: b.messages,
      lastAt: b.lastAt,
      anchorEmailId: b.anchorEmailId,
      score: Math.round(score * 100) / 100,
      evidence: describeEvidence(b.inBook, b.messages, b.lastAt),
    });
  }
  // Score first, then message count, then address — the last is arbitrary but
  // STABLE, so the same lookup never reorders itself between keystrokes.
  return out.sort((a, b) => b.score - a.score || b.messages - a.messages || a.email.localeCompare(b.email));
}

/** Why a candidate is on the list, in words. */
export function describeEvidence(inBook: boolean, messages: number, lastAt: number | null): string {
  const parts: string[] = [];
  if (inBook) parts.push("in your address book");
  if (messages > 0) {
    const when =
      lastAt === null
        ? ""
        : `, most recently ${new Date(lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    parts.push(`${messages} message${messages === 1 ? "" : "s"} between you${when}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no history to go on";
}

/**
 * The whole rule, in one call: rank, then decide whether that is a resolution
 * or a question. The `ambiguous` branch is the point of the module — it hands
 * back candidates and NO choice, and the composer refuses to send until a
 * person makes one.
 */
export function resolveRecipient(
  query: string | null,
  cards: readonly CardSighting[],
  history: readonly HistorySighting[],
  opts: { now?: number; exclude?: readonly string[] } = {},
): Resolution {
  const q = (query ?? "").trim();
  if (!q) {
    return { status: "none", query: null, chosen: null, candidates: [], message: "Who is this going to?" };
  }
  if (looksLikeAddress(q)) {
    return {
      status: "address",
      query: q,
      chosen: null,
      candidates: [],
      message: "Using the address you typed.",
    };
  }

  const candidates = rankRecipients(q, cards, history, opts);
  if (candidates.length === 0) {
    return {
      status: "unknown",
      query: q,
      chosen: null,
      candidates,
      message: `I could not find “${q}” in your address book or your mail. Type their address and I will use it.`,
    };
  }

  const top = candidates[0]!;
  const second = candidates[1];
  if (!second || top.score - second.score >= CLEAR_LEAD) {
    return {
      status: "resolved",
      query: q,
      chosen: top,
      candidates,
      message: `${q} → ${top.email} — ${top.evidence}. Change it if I have the wrong one.`,
    };
  }
  return {
    status: "ambiguous",
    query: q,
    chosen: null,
    candidates,
    message: `${candidates.length} people match “${q}” and none of them clearly. Pick the one you meant — I will not choose for you.`,
  };
}

/** The recipient an ask will actually carry, and its provenance. */
export interface ChosenRecipient {
  to: string;
  via: RecipientVia;
  anchorEmailId?: string;
}

/**
 * WHO the ask goes to, in precedence order — and the one case that yields
 * nothing at all.
 *
 *   1. an address the human picked or typed. Theirs beats every inference,
 *      and if it happens to BE one of the ranked candidates it keeps that
 *      candidate's provenance and background: agreeing with your address book
 *      is not the same as typing an address out of nowhere.
 *   2. an address written into the sentence itself — already resolved, by a
 *      person, before we were asked.
 *   3. a resolution with a clear lead.
 *   4. …and otherwise NULL. `ambiguous` deliberately contributes nothing:
 *      that null is what disables the composer's ask button, and it is the
 *      whole of "never silently pick the top match" expressed as code.
 */
export function chooseRecipient(
  plan: { who: string | null; whoIsAddress: boolean },
  resolution: Resolution,
  picked: string | null,
): ChosenRecipient | null {
  const fromCandidates = (address: string, fallback: RecipientVia): ChosenRecipient => {
    const hit = resolution.candidates.find((c) => c.email === address.toLowerCase());
    return {
      to: address,
      via: hit ? hit.via : fallback,
      ...(hit?.anchorEmailId ? { anchorEmailId: hit.anchorEmailId } : {}),
    };
  };

  if (picked && looksLikeAddress(picked)) return fromCandidates(picked.trim(), "typed");
  if (plan.whoIsAddress && plan.who) return fromCandidates(plan.who, "typed");
  if (resolution.status === "resolved" && resolution.chosen) {
    return {
      to: resolution.chosen.email,
      via: resolution.chosen.via,
      ...(resolution.chosen.anchorEmailId ? { anchorEmailId: resolution.chosen.anchorEmailId } : {}),
    };
  }
  return null;
}
