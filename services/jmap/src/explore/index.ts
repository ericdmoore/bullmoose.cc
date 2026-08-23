import { MethodError } from "@bullmoose/jmap-core";
import { principalFromGrant, type Principal } from "@bullmoose/auth-core/principal";
import { buildRegistry, type RequestContext } from "../methods";
import type { Env } from "../index";
import { EXPLORE_COOKIE, clearCookieHeader, parseCookies, readExploreCookie } from "./cookie";
import { exploreOauthCallback, exploreOauthStart, safeReturnTo } from "./oauth";
import { TYPES, TYPE_NAMES, linksFor, type ExploreLink, type LinkBuilder, type TypeSpec } from "./types";

/**
 * s21 — the explorer: navigable read-only JSON, so a browser plus a
 * pretty-print extension is the entire client.
 *
 * ## The one rule it exists under
 *
 * From `.plans/s19-transports`: **a facade calls the METHODS, never the
 * store.** Every response below comes out of `buildRegistry()` — the same
 * registry `POST /api/jmap` dispatches into, running the same
 * `requireAccount(ctx, args, scope, domain)` gate. `services/agent`'s
 * `jmapBridge.ts` is the existing proof this works; this is the second door on
 * the same rail. Nothing here touches `Mailstore`, and there is no `storeFor`
 * import in this directory. A facade that reached past JMAP into the store
 * would bypass exactly the authorization the methods enforce, and would become
 * the one transport with its own holes.
 *
 * ## Read-only, and what that buys
 *
 * No POST, no PUT, no DELETE, and only `/get` and `/query` methods are ever
 * named. The blast radius of a bug on this surface is a LEAK, never a write —
 * which is the only reason a cookie-authenticated surface is tolerable at all.
 * The refusal of non-GET happens before authentication, so it costs nothing to
 * verify: see `exploreUnauthenticated`.
 *
 * ## Off by default
 *
 * `EXPLORE_HOST` unset → `isExploreHost` is false for every request, nothing
 * in this directory is reachable, and no cookie is ever read anywhere in the
 * worker. Turning it on is three deliberate acts: the route, the DNS record,
 * and the secrets. See `services/jmap/wrangler.jsonc`.
 */

const registry = buildRegistry();

