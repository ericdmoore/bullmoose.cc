// Server-side search — `Email/query` with a `text` filter (arch.md §4).
//
// ⚠️ **Be honest about what this searches.** The server's `text` condition is a
// LIKE over four columns (`packages/mailstore/src/index.ts`, `buildFilter`):
//
//     e.subject LIKE ? OR e.preview LIKE ? OR e.from_json LIKE ? OR e.to_json LIKE ?
//     // "LIKE fallback until the FTS index is populated at ingest"
//
// `preview` is the first 256 characters of the body. **Message bodies are NOT
// searchable** — the FTS index exists in the schema but is unwired at ingest
// (common/004). A UI that says "Search mail" and quietly misses the word in
// paragraph four teaches people the mail is not there. So `SEARCH_SCOPE_NOTE`
// is rendered next to the box, and `describeSearchScope` spells it out for the
// query actually run. When FTS lands, this module is the one place to change.

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

/** Exactly the columns the server's `text` condition touches. */
export const SERVER_SEARCH_FIELDS = ["subject", "preview", "sender", "recipients"] as const;

/** The sentence the search box shows. Short, and true. */
export const SEARCH_SCOPE_NOTE =
  "Searches subject, sender, recipients and the first 256 characters of each message. Full message bodies are not searched yet.";

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
 * Operators map onto conditions the server really implements — deliberately no
 * `body:`, because there is nothing behind it.
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
 */
export function describeSearchScope(spec: SearchSpec): string {
  const parts: string[] = [];
  if (nonEmpty(spec.text)) {
    parts.push(
      `“${spec.text.trim()}” in subject, sender, recipients and message previews (first 256 characters) — not in full message bodies`,
    );
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

/** True when the result set may be missing matches that live only in a body. */
export function mayMissBodyMatches(spec: SearchSpec): boolean {
  return nonEmpty(spec.text);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}
