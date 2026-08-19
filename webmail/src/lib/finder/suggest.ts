// Agent-directed refinement (s20 T5b) — the seam #197 marked in `run.ts` and
// `FinderApp.tsx`, filled in.
//
// The feature, in one sentence: **the human types a question in plain
// language, and the agent OFFERS refinement chips — never answers, never
// applied.** "You probably mean these three months." "From Sergio, not
// Sergio's assistant." The human accepts one, or ignores the whole strip and
// nothing whatsoever changes.
//
// ## Why this is a direct suggestion and not an invocation → proposal
//
// The marker said "another invocation → proposal, or a direct suggestion".
// Three arguments decided it, in order of weight:
//
//  1. **A chip is not an act.** Every kind in `applyProposal` writes a row:
//     a draft, a contact, a calendar hold, a grant. That is what the approvals
//     queue MEANS — "this will change the world unless you stop it". A
//     refinement writes nothing; accepting one re-runs a query the human could
//     have typed themselves. Putting non-acts in that queue teaches people
//     that queue items are cheap, which is the one lesson the whole product
//     cannot afford to teach.
//  2. **The click IS the approval.** The anti-star principle wants an offer a
//     human accepts or ignores — and a chip in a strip, applied only on click,
//     removable afterwards like every other chip, is exactly that shape. The
//     agent's chip goes through the SAME `refine()` the human's own RefineBar
//     calls, so once applied the two are indistinguishable and equally
//     removable. That is the strongest available statement that the agent has
//     no privileged path into your search.
//  3. **Latency, decisively.** The invocation drain is a five-minute cron
//     (`services/agent/wrangler.jsonc`). A refinement that arrives five
//     minutes after the question is not a refinement, it is a memo — and
//     making the Finder poll for one is the "spinner that doesn't end" the
//     brief forbids. A find loop is interactive or it is not a loop.
//
// So there is no model call here, and therefore no binding, no budget and no
// spend. That is not a degraded version of the feature; the degradation clause
// ("no binding / no budget / model failure → the Finder works exactly as it
// does today") is satisfied by construction, because the suggester cannot
// reach a model to have one fail. What it CAN do, a model could not promise:
// every hit-derived offer narrows to a **non-empty subset of what is already
// on your screen**, because it is computed FROM that screen.
//
// The seam stays open and is now a real one rather than a comment: this module
// is pure over `(session, hits)`, so an agent-authored list — from the MCP
// tool layer, when the T5 "Ask" endgame gives it a synchronous door — merges
// in at the same call site with the same `FinderSuggestion` shape and the same
// offer-not-apply rule.
//
// ## What is never done here
//
//  • nothing is auto-applied — `FinderApp` calls `applySuggestion` on click
//    and at no other time. A Finder that silently narrows your search is
//    worse than one that does nothing;
//  • nothing is stored, dismissed or remembered. There is no "don't show me
//    this again" toggle, because that is a star by another name: the offers
//    recompute from the current result and vanish when they stop applying;
//  • nothing throws. Junk in the query, a hit with no sender, an unparseable
//    date — all produce fewer offers, never an error.

import { monthLabel, monthWindow } from "./dateGroups";
import type { FinderHit } from "./run";
import { chipLabel, refine, type FinderRefinement, type FinderSession } from "./session";

/** One OFFER. Not a decision, not an answer — a chip the human may take. */
export interface FinderSuggestion {
  /** Stable within a render, for keys and tests. */
  id: string;
  /** The chip that would be added. Ordinary — `refine()` takes it verbatim. */
  refinement: FinderRefinement;
  /**
   * When present, accepting ALSO rewrites the session's free text: the words
   * this chip stands in for come out of the query.
   *
   * This is the half that makes a plain-language question work at all. "What
   * did Sergio say about the elk permit" run as full text matches messages
   * containing the literal word "sergio" in their BODY; what the person meant
   * is the sender. Reading it that way is a real reinterpretation of their
   * input, so it is offered in full — with the reason saying what it will do
   * — and never performed behind their back.
   */
  query?: string;
  /** Why, in the human's own terms. Rendered beside the chip, always. */
  reason: string;
  /**
   * True when this offer was derived from the results already on screen, and
   * therefore CANNOT empty them. False for the ones read out of the question
   * text, which re-run what you typed under a different reading. The UI does
   * not currently distinguish the two; the field exists because the guarantee
   * is real and worth being able to assert.
   */
  fromResults: boolean;
}

