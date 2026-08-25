/**
 * Serving a built static site out of an R2 bucket.
 *
 * Extracted from webhost's own handler when services/webpreview arrived
 * (#371): a preview host is the SAME serving problem — SPA fallback,
 * content types, conditional requests, method handling — differing only in
 * which bucket, which key prefix, and a couple of headers. Two copies of the
 * rules below would drift, and the drift would be invisible until a preview
 * behaved unlike the app it is supposed to preview.
 *
 * The rules themselves are the small honesty decisions a static host is made
 * of; each has a wrong answer that costs an hour:
 *
 *   - **The SPA fallback is for NAVIGATIONS only.** Rewriting a missing
 *     `/_astro/app.js` to index.html hands the browser HTML with a
 *     JavaScript content-type — which fails as a syntax error in the console,
 *     three layers from the actual cause (a missing asset). A missing asset
 *     must 404 as an asset.
 *   - **Hashed assets are immutable, HTML is not.** Astro fingerprints
 *     everything under `_astro/`, so those can cache forever; the HTML that
 *     names them must revalidate or a deploy is invisible to a warm cache.
 *   - **HEAD and GET only.** Anything else is a method error, not a 404 — a
 *     static host answering POST with "not found" reads like a missing route
 *     rather than a wrong verb.
 */

/** Extension → content type. Deliberately a small closed list: a wrong guess
 *  here is a page that renders as text or a script the browser refuses to
 *  execute, and the set an Astro build emits is knowable. */
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
 * `/` and any directory-shaped path get `index.html` appended, which is how a
 * static build's nested routes (`/settings/` → `settings/index.html`) resolve.
 */
export function keyFor(pathname: string): string {
  let p = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  return p;
}

/** Is this a request for a PAGE (worth an SPA fallback) or an ASSET? */
export function isNavigation(request: Request, key: string): boolean {
  // The browser tells us directly on real navigations; the extension check is
  // the fallback for clients that do not send Sec-Fetch-Mode.
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

export interface ServeOptions {
  /** Key prefix within the bucket, "" for a bucket holding one site. The
   *  preview host uses `pr-123/` so one bucket holds many builds. Must end
   *  in `/` when non-empty; callers construct it, so this is not re-checked
   *  on every request. */
  prefix?: string;
  /** Headers added to every 2xx/304 — the preview host's noindex lives here. */
  extraHeaders?: Record<string, string>;
  /** What a missing site says. The default reads as a broken app; a preview
   *  host can say "this PR has no build" instead, which is a different
   *  problem with a different fix. */
  notFound?: string;
  /** The R2 binding's NAME, used only in the 503 when it is absent. "no SITE
   *  bucket bound" tells an operator which line of which wrangler.jsonc to
   *  look at; "no bucket bound" sends them reading every service. */
  bindingName?: string;
}

/**
 * The whole static host, minus the decision of WHICH bucket and prefix.
 *
 * Note the asymmetry in the 404s: a missing ASSET 404s immediately, while a
 * missing PAGE falls back to index.html. That asymmetry is the entire reason
 * `isNavigation` exists (see the header).
 */
export async function serveStatic(
  request: Request,
  bucket: R2Bucket | undefined,
  opts: ServeOptions = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (!bucket) {
    // Deploy skew: the worker is live and its bucket binding is not. Say so
    // rather than 404ing every page, which reads as "the app is gone".
    return new Response(`no ${opts.bindingName ?? "SITE"} bucket bound`, { status: 503 });
  }
  const prefix = opts.prefix ?? "";
  const missing = opts.notFound ?? "not found";

  const url = new URL(request.url);
  const key = keyFor(url.pathname);
  let object = await bucket.get(prefix + key);
  let servedKey = key;

  if (!object && isNavigation(request, key)) {
    // The SPA fallback — navigations only (see the header comment).
    object = await bucket.get(prefix + "index.html");
    servedKey = "index.html";
  }
  if (!object) return new Response(missing, { status: 404 });
  return respond(object, servedKey, request, opts.extraHeaders);
}

function respond(object: R2ObjectBody, key: string, request: Request, extra: Record<string, string> = {}): Response {
  const headers = new Headers({
    "content-type": contentTypeFor(key),
    "cache-control": cacheControlFor(key),
    etag: object.httpEtag,
    // The app is same-origin with its API by design (s07); nothing here
    // should ever be sniffed into a different type than it was stored as.
    "x-content-type-options": "nosniff",
    ...extra,
  });
  // A conditional request that matches costs no body — worth doing here
  // because the HTML revalidates on every navigation by design.
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
