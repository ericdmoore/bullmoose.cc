// The thread list: `Email/query` + `Email/get` in ONE batched round trip, with
// a RE-QUERY sync strategy.
//
// ⚠️ arch.md §4 plans this on "`Email/query` + `queryChanges`". That is not
// available: `services/jmap/src/methods/email.ts` registers
//
//     registry.register("Email/queryChanges", async () => {
//       throw new MethodError("cannotCalculateChanges");
//     });
//
// and `Email/query` advertises `canCalculateChanges: false` to say so up front.
// This is a deliberate server stub, not a bug — computing a query delta needs
// an index the D1 schema does not keep. RFC 8620 §5.6 tells a conformant client
// exactly what to do when `canCalculateChanges` is false: **re-run the query**.
// So this store never calls `Email/queryChanges` at all, and
// `threadList.test.ts` pins that with a fake whose `Email/queryChanges` throws
// the same error the server does.
//
// The re-query is still ONE round trip: query + back-referenced get. It costs
// more bytes than a delta would, which is why `REFRESH_CAP` bounds how much of
// a long list a push notification is allowed to re-fetch.

import { backReference } from "../jmap/JmapClient";
import type { JmapClient } from "../jmap/JmapClient";
import type { Invocation } from "../jmap/types";
import type { EmailFilter, EmailSort } from "./search";
import { LIST_PROPERTIES, displayName, isFlagged, isUnread, type Email } from "./types";

/** Rows fetched per page. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Ceiling on how many rows a re-query refreshes. Without a delta the only way
 * to notice a change deep in a long list is to re-read it, and re-reading 20k
 * rows on every push would be worse than the staleness it fixes. Rows past the
 * cap refresh when the user scrolls to them.
 */
export const REFRESH_CAP = 200;

/** Newest first — what every mail client shows and what the server indexes. */
export const DEFAULT_SORT: EmailSort[] = [{ property: "receivedAt", isAscending: false }];

export interface ThreadListQuery {
  filter?: EmailFilter | null;
  sort?: EmailSort[];
  pageSize?: number;
}

/**
 * One row of the list.
 *
 * ⚠️ **Threading is client-side and window-local.** `Email/query` has no
 * `collapseThreads` on this server, so it returns EMAILS. Grouping happens over
 * the rows loaded so far: a thread whose older message sits on a page that has
 * not been fetched yet shows the count it has, and grows as you scroll. The
 * alternative — a `Thread/get` per row to learn the true size — is the N+1 that
 * invariant §6.5 exists to prevent.
 */
export interface ThreadRow {
  threadId: string;
  /** Loaded emails in the thread, newest first. */
  emailIds: string[];
  /** The newest loaded email — what the row renders. */
  latest: Email;
  /** How many of the thread's emails are loaded (see the caveat above). */
  loadedCount: number;
  subject: string;
  participants: string[];
  receivedAt: string;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
}

export interface LoadResult {
  /** True when the visible rows differ from before the call. */
  changed: boolean;
  rows: ThreadRow[];
}

/**
 * Holds one list's worth of state. Deliberately a plain class, not a framework
 * store: it is unit-tested in Node against `FakeJmapClient` with no renderer in
 * the loop, and the component subscribes via `onChange`.
 */
export class ThreadListStore {
  private readonly client: JmapClient;
  private readonly accountId: string;
  private query: ThreadListQuery;

  /** Loaded emails in server query order. */
  private emails: Email[] = [];
  private rows: ThreadRow[] = [];
  /** `Email/query`'s `queryState` — the cheap "did anything move?" check. */
  private queryState = "";
  private total: number | undefined;
  private listeners = new Set<() => void>();
  private inFlight: Promise<LoadResult> | undefined;

  constructor(client: JmapClient, accountId: string, query: ThreadListQuery = {}) {
    this.client = client;
    this.accountId = accountId;
    this.query = query;
  }

