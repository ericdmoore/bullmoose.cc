/**
 * An in-memory `BLOBS` binding.
 *
 * `storeFor` is `new Mailstore(ctx.env.DB, ctx.env.BLOBS)`
 * (`services/jmap/src/methods/common.ts:117`), so every JMAP method test needs
 * an R2 whether or not it reads a blob — which is why four of the five fakes
 * this replaces passed `BLOBS: {}` and would have thrown the moment a test
 * touched a message body. This is small, but it is the difference between "the
 * write path is untestable" and "the write path is tested".
 *
 * Implements the subset `Mailstore` uses (`put` / `get` / `head` / `delete` /
 * `list`). Multipart upload is not modelled; nothing in the tree calls it.
 */

export interface StoredObject {
  key: string;
  body: Uint8Array;
  uploaded: Date;
}

export interface FakeR2 {
  /** The binding itself — assign straight to `env.BLOBS`. */
  readonly bucket: R2Bucket;
  /** Everything currently stored, keyed by R2 key. */
  readonly objects: Map<string, StoredObject>;
  /** Bytes at a key, for arrange/assert without going through R2's API. */
  bytes(key: string): Uint8Array | null;
  put(key: string, body: ArrayBuffer | Uint8Array | string): void;
}

const toBytes = (body: unknown): Uint8Array => {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body === null || body === undefined) return new Uint8Array(0);
  throw new TypeError(`fakeR2: unsupported body ${Object.prototype.toString.call(body)}`);
};

export function fakeR2(): FakeR2 {
  const objects = new Map<string, StoredObject>();

  const meta = (obj: StoredObject) => ({
    key: obj.key,
    version: "v1",
    size: obj.body.byteLength,
    etag: `${obj.body.byteLength}`,
    httpEtag: `"${obj.body.byteLength}"`,
    uploaded: obj.uploaded,
    checksums: { toJSON: () => ({}) },
    customMetadata: {},
    httpMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata: () => {},
  });

  const withBody = (obj: StoredObject) => {
    // `.slice()` so a consumer cannot mutate what the bucket still holds.
    const buf = () => obj.body.slice().buffer as ArrayBuffer;
    return {
      ...meta(obj),
      get body() {
        return new Response(obj.body.slice()).body;
      },
      bodyUsed: false,
      arrayBuffer: async () => buf(),
      bytes: async () => obj.body.slice(),
      text: async () => new TextDecoder().decode(obj.body),
      json: async () => JSON.parse(new TextDecoder().decode(obj.body)) as unknown,
      blob: async () => new Blob([obj.body.slice()]),
    };
  };

  const bucket = {
    async put(key: string, body: unknown) {
      const obj: StoredObject = { key, body: toBytes(body), uploaded: new Date() };
      objects.set(key, obj);
      return meta(obj);
    },
    async get(key: string) {
      const obj = objects.get(key);
      return obj ? withBody(obj) : null;
    },
    async head(key: string) {
      const obj = objects.get(key);
      return obj ? meta(obj) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      let keys = [...objects.keys()].sort();
      if (options?.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!));
      if (options?.limit !== undefined) keys = keys.slice(0, options.limit);
      return {
        objects: keys.map((k) => meta(objects.get(k)!)),
        truncated: false as const,
        delimitedPrefixes: [],
      };
    },
    createMultipartUpload() {
      throw new Error("fakeR2: multipart upload is not modelled");
    },
    resumeMultipartUpload() {
      throw new Error("fakeR2: multipart upload is not modelled");
    },
    // R2Object/R2ObjectBody are classes with branded members; the subset above
    // is everything Mailstore reads. One cast here, none in the test files.
  } as unknown as R2Bucket;

  return {
    bucket,
    objects,
    bytes: (key) => objects.get(key)?.body.slice() ?? null,
    put: (key, body) => {
      objects.set(key, { key, body: toBytes(body), uploaded: new Date() });
    },
  };
}
