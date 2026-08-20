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
// aerc, ios-mail, BoogieMail) will act on every one of them. This file pins
// the rule that we advertise exactly what we serve — in BOTH directions:
//
//   - eventSourceUrl IS advertised, as the RFC 8620 §2 URI template with
//     §7.3's three variables, because /api/eventsource is a real route now
//     (eventsource.ts). Both failure modes are live memory: when the URL
//     404'd, push clients hammered a dead endpoint (#230 removed it); once
//     removed, a strict decoder (BoogieMail) refused the Session outright —
//     §2 lists the property as required — and hung at the front door.
//   - no urn:ietf:params:jmap:websocket: /api/ws is real but push-only and
//     does not speak RFC 8887 (no `jmap` subprotocol selection, no Request
//     frames), so a client trusting the advertisement aborts with 1006 and
//     retries in a loop. Our own push consumers dial /api/ws directly. That
//     removal was legal (an extension capability) and stays.

const principal: Principal = {
  username: "eric@login.example",
  scopes: ["read", "draft", "send"],
  accounts: [{ accountId: "a_eric", tenantId: "t_bm", name: "Eric" }],
};

describe("the session advertises only what the server serves", () => {
  const session = buildSession("https://mail.bullmoose.cc", principal);

  it("advertises the EventSource endpoint as the §7.3 URI template", () => {
    expect(session.eventSourceUrl).toBe(
      "https://mail.bullmoose.cc/api/eventsource?types={types}&closeafter={closeafter}&ping={ping}",
    );
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
