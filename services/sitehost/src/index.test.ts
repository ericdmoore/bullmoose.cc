import { describe, expect, it } from "vitest";
import worker from "./index";
import { ROUTING_KEY } from "../../webhost/src/serve";

// What is different about the apex: it is NOT an SPA, and it applies the
// compiled `_redirects` / `_headers` rules.

const bucket = (files: Record<string, string>) => ({
  get: async (key: string) =>
    files[key] === undefined
      ? null
      : {
          body: files[key],
          httpEtag: `"etag-${key}"`,
          json: async () => JSON.parse(files[key]!),
        },
});

const env = (files: Record<string, string>) => ({ SITE: bucket(files) }) as never;
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://bullmoose.cc${path}`, { headers: { "sec-fetch-mode": "navigate", ...headers } });

const routing = (cfg: unknown) => ({ [ROUTING_KEY]: JSON.stringify(cfg) });

describe("a brochure site 404s honestly", () => {
  it("does NOT serve the homepage for an unknown path", async () => {
    // This is the whole reason the site moved off Pages: with no 404.html in
    // the build, Pages SPA-fell-back and answered 200 + homepage for every
    // nonexistent URL, which is what made /.well-known/jmap return a webpage.
    const res = await worker.fetch(get("/nonexistent-xyz"), env({ "index.html": "<h1>home</h1>" }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("home");
  });

  it("serves the build's own 404.html when it has one, with a 404 status", async () => {
    const res = await worker.fetch(get("/nope"), env({ "index.html": "<h1>home</h1>", "404.html": "<h1>lost</h1>" }));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("lost");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("still serves real pages", async () => {
    const res = await worker.fetch(get("/guides/"), env({ "guides/index.html": "<h1>guides</h1>" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("guides");
  });
});

describe("compiled _redirects are applied", () => {
  const files = {
    "index.html": "<h1>home</h1>",
    ...routing({
      redirects: [
        { from: "/.well-known/jmap", to: "https://app.bullmoose.cc/.well-known/jmap", status: 302 },
        { from: "/guides", to: "/docs/:splat", status: 301, splat: true },
        { from: "/retired", to: "/", status: 410 },
      ],
    }),
  };

  it("redirects the JMAP autodiscovery path off the apex", async () => {
    // RFC 8620 §2.2: a client that finds a 200 here believes it found the
    // server. Handing it to the app origin is the honest answer.
    const res = await worker.fetch(get("/.well-known/jmap"), env(files));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.bullmoose.cc/.well-known/jmap");
  });

  it("expands :splat from a trailing wildcard", async () => {
    const res = await worker.fetch(get("/guides/getting-started"), env(files));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs/getting-started");
  });

  it("honours a 410 without pretending the page moved", async () => {
    const res = await worker.fetch(get("/retired"), env(files));
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a path that still EXISTS in the bucket", async () => {
    // Redirects run before the lookup on purpose: a rule written to retire a
    // page that has not been deleted yet must still fire, or it does nothing
    // until someone remembers to remove the file.
    const res = await worker.fetch(
      get("/old"),
      env({ "old/index.html": "<h1>old</h1>", ...routing({ redirects: [{ from: "/old", to: "/new", status: 301 }] }) }),
    );
    expect(res.status).toBe(301);
  });
});

describe("compiled _headers are applied", () => {
  it("sets and removes headers by path, specific overriding general", async () => {
    const res = await worker.fetch(
      get("/admin/"),
      env({
        "admin/index.html": "<h1>admin</h1>",
        ...routing({
          headers: [
            { path: "", splat: true, set: { "x-general": "yes", "cache-control": "public, max-age=3600" } },
            { path: "/admin", splat: true, set: { "x-frame-options": "DENY" }, unset: ["x-general"] },
          ],
        }),
      }),
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-general")).toBeNull();
    // A rule may override what the host would otherwise have chosen.
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});

describe("the rules object is configuration, not content", () => {
  it("is never served", async () => {
    // Otherwise it is readable at its own path, which hands a reader every
    // route you thought was retired.
    const res = await worker.fetch(get(`/${ROUTING_KEY}`), env(routing({ redirects: [] })));
    expect(res.status).toBe(404);
  });

  it("a corrupt rules object does not take the site down", async () => {
    const res = await worker.fetch(get("/"), env({ "index.html": "<h1>home</h1>", [ROUTING_KEY]: "{not json" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("home");
  });
});