/** Query parameters the explorer owns; everything else must be a filter. */
const RESERVED_PARAMS = new Set(["accountId", "position", "limit"]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// ---- the pre-authentication surface ------------------------------------

/**
 * The explore-host routes that run BEFORE a principal exists: the read-only
 * refusal, the no-credential-in-a-URL refusal, and the OAuth dance.
 *
 * Returns `null` when the request should continue to the normal credential
 * step. Called from `services/jmap/src/index.ts` only when the request arrived
 * on the explore hostname.
 */
export async function exploreUnauthenticated(request: Request, url: URL, env: Env): Promise<Response | null> {
  // READ-ONLY, checked first and without reference to any credential. A
  // non-GET on this host is refused whether or not a cookie is present, so
  // there is no shape of request that reaches a write from here.
  if (request.method !== "GET") {
    return exploreJson(
      {
        error: { type: "forbidden", description: "the explorer is read-only" },
        detail: `${request.method} is not available here; the explorer answers GET only`,
      },
      405,
      { allow: "GET" },
    );
  }

  // Every URL on this host is a NAVIGABLE url — it lands in history, in
  // `Referer`, and in access logs. `webmail/src/lib/app/tokenInUrl.test.ts`
  // pins the policy for the app; this is the same policy at the one door where
  // a browser would be tempted to break it. The WebSocket exception
  // (`packages/cli/src/watch.ts:311`) exists because that API cannot set
  // headers; navigation can, and does.
  for (const name of ["access_token", "token"]) {
    if (url.searchParams.has(name)) {
      return exploreJson(
        {
          error: { type: "forbidden", description: "no credential may appear in a URL" },
          detail:
            `"${name}" is not accepted here. Sign in at /oauth/start (cookie) or send ` +
            "an Authorization: Bearer header.",
        },
        400,
      );
    }
  }

  if (url.pathname === "/oauth/start") return exploreOauthStart(env, url.searchParams.get("return_to"));
  if (url.pathname === "/oauth/callback") return exploreOauthCallback(url, env);
  if (url.pathname === "/signout") {
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": clearCookieHeader(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
  return null;
}

/**
 * Cookie → principal. The ONLY cookie read anywhere in this worker, and it is
 * reached only through `cookieAuthAllowed` (see `cookie.ts` — that comment is
 * the load-bearing one).
 *
 * The cookie names a principal id and a scope list; the reachable ACCOUNTS are
 * re-derived from D1 on every request by `principalFromGrant`, so a revoked
 * grant or a deleted account takes effect immediately rather than whenever the
 * cookie happens to expire.
 */
export async function exploreCookiePrincipal(request: Request, env: Env): Promise<Principal | null> {
  if (!env.EXPLORE_COOKIE_KEY) return null;
  const raw = parseCookies(request.headers.get("cookie"))[EXPLORE_COOKIE];
  const session = await readExploreCookie(env.EXPLORE_COOKIE_KEY, raw, Date.now());
  if (!session) return null;
  return principalFromGrant(env.DB, session.p, session.s);
}

/**
 * The ONE permitted scrap of HTML (`.plans/s21-explorer`, open question 3).
 *
 * No stylesheet, no script, no image — `default-src 'none'` is satisfiable
 * because the page is a heading, a few sentences and links. If this ever
 * grows a second page it has become an app, and the argument for the whole
 * unit weakens.
 *
 * ## The pretty-printer shelf (Eric, 2026-08-23)
 *
 * The explorer's whole premise is "the browser IS the explorer — with a
 * pretty-print extension." So the sign-in page names the extension for the
 * browser you are holding, THAT browser's family first. Detection is
 * SERVER-side UA sniffing, because the CSP forbids script and navigation
 * links are the only capability this page has; a wrong guess costs nothing —
 * all three families are listed, only the order moves. Firefox's row is not
 * a link at all: it ships a native JSON viewer, and sending someone to
 * install what they already have would be the page lying about the one
 * thing it exists to explain.
 */

type BrowserFamily = "chrome" | "firefox" | "safari";

/** UA → family, coarse on purpose. Chrome/Edge/Brave/Arc all carry
 *  `Chrome/`; Safari is `Safari/` WITHOUT it; Firefox says its name. An
 *  unknown UA reads as chrome-family, the largest population. */
export function browserFamily(userAgent: string | null): BrowserFamily {
  const ua = userAgent ?? "";
  if (/firefox\//i.test(ua)) return "firefox";
  if (/safari\//i.test(ua) && !/chrome|chromium|crios|edg/i.test(ua)) return "safari";
  return "chrome";
}

const VIEWER_ROWS: Record<BrowserFamily, string> = {
  chrome:
    `<li><strong>Chrome-based</strong> (Chrome, Edge, Brave, Arc): ` +
    `<a href="https://chromewebstore.google.com/detail/json-formatter/bcjindcccaagfpapjjmafapmmgkkhgoa" rel="noreferrer">JSON Formatter</a> — open source, renders <code>_links</code> as clickable.</li>`,
  firefox: `<li><strong>Firefox-based</strong>: nothing to install — Firefox ships a native JSON viewer, links clickable out of the box.</li>`,
  safari:
    `<li><strong>Safari-based</strong>: on iPhone/iPad, ` +
    `<a href="https://jayson.app" rel="noreferrer">Jayson</a> (App Store; includes a Safari extension); ` +
    `on the Mac, <a href="https://apps.apple.com/app/json-peep-for-safari/id1458969831" rel="noreferrer">JSON Peep</a>.</li>`,
};

/**
 * The one inline stylesheet, allowed through the CSP by HASH — not
 * 'unsafe-inline', which would bless any injected style; exactly these bytes
 * and no others (`STYLE_CSP_HASH` is pinned to them by a test). What it
 * fixes, each reported from a real phone (Eric, 2026-08-23): text against
 * the device walls (margins), invisible links in dark mode (the page
 * declared no color-scheme, so dark Safari painted default dark-blue links
 * on near-black), and the monospace look — liked, so made deliberate.
 */
export const SIGN_IN_STYLE =
  ":root{color-scheme:light dark}" +
  "body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:40rem;margin:0 auto;" +
  "padding:24px 20px;line-height:1.65;font-size:15px}" +
  "code{font-size:13px}ul{padding-left:1.2rem}li{margin:6px 0}" +
  "a{color:#1d4ed8}@media (prefers-color-scheme:dark){a{color:#8ab4f8}}";

/** sha256 of SIGN_IN_STYLE, precomputed — the CSP names it, the test re-derives it. */
export const STYLE_CSP_HASH = "sha256-GDAeNv8hsToOP1K3if11JS1eArS6VvrcwAdZ0yxqc4E=";

export function signInPage(returnTo?: string | null, userAgent?: string | null): Response {
  // Carry the interrupted destination through the sign-in, so a deep link
  // lands where it pointed instead of dumping you at the root and making you
  // navigate back by hand (Eric, 2026-08-21: "the salt in the wound").
  //
  // `safeReturnTo` decides what is allowed — a same-origin path and nothing
  // else. It runs HERE too, not only at /oauth/start, so a rejected value
  // never reaches the markup: this is the one place the explorer emits HTML,
  // and an unvalidated string in an href is how that becomes an injection.
  const dest = safeReturnTo(returnTo ?? null);
  const startHref = dest ? `/oauth/start?return_to=${encodeURIComponent(dest)}` : "/oauth/start";
  // The reader's own family first; the other two follow in a stable order.
  const family = browserFamily(userAgent ?? null);
  const order: BrowserFamily[] = [family, ...(["chrome", "firefox", "safari"] as const).filter((f) => f !== family)];
  const viewers = order.map((f) => VIEWER_ROWS[f]).join("\n");
  const body = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bullmoose explorer</title>
<style>${SIGN_IN_STYLE}</style>
<h1>bullmoose explorer</h1>
<p>Read-only JSON over the same JMAP methods every other client uses. Nothing here can write.</p>
<p><a href="${startHref}">Sign in with bullmoose</a></p>
<p>A session lasts 15 minutes and carries the <code>read</code> scope only.</p>
<p>Every response carries <code>_self</code>, <code>_links</code> and <code>_next</code> — with a JSON pretty-printer, the browser is the whole client:</p>
<ul>
${viewers}
</ul>
<p>The shapes are the standards': <a href="https://www.rfc-editor.org/rfc/rfc8620" rel="noreferrer">RFC 8620 (JMAP)</a> and <a href="https://www.rfc-editor.org/rfc/rfc8621" rel="noreferrer">RFC 8621 (JMAP for Mail)</a>.</p>
</html>
`;
  return new Response(body, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src '${STYLE_CSP_HASH}'; base-uri 'none'; form-action 'none'`,
    },
  });
}

// ---- the projection ----------------------------------------------------

/**
 * `GET /`, `GET /{Type}`, `GET /{Type}/{id}` — the whole grammar.
 *
 * The account is a query parameter rather than a path segment because it is
 * not part of an object's identity in JMAP either: `accountId` is an argument
 * to every method. It defaults to the principal's first reachable account and
 * is echoed into `_self`, `_meta` and every `_links` href, so a document is
 * always self-describing about which account it came from.
 */
export async function handleExplore(url: URL, env: Env, principal: Principal): Promise<Response> {
  const base = `https://${env.EXPLORE_HOST ?? url.host}`;
  const segments = url.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s));

  if (segments.length === 0) return exploreJson(indexDocument(base, principal, url.searchParams.get("accountId")));
  if (segments.length > 2) {
    return exploreJson({ error: { type: "notFound" }, detail: "the grammar is /{Type} and /{Type}/{id}" }, 404);
  }

  const typeName = segments[0] as string;
  const spec = TYPES[typeName];
  if (!spec) {
    return exploreJson({ error: { type: "notFound" }, detail: `unknown type "${typeName}"`, types: TYPE_NAMES }, 404);
  }

  const accountId = url.searchParams.get("accountId") ?? principal.accounts[0]?.accountId ?? null;
  if (!accountId) {
    return exploreJson({ error: { type: "accountNotFound" }, detail: "this credential reaches no account" }, 404);
  }

  const ctx: RequestContext = { env, principal };
  const links = linkBuilder(base, accountId);
  try {
    const id = segments[1];
    return id === undefined
      ? await listDocument(spec, url, base, accountId, ctx, links)
      : await objectDocument(spec, id, base, accountId, ctx, links);
  } catch (err) {
    if (err instanceof MethodError) return methodErrorResponse(err, spec, accountId, base);
    throw err;
  }
}

