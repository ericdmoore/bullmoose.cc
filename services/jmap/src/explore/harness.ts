import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import worker, { type Env } from "../index";
import { EXPLORE_COOKIE, mintExploreCookie } from "./cookie";

/**
 * TEST-ONLY fixture for the explorer (s21).
 *
 * It drives the WORKER ENTRYPOINT (`worker.fetch`) over `@bullmoose/test-fakes`
 * — real `node:sqlite` on the live schema, real R2/KV fakes, the real
 * `AccountDO` — so nothing sits between a request and the JMAP method layer.
 * A projection that forgot its account gate, or a link that points at an id
 * nothing owns, fails here rather than passing.
 *
 * Three principals in two tenants, each with a full set of objects seeded under
 * the SAME shapes, so a cross-account leak is visible as content rather than as
 * a missing 404: if Eric's explorer ever returns `Subject a_allen`, the
 * assertion that fails says so.
 *
 * No `package.json` concerns here — it is a plain module under `src/`, imported
 * only by `*.test.ts` files. It is excluded from coverage the same way other
 * test scaffolding is (it exports no product code).
 */

export const TENANT = "t_bm";
export const TENANT2 = "t_other";
export const ERIC = "a_eric";
export const ALLEN = "a_allen";
export const ZED = "a_zed";

export const EXPLORE_HOST = "explore.bullmoose.cc";
export const APP_HOST = "app.bullmoose.cc";
export const COOKIE_KEY = "explore-test-cookie-key";

export interface Harness {
  w: FakeWorker;
  env: Env;
  /** A bearer token for Eric with the given scopes. */
  token: string;
  /** A valid explore cookie value for Eric. */
  cookie: string;
  /** GET on the explore host, authenticated by cookie unless told otherwise. */
  explore(
    path: string,
    init?: { cookie?: string | null; bearer?: string; host?: string },
  ): Promise<Response>;
  /** Any method on the explore host, carrying the valid cookie. */
  exploreWith(method: string, path: string): Promise<Response>;
  /** Any request to the API origin. */
  api(method: string, path: string, init?: RequestInit): Promise<Response>;
  json<T = Record<string, unknown>>(res: Response): Promise<T>;
}

interface Options {
  /** Scopes on the bearer token AND in the cookie. Default: read. */
  scopes?: string[];
  /** Leave EXPLORE_HOST unset — the off-by-default deployment. */
  off?: boolean;
  /** Extra Env overrides (OAUTH binding, client id, ...). */
  env?: Partial<Env>;
}

export async function harness(opts: Options = {}): Promise<Harness> {
  const scopes = opts.scopes ?? ["read"];
  const w = fakeEnv();

  w.db.seedAccount({
    accountId: ERIC,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
    displayName: "Eric",
  });
  w.db.seedAccount({
    accountId: ALLEN,
    tenantId: TENANT,
    principalId: "p_allen",
    loginEmail: "allen@bullmoose.cc",
    displayName: "Allen",
  });
  w.db.seedAccount({
    accountId: ZED,
    tenantId: TENANT2,
    principalId: "p_zed",
    loginEmail: "zed@elsewhere.example",
    displayName: "Zed",
  });

  for (const account of [ERIC, ALLEN, ZED]) seedAll(w, account);

  const minted = await mintToken();
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "explorer-test",
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);

  const env = w.env as unknown as Env;
  if (!opts.off) {
    env.EXPLORE_HOST = EXPLORE_HOST;
    env.EXPLORE_COOKIE_KEY = COOKIE_KEY;
  }
  Object.assign(env, opts.env ?? {});

  const cookie = await mintExploreCookie(COOKIE_KEY, "p_eric", scopes, Date.now());

  return {
    w,
    env,
    token: minted.token,
    cookie,
    explore(path, init = {}) {
      const host = init.host ?? EXPLORE_HOST;
      const headers: Record<string, string> = { host };
      const cookieValue = init.cookie === null ? null : (init.cookie ?? cookie);
      if (cookieValue !== null) headers.cookie = `${EXPLORE_COOKIE}=${cookieValue}`;
      if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
      return worker.fetch(new Request(`https://${host}${path}`, { headers }), env);
    },
    exploreWith(method, path) {
      return worker.fetch(
        new Request(`https://${EXPLORE_HOST}${path}`, {
          method,
          headers: { host: EXPLORE_HOST, cookie: `${EXPLORE_COOKIE}=${cookie}` },
        }),
        env,
      );
    },
    api(method, path, init = {}) {
      return worker.fetch(
        new Request(`https://${APP_HOST}${path}`, {
          method,
          ...init,
          headers: { host: APP_HOST, ...((init.headers as Record<string, string>) ?? {}) },
        }),
        env,
      );
    },
    async json<T = Record<string, unknown>>(res: Response) {
      return (await res.json()) as T;
    },
  };
}

