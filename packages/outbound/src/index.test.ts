import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRelay, SesRelay } from "./index";

// SES substitutes its own Message-ID for whatever the raw message carries
// ("If you provide a Message-ID header, Amazon SES overrides the header with
// its own value" — SES Developer Guide, header fields). The relay therefore
// reports the id that actually went on the wire, derived from the response:
// `{MessageId}@{region}.amazonses.com`. That derivation is the load-bearing
// line — every stored message_id reconcile downstream trusts it — and the
// format is pinned here against the 2026-08-19 Gmail-received specimen
// (`<010101…-000000@us-west-2.amazonses.com>`, region us-west-2).
//
// No egress: global fetch is stubbed; aws4fetch signs locally either way.

const SES_MESSAGE_ID = "010101a01ba9762b-e5f1e023-e0f0-41d5-a521-0eecaf2a634b-000000";

afterEach(() => vi.unstubAllGlobals());

describe("SesRelay", () => {
  it("reports the wire Message-ID it knows SES stamped, derived from region + response MessageId", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ MessageId: SES_MESSAGE_ID }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const relay = new SesRelay({ accessKeyId: "AKIATEST", secretAccessKey: "secret", region: "us-west-2" });
    const result = await relay.send(new TextEncoder().encode("From: a@b\r\n\r\nhi"), {
      mailFrom: "a@b",
      rcptTo: ["c@d"],
    });

    expect(seen[0]).toBe("https://email.us-west-2.amazonaws.com/v2/email/outbound-emails");
    expect(result.relayMessageId).toBe(SES_MESSAGE_ID);
    expect(result.messageId).toBe(`${SES_MESSAGE_ID}@us-west-2.amazonses.com`);
  });
});

describe("MockRelay", () => {
  it("reports NO wire Message-ID — nothing rewrote the header, so stored is already wire", async () => {
    const result = await new MockRelay().send(new Uint8Array(), { mailFrom: "a@b", rcptTo: ["c@d"] });
    expect(result.messageId).toBeUndefined();
  });
});