/**
 * Call a registered JMAP method. `method` is always a string from `TYPES` —
 * never caller-controlled — and every one of them is a `/get` or a `/query`.
 */
async function call(
  ctx: RequestContext,
  method: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = registry.get(method);
  // Not a user error: the type table named a method the registry never had.
  if (!handler) throw new Error(`explore: no such method "${method}"`);
  return (await handler(args, ctx)) as Record<string, unknown>;
}

async function objectDocument(
  spec: TypeSpec,
  id: string,
  base: string,
  accountId: string,
  ctx: RequestContext,
  links: LinkBuilder,
): Promise<Response> {
  const res = await call(ctx, spec.get, { accountId, ids: [id] });
  const list = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
  const obj = list.find((o) => o.id === id);
  const self = objectHref(base, accountId, spec.type, id);
  if (!obj) {
    return exploreJson(
      {
        error: { type: "notFound" },
        _self: self,
        _meta: meta(base, spec, accountId, [spec.get]),
      },
      404,
    );
  }
  return exploreJson({
    ...obj,
    _self: self,
    _links: linksFor(spec.type, obj, links),
    _meta: {
      ...meta(base, spec, accountId, [spec.get]),
      ...(typeof res.state === "string" ? { state: res.state } : {}),
    },
  });
}

async function listDocument(
  spec: TypeSpec,
  url: URL,
  base: string,
  accountId: string,
  ctx: RequestContext,
  links: LinkBuilder,
): Promise<Response> {
  if (!spec.listable) {
    return exploreJson(
      {
        error: { type: "notFound" },
        detail: `${spec.type} has no list projection`,
        ...(spec.note ? { note: spec.note } : {}),
        _meta: meta(base, spec, accountId, [spec.get]),
      },
      404,
    );
  }

  const filter = collectFilter(spec, url);
  if ("error" in filter) {
    return exploreJson(
      {
        error: { type: "unsupportedFilter", description: filter.error },
        accepts: [...spec.filters],
        _meta: meta(base, spec, accountId, spec.query ? [spec.query, spec.get] : [spec.get]),
      },
      400,
    );
  }

  const methods: string[] = [];
  let ids: string[] | null = null;
  let queryState: string | undefined;
  let total: number | undefined;
  let position = 0;
  let limit: number | undefined;

  if (spec.query) {
    position = Math.max(0, intParam(url, "position", 0));
    limit = Math.min(Math.max(1, intParam(url, "limit", DEFAULT_LIMIT)), MAX_LIMIT);
    const q = await call(ctx, spec.query, {
      accountId,
      filter: filter.value,
      position,
      limit,
      calculateTotal: true,
    });
    methods.push(spec.query);
    ids = Array.isArray(q.ids) ? (q.ids as string[]) : [];
    if (typeof q.position === "number") position = q.position;
    if (typeof q.queryState === "string") queryState = q.queryState;
    if (typeof q.total === "number") total = q.total;
  }

  // `ids: null` on a /get means "everything" (RFC 8620 §5.1) — the only way to
  // enumerate the types JMAP gives no /query for. `ids: []` is a real empty
  // page and must NOT collapse into it.
  const res = await call(ctx, spec.get, { accountId, ids });
  methods.push(spec.get);
  const objects = Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];

  // `id` IS the self link — there are no bare ids on this surface.
  //
  // Eric, 2026-08-22, as the surface's only consumer: "lets really push in to
  // HATEOAS — i dont really ever need bareIDs … they can basically be
  // removed." A bare id is a dead end: to use it you must select it, know the
  // grammar, and hand-assemble `/{Type}/{id}?accountId=`. The href is that
  // work already done, and the raw value stays legible inside it.
  const items = objects.map((obj) => ({
    ...obj,
    ...(typeof obj.id === "string"
      ? {
          id: objectHref(base, accountId, spec.type, obj.id),
          _self: objectHref(base, accountId, spec.type, obj.id),
          _links: linksFor(spec.type, obj, links),
        }
      : {}),
  }));

  // `_next` is JMAP's own position/limit paging re-expressed as a URL, and
  // nothing more: a full page means "there may be more", a short page (or an
  // empty one) means the walk is over and no `_next` is emitted. A collection
  // whose size is an exact multiple of `limit` ends on one empty page, which
  // terminates.
  const next =
    limit !== undefined && ids !== null && ids.length === limit ? pageHref(url, base, position + limit) : undefined;

  return exploreJson({
    _self: pageHref(url, base, spec.query ? position : undefined),
    ...(next ? { _next: next } : {}),
    _meta: {
      ...meta(base, spec, accountId, methods),
      ...(spec.note ? { note: spec.note } : {}),
      ...(queryState !== undefined ? { queryState } : {}),
      ...(typeof res.state === "string" ? { state: res.state } : {}),
      ...(spec.query ? { position, limit } : {}),
      ...(total !== undefined ? { total } : {}),
      count: items.length,
      ...(spec.filters.length > 0 ? { filters: [...spec.filters] } : {}),
    },
    // NO top-level `ids`. It was JMAP's `/query` result echoed verbatim — a
    // wall of opaque strings sitting directly ABOVE the only thing you can
    // click, which is how the person who wrote the navigable-JSON requirement
    // came to browse this surface and conclude the links were missing.
    //
    // What it gives up, honestly: `/query` promises an ORDER that `/get` does
    // not, and an id that vanished between the two would have appeared here
    // and not in `list`. Neither has ever mattered while browsing.
    // `_meta.count` still says how many came back.
    list: items,
  });
}

