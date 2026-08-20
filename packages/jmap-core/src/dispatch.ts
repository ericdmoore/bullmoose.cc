import type { Invocation, JmapRequest, JmapResponse, ResultReference } from "./types";
import { MethodError } from "./errors";

/**
 * Per-call dispatch state a handler may consult, beyond its own arguments.
 *
 * `createdIds` is the RFC 8620 §3.3 creation-id map: client-chosen creation id
 * → the id the server assigned when an earlier /set (or /copy) in this request
 * created the record, seeded from the request's own `createdIds` property. It
 * exists because a batching client references records it has not seen yet —
 * `[Email/set create "big", EmailSubmission/set {emailId: "#big"}]` must work
 * in one round trip. /set handlers resolve `#cid` values in their Id-typed
 * properties against this map; the dispatcher maintains it (see
 * `harvestCreatedIds`) so every handler sees one consistent view.
 */
export interface CallMeta {
  createdIds: ReadonlyMap<string, string>;
}

/**
 * A JMAP method handler. `Ctx` is whatever per-request context the host
 * worker wants to thread through (env bindings, authed principal, ...).
 * `meta` is optional at the declaration site on purpose: only /set-shaped
 * methods with Id-typed properties care, and every other handler keeps its
 * two-argument signature untouched.
 */
export type MethodHandler<Ctx> = (
  args: Record<string, unknown>,
  ctx: Ctx,
  meta?: CallMeta,
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
 *
 * Alongside result references, the dispatcher maintains the §3.3 creation-id
 * map: seeded from `request.createdIds`, grown after every method response
 * whose `created` map assigned real ids, and handed to each handler via
 * `CallMeta`. Per spec the response echoes the merged map — but only when the
 * request carried a `createdIds` property at all, so non-batching clients see
 * no new response field.
 */
export async function dispatch<Ctx>(
  request: JmapRequest,
  registry: MethodRegistry<Ctx>,
  ctx: Ctx,
  sessionState: string,
): Promise<JmapResponse> {
  const responses: Invocation[] = [];
  const createdIds = new Map<string, string>(Object.entries(request.createdIds ?? {}));

  for (const [name, rawArgs, callId] of request.methodCalls) {
    const handler = registry.get(name);
    if (!handler) {
      responses.push(["error", { type: "unknownMethod" }, callId]);
      continue;
    }

    try {
      const args = resolveReferences(rawArgs, responses);
      const result = await handler(args, ctx, { createdIds });
      responses.push([name, result, callId]);
      harvestCreatedIds(result, createdIds);
    } catch (err) {
      if (err instanceof MethodError) {
        responses.push(["error", err.toArgs(), callId]);
      } else {
        console.error(`JMAP ${name} failed:`, err);
        responses.push(["error", { type: "serverFail", description: String(err) }, callId]);
      }
    }
  }

  return {
    methodResponses: responses,
    ...(request.createdIds !== undefined ? { createdIds: Object.fromEntries(createdIds) } : {}),
    sessionState,
  };
}

/**
 * Fold a /set (or /copy) response's `created` map into the request's
 * creation-id map (RFC 8620 §3.3). Shape-checked rather than method-name
 * checked: any response carrying `created: { cid: { id } }` is a creation,
 * and anything else is left alone. A reused creation id overwrites the
 * earlier binding, which is what the spec prescribes.
 */
function harvestCreatedIds(result: Record<string, unknown>, map: Map<string, string>): void {
  const created = result.created;
  if (created === null || typeof created !== "object" || Array.isArray(created)) return;
  for (const [cid, obj] of Object.entries(created as Record<string, unknown>)) {
    const id = obj !== null && typeof obj === "object" ? (obj as { id?: unknown }).id : undefined;
    if (typeof id === "string") map.set(cid, id);
  }
}

/** Replace `#key` result-reference args with values from prior responses. */
function resolveReferences(args: Record<string, unknown>, prior: Invocation[]): Record<string, unknown> {
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
      throw new MethodError("invalidResultReference", `no prior ${ref.name} response with callId "${ref.resultOf}"`);
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
