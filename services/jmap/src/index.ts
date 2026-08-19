import { dispatch, RequestErrors, type JmapRequest } from "@bullmoose/jmap-core";
import {
  AGENT_CAP,
  CALENDARS_CAP,
  CONTACTS_CAP,
  CORE_CAP,
  FILENODE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  VACATION_CAP,
  WEBSOCKET_CAP,
} from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { authenticate, accountAccess, principalHasScope, type AuthEnv, type Principal } from "./auth";
import { handleLogin, handleTokens } from "./authRoutes";
import { handleConsole } from "./console";
import { buildSession } from "./session";
import { buildRegistry, type RequestContext } from "./methods";
import { cookieAuthAllowed, isExploreHost } from "./explore/cookie";
import { exploreCookiePrincipal, exploreUnauthenticated, handleExplore, signInPage } from "./explore";
import {
  getShareRecord,
  isLive,
  listShareRecords,
  liveSharesForBlob,
  newShareId,
  putShareRecord,
  revokeShareRecord,
  type ShareRecord,
} from "./shares";

// The AccountDO class must be exported from the worker that declares it
// in wrangler.jsonc; ingest/submit bind it via script_name.
export { AccountDO } from "@bullmoose/account-do";

export interface Env extends AuthEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  /**
   * Route hot copy; also holds the `login:` /auth/login throttle windows and
   * the `share:` mint records that make share links revocable (shares.ts).
   */
  ROUTES: KVNamespace;
  ACCOUNT_DO: DurableObjectNamespace;
  /** Service binding to bullmoose-submit for EmailSubmission sends. */
  SUBMIT: Fetcher;
  /** Shared secret expected by the submit worker's /internal/* routes — and,
   *  since s26 T4, by the Bureau's (the seal hop below uses the same value;
   *  see docs/DEPLOY.md's INTERNAL_TOKEN worker list). */
  INTERNAL_TOKEN: string;
  /**
   * The Bureau (s04 T3a), for `ProviderCredential/set` only (s26 T4).
   *
   * This worker holds no master key and must not: it renders attacker-authored
   * email, which is precisely the class of worker T3a moved the key AWAY from.
   * Sealing a tenant's provider key is therefore a HOP — the plaintext crosses
   * this binding once on its way in, and nothing comes back but an
   * acknowledgement, because no route on the Bureau returns a secret.
   *
   * Optional so a deployment without it degrades to a 501 on that one method
   * rather than failing to boot; every other method here is unaffected.
   */
  BUREAU?: Fetcher;
  /** HMAC key for expiring public share links (/share/*). */
  SHARE_SIGNING_KEY?: string;

  // ---- s21, the explorer: OFF BY DEFAULT ---------------------------------
  //
  // Every one of these is optional, and `EXPLORE_HOST` is the master switch:
  // unset, `isExploreHost` is false for every request, no cookie is read
  // anywhere in this worker, and none of `src/explore/` is reachable. A
  // deployment that does not want a read-only mirror of everything omits the
  // route, the DNS record and these vars, and serves nothing.

  /**
   * The hostname the explorer answers on (e.g. `explore.bullmoose.cc`).
   * ⚠️ Also the value the `Host` header is compared against before a cookie is
   * ever honoured — see `explore/cookie.ts`'s `cookieAuthAllowed`.
   */
  EXPLORE_HOST?: string;
  /** HMAC key for the explore session cookie. */
  EXPLORE_COOKIE_KEY?: string;
  /** The OAuth client id the operator registered for the explorer. */
  EXPLORE_CLIENT_ID?: string;
  /** Only for a confidential registration; a public client needs none. */
  EXPLORE_CLIENT_SECRET?: string;
  /** Defaults to https://auth.bullmoose.cc. */
  EXPLORE_ISSUER?: string;
  /** RFC 8707 audience; defaults to https://mcp.bullmoose.cc/mcp. */
  EXPLORE_RESOURCE?: string;
  /**
   * Service binding to bullmoose-oauth, used ONLY by the explorer's sign-in:
   * the token store lives on the AS, so redeeming a code and asking who a
   * token belongs to are both hops across this binding (the same shape as
   * services/agent's OAUTH binding, and for the same reason).
   */
  OAUTH?: Fetcher;
}