/** The root document: who you are, and every door from here. */
/**
 * An account's own URL: the index, narrowed to it.
 *
 * The account id is the one value every other URL on this surface needs, so
 * leaving it bare is the worst possible place to make a reader retype
 * something. The destination is the collections reachable IN that account —
 * which is the question you have the moment you notice which account a
 * document came from.
 */
function accountHref(base: string, accountId: string): string {
  return `${base}/?accountId=${encodeURIComponent(accountId)}`;
}

function indexDocument(base: string, principal: Principal, only?: string | null): Record<string, unknown> {
  return {
    _self: `${base}/`,
    _meta: {
      principal: principal.username,
      scopes: principal.scopes,
      readOnly: true,
      types: TYPE_NAMES,
    },
    accounts: principal.accounts
      .filter((a) => !only || a.accountId === only)
      .map((a) => ({
        _self: accountHref(base, a.accountId),
        accountId: accountHref(base, a.accountId),
        name: a.name,
        via: a.granted ? "granted" : "owned",
        collections: Object.fromEntries(
          TYPE_NAMES.filter((t) => (TYPES[t] as TypeSpec).listable).map((t) => [
            t,
            {
              href: `${base}/${t}?accountId=${encodeURIComponent(a.accountId)}`,
              type: t,
              list: true,
            } satisfies ExploreLink,
          ]),
        ),
      })),
  };
}

