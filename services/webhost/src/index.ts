/**
 * webhost — the webmail's static files, served from R2.
 *
 * ## Why this exists (and what it replaced)
 *
 * The app used to be a Pages project, which meant `cloud install` ended by
 * telling a human to run `npx wrangler pages deploy`. That one line was the
 * only place in the whole install where someone learned this platform is
 * built in TypeScript — and reimplementing Pages' upload to remove it would
 * have meant copying an undocumented wrangler-internal protocol (BLAKE3
 * over base64-plus-extension, a JWT dance, four private endpoints) that
 * Cloudflare can change under us at any time.
 *
 * R2 + a worker uses only surfaces we already call: object PUT to upload,
 * script PUT to deploy. The whole install becomes one Go binary against
 * documented APIs, and the Pages project — plus its DNS attach and its
 * token scope — leaves the stack.
 *
 * ## Coexistence on app.<zone>
 *
 * `services/jmap` owns the API paths on this same hostname
 * (`/api/*`, `/auth/*`, `/console/*`, `/share/*`, `/.well-known/jmap`).
 * Worker routes match most-specific-first, so this worker's `app.<zone>/*`
 * sits UNDER those and serves everything else. That is the same-origin
 * arrangement s07 chose deliberately: no CORS surface, no preflight, no
 * second origin for a credential to cross.
 *
 * ## The rules this file keeps
 *
 * A static host is mostly a set of small honesty decisions:
 *
 *   - **The SPA fallback is for NAVIGATIONS only.** Rewriting a missing
 *     `/_astro/app.js` to index.html hands the browser HTML with a
 *     JavaScript content-type — which fails as a syntax error in the
 *     console, three layers from the actual cause (a missing asset). A
 *     missing asset must 404 as an asset.
 *   - **Hashed assets are immutable, HTML is not.** Astro fingerprints
 *     everything under `/_astro/`, so those can cache forever; the HTML
 *     that names them must revalidate or a deploy is invisible to anyone
 *     with a warm cache.
 *   - **HEAD and GET only.** Anything else is a method error, not a 404 —
 *     a static host that answers POST with "not found" reads like a
 *     missing route rather than a wrong verb.
 */

export interface Env {
  /** The bucket holding one deployment's files, keys relative to the site
   *  root with no leading slash (`index.html`, `_astro/app.abc123.js`). */
  SITE: R2Bucket;
}

/** Extension → content type. Deliberately a small closed list: a wrong
 *  guess here is a page that renders as text or a script the browser
 *  refuses to execute, and the set an Astro build emits is knowable. */
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
};

export function contentTypeFor(key: string): string {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * A URL path → the R2 key it should serve.
 *
 * `/` and any directory-shaped path get `index.html` appended, which is how
 * a static build's nested routes (`/settings/` → `settings/index.html`)
 * resolve.
 */
export function keyFor(pathname: string): string {
  let p = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  return p;
}

/** Is this a request for a PAGE (worth an SPA fallback) or an ASSET? */
export function isNavigation(request: Request, key: string): boolean {
  // The browser tells us directly on real navigations; the extension check
  // is the fallback for clients that do not send Sec-Fetch-Mode.
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) return true;
  return !key.slice(key.lastIndexOf("/") + 1).includes(".");
}

export function cacheControlFor(key: string): string {
  // Astro fingerprints these; the name changes when the bytes do.
  if (key.startsWith("_astro/")) return "public, max-age=31536000, immutable";
  if (key.endsWith(".html")) return "public, max-age=0, must-revalidate";
  return "public, max-age=3600";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (!env.SITE) {
      // Deploy skew: the worker is live and its bucket binding is not. Say
      // so rather than 404ing every page, which reads as "the app is gone".
      return new Response("webhost has no SITE bucket bound", { status: 503 });
    }

    const url = new URL(request.url);
    const key = keyFor(url.pathname);
    let object = await env.SITE.get(key);

    if (!object && isNavigation(request, key)) {
      // The SPA fallback — navigations only. An asset that is missing must
      // stay missing (see the header comment).
      object = await env.SITE.get("index.html");
      if (object) {
        return respond(object, "index.html", request);
      }
      return new Response("not found", { status: 404 });
    }
    if (!object) return new Response("not found", { status: 404 });
    return respond(object, key, request);
  },
} satisfies ExportedHandler<Env>;

function respond(object: R2ObjectBody, key: string, request: Request): Response {
  const headers = new Headers({
    "content-type": contentTypeFor(key),
    "cache-control": cacheControlFor(key),
    etag: object.httpEtag,
    // The app is same-origin with its API by design (s07); nothing here
    // should ever be framed by another site.
    "x-content-type-options": "nosniff",
  });
  // A conditional request that matches costs no body — worth doing here
  // because the HTML revalidates on every navigation by design.
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
