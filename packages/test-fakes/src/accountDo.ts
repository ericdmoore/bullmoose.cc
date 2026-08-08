import { AccountDO, type ChangeEntry, type CommitBody } from "@bullmoose/account-do";

/**
 * An `ACCOUNT_DO` binding that runs the REAL `AccountDO` over an in-memory
 * `DurableObjectState`.
 *
 * The point of running the real class rather than stubbing `/state` and
 * `/commit` with canned JSON — which is what the two hand-rolled DO fakes did —
 * is that the changelog is the thing under test. `_context.md` §3: a write that
 * lands the row but skips `commitChanges` reads back fine on a direct `get` and
 * is invisible to every incremental consumer. That bug is only catchable by a
 * test that asks `Foo/changes` what happened, and a canned `{newState: "s2"}`
 * answers that question identically whether or not the choreography ran.
 *
 * With the real class, `GET /changes` does real collapse semantics (created →
 * destroyed cancels out), real `sinceState` window checks, and real 409s.
 * Nothing here re-implements the DO, so nothing here can drift from it.
 *
 * Not modelled: WebSocket push (`getWebSockets()` returns nothing, so
 * `broadcast` is a no-op and `acceptWebSocket` is a stub), alarm scheduling
 * (`setAlarm` is recorded, never fires — call `runAlarm()` to drive it),
 * `storage.transaction()` (runs the closure with no rollback on throw), DO
 * storage's real serialization limits, and `DurableObjectId` identity
 * (`equals()` always returns false, `newUniqueId()` is a constant). `GET /ws`
 * reaches the DO with its headers intact but cannot complete: `WebSocketPair`
 * is a workerd global with no Node equivalent. Storage
 * values ARE structured-cloned, so a test cannot accidentally assert on an
 * object the DO still holds a live reference to.
 */

interface StorageListOptions {
  prefix?: string;
  start?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

class FakeDurableObjectStorage {
  private readonly map = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      for (const k of key) if (this.map.has(k)) out.set(k, structuredClone(this.map.get(k)) as T);
      return out;
    }
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, structuredClone(value));
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, structuredClone(v));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let n = 0;
      for (const k of key) if (this.map.delete(k)) n++;
      return n;
    }
    return this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async list<T>(options: StorageListOptions = {}): Promise<Map<string, T>> {
    let keys = [...this.map.keys()].sort();
    if (options.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!));
    if (options.start) keys = keys.filter((k) => k >= options.start!);
    if (options.end) keys = keys.filter((k) => k < options.end!);
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  async transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T> {
    return closure(this);
  }

  async sync(): Promise<void> {}
}

