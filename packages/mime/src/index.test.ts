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

// ---- attachments ----------------------------------------------------------

const raw = (d: DraftMessage): string => new TextDecoder().decode(buildMime(d));

/** Boundaries carry a UUID; nothing else about the output is nondeterministic. */
const normalizeBoundaries = (s: string): string => s.replaceAll(/=_bm_[0-9a-f]{32}/g, "BOUNDARY");

const crlf = (...lines: string[]): string => lines.join("\r\n");

const rich: DraftMessage = {
  from: [{ name: "Eric", email: "eric@bullmoose.cc" }],
  to: [{ email: "someone@example.com" }],
  cc: [{ email: "cc@example.com" }],
  subject: "hello",
  messageId: "abc123@bullmoose.cc",
  inReplyTo: "prev@example.com",
  date: new Date("2026-08-08T12:00:00Z"),
  extraHeaders: ["Auto-Submitted: auto-replied"],
};

const TOP_HEADERS = [
  "Date: Sat, 08 Aug 2026 12:00:00 +0000",
  "Message-ID: <abc123@bullmoose.cc>",
  "From: Eric <eric@bullmoose.cc>",
  "To: someone@example.com",
  "Cc: cc@example.com",
  "In-Reply-To: <prev@example.com>",
  "References: <prev@example.com>",
  "Subject: hello",
  "Auto-Submitted: auto-replied",
  "MIME-Version: 1.0",
];

const bytes = (s: string) => new TextEncoder().encode(s);

describe("a draft with no attachments is byte-identical to before attachments existed", () => {
  // THE REGRESSION NET. Attachments arrived by restructuring the builder into
  // the nested-node shape `packages/cli/src/mime.ts` already used, so the
  // no-attachment paths had to come out the other side unchanged — every
  // message the agent worker, the vacation responder and the AccountDO send
  // goes through them. These are the literal bytes the builder emitted before
  // that restructuring, captured from the pre-change implementation.

  it("text/plain only", () => {
    expect(raw({ ...rich, text: "body text" })).toBe(
      crlf(
        ...TOP_HEADERS,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "Ym9keSB0ZXh0",
      ),
    );
  });

  it("text/html only", () => {
    expect(raw({ ...rich, html: "<p>hi</p>" })).toBe(
      crlf(
        ...TOP_HEADERS,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "PHA+aGk8L3A+",
      ),
    );
  });

  it("both bodies, as multipart/alternative", () => {
    expect(normalizeBoundaries(raw({ ...rich, text: "body text", html: "<p>hi</p>" }))).toBe(
      crlf(
        ...TOP_HEADERS,
        'Content-Type: multipart/alternative; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "Ym9keSB0ZXh0",
        "--BOUNDARY",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "PHA+aGk8L3A+",
        "--BOUNDARY--",
        "",
      ),
    );
  });

  it("no body at all — still an empty text/plain, not a zero-part multipart", () => {
    expect(raw(rich)).toBe(
      crlf(
        ...TOP_HEADERS,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "",
      ),
    );
  });

  it("an empty attachments array changes nothing either", () => {
    expect(raw({ ...rich, text: "body text", attachments: [] })).toBe(
      raw({ ...rich, text: "body text" }),
    );
  });
});

