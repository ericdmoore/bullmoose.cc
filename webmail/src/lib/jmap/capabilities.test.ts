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
  capabilityForMethod,
  hasAgentCapability,
  hasCapability,
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
      expect(
        Object.prototype.hasOwnProperty.call(account.accountCapabilities, AGENT_CAP),
      ).toBe(false);
    }
    // Everything else is untouched: the mail client is unaffected.
    expect(hasCapability(session, MAIL_CAP)).toBe(true);
    expect(hasCapability(session, SUBMISSION_CAP)).toBe(true);
  });

  it("keeps the console gate closed against that session", () => {
    expect(consoleGate({ capabilities: {} }).visible).toBe(false);
  });
});
