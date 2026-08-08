import { describe, expect, it } from "vitest";
import { buildMime, encodeHeaderValue, formatAddress, type DraftMessage } from "./index";

// Regression suite for .feedback/fromClaude/common/002 — MIME header injection.
//
// The defect: `isAscii` was used as the safety gate, but CR (0x0D), LF (0x0A)
// and NUL are all inside [\x00-\x7F], so any header value carrying a decoded
// CRLF was emitted verbatim. Inbound Subjects reach the builder through the
// vacation responder (account-do:181), the agent auto-reply (agent:252) and the
// agent forward (ledger:580) — all reachable by a stranger sending mail.
//
// Everything below asserts on the HEADER BLOCK only. Splitting on the
// header/body boundary first matters: a body that happens to contain "Bcc:"
// would otherwise produce a false negative.

const base: DraftMessage = {
  from: [{ email: "eric@bullmoose.cc" }],
  to: [{ email: "someone@example.com" }],
  subject: "hello",
  messageId: "abc123@bullmoose.cc",
  date: new Date("2026-08-08T12:00:00Z"),
  text: "body",
};

const headerBlock = (d: DraftMessage): string[] =>
  new TextDecoder().decode(buildMime(d)).split("\r\n\r\n")[0]!.split("\r\n");

const fieldsNamed = (lines: string[], name: string): string[] =>
  lines.filter((l) => new RegExp(`^${name}:`, "i").test(l));

describe("header injection", () => {
  it("does not let a CRLF in the subject forge a Bcc header", () => {
    const lines = headerBlock({ ...base, subject: "hi\r\nBcc: evil@example.com" });
    expect(fieldsNamed(lines, "Bcc")).toHaveLength(0);
    expect(fieldsNamed(lines, "Subject")).toHaveLength(1);
  });

  it("does not let a doubled CRLF end the header block early and forge a body", () => {
    const lines = headerBlock({ ...base, subject: "hi\r\n\r\nFORGED BODY" });
    // If the injection worked, MIME-Version would fall below the boundary and
    // vanish from the header block entirely.
    expect(fieldsNamed(lines, "MIME-Version")).toHaveLength(1);
  });

  it("emits no bare LF, which some MTAs still treat as a line terminator", () => {
    // Asserting on `fieldsNamed` here would be a FALSE PASS: headerBlock splits
    // on CRLF, so a bare LF never becomes its own line and the payload hides
    // inside the Subject value. Assert on the raw bytes instead — the risk is
    // that a downstream MTA disagrees with us about what ends a line
    // (the SMTP-smuggling class of bug).
    const raw = new TextDecoder().decode(
      buildMime({ ...base, subject: "hi\nBcc: evil@example.com" }),
    );
    // Strip the LEGITIMATE CRLF field separators first; whatever CR or LF
    // survives that is by definition a bare one we emitted.
    const residue = raw.split("\r\n\r\n")[0]!.replaceAll("\r\n", "");
    expect(residue).not.toContain("\n");
    expect(residue).not.toContain("\r");
  });

  it("sanitizes an attacker-controlled display name", () => {
    const lines = headerBlock({
      ...base,
      to: [{ name: "Bob\r\nBcc: evil@example.com", email: "bob@example.com" }],
    });
    expect(fieldsNamed(lines, "Bcc")).toHaveLength(0);
  });

  it("sanitizes the address itself, which had no escaping at all", () => {
    const lines = headerBlock({
      ...base,
      to: [{ email: "bob@example.com>\r\nBcc: evil@example.com" }],
    });
    expect(fieldsNamed(lines, "Bcc")).toHaveLength(0);
  });

  it("sanitizes inReplyTo, which is copied from inbound mail on reply", () => {
    const lines = headerBlock({ ...base, inReplyTo: "x@y>\r\nBcc: evil@example.com" });
    expect(fieldsNamed(lines, "Bcc")).toHaveLength(0);
    expect(fieldsNamed(lines, "In-Reply-To")).toHaveLength(1);
    expect(fieldsNamed(lines, "References")).toHaveLength(1);
  });

  it("sanitizes extraHeaders, which callers pass as whole header lines", () => {
    const lines = headerBlock({
      ...base,
      extraHeaders: ["Auto-Submitted: auto-replied\r\nBcc: evil@example.com"],
    });
    expect(fieldsNamed(lines, "Bcc")).toHaveLength(0);
  });

  it("survives the RFC 2047 round trip a real inbound subject takes", () => {
    // postal-mime decodes =?utf-8?B?...?= before the value reaches us, so the
    // attacker's payload arrives as a plain string with a real CRLF in it.
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob("aGkNCkJjYzogZXZpbEBleGFtcGxlLmNvbQ=="), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toContain("\r\n"); // the payload really does carry a CRLF
    expect(fieldsNamed(headerBlock({ ...base, subject: decoded }), "Bcc")).toHaveLength(0);
  });
});

describe("no regression for legitimate values", () => {
  it("leaves a plain ASCII subject untouched", () => {
    expect(encodeHeaderValue("Lunch on Thursday?")).toBe("Lunch on Thursday?");
  });

  it("still RFC 2047 encodes non-ASCII", () => {
    expect(encodeHeaderValue("café")).toMatch(/^=\?utf-8\?B\?/);
  });

  it("still quotes a display name needing it, and leaves a simple one bare", () => {
    expect(formatAddress({ name: "Bob Smith", email: "b@e.com" })).toBe("Bob Smith <b@e.com>");
    expect(formatAddress({ name: "Smith, Bob", email: "b@e.com" })).toBe(
      '"Smith, Bob" <b@e.com>',
    );
    expect(formatAddress({ email: "b@e.com" })).toBe("b@e.com");
  });

  it("folds an embedded newline to a space rather than deleting it", () => {
    // RFC 5322 unfolding replaces CRLF+WSP with WSP, so a space is the
    // semantically closest survivor — "a b", not "ab".
    expect(encodeHeaderValue("a\r\nb")).toBe("a b");
  });
});