describe("attachment structure", () => {
  it("wraps the body in multipart/mixed for one ordinary attachment", () => {
    const out = normalizeBoundaries(
      raw({
        ...rich,
        text: "see attached",
        attachments: [{ type: "application/pdf", name: "report.pdf", content: bytes("PDF!") }],
      }),
    );
    expect(out).toBe(
      crlf(
        ...TOP_HEADERS,
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        "c2VlIGF0dGFjaGVk",
        "--BOUNDARY",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="report.pdf"',
        "",
        "UERGIQ==",
        "--BOUNDARY--",
        "",
      ),
    );
  });

  it("puts several attachments in ONE mixed container, all of them present", () => {
    const out = raw({
      ...rich,
      text: "three files",
      attachments: [
        { type: "text/csv", name: "a.csv", content: bytes("1,2") },
        { type: "text/csv", name: "b.csv", content: bytes("3,4") },
        { type: "text/csv", name: "c.csv", content: bytes("5,6") },
      ],
    });
    // One boundary for the whole message: no accidental nesting per part.
    expect(new Set(out.match(/=_bm_[0-9a-f]{32}/g))).toHaveLength(1);
    expect(out.match(/^Content-Type: multipart\//gm)).toHaveLength(1);
    for (const n of ["a.csv", "b.csv", "c.csv"]) {
      expect(out).toContain(`Content-Disposition: attachment; filename="${n}"`);
    }
    expect(out).toContain(btoa("1,2"));
    expect(out).toContain(btoa("3,4"));
    expect(out).toContain(btoa("5,6"));
  });

  it("puts a cid part in multipart/related — NOT mixed — with a Content-ID", () => {
    const out = normalizeBoundaries(
      raw({
        ...rich,
        html: '<img src="cid:logo@bm">',
        attachments: [
          { type: "image/png", name: "logo.png", content: bytes("PNG"), cid: "logo@bm" },
        ],
      }),
    );
    expect(out).toContain('Content-Type: multipart/related; boundary="BOUNDARY"');
    expect(out).not.toContain("multipart/mixed");
    expect(out).toContain("Content-ID: <logo@bm>");
    expect(out).toContain('Content-Disposition: inline; filename="logo.png"');
  });

  it("nests related inside mixed when a draft has both kinds", () => {
    const out = normalizeBoundaries(
      raw({
        ...rich,
        html: '<img src="cid:logo@bm">',
        attachments: [
          { type: "image/png", name: "logo.png", content: bytes("PNG"), cid: "logo@bm" },
          { type: "application/pdf", name: "report.pdf", content: bytes("PDF!") },
        ],
      }),
    );
    // mixed is the OUTER container — the top-level Content-Type — with related
    // as its first part. Inverted, a client that renders only the first part
    // shows the logo and loses the message.
    const topType = out.split("\r\n").find((l) => l.startsWith("Content-Type:"));
    expect(topType).toBe('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    const mixedAt = out.indexOf("multipart/mixed");
    const relatedAt = out.indexOf("multipart/related");
    expect(mixedAt).toBeGreaterThan(-1);
    expect(relatedAt).toBeGreaterThan(mixedAt);
    expect(out).toContain("Content-ID: <logo@bm>");
    expect(out).toContain('Content-Disposition: attachment; filename="report.pdf"');
  });

  it("defaults disposition by cid presence, and honours an explicit one", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [
        { type: "image/png", name: "a.png", content: bytes("A"), cid: "a@bm" },
        { type: "image/png", name: "b.png", content: bytes("B") },
        {
          type: "image/png",
          name: "c.png",
          content: bytes("C"),
          cid: "c@bm",
          disposition: "attachment",
        },
      ],
    });
    expect(out).toContain('Content-Disposition: inline; filename="a.png"');
    expect(out).toContain('Content-Disposition: attachment; filename="b.png"');
    expect(out).toContain('Content-Disposition: attachment; filename="c.png"');
  });

  it("omits the filename parameter entirely rather than emitting an empty one", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [{ type: "application/octet-stream", content: bytes("Z"), name: null }],
    });
    expect(out).toContain("Content-Disposition: attachment\r\n");
    expect(out).not.toContain("filename=");
  });

  it("RFC 2231-encodes a non-ASCII filename instead of emitting raw UTF-8", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [{ type: "application/pdf", name: "rapport-café.pdf", content: bytes("P") }],
    });
    expect(out).toContain("filename*=utf-8''rapport-caf%C3%A9.pdf");
    expect(out).not.toContain('filename="rapport-café.pdf"');
  });

  it("wraps attachment base64 at 76 columns, as RFC 2045 §6.8 requires", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [
        { type: "application/octet-stream", name: "big.bin", content: new Uint8Array(600) },
      ],
    });
    // The 76-column rule is about the ENCODED BODY, not headers (a
    // Content-Type carrying a boundary is legitimately longer), so measure
    // only the base64 payload lines.
    const payload = out.split("\r\n").filter((l) => /^[A-Za-z0-9+/]+={0,2}$/.test(l));
    expect(payload.length).toBeGreaterThan(1); // 600 bytes really did wrap
    expect(payload.filter((l) => l.length > 76)).toEqual([]);
  });
});

describe("attachment part headers are the same injection surface as the top block", () => {
  // `type`, `name` and `cid` all arrive as client JSON on Email/set create, so
  // each is as attacker-controlled as the Subject that common/002 was about.

  it("does not let a CRLF in an attachment's type forge a part header", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [
        { type: "text/plain\r\nContent-Disposition: inline", name: "a.txt", content: bytes("A") },
      ],
    });
    // The forged disposition would make the part render in place; the only
    // Content-Disposition in the message must be the one we chose.
    expect(out.match(/^Content-Disposition:/gm)).toHaveLength(1);
    expect(out).toContain('Content-Disposition: attachment; filename="a.txt"');
  });

  it("does not let a CRLF in a filename escape the quoted-string parameter", () => {
    const out = raw({
      ...rich,
      text: "x",
      attachments: [
        { type: "text/plain", name: 'a.txt"\r\nContent-ID: <forged@x>', content: bytes("A") },
      ],
    });
    // The payload survives as inert text INSIDE the quoted string; what must
    // not exist is a Content-ID header line, i.e. one at the start of a line.
    expect(out.match(/^Content-ID:/gm)).toBeNull();
    expect(out.match(/^Content-Disposition:/gm)).toHaveLength(1);
  });

  it("does not let a cid break out of its angle brackets", () => {
    const out = raw({
      ...rich,
      html: "x",
      attachments: [
        { type: "image/png", name: "a.png", content: bytes("A"), cid: "a@bm>\r\nBcc: evil@x" },
      ],
    });
    expect(out.split("\r\n").filter((l) => /^Bcc:/i.test(l))).toEqual([]);
    expect(out).toContain("Content-ID: <a@bmBcc:evil@x>");
  });
});
