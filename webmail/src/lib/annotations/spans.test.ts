import { describe, expect, it } from "vitest";
import { createSpanAnchor, findSpanAnchor, SPAN_CONTEXT_CHARS, type SpanAnchor } from "./spans";

// s36 span anchors. The cases that matter here are the ADVERSARIAL ones, because
// the failure mode is not "no highlight" — it is a highlight over the WRONG
// SENTENCE, which invites the reader to judge a claim against a source that did
// not say it. Every test below is named for the failure it prevents.
//
// The drift being simulated is real: sanitize.ts rewrites the body, quoted
// trails are collapsed, `maxBodyValueBytes` truncates, `&nbsp;` decodes to a
// non-breaking space, and the CLI renders the same message with no DOM at all.

const BODY = [
  "Hi all,",
  "",
  "Check-in is Saturday, Aug 22 at 7:30 am at the north field.",
  "First whistle is at 8:00 am.",
  "Sunday, Aug 23 at 7:30 am for the semi-final.",
  "",
  "Registration is $60 - Venmo the coach by Friday.",
].join("\n");

/** Anchor the `nth` (0-based) occurrence of `quote` in `text`. Fails loudly. */
function anchorOn(text: string, quote: string, nth = 0): SpanAnchor {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(quote, at + 1);
    if (at < 0) throw new Error(`fixture has no occurrence ${i} of ${JSON.stringify(quote)}`);
  }
  const anchor = createSpanAnchor(text, at, at + quote.length);
  if (!anchor) throw new Error(`fixture is not anchorable: ${JSON.stringify(quote)}`);
  return anchor;
}

/** What `findSpanAnchor` actually pointed at, so a wrong span reads as wrong text. */
function found(anchor: SpanAnchor, text: string): string | null {
  const range = findSpanAnchor(anchor, text);
  return range === null ? null : text.slice(range.start, range.end);
}

describe("createSpanAnchor", () => {
  it("carries the quote, both context windows, and which occurrence it is", () => {
    const anchor = anchorOn(BODY, "7:30 am", 1);
    expect(anchor.quote).toBe("7:30 am");
    expect(anchor.prefix.endsWith("Sunday, Aug 23 at ")).toBe(true);
    expect(anchor.suffix.startsWith(" for the semi-final.")).toBe(true);
    expect(anchor.occurrence).toBe(1);
  });

  it("caps each context window at SPAN_CONTEXT_CHARS — an anchor is a pointer, not a copy", () => {
    const long = `${"x".repeat(100)}TARGET${"y".repeat(100)}`;
    const anchor = anchorOn(long, "TARGET");
    expect(anchor.prefix).toBe("x".repeat(SPAN_CONTEXT_CHARS));
    expect(anchor.suffix).toBe("y".repeat(SPAN_CONTEXT_CHARS));
  });

  it("leaves a window empty at the edge of the text rather than inventing context", () => {
    const anchor = anchorOn("Saturday", "Saturday");
    expect(anchor.prefix).toBe("");
    expect(anchor.suffix).toBe("");
    expect(found(anchor, "Saturday")).toBe("Saturday");
  });

  it("trims padding out of the quote, so the highlight is the text and not the space beside it", () => {
    const text = "Meet on Saturday at noon.";
    const at = text.indexOf(" Saturday ");
    const anchor = createSpanAnchor(text, at, at + " Saturday ".length);
    expect(anchor?.quote).toBe("Saturday");
    expect(anchor?.prefix).toBe("Meet on ");
    expect(anchor?.suffix).toBe(" at noon.");
    expect(findSpanAnchor(anchor as SpanAnchor, text)).toEqual({ start: 8, end: 16 });
  });

  it("refuses a whitespace-only selection — there would be nothing to re-find", () => {
    expect(createSpanAnchor("a   b", 1, 4)).toBeNull();
  });

  it("refuses bounds that are not a range in this text, rather than clamping into a guess", () => {
    expect(createSpanAnchor(BODY, 10, 10)).toBeNull();
    expect(createSpanAnchor(BODY, 12, 4)).toBeNull();
    expect(createSpanAnchor(BODY, -1, 5)).toBeNull();
    expect(createSpanAnchor(BODY, 0, BODY.length + 1)).toBeNull();
    expect(createSpanAnchor(BODY, 0.5, 4)).toBeNull();
    expect(createSpanAnchor("", 0, 0)).toBeNull();
  });

  it("counts OVERLAPPING occurrences, so a span at position 1 of `aaaa` is still nameable", () => {
    expect(createSpanAnchor("aaaa", 0, 2)?.occurrence).toBe(0);
    expect(createSpanAnchor("aaaa", 1, 3)?.occurrence).toBe(1);
    expect(createSpanAnchor("aaaa", 2, 4)?.occurrence).toBe(2);
    // …and each of them re-finds its own position, not the first match.
    expect(findSpanAnchor(anchorOn("aaaa", "aa", 1), "aaaa")).toEqual({ start: 1, end: 3 });
  });

  it("does not cut an astral character in half at either window edge", () => {
    // Half a surrogate pair is not text: it renders as a replacement character
    // in the margin and travels to storage as a mangled string.
    const before = `🎉${"x".repeat(SPAN_CONTEXT_CHARS - 1)}Saturday`;
    expect(anchorOn(before, "Saturday").prefix).toBe(`🎉${"x".repeat(SPAN_CONTEXT_CHARS - 1)}`);

    const after = `Saturday${"x".repeat(SPAN_CONTEXT_CHARS - 1)}🎉 rest`;
    expect(anchorOn(after, "Saturday").suffix).toBe("x".repeat(SPAN_CONTEXT_CHARS - 1));
  });
});

