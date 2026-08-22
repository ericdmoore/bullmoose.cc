// Span anchors (s36) — pointing an annotation at a RANGE INSIDE a message
// body, and re-finding that range in whatever the body renders as later.
//
// Annotations anchor to `{realm, objectId}` — a whole email (types.ts). The
// extraction ladder needs the date highlighted *where it appears*, which means
// anchoring into the body. The obvious anchor — a pair of offsets — does not
// survive the trip:
//
//   - the body is sanitised HTML and the sanitiser REWRITES it (sanitize.ts
//     unwraps unknown tags, drops dangerous subtrees, and re-escapes
//     everything), so an offset into the source is not an offset into what
//     renders;
//   - quoted-trail collapsing, `maxBodyValueBytes` truncation and blocked
//     remote images each change how long the shown text is;
//   - the same message renders in the CLI, which has no DOM at all.
//
// So the anchor is CONTENT-ADDRESSED: the exact quote, a window of text either
// side of it, and which occurrence of the quote it was. Re-anchoring is then a
// search in the rendered text, wherever that text came from. This is the W3C
// Web Annotation `TextQuoteSelector` shape (exact/prefix/suffix) plus the
// occurrence index — a mail body repeats "7:30 am" far more readily than a web
// page repeats a sentence, and the index is what tells two of them apart.
//
// **The bias is refusal.** A wrong span highlights the WRONG SENTENCE, and the
// reader then judges a claim against a source that did not say it — worse than
// no highlight at all. So every genuinely ambiguous case returns null and the
// caller degrades to a whole-message annotation: the margin note still appears,
// it simply is not highlighted (s36, "the modelling change: span anchors").
//
// Pure, DOM-free, and dependency-free, for the same reason sanitize.ts is: it
// has to run in the browser, in a Worker, and in plain-Node tests.

/** How much text either side of the quote an anchor carries. */
export const SPAN_CONTEXT_CHARS = 32;

/**
 * A content-addressed pointer at a range of text.
 *
 * Every field is stored RAW — exactly as it appeared — so the row stays legible
 * in a database dump and a margin can show the sentence it came from.
 * Whitespace is normalized at MATCH time, on both sides, never on the way in.
 */
export interface SpanAnchor {
  /** The anchored text itself, edge whitespace trimmed off. */
  quote: string;
  /** Up to `SPAN_CONTEXT_CHARS` immediately before the quote; "" at the start of the text. */
  prefix: string;
  /** Up to `SPAN_CONTEXT_CHARS` immediately after the quote; "" at the end of the text. */
  suffix: string;
  /**
   * Which occurrence of `quote` this was, 0-based, counting every position the
   * quote occurs at (overlapping ones included). The tie-break of last resort,
   * used only where the surrounding context cannot tell candidates apart.
   */
  occurrence: number;
}

/** Where a span landed, as offsets into the text that was searched. */
export interface SpanRange {
  start: number;
  end: number;
}

/**
 * Anchor `[start, end)` of `text`.
 *
 * Returns null when there is nothing anchorable there — bounds that are not a
 * real range in this text, or a selection that is only whitespace. Null is not
 * an error to handle loudly: it means "this stays a whole-message annotation".
 *
 * Edge whitespace inside the selection is dropped, so the stored quote is the
 * text that will be highlighted rather than the padding around it.
 */