// ---- URL construction --------------------------------------------------
//
// Every href below is built from a type name, an id and an accountId. None of
// those is a credential, and there is no code path in this file that can put
// one into a URL — `explore.test.ts` walks every emitted href and asserts it.

function objectHref(base: string, accountId: string, type: string, id: string): string {
  return `${base}/${type}/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`;
}

function linkBuilder(base: string, accountId: string): LinkBuilder {
  return {
    object: (type, id) => ({ href: objectHref(base, accountId, type, id), type, id }),
    collection: (type, filter) => {
      const u = new URL(`${base}/${type}`);
      u.searchParams.set("accountId", accountId);
      for (const [k, v] of Object.entries(filter)) u.searchParams.set(k, v);
      return { href: u.toString(), type, list: true };
    },
  };
}

/** The current list URL, optionally with `position` moved. */
function pageHref(url: URL, base: string, position: number | undefined): string {
  const u = new URL(`${base}${url.pathname}`);
  for (const [k, v] of url.searchParams) {
    if (k === "position") continue;
    u.searchParams.set(k, v);
  }
  if (position !== undefined) u.searchParams.set("position", String(position));
  return u.toString();
}

// ---- arguments ---------------------------------------------------------

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * URL parameters → a JMAP FilterCondition, renaming nothing.
 *
 * An unrecognised parameter is REFUSED rather than dropped: silently ignoring
 * `?inMailbox=…` on a type that has no such filter would answer a different
 * question than the one asked, and on a read-everything surface "you got more
 * than you filtered for" is the failure that matters.
 */
