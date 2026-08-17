/** Minimal JMAP client over fetch — just what the sync engine needs. */

export type Invocation = [string, Record<string, unknown>, string];

export interface Session {
  accounts: Record<
    string,
    {
      name: string;
      /** False for grant-reached (shared/delegated) accounts. */
      isPersonal?: boolean;
      /** Per-account capability URNs — the fleet host's discovery surface:
       * a whole-account grant exposes the agent capability, a book-scoped
       * one only contacts (services/jmap/src/session.ts). Optional because
       * older CLI configs may talk to servers predating the field. */
      accountCapabilities?: Record<string, unknown>;
    }
  >;
  primaryAccounts: Record<string, string>;
  apiUrl: string;
  downloadUrl: string;
  username: string;
}

/** One stored object, as `GET /api/blobs/{accountId}` reports it. */
export interface BlobEntry {
  blobId: string;
  size: number;
  uploaded: string;
}

export interface BlobListing {
  accountId: string;
  blobs: BlobEntry[];
  totalSize: number;
  cursor?: string;
}

/** One minted share link, as `GET /api/shares/{accountId}` reports it. */
export interface ShareEntry {
  shareId: string;
  blobId: string;
  name: string;
  type?: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  /** Unrevoked and unexpired — i.e. this URL still resolves. */
  live: boolean;
}

export interface ShareListing {
  accountId: string;
  shares: ShareEntry[];
}

export interface RevokeResult {
  shareId: string;
  revoked: boolean;
  alreadyRevoked: boolean;
  blobId: string | null;
  note: string;
}

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];

/**
 * Every error this client throws carries the machine-readable half of what the
 * server said, so `io.exitCodeFor` can map it to an exit code (`arch.md` §1.5)
 * without re-parsing a human message. `jmapType` is the RFC 8620 error type
 * when there is one; `httpStatus` is the transport status for the endpoints
 * outside the JMAP envelope (`/auth`, `/api/blobs`, `/api/shares`, upload).
 */
export interface JmapError extends Error {
  jmapType?: string;
  httpStatus?: number;
}

/**
 * Non-JMAP endpoints answer a refusal with a JSON body; several of them name a
 * `type` (or an `error`) in it. Lift that when present — a 409 that says
 * `blob in use` should not be indistinguishable from any other 409.
 */
function transportError(message: string, status: number, body: string): JmapError {
  const err = new Error(message) as JmapError;
  err.httpStatus = status;
  try {
    const parsed = JSON.parse(body) as { type?: unknown; error?: unknown };
    const type = typeof parsed.type === "string" ? parsed.type : parsed.error;
    if (typeof type === "string") err.jmapType = type;
  } catch {
    /* not JSON — the status alone decides the exit code */
  }
  return err;
}

export class JmapClient {
  private sessionCache?: Session;

  constructor(
    private base: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  /**
   * `session()` with the cache dropped — for consumers whose account SET is
   * dynamic. The fleet host re-resolves "which accounts granted me claim?"
   * on every discovery refresh; serving yesterday's cached session would hold
   * a revoked binding open and hide a freshly granted one.
   */
  async refreshSession(): Promise<Session> {
    this.sessionCache = undefined;
    return this.session();
  }

  async session(): Promise<Session> {
    if (this.sessionCache) return this.sessionCache;
    const res = await fetch(`${this.base}/.well-known/jmap`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text();
      throw transportError(`session fetch failed: HTTP ${res.status} ${body}`, res.status, body);
    }
    this.sessionCache = (await res.json()) as Session;
    return this.sessionCache;
  }

  async call(methodCalls: Invocation[], using: string[] = USING): Promise<Invocation[]> {
    const session = await this.session();
    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw transportError(`JMAP request failed: HTTP ${res.status} ${text}`, res.status, text);
    }
    const body = (await res.json()) as { methodResponses: Invocation[] };
    return body.methodResponses;
  }

