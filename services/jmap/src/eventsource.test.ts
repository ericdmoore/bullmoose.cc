import { afterEach, describe, expect, it, vi } from "vitest";
import { commitChanges } from "@bullmoose/account-do";
import { mintToken } from "@bullmoose/auth-core";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import worker, { type Env } from "./index";
import { handleEventSource, type EventSourceLimits } from "./eventsource";
import type { Principal } from "./auth";

// RFC 8620 §7.3 — the EventSource push channel behind the session's
// `eventSourceUrl` template.
//
// The bug this file keeps dead, observed live: BoogieMail (a strictly-typed
// Swift JMAP client) fetched /.well-known/jmap, failed to decode a Session
// missing the §2-required `eventSourceUrl`, and hung forever — after #230
// removed the field because the URL it named 404'd. The cure for a dead URL
// is a live endpoint, so these tests drive the WORKER ENTRYPOINT for the
// framing/auth half and the handler directly for the streaming half, and
// session.test.ts pins that the template is advertised again.

const TENANT = "t_bm";
const ACCOUNT = "a_eric";

const ALL_TYPES = [
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
];

// ---- SSE plumbing ---------------------------------------------------------

interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
  comment?: string;
}

function parseFrame(block: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = ((frame.comment ?? "") + line.slice(1)).trim();
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("data: ")) frame.data = (frame.data ? `${frame.data}\n` : "") + line.slice(6);
  }
  return frame;
}

/** Parse a COMPLETE stream (closeafter=state) into its frames. */
function parseSse(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map(parseFrame);
}

/** Incremental frame reader for still-open streams. */
class SseReader {
  private buf = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** The next complete frame, or null when the stream has ended. */
  async next(): Promise<SseFrame | null> {
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx >= 0) {
        const block = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        if (block.trim() === "") continue;
        return parseFrame(block);
      }
      const { done, value } = await this.reader.read();
      if (done) return null;
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

function stateEvent(frame: SseFrame | null): { "@type": string; changed: Record<string, Record<string, string>> } {
  expect(frame).not.toBeNull();
  expect(frame!.event).toBe("state");
  return JSON.parse(frame!.data ?? "null");
}

// ---- harness --------------------------------------------------------------

interface Harness {
  w: FakeWorker;
  env: Env;
  principal: Principal;
  /** Authenticated GET through the real worker entrypoint. */
  get(path: string): Promise<Response>;
  /** The same GET with no credential at all. */
  getAnon(path: string): Promise<Response>;
  /** Bump the account's changelog (state "0" → "1" → …). */
  commit(): Promise<void>;
}

async function harness(scopes: string[] = ["mail"]): Promise<Harness> {
  const minted = await mintToken();
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: "eric@bullmoose.cc",
  });
  w.db.seed("tokens", [
    {
      id: minted.id,
      principal_id: "p_eric",
      kind: "bearer",
      secret_hash: minted.secretHash,
      name: "test",
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: null,
      last_used_at: Date.now(),
    },
  ]);
  const env = w.env as Env;
  return {
    w,
    env,
    principal: {
      username: "eric@bullmoose.cc",
      scopes: ["read"],
      accounts: [{ accountId: ACCOUNT, tenantId: TENANT, name: "Eric" }],
    },
    get: (path) =>
      worker.fetch(
        new Request(`https://jmap.bullmoose.cc${path}`, {
          headers: { Authorization: `Bearer ${minted.token}` },
        }),
        env,
      ),
    getAnon: (path) => worker.fetch(new Request(`https://jmap.bullmoose.cc${path}`), env),
    commit: async () => {
      await commitChanges(env.ACCOUNT_DO, ACCOUNT, [{ collection: "Email", created: ["m1"] }]);
    },
  };
}

/** Wrap the DO namespace so every stub fetch is counted — the "is the poll
 *  loop still alive" probe the disconnect tests assert against. */
