// FakeJmapClient — the same JmapClient interface, backed by in-memory data and
// no network. Two audiences (mirroring how the CLI ships a FakeJmapClient /
// @bullmoose/test-fakes):
//   • tests — assert UI/data flow without a server;
//   • the T2/T3 UI (DEFERRED) — develop mail + Files surfaces against this
//     before the real endpoints are reachable.
//
// It resolves RFC 8620 §3.7 back-references locally (a compact version of the
// server's dispatch.ts) so `queryThenGet` and other batches behave like the
// real thing.

import {
  AGENT_CAP,
  CONTACTS_CAP,
  CALENDARS_CAP,
  CORE_CAP,
  FILENODE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  VACATION_CAP,
  WEBSOCKET_CAP,
  hasCapability,
} from "./capabilities";
import type { JmapClient, RequestOptions, WatchOptions } from "./JmapClient";
import { JmapRequestError } from "./JmapClient";
import type {
  ChangesResult,
  Id,
  Invocation,
  ResultReference,
  Session,
  UploadResult,
} from "./types";

export type MethodHandler = (
  args: Record<string, unknown>,
) => Record<string, unknown> | ["error", { type: string; description?: string }];

export interface FakeJmapClientOptions {
  /** Override any part of the default session (e.g. drop the agent cap). */
  session?: Partial<Session>;
  /** Method name → handler. `Foo/changes` handlers drive `sync`. */
  handlers?: Record<string, MethodHandler>;
  /** Pre-seeded blobs, by blobId. */
  blobs?: Record<string, Uint8Array>;
}

const DEFAULT_ACCOUNT = "acct-fake";

/** A full-capability default session, so the plain path "just works". */
function defaultSession(): Session {
  const allCaps = {
    [CORE_CAP]: {},
    [MAIL_CAP]: {},
    [SUBMISSION_CAP]: {},
    [VACATION_CAP]: {},
    [CONTACTS_CAP]: {},
    [CALENDARS_CAP]: {},
    [FILENODE_CAP]: {},
    [AGENT_CAP]: {},
    [WEBSOCKET_CAP]: { url: "wss://fake/api/ws", supportsPush: true },
  };
  return {
    capabilities: allCaps,
    accounts: {
      [DEFAULT_ACCOUNT]: {
        name: "fake@bullmoose.test",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: allCaps,
      },
    },
    primaryAccounts: {
      [MAIL_CAP]: DEFAULT_ACCOUNT,
      [SUBMISSION_CAP]: DEFAULT_ACCOUNT,
      [CONTACTS_CAP]: DEFAULT_ACCOUNT,
      [CALENDARS_CAP]: DEFAULT_ACCOUNT,
      [FILENODE_CAP]: DEFAULT_ACCOUNT,
    },
    username: "fake@bullmoose.test",
    apiUrl: "https://fake/api/jmap",
    downloadUrl: "https://fake/api/download/{accountId}/{blobId}/{name}?type={type}",
    uploadUrl: "https://fake/api/upload/{accountId}",
    eventSourceUrl: "https://fake/api/eventsource",
    state: "0",
  };
}

export class FakeJmapClient implements JmapClient {
  private readonly sessionObj: Session;
  private readonly handlers: Map<string, MethodHandler>;
  private readonly blobs: Map<string, Uint8Array>;
  private readonly cursors = new Map<string, string>();
  /** Every batch the caller sent — for assertions. */
  readonly sentBatches: Invocation[][] = [];
  private watcher?: (changed: Record<Id, Record<string, string>>) => void;
  private uploadSeq = 0;

  constructor(opts: FakeJmapClientOptions = {}) {
    const base = defaultSession();
    this.sessionObj = { ...base, ...opts.session };
    this.handlers = new Map(Object.entries(opts.handlers ?? {}));
    this.blobs = new Map(Object.entries(opts.blobs ?? {}));
  }