export function createSpanAnchor(text: string, start: number, end: number): SpanAnchor | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || start >= end) return null;

  // Trim the selection before storing it. A caller's offsets often include a
  // leading space (a word selection, a regex with `\s` in it); highlighting
  // that space is wrong, and it would also put whitespace at the inner edge of
  // the quote where normalization is about to remove it anyway.
  const selected = text.slice(start, end);
  const quoteStart = start + (selected.length - selected.trimStart().length);
  const quoteEnd = end - (selected.length - selected.trimEnd().length);
  if (quoteStart >= quoteEnd) return null;

  const quote = text.slice(quoteStart, quoteEnd);
  const source = normalize(text);
  const at = source.map.indexOf(quoteStart);
  // Unreachable for a real slice of `text` — the first quoted character is not
  // whitespace, so normalization kept it and mapped it. Refuse rather than
  // return an anchor whose occurrence index we would have to invent.
  if (at < 0) return null;

  const occurrence = occurrencesOf(source.text, normalize(quote).text).indexOf(at);
  if (occurrence < 0) return null;

  return {
    quote,
    prefix: sliceWholeChars(text, Math.max(0, quoteStart - SPAN_CONTEXT_CHARS), quoteStart),
    suffix: sliceWholeChars(text, quoteEnd, Math.min(text.length, quoteEnd + SPAN_CONTEXT_CHARS)),
    occurrence,
  };
}

/**
 * Re-find `anchor` in `text`, as offsets into `text`, or null.
 *
 * The rules, in the order they apply:
 *
 * | situation | answer | why |
 * |---|---|---|
 * | the quote is absent | null | nothing to point at |
 * | one candidate whose context agrees | that one | the ordinary case |
 * | several whose context agrees | the `occurrence`th | exactly what the index is for |
 * | several agree, none is the `occurrence`th | null | the anchored one is gone; a neighbour is not it |
 * | no candidate's context agrees | null | the quote survived but its surroundings did not |
 *
 * Two candidates can only ever be told apart by CONTEXT first and position
 * second, because position is the thing rendering changes. A candidate whose
 * context disagrees is never chosen, even when it is the only one there is —
 * that is the "wrong sentence" case, and refusing it is the whole point.
 */
export function findSpanAnchor(anchor: SpanAnchor, text: string): SpanRange | null {
  const needle = normalize(anchor.quote).text;
  if (needle === "") return null;

  const source = normalize(text);
  const at = occurrencesOf(source.text, needle);
  if (at.length === 0) return null;

  const prefix = normalizeContext(anchor.prefix, "prefix");
  const suffix = normalizeContext(anchor.suffix, "suffix");

  const agreeing: number[] = [];
  for (let i = 0; i < at.length; i++) {
    if (contextAgrees(source.text, at[i], needle.length, prefix, suffix)) agreeing.push(i);
  }

  if (agreeing.length === 0) return null;
  if (agreeing.length === 1) return rangeOf(source, at[agreeing[0]], needle.length);
  // Indistinguishable by context — the same date in the same words, twice. The
  // occurrence index is the only evidence left, and if it names none of them
  // (the anchored one was truncated away, say) the honest answer is nothing.
  if (agreeing.includes(anchor.occurrence)) return rangeOf(source, at[anchor.occurrence], needle.length);
  return null;
}

// ── normalization ─────────────────────────────────────────────────────────

/**
 * Whitespace, for matching purposes. JS `\s` already covers U+00A0, which is
 * what the sanitiser's `&nbsp;` decodes to — so a non-breaking space in the
 * rendered body matches a plain space in the anchor without special-casing.
 */
const WHITESPACE = /\s/;

interface Normalized {
  /** Whitespace runs collapsed to one space, both edges trimmed. */
  text: string;
  /** `map[i]` is the index in the ORIGINAL string that produced `text[i]`. */
  map: number[];
}

/**
 * Collapse whitespace and remember where every surviving character came from,
 * so a match found in the normalized text can be reported in the caller's
 * coordinates. Nothing else is folded: case and punctuation are evidence, and
 * an anchor that ignored them would match text the sender did not write.
 */
