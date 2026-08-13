import { MethodError, MethodRegistry } from "@bullmoose/jmap-core";
import type { Principal } from "@bullmoose/auth-core/principal";
import type { Env as JmapEnv } from "../../jmap/src/index";
import type { RequestContext } from "../../jmap/src/methods/common";
import { registerCalendarMethods } from "../../jmap/src/methods/calendars";
import { registerContactsMethods } from "../../jmap/src/methods/contacts";
import { registerEmailMethods } from "../../jmap/src/methods/email";
import { registerMailboxMethods } from "../../jmap/src/methods/mailbox";
import type { Env } from "./models.js";

/**
 * The bridge from the MCP tool surface into the JMAP method layer
 * (sVOL unit 013).
 *
 * ## Why the method layer and not SQL
 *
 * `_context.md` §3: `Mailstore` is a thin data layer that maintains no
 * invariants — `insertCalendarEvents` is a bare INSERT. The write
 * choreography lives in the methods:
 *
 *     mutate rows → accumulate ctags → bumpCalendarCtags
 *                 → commitChanges (AccountDO changelog) → newState
 *
 * Skip any of it and the row lands, reads back fine on a direct `/get`, and
 * is invisible to every incremental consumer: a stale ctag means CalDAV
 * clients never re-poll, and a missing changelog entry means `Foo/changes`
 * never reports it, so the CLI mirror never sees it. It presents as a sync
 * bug and is really a write-path bug. The four analytics tools query
 * `env.DB` with raw SQL — correct for read-only aggregates, wrong here.
 *
 * ## Why an in-process import and not a service binding
 *
 * `013`'s open question #1 leaned service binding, on the stated grounds
 * that it "matches how services/anglebrackets already projects off shared
 * state". That premise does not hold: `services/anglebrackets` has **no**
 * service binding to the jmap worker — it binds `ACCOUNT_DO` cross-script
 * (`services/anglebrackets/wrangler.jsonc`) and therefore *replicates* the
 * ctag + changelog choreography in `dav.ts` rather than calling it. That is
 * the drift risk §3 warns about, reproduced once already.
 *
 * `services/agent/wrangler.jsonc` binds `DB`, `BLOBS`, `ROUTES`,
 * `ACCOUNT_DO` (cross-script, same as anglebrackets) and `SUBMIT` — and no
 * jmap service binding. So the two options are not symmetric:
 *
 *   - in-process: zero binding changes, zero CI deploy-order changes, the
 *     choreography executes as *the same code* the jmap worker runs (no
 *     second implementation to drift), no extra hop inside an agent loop,
 *     and it is testable in plain Node against `@bullmoose/test-fakes`.
 *   - service binding: a new `services` entry, a new edge in the deploy
 *     graph CI derives its order from, a second full auth pass per tool
 *     call, an extra round trip, and tests that need a Fetcher fake running
 *     the whole jmap worker (the harness has no such fake).
 *
 * The cost of in-process is real and is build-time coupling: this is the
 * first cross-service import in the tree, and `services/agent`'s bundle now
 * contains the calendar and contacts method modules. That is the price of
 * one implementation of the choreography instead of two, and it is the
 * cheaper mistake to reverse — extracting the method layer into a package
 * later is a rename, whereas un-replicating a second copy is an audit.
 *
 * Calendar, contacts, email and mailbox modules are registered. `014` added
 * the last two: `Email/*` for read + triage, and `Mailbox/*` because a move
 * tool is useless without a way to name its destination, and because
 * `email_move --role archive` resolves the role through `Mailbox/query`.
 *
 * Registering a module is not the same as exposing it. The registry is
 * private to this file and reachable only through `callJmap`, whose `method`
 * argument every tool passes as a string LITERAL — no caller-controlled
 * method name reaches it. So `Mailbox/set` is registered and unreachable:
 * there is no folder-management tool, and adding one is `004`'s surface, not
 * this bridge's.
 */

const registry = new MethodRegistry<RequestContext>();
registerCalendarMethods(registry);
registerContactsMethods(registry);
registerEmailMethods(registry);
registerMailboxMethods(registry);

/**
 * Exactly the bindings the calendar/contacts methods read off `ctx.env`:
 * `DB` (Mailstore + the grant_audit write), `BLOBS` (Mailstore's blob
 * offload, e.g. contact photos) and `ACCOUNT_DO` (`accountState` /
 * `commitChanges`).
 *
 * jmap's `Env` additionally extends `AuthEnv`'s `DEV_*` dev-login vars,
 * which only `authenticate()` reads — and the MCP surface authenticates
 * with `verifyBearer` and never calls it. Rather than invent three fake
 * `DEV_*` values that would read as meaningful, the cast below is narrow
 * and this parameter type is the compile-time proof of the part that
 * matters: if `services/agent`'s Env ever stops binding one of the three,
 * every call site fails to typecheck.
 */
type MethodEnv = Pick<JmapEnv, "DB" | "BLOBS" | "ACCOUNT_DO">;

/**
 * A tool failure an agent can act on, rather than a stack trace.
 *
 * `handleToolCall` renders it as an MCP tool error (`isError: true`) with
 * `data` appended as JSON, so a model gets a sentence and a program gets a
 * structure.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** RFC 8620 SetError, as it comes back inside a `/set` response. */
