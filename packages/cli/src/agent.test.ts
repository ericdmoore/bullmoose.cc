import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAccounts,
  fitsRequirements,
  fleetDrain,
  fleetFromSingle,
  isAuthzRefusal,
  loadFleetConfig,
  type FleetClient,
  type FleetConfig,
  type HostCapabilities,
} from "./agent.js";
import type { AccountRef } from "./db.js";
import type { Session } from "./jmap.js";

/**
 * s11 T8 — the fleet host's claim loop, driven against a fake server.
 *
 * agent.ts had no tests (the serve loop was all shell); the fleet rework
 * split out the pure/injectable parts — fitsRequirements, discoverAccounts,
 * fleetDrain over a FleetClient — so the loop is testable without a network.
 * The fake below implements just the JMAP subset the loop calls
 * (AgentInvocation/query|get|set, Email/get, Mailbox/query, Email/set) over
 * an in-memory invocation table spanning MULTIPLE accounts, because the
 * whole point of T8 is one process serving N accounts under one login.
 *
 * The AUTHORITY side (a granted principal may claim, an ungranted one may
 * not, revocation stops resolution) is proven server-side against the real
 * method + real grant rows in services/jmap/src/methods/agentGrants.test.ts.
 * Here the server is faked, so these tests cover the DAEMON's obligations:
 * claim only your bindings, skip unfit work, drop a refused account and
 * stop asking it.
 */

const AGENT_CAP = "urn:bullmoose:params:jmap:agent";
const CONTACTS_CAP = "urn:ietf:params:jmap:contacts";

interface FakeInvocation {
  id: string;
  accountId: string;
  bindingName: string;
  status: string;
  emailId: string | null;
  requires: Record<string, unknown> | null;
  result?: unknown;
}

/** In-memory fleet server: invocations across accounts + a revocation switch. */
function fakeServer(invocations: FakeInvocation[]) {
  const revoked = new Set<string>();
  const calls: Array<{ method: string; accountId: string }> = [];
  const drafts: Array<{ accountId: string; body: string }> = [];
  /** Every AgentInvocation/set argument object, verbatim — the wire shape. */
  const setCalls: Array<Record<string, unknown>> = [];

  const client: FleetClient = {
    async refreshSession(): Promise<Session> {
      throw new Error("not used by fleetDrain");
    },
    async one(method, args) {
      const accountId = args.accountId as string;
      calls.push({ method, accountId });
      if (revoked.has(accountId)) {
        // What JmapClient.one throws for a JMAP-level refusal: an Error
        // carrying jmapType. The server side of this contract is pinned by
        // agentGrants.test.ts ("refusal shapes the daemon relies on").
        const err = new Error(`${method} → accountNotFound`) as Error & { jmapType: string };
        err.jmapType = "accountNotFound";
        throw err;
      }
      const mine = invocations.filter((i) => i.accountId === accountId);
      switch (method) {
        case "AgentInvocation/query":
          return { ids: mine.filter((i) => i.status === args.status).map((i) => i.id) };
        case "AgentInvocation/get":
          return {
            list: mine
              .filter((i) => (args.ids as string[]).includes(i.id))
              .map((i) => ({
                id: i.id,
                bindingName: i.bindingName,
                status: i.status,
                emailId: i.emailId,
                requires: i.requires,
              })),
          };
        case "AgentInvocation/set": {
          setCalls.push(args);
          const updated: Record<string, null> = {};
          for (const [id, patch] of Object.entries(
            args.update as Record<string, Record<string, unknown>>,
          )) {
            const inv = mine.find((i) => i.id === id);
            if (!inv) continue;
            if (patch.status === "running" && inv.status !== "pending") continue; // claim guard
            inv.status = patch.status as string;
            if (patch.result !== undefined) inv.result = patch.result;
            updated[id] = null;
          }
          return { updated };
        }
        case "Email/get":
          return {
            list: [
              {
                id: args.ids ? (args.ids as string[])[0] : "e_x",
                from: [{ name: "Sender", email: "sender@example.com" }],
                subject: "hello",
                messageId: ["<m1@example>"],
                bodyValues: { p1: { value: "the body" } },
              },
            ],
          };
        case "Mailbox/query":
          return { ids: [`mb_drafts_${accountId}`] };
        case "Email/set": {
          const create = (args.create as Record<string, Record<string, unknown>>).r!;
          const bodyValues = create.bodyValues as Record<string, { value: string }>;
          drafts.push({ accountId, body: bodyValues.b!.value });
          return { created: { r: { id: `draft_${drafts.length}` } } };
        }
        default:
          throw new Error(`fake server: unexpected method ${method}`);
      }
    },
  };
  return { client, calls, drafts, setCalls, revoke: (id: string) => revoked.add(id) };
}

