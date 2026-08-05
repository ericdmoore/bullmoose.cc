/**
 * JMAP autodiscovery (RFC 8620 §2.2): given only an email address,
 * find the server. Resolution ladder:
 *
 *   1. SRV _jmap._tcp.<domain> via node:dns          (native)
 *   2. same query via DNS-over-HTTPS (1.1.1.1)       (UDP-53-blocked envs)
 *   3. https://<domain>/.well-known/jmap             (spec fallback)
 *
 * An SRV target of "." means "service explicitly not offered" (RFC 2782)
 * and drops straight to the fallback.
 */

export interface Discovery {
  base: string;
  via: "srv" | "srv-doh" | "fallback";
  domain: string;
}

interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export async function resolveJmapBase(email: string): Promise<Discovery> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    console.error(`not an email address: ${email}`);
    process.exit(1);
  }
  const name = `_jmap._tcp.${domain}`;

  let records: SrvRecord[] | null = null;
  let via: Discovery["via"] = "srv";
  try {
    const { promises: dns } = await import("node:dns");
    const answers = await dns.resolveSrv(name);
    records = answers.map((a) => ({
      priority: a.priority,
      weight: a.weight,
      port: a.port,
      target: a.name,
    }));
  } catch {
    records = await resolveSrvDoH(name);
    via = "srv-doh";
  }

  const best = pickSrv(records ?? []);
  if (best) {
    const target = best.target.replace(/\.$/, "");
    const base = best.port === 443 ? `https://${target}` : `https://${target}:${best.port}`;
    return { base, via, domain };
  }
  return { base: `https://${domain}`, via: "fallback", domain };
}

/** RFC 2782 selection: lowest priority, then highest weight. */
function pickSrv(records: SrvRecord[]): SrvRecord | null {
  const usable = records.filter((r) => r.target && r.target !== ".");
  if (usable.length === 0) return null;
  usable.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  return usable[0] ?? null;
}

async function resolveSrvDoH(name: string): Promise<SrvRecord[] | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=SRV`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const records: SrvRecord[] = [];
    for (const a of data.Answer ?? []) {
      if (a.type !== 33) continue; // SRV
      const [priority, weight, port, target] = a.data.split(/\s+/);
      if (target) {
        records.push({
          priority: Number(priority),
          weight: Number(weight),
          port: Number(port),
          target,
        });
      }
    }
    return records;
  } catch {
    return null;
  }
}

/** Probe the session resource: is there a JMAP server at this base? */
export async function probeSession(
  base: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const res = await fetch(`${base}/.well-known/jmap`, { redirect: "follow" });
    if (res.status === 401) {
      return { ok: true, status: 401, detail: "JMAP server present (auth required — expected)" };
    }
    if (res.ok) {
      const type = res.headers.get("content-type") ?? "";
      return type.includes("json")
        ? { ok: true, status: res.status, detail: "JMAP session served" }
        : { ok: false, status: res.status, detail: `responds, but not with a JMAP session (${type})` };
    }
    return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