  /**
   * Single method call; throws on a method-level error response.
   *
   * The returned record is the whole result, `newState` and all — which is why
   * `--if-state` (`arch.md` §1.7) needed no new plumbing: a `/set` reply's
   * `oldState`/`newState` are already here for a caller to chain, and an
   * `ifInState` mismatch comes back as a method-level `stateMismatch`, whose
   * type lands on `jmapType` below and maps to exit 5.
   */
  async one(name: string, args: Record<string, unknown>, using?: string[]): Promise<Record<string, unknown>> {
    const [resp] = await this.call([[name, args, "c0"]], using);
    if (!resp) throw new Error(`no response for ${name}`);
    if (resp[0] === "error") {
      const detail = resp[1] as { type?: string; description?: string };
      const err = new Error(
        `${name} → ${detail.type ?? "error"}${detail.description ? `: ${detail.description}` : ""}`,
      ) as JmapError;
      err.jmapType = detail.type;
      throw err;
    }
    return resp[1];
  }

  /** RFC 8620 §6.1 blob upload; returns the content-hash blobId. */
  async upload(accountId: string, content: Uint8Array, type: string): Promise<{ blobId: string; size: number }> {
    const res = await fetch(`${this.base}/api/upload/${encodeURIComponent(accountId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": type },
      // Copy into a fresh ArrayBuffer-backed view: fetch rejects
      // SharedArrayBuffer-typed views, and Node types demand it.
      body: new Uint8Array(content),
    });
    if (!res.ok) {
      const body = await res.text();
      throw transportError(`upload failed: HTTP ${res.status} ${body}`, res.status, body);
    }
    return (await res.json()) as { blobId: string; size: number };
  }

  /** Mint an expiring public link for an uploaded blob (big-file sends). */
  async createShareLink(
    accountId: string,
    blobId: string,
    opts: { name: string; type?: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: string }> {
    const res = await fetch(`${this.base}/api/share/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const body = await res.text();
      throw transportError(`share link failed: HTTP ${res.status} ${body}`, res.status, body);
    }
    return (await res.json()) as { url: string; expiresAt: string };
  }

  // ---- blob + share lifecycle (sVOL 010) -------------------------------
  //
  // These hardcode paths on `this.base`, as `upload` and `createShareLink`
  // already do. `downloadBlob` resolves through the session's `downloadUrl`
  // template because RFC 8620 §2 defines one; there is no session template for
  // blob enumeration, delete, or share management, so there is nothing to
  // resolve through. Adding non-standard members to the session resource to
  // create one would be worse than this.

  /** Every object stored for the account — the only way to see what R2 holds. */
  async listBlobs(accountId: string): Promise<BlobListing> {
    return this.getJson<BlobListing>(`/api/blobs/${encodeURIComponent(accountId)}`, "blobs list");
  }

  /** Explicit single-blob delete. Refused (409) if mail or a share needs it. */
  async deleteBlob(accountId: string, blobId: string): Promise<{ blobId: string }> {
    return this.sendJson<{ blobId: string }>(
      "DELETE",
      `/api/blobs/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}`,
      "blobs rm",
    );
  }

  /** Every share link the server still has a record of, live or revoked. */
  async listShares(accountId: string): Promise<ShareListing> {
    return this.getJson<ShareListing>(`/api/shares/${encodeURIComponent(accountId)}`, "share list");
  }

  /** The kill switch. Eventually consistent — see the note in the response. */
  async revokeShare(accountId: string, shareId: string): Promise<RevokeResult> {
    return this.sendJson<RevokeResult>(
      "POST",
      `/api/shares/${encodeURIComponent(accountId)}/${encodeURIComponent(shareId)}/revoke`,
      "share revoke",
    );
  }

  private async getJson<T>(path: string, what: string): Promise<T> {
    return this.sendJson<T>("GET", path, what);
  }

  /**
   * The server answers a refusal with a JSON body that names the reason
   * (`blob in use` + the message ids, `blob shared` + the share ids). Surface
   * that verbatim — a bare "HTTP 409" would drop the one part a human needs.
   */
  private async sendJson<T>(method: string, path: string, what: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { method, headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw transportError(`${what} failed: HTTP ${res.status} ${text}`, res.status, text);
    return JSON.parse(text) as T;
  }

  async downloadBlob(accountId: string, blobId: string): Promise<Uint8Array> {
    const session = await this.session();
    const url = session.downloadUrl
      .replaceAll("{accountId}", encodeURIComponent(accountId))
      .replaceAll("{blobId}", encodeURIComponent(blobId))
      .replaceAll("{name}", "blob")
      .replaceAll("{type}", encodeURIComponent("application/octet-stream"));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw transportError(`blob download failed: HTTP ${res.status}`, res.status, "");
    return new Uint8Array(await res.arrayBuffer());
  }
}
