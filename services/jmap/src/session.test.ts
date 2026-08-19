import { describe, expect, it } from "vitest";
import {
  AGENT_CAP,
  CALENDARS_CAP,
  CONTACTS_CAP,
  CORE_CAP,
  FILENODE_CAP,
  MAIL_CAP,
  SUBMISSION_CAP,
  VACATION_CAP,
  WEBSOCKET_CAP,
} from "@bullmoose/jmap-core";
import { buildSession } from "./session";
import type { Principal } from "./auth";

// The session document is a set of PROMISES, and a real client (Mailtemi,
// aerc, ios-mail) will act on every one of them. This file pins the rule that
// we only advertise what we actually serve:
//
//   - no eventSourceUrl: there is no /api/eventsource route, and a URL that
//     404s makes push-capable clients hammer a dead endpoint forever instead
//     of falling back to polling (RFC 8620 §7.3).
//   - no urn:ietf:params:jmap:websocket: /api/ws is real but push-only and
//     does not speak RFC 8887 (no `jmap` subprotocol selection, no Request
//     frames), so a client trusting the advertisement aborts with 1006 and
//     retries in a loop. Our own push consumers dial /api/ws directly.

const principal: Principal = {
  username: "eric@login.example",
  scopes: ["read", "draft", "send"],
  accounts: [{ accountId: "a_eric", tenantId: "t_bm", name: "Eric" }],
};

describe("the session advertises only what the server serves", () => {
  const session = buildSession("https://mail.bullmoose.cc", principal);

  it("does not advertise an EventSource endpoint", () => {
    expect("eventSourceUrl" in session).toBe(false);
  });

  it("does not advertise the RFC 8887 websocket capability", () => {
    expect(Object.keys(session.capabilities)).not.toContain(WEBSOCKET_CAP);
    for (const account of Object.values(session.accounts)) {
      expect(Object.keys(account.accountCapabilities)).not.toContain(WEBSOCKET_CAP);
    }
  });

  it("still advertises the full real surface", () => {
    const caps = Object.keys(session.capabilities);
    for (const cap of [
      CORE_CAP,
      MAIL_CAP,
      SUBMISSION_CAP,
      VACATION_CAP,
      CONTACTS_CAP,
      CALENDARS_CAP,
      FILENODE_CAP,
      AGENT_CAP,
    ]) {
      expect(caps).toContain(cap);
    }
    expect(session.apiUrl).toBe("https://mail.bullmoose.cc/api/jmap");
    expect(session.downloadUrl).toContain("/api/download/");
    expect(session.uploadUrl).toContain("/api/upload/");
    expect(session.primaryAccounts[MAIL_CAP]).toBe("a_eric");
  });
});
