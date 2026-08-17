// The one load-bearing abstraction of the webmail floor (arch.md §2).
//
// A single module owns ALL protocol contact with the server. Three properties
// it must have, all exercised by JmapClient.test.ts:
//   1. Injected, never a singleton  — components receive it; tests pass a fake
//      (or, for the real client, a fake `fetch`) and touch no network.
//   2. Batched by default           — many calls, one round trip, with
//      RFC 8620 §3.7 back-references so a thread open is one request, not N.
//   3. Capability-aware             — `using[]` is computed from the LIVE
//      session, so a surface whose capability is absent never sends a call
//      that would 400.
//
// T2 (mail surfaces) and T3 (the Files browser, `../files/`) both develop
// against this module alongside FakeJmapClient. T3 is the surface that finally
// CALLS `upload` — every file in the browser is `upload` then
// `FileNode/set create`, in that order (`../files/api.ts`).
//
// Note that `sync`, `cursor` and `seedCursor` are built and tested but reached
// by NO surface: every screen syncs by re-querying on a push notification
// rather than walking a /changes cursor. Tested-but-unreached, which is the
// opposite of dead code and worth knowing before assuming a gap is work.

import { AGENT_CAP, CORE_CAP, capabilityForMethod, hasCapability } from "./capabilities";
import type { ChangesResult, Id, Invocation, ResultReference, Session, UploadResult } from "./types";

/** Build an RFC 8620 §3.7 back-reference to a prior call's result. */
export function backReference(resultOf: string, name: string, path: string): ResultReference {
  return { resultOf, name, path };
}

/** A method-level or transport-level JMAP failure, carrying the server's type. */
export class JmapRequestError extends Error {
  constructor(
    message: string,
    readonly jmapType?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "JmapRequestError";
  }
}

/** Minimal shape of a browser WebSocket — the bit the push loop needs. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RequestOptions {
  /** Override the computed `using[]`. Normally leave unset — see arch.md §2. */
  using?: string[];
}

export interface WatchOptions {
  accountId?: string;
  onStatus?: (status: string) => void;
}

/**
 * The interface every surface receives. FetchJmapClient is the real
 * implementation; FakeJmapClient (FakeJmapClient.ts) implements the same shape
 * for tests and for the T2 UI to develop against — mirroring how the CLI has a
 * FakeJmapClient / @bullmoose/test-fakes.
 */
export interface JmapClient {
  session(): Promise<Session>;
  capabilities(): Promise<string[]>;
  hasCapability(urn: string): Promise<boolean>;
  hasAgentCapability(): Promise<boolean>;
  primaryAccountId(capability?: string): Promise<Id>;
  request(methodCalls: Invocation[], opts?: RequestOptions): Promise<Invocation[]>;
  requestOne(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  queryThenGet(
    accountId: Id,
    queryMethod: string,
    queryArgs: Record<string, unknown>,
    getMethod: string,
    properties?: string[] | null,
  ): Promise<{ query: Record<string, unknown>; get: Record<string, unknown> }>;
  sync(collection: string, sinceState?: string, accountId?: Id): Promise<ChangesResult>;
  cursor(collection: string): string | undefined;
  seedCursor(collection: string, state: string): void;
  /**
   * `POST {uploadUrl}` with the bytes as the RAW body (RFC 8620 §6.1, and
   * `services/jmap/src/index.ts:199-221` — the handler reads
   * `request.arrayBuffer()`, so a multipart/FormData envelope would be stored
   * verbatim AS the blob). A `Blob` is passed to `fetch` untouched so the
   * browser streams it: a 40 MB upload must not be materialised in the tab's
   * heap first. `Uint8Array` stays accepted for tests and the CLI-shaped path.
   */
  upload(accountId: Id, body: Blob | Uint8Array, type: string): Promise<UploadResult>;
  download(accountId: Id, blobId: string, opts?: { name?: string; type?: string }): Promise<Uint8Array>;
  watch(onChange: (changed: Record<Id, Record<string, string>>) => void, opts?: WatchOptions): Promise<() => void>;
}

export interface FetchJmapClientOptions {
  baseUrl: string;
  token: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to `new WebSocket(url)`. */
  webSocketFactory?: WebSocketFactory;
}

const WS_BACKOFF_MIN_MS = 1_000;
const WS_BACKOFF_MAX_MS = 30_000;

/** The real client: JMAP over `fetch`, push over a WebSocket. */
export class FetchJmapClient implements JmapClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly makeSocket: WebSocketFactory;
  private sessionCache?: Session;
  /** Per-collection `/changes` cursor (arch.md §3). */
  private readonly cursors = new Map<string, string>();

