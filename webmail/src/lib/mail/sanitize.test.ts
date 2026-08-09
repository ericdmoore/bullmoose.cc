import { describe, expect, it } from "vitest";
import { SANITIZER_IS_STUB, sanitizeHtml } from "./sanitize";

// The stub is fail-closed by design (arch.md §4 — sanitization is a security
// surface, wired in T2). These tests pin that it neutralizes the obvious XSS
// vector NOW, and flag that it is not the finished sanitizer.
describe("sanitizeHtml (T1 fail-closed stub)", () => {
  it("strips <script> so nothing executes", () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
  });

  it("drops all tags rather than allow-listing (so it can't pass for finished)", () => {
    const out = sanitizeHtml('<a href="https://evil.test" onclick="steal()">click</a>');
    expect(out).toBe("click");
  });

  it("is flagged as a stub for T2 to replace", () => {
    expect(SANITIZER_IS_STUB).toBe(true);
  });
});
