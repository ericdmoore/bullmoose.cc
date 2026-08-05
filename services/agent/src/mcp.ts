import { authorizeAccount, verifyBearer, type Principal } from "@bullmoose/auth-core/principal";
import type { Env } from "./models.js";

/**
 * mailstore-analytics — bullmoose's own MCP server (devPlan-handoff
 * Phase 3): a READ-ONLY tool surface over the message log + spend
 * ledger, so an analyst-style agent gets useful tools with zero
 * external credentials. Every tool is a bounded, parameterized query —
 * no free-form SQL crosses this boundary.
 *
 * Transport: stateless MCP (2026-07-28 / SEP-2575). One JSON-RPC request
 * per POST, one response — no session, no `initialize`, no `ping`. Each
 * request carries its own protocol version (an HTTP header mirrored in
 * `_meta`) and its own identity: a bearer token resolved to a principal,
 * with every tool call authorized against the TARGET account (token ∩
 * grant) and audited — never a self-asserted accountId. The platform
 * `x-internal-token` remains as a coarse network ACL on the route (see
 * index.ts); the bearer is the identity. See .plans/s01-stateless-MCP/.
 */

const PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
/** Clients may cache tools/list this long (MCP.2 list cache hint). */
const TOOLS_LIST_TTL_MS = 5 * 60_000;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const PROTO_META = "io.modelcontextprotocol/protocolVersion";
const CAPS_META = "io.modelcontextprotocol/clientCapabilities";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: Record<string, unknown>) => Promise<unknown>;
}

const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
};

const requireAccountId = (args: Record<string, unknown>): string => {
  if (typeof args.accountId !== "string" || args.accountId.length === 0) {
    throw new Error("accountId is required");
  }
  return args.accountId;
};