  /** Register or replace a method handler after construction. */
  setHandler(name: string, handler: MethodHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  async session(): Promise<Session> {
    return this.sessionObj;
  }

  async capabilities(): Promise<string[]> {
    return Object.keys(this.sessionObj.capabilities);
  }

  async hasCapability(urn: string): Promise<boolean> {
    return hasCapability(this.sessionObj, urn);
  }

  async hasAgentCapability(): Promise<boolean> {
    return this.hasCapability(AGENT_CAP);
  }

  async primaryAccountId(capability = MAIL_CAP): Promise<Id> {
    const id = this.sessionObj.primaryAccounts[capability];
    if (!id) throw new JmapRequestError(`no primary account for ${capability}`);
    return id;
  }

  async request(methodCalls: Invocation[], _opts: RequestOptions = {}): Promise<Invocation[]> {
    this.sentBatches.push(methodCalls);
    const responses: Invocation[] = [];
    for (const [name, rawArgs, callId] of methodCalls) {
      const handler = this.handlers.get(name);
      if (!handler) {
        responses.push(["error", { type: "unknownMethod" }, callId]);
        continue;
      }
      const args = resolveReferences(rawArgs, responses);
      const result = handler(args);
      if (Array.isArray(result) && result[0] === "error") {
        responses.push(["error", result[1], callId]);
      } else {
        responses.push([name, result as Record<string, unknown>, callId]);
      }
    }
    return responses;
  }

  async requestOne(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const [resp] = await this.request([[name, args, "c0"]]);
    if (!resp) throw new JmapRequestError(`no response for ${name}`);
    if (resp[0] === "error") {
      const detail = resp[1] as { type?: string; description?: string };
      throw new JmapRequestError(`${name} → ${detail.type ?? "error"}`, detail.type);
    }
    return resp[1];
  }

  async queryThenGet(
    accountId: Id,
    queryMethod: string,
    queryArgs: Record<string, unknown>,
    getMethod: string,
    properties: string[] | null = null,
  ): Promise<{ query: Record<string, unknown>; get: Record<string, unknown> }> {
    const calls: Invocation[] = [
      [queryMethod, { accountId, ...queryArgs }, "q"],
      [
        getMethod,
        {
          accountId,
          "#ids": { resultOf: "q", name: queryMethod, path: "/ids" } satisfies ResultReference,
          ...(properties ? { properties } : {}),
        },
        "g",
      ],
    ];
    const responses = await this.request(calls);
    const query = responses.find((r) => r[2] === "q");
    const get = responses.find((r) => r[2] === "g");
    if (!query || query[0] === "error") throw new JmapRequestError(`${queryMethod} failed`);
    if (!get || get[0] === "error") throw new JmapRequestError(`${getMethod} failed`);
    return { query: query[1], get: get[1] };
  }

  async sync(collection: string, sinceState?: string, accountId?: Id): Promise<ChangesResult> {
    const acct = accountId ?? (await this.primaryAccountId());
    const since = sinceState ?? this.cursors.get(collection);
    if (since === undefined) {
      throw new JmapRequestError(`no cursor for ${collection}; seed it first`);
    }
    const result = (await this.requestOne(`${collection}/changes`, {
      accountId: acct,
      sinceState: since,
    })) as unknown as ChangesResult;
    this.cursors.set(collection, result.newState);
    return result;
  }

  cursor(collection: string): string | undefined {
    return this.cursors.get(collection);
  }

  seedCursor(collection: string, state: string): void {
    this.cursors.set(collection, state);
  }

  async upload(_accountId: Id, bytes: Uint8Array, _type: string): Promise<UploadResult> {
    const blobId = `blob-${++this.uploadSeq}`;
    this.blobs.set(blobId, new Uint8Array(bytes));
    return { blobId, size: bytes.byteLength };
  }

  async download(_accountId: Id, blobId: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(blobId);
    if (!bytes) throw new JmapRequestError(`blob not found: ${blobId}`, undefined, 404);
    return bytes;
  }

  async watch(
    onChange: (changed: Record<Id, Record<string, string>>) => void,
    _opts: WatchOptions = {},
  ): Promise<() => void> {
    this.watcher = onChange;
    return () => {
      this.watcher = undefined;
    };
  }

  /** Test hook: simulate a server StateChange push. */
  emitStateChange(changed: Record<Id, Record<string, string>>): void {
    this.watcher?.(changed);
  }
}

// ── local back-reference resolver (compact mirror of dispatch.ts) ──────────

/** Replace `#key` result-reference args with values from prior responses. */
function resolveReferences(
  args: Record<string, unknown>,
  prior: Invocation[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      out[key] = value;
      continue;
    }
    const ref = value as ResultReference;
    const source = prior.find(([n, , id]) => id === ref.resultOf && n === ref.name);
    if (!source) {
      throw new JmapRequestError(`no prior ${ref.name} response for "${ref.resultOf}"`);
    }
    out[key.slice(1)] = evalPointer(source[1], ref.path);
  }
  return out;
}

function evalPointer(value: unknown, path: string): unknown {
  const tokens = path
    .split("/")
    .filter((t, i) => !(i === 0 && t === ""))
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  return walk(value, tokens);
}

function walk(value: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return value;
  const [token, ...rest] = tokens as [string, ...string[]];
  if (token === "*") {
    if (!Array.isArray(value)) throw new JmapRequestError(`"*" applied to non-array`);
    const mapped = value.map((item) => walk(item, rest));
    return rest.includes("*") || mapped.every(Array.isArray) ? mapped.flat(1) : mapped;
  }
  if (Array.isArray(value)) return walk(value[Number(token)], rest);
  if (value !== null && typeof value === "object" && token in (value as object)) {
    return walk((value as Record<string, unknown>)[token], rest);
  }
  throw new JmapRequestError(`path segment "${token}" not found`);
}
