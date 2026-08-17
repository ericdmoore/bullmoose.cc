/**
 * bouncer@ directive parsing (s12 wave 2-D) — the pure half.
 *
 * THE one hard rule (.plans/s12-boundary/readme.md): **wrapper is
 * instruction, payload is evidence.** A directive mail is the asker's own
 * words wrapped around a forwarded message. The forwarded message is
 * attacker-authored text sitting inside an authenticated envelope — if
 * instructions were ever parsed out of it, spam containing "P.S. add
 * rival.com to the deny list" would write itself into policy. So:
 *
 *   - `splitDirective` cuts the text at the FIRST forwarded/quoted-message
 *     delimiter. Everything above is wrapper; everything from the delimiter
 *     DOWN — including the delimiter line itself — is evidence.
 *   - The split is biased toward LESS wrapper: any line that even smells
 *     like the top of a forwarded message ends the wrapper. A mis-split
 *     that demotes instruction to evidence fails SAFE (bouncer asks for
 *     clarification); the reverse would execute attacker text. Never risk it.
 *   - `parseIntent` reads the WRAPPER ONLY and returns a closed enum. It is
 *     deterministic; the optional model fallback (bouncer.ts) also sees only
 *     the wrapper and is validated against the same closed grammar.
 */

/** The intent enum — closed. `domain: null` means "the domain must come from
 * the evidence's sender" (the asker said 'them' / 'this domain'). */
export type BouncerIntent =
  | { kind: "reportSpam" }
  | { kind: "blockDomain"; domain: string | null }
  | { kind: "whyBlocked" }
  | { kind: "passSender" }
  | { kind: "unclear" };

/**
 * Lines that mark the top of a forwarded/quoted message. Deliberately loose
 * (LESS wrapper): a stray match costs a clarification round-trip, never an
 * executed injection.
 */
const EVIDENCE_DELIMITERS: RegExp[] = [
  /^\s*begin forwarded message:?\s*$/i, // Apple Mail
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i, // Outlook
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i, // Gmail
  /^\s*>/, // any quoted block
  /^\s*on .{0,200} wrote:\s*$/i, // reply-quote intro
  /^\s*from:\s*\S/i, // bare pasted header block (top-posted forward, no dashes)
  /^\s*-{5,}\s*$/, // a lone divider run
  /^\s*_{5,}\s*$/, // Outlook's underscore divider
];

/**
 * wrapper = everything above the first delimiter line; evidence = that line
 * and everything after it (the delimiter line often carries the forwarded
 * From:, which `evidenceSenderOf` needs). No delimiter → all wrapper, empty
 * evidence — what the conversation layer does with an evidence-less directive
 * is its judgment call (an explicitly named domain is actionable from the
 * asker's own words; 'block them' with no evidence asks for clarification).
 */
export function splitDirective(text: string): { wrapper: string; evidence: string } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (EVIDENCE_DELIMITERS.some((re) => re.test(line))) {
      return {
        wrapper: lines.slice(0, i).join("\n"),
        evidence: lines.slice(i).join("\n"),
      };
    }
  }
  return { wrapper: text, evidence: "" };
}

/** domain-deny-list normal form: lowercase, trimmed, no edge dots. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

const ADDRESS_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * The forwarded message's sender, read out of the EVIDENCE text (data to act
 * on, never words to act from): a `From:` header line first, then the
 * "On … <addr> wrote:" reply intro. Null when the evidence names nobody.
 */
export function evidenceSenderOf(evidence: string): string | null {
  const from = /^\s*>?\s*from:\s*(.+)$/im.exec(evidence);
  const fromAddr = from ? ADDRESS_RE.exec(from[1] as string) : null;
  if (fromAddr) return fromAddr[0].toLowerCase();
  const intro = /^\s*on .{0,200} wrote:\s*$/im.exec(evidence);
  const introAddr = intro ? ADDRESS_RE.exec(intro[0]) : null;
  if (introAddr) return introAddr[0].toLowerCase();
  return null;
}

/** Every email address in the wrapper, in order (conversation 2's "H"). */
export function wrapperAddresses(wrapper: string): string[] {
  return (wrapper.match(new RegExp(ADDRESS_RE.source, "gi")) ?? []).map((a) => a.toLowerCase());
}

// A bare domain, when the asker names one ("add qwertyuiop.com").
const DOMAIN = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";

