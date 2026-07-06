import { dispatch, RequestErrors, type JmapRequest } from "@bullmoose/jmap-core";
import { CORE_CAP, MAIL_CAP, SUBMISSION_CAP, WEBSOCKET_CAP } from "@bullmoose/jmap-core";
import { accountStub } from "@bullmoose/account-do";
import { Mailstore } from "@bullmoose/mailstore";
import { authenticate, accountAccess, type AuthEnv } from "./auth";
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
}

const SUPPORTED_CAPS = new Set([CORE_CAP, MAIL_CAP, SUBMISSION_CAP, WEBSOCKET_CAP]);
const registry = buildRegistry();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const principal = authenticate(request, env);
    if (!principal) {
      return json({ error: "unauthorized" }, 401, {
        "www-authenticate": 'Bearer realm="jmap"',
      });
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
      return handleDownload(url, env, principal);
    }

    // Blob upload: /api/upload/{accountId}
    if (request.method === "POST" && url.pathname.startsWith("/api/upload/")) {
      return handleUpload(request, url, env, principal);
    }

    // Push: proxy the WebSocket straight to the account's Durable Object.
    if (url.pathname === "/api/ws") {
      const accountId = url.searchParams.get("accountId") ?? principal.accounts[0]?.accountId;
      if (!accountId || !accountAccess(principal, accountId)) {
        return json({ error: "unknown account" }, 404);
      }
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