const SUPPORTED_CAPS = new Set([
  CORE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  // Tolerated in `using[]` even though the session no longer ADVERTISES it
  // (the /api/ws socket is push-only, not RFC 8887 — see session.ts): a
  // client that lists it anyway should not have its whole request refused.
  WEBSOCKET_CAP,
  VACATION_CAP,
  CONTACTS_CAP,
  CALENDARS_CAP,
  FILENODE_CAP,
  AGENT_CAP,
]);
const registry = buildRegistry();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The `Host` header, not `url.host`: the explore rule is a check on what
    // the client CLAIMED to be talking to, and it must be the same string the
    // cookie decision is made from.
    const hostHeader = request.headers.get("host") ?? url.host;
    const onExplore = isExploreHost(hostHeader, env.EXPLORE_HOST);

    if (onExplore) {
      // Read-only refusal, the no-credential-in-a-URL refusal, and the OAuth
      // dance — all before any credential is resolved.
      const early = await exploreUnauthenticated(request, url, env);
      if (early) return early;
    } else {
      // Public expiring share links — recipients are external, so this
      // route authenticates by HMAC signature + expiry, not bearer token.
      if (request.method === "GET" && url.pathname.startsWith("/share/")) {
        return handleShareDownload(url, env);
      }

      // Password login mints the caller's first bearer token.
      if (request.method === "POST" && url.pathname === "/auth/login") {
        return handleLogin(request, env);
      }
    }

    const principal = await resolvePrincipal(request, hostHeader, env);
    if (!principal) {
      // On the explore host a browser is the client, so the refusal is a page
      // with a sign-in link rather than a JSON 401 it cannot act on. Same
      // status, same absence of authority.
      if (onExplore) return signInPage();
      return json({ error: "unauthorized" }, 401, {
        // Basic is advertised for third-party clients that only speak
        // user+password — the "password" is a minted bm_ token (app password).
        "www-authenticate": 'Basic realm="jmap", Bearer realm="jmap"',
      });
    }

    // The explorer's read-only projection (s21). Everything past this point is
    // the API surface, and it is unreachable on the explore hostname.
    if (onExplore) return handleExplore(url, env, principal);

    // Self-service token management (list / mint-within-scopes / revoke).
    if (url.pathname === "/auth/tokens" || url.pathname.startsWith("/auth/tokens/")) {
      return handleTokens(request, url, env, principal);
    }

    // The agent console's read interface (s03.E). Same-origin with the app for
    // the same reason /api/* is — see console.ts's header for why it is served
    // here and not by the worker that owns /vault/credentials.
    if (url.pathname === "/console" || url.pathname.startsWith("/console/")) {
      return handleConsole(request, url, env, principal);
    }

    // RFC 8620 §2: session resource.
    if (request.method === "GET" && url.pathname === "/.well-known/jmap") {
      return json(buildSession(url.origin, principal));
    }

    // The API endpoint: a batch of method calls.
    if (request.method === "POST" && url.pathname === "/api/jmap") {
      return handleApi(request, env, principal);
    }

    // Blob download: /api/download/{accountId}/{blobId}/{name}
    if (request.method === "GET" && url.pathname.startsWith("/api/download/")) {
      if (!principalHasScope(principal, "read")) return json({ error: "forbidden" }, 403);
      return handleDownload(url, env, principal);
    }

    // Blob upload: /api/upload/{accountId}
    if (request.method === "POST" && url.pathname.startsWith("/api/upload/")) {
      if (!principalHasScope(principal, "draft")) return json({ error: "forbidden" }, 403);
      return handleUpload(request, url, env, principal);
    }

    // Share-link lifecycle. NOTE the trailing "s": "/api/shares/" and
    // "/api/share/" are disjoint prefixes (they differ at index 10), so the
    // order below is for readers, not for correctness.
    //   GET  /api/shares/{accountId}                    — enumerate
    //   POST /api/shares/{accountId}/{shareId}/revoke   — the kill switch
    if (url.pathname.startsWith("/api/shares/")) {
      if (request.method === "GET") {
        if (!principalHasScope(principal, "read")) return json({ error: "forbidden" }, 403);
        return handleShareList(url, env, principal);
      }
      if (request.method === "POST") {
        // `delete` — revoking destroys a capability. Deliberately the same
        // tier as minting (`draft`): both are covered by the `mail` bundle, so
        // no token can create a link it is then unable to kill. A gate that
        // made revocation HARDER than minting would be the wrong way round.
        if (!principalHasScope(principal, "delete")) return json({ error: "forbidden" }, 403);
        return handleShareRevoke(url, env, principal);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // Mint an expiring public link for an already-uploaded blob:
    // POST /api/share/{accountId}/{blobId}  {name, type?, ttlSeconds?}
    if (request.method === "POST" && url.pathname.startsWith("/api/share/")) {
      if (!principalHasScope(principal, "draft")) return json({ error: "forbidden" }, 403);
      return handleShareCreate(request, url, env, principal);
    }

    // Blob lifecycle:
    //   GET    /api/blobs/{accountId}            — enumerate
    //   DELETE /api/blobs/{accountId}/{blobId}   — explicit delete, refcounted
    if (url.pathname.startsWith("/api/blobs/")) {
      if (request.method === "GET") {
        if (!principalHasScope(principal, "read")) return json({ error: "forbidden" }, 403);
        return handleBlobList(url, env, principal);
      }
      if (request.method === "DELETE") {
        if (!principalHasScope(principal, "delete")) return json({ error: "forbidden" }, 403);
        return handleBlobDelete(url, env, principal);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // Push: proxy the WebSocket straight to the account's Durable Object.
    if (url.pathname === "/api/ws") {
      const accountId = url.searchParams.get("accountId") ?? principal.accounts[0]?.accountId;
      if (!accountId || !accountAccess(principal, accountId)) {
        return json({ error: "unknown account" }, 404);
      }
      if (!principalHasScope(principal, "read")) return json({ error: "forbidden" }, 403);
      return accountStub(env.ACCOUNT_DO, accountId).fetch("https://do/ws", request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * THE worker's single credential resolution, and the only place a cookie is
 * ever consulted.
 *
 * ⚠️ Read `explore/cookie.ts`'s `cookieAuthAllowed` before touching this. The
 * short version: a cookie is honoured only when the request arrived on the
 * explore hostname AND is a GET. Drop either half and `app.bullmoose.cc/api/`
 * gains an ambient credential — which is to say it becomes CSRF-able, trading
 * a debugging convenience for a write primitive. **Bearer stays the only
 * credential `app.bullmoose.cc/api/` accepts**, and `explore/csrf.test.ts`
 * presents a valid explore cookie to the API origin, GET and POST, and
 * requires a 401 from both.
 *
 * The order matters too: a presented bearer always wins, so the cookie can
 * never widen what an explicit credential already decided.
 */
async function resolvePrincipal(request: Request, hostHeader: string, env: Env): Promise<Principal | null> {
  const bearer = await authenticate(request, env);
  if (bearer) return bearer;
  if (!cookieAuthAllowed(hostHeader, request.method, env.EXPLORE_HOST)) return null;
  return exploreCookiePrincipal(request, env);
}

async function handleApi(request: Request, env: Env, principal: RequestContext["principal"]) {
  let body: JmapRequest;
  try {
    body = (await request.json()) as JmapRequest;
  } catch {
    return problem(RequestErrors.notJSON, 400);
  }
  if (!Array.isArray(body.using) || !Array.isArray(body.methodCalls)) {
    return problem(RequestErrors.notRequest, 400);
  }
  const unknown = body.using.filter((cap) => !SUPPORTED_CAPS.has(cap));
  if (unknown.length > 0) {
    return problem(RequestErrors.unknownCapability, 400, `unsupported: ${unknown.join(", ")}`);
  }

  const ctx: RequestContext = { env, principal };
  const response = await dispatch(body, registry, ctx, "0");
  return json(response);
}

async function handleDownload(url: URL, env: Env, principal: RequestContext["principal"]) {
  const [, , , accountId, blobId] = url.pathname.split("/");
  if (!accountId || !blobId) return json({ error: "bad download path" }, 400);
  const access = accountAccess(principal, accountId);
  if (!access) return json({ error: "unknown account" }, 404);

  const store = new Mailstore(env.DB, env.BLOBS);
  const obj = await store.getBlob(access.tenantId, accountId, blobId);
  if (!obj) return json({ error: "blob not found" }, 404);

  return new Response(obj.body, {
    headers: {
      "content-type": url.searchParams.get("type") ?? "application/octet-stream",
      "content-disposition": "attachment",
      "cache-control": "private, immutable, max-age=31536000",
    },
  });
}

async function handleUpload(request: Request, url: URL, env: Env, principal: RequestContext["principal"]) {
  const [, , , accountId] = url.pathname.split("/");
  if (!accountId) return json({ error: "bad upload path" }, 400);
  const access = accountAccess(principal, accountId);
  if (!access) return json({ error: "unknown account" }, 404);

  const raw = await request.arrayBuffer();
  const store = new Mailstore(env.DB, env.BLOBS);
  const blobId = await store.putBlob(access.tenantId, accountId, raw);

  // RFC 8620 §6.1 upload response.
  return json({
    accountId,
    blobId,
    type: request.headers.get("content-type") ?? "application/octet-stream",
    size: raw.byteLength,
  });
}

// ---- expiring share links (the "Big Files" home: R2 + link worker) -----

const SHARE_DEFAULT_TTL = 30 * 24 * 3600; // 30 days
const SHARE_MAX_TTL = 90 * 24 * 3600;

/**
 * The signed payload now ends in `shareId`.
 *
 * That binding is what stops a holder of one valid link from swapping in
 * another account's share id to dodge a revocation: the id is not a free
 * parameter, it is part of what was signed.
 *
 * ⚠️ IT IS ALSO A ONE-TIME FLUSH. Links minted before this change carry a
 * signature over the old five-field payload and no longer verify — they 403.
 * That is the intended outcome, not collateral: the state this unit exists to
 * fix is that nobody knows what links are out there, and every surviving old
 * link is one more unknown that can never be enumerated or revoked. Accepting
 * both payload shapes during a window would preserve exactly the population
 * we cannot account for. See unit `010` Open Question #5.
 */
async function shareSignature(
  key: string,
  tenantId: string,
  accountId: string,
  blobId: string,
  name: string,
  exp: number,
  shareId: string,
): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${tenantId}:${accountId}:${blobId}:${name}:${exp}:${shareId}`;
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleShareCreate(
  request: Request,
  url: URL,
  env: Env,
  principal: RequestContext["principal"],
): Promise<Response> {
  if (!env.SHARE_SIGNING_KEY) return json({ error: "sharing not configured" }, 501);
  const [, , , accountId, blobId] = url.pathname.split("/");
  if (!accountId || !blobId) return json({ error: "bad share path" }, 400);
  const access = accountAccess(principal, accountId);
  if (!access) return json({ error: "unknown account" }, 404);

  const body = (await request.json()) as { name?: string; type?: string; ttlSeconds?: number };
  const name = (body.name ?? "file").replaceAll("/", "_");
  const ttl = Math.min(Math.max(60, body.ttlSeconds ?? SHARE_DEFAULT_TTL), SHARE_MAX_TTL);

  // Verify the blob exists before minting a link to it. `head` — this only
  // needs a boolean, and `getBlob` streamed the whole object to get one.
  const store = new Mailstore(env.DB, env.BLOBS);
  const head = await store.headBlob(access.tenantId, accountId, blobId);
  if (!head) return json({ error: "blob not found" }, 404);

  const now = Date.now();
  const exp = Math.floor(now / 1000) + ttl;
  const shareId = newShareId();
  const sig = await shareSignature(env.SHARE_SIGNING_KEY, access.tenantId, accountId, blobId, name, exp, shareId);

  // Record BEFORE returning the URL. If the KV write fails the mint fails,
  // and the caller gets no link — the alternative is handing out a URL that
  // deny-by-default will refuse, which looks like a broken link rather than
  // a failed mint, and would be unrevocable in exactly the way this unit
  // exists to end.
  const record: ShareRecord = {
    shareId,
    tenantId: access.tenantId,
    accountId,
    blobId,
    name,
    ...(body.type ? { type: body.type } : {}),
    exp,
    createdAt: now,
  };
  await putShareRecord(env.ROUTES, record, now);

  const shareUrl =
    `${url.origin}/share/${access.tenantId}/${accountId}/${blobId}/${encodeURIComponent(name)}` +
    `?exp=${exp}&sid=${shareId}&sig=${sig}` +
    (body.type ? `&type=${encodeURIComponent(body.type)}` : "");

  return json({ url: shareUrl, shareId, expiresAt: new Date(exp * 1000).toISOString() });
}

async function handleShareDownload(url: URL, env: Env): Promise<Response> {
  if (!env.SHARE_SIGNING_KEY) return json({ error: "sharing not configured" }, 501);
  const [, , tenantId, accountId, blobId, encodedName] = url.pathname.split("/");
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  // `sid` is deliberately NOT in the required-fields check: a missing one
  // signs as "" and fails the HMAC, so stripping it returns the same 403 as
  // forging it. A 400 here would tell a prober that `sid` is load-bearing.
  const shareId = url.searchParams.get("sid") ?? "";
  if (!tenantId || !accountId || !blobId || !encodedName || !Number.isFinite(exp)) {
    return json({ error: "bad share link" }, 400);
  }
  const name = decodeURIComponent(encodedName);

  const expected = await shareSignature(env.SHARE_SIGNING_KEY, tenantId, accountId, blobId, name, exp, shareId);
  if (!timingSafeEqualHex(sig, expected)) return json({ error: "invalid signature" }, 403);
  if (exp * 1000 < Date.now()) return json({ error: "link expired" }, 410);

  // The kill switch. Absent record and revoked record are the SAME refusal as
  // a forged signature — identical status and identical body — so the route
  // is not an oracle for which share ids exist. Deny-by-default: a link is
  // served only while the system can still account for it.
  const record = await getShareRecord(env.ROUTES, accountId, shareId);
  if (!record || record.revokedAt !== undefined) {
    return json({ error: "invalid signature" }, 403);
  }

  const store = new Mailstore(env.DB, env.BLOBS);
  const obj = await store.getBlob(tenantId, accountId, blobId);
  if (!obj) return json({ error: "gone" }, 410);

  const type = url.searchParams.get("type") ?? "application/octet-stream";
  const inlineable = type.startsWith("image/") || type === "application/pdf";
  return new Response(obj.body, {
    headers: {
      "content-type": type,
      "content-disposition": `${inlineable ? "inline" : "attachment"}; filename="${name.replaceAll('"', "")}"`,
      "cache-control": "private, max-age=3600",
    },
  });
}

// ---- share enumeration + revocation -----------------------------------
//
// Both refuse with 501 when SHARE_SIGNING_KEY is unset, matching the two
// handlers above: a deployment without the key has no sharing at all, and
// "sharing not configured" is a better answer than an empty list that looks
// like "you have no links".

/** GET /api/shares/{accountId} */
async function handleShareList(url: URL, env: Env, principal: RequestContext["principal"]): Promise<Response> {
  if (!env.SHARE_SIGNING_KEY) return json({ error: "sharing not configured" }, 501);
  const [, , , accountId] = url.pathname.split("/");
  if (!accountId) return json({ error: "bad shares path" }, 400);
  if (!accountAccess(principal, accountId)) return json({ error: "unknown account" }, 404);

  const now = Date.now();
  const records = await listShareRecords(env.ROUTES, accountId);
  return json({
    accountId,
    shares: records.map((r) => ({
      shareId: r.shareId,
      blobId: r.blobId,
      name: r.name,
      ...(r.type ? { type: r.type } : {}),
      expiresAt: new Date(r.exp * 1000).toISOString(),
      createdAt: new Date(r.createdAt).toISOString(),
      ...(r.revokedAt !== undefined ? { revokedAt: new Date(r.revokedAt).toISOString() } : {}),
      live: isLive(r, now),
    })),
  });
}

/** POST /api/shares/{accountId}/{shareId}/revoke */
async function handleShareRevoke(url: URL, env: Env, principal: RequestContext["principal"]): Promise<Response> {
  if (!env.SHARE_SIGNING_KEY) return json({ error: "sharing not configured" }, 501);
  const [, , , accountId, shareId, verb] = url.pathname.split("/");
  if (!accountId || !shareId || verb !== "revoke") {
    return json({ error: "bad revoke path" }, 400);
  }
  if (!accountAccess(principal, accountId)) return json({ error: "unknown account" }, 404);

  const { outcome, record } = await revokeShareRecord(env.ROUTES, accountId, shareId);
  if (outcome === "notFound") return json({ error: "unknown share" }, 404);
  return json({
    shareId,
    revoked: true,
    alreadyRevoked: outcome === "alreadyRevoked",
    blobId: record?.blobId ?? null,
    // KV is eventually consistent. Say so here so the CLI can repeat it to a
    // human rather than leaving them to discover it on a reload.
    note: "revoked; KV propagation may take up to ~60s at other edges",
  });
}

// ---- blob enumeration + delete -----------------------------------------

/** GET /api/blobs/{accountId}?cursor&limit */
async function handleBlobList(url: URL, env: Env, principal: RequestContext["principal"]): Promise<Response> {
  const [, , , accountId] = url.pathname.split("/");
  if (!accountId) return json({ error: "bad blobs path" }, 400);
  const access = accountAccess(principal, accountId);
  if (!access) return json({ error: "unknown account" }, 404);

  const rawLimit = Number(url.searchParams.get("limit"));
  const store = new Mailstore(env.DB, env.BLOBS);
  const page = await store.listBlobs(access.tenantId, accountId, {
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
    ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: Math.min(rawLimit, 1000) } : {}),
  });
  return json({
    accountId,
    blobs: page.blobs,
    totalSize: page.blobs.reduce((n, b) => n + b.size, 0),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  });
}

