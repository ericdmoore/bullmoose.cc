/** Minimal JMAP client over fetch — just what the sync engine needs. */

export type Invocation = [string, Record<string, unknown>, string];

export interface Session {
  accounts: Record<string, { name: string }>;
  primaryAccounts: Record<string, string>;
  apiUrl: string;
  downloadUrl: string;
  username: string;
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