/** The changelog `/changes` body, as the DO returns it. */
export interface ChangesBody {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface FakeAccountDo {
  /** The binding itself — assign straight to `env.ACCOUNT_DO`. */
  readonly ns: DurableObjectNamespace;
  /** Every commit body the changelog received, in order. */
  readonly commits: CommitBody[];
  /** Current state string for an account (`GET /state`). */
  state(accountId: string): Promise<string>;
  /** `GET /changes` — the real method, collapse semantics and all. */
  changes(accountId: string, collection: string, since?: string): Promise<ChangesBody>;
  /** Raw changelog entries for an account, oldest first. */
  log(accountId: string): Promise<ChangeEntry[]>;
  /** The alarm the DO has scheduled, if any. */
  alarmAt(accountId: string): number | null;
  /** Fire the DO's alarm handler now (armed responders). */
  runAlarm(accountId: string): Promise<void>;
}

/**
 * @param env bindings the DO itself needs — only for responder firing
 *   (`DB`/`BLOBS`/`SUBMIT`/`INTERNAL_TOKEN`). The changelog paths need none.
 */
export function fakeAccountDo(env: Record<string, unknown> = {}): FakeAccountDo {
  const instances = new Map<string, { obj: AccountDO; storage: FakeDurableObjectStorage }>();
  const commits: CommitBody[] = [];

  const instance = (name: string) => {
    let existing = instances.get(name);
    if (!existing) {
      const storage = new FakeDurableObjectStorage();
      const ctx = {
        id: { toString: () => name, name, equals: (o: { toString(): string }) => String(o) === name },
        storage,
        waitUntil: () => {},
        blockConcurrencyWhile: <T>(cb: () => Promise<T>) => cb(),
        acceptWebSocket: () => {},
        getWebSockets: () => [],
        setWebSocketAutoResponse: () => {},
        getWebSocketAutoResponse: () => null,
        getWebSocketAutoResponseTimestamp: () => null,
        setHibernatableWebSocketEventTimeout: () => {},
        getHibernatableWebSocketEventTimeout: () => null,
        getTags: () => [],
        abort: () => {},
        // The DO's own type surface is large and entirely irrelevant to the
        // four routes under test; one cast here beats one per test file.
      } as unknown as DurableObjectState;
      existing = { obj: new AccountDO(ctx, env), storage };
      instances.set(name, existing);
    }
    return existing;
  };

  /**
   * Normalize every call shape the tree uses into one Request the DO can read.
   * There are three, and the third is easy to miss:
   *   accountStub(ns, id).fetch("https://do/state")                  url only
   *   accountStub(ns, id).fetch(url, { method, body })               url + init
   *   accountStub(ns, id).fetch("https://do/ws", request)            url + REQUEST
   * The last is `services/jmap/src/index.ts:96`, and it is why HEADERS must be
   * carried: `AccountDO.upgradeWebSocket` refuses anything without
   * `Upgrade: websocket`, so dropping them would turn a working upgrade into a
   * 426 that only the fake produces.
   *
   * Bodies are read to text rather than forwarded as streams — piping a
   * ReadableStream into `new Request` needs `duplex: "half"`, and text keeps
   * the body replayable for the `commits` log.
   */
  const call = async (
    name: string,
    input: RequestInfo | URL,
    init?: RequestInit | Request,
  ): Promise<Response> => {
    const from = input instanceof Request ? input : null;
    const over = init instanceof Request ? init : null;
    const plainInit = over ? null : (init as RequestInit | undefined);

    const url = from ? from.url : String(input);
    const method = over?.method ?? (plainInit?.method as string | undefined) ?? from?.method ?? "GET";
    const headers = new Headers(over?.headers ?? plainInit?.headers ?? from?.headers ?? undefined);

    let body: string | null = null;
    if (method !== "GET" && method !== "HEAD") {
      if (over) body = await over.clone().text();
      else if (plainInit?.body != null) body = String(plainInit.body);
      else if (from) body = await from.clone().text();
    }

    if (method === "POST" && url.endsWith("/commit") && body !== null) {
      commits.push(JSON.parse(body) as CommitBody);
    }
    return instance(name).obj.fetch(new Request(url, { method, headers, body }));
  };

  const stubFor = (name: string) => ({
    id: { toString: () => name, name },
    name,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => call(name, input, init),
  });

  const ns = {
    idFromName: (name: string) => ({ toString: () => name, name, equals: () => false }),
    idFromString: (id: string) => ({ toString: () => id, name: id, equals: () => false }),
    newUniqueId: () => ({ toString: () => "unique", name: undefined, equals: () => false }),
    get: (id: { toString(): string }) => stubFor(String(id)),
    getExisting: (id: { toString(): string }) => stubFor(String(id)),
    jurisdiction: () => ns,
    // Same bargain as DurableObjectState above: the binding's RPC-branded type
    // is unsatisfiable structurally, and no test touches it.
  } as unknown as DurableObjectNamespace;

  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  return {
    ns,
    commits,
    async state(accountId) {
      return (await json<{ state: string }>(await call(accountId, "https://do/state"))).state;
    },
    async changes(accountId, collection, since = "0") {
      const url = new URL("https://do/changes");
      url.searchParams.set("collection", collection);
      url.searchParams.set("since", since);
      const res = await call(accountId, url.toString());
      if (!res.ok) throw new Error(`fakeAccountDo: /changes returned ${res.status}`);
      return json<ChangesBody>(res);
    },
    async log(accountId) {
      const entries = await instance(accountId).storage.list<ChangeEntry>({ prefix: "log:" });
      return [...entries.values()];
    },
    alarmAt(accountId) {
      return instance(accountId).storage.alarm;
    },
    async runAlarm(accountId) {
      await instance(accountId).obj.alarm();
    },
  };
}
