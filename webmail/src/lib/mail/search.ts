// Server-side search — `Email/query` with a `text` filter (arch.md §4).
//
// ⚠️ **Be honest about what this searches.** That is this module's whole job,
// and the honest answer CHANGED with common/004.
//
// Was: a LIKE over `subject`/`preview`/`from_json`/`to_json`, where `preview`
// is the first 256 characters. Message bodies were not searchable at all, and
// the note said so.
//
// Now: the server matches an FTS5 index that `Mailstore.insertEmail` writes at
// ingest (`packages/mailstore/src/index.ts`, `ftsMatchQuery` + `buildFilter`).
// **Message bodies ARE searched**, including HTML-only mail. Two limits remain,
// and they are the ones the note now carries:
//
//   1. FTS matches whole words, not fragments. `ell` no longer finds `hello` —
//      the LIKE it replaced would have. This is a real, user-visible trade.
//   2. Bodies are indexed to `FTS_BODY_LIMIT` (64 KiB, ~15 printed pages).
//      Not worth a sentence in the UI; documented in the mailstore.
//
// A UI that says "Search mail" and quietly misses the word in paragraph four
// teaches people the mail is not there — and a UI that keeps apologising for a
// gap that has been closed teaches them not to trust the notes. So
// `SEARCH_SCOPE_NOTE` is rendered next to the box, `describeSearchScope`
// spells it out for the query actually run, and both track what the server
// really does. This module is the one place to change when it changes again.
//
// ⚠️ One caveat that is NOT the server's: the demo backend
// (`webmail/src/lib/jmap/demo.ts`) is a client-side fake with no index, and it
// still matches subject/preview/from/to only. Against demo data a body-only
// word will miss. See `search.test.ts`.

/** Mirrors `EmailFilter` in `packages/mailstore/src/index.ts`. */
export type EmailFilter = EmailFilterOperator | EmailFilterCondition;

export interface EmailFilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: EmailFilter[];
}

export interface EmailFilterCondition {
  inMailbox?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  before?: string;
  after?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  minSize?: number;
  maxSize?: number;
}

export interface EmailSort {
  property: "receivedAt" | "size" | "subject" | "from";
  isAscending: boolean;
}

/** Exactly what the server's `text` condition matches, post-common/004. */
export const SERVER_SEARCH_FIELDS = ["subject", "sender", "recipients", "body"] as const;

/** The sentence the search box shows. Short, and true. */
export const SEARCH_SCOPE_NOTE =
  "Searches subject, sender, recipients and full message bodies. Matches whole words, so partial words are not found.";

export interface SearchSpec {
  /** Free text → the server's `text` condition. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  inMailbox?: string;
  hasAttachment?: boolean;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  /** ISO-8601 dates. */
  before?: string;
  after?: string;
}

const KEYED = /(\w+):("([^"]*)"|\S*)/g;

/**
 * Parse a Gmail-ish query into a `SearchSpec`. Supports `from:`, `to:`,
 * `subject:`, `in:`, `has:attachment`, `is:unread`, `is:flagged`,
 * `before:`/`after:`; everything left over is free text.
 *
 * Operators map onto conditions the server really implements. There is still
 * no `body:` operator — not because bodies are unsearchable (they are, since
 * common/004) but because the server has no body-ONLY condition: `text`
 * already covers bodies, and `body:foo` would have to be a lie or a
 * client-side filter.
 */