const ref = (accountId: string): AccountRef => ({ accountId });
const servedOf = (...ids: string[]) => new Map(ids.map((id) => [id, ref(id)]));
const quiet = () => undefined;

const FLEET: FleetConfig = {
  capabilities: { vision: false, contextTokens: 32_000, tools: false },
  bindings: {
    "hermes-responder": { persona: "You are Hermes.", model: { provider: "mock" } },
    "allen-analyst": { persona: "You are Allen.", model: { provider: "mock" } },
  },
};

const inv = (over: Partial<FakeInvocation>): FakeInvocation => ({
  id: "inv_1",
  accountId: "a_hermes",
  bindingName: "hermes-responder",
  status: "pending",
  emailId: "e_1",
  requires: null,
  ...over,
});

// ---- one process, one login, two bindings on two accounts ------------------

describe("fleetDrain serves N bindings across N accounts in one pass", () => {
  it("claims and completes both accounts' invocations with per-binding configs", async () => {
    const rows = [
      inv({ id: "inv_h", accountId: "a_hermes", bindingName: "hermes-responder" }),
      inv({ id: "inv_a", accountId: "a_allen", bindingName: "allen-analyst" }),
    ];
    const s = fakeServer(rows);
    const served = servedOf("a_hermes", "a_allen");

    const handled = await fleetDrain(s.client, served, FLEET, quiet);

    expect(handled).toBe(2);
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    // One draft landed in EACH account — the fleet host wrote as both agents.
    expect(s.drafts.map((d) => d.accountId).sort()).toEqual(["a_allen", "a_hermes"]);
    // And both stayed served (no drops).
    expect([...served.keys()].sort()).toEqual(["a_allen", "a_hermes"]);
  });

  it("leaves another host's binding alone (no claim, still pending)", async () => {
    const rows = [inv({ id: "inv_x", bindingName: "not-in-this-fleet" })];
    const s = fakeServer(rows);
    const handled = await fleetDrain(s.client, servedOf("a_hermes"), FLEET, quiet);

    expect(handled).toBe(0);
    expect(rows[0]!.status).toBe("pending");
    // It looked (get) but never claimed (set).
    expect(s.calls.some((c) => c.method === "AgentInvocation/set")).toBe(false);
  });
});

// ---- revocation is live ----------------------------------------------------

describe("fleetDrain drops a revoked account without a restart", () => {
  it("an authz refusal removes the account; later drains stop asking it", async () => {
    const rows = [
      inv({ id: "inv_h", accountId: "a_hermes" }),
      inv({ id: "inv_a", accountId: "a_allen", bindingName: "allen-analyst" }),
    ];
    const s = fakeServer(rows);
    const served = servedOf("a_hermes", "a_allen");

    // hermes revokes its claim grant between drains. The server now refuses
    // (accountNotFound — the grant no longer resolves onto the principal).
    s.revoke("a_hermes");
    const handled = await fleetDrain(s.client, served, FLEET, quiet);

    // allen was untouched by hermes' revocation…
    expect(handled).toBe(1);
    expect(rows.find((r) => r.id === "inv_a")!.status).toBe("done");
    // …hermes' work was NOT claimed, and the account is out of the served set.
    expect(rows.find((r) => r.id === "inv_h")!.status).toBe("pending");
    expect([...served.keys()]).toEqual(["a_allen"]);

    // The next drain issues ZERO calls for the revoked account.
    const before = s.calls.length;
    await fleetDrain(s.client, served, FLEET, quiet);
    expect(s.calls.slice(before).every((c) => c.accountId === "a_allen")).toBe(true);
  });

  it("recognizes both refusal shapes (jmapType from the wire, type from MethodError)", () => {
    expect(isAuthzRefusal(Object.assign(new Error("x"), { jmapType: "accountNotFound" }))).toBe(
      true,
    );
    expect(isAuthzRefusal(Object.assign(new Error("x"), { jmapType: "forbidden" }))).toBe(true);
    expect(isAuthzRefusal({ type: "accountNotFound" })).toBe(true);
    expect(isAuthzRefusal(Object.assign(new Error("x"), { jmapType: "serverFail" }))).toBe(false);
    expect(isAuthzRefusal(new Error("ECONNREFUSED"))).toBe(false); // outage ≠ revocation
    expect(isAuthzRefusal(null)).toBe(false);
  });

  it("a network failure does NOT drop the account (only authz refusals do)", async () => {
    const served = servedOf("a_hermes");
    const client: FleetClient = {
      async refreshSession(): Promise<Session> {
        throw new Error("unused");
      },
      async one() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };
    await fleetDrain(client, served, FLEET, quiet);
    expect(served.has("a_hermes")).toBe(true);
  });
});