function normalize(raw: string): Normalized {
  let text = "";
  const map: number[] = [];
  let gapAt = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (WHITESPACE.test(ch)) {
      // Remember where the run started, but do not emit yet. A run that reaches
      // the end of the string has to vanish entirely — that is what makes a
      // trailing "\n" (or three, or a `<br>` the sanitiser left behind)
      // invisible to matching, and the same skip at the head handles a leading
      // one, since nothing has been emitted for it to follow.
      if (text.length > 0 && gapAt < 0) gapAt = i;
      continue;
    }
    if (gapAt >= 0) {
      text += " ";
      map.push(gapAt);
      gapAt = -1;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

/**
 * Normalize a context window, keeping the space that abuts the quote.
 *
 * `normalize` trims both edges, which is right for the OUTER one — the window
 * was cut there arbitrarily — and wrong for the inner one. The space between
 * "at" and "7:30 am" is in the rendered text too, so dropping it from the
 * anchor's side would make every context comparison stop dead at that space and
 * report a disagreement that is not there.
 */
function normalizeContext(raw: string, side: "prefix" | "suffix"): string {
  const inner = normalize(raw).text;
  if (inner === "") return "";
  if (side === "prefix") return WHITESPACE.test(raw.charAt(raw.length - 1)) ? `${inner} ` : inner;
  return WHITESPACE.test(raw.charAt(0)) ? ` ${inner}` : inner;
}

// ── matching ──────────────────────────────────────────────────────────────

/**
 * Every position `needle` occurs at, OVERLAPPING ones included: in "aaaa" the
 * quote "aa" occurs at 0, 1 and 2. A non-overlapping scan would make position 1
 * un-anchorable — there would be no index that named it — and `createSpanAnchor`
 * and `findSpanAnchor` must count the same way or the index means two things.
 */
function occurrencesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Does the rendered text around a candidate agree with the anchor's context?
 *
 * Both comparisons run OUTWARD from the quote and stop when they run out of
 * text, and that is the whole trick: an edit FARTHER from the quote — a
 * collapsed quoted trail ahead of it, `maxBodyValueBytes` truncation after it —
 * is invisible, while an edit ADJACENT to it is not. Running out of text counts
 * as agreement; disagreeing about a character does not.
 */
function contextAgrees(hay: string, at: number, quoteLength: number, prefix: string, suffix: string): boolean {
  const availableBefore = Math.min(prefix.length, at);
  const availableAfter = Math.min(suffix.length, hay.length - at - quoteLength);
  return (
    matchBackward(hay, at, prefix) === availableBefore && matchForward(hay, at + quoteLength, suffix) === availableAfter
  );
}

/** How many characters of `prefix` sit immediately before `at`, reading backwards. */
function matchBackward(hay: string, at: number, prefix: string): number {
  let n = 0;
  while (n < prefix.length && at - n - 1 >= 0 && hay.charAt(at - n - 1) === prefix.charAt(prefix.length - 1 - n)) n++;
  return n;
}

/** How many characters of `suffix` sit immediately at `at`, reading forwards. */
function matchForward(hay: string, at: number, suffix: string): number {
  let n = 0;
  while (n < suffix.length && at + n < hay.length && hay.charAt(at + n) === suffix.charAt(n)) n++;
  return n;
}

/**
 * A normalized match, back in the caller's coordinates. A normalized needle
 * never ends on a collapsed space (normalization trims both edges), so the last
 * mapped character is a real one and `+ 1` is the exclusive end of it.
 */
function rangeOf(source: Normalized, at: number, length: number): SpanRange {
  return { start: source.map[at], end: source.map[at + length - 1] + 1 };
}

// ── slicing ───────────────────────────────────────────────────────────────

/**
 * `text.slice(from, to)`, without cutting an astral character in half. The
 * context window lands mid-emoji often enough in real mail to be worth two
 * comparisons: half a surrogate pair is not text, it is a replacement character
 * in the margin and a mangled string on the way to storage.
 */
function sliceWholeChars(text: string, from: number, to: number): string {
  // A low surrogate on a boundary means its high partner is on the other side
  // of it: at the head take the partner in, at the tail leave the orphan out.
  const a = from > 0 && isLowSurrogate(text.charCodeAt(from)) ? from - 1 : from;
  const b = to < text.length && isLowSurrogate(text.charCodeAt(to)) ? to - 1 : to;
  return text.slice(a, b);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