export interface JmapSetError {
  type: string;
  description?: string;
  properties?: string[];
}

/** The `/set` response shape shared by CalendarEvent, ContactCard, ... */
export interface JmapSetResponse {
  accountId: string;
  oldState?: string;
  newState: string;
  created: Record<string, Record<string, unknown>>;
  notCreated: Record<string, JmapSetError>;
  updated: Record<string, null>;
  notUpdated: Record<string, JmapSetError>;
  destroyed: string[];
  notDestroyed: Record<string, JmapSetError>;
}

/**
 * Call a registered JMAP method in-process.
 *
 * The method runs its OWN `requireAccount(scope, domain)` gate — this is
 * deliberately a second gate, not a replacement for the per-tool one in
 * `handleToolCall`. The tool gate is what produces a `-32004` before any
 * work happens; this one is what guarantees a tool cannot widen its own
 * access by passing different arguments. Both write `grant_audit` for a
 * grant-reached call, under different `method` labels (`mcp:<tool>` and
 * `<domain>:<scope>`), which is two true rows rather than one duplicated.
 */
export async function callJmap<T = Record<string, unknown>>(
  env: Env & MethodEnv,
  principal: Principal,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const handler = registry.get(method);
  // Not a user error: the tool named a method this bridge never registered.
  if (!handler) throw new Error(`jmapBridge: no such method "${method}"`);
  // This bridge IS the agent tool surface, so every call through it carries
  // agent context (s10 T1): the contact-write chokepoint gates agent writers
  // on propose/governed books. Binding/invocation are unknown at this layer —
  // the bearer, not a job, is the identity — so provenance stays principal-only.
  const ctx: RequestContext = { env: env as unknown as JmapEnv, principal, agent: {} };
  try {
    return (await handler(args, ctx)) as T;
  } catch (err) {
    if (err instanceof MethodError) {
      throw new ToolError(
        `${method} failed: ${err.type}${err.description ? ` — ${err.description}` : ""}`,
        { jmapMethod: method, error: err.toArgs() },
      );
    }
    throw err;
  }
}

/**
 * What an agent should do about a rejected property, keyed by the
 * `properties` a SetError names.
 *
 * `recurrenceRules` is the one this unit is required to surface well:
 * `003` put a guard at the `eventSpan` write boundary, so a rule the
 * expander cannot expand exactly is REFUSED rather than silently stored
 * with wrong `end_at`. Without a hint the model sees "invalidProperties"
 * and retries the identical payload.
 */
const HINTS: Record<string, string> = {
  recurrenceRules:
    "This server only stores recurrence rules it can expand exactly, so a rule it " +
    "cannot compute is refused instead of being stored with wrong dates. Retrying " +
    "the same rule will fail the same way: either simplify it (a plain daily / " +
    "weekly / monthly / yearly repeat, optionally with byMonthDay, count or until) " +
    "or create the occurrences as separate single events.",
  uid: "Choose a different uid, or update the existing object instead of creating a second one.",
  calendarIds:
    "Pass a calendarId that calendar_list returned. This server allows exactly one calendar per event.",
  addressBookIds:
    "Pass an addressBookId that contacts_list_books returned. This server allows exactly one address book per card.",
  start:
    'start is a LocalDateTime with no offset and no trailing "Z" (e.g. "2026-11-26T17:00:00"); ' +
    "put the zone in timeZone instead.",
};

function rejected(what: string, e: JmapSetError): ToolError {
  const parts = [`${what} was rejected; nothing was written.`, `Reason: ${e.type}.`];
  if (e.description) parts.push(e.description);
  if (e.properties?.length) parts.push(`Offending properties: ${e.properties.join(", ")}.`);
  for (const p of e.properties ?? []) {
    const hint = HINTS[p];
    if (hint) {
      parts.push(hint);
      break;
    }
  }
  return new ToolError(parts.join(" "), { setError: e });
}

/** The single-object `create` half of a `/set` response, or a useful error. */
export function tookCreate(
  res: JmapSetResponse,
  cid: string,
  what: string,
): Record<string, unknown> {
  const bad = res.notCreated[cid];
  if (bad) throw rejected(what, bad);
  const ok = res.created[cid];
  if (!ok) throw new ToolError(`${what} was neither created nor refused.`, { response: res });
  return { ...ok, newState: res.newState };
}

/** The single-object `update` half of a `/set` response, or a useful error. */
export function tookUpdate(
  res: JmapSetResponse,
  id: string,
  what: string,
): Record<string, unknown> {
  const bad = res.notUpdated[id];
  if (bad) throw rejected(what, bad);
  if (!(id in res.updated)) {
    throw new ToolError(`${what} was neither updated nor refused.`, { response: res });
  }
  return { id, updated: true, newState: res.newState };
}

/** The single-object `destroy` half of a `/set` response, or a useful error. */
export function tookDestroy(
  res: JmapSetResponse,
  id: string,
  what: string,
): Record<string, unknown> {
  const bad = res.notDestroyed[id];
  if (bad) throw rejected(what, bad);
  if (!res.destroyed.includes(id)) {
    throw new ToolError(`${what} was neither destroyed nor refused.`, { response: res });
  }
  return { id, destroyed: true, newState: res.newState };
}
