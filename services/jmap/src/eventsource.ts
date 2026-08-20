import type { StateChange } from "@bullmoose/jmap-core";
import { accountState, type RequestContext } from "./methods/common";

/**
 * RFC 8620 §7.3 — the EventSource (SSE) push channel.
 *
 * `GET /api/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
 * behind the SAME auth gate as every other route in this worker (index.ts
 * resolves the principal before routing; native EventSource clients can and
 * do send Authorization headers). No token-in-URL variant is added here —
 * webmail's tokenInUrl invariant stands.
 *
 * Shape of the stream:
 *  - on open: one `state` event carrying the CURRENT state for every account
 *    the principal reaches (the same set the session document lists), as a
 *    §7.1 StateChange: `{"@type":"StateChange","changed":{acct:{Type:state}}}`;
 *  - then: poll the AccountDO `/state` door (the same one Foo/get answers
 *    from — `accountState` in methods/common.ts, one reader, no drift) every
 *    `pollMs`, and emit a `state` event naming only the accounts whose state
 *    string moved;
 *  - `ping={seconds}`: periodic `ping` events, data `{"interval":n}`. The
 *    cadence is floored at `pingFloorSeconds` (10s) — a 1-second ping over a
 *    polled backend is pure cost — and per §7.3 the event reports the
 *    interval the server is ACTUALLY using, so the floor is visible, not
 *    silent;
 *  - `closeafter=state`: close after the first `state` event (the "poll me
 *    over SSE" mode);
 *  - `types`: `*` or a comma-list; unknown type names are simply absent from
 *    the events (never an error), per the changelog's actual vocabulary.
 *
 * Workers honesty: a streaming response holds the invocation (and its
 * isolate) open for as long as the client stays connected, so the connection
 * is BOUNDED — after `maxAgeMs` (~4 min) the stream closes cleanly with a
 * comment saying why. EventSource clients auto-reconnect by design; rotation
 * is the protocol working, not a failure. Client disconnect (stream cancel /
 * request abort) tears down every timer, so no poll loop outlives its reader.
 */

/**
 * The type names the AccountDO changelog actually carries — the union
 * `proxyChanges` (methods/common.ts) accepts, kept in lockstep by hand
 * because that union is a type, not a value. The DO keeps ONE monotonic
 * sequence per account and filters per collection, so every type shares the
 * account's state string; that is spec-conformant (state strings are opaque)
 * and it is why one `/state` read covers all of these.
 */
const KNOWN_TYPES = [
  "Email",
  "Mailbox",
  "Thread",
  "EmailSubmission",
  "AgentInvocation",
  "ActionProposal",
  "Identity",
  "AddressBook",
  "ContactCard",
  "Calendar",
  "CalendarEvent",
  "FileNode",
] as const;

export interface EventSourceLimits {
  /** DO `/state` poll cadence while the stream is open. */
  pollMs: number;
  /** Floor for the client's requested `ping` interval, in seconds. */
  pingFloorSeconds: number;
  /** Connection rotation bound — see the header comment. */
  maxAgeMs: number;
}

export const DEFAULT_LIMITS: EventSourceLimits = {
  pollMs: 15_000,
  pingFloorSeconds: 10,
  maxAgeMs: 4 * 60_000,
};

/** §7.3 `types`: `*` (or absent) means everything; otherwise intersect. */
function requestedTypes(param: string | null): string[] {
  if (param === null || param === "" || param === "*") return [...KNOWN_TYPES];
  const asked = new Set(param.split(",").map((t) => t.trim()));
  return KNOWN_TYPES.filter((t) => asked.has(t));
}

/** §7.1 StateChange over the given account → state map. */
function stateChange(states: ReadonlyMap<string, string>, types: string[]): StateChange {
  const changed: StateChange["changed"] = {};
  for (const [accountId, state] of states) {
    const perType: Record<string, string> = {};
    for (const t of types) perType[t] = state;
    changed[accountId] = perType;
  }
  return { "@type": "StateChange", changed };
}

export async function handleEventSource(
  request: Request,
  url: URL,
  ctx: RequestContext,
  limits: EventSourceLimits = DEFAULT_LIMITS,
): Promise<Response> {
  const types = requestedTypes(url.searchParams.get("types"));
  const closeAfterState = url.searchParams.get("closeafter") === "state";
  const pingParam = Number.parseInt(url.searchParams.get("ping") ?? "0", 10);
  const pingSeconds = Number.isFinite(pingParam) && pingParam > 0 ? Math.max(pingParam, limits.pingFloorSeconds) : 0;

  const accountIds = ctx.principal.accounts.map((a) => a.accountId);

  // Snapshot BEFORE committing to a stream: if the DO door is unreachable the
  // client gets an honest 500 it can back off from, not a 200 that dies mid-
  // handshake.
  const lastSeen = new Map<string, string>();
  try {
    for (const accountId of accountIds) {
      lastSeen.set(accountId, await accountState(ctx, accountId));
    }
  } catch {
    return new Response(JSON.stringify({ error: "state unavailable" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let eventId = 0;
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  const stopTimers = () => {
    for (const t of timers) clearInterval(t as ReturnType<typeof setInterval>);
    timers.length = 0;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (event: string, data: string) => {
        if (closed) return;
        // `id` is set but Last-Event-ID is deliberately NOT honoured: §7.3
        // lets a server ignore it, and a reconnecting client then simply gets
        // current state — which is exactly what a fresh connection gets.
        eventId += 1;
        controller.enqueue(encoder.encode(`event: ${event}\nid: ${eventId}\ndata: ${data}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        stopTimers();
        try {
          controller.close();
        } catch {
          /* already errored/cancelled */
        }
      };

      // Client gone (EventSource.close(), process death, network drop): the
      // runtime aborts the request — stop polling immediately.
      request.signal.addEventListener("abort", finish);

      // §7.3: a state event on open, so a client never has to race the
      // stream against a separate poll to learn where it stands.
      send("state", JSON.stringify(stateChange(lastSeen, types)));
      if (closeAfterState) return finish();

      timers.push(
        setInterval(() => {
          void (async () => {
            try {
              const moved = new Map<string, string>();
              for (const accountId of accountIds) {
                if (closed) return;
                const state = await accountState(ctx, accountId);
                if (state !== lastSeen.get(accountId)) {
                  lastSeen.set(accountId, state);
                  moved.set(accountId, state);
                }
              }
              if (moved.size > 0) send("state", JSON.stringify(stateChange(moved, types)));
            } catch {
              // Transient DO failure: skip this tick; the next one retries.
            }
          })();
        }, limits.pollMs),
      );

      if (pingSeconds > 0) {
        timers.push(setInterval(() => send("ping", JSON.stringify({ interval: pingSeconds })), pingSeconds * 1000));
      }

      timers.push(
        setTimeout(() => {
          if (closed) return;
          // SSE comment (":" line) — clients ignore it; humans reading a
          // curl session learn why the stream ended.
          controller.enqueue(
            encoder.encode(": connection rotated — Workers bounds long-lived streams; reconnect to resume\n\n"),
          );
          finish();
        }, limits.maxAgeMs),
      );
    },
    cancel: () => {
      // Reader side dropped us (the other half of disconnect): same teardown.
      closed = true;
      stopTimers();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
