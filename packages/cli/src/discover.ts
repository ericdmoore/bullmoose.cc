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
 *
 * ⚠️ Rung 3 is the LIVE path for bullmoose.cc, and rung 1 is not a miss by
 * accident: the `_jmap._tcp` record was retired because Cloudflare cannot serve
 * a working SRV for a PROXIED host — the record must name a hostname that
 * resolves to the origin, and a proxied one does not. Both rungs stay
 * implemented (a self-hosted deployment can still publish SRV, and RFC 8620
 * says to look) but nothing here may ASSUME the SRV rung answers. The same
 * warning is on cli-go/internal/discover/discover.go.
 *
 * ── Why the fallback now FOLLOWS the redirect ─────────────────────────────
 *
 * `https://<domain>/.well-known/jmap` is allowed to redirect, and RFC 8620 §2.2
 * says the client follows it — the session resource lives at the FINAL URL. It
 * is not a detail here: `bullmoose.cc` is a Pages site that 302s exactly that
 * one path to `https://app.bullmoose.cc/.well-known/jmap` (src/public/_redirects)
 * and serves nothing else the CLI needs. Returning the domain unfollowed made
 * `bullmoose login you@bullmoose.cc` (no --base) store `https://bullmoose.cc`
 * and then POST `/auth/login` to it — HTTP 405, because that path is not
 * redirected and Pages has no such route. So the probe reports the origin the
 * session resource actually answered on, and that origin — not the name we
 * started from — is the base.
 */

export interface Discovery {
  base: string;
  via: "srv" | "srv-doh" | "fallback";
  domain: string;
  /**
   * The base we started from, when the session resource redirected off it.
   * Present only on a CROSS-ORIGIN redirect, i.e. only when `base` was rewritten.
   */
  redirectedFrom?: string;
  /**
   * The session probe that settled it — undefined only when the network was
   * unreachable enough that no probe was attempted (`probe.ok === false`
   * otherwise). `login` and `discover` both report it rather than re-probing.
   */
  probe?: SessionProbe;
}

/**
 * bullmoose.cc's own deployment, for the one place a message has to name
 * something concrete: the repair hint on a stored base that has gone 404
 * (`db.ts` annotateStaleBase). Verified answering `/.well-known/jmap` with
 * `401 + WWW-Authenticate: Basic realm="jmap"` — the JMAP worker, not the Pages
 * app that shares the origin (services/jmap/wrangler.jsonc routes).
 *
 * NOT a default: nothing dials this unless a user types it. Autodiscovery
 * decides for every domain, including this one.
 */
export const BULLMOOSE_ORIGIN = "https://app.bullmoose.cc";

import { usage } from "./io.js";

interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export async function resolveJmapBase(email: string): Promise<Discovery> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) usage(`not an email address: ${email}`);
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
    return settle(base, via, domain);
  }
  return settle(`https://${domain}`, "fallback", domain);
}

/**
 * Probe the candidate and let the answer correct it. Two things can happen that
 * the DNS half cannot see: the session resource redirects to another origin (so
 * THAT is the base — see the header), or nothing is there at all (reported, not
 * thrown: `discover` prints the verdict and `login` fails with it, and neither
 * wants an exception from a name lookup).
 */
async function settle(base: string, via: Discovery["via"], domain: string): Promise<Discovery> {
  const probe = await probeSession(base);
  if (probe.origin && probe.origin !== new URL(base).origin) {
    return { base: probe.origin, via, domain, redirectedFrom: base, probe };
  }
  return { base, via, domain, probe };
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
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=SRV`, {
      headers: { accept: "application/dns-json" },
    });
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

export interface SessionProbe {
  ok: boolean;
  status: number;
  detail: string;
  /**
   * Origin of the FINAL URL after redirects — where the session resource
   * actually lives. Absent when the request never completed.
   */
  origin?: string;
}

/**
 * Probe the session resource: is there a JMAP server at this base?
 *
 * The case that decides everything: an UNAUTHENTICATED GET answers 401, and
 * that is a YES. A 200 of HTML is a NO — a parked domain or a marketing page
 * answering everything — and the content-type is named rather than pasted, so
 * a wrong guess never dumps a page of markup into the terminal.
 */
export async function probeSession(base: string): Promise<SessionProbe> {
  try {
    const res = await fetch(`${base}/.well-known/jmap`, { redirect: "follow" });
    // `res.url` is the URL after redirects; empty only on a synthetic response.
    const origin = res.url ? new URL(res.url).origin : undefined;
    if (res.status === 401) {
      return { ok: true, status: 401, detail: "JMAP server present (auth required — expected)", origin };
    }
    if (res.ok) {
      const type = res.headers.get("content-type") ?? "";
      return type.includes("json")
        ? { ok: true, status: res.status, detail: "JMAP session served", origin }
        : {
            ok: false,
            status: res.status,
            detail: `responds, but not with a JMAP session (${type})`,
            origin,
          };
    }
    return { ok: false, status: res.status, detail: `HTTP ${res.status}`, origin };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
