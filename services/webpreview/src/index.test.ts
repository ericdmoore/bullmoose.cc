import { describe, expect, it } from "vitest";
import worker, { prefixForHost } from "./index";

// The serving rules themselves are tested once, in webhost — this file owns
// what is DIFFERENT about a preview: which prefix a hostname may reach, that
// it cannot reach any other, and that it never gets indexed.

const bucket = (files: Record<string, string>) => ({
  get: async (key: string) => (files[key] === undefined ? null : { body: files[key], httpEtag: `"etag-${key}"` }),
});

const env = (files: Record<string, string>) => ({ PREVIEWS: bucket(files) }) as never;
const get = (host: string, path = "/", headers: Record<string, string> = {}) =>
  new Request(`https://${host}${path}`, { headers });

describe("a hostname addresses exactly one PR's build", () => {
  it("preview-<n> maps to that PR's prefix", () => {
    expect(prefixForHost("preview-123.bullmoose.cc")).toBe("pr-123/");
    expect(prefixForHost("preview-7.bullmoose.cc")).toBe("pr-7/");
  });

  it("refuses a non-numeric label", () => {
    // The route pattern is a wildcard, so without this any `preview-<word>`
    // hostname someone points at the zone could address a prefix.
    expect(prefixForHost("preview-abc.bullmoose.cc")).toBeNull();
    expect(prefixForHost("preview-.bullmoose.cc")).toBeNull();
    expect(prefixForHost("app.bullmoose.cc")).toBeNull();
  });

  it("says which hostname was wrong rather than serving someone else's PR", async () => {
    const res = await worker.fetch(get("preview-abc.bullmoose.cc"), env({ "pr-1/index.html": "<h1>1</h1>" }));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("preview-abc.bullmoose.cc");
  });
});

describe("previews cannot read each other", () => {
  const files = { "pr-1/index.html": "<h1>PR ONE</h1>", "pr-2/index.html": "<h1>PR TWO</h1>" };

  it("serves the build under its own prefix", async () => {
    const res = await worker.fetch(get("preview-2.bullmoose.cc"), env(files));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("PR TWO");
  });

  it("a PR with no build 404s instead of falling through to another PR's", async () => {
    // The SPA fallback is per-prefix: `pr-99/index.html` is absent, and the
    // bucket's OTHER index.html files must not stand in for it.
    const res = await worker.fetch(get("preview-99.bullmoose.cc", "/", { "sec-fetch-mode": "navigate" }), env(files));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no preview build");
  });
});

describe("a preview is inert and unindexed", () => {
  it("carries noindex — a public hostname serving an unreleased build", async () => {
    const res = await worker.fetch(get("preview-1.bullmoose.cc"), env({ "pr-1/index.html": "<h1>1</h1>" }));
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("still keeps the asset/page asymmetry inside the prefix", async () => {
    const files = { "pr-1/index.html": "<h1>1</h1>" };
    const page = await worker.fetch(
      get("preview-1.bullmoose.cc", "/mail/inbox", { "sec-fetch-mode": "navigate" }),
      env(files),
    );
    expect(page.status).toBe(200);
    const asset = await worker.fetch(get("preview-1.bullmoose.cc", "/_astro/missing.js"), env(files));
    expect(asset.status).toBe(404);
  });

  it("names its own binding when the bucket is unbound", async () => {
    const res = await worker.fetch(get("preview-1.bullmoose.cc"), {} as never);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("PREVIEWS");
  });
});
