import type { Env } from "./models.js";

/**
 * mailstore-analytics — bullmoose's own MCP server (devPlan-handoff
 * Phase 3): a READ-ONLY tool surface over the message log + spend
 * ledger, so an analyst-style agent gets useful tools with zero
 * external credentials. Every tool is a bounded, parameterized query —
 * no free-form SQL crosses this boundary.
 *
 * Transport: MCP streamable-HTTP (JSON-RPC 2.0 over POST, single
 * response per request — we never open a stream). Auth: the platform
 * INTERNAL_TOKEN via x-internal-token; this is an internal tool surface
 * for agent runtimes, not a public endpoint.
 */

const PROTOCOL_VERSION = "2025-06-18";

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
    return json({ error: "MCP streamable-http: POST JSON-RPC only" }, 405);
  }

  let msg: JsonRpcRequest;
  try {
    msg = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg.id ?? null, -32600, "invalid request");
  }

  // Notifications get an empty 202 per the streamable-http spec.
  if (msg.id === undefined || msg.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "bullmoose-mailstore-analytics", version: "1.0.0" },
      });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${String(params.name)}`);
      try {
        const result = await tool.run(env, params.arguments ?? {});
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (err) {
        return rpcResult(msg.id, {
          content: [{ type: "text", text: String(err) }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

function rpcResult(id: number | string | null | undefined, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: number | string | null | undefined, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
