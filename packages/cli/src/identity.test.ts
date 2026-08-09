import { describe, expect, it } from "vitest";
import {
  SIG_SEP,
  appendHtmlSignature,
  appendTextSignature,
  renderIdentity,
  resolveIdentity,
  type JmapIdentity,
} from "./identity.js";

// The pure half of `bullmoose identity` (sVOL 006), tested the way
// mailbox.test.ts tests the pure half of `bullmoose mailbox`: the JMAP
// round-trip belongs to services/jmap/src/methods/identity.test.ts and to the
// smoke contract, and what is worth pinning here is the signature composition
// — the thing a recipient actually reads, and the reason this unit is
// human-verifiable at all.

const identity = (over: Partial<JmapIdentity> = {}): JmapIdentity => ({
  id: "id_1",
  email: "eric@bullmoose.cc",
  name: "Eric",
  replyTo: null,
  bcc: null,
  textSignature: "",
  htmlSignature: "",
  mayDelete: false,
  ...over,
});

describe("appendTextSignature", () => {
  it("leaves the body byte-for-byte alone when there is no signature", () => {
    expect(appendTextSignature("hello\n\n", "")).toBe("hello\n\n");
  });

  it("uses the RFC 3676 separator so clients can strip it from replies", () => {
    expect(SIG_SEP).toBe("\n-- \n");
    expect(appendTextSignature("hello", "Eric")).toBe("hello\n-- \nEric\n");
  });

  it("does not stack blank lines when the body already ends in newlines", () => {
    expect(appendTextSignature("hello\n\n\n", "Eric\n")).toBe("hello\n-- \nEric\n");
  });

  it("keeps a multi-line signature intact", () => {
    expect(appendTextSignature("hi", "Eric\nbullmoose.cc")).toBe("hi\n-- \nEric\nbullmoose.cc\n");
  });
});

describe("appendHtmlSignature", () => {
  it("leaves the html alone when neither signature is set", () => {
    expect(appendHtmlSignature("<p>hi</p>", "", "")).toBe("<p>hi</p>");
  });

  it("inserts htmlSignature as a snippet, not as escaped text", () => {
    const out = appendHtmlSignature("<p>hi</p>", '<a href="https://bullmoose.cc">Eric</a>');
    expect(out).toContain('<a href="https://bullmoose.cc">Eric</a>');
    expect(out).toContain("<div>-- </div>");
  });

  it("falls back to the plaintext signature so both alternatives carry one", () => {
    // Otherwise a text-only signature appears in one half of a
    // multipart/alternative and not the other, and which half the recipient
    // sees is their client's choice.
    const out = appendHtmlSignature("<p>hi</p>", "", "Eric & Co\n");
    expect(out).toContain("<pre>Eric &amp; Co</pre>");
  });

  it("escapes the plaintext fallback rather than injecting markup", () => {
    expect(appendHtmlSignature("<p>hi</p>", "", "<script>x</script>")).toContain(
      "<pre>&lt;script&gt;x&lt;/script&gt;</pre>",
    );
  });
});

describe("resolveIdentity", () => {
  const list = [
    identity({ id: "id_1", email: "eric@bullmoose.cc" }),
    identity({ id: "id_2", email: "Sales@bullmoose.cc", mayDelete: true }),
  ];

  it("matches on id first", () => {
    expect(resolveIdentity(list, "id_2").email).toBe("Sales@bullmoose.cc");
  });

  it("matches on the exact address before falling back to case-insensitive", () => {
    expect(resolveIdentity(list, "Sales@bullmoose.cc").id).toBe("id_2");
    expect(resolveIdentity(list, "sales@bullmoose.cc").id).toBe("id_2");
  });

  it("exits 3 rather than guessing when nothing matches", () => {
    // notFound() is the io.ts exit-3 path; it throws a CliError.
    expect(() => resolveIdentity(list, "nobody@example.com")).toThrow(/not found/);
  });
});

describe("renderIdentity", () => {
  it("marks the primary, so `identity rm` has a visible reason to refuse", () => {
    expect(renderIdentity(identity())).toContain("primary");
    expect(renderIdentity(identity({ mayDelete: true }))).not.toContain("primary");
  });

  it("says a signature is set without printing it inline", () => {
    const line = renderIdentity(identity({ textSignature: "Eric\nbullmoose.cc", mayDelete: true }));
    expect(line).toContain("sig");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("keeps columns tab-separated so awk works (arch.md §1.6)", () => {
    expect(renderIdentity(identity()).split("\t")[0]).toBe("id_1");
  });
});