// ---- capability narrowing --------------------------------------------------

describe("capability narrowing: unfit work is not claimed", () => {
  it("skips an invocation requiring vision on a no-vision fleet, claims its unfaceted sibling", async () => {
    const rows = [
      inv({ id: "inv_vision", requires: { vision: true } }),
      inv({ id: "inv_plain", requires: null }),
    ];
    const s = fakeServer(rows);
    const handled = await fleetDrain(s.client, servedOf("a_hermes"), FLEET, quiet);

    expect(handled).toBe(1);
    expect(rows.find((r) => r.id === "inv_vision")!.status).toBe("pending"); // left for a fitter host
    expect(rows.find((r) => r.id === "inv_plain")!.status).toBe("done");
  });

  it("skips a context requirement beyond the declared window", async () => {
    const rows = [inv({ id: "inv_big", requires: { contextTokens: 200_000 } })];
    const s = fakeServer(rows);
    await fleetDrain(s.client, servedOf("a_hermes"), FLEET, quiet);
    expect(rows[0]!.status).toBe("pending");
  });

  it("fitsRequirements: the table", () => {
    const caps: HostCapabilities = { vision: false, contextTokens: 32_000, tools: false };
    const cases: Array<[HostCapabilities | undefined, unknown, boolean]> = [
      // Feature detection / DefaultCase: no facet → claim exactly as today.
      [caps, null, true],
      [caps, undefined, true],
      [caps, "garbage", true],
      // No declared vector (single --config mode) → no narrowing.
      [undefined, { vision: true }, true],
      // Booleans: required-and-absent refuses; declaring it admits.
      [caps, { vision: true }, false],
      [{ ...caps, vision: true }, { vision: true }, true],
      [caps, { tools: true }, false],
      [{ ...caps, tools: true }, { tools: true }, true],
      [caps, { vision: false, tools: false }, true],
      // Context window: numeric comparison; unstated cap = no known limit.
      [caps, { contextTokens: 32_000 }, true],
      [caps, { contextTokens: 32_001 }, false],
      [{ vision: true }, { contextTokens: 1_000_000 }, true],
      // Combined: every axis must fit.
      [{ ...caps, vision: true }, { vision: true, contextTokens: 64_000 }, false],
    ];
    for (const [c, r, want] of cases) {
      expect(
        fitsRequirements(c, r),
        `caps=${JSON.stringify(c)} requires=${JSON.stringify(r)}`,
      ).toBe(want);
    }
  });
});

// ---- the claim declares the host's identity (s11 T2) -----------------------

