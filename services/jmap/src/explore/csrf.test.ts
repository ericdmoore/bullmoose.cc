import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker from "../index";
import { EXPLORE_COOKIE, cookieAuthAllowed, hostOnly, isExploreHost } from "./cookie";
import { APP_HOST, ERIC, EXPLORE_HOST, harness } from "./harness";

/**
 * ⚠️ THE GUARD (`.plans/s21-explorer` open question 1).
 *
 * The explorer and the API are the same worker — that is what makes the
 * explorer cheap, because the JMAP method registry lives here. It is also what
 * makes this file necessary: a cookie-authenticated path exists in a worker
 * that also serves `app.bullmoose.cc/api/`, and the ONLY thing keeping the two
 * apart is `cookieAuthAllowed`'s explicit `Host` check.
 *
 * If it were dropped, an ambient credential would authenticate on the API
 * origin and `POST /api/jmap` would become CSRF-able: any page on the internet
 * could make a signed-in browser run `Email/set destroy` with the user's own
 * authority. That trades a debugging convenience for a WRITE PRIMITIVE.
 *
 * So: **bearer stays the only credential `app.bullmoose.cc/api/` accepts.**
 * Everything below presents a *valid, unexpired, correctly signed* explore
 * cookie — the strongest form of the attack — and requires a 401.
 *
 * The two mutations these tests are built to catch:
 *   (a) delete the host comparison in `cookieAuthAllowed` → every GET case
 *       below starts returning 200;
 *   (b) delete the `method !== "GET"` line → the POST case below authenticates.
 */

/** Every API-origin path that answers to an authenticated principal. */
const API_GETS = [
  `/api/blobs/${ERIC}`,
  `/api/download/${ERIC}/blob_a_eric/x.txt`,
  `/api/shares/${ERIC}`,
  `/.well-known/jmap`,
  `/auth/tokens`,
  `/console/overview`,
];

