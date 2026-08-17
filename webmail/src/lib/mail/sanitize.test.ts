import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  escapeText,
  safeStyle,
  safeUrl,
  sanitizeEmailHtml,
  sanitizeHtml,
  textToSafeHtml,
} from "./sanitize";

// Sanitization is a SECURITY surface (arch.md §4, invariant §6.3), so this
// suite is adversarial first and fidelity second. The T1 stub stripped every
// tag; these tests pin that the T2 allowlist sanitizer still neutralizes every
// payload the stub did, while now rendering real mail.

/** No output of this sanitizer may ever contain executable surface. */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript\s*:/i);
  expect(html).not.toMatch(/vbscript\s*:/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<object/i);
  expect(html).not.toMatch(/<embed/i);
}

describe("sanitizeEmailHtml — script execution", () => {
  it("drops <script> with its content", () => {
    const r = sanitizeEmailHtml("<p>hi</p><script>alert(document.cookie)</script>");
    expect(r.html).toBe("<p>hi</p>");
    expect(r.html).not.toContain("alert");
    expect(r.droppedTags).toContain("script");
    expectInert(r.html);
  });

  it("is not fooled by a sloppy </script > close tag smuggling markup after it", () => {
    // A stripper that looks for a literal "</script>" leaves the payload behind.
    const r = sanitizeEmailHtml('<script>x</script foo><img src=x onerror="alert(1)">');
    expect(r.html).not.toContain("alert");
    expect(r.html).not.toContain("onerror");
    expectInert(r.html);
  });

  it("drops <style>, whose content is CSS, not markup", () => {
    const r = sanitizeEmailHtml("<style>body{background:url(https://t.test/p)}</style><p>hi</p>");
    expect(r.html).toBe("<p>hi</p>");
    expect(r.droppedTags).toContain("style");
  });

  it("drops svg and math wholesale — foreign content is where mXSS lives", () => {
    const r = sanitizeEmailHtml("<svg><script>alert(1)</script></svg><math><mi>x</mi></math><p>after</p>");
    expect(r.html).toBe("<p>after</p>");
    expectInert(r.html);
  });

  it("drops <iframe>, <object> and <embed>", () => {
    const r = sanitizeEmailHtml(
      '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="y"><p>ok</p>',
    );
    expect(r.html).toBe("<p>ok</p>");
    expectInert(r.html);
  });

  it("drops <noscript>, which many strippers treat as inert", () => {
    const r = sanitizeEmailHtml("<noscript><img src=x onerror=alert(1)></noscript><p>ok</p>");
    expect(r.html).toBe("<p>ok</p>");
    expectInert(r.html);
  });

  it("drops HTML comments so a conditional comment cannot hide markup", () => {
    const r = sanitizeEmailHtml("<!--[if mso]><script>alert(1)</script><![endif]--><p>ok</p>");
    expect(r.html).toBe("<p>ok</p>");
    expectInert(r.html);
  });
});

describe("sanitizeEmailHtml — event handlers", () => {
  it("strips onerror from an otherwise allowed <img>", () => {
    const r = sanitizeEmailHtml('<img src="cid:none" onerror="alert(1)" alt="x">');
    expect(r.html).not.toContain("onerror");
    expect(r.html).toContain("alt=");
    expectInert(r.html);
  });

  it("strips every on* handler, including ones no denylist would enumerate", () => {
    const r = sanitizeEmailHtml(
      '<div onclick="a()" onmouseover="b()" onfocusin="c()" onanimationstart="d()">text</div>',
    );
    expect(r.html).toBe("<div>text</div>");
    expectInert(r.html);
  });

  it("strips handlers whose name is upper-cased or oddly spaced", () => {
    const r = sanitizeEmailHtml('<div OnClick = "alert(1)">text</div>');
    expect(r.html).toBe("<div>text</div>");
    expectInert(r.html);
  });

  it("strips handlers on an unquoted attribute value", () => {
    const r = sanitizeEmailHtml("<img src=x onerror=alert(1)>");
    expect(r.html).not.toContain("onerror");
    expectInert(r.html);
  });
});

