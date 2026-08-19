import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BULLMOOSE_ORIGIN, probeSession, resolveJmapBase } from "./discover.js";

/**
 * The dead-host lane, at the one place a default is manufactured.
 *
 * `bullmoose login you@bullmoose.cc` with no --base takes whatever discovery
 * returns and STORES it. Rung 3 of the ladder — `https://<domain>` — used to be
 * returned unverified, and for this deployment that is the wrong answer by one
 * hop: the apex is a Pages site that 302s exactly `/.well-known/jmap` to
 * `https://app.bullmoose.cc/.well-known/jmap` (src/public/_redirects) and
 * serves nothing else the CLI needs. Discovery "succeeded", the config said
 * `https://bullmoose.cc`, and the next step — POST /auth/login — got HTTP 405.
 *
 * RFC 8620 §2.2 already says what to do: follow, and the session resource is
 * the final URL. So the base is the origin that ANSWERED.
 *
 * Both live shapes here were observed against the real deployment on
 * 2026-08-18: `https://bullmoose.cc/.well-known/jmap` → 302 →
 * `https://app.bullmoose.cc/.well-known/jmap` → 401
 * `WWW-Authenticate: Basic realm="jmap"`.
 */

/** No SRV anywhere — the world as it has been since the record was retired. */
vi.mock("node:dns", () => ({
  promises: {
    resolveSrv: async () => {
      throw new Error("NXDOMAIN");
    },
  },
}));

type Route = (url: string) => Response;
let asked: string[];
let route: Route;

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = String(input);
    asked.push(url);
    // The DoH rung must never reach the network in a unit test; answer it as
    // "no records" so discovery drops to the well-known fallback.
    if (url.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    // node's fetch follows redirects itself and reports the final URL on
    // `res.url`; this stub does the same in one step, which is what the code
    // under test reads.
    return route(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A Response that claims to have come from `finalUrl` after redirects. */
function answeredAt(finalUrl: string, status: number, body = "", type = "application/json"): Response {
  const res = new Response(body || null, { status, headers: { "content-type": type } });
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

describe("probeSession reports WHERE the session resource answered", () => {
  it("treats 401 as yes and carries the final origin", async () => {
    route = () => answeredAt("https://app.bullmoose.cc/.well-known/jmap", 401);
    const probe = await probeSession("https://bullmoose.cc");
    expect(probe.ok).toBe(true);
    expect(probe.origin).toBe(BULLMOOSE_ORIGIN);
  });

  it("a 200 of HTML is not a JMAP server, and the page is named not pasted", async () => {
    route = () => answeredAt("https://parked.example/.well-known/jmap", 200, "<!doctype html>", "text/html");
    const probe = await probeSession("https://parked.example");
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("text/html");
    expect(probe.detail).not.toContain("doctype");
  });

  it("survives a stub with no url (a synthetic Response) without inventing one", async () => {
    route = () => new Response(null, { status: 401 });
    const probe = await probeSession("https://jmap.example.com");
    expect(probe.ok).toBe(true);
    expect(probe.origin).toBeUndefined();
  });
});

describe("autodiscovery lands on the origin that answers, not the name asked", () => {
  it("adopts a cross-origin redirect of the session resource", async () => {
    route = () => answeredAt("https://app.bullmoose.cc/.well-known/jmap", 401);
    const found = await resolveJmapBase("eric@bullmoose.cc");
    expect(found.base).toBe(BULLMOOSE_ORIGIN);
    expect(found.redirectedFrom).toBe("https://bullmoose.cc");
    // The redirect says nothing about which RUNG answered.
    expect(found.via).toBe("fallback");
    expect(found.probe?.ok).toBe(true);
  });

  it("leaves the base alone when the redirect stays on the same origin", async () => {
    route = () => answeredAt("https://jmap.example.com/.well-known/jmap/", 401);
    const found = await resolveJmapBase("you@jmap.example.com");
    expect(found.base).toBe("https://jmap.example.com");
    expect(found.redirectedFrom).toBeUndefined();
  });

  it("still returns a base when nothing answers, with the verdict attached", async () => {
    route = () => answeredAt("https://nowhere.example/.well-known/jmap", 404);
    const found = await resolveJmapBase("you@nowhere.example");
    // Reported, not thrown: `discover` prints the ✗ and exits 1, and `login`
    // fails against the URL it names. Neither wants an exception from a lookup.
    expect(found.base).toBe("https://nowhere.example");
    expect(found.probe?.ok).toBe(false);
    expect(found.probe?.status).toBe(404);
  });

  it("probes exactly once per candidate — discovery is not a scan", async () => {
    route = () => answeredAt("https://app.bullmoose.cc/.well-known/jmap", 401);
    await resolveJmapBase("eric@bullmoose.cc");
    expect(asked.filter((u) => u.endsWith("/.well-known/jmap"))).toEqual(["https://bullmoose.cc/.well-known/jmap"]);
  });
});
