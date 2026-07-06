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

  async call(methodCalls: Invocation[]): Promise<Invocation[]> {
    const session = await this.session();
    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ using: USING, methodCalls }),
    });
    if (!res.ok) throw new Error(`JMAP request failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { methodResponses: Invocation[] };
    return body.methodResponses;
  }

  /** Single method call; throws on a method-level error response. */
  async one(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [resp] = await this.call([[name, args, "c0"]]);
    if (!resp) throw new Error(`no response for ${name}`);
    if (resp[0] === "error") {
      const err = new Error(`${name} → ${JSON.stringify(resp[1])}`);
      (err as Error & { jmapType?: string }).jmapType = (resp[1] as { type?: string }).type;
      throw err;
    }
    return resp[1];
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