/** Ids are account-qualified so a leak reads as the wrong account's data. */
export const ids = {
  inbox: (a: string) => `mb_inbox_${a}`,
  archive: (a: string) => `mb_archive_${a}`,
  thread: (a: string, n: number) => `th_${n}_${a}`,
  email: (a: string, n: number) => `e_${n}_${a}`,
  book: (a: string) => `ab_1_${a}`,
  card: (a: string, n: number) => `cc_${n}_${a}`,
  calendar: (a: string) => `cal_1_${a}`,
  event: (a: string, n: number) => `ce_${n}_${a}`,
  dir: (a: string) => `fn_dir_${a}`,
  file: (a: string, n: number) => `fn_${n}_${a}`,
};

/** How many emails each account gets — enough to page at limit=2. */
export const EMAIL_COUNT = 5;

function seedAll(w: FakeWorker, account: string): void {
  // Mailboxes: one root, one child, so `_links.parent` has something to point
  // at and `?parentId=` has something to filter on.
  w.db.seed("mailboxes", [
    {
      id: ids.inbox(account),
      account_id: account,
      parent_id: null,
      name: "Inbox",
      role: "inbox",
      sort_order: 0,
    },
    {
      id: ids.archive(account),
      account_id: account,
      parent_id: ids.inbox(account),
      name: "Archive",
      role: "archive",
      sort_order: 1,
    },
  ]);

  // Emails: EMAIL_COUNT in the inbox, the first two sharing a thread, and the
  // first carrying an attachment whose fileNodeId points at a real FileNode —
  // the one cross-realm id an Email payload carries.
  for (let n = 1; n <= EMAIL_COUNT; n++) {
    const attachments =
      n === 1
        ? [
            {
              blobId: `blob_${account}`,
              type: "text/plain",
              name: "notes.txt",
              size: 4,
              cid: null,
              disposition: "attachment",
              fileNodeId: ids.file(account, 1),
            },
          ]
        : [];
    w.db.seed("emails", [
      {
        id: ids.email(account, n),
        account_id: account,
        blob_id: `blob_${account}`,
        thread_id: n <= 2 ? ids.thread(account, 1) : ids.thread(account, n),
        subject: `Subject ${n} ${account}`,
        size: 10,
        received_at: 1_700_000_000_000 + n,
        has_attachment: attachments.length > 0 ? 1 : 0,
        attachments_json: JSON.stringify(attachments),
      },
    ]);
    w.db.seed("email_mailboxes", [
      { account_id: account, email_id: ids.email(account, n), mailbox_id: ids.inbox(account) },
    ]);
  }

  const now = 1_700_000_000_000;
  w.db.seed("address_books", [
    {
      id: ids.book(account),
      account_id: account,
      name: `Contacts ${account}`,
      sort_order: 0,
      is_default: 1,
      is_subscribed: 1,
      ctag: 1,
      created_at: now,
      updated_at: now,
    },
  ]);
  for (let n = 1; n <= 3; n++) {
    w.db.seed("contact_cards", [
      {
        id: ids.card(account, n),
        account_id: account,
        address_book_id: ids.book(account),
        uid: `urn:uuid:card-${n}-${account}`,
        card_json: JSON.stringify({
          "@type": "Card",
          version: "1.0",
          uid: `urn:uuid:card-${n}-${account}`,
          name: { full: `Person ${n} ${account}` },
        }),
        name_full: `Person ${n} ${account}`,
        created_at: now,
        updated_at: now,
      },
    ]);
  }

  w.db.seed("calendars", [
    {
      id: ids.calendar(account),
      account_id: account,
      name: `Calendar ${account}`,
      sort_order: 0,
      is_default: 1,
      is_subscribed: 1,
      ctag: 1,
      created_at: now,
      updated_at: now,
    },
  ]);
  for (let n = 1; n <= 3; n++) {
    w.db.seed("calendar_events", [
      {
        id: ids.event(account, n),
        account_id: account,
        calendar_id: ids.calendar(account),
        uid: `urn:uuid:event-${n}-${account}`,
        event_json: JSON.stringify({
          "@type": "Event",
          uid: `urn:uuid:event-${n}-${account}`,
          title: `Event ${n} ${account}`,
          start: "2026-09-01T09:00:00",
          duration: "PT1H",
          timeZone: "UTC",
        }),
        title: `Event ${n} ${account}`,
        start_at: now + n * 3_600_000,
        end_at: now + n * 3_600_000 + 3_600_000,
        is_recurring: 0,
        created_at: now,
        updated_at: now,
      },
    ]);
  }

  w.db.seed("file_nodes", [
    {
      id: ids.dir(account),
      account_id: account,
      parent_id: null,
      name: "Documents",
      node_type: "directory",
      blob_id: null,
      size: null,
      type: null,
      created: now,
      modified: now,
      accessed: now,
      changed: now,
      executable: 0,
      is_subscribed: 1,
      role: null,
    },
  ]);
  for (let n = 1; n <= 3; n++) {
    w.db.seed("file_nodes", [
      {
        id: ids.file(account, n),
        account_id: account,
        parent_id: ids.dir(account),
        name: `file-${n}.txt`,
        node_type: "file",
        blob_id: `blob_${account}`,
        size: 4,
        type: "text/plain",
        created: now,
        modified: now,
        accessed: now,
        changed: now,
        executable: 0,
        is_subscribed: 1,
        role: null,
      },
    ]);
  }
}
