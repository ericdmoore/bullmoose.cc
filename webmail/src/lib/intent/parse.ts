// s20 T3 — reading an intent sentence, deterministically and for free.
//
// The composer's second mode asks one question — *what do you want to
// happen?* — and the answer arrives as prose: "ask Sergio whether he's
// comfortable with me selling assembled boards — supportive tone, no big
// commitment". Before any money is spent, before any round trip, this module
// pulls the three things a human needs to CHECK out of that sentence:
//
//   who          the person it is addressed to (a name, or an address outright)
//   tone         the register they asked for ("supportive")
//   constraints  the limits they set ("no big commitment")
//
// Deterministic on purpose, and the reason is the same one `remind.ts` gives
// for parsing deadlines without a model: what this produces is shown back to
// the human as an editable plan, so it must be predictable, instant, and free
// — a plan card that flickers while a model thinks is a plan card nobody
// reads. The MODEL's job starts later and is a different job: writing the
// message. This one only reads the ask.
//
// It is also deliberately shallow. Everything it extracts is displayed and
// editable, so a miss costs a correction, never a wrong send — and a miss it
// cannot recover from (no name at all) asks rather than guesses.

/** What one intent sentence says, as far as anything deterministic can tell. */
export interface IntentPlan {
  /** The sentence, verbatim — the source of truth the agent is given. */
  raw: string;
  /** The person named, as written ("Sergio", or an address). Null = not named. */
  who: string | null;
  /** True when `who` is already an address and nothing needs resolving. */
  whoIsAddress: boolean;
  /** The tone asked for, lowercased ("supportive"). */
  tone: string | null;
  /** The limits set, in the human's own words ("no big commitment"). */
  constraints: string[];
}

/**
 * The registers a person actually asks for in one word. Matched only in tone
 * POSITION (as "<word> tone", after "in a/with a", or as its own clause), so
 * "warm regards from the shipping company" in the middle of an ask does not
 * become a tone.
 */
export const TONE_WORDS: readonly string[] = [
  "supportive",
  "warm",
  "friendly",
  "kind",
  "gentle",
  "encouraging",
  "grateful",
  "apologetic",
  "polite",
  "formal",
  "informal",
  "casual",
  "professional",
  "neutral",
  "direct",
  "blunt",
  "firm",
  "brief",
  "short",
  "serious",
  "upbeat",
  "enthusiastic",
  "playful",
  "cautious",
  "curious",
];

/**
 * The verbs that address a message at somebody. Matched case-insensitively
 * against a lowercased copy, so the NAME can then be read out of the original
 * with its capitalisation intact — a single `/i` regex would make `[A-Z]`
 * match anything and turn "ask sergio whether" into the name "sergio whether".
 * "write to" precedes "write" so the longer form wins.
 */
const ADDRESSING =
  /\b(?:please\s+)?(?:ask|tell|e-?mail|write\s+to|write|message|ping|remind|nudge|check\s+with|follow\s+up\s+with|let|reply\s+to|get\s+back\s+to)\s+/i;

