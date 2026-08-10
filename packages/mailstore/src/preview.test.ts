import { describe, expect, it } from "vitest";
import { previewText } from "./index";

/**
 * `preview` for HTML-only mail.
 *
 * All three write paths cut it as `(parsed.text ?? "").slice(0, 256)`, which is
 * empty string when a message has no text/plain part — most newsletters, most
 * transactional mail. The thread list rendered a blank line for them. The FTS
 * work (common/004) had already solved the same problem for `bodyText` with a
 * text-then-html fallback; `previewText` is that fallback, shared.
 */
describe("previewText", () => {
  it("prefers text/plain when it has content", () => {
    expect(previewText("the plain part", "<p>the html part</p>")).toBe("the plain part");
  });

  it("falls back to HTML when there is no text part — the bug", () => {
    // Before: "" for every message shaped like this.
    expect(previewText(undefined, "<p>Your receipt for <b>$12.00</b></p>")).toBe(
      "Your receipt for $12.00",
    );
    expect(previewText(null, "<div>hello</div>")).toBe("hello");
  });

  it("treats a whitespace-only text part as absent", () => {
    // A multipart/alternative with an empty text/plain stub is common, and
    // `?? ""` would not catch it — only null/undefined trigger that operator.
    expect(previewText("   \n\t  ", "<p>real content</p>")).toBe("real content");
  });

  it("drops script and style content rather than previewing it", () => {
    const html = "<style>.a{color:red}</style><script>alert(1)</script><p>Hi</p>";
    expect(previewText(null, html)).toBe("Hi");
  });

  it("collapses whitespace on BOTH paths, not just the HTML one", () => {
    // Deliberate change to the plaintext path: a preview renders as one line,
    // and letting the two paths differ in shape is worse than either.
    expect(previewText("line one\n\nline   two", null)).toBe("line one line two");
    expect(previewText(null, "<p>line one</p>\n\n<p>line   two</p>")).toBe("line one line two");
  });

  it("cuts at 256 characters AFTER collapsing", () => {
    // The point of collapsing first: 256 visible characters, not 256 newlines.
    const padded = `${"\n".repeat(300)}${"x".repeat(300)}`;
    expect(previewText(padded, null)).toBe("x".repeat(256));
    expect(previewText("y".repeat(300), null)).toHaveLength(256);
  });

  it("is empty only when the message genuinely has no body", () => {
    expect(previewText(null, null)).toBe("");
    expect(previewText(undefined, undefined)).toBe("");
    expect(previewText("", "")).toBe("");
    expect(previewText(null, "<p></p>")).toBe("");
  });

  it("decodes entities in the UNSAFE direction, and that is the contract", () => {
    // RFC 8621 defines `preview` as plaintext, so decoding is correct and the
    // obligation to escape sits with the renderer. Pinned as a test because it
    // is the surprising half: a preview CAN contain angle brackets, and any
    // consumer that interpolates it into HTML unescaped has an XSS bug.
    //
    // Our own client is safe by construction -- MessageView.tsx renders
    // `{email.preview}` and Preact escapes. A third-party JMAP client is
    // responsible for its own escaping.
    expect(previewText(null, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
      "<script>alert(1)</script>",
    );
    expect(previewText(null, "<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
    expect(previewText(null, "<p>a&nbsp;b</p>")).toBe("a b");
  });

  it("does not let an HTML comment leak into the preview", () => {
    expect(previewText(null, "<!-- tracking id 91af --><p>Sale ends today</p>")).toBe(
      "Sale ends today",
    );
  });
});
