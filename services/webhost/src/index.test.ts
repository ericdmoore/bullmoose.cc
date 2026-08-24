import { describe, expect, it } from "vitest";
import worker, { cacheControlFor, contentTypeFor, isNavigation, keyFor } from "./index";

// The static host's whole job is a handful of decisions that each have a
// wrong answer someone will debug for an hour. These are those.

const bucket = (files: Record<string, string>) => ({
  get: async (key: string) =>
    files[key] === undefined
      ? null
      : {
          body: files[key],
          httpEtag: `"etag-${key}"`,
        },
});

const env = (files: Record<string, string>) => ({ SITE: bucket(files) }) as never;
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.example.com${path}`, { headers });

describe("key resolution", () => {
  it("a directory-shaped path resolves to its index.html", () => {
    expect(keyFor("/")).toBe("index.html");
    expect(keyFor("/settings/")).toBe("settings/index.html");
    expect(keyFor("/_astro/app.js")).toBe("_astro/app.js");
  });
});

describe("the SPA fallback is for NAVIGATIONS only", () => {
  it("a missing PAGE falls back to index.html", async () => {
    const res = await worker.fetch(
      get("/mail/inbox", { "sec-fetch-mode": "navigate" }),
      env({ "index.html": "<h1>app</h1>" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("a missing ASSET 404s — HTML with a JS content-type is a syntax error three layers from the cause", async () => {
    const res = await worker.fetch(get("/_astro/missing.js"), env({ "index.html": "<h1>app</h1>" }));
    expect(res.status).toBe(404);
  });

  it("classifies by Sec-Fetch-Mode, then Accept, then the extension", () => {
    expect(isNavigation(get("/x", { "sec-fetch-mode": "navigate" }), "x")).toBe(true);
    expect(isNavigation(get("/x", { accept: "text/html" }), "x")).toBe(true);
    expect(isNavigation(get("/mail/inbox"), "mail/inbox")).toBe(true); // no extension
    expect(isNavigation(get("/a.js"), "a.js")).toBe(false);
  });
});

describe("caching", () => {
  it("fingerprinted assets are immutable; the HTML that names them is not", () => {
    expect(cacheControlFor("_astro/app.abc123.js")).toContain("immutable");
    // If the HTML cached too, a deploy would be invisible to warm caches.
    expect(cacheControlFor("index.html")).toContain("must-revalidate");
  });

  it("a matching If-None-Match costs no body", async () => {
    const files = { "index.html": "<h1>app</h1>" };
    const first = await worker.fetch(get("/"), env(files));
    const etag = first.headers.get("etag")!;
    const second = await worker.fetch(get("/", { "if-none-match": etag }), env(files));
    expect(second.status).toBe(304);
  });
});

describe("content types and methods", () => {
  it("maps what an Astro build emits, and refuses to guess at the rest", () => {
    expect(contentTypeFor("a.js")).toContain("text/javascript");
    expect(contentTypeFor("a.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });

  it("HEAD sends headers without a body; POST is a method error, not a 404", async () => {
    const files = { "index.html": "<h1>app</h1>" };
    const head = await worker.fetch(new Request("https://app.example.com/", { method: "HEAD" }), env(files));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await worker.fetch(new Request("https://app.example.com/", { method: "POST" }), env(files));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toContain("GET");
  });

  it("a missing SITE binding says so rather than 404ing the whole app", async () => {
    const res = await worker.fetch(get("/"), {} as never);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("SITE");
  });
});