/** How many offers a strip may carry. A strip, not a second search UI: past
 *  three, "you might mean" stops being a suggestion and becomes a menu. */
export const MAX_SUGGESTIONS = 3;

/** A month must hold at least this share of the page before it is worth
 *  offering as "you probably mean this window". Below it, the results are
 *  spread and narrowing by date is the human's call, not a suggestion. */
const MONTH_SHARE = 0.4;

/** …and a contiguous run of months has a lower bar, because "these three
 *  months" is a much weaker claim than "this one month". */
const RUN_SHARE = 0.7;
const MAX_RUN_MONTHS = 3;

/** A sender must hold at least this share before it is offered on volume
 *  alone. A name collision (below) bypasses it: two Sergios is worth saying
 *  even when neither dominates. */
const SENDER_SHARE = 0.25;

/**
 * The whole feature. Pure, synchronous, total — for any session and any hits
 * it returns a (possibly empty) list, and it never throws.
 *
 * Order is deliberate: what the human SAID outranks what their corpus IS. A
 * question that literally contains "from sergio" gets the sender offer first,
 * because that is a reading of their sentence rather than an observation about
 * their mail.
 */
export function suggestRefinements(session: FinderSession, hits: readonly FinderHit[]): FinderSuggestion[] {
  const offers = [...fromQuestion(session), ...fromResults(hits)];

  const seen = new Set<string>();
  const kept: FinderSuggestion[] = [];
  for (const offer of offers) {
    // Never offer a chip the chain already carries verbatim — accepting it
    // would be a no-op, and an offer that does nothing is noise. (A DIFFERENT
    // value of the same kind is legitimate: same-kind chips replace, which is
    // "move the window", and moving it is a real suggestion.)
    if (session.refinements.some((r) => sameRefinement(r, offer.refinement))) continue;
    const key = `${offer.refinement.kind}:${chipLabel(offer.refinement)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(offer);
    if (kept.length === MAX_SUGGESTIONS) break;
  }
  return kept;
}

/**
 * Accept one offer. The ONLY way a suggestion reaches a session, and it is
 * called from a click handler and nowhere else.
 *
 * It goes through the same `refine()` the human's own RefineBar calls, so an
 * accepted suggestion is an ordinary chip: same replace-by-kind semantics,
 * same removal button, same place in the chain. There is no such thing as an
 * "agent chip" once it lands, which is the point.
 */
export function applySuggestion(session: FinderSession, offer: FinderSuggestion): FinderSession {
  const base = offer.query === undefined ? session : { ...session, query: offer.query.trim() };
  return refine(base, offer.refinement);
}

/** The strip's own one-liner. Rendered above the offers, every time, because
 *  the thing a person most needs to know about an agent suggestion is that
 *  ignoring it is free. */
export const SUGGEST_NOTE = "Suggestions — take one or ignore them; nothing is applied until you click.";

// ── read out of the question ──────────────────────────────────────────────

/** "from sergio", "from sergio@example.com" — the word, then who. */
const FROM_RE = /\bfrom\s+([\w][\w.'+-]*(?:@[\w.-]+)?)/i;
const TO_RE = /\bto\s+([\w][\w.'+-]*(?:@[\w.-]+)?)/i;
const ATTACHMENT_RE = /\b(attached|attachment|attachments)\b/i;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE = new RegExp(
  `\\b(?:in\\s+)?(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|")})\\.?(?:\\s+(\\d{4}))?\\b`,
  "i",
);

/**
 * Words in the question that name a FACET rather than content. Each becomes
 * an offer that both adds the chip and lifts its own words out of the free
 * text — the reinterpretation stated in full, for the human to take or leave.
 *
 * Deliberately narrow. "Last summer" and "a while back" are not here and will
 * not be: turning a vague phrase into a concrete date range is inventing a
 * bound the person did not state, and a wrong bound that LOOKS authoritative
 * is worse than no suggestion at all. Month names and years are what someone
 * actually wrote down.
 */
function fromQuestion(session: FinderSession): FinderSuggestion[] {
  const q = session.query.trim();
  if (q === "") return [];
  const out: FinderSuggestion[] = [];

  const address = (re: RegExp, kind: "from" | "to"): void => {
    const m = q.match(re);
    const who = m?.[1];
    // A bare "from" with nothing after it, or a stop-word, is not a name.
    if (!m || !who || who.length < 2 || STOPWORDS.has(who.toLowerCase())) return;
    out.push({
      id: `q-${kind}-${who.toLowerCase()}`,
      refinement: { kind, value: who },
      query: strip(q, m[0]),
      reason: `You wrote “${m[0]}” — I can match the ${kind === "from" ? "sender" : "recipient"} instead of the words.`,
      fromResults: false,
    });
  };
  address(FROM_RE, "from");
  address(TO_RE, "to");

  const month = q.match(MONTH_RE);
  if (month?.[1]) {
    const index = MONTHS.findIndex((name) => name.startsWith(month[1]!.toLowerCase()));
    const year = month[2] ? Number(month[2]) : null;
    // A month with no year is ambiguous across every year you have mail in,
    // and picking one would be exactly the invention this module refuses. So
    // the offer only stands when the person wrote the year down.
    if (index >= 0 && year !== null && year > 1970 && year < 3000) {
      out.push({
        id: `q-window-${year}-${index + 1}`,
        refinement: { kind: "window", label: monthLabel(year, index + 1), ...monthWindow(year, index + 1) },
        query: strip(q, month[0]),
        reason: `You wrote “${month[0].trim()}” — I can narrow to that month instead of matching the words.`,
        fromResults: false,
      });
    }
  }

  const attached = q.match(ATTACHMENT_RE);
  if (attached) {
    out.push({
      id: "q-attachment",
      refinement: { kind: "attachment" },
      query: strip(q, attached[0]),
      reason: `You wrote “${attached[0]}” — I can keep only the messages that actually carry a file.`,
      fromResults: false,
    });
  }
  return out;
}

/** Words that are never a person, so "from the printer" does not become a
 *  sender chip. Short and boring on purpose. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "me",
  "my",
  "us",
  "them",
  "him",
  "her",
  "it",
  "that",
  "this",
  "last",
  "any",
]);

/** Take a phrase out of the query and tidy what is left. */
function strip(query: string, phrase: string): string {
  return query.replace(phrase, " ").replace(/\s+/g, " ").trim();
}

// ── read out of the results already on screen ─────────────────────────────

/**
 * Offers derived from the page the browser is holding. Every one of these
 * narrows to a NON-EMPTY subset of what the human is already looking at,
 * because it is computed from that set — the guarantee a model could not make
 * and the reason this half is worth having on its own.
 */
function fromResults(hits: readonly FinderHit[]): FinderSuggestion[] {
  if (hits.length < 2) return [];
  return [...senderOffers(hits), ...windowOffers(hits)];
}

/**
 * "From Sergio, not Sergio's assistant."
 *
 * Two triggers. VOLUME — one sender accounts for a large share of the page,
 * so narrowing to them is probably what was meant. And COLLISION — two
 * DIFFERENT addresses whose display names share a name word, which is the
 * case the brief names and the case a person cannot see from a result list
 * without reading every row. A collision is worth saying even when neither
 * side dominates, so it is offered on its own merit and its reason names the
 * other one explicitly.
 */
function senderOffers(hits: readonly FinderHit[]): FinderSuggestion[] {
  const byAddress = new Map<string, { count: number; name: string }>();
  for (const h of hits) {
    const address = h.senderEmail.trim().toLowerCase();
    if (address === "") continue;
    const seat = byAddress.get(address) ?? { count: 0, name: h.sender };
    seat.count += 1;
    byAddress.set(address, seat);
  }
  if (byAddress.size < 2) return [];

  const ranked = [...byAddress.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const total = hits.length;
  const offer = (entry: (typeof ranked)[number], reason: string): FinderSuggestion => ({
    id: `r-from-${entry[0]}`,
    refinement: { kind: "from", value: entry[0] },
    reason,
    fromResults: true,
  });
  const name = (entry: (typeof ranked)[number]): string =>
    entry[1].name && entry[1].name !== entry[0] ? `${entry[1].name} <${entry[0]}>` : entry[0];

  // A COLLISION outranks volume and, when there is one, is the WHOLE offer.
  // Two people whose names look alike is a question — "did you mean one of
  // them rather than both?" — and a question is answered by being shown both
  // sides, not by being shown both sides plus an unrelated third sender who
  // happened to clear a threshold.
  for (const first of ranked) {
    const twin = ranked.find((other) => other[0] !== first[0] && sharesNameWord(first[1].name, other[1].name));
    if (!twin) continue;
    return [
      offer(
        first,
        `${first[1].count} of these ${total} are from ${name(first)} — and ${twin[0]} is in here too, under a ` +
          `similar name. Did you mean one of them rather than both?`,
      ),
      offer(twin, `${twin[1].count} of these ${total} are from ${name(twin)} — the other similar name.`),
    ];
  }

  // No collision: sheer volume is an observation, and one is enough.
  const top = ranked[0]!;
  if (top[1].count / total < SENDER_SHARE) return [];
  return [offer(top, `${top[1].count} of these ${total} are from ${name(top)}.`)];
}

/** Do two display names share a word that looks like a name? The whole point
 *  of the collision case: "Sergio Ruiz" and "Sergio's assistant" share
 *  "sergio". Case-folded, punctuation-stripped, two characters minimum. */
export function sharesNameWord(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  const left = words(a);
  for (const w of words(b)) if (left.has(w)) return true;
  return false;
}

/**
 * "You probably mean these three months."
 *
 * Two shapes, and the run is the one the brief names. A single month that
 * holds most of the page is the easy case. A contiguous RUN of up to three
 * months that holds most of it is the interesting one: the results are not in
 * one month, but they are in one stretch, and offering the stretch is what a
 * person would say out loud.
 */
function windowOffers(hits: readonly FinderHit[]): FinderSuggestion[] {
  const counts = new Map<string, { year: number; month: number; count: number }>();
  for (const h of hits) {
    const ms = Date.parse(h.receivedAt);
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    const seat = counts.get(key) ?? { year, month, count: 0 };
    seat.count += 1;
    counts.set(key, seat);
  }
  if (counts.size < 2) return [];
  const total = [...counts.values()].reduce((n, c) => n + c.count, 0);
  if (total === 0) return [];

  // Oldest first, so a "run" is a walk forward through the calendar.
  const months = [...counts.values()].sort((a, b) => a.year - b.year || a.month - b.month);

  const top = [...months].sort((a, b) => b.count - a.count)[0]!;
  if (top.count / total >= MONTH_SHARE) {
    return [
      {
        id: `r-window-${top.year}-${top.month}`,
        refinement: { kind: "window", label: monthLabel(top.year, top.month), ...monthWindow(top.year, top.month) },
        reason: `${top.count} of these ${total} landed in ${monthLabel(top.year, top.month)}.`,
        fromResults: true,
      },
    ];
  }

  // The best contiguous stretch of up to three calendar months.
  let best: { from: number; to: number; count: number } | null = null;
  for (let i = 0; i < months.length; i++) {
    let count = 0;
    for (let j = i; j < months.length && j - i < MAX_RUN_MONTHS; j++) {
      if (j > i && !isNextMonth(months[j - 1]!, months[j]!)) break;
      count += months[j]!.count;
      if (!best || count > best.count) best = { from: i, to: j, count };
    }
  }
  if (!best || best.to === best.from || best.count / total < RUN_SHARE) return [];
  const first = months[best.from]!;
  const last = months[best.to]!;
  const span = best.to - best.from + 1;
  return [
    {
      id: `r-window-${first.year}-${first.month}-${span}`,
      refinement: {
        kind: "window",
        label: `${monthLabel(first.year, first.month)} – ${monthLabel(last.year, last.month)}`,
        after: monthWindow(first.year, first.month).after,
        before: monthWindow(last.year, last.month).before,
      },
      reason:
        `${best.count} of these ${total} are in one ${span}-month stretch, ` +
        `${monthLabel(first.year, first.month)} to ${monthLabel(last.year, last.month)}.`,
      fromResults: true,
    },
  ];
}

/** Is `b` the calendar month immediately after `a`? (December rolls.) */
function isNextMonth(a: { year: number; month: number }, b: { year: number; month: number }): boolean {
  return a.year * 12 + a.month + 1 === b.year * 12 + b.month;
}

/** Same chip, to the byte a session would store. */
function sameRefinement(a: FinderRefinement, b: FinderRefinement): boolean {
  if (a.kind !== b.kind) return false;
  return chipLabel(a) === chipLabel(b);
}