export function parseSearchInput(input: string, mailboxIdByName?: Map<string, string>): SearchSpec {
  const spec: SearchSpec = {};
  const rest = input
    .replace(KEYED, (match, rawKey: string, rawValue: string, quoted?: string) => {
      const key = rawKey.toLowerCase();
      const value = (quoted ?? rawValue).replace(/^"|"$/g, "");
      switch (key) {
        case "from":
          spec.from = value;
          return "";
        case "to":
          spec.to = value;
          return "";
        case "subject":
          spec.subject = value;
          return "";
        case "in":
        case "mailbox":
        case "folder": {
          const id = mailboxIdByName?.get(value.toLowerCase());
          if (id) spec.inMailbox = id;
          return "";
        }
        case "has":
          if (value.toLowerCase() === "attachment") spec.hasAttachment = true;
          return "";
        case "is":
          if (value.toLowerCase() === "unread") spec.unreadOnly = true;
          else if (value.toLowerCase() === "flagged" || value.toLowerCase() === "starred") {
            spec.flaggedOnly = true;
          }
          return "";
        case "before":
          spec.before = normalizeDate(value) ?? spec.before;
          return "";
        case "after":
          spec.after = normalizeDate(value) ?? spec.after;
          return "";
        default:
          return match; // not an operator we implement — leave it as free text
      }
    })
    .trim()
    .replace(/\s+/g, " ");

  if (rest !== "") spec.text = rest;
  return spec;
}

function normalizeDate(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Build the `Email/query` filter. Returns `null` for an empty spec, which is
 * the "everything" filter — not `{}`, which would be a condition object the
 * server has to evaluate for nothing.
 */
export function buildEmailFilter(spec: SearchSpec): EmailFilter | null {
  const conditions: EmailFilter[] = [];
  const push = (c: EmailFilterCondition): void => {
    conditions.push(c);
  };

  if (spec.inMailbox) push({ inMailbox: spec.inMailbox });
  if (nonEmpty(spec.text)) push({ text: spec.text.trim() });
  if (nonEmpty(spec.from)) push({ from: spec.from.trim() });
  if (nonEmpty(spec.to)) push({ to: spec.to.trim() });
  if (nonEmpty(spec.subject)) push({ subject: spec.subject.trim() });
  if (spec.hasAttachment === true) push({ hasAttachment: true });
  if (spec.unreadOnly) push({ notKeyword: "$seen" });
  if (spec.flaggedOnly) push({ hasKeyword: "$flagged" });
  if (spec.before) push({ before: spec.before });
  if (spec.after) push({ after: spec.after });

  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0] as EmailFilter;
  return { operator: "AND", conditions };
}

export function isEmptySpec(spec: SearchSpec): boolean {
  return buildEmailFilter(spec) === null;
}

/**
 * A sentence describing what the server WILL match for this spec — rendered
 * under the results. The `text` clause is the one that needs the caveat; a
 * `from:`/`subject:` search really is exact about its column, so saying so
 * makes the honest limitation legible rather than blanket-apologetic.
 *
 * The caveat used to be "not in full message bodies". Since common/004 it is
 * the tokenizer: `text` is whole-word, while `from:`/`subject:` remain
 * substring matches on their column. Those two really do behave differently
 * now, which is exactly why this sentence exists.
 */
export function describeSearchScope(spec: SearchSpec): string {
  const parts: string[] = [];
  if (nonEmpty(spec.text)) {
    parts.push(`“${spec.text.trim()}” as whole words in subject, sender, recipients and message bodies`);
  }
  if (nonEmpty(spec.from)) parts.push(`sender containing “${spec.from.trim()}”`);
  if (nonEmpty(spec.to)) parts.push(`recipient containing “${spec.to.trim()}”`);
  if (nonEmpty(spec.subject)) parts.push(`subject containing “${spec.subject.trim()}”`);
  if (spec.hasAttachment) parts.push("with an attachment");
  if (spec.unreadOnly) parts.push("unread only");
  if (spec.flaggedOnly) parts.push("flagged only");
  if (spec.after) parts.push(`on or after ${spec.after.slice(0, 10)}`);
  if (spec.before) parts.push(`before ${spec.before.slice(0, 10)}`);
  if (parts.length === 0) return "Showing everything in this mailbox.";
  return `Matching ${parts.join("; ")}.`;
}

/**
 * True when the free-text clause may be missing matches a substring search
 * would have found — i.e. when the whole-word tokenizer is in play.
 *
 * Pre-common/004 this meant "may be missing BODY matches", which is no longer
 * a thing that happens. The name is kept (`AppShell` and any future caller
 * want the same signal: "warn about this query") but the gap it points at is
 * now word boundaries, not body coverage.
 */
export function mayMissBodyMatches(spec: SearchSpec): boolean {
  return nonEmpty(spec.text);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
