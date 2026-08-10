import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SECTIONS } from "./sections";

/**
 * app.bullmoose.cc is ONE origin serving two things: Cloudflare Pages holds the
 * app's documents, and `services/jmap` claims the API paths via Worker routes,
 * which take precedence on a shared hostname.
 *
 * That is a deliberate choice over a separate api. host: `services/jmap` sends
 * no CORS headers and has no OPTIONS handler, so a cross-origin app would die
 * at preflight before reaching any route. Same-origin removes the CORS surface
 * instead of adding one.
 *
 * The cost of the choice is a namespace shared between two systems, and nothing
 * enforces it at build time — Pages and Wrangler never see each other. A page
 * named `api.astro` would be shadowed by the worker and simply never render;
 * a worker path that stopped being routed would 404 as Pages HTML, which reads
 * as "the app is broken" rather than "the route is missing". Both failures are
 * silent and neither is a type error. Hence this file.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const JMAP_CONFIG = resolve(ROOT, "services/jmap/wrangler.jsonc");
const PAGES_DIR = resolve(ROOT, "webmail/src/pages");
const HOST = "app.bullmoose.cc";

/** Route patterns wrangler will claim on the app host. */
function workerRoutes(): string[] {
  const raw = readFileSync(JMAP_CONFIG, "utf8");
  return [...raw.matchAll(/"pattern":\s*"([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((p) => p.startsWith(HOST))
    .map((p) => p.slice(HOST.length));
}

/** Top-level path segments Astro will publish as documents. */
function pageSegments(): string[] {
  return readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith(".astro"))
    .map((f) => f.replace(/\.astro$/, ""))
    .filter((n) => n !== "index");
}

describe("app.bullmoose.cc — Pages and the jmap worker share one origin", () => {
  it("declares routes for every API path the client actually opens with", () => {
    // The two that are easy to forget precisely because they are not under
    // /api: JmapClient opens on `/.well-known/jmap`, and the login door posts
    // to `/auth/login`. A lone "/api/*" route looks complete and is not.
    const routes = workerRoutes();
    expect(routes).toContain("/.well-known/jmap");
    expect(routes.some((r) => r === "/auth/*")).toBe(true);
    expect(routes.some((r) => r === "/api/*")).toBe(true);
  });

  it("no app page collides with a worker route — the worker would shadow it", () => {
    const claimed = workerRoutes().map((r) => r.replace(/\/\*$/, "").replace(/^\//, ""));
    const collisions = pageSegments().filter((seg) => claimed.includes(seg));
    expect(collisions, `worker routes would shadow: ${collisions.join(", ")}`).toEqual([]);
  });

  it("no NAV section collides either, including ones not yet built", () => {
    // sections.ts is the plan of record for what will exist. Catching the
    // collision when the section is still `planned` is far cheaper than
    // catching it after someone writes the page and it silently never loads.
    const claimed = workerRoutes().map((r) => r.replace(/\/\*$/, ""));
    const collisions = SECTIONS.filter((s) => claimed.includes(s.href)).map((s) => s.href);
    expect(collisions, `nav would be shadowed by the worker: ${collisions.join(", ")}`).toEqual([]);
  });
});