describe("the claim call carries the declared claimant identity", () => {
  it("a fleet with a capability vector claims as { isFree: true, capabilities }", async () => {
    const rows = [inv({ id: "inv_h" })];
    const s = fakeServer(rows);
    await fleetDrain(s.client, servedOf("a_hermes"), FLEET, quiet);

    const claim = s.setCalls.find(
      (c) => (c.update as Record<string, { status: string }>).inv_h?.status === "running",
    )!;
    // The homelab daemon IS the free runtime; the vector is fleet.json's,
    // verbatim. The server records this declaration on the claim
    // (trust-but-audit) and enforces the same fit predicate server-side.
    expect(claim.claimant).toEqual({
      isFree: true,
      capabilities: { vision: false, contextTokens: 32_000, tools: false },
    });
  });

  it("a capability-less fleet (single --config mode) still declares isFree, with NO vector", async () => {
    const rows = [inv({ id: "inv_h" })];
    const s = fakeServer(rows);
    const fleet: FleetConfig = { bindings: FLEET.bindings }; // fleetFromSingle's shape
    await fleetDrain(s.client, servedOf("a_hermes"), fleet, quiet);

    const claim = s.setCalls.find(
      (c) => (c.update as Record<string, { status: string }>).inv_h?.status === "running",
    )!;
    // No vector declared → the server's fit gate treats it as "claims as
    // today" (T2-FIT-CONTRACT); isFree still feeds policy + liveness.
    expect(claim.claimant).toEqual({ isFree: true });
  });

  it("completions carry no claimant — only the claim declares identity", async () => {
    const rows = [inv({ id: "inv_h" })];
    const s = fakeServer(rows);
    await fleetDrain(s.client, servedOf("a_hermes"), FLEET, quiet);

    const done = s.setCalls.find(
      (c) => (c.update as Record<string, { status: string }>).inv_h?.status === "done",
    )!;
    expect(done.claimant).toBeUndefined();
  });
});

// ---- discovery -------------------------------------------------------------

describe("discoverAccounts: the served set comes from grants, freshly", () => {
  const session = (accounts: Session["accounts"]): Session => ({
    accounts,
    primaryAccounts: {},
    apiUrl: "https://x/api/jmap",
    downloadUrl: "https://x/dl",
    username: "alpaca-daemon@bullmoose.cc",
  });

  it("serves owned and whole-account-granted accounts; excludes book-scoped grants", async () => {
    let refreshes = 0;
    const client: FleetClient = {
      async one() {
        throw new Error("unused");
      },
      async refreshSession() {
        refreshes++;
        return session({
          a_daemon: { name: "daemon", isPersonal: true, accountCapabilities: { [AGENT_CAP]: {} } },
          a_hermes: { name: "hermes", isPersonal: false, accountCapabilities: { [AGENT_CAP]: {} } },
          // A contacts-sharing grant must NOT make the daemon serve mail claims.
          a_book: {
            name: "book-share",
            isPersonal: false,
            accountCapabilities: { [CONTACTS_CAP]: {} },
          },
        });
      },
    };
    const accounts = await discoverAccounts(client);
    expect(accounts.map((a) => a.accountId).sort()).toEqual(["a_daemon", "a_hermes"]);
    // FRESH session each time — a cached account list would pin yesterday's grants.
    await discoverAccounts(client);
    expect(refreshes).toBe(2);
  });

  it("admits capability-less accounts (older server) — the drain refusal is the backstop", async () => {
    const client: FleetClient = {
      async one() {
        throw new Error("unused");
      },
      async refreshSession() {
        return session({ a_legacy: { name: "legacy" } });
      },
    };
    const accounts = await discoverAccounts(client);
    expect(accounts.map((a) => a.accountId)).toEqual(["a_legacy"]);
  });
});

// ---- config shapes ---------------------------------------------------------

describe("fleet config loading and the single-config adapter", () => {
  it("loadFleetConfig round-trips the documented shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-fleet-"));
    const path = join(dir, "fleet.json");
    writeFileSync(
      path,
      JSON.stringify({
        capabilities: { vision: false, contextTokens: 32000, tools: false },
        bindings: {
          "hermes-responder": { persona: "p1", model: { provider: "mock" } },
          "allen-analyst": { persona: "p2", model: { provider: "mock" }, reply: { send: false } },
        },
      }),
    );
    const fleet = loadFleetConfig(path);
    expect(Object.keys(fleet.bindings).sort()).toEqual(["allen-analyst", "hermes-responder"]);
    expect(fleet.capabilities).toEqual({ vision: false, contextTokens: 32000, tools: false });
  });

  it("fleetFromSingle wraps an AgentConfig as a one-binding fleet with NO capability vector", () => {
    const fleet = fleetFromSingle({
      binding: "hermes-responder",
      persona: "You are Hermes.",
      model: { provider: "mock" },
      reply: { send: false },
    });
    expect(Object.keys(fleet.bindings)).toEqual(["hermes-responder"]);
    expect(fleet.bindings["hermes-responder"]!.reply).toEqual({ send: false });
    // No vector → fitsRequirements never narrows → --config claims as today.
    expect(fleet.capabilities).toBeUndefined();
    expect(fitsRequirements(fleet.capabilities, { vision: true })).toBe(true);
  });
});
