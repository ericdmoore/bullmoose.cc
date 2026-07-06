import type { Invocation, JmapRequest, JmapResponse, ResultReference } from "./types";
import { MethodError } from "./errors";

/**
 * A JMAP method handler. `Ctx` is whatever per-request context the host
 * worker wants to thread through (env bindings, authed principal, ...).
 */
export type MethodHandler<Ctx> = (
  args: Record<string, unknown>,
  ctx: Ctx,
) => Promise<Record<string, unknown>>;

export class MethodRegistry<Ctx> {
  private handlers = new Map<string, MethodHandler<Ctx>>();

  register(name: string, handler: MethodHandler<Ctx>): this {
    this.handlers.set(name, handler);
    return this;
  }

  get(name: string): MethodHandler<Ctx> | undefined {
    return this.handlers.get(name);
  }
}

/**
 * Run a JMAP request through the registry, resolving back-references
 * (RFC 8620 §3.7) between method calls. Calls execute sequentially, as
 * the spec requires — later calls may reference earlier results.
 */
export async function dispatch<Ctx>(
  request: JmapRequest,
  registry: MethodRegistry<Ctx>,
  ctx: Ctx,
  sessionState: string,
): Promise<JmapResponse> {
  const responses: Invocation[] = [];

  for (const [name, rawArgs, callId] of request.methodCalls) {
    const handler = registry.get(name);
    if (!handler) {
      responses.push(["error", { type: "unknownMethod" }, callId]);
      continue;
    }

    try {
      const args = resolveReferences(rawArgs, responses);
      const result = await handler(args, ctx);
      responses.push([name, result, callId]);
    } catch (err) {
      if (err instanceof MethodError) {
        responses.push(["error", err.toArgs(), callId]);
      } else {
        console.error(`JMAP ${name} failed:`, err);
        responses.push(["error", { type: "serverFail", description: String(err) }, callId]);
      }
    }
  }

  return { methodResponses: responses, sessionState };
}

/** Replace `#key` result-reference args with values from prior responses. */
function resolveReferences(
  args: Record<string, unknown>,
  prior: Invocation[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      out[key] = value;
      continue;
    }
    const realKey = key.slice(1);
    if (realKey in args) {
      throw new MethodError("invalidArguments", `both "${key}" and "${realKey}" present`);
    }
    const ref = value as ResultReference;
    const source = prior.find(([n, , id]) => id === ref.resultOf && n === ref.name);
    if (!source) {
      throw new MethodError(
        "invalidResultReference",
        `no prior ${ref.name} response with callId "${ref.resultOf}"`,
      );
    }
    out[realKey] = evalPointer(source[1], ref.path);
  }
  return out;
}

/**
 * RFC 8620 §3.7 JSON pointer evaluation, extended with "*" to map over
 * arrays (flattening one level, per spec).
 */
function evalPointer(value: unknown, path: string): unknown {
  const tokens = path
    .split("/")
    .filter((t, i) => !(i === 0 && t === ""))
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  return walkPointer(value, tokens);
}

function walkPointer(value: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return value;
  const [token, ...rest] = tokens as [string, ...string[]];

  if (token === "*") {
    if (!Array.isArray(value)) {
      throw new MethodError("invalidResultReference", `"*" applied to non-array`);
    }
    const mapped = value.map((item) => walkPointer(item, rest));
    return rest.includes("*") || mapped.every(Array.isArray) ? mapped.flat(1) : mapped;
  }

  if (Array.isArray(value)) {
    const idx = Number(token);
    if (!Number.isInteger(idx) || idx < 0 || idx >= value.length) {
      throw new MethodError("invalidResultReference", `index "${token}" out of range`);
    }
    return walkPointer(value[idx], rest);
  }

  if (value !== null && typeof value === "object" && token in (value as object)) {
    return walkPointer((value as Record<string, unknown>)[token], rest);
  }

  throw new MethodError("invalidResultReference", `path segment "${token}" not found`);
}