describe("the explore cookie is refused on the API origin", () => {
  for (const path of API_GETS) {
    it(`GET ${path} with a valid explore cookie → 401`, async () => {
      const h = await harness();
      const res = await h.api("GET", path, { headers: { cookie: `${EXPLORE_COOKIE}=${h.cookie}` } });
      expect(res.status, `${path} honoured a cookie`).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    });
  }

  it("POST /api/jmap with a valid explore cookie → 401, and nothing is dispatched", async () => {
    const h = await harness();
    const res = await h.api("POST", "/api/jmap", {
      headers: { cookie: `${EXPLORE_COOKIE}=${h.cookie}`, "content-type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/query", { accountId: ERIC }, "c0"]],
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("methodResponses");
  });

  it("a write posted with the cookie changes nothing", async () => {
    const h = await harness();
    const before = h.w.db.count("emails", "account_id = ?", ERIC);
    const res = await h.api("POST", "/api/jmap", {
      headers: { cookie: `${EXPLORE_COOKIE}=${h.cookie}`, "content-type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/set", { accountId: ERIC, destroy: [`e_1_${ERIC}`] }, "c0"]],
      }),
    });
    expect(res.status).toBe(401);
    expect(h.w.db.count("emails", "account_id = ?", ERIC)).toBe(before);
  });

  it("the check is on the Host HEADER, not on the URL's authority", async () => {
    const h = await harness();
    // A request whose URL claims the explore host but whose `Host:` says
    // otherwise must be treated as the API origin. Relying on the browser's
    // host-only cookie scoping is not enough — this must hold against anything
    // that can open a socket.
    const res = await worker.fetch(
      new Request(`https://${EXPLORE_HOST}/api/blobs/${ERIC}`, {
        headers: { host: APP_HOST, cookie: `${EXPLORE_COOKIE}=${h.cookie}` },
      }),
      h.env,
    );
    expect(res.status).toBe(401);
  });

  it("the same cookie DOES work on the explore host — the guard is the host, not the cookie", async () => {
    const h = await harness();
    expect((await h.explore("/Email")).status).toBe(200);
  });

  it("a bearer still works on the API origin — nothing was taken away", async () => {
    const h = await harness();
    const res = await h.api("GET", `/api/blobs/${ERIC}`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("cookieAuthAllowed — the rule, in isolation", () => {
  it("is false without an explore host: the explorer is off by default", () => {
    expect(cookieAuthAllowed(EXPLORE_HOST, "GET", undefined)).toBe(false);
    expect(cookieAuthAllowed(EXPLORE_HOST, "GET", "")).toBe(false);
  });

  it("is true only for a GET on the explore host", () => {
    expect(cookieAuthAllowed(EXPLORE_HOST, "GET", EXPLORE_HOST)).toBe(true);
    expect(cookieAuthAllowed(APP_HOST, "GET", EXPLORE_HOST)).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(cookieAuthAllowed(EXPLORE_HOST, method, EXPLORE_HOST), method).toBe(false);
    }
  });

  it("compares hostnames, not substrings — no suffix or prefix gets in", () => {
    for (const impostor of [
      `evil-${EXPLORE_HOST}`,
      `${EXPLORE_HOST}.evil.example`,
      `x.${EXPLORE_HOST}`,
      "",
      null,
    ]) {
      expect(cookieAuthAllowed(impostor, "GET", EXPLORE_HOST), String(impostor)).toBe(false);
    }
  });

  it("ignores the port and the case, as HTTP does", () => {
    expect(cookieAuthAllowed(`${EXPLORE_HOST}:8787`, "GET", EXPLORE_HOST)).toBe(true);
    expect(cookieAuthAllowed(EXPLORE_HOST.toUpperCase(), "GET", EXPLORE_HOST)).toBe(true);
    expect(hostOnly("[::1]:8787")).toBe("[::1]");
    expect(hostOnly(null)).toBe("");
  });

  it("isExploreHost is the routing half, and agrees on the same string", () => {
    expect(isExploreHost(EXPLORE_HOST, EXPLORE_HOST)).toBe(true);
    expect(isExploreHost(APP_HOST, EXPLORE_HOST)).toBe(false);
    expect(isExploreHost(EXPLORE_HOST, undefined)).toBe(false);
  });
});

/**
 * The structural half of the guard: there is exactly ONE cookie-reading path in
 * this worker, and exactly one call to the rule that gates it.
 *
 * The behavioural tests above prove the guard works where it is. This proves
 * nobody added a second door somewhere it isn't — the failure mode that a
 * request-level test cannot see, because the request that would exercise it
 * does not exist yet. Same shape as `webmail/src/lib/app/tokenInUrl.test.ts`:
 * read the directory, not a list, so a NEW file is covered the moment it lands.
 */
describe("only one place in the worker reads a cookie", () => {
  const SRC = fileURLToPath(new URL("../", import.meta.url));

  /** Every worker source file OUTSIDE src/explore/, tests excluded. */
  function workerSources(): string[] {
    return readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
      .map((e) => `${SRC}${e.name}`);
  }

  /** Strip comments, so the scan reads CODE — this file's prose says "cookie" a lot. */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("scans a surface that is actually populated", () => {
    const files = workerSources();
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1))).toContain("index.ts");
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1))).toContain("console.ts");
  });

  it("no worker file outside src/explore/ reads the Cookie header", () => {
    for (const file of workerSources()) {
      const src = code(readFileSync(file, "utf8"));
      expect(src, `${file} reads a cookie`).not.toMatch(/["'`]cookie["'`]/i);
      expect(src, `${file} parses cookies`).not.toMatch(/document\.cookie|parseCookies\(/);
    }
  });

  it("index.ts consults the rule exactly once, and only to resolve a principal", () => {
    const src = code(readFileSync(`${SRC}index.ts`, "utf8"));
    expect([...src.matchAll(/cookieAuthAllowed\(/g)]).toHaveLength(1);
    expect([...src.matchAll(/exploreCookiePrincipal\(/g)]).toHaveLength(1);
    // The cookie is reached only after `authenticate` declined — a presented
    // bearer always wins, so a cookie can never widen an explicit credential.
    const guard = src.indexOf("cookieAuthAllowed(");
    expect(src.lastIndexOf("await authenticate(request, env)", guard)).toBeGreaterThan(-1);
  });
});

describe("the explore host is not the API", () => {
  it("API paths are not served there, even with a valid cookie", async () => {
    const h = await harness();
    for (const path of ["/api/jmap", `/api/blobs/${ERIC}`, "/auth/tokens", "/console/overview"]) {
      const res = await h.explore(path);
      // Unknown to the explorer's grammar: an ordinary 404, not the API's answer.
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("blobs");
    }
  });

  it("POST /auth/login is refused there before it is even routed", async () => {
    const h = await harness();
    const res = await h.exploreWith("POST", "/auth/login");
    expect(res.status).toBe(405);
  });

  it("GET /share/... is not served there", async () => {
    const h = await harness();
    const res = await h.explore("/share/t_bm/a_eric/blob/x?exp=1&sig=00");
    expect(res.status).toBe(404);
  });
});