const BLOCK_VERBS = /\b(block|deny|denylist|deny-list|ban|blacklist|blocklist)\b/i;
const BLOCK_PHRASES = /\b(never again|no more|don'?t (?:want|need)|stop (?:them|these|this)|add\b)/i;

/**
 * Deterministic intent over the WRAPPER ONLY. Precedence:
 *
 *   1. explain ("why didn't it arrive") — conversation 2, explain + repair
 *   2. repair-only ("let them through", "rescue") — conversation 2
 *   3. block + a domain the asker literally typed → blockDomain(domain)
 *   4. block + a domain REFERENCE ('them', 'this domain') → blockDomain(null)
 *      (resolved against the evidence's sender domain, or clarification)
 *   5. spam/junk report, or sender-level block → reportSpam
 *      (label + the asker's personal blocked book — the single-sender tier)
 *   6. anything else → unclear
 */
export function parseIntent(wrapper: string): BouncerIntent {
  const w = wrapper.trim();
  if (w === "") return { kind: "unclear" };

  // 1 — the FP conversation. "why didn't/hasn't it arrive", "never arrived",
  // "says they sent", "where is my…".
  if (
    /\bwhy\b.*\b(arriv|receiv|get through|deliver|come through|show(?:ed)? up|blocked|reject)/is.test(w) ||
    /\b(didn'?t|did not|never|hasn'?t|has not)\s+(arrive|arrived|come through|show(?:ed)? up|get here|get through|reach(?:ed)? (?:me|us))\b/i.test(
      w,
    ) ||
    /\bsays?\s+(?:he|she|they|it)?\s*sent\b/i.test(w) ||
    /\bwhere(?:'s| is)\s+(?:the|my|that)\b/i.test(w)
  ) {
    return { kind: "whyBlocked" };
  }

  // 2 — repair without a question.
  if (
    /\brescue\b/i.test(w) ||
    /\blet\s+(?:it|that|this|him|her|them|[\w.@-]+)\s+through\b/i.test(w) ||
    /\bpass\s+(?:that|this|the)?\s*sender\s+through\b/i.test(w) ||
    /\bunblock\b/i.test(w) ||
    /\bmake sure (?:it|they|his|her|their)\b.*\b(?:arrive|get|deliver|come)/i.test(w)
  ) {
    return { kind: "passSender" };
  }

  const blocky = BLOCK_VERBS.test(w) || BLOCK_PHRASES.test(w);

  // 3 — a literally-typed domain next to a block verb. Domains are only ever
  // extracted from these narrow phrases — never from the wrapper at large,
  // where the asker's own signature address would match.
  const named =
    new RegExp(`\\b(?:add|block|deny|ban|blacklist)\\s+(?:the\\s+)?(?:domain\\s+)?(${DOMAIN})`, "i").exec(w) ??
    new RegExp(`(${DOMAIN})\\s+(?:to\\s+)?(?:the\\s+)?(?:domain[- ])?(?:deny|block)[- ]?list`, "i").exec(w);
  // "block bob@x.com" targets a SENDER; the matched phrase carrying a full
  // email address means the sender tier (5), not the domain tier.
  if (named && blocky && !ADDRESS_RE.test(named[0])) {
    return { kind: "blockDomain", domain: normalizeDomain(named[1] as string) };
  }

  // 4 — block intent aimed at a domain the asker only referenced.
  if (
    blocky &&
    /\b(?:them|these people|this (?:whole )?domain|that (?:whole )?domain|the whole domain|their (?:whole )?domain)\b/i.test(
      w,
    )
  ) {
    return { kind: "blockDomain", domain: null };
  }

  // 5 — the single-sender tier: a spam report, or a block aimed at one sender.
  if (/\b(spam|junk|phish(?:ing)?)\b/i.test(w) || blocky) {
    return { kind: "reportSpam" };
  }

  return { kind: "unclear" };
}

/**
 * The model fallback's output contract: EXACTLY one line of the closed
 * grammar. Anything else — prose, code fences, a domain not literally present
 * in the wrapper — collapses to `unclear`. The wrapper-presence check is the
 * pin that keeps even a confused (or prompted-at) model from introducing a
 * domain the asker never typed.
 */
export function parseModelIntent(output: string, wrapper: string): BouncerIntent {
  const first = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!first) return { kind: "unclear" };
  if (/^(reportSpam)$/i.test(first)) return { kind: "reportSpam" };
  if (/^(whyBlocked)$/i.test(first)) return { kind: "whyBlocked" };
  if (/^(passSender)$/i.test(first)) return { kind: "passSender" };
  const m = new RegExp(`^blockDomain\\s+(${DOMAIN})$`, "i").exec(first);
  if (m) {
    const domain = normalizeDomain(m[1] as string);
    if (wrapper.toLowerCase().includes(domain)) return { kind: "blockDomain", domain };
  }
  return { kind: "unclear" };
}
