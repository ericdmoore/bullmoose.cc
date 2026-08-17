import { MethodRegistry, dispatch } from "@bullmoose/jmap-core";
import { describe, expect, it, vi } from "vitest";
import { AGENT_CAP, CORE_CAP, MAIL_CAP } from "./capabilities";
import { FetchJmapClient, JmapRequestError, backReference, type WebSocketLike } from "./JmapClient";
import type { Invocation, Session } from "./types";

// ── fixtures ───────────────────────────────────────────────────────────────

const ACCT = "acct-1";

function makeSession(overrides: Partial<Session> = {}): Session {
  const caps: Record<string, unknown> = {
    [CORE_CAP]: { maxCallsInRequest: 16 },
    [MAIL_CAP]: {},
    [AGENT_CAP]: {},
  };
  return {
    capabilities: caps,
    accounts: {
      [ACCT]: {
        name: "me@bullmoose.test",
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: caps,
      },
    },
    primaryAccounts: { [MAIL_CAP]: ACCT },
    username: "me@bullmoose.test",
    apiUrl: "https://mail.test/api/jmap",
    downloadUrl: "https://mail.test/api/download/{accountId}/{blobId}/{name}?type={type}",
    uploadUrl: "https://mail.test/api/upload/{accountId}",
    eventSourceUrl: "https://mail.test/api/eventsource",
    state: "0",
    ...overrides,
  };
}

/** A fetch double: routes by (method, pathname) to a handler. */
function routedFetch(
  routes: Record<string, (url: URL, init: RequestInit) => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${(init.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response("no route", { status: 404 });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── session bootstrap ────────────────────────────────────────────────────────

describe("session bootstrap", () => {
  it("resolves the session from /.well-known/jmap with a bearer token", async () => {
    const seen: RequestInit[] = [];
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "bm_secret",
      fetch: routedFetch({
        "GET /.well-known/jmap": (_url, init) => {
          seen.push(init);
          return jsonResponse(makeSession());
        },
      }),
    });

    const session = await client.session();
    expect(session.apiUrl).toBe("https://mail.test/api/jmap");
    expect(session.primaryAccounts[MAIL_CAP]).toBe(ACCT);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer bm_secret");
  });

  it("caches the session — a second call makes no second fetch", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(makeSession()));
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await client.session();
    await client.session();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws a JmapRequestError carrying the HTTP status on a failed session", async () => {
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({ "GET /.well-known/jmap": () => new Response("nope", { status: 401 }) }),
    });
    await expect(client.session()).rejects.toMatchObject({ httpStatus: 401 });
  });
});

// ── batched requests + back-references ──────────────────────────────────────

describe("batched requests", () => {
  it("sends multiple method calls in one request body", async () => {
    let body: { using: string[]; methodCalls: Invocation[] } | undefined;
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        "POST /api/jmap": (_url, init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse({
            methodResponses: [
              ["Mailbox/get", { list: [] }, "a"],
              ["Email/query", { ids: ["e1"] }, "b"],
            ],
          });
        },
      }),
    });

    const responses = await client.request([
      ["Mailbox/get", { accountId: ACCT }, "a"],
      ["Email/query", { accountId: ACCT }, "b"],
    ]);

    expect(body?.methodCalls).toHaveLength(2);
    expect(responses).toHaveLength(2);
    expect(responses[1]?.[2]).toBe("b");
  });

  it("builds a back-reference the REAL server dispatcher resolves (one round trip)", async () => {
    // The client constructs Email/query → Email/get(#ids). We run its batch
    // through jmap-core's ACTUAL dispatch, so this proves the wire shape the
    // server resolves — not a shape only our fake understands.
    const registry = new MethodRegistry<unknown>()
      .register("Email/query", async () => ({ ids: ["e1", "e2", "e3"] }))
      // Echo back exactly the ids handed in — if the back-ref resolved, `ids`
      // is the array from Email/query, not the ResultReference object.
      .register("Email/get", async (args) => ({
        list: (args.ids as string[]).map((id) => ({ id, subject: `re: ${id}` })),
        notFound: [],
      }));

    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        "POST /api/jmap": async (_url, init) => {
          const req = JSON.parse(String(init.body));
          const resp = await dispatch(req, registry, {}, "0");
          return jsonResponse(resp);
        },
      }),
    });

    const { query, get } = await client.queryThenGet(ACCT, "Email/query", {}, "Email/get", [
      "id",
      "subject",
    ]);

    expect(query.ids).toEqual(["e1", "e2", "e3"]);
    expect((get.list as Array<{ id: string }>).map((m) => m.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("backReference() produces the RFC 8620 §3.7 shape", () => {
    expect(backReference("q", "Email/query", "/ids")).toEqual({
      resultOf: "q",
      name: "Email/query",
      path: "/ids",
    });
  });

  it("requestOne throws a typed error on a method-level error response", async () => {
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        "POST /api/jmap": () =>
          jsonResponse({ methodResponses: [["error", { type: "stateMismatch" }, "c0"]] }),
      }),
    });
    await expect(client.requestOne("Email/set", {})).rejects.toMatchObject({
      jmapType: "stateMismatch",
    });
  });
});

// ── capability awareness (the plain-client proof) ───────────────────────────