function countingNs(ns: DurableObjectNamespace, counter: { n: number }): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return {
        fetch: (...args: Parameters<typeof stub.fetch>) => {
          counter.n += 1;
          return stub.fetch(...args);
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
}

const FAST: EventSourceLimits = { pollMs: 20, pingFloorSeconds: 10, maxAgeMs: 60_000 };

function directRequest(query: string, signal?: AbortSignal): { request: Request; url: URL } {
  const href = `https://jmap.bullmoose.cc/api/eventsource${query}`;
  return {
    request: new Request(href, signal ? { signal } : undefined),
    url: new URL(href),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("auth: the same gate as every other route", () => {
  it("unauthenticated → a 401 JSON refusal, not a stream", async () => {
    const h = await harness();
    const res = await h.getAnon("/api/eventsource?types=*&closeafter=state&ping=0");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("a token with no read-implying scope → 403, not a stream", async () => {
    const h = await harness([]);
    const res = await h.get("/api/eventsource?types=*&closeafter=state&ping=0");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("closeafter=state: one honest snapshot, then goodbye", () => {
  it("streams exactly one §7.1 StateChange with current state for every type, then closes", async () => {
    const h = await harness();
    await h.commit(); // state "0" → "1", so the event carries a real value

    const res = await h.get("/api/eventsource?types=*&closeafter=state&ping=0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    // res.text() resolves ONLY if the server actually closes the stream —
    // this line is itself the closeafter assertion.
    const frames = parseSse(await res.text());
    expect(frames).toHaveLength(1);
    const change = stateEvent(frames[0]!);
    expect(change["@type"]).toBe("StateChange");
    expect(Object.keys(change.changed)).toEqual([ACCOUNT]);
    expect(Object.keys(change.changed[ACCOUNT]!).sort()).toEqual([...ALL_TYPES].sort());
    expect(change.changed[ACCOUNT]!.Email).toBe("1");
    expect(change.changed[ACCOUNT]!.Mailbox).toBe("1");
  });

  it("`types` filters: requested-and-known kept, unknown silently absent", async () => {
    const h = await harness();
    const res = await h.get("/api/eventsource?types=Email,Bogus&closeafter=state&ping=0");
    const frames = parseSse(await res.text());
    expect(frames).toHaveLength(1);
    const change = stateEvent(frames[0]!);
    expect(Object.keys(change.changed[ACCOUNT]!)).toEqual(["Email"]);
  });
});

describe("the open stream: poll → StateChange", () => {
  it("a DO commit surfaces as a second state event naming the new state", async () => {
    const h = await harness();
    const { request, url } = directRequest("?types=*&ping=0");
    const res = await handleEventSource(request, url, { env: h.env, principal: h.principal }, FAST);
    const reader = new SseReader(res.body!.getReader());

    const initial = stateEvent(await reader.next());
    expect(initial.changed[ACCOUNT]!.Email).toBe("0");

    await h.commit();
    const update = stateEvent(await reader.next());
    expect(update.changed[ACCOUNT]!.Email).toBe("1");
    expect(update.changed[ACCOUNT]!.Mailbox).toBe("1");

    await reader.cancel();
  });

  it("client disconnect (reader cancel) stops the poll loop — no dangling timers", async () => {
    const h = await harness();
    const counter = { n: 0 };
    const env = { ...h.env, ACCOUNT_DO: countingNs(h.env.ACCOUNT_DO, counter) } as Env;

    const { request, url } = directRequest("?types=*&ping=0");
    const res = await handleEventSource(request, url, { env, principal: h.principal }, FAST);
    const reader = new SseReader(res.body!.getReader());
    stateEvent(await reader.next());

    await sleep(50); // let a few polls land, proving the loop was alive
    await reader.cancel();
    await sleep(60); // in-flight tick, if any, settles
    const after = counter.n;
    expect(after).toBeGreaterThan(1); // snapshot + at least one poll
    await sleep(80);
    expect(counter.n).toBe(after); // …and then NOTHING once the client left
  });

  it("request abort (EventSource.close()) ends the stream and the polling", async () => {
    const h = await harness();
    const counter = { n: 0 };
    const env = { ...h.env, ACCOUNT_DO: countingNs(h.env.ACCOUNT_DO, counter) } as Env;

    const aborter = new AbortController();
    const { request, url } = directRequest("?types=*&ping=0", aborter.signal);
    const res = await handleEventSource(request, url, { env, principal: h.principal }, FAST);
    const reader = new SseReader(res.body!.getReader());
    stateEvent(await reader.next());

    aborter.abort();
    expect(await reader.next()).toBeNull(); // stream closed cleanly
    await sleep(60);
    const after = counter.n;
    await sleep(80);
    expect(counter.n).toBe(after);
  });
});

describe("ping and the connection bound", () => {
  it("ping events fire at the FLOORED cadence and say the interval actually used", async () => {
    const h = await harness();
    vi.useFakeTimers();
    // Client asks for 1s; the floor is 10s, and §7.3 says the event reports
    // the interval the server is actually using — so the floor is visible.
    const { request, url } = directRequest("?types=*&ping=1");
    const res = await handleEventSource(request, url, { env: h.env, principal: h.principal });
    const reader = new SseReader(res.body!.getReader());
    stateEvent(await reader.next());

    await vi.advanceTimersByTimeAsync(10_000);
    const ping = await reader.next();
    expect(ping?.event).toBe("ping");
    expect(JSON.parse(ping?.data ?? "null")).toEqual({ interval: 10 });

    await reader.cancel();
  });

  it("the stream closes itself at maxAge with a comment saying why", async () => {
    const h = await harness();
    vi.useFakeTimers();
    const { request, url } = directRequest("?types=*&ping=0");
    const res = await handleEventSource(request, url, { env: h.env, principal: h.principal });
    const reader = new SseReader(res.body!.getReader());
    stateEvent(await reader.next());

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const last = await reader.next();
    expect(last?.comment).toContain("reconnect");
    expect(await reader.next()).toBeNull(); // closed — the client's cue to redial
  });
});
