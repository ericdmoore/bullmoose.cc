// The mail-domain view types the T2 surfaces render.
//
// Like `../jmap/types.ts`, these MIRROR the server's wire shape rather than
// importing it: `services/jmap/src/methods/email.ts` (`emailToJmap`) and
// `mailbox.ts` (`Mailbox/get`) are the source of truth, but they are Worker
// source and dragging `@cloudflare/workers-types` into a DOM bundle is the
// lib-clash the repo already fights. Keep in sync with those two files.

/** RFC 8621 §4.1.2 — `name` is `null`, not absent, when the server has none. */
export interface EmailAddress {
  name: string | null;
  email: string;
}

/** RFC 8621 §4.1.4 body part, as `Email/get` returns it for text/html parts. */
export interface BodyPart {
  partId: string | null;
  blobId: string | null;
  type: string;
  charset?: string | null;
  name?: string | null;
  size?: number;
  cid?: string | null;
  disposition?: string | null;
}

export interface BodyValue {
  value: string;
  isEncodingProblem?: boolean;
  /** The server truncates when `maxBodyValueBytes` is set — surface it. */
  isTruncated?: boolean;
}

export interface Attachment {
  partId: string | null;
  blobId: string;
  size: number;
  name: string | null;
  type: string;
  cid: string | null;
  disposition: string | null;
}

export interface Email {
  id: string;
  blobId: string;
  threadId: string;
  /** id → true. RFC 8621 uses a set-as-object, not an array. */
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  /** ISO-8601. */
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /**
   * ⚠️ The server returns `null` for every message today — `emailToJmap` has a
   * standing `// TODO: parse Date header at ingest`. Sort and display off
   * `receivedAt`; treating `sentAt` as authoritative would silently show
   * "unknown" on every row.
   */
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  attachments: Attachment[];
  bodyValues?: Record<string, BodyValue>;
  textBody?: BodyPart[];
  htmlBody?: BodyPart[];
}

export interface MailboxRights {
  mayReadItems?: boolean;
  mayAddItems?: boolean;
  mayRemoveItems?: boolean;
  maySetSeen?: boolean;
  maySetKeywords?: boolean;
  mayCreateChild?: boolean;
  mayRename?: boolean;
  mayDelete?: boolean;
  maySubmit?: boolean;
}

export interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  /** One of MAILBOX_ROLES, or null for a user folder. */
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/**
 * The six roles this server understands — `KNOWN_ROLES` in
 * `services/jmap/src/methods/mailbox.ts`. Anything else is a user folder.
 */
export const MAILBOX_ROLES = ["inbox", "drafts", "sent", "archive", "junk", "trash"] as const;
export type MailboxRole = (typeof MAILBOX_ROLES)[number];

/** IMAP-derived keywords the UI acts on (RFC 8621 §4.1.1). */
export const KEYWORD = {
  seen: "$seen",
  flagged: "$flagged",
  draft: "$draft",
  answered: "$answered",
  forwarded: "$forwarded",
} as const;

export function isUnread(email: Pick<Email, "keywords">): boolean {
  return email.keywords[KEYWORD.seen] !== true;
}

export function isFlagged(email: Pick<Email, "keywords">): boolean {
  return email.keywords[KEYWORD.flagged] === true;
}

export function isDraft(email: Pick<Email, "keywords">): boolean {
  return email.keywords[KEYWORD.draft] === true;
}

/** "Ada Lovelace" when there is a name, else the bare address. */
export function displayName(addr: EmailAddress | undefined): string {
  if (!addr) return "(unknown)";
  return addr.name && addr.name.trim() !== "" ? addr.name : addr.email;
}

export function formatAddress(addr: EmailAddress): string {
  return addr.name && addr.name.trim() !== "" ? `${addr.name} <${addr.email}>` : addr.email;
}

/** The properties a LIST row needs — deliberately excludes bodies (see threadList). */
export const LIST_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "receivedAt",
  "preview",
  "hasAttachment",
  "size",
] as const;

/** The properties a thread VIEW needs — metadata plus bodies and attachments. */
export const DETAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "attachments",
  "bodyValues",
  "textBody",
  "htmlBody",
] as const;
