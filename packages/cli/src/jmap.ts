/** Minimal JMAP client over fetch — just what the sync engine needs. */

export type Invocation = [string, Record<string, unknown>, string];

export interface Session {
  accounts: Record<string, { name: string }>;
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

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

export class JmapClient {
  private sessionCache?: Session;

  constructor(
    private base: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  async session(): Promise<Session> {
    if (this.sessionCache) return this.sessionCache;
    const res = await fetch(`${this.base}/.well-known/jmap`, { headers: this.headers() });
    if (!res.ok) throw new Error(`session fetch failed: HTTP ${res.status} ${await res.text()}`);
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
    if (!res.ok) throw new Error(`JMAP request failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { methodResponses: Invocation[] };
    return body.methodResponses;
  }

  /** Single method call; throws on a method-level error response. */
  async one(
    name: string,
    args: Record<string, unknown>,
    using?: string[],
  ): Promise<Record<string, unknown>> {
    const [resp] = await this.call([[name, args, "c0"]], using);
    if (!resp) throw new Error(`no response for ${name}`);
    if (resp[0] === "error") {
      const err = new Error(`${name} → ${JSON.stringify(resp[1])}`);
      (err as Error & { jmapType?: string }).jmapType = (resp[1] as { type?: string }).type;
      throw err;
    }
    return resp[1];
  }

  /** RFC 8620 §6.1 blob upload; returns the content-hash blobId. */
  async upload(
    accountId: string,
    content: Uint8Array,
    type: string,
  ): Promise<{ blobId: string; size: number }> {
    const res = await fetch(`${this.base}/api/upload/${encodeURIComponent(accountId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "content-type": type },
      // Copy into a fresh ArrayBuffer-backed view: fetch rejects
      // SharedArrayBuffer-typed views, and Node types demand it.
      body: new Uint8Array(content),
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as { blobId: string; size: number };
  }

  /** Mint an expiring public link for an uploaded blob (big-file sends). */
  async createShareLink(
    accountId: string,
    blobId: string,
    opts: { name: string; type?: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: string }> {
    const res = await fetch(
      `${this.base}/api/share/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(opts),
      },
    );
    if (!res.ok) throw new Error(`share link failed: HTTP ${res.status} ${await res.text()}`);
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
    return this.getJson<ShareListing>(
      `/api/shares/${encodeURIComponent(accountId)}`,
      "share list",
    );
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
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text}`);
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
    if (!res.ok) throw new Error(`blob download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
