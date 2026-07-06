import { dispatch, RequestErrors, type JmapRequest } from "@bullmoose/jmap-core";
import { CORE_CAP, MAIL_CAP, SUBMISSION_CAP, WEBSOCKET_CAP } from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { authenticate, accountAccess, principalHasScope, type AuthEnv } from "./auth";
import { handleLogin, handleTokens } from "./authRoutes";
import { buildSession } from "./session";
import { buildRegistry, type RequestContext } from "./methods";

// The AccountDO class must be exported from the worker that declares it
// in wrangler.jsonc; ingest/submit bind it via script_name.
export { AccountDO } from "@bullmoose/account-do";

export interface Env extends AuthEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  ROUTES: KVNamespace;
  ACCOUNT_DO: DurableObjectNamespace;
  /** Service binding to bullmoose-submit for EmailSubmission sends. */
  SUBMIT: Fetcher;
  /** Shared secret expected by the submit worker's /internal/* routes. */
  INTERNAL_TOKEN: string;
  /** HMAC key for expiring public share links (/share/*). */
  SHARE_SIGNING_KEY?: string;
}

const SUPPORTED_CAPS = new Set([CORE_CAP, MAIL_CAP, SUBMISSION_CAP, WEBSOCKET_CAP]);
const registry = buildRegistry();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public expiring share links — recipients are external, so this
    // route authenticates by HMAC signature + expiry, not bearer token.
    if (request.method === "GET" && url.pathname.startsWith("/share/")) {
      return handleShareDownload(url, env);
    }

    // Password login mints the caller's first bearer token.
    if (request.method === "POST" && url.pathname === "/auth/login") {
      return handleLogin(request, env);
    }

    const principal = await authenticate(request, env);
    if (!principal) {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": 'Bearer realm="jmap"',
      });
    }

    // Self-service token management (list / mint-within-scopes / revoke).
    if (url.pathname === "/auth/tokens" || url.pathname.startsWith("/auth/tokens/")) {
      return handleTokens(request, url, env, principal);
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

    // Mint an expiring public link for an already-uploaded blob:
    // POST /api/share/{accountId}/{blobId}  {name, type?, ttlSeconds?}
    if (request.method === "POST" && url.pathname.startsWith("/api/share/")) {
      if (!principalHasScope(principal, "draft")) return json({ error: "forbidden" }, 403);
      return handleShareCreate(request, url, env, principal);
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

async function handleUpload(
  request: Request,
  url: URL,
  env: Env,
  principal: RequestContext["principal"],
) {
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

async function shareSignature(
  key: string,
  tenantId: string,
  accountId: string,
  blobId: string,
  name: string,
  exp: number,
): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${tenantId}:${accountId}:${blobId}:${name}:${exp}`;
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

  // Verify the blob exists before minting a link to it.
  const store = new Mailstore(env.DB, env.BLOBS);
  const head = await store.getBlob(access.tenantId, accountId, blobId);
  if (!head) return json({ error: "blob not found" }, 404);

  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await shareSignature(env.SHARE_SIGNING_KEY, access.tenantId, accountId, blobId, name, exp);
  const shareUrl =
    `${url.origin}/share/${access.tenantId}/${accountId}/${blobId}/${encodeURIComponent(name)}` +
    `?exp=${exp}&sig=${sig}${body.type ? `&type=${encodeURIComponent(body.type)}` : ""}`;

  return json({ url: shareUrl, expiresAt: new Date(exp * 1000).toISOString() });
}

async function handleShareDownload(url: URL, env: Env): Promise<Response> {
  if (!env.SHARE_SIGNING_KEY) return json({ error: "sharing not configured" }, 501);
  const [, , tenantId, accountId, blobId, encodedName] = url.pathname.split("/");
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!tenantId || !accountId || !blobId || !encodedName || !Number.isFinite(exp)) {
    return json({ error: "bad share link" }, 400);
  }
  const name = decodeURIComponent(encodedName);

  const expected = await shareSignature(env.SHARE_SIGNING_KEY, tenantId, accountId, blobId, name, exp);
  if (!timingSafeEqualHex(sig, expected)) return json({ error: "invalid signature" }, 403);
  if (exp * 1000 < Date.now()) return json({ error: "link expired" }, 410);

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