describe("sanitizeEmailHtml — javascript: URLs", () => {
  it("drops a plain javascript: href but keeps the link text", () => {
    const r = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(r.html).toBe("<a>click</a>");
    expectInert(r.html);
  });

  it("drops a javascript: URL hidden behind an HTML entity", () => {
    const r = sanitizeEmailHtml('<a href="&#106;avascript:alert(1)">click</a>');
    expect(r.html).toBe("<a>click</a>");
    expectInert(r.html);
  });

  it("drops a javascript: URL hidden behind a hex entity", () => {
    const r = sanitizeEmailHtml('<a href="&#x6a;avascript:alert(1)">click</a>');
    expect(r.html).toBe("<a>click</a>");
    expectInert(r.html);
  });

  it("drops a javascript: URL broken up with control characters", () => {
    const r = sanitizeEmailHtml('<a href="java\tscript:alert(1)">click</a>');
    expect(r.html).toBe("<a>click</a>");
    expectInert(r.html);
  });

  it("drops a javascript: URL with leading whitespace", () => {
    const r = sanitizeEmailHtml('<a href="   javascript:alert(1)">click</a>');
    expect(r.html).toBe("<a>click</a>");
  });

  it("drops vbscript: and data:text/html", () => {
    expect(safeUrl("vbscript:msgbox(1)", { allowRemote: true, isResource: false })).toBeNull();
    expect(
      safeUrl("data:text/html;base64,PHNjcmlwdD4=", {
        allowRemote: true,
        isResource: true,
        allowDataImage: true,
      }),
    ).toBeNull();
  });

  it("keeps http(s), mailto and tel links and forces a safe rel", () => {
    const r = sanitizeEmailHtml('<a href="https://ok.test/x">go</a>');
    expect(r.html).toContain('href="https://ok.test/x"');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
    expect(r.html).toContain('target="_blank"');
    expect(sanitizeHtml('<a href="mailto:a@b.test">mail</a>')).toContain("mailto:a@b.test");
  });

  it("does NOT let a sender override rel to re-open window.opener", () => {
    const r = sanitizeEmailHtml('<a href="https://ok.test" rel="opener" target="_self">go</a>');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
    expect(r.html).not.toContain('rel="opener"');
    expect(r.html).not.toContain('target="_self"');
  });

  it("preserves an ampersand-escaped query string without double-escaping it", () => {
    const r = sanitizeEmailHtml('<a href="https://ok.test/?a=1&amp;b=2">go</a>');
    expect(r.html).toContain('href="https://ok.test/?a=1&amp;b=2"');
    expect(r.html).not.toContain("&amp;amp;");
  });

  it("drops relative URLs, which would resolve against the WEBMAIL origin", () => {
    expect(safeUrl("/settings/delete-account", { allowRemote: true, isResource: false })).toBeNull();
    expect(safeUrl("#section", { allowRemote: true, isResource: false })).toBe("#section");
  });
});

describe("sanitizeEmailHtml — remote content (tracking pixels)", () => {
  it("blocks a remote <img> by default and counts it", () => {
    const r = sanitizeEmailHtml('<img src="https://tracker.test/open.gif" width="1" height="1">');
    // No `src` means the browser never fetches it — the pixel never fires.
    expect(r.html).not.toMatch(/\ssrc=/);
    // The URL survives ONLY in an inert data- attribute, so "show images" can
    // put it back once the user has decided to trust the sender.
    expect(r.html).toContain('data-blocked-src="https://tracker.test/open.gif"');
    expect(r.blockedRemoteCount).toBe(1);
  });

  it("loads the same image once the user opts in", () => {
    const r = sanitizeEmailHtml('<img src="https://tracker.test/open.gif">', {
      allowRemoteContent: true,
    });
    expect(r.html).toContain('src="https://tracker.test/open.gif"');
    expect(r.blockedRemoteCount).toBe(0);
  });

  it("blocks a protocol-relative image, which has no scheme but is still remote", () => {
    const r = sanitizeEmailHtml('<img src="//tracker.test/open.gif">');
    expect(r.html).not.toMatch(/\ssrc=/);
    expect(r.blockedRemoteCount).toBe(1);
  });

  it("still keeps LINKS when remote content is blocked — blocking is about auto-fetch", () => {
    // Gating href on the remote-content switch would strip every link out of
    // every message by default: privacy theatre that breaks the client.
    const r = sanitizeEmailHtml('<a href="https://ok.test/x">go</a><img src="https://t.test/p.gif">');
    expect(r.html).toContain('href="https://ok.test/x"');
    expect(r.blockedRemoteCount).toBe(1);
  });

  it("blocks a url() tracking pixel smuggled through inline CSS", () => {
    const r = sanitizeEmailHtml('<div style="color: red; background-color: url(https://tracker.test/p.png)">hi</div>');
    expect(r.html).toContain("color: red");
    expect(r.html).not.toContain("tracker.test");
  });

  it("resolves cid: inline attachments through the injected resolver only", () => {
    const withResolver = sanitizeEmailHtml('<img src="cid:logo@x">', {
      resolveCid: (cid) => (cid === "logo@x" ? "blob:local/1" : null),
    });
    expect(withResolver.html).toContain('src="blob:local/1"');

    const without = sanitizeEmailHtml('<img src="cid:logo@x">');
    expect(without.html).not.toContain("cid:");
  });
});

describe("sanitizeEmailHtml — CSS policy", () => {
  it("keeps allowlisted declarations and drops the rest", () => {
    expect(safeStyle("color: #333; position: fixed; font-size: 12px")).toBe("color: #333; font-size: 12px");
  });

  it("drops expression(), -moz-binding and @import", () => {
    expect(safeStyle("width: expression(alert(1))")).toBe("");
    expect(safeStyle("border: -moz-binding: url(x)")).toBe("");
    expect(safeStyle("color: red; @import 'evil.css'")).toBe("color: red");
  });

  it("drops position so sender CSS cannot overlay the app's own chrome", () => {
    const r = sanitizeEmailHtml('<div style="position:fixed;top:0;left:0;width:100%;height:100%">x</div>');
    expect(r.html).not.toContain("position");
    expect(r.html).toContain("width: 100%");
  });
});

