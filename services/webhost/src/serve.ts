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

/** Where the CLI writes the compiled `_redirects` / `_headers` rules. Must
 *  equal cli-go/internal/cloud/staticconfig.go's RoutingKey; serve.test.ts
 *  pins the two together. */
export const ROUTING_KEY = ".bullmoose/routing.json";

export interface Redirect {
  from: string;
  to: string;
  status: number;
  splat?: boolean;
}

export interface HeaderRule {
  path: string;
  splat?: boolean;
  set?: Record<string, string>;
  unset?: string[];
}

export interface RoutingConfig {
  redirects?: Redirect[];
  headers?: HeaderRule[];
}

/**
 * Per-isolate routing cache.
 *
 * Reading the rules from R2 on every request would double the object reads
 * for every page on the site. Caching them forever would mean a deploy's new
 * redirects take effect only when an isolate happens to recycle — which is
 * unpredictable, so "I deployed the redirect and it did not happen" would be
 * true for some visitors and false for others. A short TTL makes it a
 * bounded, explainable minute.
 */
const ROUTING_TTL_MS = 60_000;

// Keyed on the BUCKET, not just the prefix. Two hosts can both use prefix ""
// against different buckets, and a plain module-level map would serve one
// site's redirects from the other's cache — which is also what makes a test
// suite's second case inherit the first's rules.
const routingCache = new WeakMap<R2Bucket, Map<string, { at: number; cfg: RoutingConfig }>>();

async function loadRouting(bucket: R2Bucket, prefix: string, now: number): Promise<RoutingConfig> {
  let perPrefix = routingCache.get(bucket);
  if (!perPrefix) {
    perPrefix = new Map();
    routingCache.set(bucket, perPrefix);
  }
  const hit = perPrefix.get(prefix);
  if (hit && now - hit.at < ROUTING_TTL_MS) return hit.cfg;
  let cfg: RoutingConfig = {};
  try {
    const obj = await bucket.get(prefix + ROUTING_KEY);
    if (obj) cfg = (await obj.json()) as RoutingConfig;
  } catch {
    // A corrupt or unreadable rules object must not take the site down: the
    // pages themselves are fine, and serving them without redirects is a far
    // better failure than serving nothing. It is cached as empty so a broken
    // file does not re-fetch on every request.
    cfg = {};
  }
  perPrefix.set(prefix, { at: now, cfg });
  return cfg;
}

/** Does a rule's path match, honouring a trailing-wildcard rule? */
function ruleMatches(rulePath: string, splat: boolean | undefined, pathname: string): string | null {
  if (splat) {
    if (pathname === rulePath) return "";
    if (pathname.startsWith(rulePath + "/")) return pathname.slice(rulePath.length + 1);
    // `/*` at the root compiles to an empty path and matches everything.
    if (rulePath === "") return pathname.replace(/^\/+/, "");
    return null;
  }
  return pathname === rulePath ? "" : null;
}

export function findRedirect(cfg: RoutingConfig, pathname: string): { to: string; status: number } | null {
  for (const r of cfg.redirects ?? []) {
    const splatValue = ruleMatches(r.from, r.splat, pathname);
    if (splatValue === null) continue;
    return { to: r.to.replace(/:splat$/, splatValue), status: r.status };
  }
  return null;
}

export function applyHeaderRules(cfg: RoutingConfig, pathname: string, headers: Headers): void {
  // Least-specific first (the CLI sorts them that way), so a more specific
  // block overrides a general one rather than racing it.
  for (const rule of cfg.headers ?? []) {
    if (ruleMatches(rule.path, rule.splat, pathname) === null) continue;
    for (const [k, v] of Object.entries(rule.set ?? {})) headers.set(k, v);
    for (const k of rule.unset ?? []) headers.delete(k);
  }
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
  /**
   * Is this site a single-page app?
   *
   * `true` (the webmail, and its previews): an unmatched NAVIGATION serves
   * index.html, because the client router owns the path.
   *
   * `false` (a brochure/guides site): an unmatched path is a genuine 404,
   * served from the build's own `404.html` if it has one.
   *
   * This is not a preference. bullmoose.cc ran for months on Pages' default —
   * no `404.html` in the build means Pages SPA-falls-back — so every
   * nonexistent URL answered 200 with the homepage. That is what made
   * `/.well-known/jmap` return a webpage to JMAP clients instead of a 404,
   * and it needed a redirect rule to patch the one path anybody noticed.
   * A brochure site that 200s on everything is broken in a way that looks
   * fine.
   */
  spa?: boolean;
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
  const spa = opts.spa ?? true;

  const url = new URL(request.url);
  const cfg = await loadRouting(bucket, prefix, Date.now());

  // Redirects run BEFORE any lookup: the whole point of `/old -> /new` is
  // that /old need not exist, and checking the bucket first would make a
  // redirect for a path that still exists silently lose to the file.
  const hit = findRedirect(cfg, url.pathname.replace(/\/+$/, "") || "/");
  if (hit) {
    if (hit.status === 404 || hit.status === 410) {
      return new Response(hit.status === 410 ? "gone" : missing, { status: hit.status });
    }
    return new Response(null, { status: hit.status, headers: { location: hit.to } });
  }

  const key = keyFor(url.pathname);

  // The rules object is configuration, not content. Without this it would be
  // readable at /.bullmoose/routing.json, handing a reader every path you
  // thought was retired.
  if (key === ROUTING_KEY) return new Response(missing, { status: 404 });

  let object = await bucket.get(prefix + key);
  let servedKey = key;

  if (!object && spa && isNavigation(request, key)) {
    // The SPA fallback — navigations only (see the header comment).
    object = await bucket.get(prefix + "index.html");
    servedKey = "index.html";
  }
  if (!object) {
    // A non-SPA site gets to 404 properly, with its own page if it built one.
    if (!spa && isNavigation(request, key)) {
      const custom = await bucket.get(prefix + "404.html");
      if (custom) {
        const res = respond(custom, "404.html", request, opts.extraHeaders, 404);
        applyHeaderRules(cfg, url.pathname, res.headers);
        return res;
      }
    }
    return new Response(missing, { status: 404 });
  }
  const res = respond(object, servedKey, request, opts.extraHeaders);
  applyHeaderRules(cfg, url.pathname, res.headers);
  return res;
}

function respond(
  object: R2ObjectBody,
  key: string,
  request: Request,
  extra: Record<string, string> = {},
  status = 200,
): Response {
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
  // because the HTML revalidates on every navigation by design. Not offered
  // for a 404 page: "your cached copy of the error is current" is a
  // conversation nobody needs.
  if (status === 200 && request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