const TOOLS: ToolDef[] = [
  {
    name: "spend_by_month",
    description:
      "Monthly spend totals from the receipt ledger (spend_facts): period, currency, total, transaction count.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "bullmoose account id" },
        months: { type: "number", description: "how many recent months (default 6, max 24)" },
      },
      required: ["accountId"],
    },
    async run(env, args) {
      const months = clampInt(args.months, 6, 1, 24);
      const { results } = await env.DB.prepare(
        `SELECT period_month, currency, SUM(amount_cents) AS total_cents, COUNT(*) AS txns
         FROM spend_facts WHERE account_id = ?
         GROUP BY period_month, currency
         ORDER BY period_month DESC LIMIT ?`,
      )
        .bind(requireAccountId(args), months)
        .all();
      return results;
    },
  },
  {
    name: "spend_by_vendor",
    description:
      "Spend grouped by vendor, optionally within one month (YYYY-MM). Top N by total.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        month: { type: "string", description: "YYYY-MM; omit for all time" },
        top: { type: "number", description: "max vendors (default 10, max 50)" },
      },
      required: ["accountId"],
    },
    async run(env, args) {
      const top = clampInt(args.top, 10, 1, 50);
      const month = typeof args.month === "string" && /^\d{4}-\d{2}$/.test(args.month) ? args.month : null;
      const { results } = await env.DB.prepare(
        `SELECT vendor, currency, SUM(amount_cents) AS total_cents, COUNT(*) AS txns
         FROM spend_facts WHERE account_id = ? ${month ? "AND period_month = ?" : ""}
         GROUP BY vendor, currency
         ORDER BY total_cents DESC LIMIT ?`,
      )
        .bind(...(month ? [requireAccountId(args), month, top] : [requireAccountId(args), top]))
        .all();
      return results;
    },
  },
  {
    name: "top_senders",
    description: "Most frequent senders over a recent window of days.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        days: { type: "number", description: "window (default 30, max 365)" },
        limit: { type: "number", description: "max senders (default 10, max 50)" },
      },
      required: ["accountId"],
    },
    async run(env, args) {
      const days = clampInt(args.days, 30, 1, 365);
      const limit = clampInt(args.limit, 10, 1, 50);
      const since = Date.now() - days * 86_400_000;
      const { results } = await env.DB.prepare(
        `SELECT COALESCE(json_extract(from_json, '$[0].email'), '(unknown)') AS sender,
                COUNT(*) AS messages
         FROM emails WHERE account_id = ? AND received_at >= ?
         GROUP BY sender ORDER BY messages DESC LIMIT ?`,
      )
        .bind(requireAccountId(args), since, limit)
        .all();
      return results;
    },
  },
  {
    name: "message_volume",
    description: "Messages received per day over a recent window.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        days: { type: "number", description: "window (default 14, max 90)" },
      },
      required: ["accountId"],
    },
    async run(env, args) {
      const days = clampInt(args.days, 14, 1, 90);
      const since = Date.now() - days * 86_400_000;
      const { results } = await env.DB.prepare(
        `SELECT date(received_at / 1000, 'unixepoch') AS day, COUNT(*) AS messages
         FROM emails WHERE account_id = ? AND received_at >= ?
         GROUP BY day ORDER BY day`,
      )
        .bind(requireAccountId(args), since)
        .all();
      return results;
    },
  },
];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "MCP: POST JSON-RPC only" }, 405);
  }

  // Identity first: MCP.2 has no session to authenticate once, so every
  // request carries its own bearer. Resolve it to a principal up front.
  const authz = request.headers.get("Authorization") ?? "";
  const raw = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  const principal = raw ? await verifyBearer(env.DB, raw) : null;
  if (!principal) return rpcError(null, -32001, "unauthorized", 401);

  let msg: JsonRpcRequest;
  try {
    msg = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg.id ?? null, -32600, "invalid request", 400);
  }

  // Notifications carry no id and expect an empty 202 — no version gate.
  if (msg.id === undefined || msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  // Per-request protocol negotiation (SEP-2575): the header MUST be present
  // and MUST equal the _meta value; an unknown version returns a typed error
  // carrying the supported set. No `initialize`, no `ping`.
  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  if (!headerVersion || headerVersion !== meta[PROTO_META]) {
    return rpcError(
      msg.id,
      -32600,
      "MCP-Protocol-Version header is required and must equal _meta protocolVersion",
      400,
    );
  }
  if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
    return rpcError(msg.id, UNSUPPORTED_PROTOCOL_VERSION, `unsupported protocol version: ${headerVersion}`, 400, {
      supported: SUPPORTED_VERSIONS,
      requested: headerVersion,
    });
  }
  if (typeof meta[CAPS_META] !== "object" || meta[CAPS_META] === null) {
    return rpcError(msg.id, -32602, "_meta clientCapabilities is required per request", 400);
  }

  switch (msg.method) {
    case "server/discover":
      return rpcResult(msg.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: "bullmoose-mailstore-analytics", version: "1.0.0" },
        instructions:
          "Read-only analytics over the bullmoose message log and spend ledger. " +
          "Each tool takes the accountId you are authorized to read.",
      });
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ttlMs: TOOLS_LIST_TTL_MS,
        cacheScope: "session",
      });
    case "tools/call":
      return handleToolCall(msg, request, env, principal);
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`, 404);
  }
}

async function handleToolCall(
  msg: JsonRpcRequest,
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  // The routable Mcp-Name header, when present, must agree with the body.
  const nameHeader = request.headers.get("Mcp-Name");
  if (nameHeader && nameHeader !== params.name) {
    return rpcError(msg.id, -32602, "Mcp-Name header does not match params.name", 400);
  }
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${String(params.name)}`, 400);

  const args = params.arguments ?? {};
  const accountId = args.accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    return rpcError(msg.id, -32602, "accountId is required", 400);
  }

  // §6 gate: authorize the TARGET account (token ∩ grant), never a self-
  // asserted id, and audit any grant-reached read.
  const decision = authorizeAccount(principal, accountId, "read", "mail");
  if (!decision.ok) {
    const detail = decision.reason === "accountNotFound" ? "account not found" : decision.detail;
    return rpcError(msg.id, -32004, detail, 403);
  }
  if (decision.auditGrant) {
    await env.DB.prepare(
      `INSERT INTO grant_audit (grant_id, principal, account_id, method, at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(decision.auditGrant.grantId, principal.username, accountId, `mcp:${tool.name}`, Date.now())
      .run();
  }

  try {
    const result = await tool.run(env, args);
    return rpcResult(msg.id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
    });
  } catch (err) {
    return rpcResult(msg.id, { content: [{ type: "text", text: String(err) }], isError: true });
  }
}

function rpcResult(id: number | string | null | undefined, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
): Response {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