describe("sanitizeEmailHtml — structure and escaping", () => {
  it("escapes text so a bare < can never become a tag", () => {
    const r = sanitizeEmailHtml("<p>1 < 2 and 3 > 2</p>");
    expect(r.html).toBe("<p>1 &lt; 2 and 3 &gt; 2</p>");
  });

  it("escapes a bare ampersand without mangling an existing entity", () => {
    expect(escapeText("AT&T &amp; Co &lt;x&gt;")).toBe("AT&amp;T &amp; Co &lt;x&gt;");
  });

  it("balances tags the sender left open", () => {
    expect(sanitizeEmailHtml("<b>bold<i>both").html).toBe("<b>bold<i>both</i></b>");
  });

  it("ignores stray close tags rather than unbalancing the output", () => {
    expect(sanitizeEmailHtml("<p>x</p></div></body></html>").html).toBe("<p>x</p>");
  });

  it("unwraps unknown elements but keeps their text", () => {
    expect(sanitizeEmailHtml("<custom-thing>kept</custom-thing>").html).toBe("kept");
  });

  it("strips class and id — the DOM-clobbering and style-impersonation vector", () => {
    const r = sanitizeEmailHtml('<div class="app-header" id="attributes">x</div>');
    expect(r.html).toBe("<div>x</div>");
  });

  it("drops <base>, which would retarget every relative link in the page", () => {
    const r = sanitizeEmailHtml('<base href="https://evil.test/"><p>x</p>');
    expect(r.html).toBe("<p>x</p>");
    expect(r.droppedTags).toContain("base");
  });

  it("keeps ordinary formatted mail intact", () => {
    const r = sanitizeEmailHtml(
      '<div><h2>Hi</h2><p>See <a href="https://ok.test">this</a>.</p>' +
        "<ul><li>one</li><li>two</li></ul>" +
        '<table><tr><td colspan="2">cell</td></tr></table></div>',
    );
    expect(r.html).toContain("<h2>Hi</h2>");
    expect(r.html).toContain("<li>one</li>");
    expect(r.html).toContain('colspan="2"');
    expectInert(r.html);
  });
});

describe("sanitizeEmailHtml — quoted-reply collapsing", () => {
  it("splits a trailing <blockquote> off at the top level", () => {
    const r = sanitizeEmailHtml("<p>my reply</p><blockquote><p>your mail</p></blockquote>");
    expect(r.html).toBe("<p>my reply</p>");
    expect(r.quotedHtml).toBe("<blockquote><p>your mail</p></blockquote>");
  });

  it("splits on a gmail_quote container", () => {
    const r = sanitizeEmailHtml('<p>reply</p><div class="gmail_quote">On Tue, X wrote:</div>');
    expect(r.html).toBe("<p>reply</p>");
    expect(r.quotedHtml).toContain("On Tue, X wrote:");
  });

  it("leaves both halves independently well-formed", () => {
    const r = sanitizeEmailHtml("<div><p>reply</p></div><blockquote>old");
    expect(r.html).toBe("<div><p>reply</p></div>");
    expect(r.quotedHtml).toBe("<blockquote>old</blockquote>");
  });

  it("does not split a blockquote that is nested inside the live body", () => {
    const r = sanitizeEmailHtml("<div><blockquote>inline quote</blockquote></div>");
    expect(r.quotedHtml).toBe("");
    expect(r.html).toContain("inline quote");
  });

  it("can be told not to split at all", () => {
    const r = sanitizeEmailHtml("<p>a</p><blockquote>b</blockquote>", { splitQuote: false });
    expect(r.quotedHtml).toBe("");
    expect(r.html).toContain("<blockquote>b</blockquote>");
  });

  it("sanitizes the quoted half too", () => {
    const r = sanitizeEmailHtml("<p>a</p><blockquote><script>alert(1)</script>old</blockquote>");
    expect(r.quotedHtml).not.toContain("script");
    expectInert(r.quotedHtml);
  });
});

describe("textToSafeHtml", () => {
  it("escapes a plain-text body so markup in it stays text", () => {
    const html = textToSafeHtml("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expectInert(html);
  });

  it("linkifies bare URLs with a safe rel", () => {
    const html = textToSafeHtml("see https://ok.test/a for details");
    expect(html).toContain('<a href="https://ok.test/a"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe("decodeEntities", () => {
  it("decodes numeric, hex and named entities", () => {
    expect(decodeEntities("&#106;&#x61;&amp;")).toBe("ja&");
  });

  it("leaves an unknown entity alone rather than guessing", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});