function collectFilter(spec: TypeSpec, url: URL): { value: Record<string, unknown> | null } | { error: string } {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of url.searchParams) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (!spec.filters.includes(key)) {
      return { error: `${spec.type} has no "${key}" filter` };
    }
    // An explicitly empty id means the null parent — the top of a tree. JMAP
    // spells that `null`, and a URL cannot.
    out[key] = raw === "" || raw === "null" ? null : raw;
  }
  return { value: Object.keys(out).length > 0 ? out : null };
}

// ---- responses ---------------------------------------------------------

function meta(base: string, spec: TypeSpec, accountId: string, methods: string[]): Record<string, unknown> {
  return {
    // A URL. There are no bare ids on this surface (devPrinciples, HATEOAS).
    accountId: accountHref(base, accountId),
    type: spec.type,
    // What was actually called. A reader who wants the same data over
    // `/api/jmap` can copy these names and the arguments straight across.
    methods,
    scopes: [...spec.scopes],
    domain: spec.domain,
  };
}

/**
 * A JMAP `MethodError`, rendered as HTTP without being reinterpreted.
 *
 * `type` is carried through VERBATIM, so a missing scope refuses here with the
 * same `forbidden` (and the same description) it would produce over
 * `/api/jmap`. The status code is the only thing added, and it is a
 * translation of the type rather than a second opinion about it.
 */
function methodErrorResponse(err: MethodError, spec: TypeSpec, accountId: string, base: string): Response {
  const status =
    err.type === "forbidden"
      ? 403
      : err.type === "accountNotFound" || err.type === "notFound"
        ? 404
        : err.type === "invalidArguments" ||
            err.type === "unsupportedFilter" ||
            err.type === "unsupportedSort" ||
            err.type === "anchorNotFound"
          ? 400
          : err.type === "cannotCalculateChanges"
            ? 409
            : 500;
  return exploreJson({ error: err.toArgs(), _meta: meta(base, spec, accountId, [spec.get]) }, status);
}

/**
 * Pretty-printed on purpose: the client for this surface is a browser, and
 * two-space JSON is readable even without an extension installed.
 *
 * `no-store` because every document is account data. `no-referrer` so a URL —
 * which carries account and object ids — never leaves on an outbound request.
 */
export function exploreJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
