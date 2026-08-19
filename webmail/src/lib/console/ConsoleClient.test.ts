import { describe, expect, it } from "vitest";
import {
  CONSOLE_ENDPOINTS,
  ConsoleUnavailable,
  FakeConsoleClient,
  HttpConsoleClient,
  resourceKey,
} from "./ConsoleClient";
import { DEMO_NOW, VENDORS_BOOK, createDemoConsole, demoConsoleData } from "./demoConsole";
import { consoleGate } from "./gate";
import type { Session } from "../jmap/types";

const SITE = "https://app.bullmoose.cc";
const VAULT = "https://agent.bullmoose.cc";
const DAY = 86_400_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(respond: (url: string) => Response) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return respond(String(input));
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const http = (fetchImpl: typeof fetch): HttpConsoleClient =>
  new HttpConsoleClient({ origins: { vault: VAULT, site: SITE }, token: "tok", fetch: fetchImpl });

describe("HttpConsoleClient", () => {
  it("reads credentials from the LIVE vault route", async () => {
    const { seen, fetchImpl } = recorder(() => json({ credentials: [{ name: "aws-mcp" }] }));
    const creds = await http(fetchImpl).listCredentials();
    expect(seen[0]).toBe(`${VAULT}${CONSOLE_ENDPOINTS.credentials}`);
    expect(creds[0]?.name).toBe("aws-mcp");
  });

  it("splits the two surfaces: /console/* to the site backend, /vault/* to the vault", async () => {
    // The read interface is served same-origin (services/jmap/src/console.ts);
    // the vault worker has no public route and sends no CORS headers, so a
    // console read addressed there is unreachable from a browser even now that
    // the routes exist. `readBase` is what keeps them apart.
    const { seen, fetchImpl } = recorder(() => json({ agents: [], resources: [], credentials: [] }));
    const c = http(fetchImpl);
    await c.listAgents();
    await c.listResources("acct_allen");
    await c.resourceDossier(VENDORS_BOOK, { at: 2, since: 1 }).catch(() => undefined);
    expect(seen).toHaveLength(3);
    for (const url of seen) expect(new URL(url).origin).toBe(SITE);

    seen.length = 0;
    await c.listCredentials();
    expect(new URL(seen[0] as string).origin).toBe(VAULT);
  });

  it("reads the console with NO vault origin configured — the default deployment", async () => {
    // T2 only needs a vault origin to MUTATE a credential. An operator who has
    // not set one must still get the whole read surface, or the console is dead
    // out of the box.
    const { seen, fetchImpl } = recorder(() => json({ agents: [] }));
    const c = new HttpConsoleClient({
      origins: { vault: "", site: SITE },
      token: "tok",
      fetch: fetchImpl,
    });
    await c.listAgents();
    expect(seen[0]).toBe(`${SITE}${CONSOLE_ENDPOINTS.agents}`);
  });

  it("carries the point-in-time instant on the wire", async () => {
    const { seen, fetchImpl } = recorder(() => json({}));
    await http(fetchImpl).resourceDossier(VENDORS_BOOK, { at: 1700, since: 900 });
    expect(seen[0]).toContain("at=1700");
    expect(seen[0]).toContain("since=900");
    expect(seen[0]).toContain("ab_vendors");
  });

  it("names the missing endpoint instead of rendering a blank panel", async () => {
    const { fetchImpl } = recorder(() => json({ error: "not found" }, 404));
    const err = await http(fetchImpl)
      .listAgents()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleUnavailable);
    expect((err as ConsoleUnavailable).endpoint).toBe(CONSOLE_ENDPOINTS.agents);
    expect((err as ConsoleUnavailable).status).toBe(404);
    expect(String(err)).toContain("/console/agents");
  });

  it("does not invent data when the read interface is absent", async () => {
    // A governance screen that falls back to samples wearing a live label is
    // worse than one that is honest about being empty.
    const { fetchImpl } = recorder(() => json({ error: "not found" }, 404));
    await expect(http(fetchImpl).agentDossier("acct_allen")).rejects.toThrow(ConsoleUnavailable);
  });
});

describe("FakeConsoleClient", () => {
  const fake = createDemoConsole();

  it("implements the same interface the UI receives", async () => {
    expect((await fake.listAgents()).map((a) => a.principal)).toEqual(["allen@bullmoose.cc", "analyst@bullmoose.cc"]);
    expect((await fake.listCredentials()).map((c) => c.name)).toContain("aws-mcp");
    expect((await fake.listResources("acct_allen"))[0]?.name).toBe("VendorsBook");
  });

  it("windows the audit trail, but returns the grant set whole so tombstones survive", async () => {
    const narrow = await fake.resourceDossier(VENDORS_BOOK, {
      at: DEMO_NOW,
      since: DEMO_NOW - 3 * DAY,
    });
    // Only the refusal (2 days ago) falls inside a 3-day window.
    expect(narrow.audit).toHaveLength(1);
    // …and the revoked grant is still on the wire, which is what makes
    // reconstruction at an earlier instant possible at all.
    expect(narrow.grants.map((g) => g.grantId)).toContain("g_temp_vendors");
  });

  it("refuses an unknown agent with the same error the HTTP client would raise", async () => {
    await expect(fake.agentDossier("acct_nope")).rejects.toThrow(ConsoleUnavailable);
  });

  it("records its calls so a surface can be asserted not to over-fetch", async () => {
    const f = new FakeConsoleClient(demoConsoleData());
    await f.listAgents();
    await f.agentDossier("acct_allen");
    expect(f.calls).toEqual(["listAgents", "agentDossier:acct_allen"]);
  });

  it("keys resources the same way both sides do", () => {
    expect(resourceKey(VENDORS_BOOK)).toBe("AddressBook:ab_vendors");
  });
});

// ── the plain-client floor ──────────────────────────────────────────────────

const session = (caps: Record<string, unknown>): Pick<Session, "capabilities"> =>
  ({ capabilities: caps }) as Pick<Session, "capabilities">;

describe("the capability gate keeps the plain-client proof green", () => {
  it("is closed with the agent capability absent, and says so without erroring", () => {
    const gate = consoleGate(session({ "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} }));
    expect(gate.state).toBe("no-capability");
    expect(gate.visible).toBe(false);
    // Not an error string: this is the supported configuration.
    expect(gate.reason).toContain("The mail client is unaffected");
  });

  it("is open when the LIVE urn is advertised", () => {
    // The server advertises the fuller `urn:bullmoose:params:jmap:agent`; the
    // arch doc's `urn:bullmoose:agent` is shorthand and must NOT open the gate.
    expect(consoleGate(session({ "urn:bullmoose:params:jmap:agent": {} })).visible).toBe(true);
    expect(consoleGate(session({ "urn:bullmoose:agent": {} })).visible).toBe(false);
  });

  it("is closed before a session resolves", () => {
    expect(consoleGate(undefined).visible).toBe(false);
  });
});