describe("findSpanAnchor — the text it was made from", () => {
  it("round-trips every span it anchored", () => {
    for (const [quote, nth] of [
      ["Saturday, Aug 22", 0],
      ["7:30 am", 0],
      ["8:00 am", 0],
      ["7:30 am", 1],
      ["Friday", 0],
    ] as const) {
      expect(found(anchorOn(BODY, quote, nth), BODY)).toBe(quote);
    }
  });

  it("re-finds the SECOND `7:30 am`, not the first", () => {
    const anchor = anchorOn(BODY, "7:30 am", 1);
    const range = findSpanAnchor(anchor, BODY);
    expect(range?.start).toBe(BODY.lastIndexOf("7:30 am"));
  });
});

describe("findSpanAnchor — surviving how the body is rendered", () => {
  it("survives whitespace added or removed at the edges of the whole body", () => {
    const padded = `\n\n   ${BODY}   \n`;
    const range = findSpanAnchor(anchorOn(BODY, "7:30 am", 1), padded);
    expect(range?.start).toBe(padded.lastIndexOf("7:30 am"));
    expect(padded.slice(range?.start, range?.end)).toBe("7:30 am");
  });

  it("survives a re-flow that turns line breaks into spaces", () => {
    // The CLI wraps; the HTML path emits <br> and <p>. Neither keeps the
    // sender's newlines, so whitespace cannot be part of the identity.
    const reflowed = BODY.replace(/\n+/g, " ");
    expect(found(anchorOn(BODY, "7:30 am", 1), reflowed)).toBe("7:30 am");
  });

  it("survives a non-breaking space where a plain space used to be", () => {
    // `&nbsp;` is ordinary in sender HTML and decodes to U+00A0, which would
    // otherwise make the rendered "7:30 am" a different string from the
    // anchored one. JS `\s` already covers U+00A0, so this needs no special
    // case — but it needs a test, because nothing else here would notice if it
    // stopped being true. Escaped on purpose: an invisible character in a
    // fixture is a fixture nobody can review.
    const rendered = BODY.replace("7:30 am", "7:30\u00a0am");
    const range = findSpanAnchor(anchorOn(BODY, "7:30 am", 0), rendered);
    expect(rendered.slice(range?.start, range?.end)).toBe("7:30\u00a0am");
  });

  it("survives truncation flush with the end of the span — the whole suffix gone", () => {
    const cut = BODY.slice(0, BODY.indexOf("7:30 am") + "7:30 am".length);
    const range = findSpanAnchor(anchorOn(BODY, "7:30 am", 0), cut);
    expect(range).toEqual({ start: cut.length - "7:30 am".length, end: cut.length });
  });

  it("survives truncation part-way through the suffix", () => {
    const cut = BODY.slice(0, BODY.indexOf("7:30 am") + "7:30 am".length + 5);
    expect(found(anchorOn(BODY, "7:30 am", 0), cut)).toBe("7:30 am");
  });

  it("survives text removed BEFORE the span — a collapsed quoted trail ahead of it", () => {
    // Context is compared OUTWARD from the quote, so an edit farther away than
    // the window is invisible; only an adjacent edit is evidence of anything.
    const later = BODY.slice(BODY.indexOf("First whistle"));
    const range = findSpanAnchor(anchorOn(BODY, "7:30 am", 1), later);
    expect(range?.start).toBe(later.indexOf("7:30 am"));
  });

  it("lets context outrank the index when an earlier occurrence disappears", () => {
    // The anchor says occurrence 1, but only one `7:30 am` survived the cut and
    // its surroundings are the anchored ones. Position is the thing rendering
    // changes; context is not.
    const later = BODY.slice(BODY.indexOf("Sunday, Aug 23"));
    expect(later.split("7:30 am").length - 1).toBe(1);
    expect(found(anchorOn(BODY, "7:30 am", 1), later)).toBe("7:30 am");
  });
});