/** Trim the punctuation a name collects in a sentence. */
function cleanName(token: string): string {
  return token.replace(/^["'“”‘’(]+|["'“”‘’),;.!?:]+$/g, "");
}

/** Pronouns and collectives that are not a person we could look up. */
const NOT_A_NAME = new Set([
  "him",
  "her",
  "them",
  "they",
  "everyone",
  "everybody",
  "someone",
  "somebody",
  "me",
  "myself",
  "us",
  "it",
  "the",
  "a",
  "an",
  "that",
  "this",
  "there",
  "back",
]);

/** An address, as loosely as one can be recognised without validating it. */
const ADDRESS = /[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+\.[^\s<>,;:"()[\]]+/;

/** The clause openers that mark a LIMIT rather than part of the ask. */
const CONSTRAINT_OPENERS = [
  /^no\s+/i,
  /^not\s+/i,
  /^nothing\s+/i,
  /^never\s+/i,
  /^don'?t\s+/i,
  /^do\s+not\s+/i,
  /^without\s+/i,
  /^avoid\s+/i,
  /^keep\s+it\s+/i,
  /^stay\s+/i,
  /^make\s+sure\s+/i,
  /^but\s+(?:no|not|don'?t|nothing)\s+/i,
];

/**
 * Split an intent into clauses. A person tacks their steer onto the end of the
 * sentence with a dash, a comma or a semicolon, and it is that tail — not the
 * ask itself — that carries tone and limits.
 */
export function intentClauses(text: string): string[] {
  return text
    .split(/\s*[—–]\s*|\s*[;,]\s*|\s+-\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Read the tone out of one clause, in tone POSITION only. */
function toneIn(clause: string): string | null {
  const lower = clause.toLowerCase();
  const labelled = lower.match(/\btone\s*[:=]\s*([a-z-]+)/) ?? lower.match(/\b([a-z-]+)\s+tone\b/);
  if (labelled?.[1] && TONE_WORDS.includes(labelled[1])) return labelled[1];
  const phrased = lower.match(/\b(?:in|with|use|using|keep\s+it)\s+(?:a\s+|an\s+)?([a-z-]+)\b/);
  if (phrased?.[1] && TONE_WORDS.includes(phrased[1])) return phrased[1];
  // A clause that is nothing BUT a tone word ("supportive") is a tone.
  const bare = lower.replace(/\s+tone$/, "").trim();
  return TONE_WORDS.includes(bare) ? bare : null;
}

/**
 * Read one intent sentence. Never throws, never returns a name it had to
 * invent, and everything it returns is shown back to the human as editable —
 * the parse is a proposal like everything else here.
 */
export function parseIntent(text: string): IntentPlan {
  const raw = text ?? "";
  const trimmed = raw.trim();
  const plan: IntentPlan = { raw, who: null, whoIsAddress: false, tone: null, constraints: [] };
  if (!trimmed) return plan;

  // An address in the sentence beats any name in it: the human already did the
  // resolving, and nothing should second-guess that.
  const address = trimmed.match(ADDRESS);
  if (address) {
    plan.who = address[0];
    plan.whoIsAddress = true;
  } else {
    const named = trimmed.toLowerCase().match(ADDRESSING);
    if (named?.index !== undefined) {
      const after = trimmed.slice(named.index + named[0].length);
      const tokens = after.split(/\s+/);
      const first = cleanName(tokens[0] ?? "");
      if (first && !NOT_A_NAME.has(first.toLowerCase()) && !/^\d+$/.test(first)) {
        // A capitalised second token joins the first ("Dana Ruiz"); a lowercase
        // one is the rest of the sentence ("sergio whether…") and is left alone.
        const next = tokens[1] ?? "";
        const second = /^[A-Z]/.test(next) ? cleanName(next) : "";
        plan.who = second ? `${first} ${second}` : first;
      }
    }
  }

  for (const clause of intentClauses(trimmed)) {
    // The first clause is the ask itself; a tone or a limit stated inside it
    // still counts, which is why every clause is examined and only clause
    // ROLE — not position — decides.
    const tone = toneIn(clause);
    if (tone && !plan.tone) {
      plan.tone = tone;
      // "supportive tone" is spent; "keep it supportive and short" may also be
      // a constraint, so only a clause that is PURELY tone is consumed.
      if (/^\s*[a-z-]+(\s+tone)?\s*$/i.test(clause) || /^tone\s*[:=]/i.test(clause)) continue;
    }
    if (CONSTRAINT_OPENERS.some((re) => re.test(clause))) {
      plan.constraints.push(clause.replace(/[.?!]+$/, ""));
    }
  }
  plan.constraints = plan.constraints.slice(0, 6);
  return plan;
}

/**
 * Is this draft still blank — nothing typed, nobody addressed?
 *
 * The one question that decides whether intent mode may open by DEFAULT.
 * s20 T3's rule: the mode is a toggle, never a replacement, and never the
 * default for a draft the human already started writing. A reply, a forward,
 * or a draft picked back up is theirs and opens in the classic editor; only an
 * empty "New message" opens on the question.
 *
 * The signature counts as blank, because `newDraft` puts it there — treating
 * an account with a signature as "already writing" would silently take intent
 * mode away from exactly the people who configured their mail most.
 */
export function draftLooksBlank(draft: {
  to: unknown[];
  cc: unknown[];
  bcc: unknown[];
  subject: string;
  text: string;
}): boolean {
  if (draft.to.length > 0 || draft.cc.length > 0 || draft.bcc.length > 0) return false;
  if (draft.subject.trim() !== "") return false;
  // Everything above the RFC 3676 signature delimiter is the human's writing.
  const above = draft.text.split(/^-- $/m)[0] ?? draft.text;
  return above.trim() === "";
}
