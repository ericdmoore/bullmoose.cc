// Quoted-text collapsing for text/plain bodies (arch.md §4).
//
// The HTML path splits on a top-level `<blockquote>` inside the sanitizer,
// where it can cut without breaking element nesting (see sanitize.ts). Plain
// text has no structure to lean on, so it is detected here by the conventions
// mail clients actually emit: an attribution line, a separator banner, or a run
// of `>`-prefixed lines that reaches the end of the message.
//
// Deliberately conservative: when the shape is ambiguous nothing is collapsed.
// Hiding text the user wrote is a worse failure than showing a quote they have
// already read.

export interface TextBodySplit {
  /** What the sender actually wrote. */
  body: string;
  /** The trailing quote, attribution line included. Empty when none was found. */
  quoted: string;
  /** A trailing `-- ` signature block, split off separately. Empty when none. */
  signature: string;
}

/** `-----Original Message-----`, `---------- Forwarded message ----------`. */
const BANNER =
  /^\s*(-{2,}\s*original message\s*-{2,}|-{2,}\s*forwarded message\s*-{2,}|_{10,}|-{10,})\s*$/i;

/**
 * `On <date>, <person> wrote:` — possibly wrapped across up to three lines,
 * which is what every client does once the address is long enough.
 */
const ATTRIBUTION = /^(on|am|le|el)\b[\s\S]{0,300}?\b(wrote|schrieb|escribió|a écrit|writes|said):\s*$/i;

/** Outlook's localized header block, which has no `>` prefixes at all. */
const OUTLOOK_HEADER = /^\s*(from|von|de):\s*.+$/i;

const SIGNATURE = /^--\s?$/;

export function splitQuotedText(text: string): TextBodySplit {
  const lines = text.split(/\r?\n/);

  const sigAt = findSignature(lines);
  const searchable = sigAt >= 0 ? lines.slice(0, sigAt) : lines;
  const signature = sigAt >= 0 ? lines.slice(sigAt).join("\n") : "";

  const cut = findQuoteStart(searchable);
  if (cut < 0) {
    return { body: searchable.join("\n").replace(/\s+$/, ""), quoted: "", signature };
  }
  return {
    body: searchable.slice(0, cut).join("\n").replace(/\s+$/, ""),
    quoted: searchable.slice(cut).join("\n").replace(/\s+$/, ""),
    signature,
  };
}

function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (BANNER.test(line)) return i;
    if (isAttribution(lines, i)) return i;
    // A `>` run only counts when it runs to the END of the message; a quote in
    // the middle is something the sender is replying to inline.
    if (line.startsWith(">") && restIsAllQuoted(lines, i)) return i;
    // `From: ...` followed by more headers, with no `>` anywhere: Outlook.
    if (OUTLOOK_HEADER.test(line) && looksLikeHeaderBlock(lines, i)) return i;
  }
  return -1;
}

/**
 * An attribution may wrap. Join this line and the next two, and require the
 * JOINED text to end in `wrote:` — so a sentence merely starting with "On"
 * does not swallow the rest of the message.
 */
function isAttribution(lines: string[], i: number): boolean {
  for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
    const joined = lines.slice(i, i + span).join(" ").trim();
    if (joined === "") continue;
    if (ATTRIBUTION.test(joined)) return true;
  }
  return false;
}

function restIsAllQuoted(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    if (!line.startsWith(">")) return false;
  }
  return true;
}

/** Two or more consecutive `Header: value` lines starting at `i`. */
function looksLikeHeaderBlock(lines: string[], i: number): boolean {
  let seen = 0;
  for (let j = i; j < Math.min(i + 5, lines.length); j++) {
    if (/^\s*[a-z-]+:\s*\S/i.test(lines[j] as string)) seen++;
    else break;
  }
  return seen >= 2;
}

function findSignature(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SIGNATURE.test(lines[i] as string)) return i;
  }
  return -1;
}

/** Prefix every line with `> ` for a reply quote (RFC 3676 style). */
export function quoteLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}