describe("findSpanAnchor — repeats", () => {
  const REPEATED = "Arrive 7:30 am.\nArrive 7:30 am.\nArrive 7:30 am.";

  it("uses the occurrence index when three copies sit in IDENTICAL surroundings", () => {
    for (const nth of [0, 1, 2]) {
      const range = findSpanAnchor(anchorOn(REPEATED, "7:30 am", nth), REPEATED);
      expect(range?.start).toBe(7 + nth * 16);
    }
  });

  it("picks the copy whose surroundings match, not the first one it sees", () => {
    // A reply quoting the original: the same sentence renders twice. The margin
    // must not hang the note on the sentence the reader is writing.
    const original = "Coach says check-in is 7:30 am at the north field.";
    const reply = `We moved check-in to 7:30 am.\n\nOn Tue, Coach wrote:\n> ${original}`;
    const range = findSpanAnchor(anchorOn(original, "7:30 am"), reply);
    expect(range?.start).toBe(reply.lastIndexOf("7:30 am"));
  });
});

describe("findSpanAnchor — refuses to guess", () => {
  it("returns null when the quote is simply not there", () => {
    expect(findSpanAnchor(anchorOn(BODY, "7:30 am"), "Nothing about times in here.")).toBeNull();
  });

  it("returns null when the anchored occurrence was truncated away and an EARLIER twin remains", () => {
    // The sharpest wrong-sentence case: the quote is present, unique, and the
    // wrong one. Highlighting "bring cash" as the boots deadline is worse than
    // no highlight, so the caller degrades to a whole-message annotation.
    const twice = "Bring cash Saturday. Also bring boots Saturday.";
    const anchor = anchorOn(twice, "Saturday", 1);
    expect(findSpanAnchor(anchor, "Bring cash Saturday.")).toBeNull();
  });

  it("returns null when the same words appear in a DIFFERENT message", () => {
    // Stale anchor, re-used against the wrong body: nothing around the quote
    // agrees, so nothing is claimed.
    expect(findSpanAnchor(anchorOn(BODY, "7:30 am"), "The gym opens at 7:30 am on weekdays.")).toBeNull();
  });

  it("returns null when the index names an occurrence that no longer exists", () => {
    const anchor: SpanAnchor = { quote: "am", prefix: "", suffix: "", occurrence: 5 };
    expect(findSpanAnchor(anchor, "7 am and 8 am")).toBeNull();
    // …and still resolves the one it CAN name, so this is refusal rather than a
    // context-free anchor being useless.
    expect(findSpanAnchor({ ...anchor, occurrence: 1 }, "7 am and 8 am")).toEqual({ start: 11, end: 13 });
  });

  it("returns null on empty text, and on an anchor with nothing to search for", () => {
    expect(findSpanAnchor(anchorOn(BODY, "7:30 am"), "")).toBeNull();
    expect(findSpanAnchor({ quote: "", prefix: "", suffix: "", occurrence: 0 }, BODY)).toBeNull();
    expect(findSpanAnchor({ quote: "   \n ", prefix: "", suffix: "", occurrence: 0 }, BODY)).toBeNull();
  });
});
