// Mailbox list (arch.md §4) — `Mailbox/get` through the injected JmapClient.
//
// `Mailbox/set` exists server-side (sVOL 004) and `myRights` is honest about
// what a given mailbox permits, so a folder-management UI is buildable; T2
// ships the LIST, which is the requirement, plus the rights the list needs to
// grey out actions it must not offer.

import type { JmapClient } from "../jmap/JmapClient";
import { MAILBOX_ROLES, type Mailbox, type MailboxRole } from "./types";

/**
 * Load every mailbox in one call. `ids: null` means "all" (RFC 8621 §2.1);
 * there is no pagination because an account has tens of mailboxes, not
 * thousands — `Mailbox/query` exists for clients that want otherwise.
 */
export async function loadMailboxes(client: JmapClient, accountId: string): Promise<Mailbox[]> {
  const result = await client.requestOne("Mailbox/get", { accountId, ids: null });
  return ((result.list as Mailbox[] | undefined) ?? []).map(normalizeMailbox);
}

/** Defensive: a server that omits a count must not render `NaN unread`. */
function normalizeMailbox(raw: Mailbox): Mailbox {
  return {
    ...raw,
    parentId: raw.parentId ?? null,
    role: raw.role ?? null,
    totalEmails: raw.totalEmails ?? 0,
    unreadEmails: raw.unreadEmails ?? 0,
    totalThreads: raw.totalThreads ?? 0,
    unreadThreads: raw.unreadThreads ?? 0,
    myRights: raw.myRights ?? {},
    isSubscribed: raw.isSubscribed !== false,
  };
}

export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  /** Nesting level, 0 at the root — the indent the sidebar renders. */
  depth: number;
}

/**
 * Roles our own surfaces do not present as browsable folders (s12).
 *
 * `junk` holds what the boundary shunted, displayed "Quarantined". The role is
 * not going away — it is the REGISTERED JMAP role, which is what makes Apple
 * Mail, himalaya and every other RFC 8621 client treat the mail correctly —
 * but a folder you *maybe* need to manage is a pile with no completion state,
 * and rendering it here is what makes it one. What the boundary could not
 * decide reaches this client as a PROPOSAL in `/approvals` ("3 messages I
 * couldn't judge"), which has an answer and then goes away; what it decided
 * confidently needs no human at all.
 *
 * So: a decision, not a destination. Legacy clients keep the folder; we show
 * the question.
 */
export const UNBROWSABLE_ROLES: ReadonlySet<string> = new Set(["junk"]);

/** The mailboxes this client lists. Filtered ONCE, here, so the sidebar and
 * the move targets cannot disagree — offering a move into a folder the
 * sidebar hides would be a one-way door out of the UI. */
export function browsableMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.filter((m) => !UNBROWSABLE_ROLES.has(m.role ?? ""));
}

/**
 * Build the sidebar tree. Two properties worth stating:
 *
 * - **Orphans and cycles become roots.** A `parentId` pointing at a mailbox
 *   that was not returned (or at an ancestor of itself) would otherwise make
 *   folders vanish from the sidebar entirely — the worst possible failure for
 *   a folder list, because the mail is still there and simply unreachable.
 *   (`UNBROWSABLE_ROLES` is filtered out first, and a child of one is promoted
 *   to a root by that same rule rather than disappearing with its parent.)
 * - **Roles sort first, in the order a mail client shows them**, then
 *   `sortOrder`, then name. The server does not impose an order; the client
 *   owning it is what makes Inbox the first row.
 */
export function buildMailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  const byId = new Map<string, MailboxNode>();
  for (const m of browsableMailboxes(mailboxes)) byId.set(m.id, { ...m, children: [], depth: 0 });

  const roots: MailboxNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent || parent.id === node.id || createsCycle(node, byId)) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const sortNodes = (nodes: MailboxNode[], depth: number): MailboxNode[] => {
    nodes.sort(compareMailboxes);
    for (const n of nodes) {
      n.depth = depth;
      sortNodes(n.children, depth + 1);
    }
    return nodes;
  };
  return sortNodes(roots, 0);
}

function createsCycle(node: MailboxNode, byId: Map<string, MailboxNode>): boolean {
  const seen = new Set<string>([node.id]);
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

export function compareMailboxes(a: Mailbox, b: Mailbox): number {
  const ra = roleRank(a.role);
  const rb = roleRank(b.role);
  if (ra !== rb) return ra - rb;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

/** Role display order; user folders (role `null`) sort after all of them. */
export function roleRank(role: string | null): number {
  const i = (MAILBOX_ROLES as readonly string[]).indexOf(role ?? "");
  return i < 0 ? MAILBOX_ROLES.length : i;
}

export function findByRole(mailboxes: Mailbox[], role: MailboxRole): Mailbox | undefined {
  return mailboxes.find((m) => m.role === role);
}

/** Flatten a tree back to render order — what the sidebar actually maps over. */
export function flattenTree(nodes: MailboxNode[]): MailboxNode[] {
  const out: MailboxNode[] = [];
  const walk = (list: MailboxNode[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The one number the tab title shows. Counts the INBOX only: summing every
 * mailbox double-counts a message filed in two places and, worse, counts
 * unread mail in Junk — a badge that never reaches zero is a badge people
 * learn to ignore.
 */
export function inboxUnread(mailboxes: Mailbox[]): number {
  return findByRole(mailboxes, "inbox")?.unreadEmails ?? 0;
}

/**
 * The set of mailboxes a message may be MOVED to. Excludes the mailbox it is
 * already in, anything whose rights refuse new items, and the roles this
 * client does not browse — a destination you cannot then open is a trapdoor,
 * not a folder.
 */
export function moveTargets(mailboxes: Mailbox[], currentId?: string): Mailbox[] {
  return browsableMailboxes(mailboxes)
    .filter((m) => m.id !== currentId && m.myRights.mayAddItems !== false)
    .sort(compareMailboxes);
}
