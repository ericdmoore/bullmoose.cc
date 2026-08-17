/**
 * A `KVNamespace` that honours expiry the way the real namespace does.
 *
 * The two KV fakes this replaces disagreed: `authRoutes.test.ts` honoured
 * absolute `expiration` (its login-throttle tests turn on it), while
 * `mintScopes.test.ts` was a bare `Map` that ignored every option. A test
 * written against the second and run against the first behaves differently —
 * which is the whole argument for having one.
 *
 * Both `expiration` (absolute, seconds) and `expirationTtl` (relative,
 * seconds) are honoured, and reads are evaluated against `Date.now()` at read
 * time, so `vi.useFakeTimers()` drives expiry exactly as wall-clock does.
 */

export interface KvEntry {
  value: string;
  /** Absolute expiry in epoch SECONDS, as KV stores it. `undefined` = never. */
  expiration?: number;
  metadata?: unknown;
}

export interface FakeKV {
  /** The binding itself — assign straight to `env.ROUTES`. */
  readonly ns: KVNamespace;
  /** The backing store, for arrange/assert. Keys survive until read-time expiry. */
  readonly store: Map<string, KvEntry>;
}

export function fakeKV(): FakeKV {
  const store = new Map<string, KvEntry>();

  const live = (key: string): KvEntry | null => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiration !== undefined && entry.expiration * 1000 <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  const ns = {
    async get(key: string, options?: string | { type?: string }) {
      const entry = live(key);
      if (!entry) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? (JSON.parse(entry.value) as unknown) : entry.value;
    },
    async getWithMetadata(key: string) {
      const entry = live(key);
      return entry
        ? { value: entry.value, metadata: entry.metadata ?? null, cacheStatus: null }
        : { value: null, metadata: null, cacheStatus: null };
    },
    async put(
      key: string,
      value: string,
      options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
    ) {
      const expiration =
        options?.expiration ??
        (options?.expirationTtl !== undefined ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
      store.set(key, { value, expiration, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      let keys = [...store.keys()].filter((k) => live(k) !== null).sort();
      if (options?.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!));
      if (options?.limit !== undefined) keys = keys.slice(0, options.limit);
      return {
        keys: keys.map((name) => ({ name, expiration: store.get(name)?.expiration })),
        list_complete: true as const,
        cacheStatus: null,
      };
    },
    // KVNamespace's get/getWithMetadata carry ~a dozen overloads keyed on the
    // `type` option. The subset above is what the tree calls; one cast here.
  } as unknown as KVNamespace;

  return { ns, store };
}