/**
 * DELETE /api/blobs/{accountId}/{blobId}
 *
 * Refuses rather than cascades, in both directions:
 *
 *  - a blob still referenced by a message → 409, because content addressing
 *    means the object may back several messages and deleting it would break
 *    every one of them;
 *  - a blob with a live share link → 409, because the alternative is a link
 *    that silently starts returning 410 gone. `handleShareDownload` already
 *    does return 410 for a missing object, which is honest — but arriving
 *    there by accident is worse than being told to revoke first.
 *  - a blob referenced by a live FileNode → 409: BLOB PINNING (sVOL 011 /
 *    s03.B arch §3). The draft is explicit that a blob backing a FileNode MUST
 *    NOT be GC'd or deleted while the node exists. This guard is the pinning
 *    invariant landing WITH the schema — without it, the first explicit delete
 *    after Files ships eats a live file. Destroy the FileNode first (which
 *    also revokes any shares), then the blob becomes deletable.
 *
 * 🚧 This is EXPLICIT delete only. The GC sweep is deliberately not here:
 * a sweep must respect the same three guards, and none exists yet.
 */
async function handleBlobDelete(url: URL, env: Env, principal: RequestContext["principal"]): Promise<Response> {
  const [, , , accountId, blobId] = url.pathname.split("/");
  if (!accountId || !blobId) return json({ error: "bad blob path" }, 400);
  const access = accountAccess(principal, accountId);
  if (!access) return json({ error: "unknown account" }, 404);

  const store = new Mailstore(env.DB, env.BLOBS);
  const head = await store.headBlob(access.tenantId, accountId, blobId);
  if (!head) return json({ error: "blob not found" }, 404);

  const referencedBy = await store.blobReferences(accountId, blobId);
  if (referencedBy.length > 0) {
    return json(
      {
        error: "blob in use",
        detail: "still referenced by mail; destroy the message(s) first",
        referencedBy,
      },
      409,
    );
  }

  const pinnedBy = await store.fileNodesReferencingBlob(accountId, blobId);
  if (pinnedBy.length > 0) {
    return json(
      {
        error: "blob pinned",
        detail: "referenced by a FileNode; destroy the file(s) first",
        fileNodeIds: pinnedBy,
      },
      409,
    );
  }

  const shares = await liveSharesForBlob(env.ROUTES, accountId, blobId);
  if (shares.length > 0) {
    return json(
      {
        error: "blob shared",
        detail: "a live share link points at this blob; revoke it first",
        shareIds: shares.map((s) => s.shareId),
      },
      409,
    );
  }

  await store.deleteBlob(access.tenantId, accountId, blobId);
  return json({ accountId, blobId, deleted: true });
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function problem(type: string, status: number, detail?: string): Response {
  return new Response(JSON.stringify({ type, status, ...(detail ? { detail } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}