  getRows(): ThreadRow[] {
    return this.rows;
  }
  getEmails(): Email[] {
    return this.emails;
  }
  getTotal(): number | undefined {
    return this.total;
  }
  getQueryState(): string {
    return this.queryState;
  }
  /** True when the server has rows past what is loaded. */
  hasMore(): boolean {
    return this.total === undefined ? false : this.emails.length < this.total;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Swap the filter/sort (a mailbox click or a search) and reload from zero. */
  async setQuery(query: ThreadListQuery): Promise<LoadResult> {
    this.query = query;
    this.emails = [];
    this.rows = [];
    this.total = undefined;
    this.queryState = "";
    return this.load(0, this.pageSize());
  }

  /** First page. */
  async reload(): Promise<LoadResult> {
    this.emails = [];
    this.rows = [];
    return this.load(0, this.pageSize());
  }

  /** Next page, appended. No-op once everything is loaded. */
  async loadMore(): Promise<LoadResult> {
    if (this.total !== undefined && this.emails.length >= this.total) {
      return { changed: false, rows: this.rows };
    }
    return this.load(this.emails.length, this.pageSize());
  }

  /**
   * The re-query fallback. Called on a `StateChange` push (arch.md §3), because
   * `Email/queryChanges` cannot answer. Re-reads the loaded prefix in one round
   * trip and reports whether anything actually moved, so a push that concerns a
   * different mailbox does not repaint the list.
   *
   * Coalesced: a burst of pushes produces one request, not one per push.
   */
  async refresh(): Promise<LoadResult> {
    if (this.inFlight) return this.inFlight;
    const limit = Math.min(Math.max(this.emails.length, this.pageSize()), REFRESH_CAP);
    this.inFlight = this.load(0, limit, { replace: true }).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private pageSize(): number {
    return this.query.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  /**
   * One round trip: `Email/query` then `Email/get` of exactly the ids it
   * returned, joined by an RFC 8620 §3.7 back-reference (invariant §6.5).
   */
  private async load(
    position: number,
    limit: number,
    opts: { replace?: boolean } = {},
  ): Promise<LoadResult> {
    const calls: Invocation[] = [
      [
        "Email/query",
        {
          accountId: this.accountId,
          filter: this.query.filter ?? null,
          sort: this.query.sort ?? DEFAULT_SORT,
          position,
          limit,
          calculateTotal: true,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: this.accountId,
          "#ids": backReference("q", "Email/query", "/ids"),
          properties: [...LIST_PROPERTIES],
        },
        "g",
      ],
    ];

    const responses = await this.client.request(calls);
    const queryResp = responses.find((r) => r[2] === "q");
    const getResp = responses.find((r) => r[2] === "g");
    if (!queryResp || queryResp[0] === "error") {
      throw new ThreadListError("Email/query", queryResp?.[1]);
    }
    if (!getResp || getResp[0] === "error") {
      throw new ThreadListError("Email/get", getResp?.[1]);
    }

    const q = queryResp[1] as { ids: string[]; queryState: string; total?: number };
    const fetched = ((getResp[1] as { list?: Email[] }).list ?? []) as Email[];

    // `Email/get` does not promise the order of `list`; the QUERY is the order
    // of record. Re-index rather than trusting the get.
    const byId = new Map(fetched.map((e) => [e.id, e]));
    const ordered = q.ids.map((id) => byId.get(id)).filter((e): e is Email => e !== undefined);

    const before = this.signature();
    if (opts.replace || position === 0) {
      // A replace keeps rows past the refresh window: they were not re-read,
      // and dropping them would make the list jump under a user who had
      // scrolled past the cap.
      const tail = opts.replace ? this.emails.slice(limit) : [];
      this.emails = dedupeById([...ordered, ...tail]);
    } else {
      this.emails = dedupeById([...this.emails, ...ordered]);
    }
    this.queryState = q.queryState;
    if (typeof q.total === "number") this.total = q.total;
    this.rows = groupIntoThreads(this.emails);

    const changed = before !== this.signature();
    if (changed) for (const fn of this.listeners) fn();
    return { changed, rows: this.rows };
  }

  /** Cheap identity of the rendered state — id + keywords, which is what shows. */
  private signature(): string {
    return this.emails
      .map((e) => `${e.id}:${Object.keys(e.keywords ?? {}).sort().join(",")}`)
      .join("|");
  }

  // ── optimistic local edits (keyboard triage repaints before the server) ──

  /** Apply a keyword/mailbox change locally so the UI does not wait on a round trip. */
  patchLocal(emailId: string, patch: { keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> }): void {
    const idx = this.emails.findIndex((e) => e.id === emailId);
    if (idx < 0) return;
    const email = this.emails[idx] as Email;
    this.emails[idx] = {
      ...email,
      ...(patch.keywords ? { keywords: { ...email.keywords, ...patch.keywords } } : {}),
      ...(patch.mailboxIds ? { mailboxIds: { ...email.mailboxIds, ...patch.mailboxIds } } : {}),
    };
    this.rows = groupIntoThreads(this.emails);
    for (const fn of this.listeners) fn();
  }

  /** Drop rows the user archived or deleted, before the server confirms. */
  removeLocal(emailIds: string[]): void {
    const gone = new Set(emailIds);
    const before = this.emails.length;
    this.emails = this.emails.filter((e) => !gone.has(e.id));
    if (this.emails.length === before) return;
    if (this.total !== undefined) this.total -= before - this.emails.length;
    this.rows = groupIntoThreads(this.emails);
    for (const fn of this.listeners) fn();
  }
}

export class ThreadListError extends Error {
  constructor(
    readonly method: string,
    readonly detail: unknown,
  ) {
    const type = (detail as { type?: string } | undefined)?.type;
    super(`${method} failed${type ? `: ${type}` : ""}`);
    this.name = "ThreadListError";
  }
}

function dedupeById(emails: Email[]): Email[] {
  const seen = new Set<string>();
  const out: Email[] = [];
  for (const e of emails) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Collapse emails into thread rows, preserving the server's query order (the
 * thread takes the position of its newest loaded message). See the caveat on
 * `ThreadRow`: this is grouping over the loaded window, not a server-side
 * thread query.
 */
export function groupIntoThreads(emails: Email[]): ThreadRow[] {
  const byThread = new Map<string, Email[]>();
  const order: string[] = [];

  for (const email of emails) {
    const key = email.threadId || email.id;
    let bucket = byThread.get(key);
    if (!bucket) {
      bucket = [];
      byThread.set(key, bucket);
      order.push(key);
    }
    bucket.push(email);
  }

  return order.map((threadId) => {
    const bucket = byThread.get(threadId) as Email[];
    const latest = bucket[0] as Email;
    return {
      threadId,
      emailIds: bucket.map((e) => e.id),
      latest,
      loadedCount: bucket.length,
      // The oldest loaded message carries the thread's original subject; the
      // newest usually just prefixes it with Re:.
      subject: (bucket[bucket.length - 1] as Email).subject || latest.subject || "(no subject)",
      participants: participantsOf(bucket),
      receivedAt: latest.receivedAt,
      // A thread is unread if ANY message in it is — the Gmail behaviour, and
      // the one that stops a reply from hiding under an already-read thread.
      unread: bucket.some(isUnread),
      flagged: bucket.some(isFlagged),
      hasAttachment: bucket.some((e) => e.hasAttachment),
    };
  });
}

/** Distinct senders, oldest-first, which is the order a conversation reads in. */
function participantsOf(emails: Email[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = emails.length - 1; i >= 0; i--) {
    const from = (emails[i] as Email).from?.[0];
    if (!from) continue;
    const key = from.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(displayName(from));
  }
  return out;
}