  constructor(opts: FetchJmapClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    // Bind so a bare `this.doFetch(...)` keeps the correct receiver.
    this.doFetch = (opts.fetch ?? globalThis.fetch).bind(globalThis);
    this.makeSocket =
      opts.webSocketFactory ??
      ((url: string) => new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async session(): Promise<Session> {
    if (this.sessionCache) return this.sessionCache;
    const res = await this.doFetch(`${this.baseUrl}/.well-known/jmap`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new JmapRequestError(`session fetch failed: HTTP ${res.status}`, undefined, res.status);
    }
    this.sessionCache = (await res.json()) as Session;
    return this.sessionCache;
  }

  async capabilities(): Promise<string[]> {
    return Object.keys((await this.session()).capabilities);
  }

  async hasCapability(urn: string): Promise<boolean> {
    return hasCapability(await this.session(), urn);
  }

  async hasAgentCapability(): Promise<boolean> {
    return this.hasCapability(AGENT_CAP);
  }

  async primaryAccountId(capability = "urn:ietf:params:jmap:mail"): Promise<Id> {
    const session = await this.session();
    const id = session.primaryAccounts[capability];
    if (!id) throw new JmapRequestError(`no primary account for ${capability}`);
    return id;
  }

  /**
   * Compute `using[]` from the method calls, intersected with what the LIVE
   * session advertises. Core is always present. This is the guarantee that a
   * capability-less session never gets a request it would reject: if the agent
   * cap is absent, an AgentInvocation call simply doesn't put the agent URN in
   * `using[]` (invariant §6.4).
   */
  private async computeUsing(methodCalls: Invocation[]): Promise<string[]> {
    const session = await this.session();
    const wanted = new Set<string>([CORE_CAP]);
    for (const [name] of methodCalls) {
      const cap = capabilityForMethod(name);
      if (hasCapability(session, cap)) wanted.add(cap);
    }
    return [...wanted];
  }

  async request(methodCalls: Invocation[], opts: RequestOptions = {}): Promise<Invocation[]> {
    const session = await this.session();
    const using = opts.using ?? (await this.computeUsing(methodCalls));
    const res = await this.doFetch(session.apiUrl, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      throw new JmapRequestError(`JMAP request failed: HTTP ${res.status}`, undefined, res.status);
    }
    const body = (await res.json()) as { methodResponses: Invocation[] };
    return body.methodResponses;
  }

  /** One method call; throws on a method-level `error` response. */
  async requestOne(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [resp] = await this.request([[name, args, "c0"]]);
    if (!resp) throw new JmapRequestError(`no response for ${name}`);
    if (resp[0] === "error") {
      const detail = resp[1] as { type?: string; description?: string };
      throw new JmapRequestError(
        `${name} → ${detail.type ?? "error"}${detail.description ? `: ${detail.description}` : ""}`,
        detail.type,
      );
    }
    return resp[1];
  }

  /**
   * The batching proof (arch.md §2, invariant §6.5): a query followed by a get
   * of exactly the ids it returned, in ONE round trip, via a back-reference.
   * This is the shape a thread open uses — Email/query then Email/get(#ids) —
   * and the server resolves the `#ids` reference in `dispatch.ts`.
   */
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
          "#ids": backReference("q", queryMethod, "/ids"),
          ...(properties ? { properties } : {}),
        },
        "g",
      ],
    ];
    const responses = await this.request(calls);
    const query = responses.find((r) => r[2] === "q");
    const get = responses.find((r) => r[2] === "g");
    if (!query || query[0] === "error") {
      throw new JmapRequestError(`${queryMethod} failed`, (query?.[1] as { type?: string })?.type);
    }
    if (!get || get[0] === "error") {
      throw new JmapRequestError(`${getMethod} failed`, (get?.[1] as { type?: string })?.type);
    }
    return { query: query[1], get: get[1] };
  }

  /**
   * Advance the per-collection sync cursor by one `Foo/changes` call. Returns
   * the delta; the caller patches its store. `hasMoreChanges` signals the
   * caller to call again to drain (RFC 8620 §5.2). The cursor is the state the
   * push loop feeds off of (arch.md §3).
   */
  async sync(collection: string, sinceState?: string, accountId?: Id): Promise<ChangesResult> {
    const acct = accountId ?? (await this.primaryAccountId());
    const since = sinceState ?? this.cursors.get(collection);
    if (since === undefined) {
      throw new JmapRequestError(`no cursor for ${collection}; seed it from an initial /query first`);
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

  async upload(accountId: Id, body: Blob | Uint8Array, type: string): Promise<UploadResult> {
    const url = this.uploadUrlFor(await this.session(), accountId);
    const res = await this.doFetch(url, {
      method: "POST",
      headers: this.authHeaders({ "content-type": type }),
      // A Blob (every browser `File` is one) goes through as-is so fetch
      // streams it rather than buffering the whole file. A Uint8Array is
      // copied into a fresh ArrayBuffer-backed view: fetch rejects
      // SharedArrayBuffer-typed views (mirrors the CLI client).
      body: body instanceof Uint8Array ? new Uint8Array(body) : body,
    });
    if (!res.ok) {
      throw new JmapRequestError(`upload failed: HTTP ${res.status}`, undefined, res.status);
    }
    return (await res.json()) as UploadResult;
  }

  async download(accountId: Id, blobId: string, opts: { name?: string; type?: string } = {}): Promise<Uint8Array> {
    const session = await this.session();
    const url = session.downloadUrl
      .replaceAll("{accountId}", encodeURIComponent(accountId))
      .replaceAll("{blobId}", encodeURIComponent(blobId))
      .replaceAll("{name}", encodeURIComponent(opts.name ?? "blob"))
      .replaceAll("{type}", encodeURIComponent(opts.type ?? "application/octet-stream"));
    const res = await this.doFetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new JmapRequestError(`blob download failed: HTTP ${res.status}`, undefined, res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  private uploadUrlFor(session: Session, accountId: Id): string {
    if (session.uploadUrl.includes("{accountId}")) {
      return session.uploadUrl.replaceAll("{accountId}", encodeURIComponent(accountId));
    }
    return `${this.baseUrl}/api/upload/${encodeURIComponent(accountId)}`;
  }

  /**
   * Push-driven sync (arch.md §3): open `/api/ws`, and on each StateChange hand
   * the changed collections to `onChange` (which typically drives `sync`).
   * Reconnects with jittered backoff if the socket drops — modelling the CLI's
   * `watch` reconnect. The `/api/ws` push itself is server-owned [live]; here
   * the loop is what matters, and the socket factory is injected so tests drive
   * it without a real WebSocket.
   */
  async watch(
    onChange: (changed: Record<Id, Record<string, string>>) => void,
    opts: WatchOptions = {},
  ): Promise<() => void> {
    const session = await this.session();
    const accountId = opts.accountId ?? Object.keys(session.accounts)[0];
    if (!accountId) throw new JmapRequestError("no account to watch");

    const wsUrl = new URL(session.apiUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/api/ws";
    wsUrl.search = "";
    wsUrl.searchParams.set("accountId", accountId);
    // WebSocket clients can't set an Authorization header (auth-core reads the
    // `access_token` query param as the fallback — principal.ts:67).
    wsUrl.searchParams.set("access_token", this.token);

    let stopped = false;
    let backoff = WS_BACKOFF_MIN_MS;
    let socket: WebSocketLike | undefined;

    const connect = (): void => {
      if (stopped) return;
      socket = this.makeSocket(wsUrl.toString());
      socket.addEventListener("open", () => {
        backoff = WS_BACKOFF_MIN_MS;
        opts.onStatus?.("connected");
      });
      socket.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { "@type"?: string; changed?: unknown };
          if (msg["@type"] === "StateChange" && msg.changed) {
            onChange(msg.changed as Record<Id, Record<string, string>>);
          }
        } catch {
          /* not JSON — ignore */
        }
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        backoff = Math.min(backoff * 2, WS_BACKOFF_MAX_MS);
        opts.onStatus?.(`disconnected — retrying in ${Math.round(jitter / 1000)}s`);
        setTimeout(connect, jitter);
      });
      socket.addEventListener("error", () => {
        /* close fires next; reconnect there */
      });
    };
    connect();

    return () => {
      stopped = true;
      socket?.close();
    };
  }
}
