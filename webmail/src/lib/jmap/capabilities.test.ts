import { describe, expect, it } from "vitest";
import { consoleGate } from "../console/gate";
import { createDemoBackend } from "./demo";
import {
  AGENT_CAP,
  CALENDARS_CAP,
  CONTACTS_CAP,
  CORE_CAP,
  FILENODE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  DEFAULT_MAX_OBJECTS_IN_SET,
  capabilityForMethod,
  hasAgentCapability,
  hasCapability,
  maxObjectsInSet,
} from "./capabilities";
import type { Session } from "./types";

const session = (caps: string[]): Pick<Session, "capabilities"> => ({
  capabilities: Object.fromEntries(caps.map((c) => [c, {}])),
});

describe("capability gate", () => {
  it("detects a present capability by key, not truthiness", () => {
    expect(hasCapability(session([CORE_CAP, MAIL_CAP]), MAIL_CAP)).toBe(true);
    expect(hasCapability(session([CORE_CAP]), MAIL_CAP)).toBe(false);
  });

  it("hasAgentCapability is the seam every agent surface hides behind", () => {
    expect(hasAgentCapability(session([CORE_CAP, MAIL_CAP, AGENT_CAP]))).toBe(true);
    // The plain-client invariant: agent cap absent → gate closed, cleanly.
    expect(hasAgentCapability(session([CORE_CAP, MAIL_CAP]))).toBe(false);
  });

  it("uses the REAL server URN, not the arch shorthand", () => {
    // arch.md §5 writes "urn:bullmoose:agent"; the live server advertises this.
    expect(AGENT_CAP).toBe("urn:bullmoose:params:jmap:agent");
  });
});

describe("capabilityForMethod", () => {
  it.each([
    ["Core/echo", CORE_CAP],
    ["Mailbox/query", MAIL_CAP],
    ["Email/get", MAIL_CAP],
    ["Thread/get", MAIL_CAP],
    ["EmailSubmission/set", SUBMISSION_CAP],
    ["ContactCard/get", CONTACTS_CAP],
    ["AddressBook/get", CONTACTS_CAP],
    ["Calendar/get", CALENDARS_CAP],
    ["CalendarEvent/query", CALENDARS_CAP],
    ["FileNode/get", FILENODE_CAP],
    ["AgentInvocation/get", AGENT_CAP],
    // s03.D T1: the ActionProposal collection is gated by the same capability,
    // so a session without urn:bullmoose:agent never calls it (the plain-client
    // floor — a client computes a method's using[] from the live session).
    ["ActionProposal/get", AGENT_CAP],
    ["ActionProposal/set", AGENT_CAP],
    ["ActionProposal/changes", AGENT_CAP],
    // s26 T4 — BYOK's session door rides the same capability (it is agent
    // configuration), so a plain client never calls it either.
    ["ProviderCredential/get", AGENT_CAP],
    ["ProviderCredential/set", AGENT_CAP],
    // s20 T6 — Goals is a face over the agent's Job DAG, same gate.
    ["Goal/get", AGENT_CAP],
    ["Goal/set", AGENT_CAP],
  ])("maps %s → %s", (method, cap) => {
    expect(capabilityForMethod(method)).toBe(cap);
  });
});

// ── the plain-client floor, drivable ────────────────────────────────────────

describe("createDemoBackend can drop the agent capability", () => {
  it("advertises it by default", async () => {
    const { client } = createDemoBackend();
    expect(hasAgentCapability(await client.session())).toBe(true);
  });

  it("removes the KEY — not sets it falsy — when asked", async () => {
    // The gate is `hasOwnProperty`, so a falsy value would still read as
    // present. Removal is the only faithful simulation of a server that does
    // not advertise the capability, and this is what makes `?agentcap=0`
    // exercise the real floor in a browser.
    const { client } = createDemoBackend({ agentCapability: false });
    const session = await client.session();
    expect(hasAgentCapability(session)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(session.capabilities, AGENT_CAP)).toBe(false);
    // …including on the account, which is where a surface would look next.
    for (const account of Object.values(session.accounts)) {
      expect(Object.prototype.hasOwnProperty.call(account.accountCapabilities, AGENT_CAP)).toBe(false);
    }
    // Everything else is untouched: the mail client is unaffected.
    expect(hasCapability(session, MAIL_CAP)).toBe(true);
    expect(hasCapability(session, SUBMISSION_CAP)).toBe(true);
  });

  it("keeps the console gate closed against that session", () => {
    expect(consoleGate({ capabilities: {} }).visible).toBe(false);
  });
});

// ── s34: the bulk-write ceiling ────────────────────────────────────────────

describe("maxObjectsInSet", () => {
  const withCore = (core: unknown): Pick<Session, "capabilities"> => ({ capabilities: { [CORE_CAP]: core } });

  it("reads what the session actually advertises", () => {
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: 500 }))).toBe(500);
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: 64 }))).toBe(64);
  });

  it("falls back to the RFC floor when the core capability says nothing", () => {
    // `FakeJmapClient` serves `{}` for every capability, and a bulk delete has
    // to work against it — conservatively, but it has to work.
    expect(maxObjectsInSet(withCore({}))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet({ capabilities: {} })).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet(withCore(null))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
  });

  it("refuses a value that would break the caller rather than trusting the wire", () => {
    // Zero or negative is an infinite chunk loop in the browser; a fraction is
    // a chunk size nothing can honour.
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: 0 }))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: -1 }))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: "lots" }))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: Infinity }))).toBe(DEFAULT_MAX_OBJECTS_IN_SET);
    expect(maxObjectsInSet(withCore({ maxObjectsInSet: 10.9 }))).toBe(10);
  });

  it("honours a caller-supplied fallback", () => {
    expect(maxObjectsInSet({ capabilities: {} }, 25)).toBe(25);
  });
});