describe("capability-aware using[]", () => {
  it("includes the agent capability when the session advertises it", async () => {
    let body: { using: string[] } | undefined;
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        "POST /api/jmap": (_url, init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse({ methodResponses: [["AgentInvocation/get", {}, "c0"]] });
        },
      }),
    });
    await client.request([["AgentInvocation/get", { accountId: ACCT }, "c0"]]);
    expect(body?.using).toContain(AGENT_CAP);
    expect(await client.hasAgentCapability()).toBe(true);
  });

  it("OMITS the agent capability against a capability-less session (no 400)", async () => {
    // The plain-client gate (arch.md §5, invariant §6.4). A session WITHOUT the
    // agent cap must never send the agent URN in using[] — the server 400s on
    // an unsupported capability, so this is what keeps the plain client honest.
    const plainCaps = { [CORE_CAP]: {}, [MAIL_CAP]: {} };
    const plainSession = makeSession({
      capabilities: plainCaps,
      accounts: {
        [ACCT]: {
          name: "me",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: plainCaps,
        },
      },
    });

    let body: { using: string[] } | undefined;
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(plainSession),
        "POST /api/jmap": (_url, init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse({ methodResponses: [["Email/query", { ids: [] }, "c0"]] });
        },
      }),
    });

    expect(await client.hasAgentCapability()).toBe(false);
    // Even if a caller reaches for an agent method, using[] omits the agent URN.
    await client.request([["AgentInvocation/get", { accountId: ACCT }, "c0"]]);
    expect(body?.using).not.toContain(AGENT_CAP);
    expect(body?.using).toContain(CORE_CAP);
  });
});

// ── /changes sync cursor ────────────────────────────────────────────────────

describe("/changes sync cursor", () => {
  it("advances the per-collection cursor on each sync", async () => {
    const states: Record<string, { newState: string; created: string[] }> = {
      "5": { newState: "6", created: ["e10"] },
      "6": { newState: "7", created: ["e11", "e12"] },
    };
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        "POST /api/jmap": (_url, init) => {
          const req = JSON.parse(String(init.body));
          const since = req.methodCalls[0][1].sinceState as string;
          const step = states[since]!;
          return jsonResponse({
            methodResponses: [
              [
                "Email/changes",
                {
                  accountId: ACCT,
                  oldState: since,
                  newState: step.newState,
                  hasMoreChanges: false,
                  created: step.created,
                  updated: [],
                  destroyed: [],
                },
                "c0",
              ],
            ],
          });
        },
      }),
    });

    client.seedCursor("Email", "5");
    const first = await client.sync("Email");
    expect(first.created).toEqual(["e10"]);
    expect(client.cursor("Email")).toBe("6");

    const second = await client.sync("Email");
    expect(second.created).toEqual(["e11", "e12"]);
    expect(client.cursor("Email")).toBe("7");
  });

  it("refuses to sync a collection with no seeded cursor", async () => {
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({ "GET /.well-known/jmap": () => jsonResponse(makeSession()) }),
    });
    await expect(client.sync("Email")).rejects.toBeInstanceOf(JmapRequestError);
  });
});

// ── blob up/download ────────────────────────────────────────────────────────

describe("blob helpers", () => {
  it("uploads through the session uploadUrl and downloads the bytes back", async () => {
    const store = new Map<string, Uint8Array>();
    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "t",
      fetch: routedFetch({
        "GET /.well-known/jmap": () => jsonResponse(makeSession()),
        [`POST /api/upload/${ACCT}`]: async (_url, init) => {
          const bytes = new Uint8Array(init.body as ArrayBuffer);
          store.set("blob-x", bytes);
          return jsonResponse({ blobId: "blob-x", size: bytes.byteLength });
        },
        [`GET /api/download/${ACCT}/blob-x/report.txt`]: () =>
          // Copy into a fresh Uint8Array<ArrayBuffer> so it satisfies BodyInit
          // (TS 5.7 distinguishes the backing-buffer generic).
          new Response(new Uint8Array(store.get("blob-x")!), { status: 200 }),
      }),
    });

    const bytes = new TextEncoder().encode("hello attachment");
    const up = await client.upload(ACCT, bytes, "text/plain");
    expect(up).toEqual({ blobId: "blob-x", size: bytes.byteLength });

    const back = await client.download(ACCT, "blob-x", { name: "report.txt" });
    expect(new TextDecoder().decode(back)).toBe("hello attachment");
  });
});

// ── push loop (WS injected) ─────────────────────────────────────────────────

describe("watch push loop", () => {
  it("drives onChange from an injected StateChange push", async () => {
    type Listener = (ev: { data?: unknown }) => void;
    const listeners: Record<string, Listener> = {};
    const fakeSocket: WebSocketLike = {
      send: () => {},
      close: () => {},
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    };
    let openedUrl = "";

    const client = new FetchJmapClient({
      baseUrl: "https://mail.test",
      token: "bm_ws",
      fetch: routedFetch({ "GET /.well-known/jmap": () => jsonResponse(makeSession()) }),
      webSocketFactory: (url) => {
        openedUrl = url;
        return fakeSocket;
      },
    });

    const changes: Array<Record<string, Record<string, string>>> = [];
    const stop = await client.watch((changed) => changes.push(changed));

    // WS auth rides the query param (auth-core reads access_token — no header).
    expect(openedUrl).toContain("access_token=bm_ws");
    expect(openedUrl).toMatch(/^wss:/);

    listeners.open?.({});
    listeners.message?.({
      data: JSON.stringify({ "@type": "StateChange", changed: { [ACCT]: { Email: "9" } } }),
    });

    expect(changes).toEqual([{ [ACCT]: { Email: "9" } }]);
    stop();
  });
});
