// HTML sanitization — a SECURITY SURFACE, not a rendering detail (arch.md §4,
// invariant §6.3). Untrusted sender HTML rendered in an authenticated origin is
// the classic webmail XSS vector.
//
// T1 shipped a fail-closed stub that stripped every tag. T2 replaces it with a
// real allowlist sanitizer. Three deliberate choices:
//
// 1. **No DOM, no dependency.** This is a hand-written scanner rather than
//    DOMPurify because the sanitizer must run where the tests run — plain Node,
//    `environment: "node"` in vitest.config.ts, no jsdom — and, per the T1
//    stub's own note, "in the Worker/edge, not just the browser". A sanitizer
//    that can only run after a DOM exists cannot be unit-tested here and cannot
//    be moved server-side later.
// 2. **Allowlist, never denylist.** Unknown tags are unwrapped (dropped, text
//    kept); a known-dangerous set is dropped with its subtree. A denylist is
//    one novel element away from failing open.
// 3. **Parse once, serialize once.** Output is built from parsed tokens and
//    re-escaped, so it is well-formed by construction: no unbalanced tags to
//    re-parse differently, which is where mXSS lives.
//
// Remote content is blocked BY DEFAULT (tracking pixels) — see `SanitizeOptions`.

// ── policy ────────────────────────────────────────────────────────────────

/** Elements that render. Everything not here is unwrapped or dropped. */
const ALLOWED = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
]);

/**
 * Dropped WITH their subtree. Scripting, plugin, foreign-content (svg/math is
 * where mXSS parser-confusion lives), document-metadata (a `<base>` retargets
 * every relative link) and form-control elements.
 */
const DROP_SUBTREE = new Set([
  "applet",
  "audio",
  "base",
  "body",
  "button",
  "canvas",
  "dialog",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "html",
  "iframe",
  "input",
  "keygen",
  "link",
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "option",
  "optgroup",
  "param",
  "plaintext",
  "portal",
  "script",
  "select",
  "slot",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
  "xmp",
]);

/**
 * Elements whose content the HTML parser does NOT treat as markup. They must be
 * skipped to their literal close tag, or `<script>foo</script ><img onerror>`
 * style smuggling works. All of them are in DROP_SUBTREE too.
 */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "listing",
  "noscript",
  "noembed",
  "noframes",
  "iframe",
]);

/** No end tag; never pushed onto the open-element stack. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Attributes allowed on any element. `class`, `id` and `name` are deliberately
 * ABSENT: they are the DOM-clobbering vector (a sender-controlled
 * `id="attributes"` shadows a real DOM property) and they let sender markup
 * borrow the app's own stylesheet to impersonate chrome.
 */
const GLOBAL_ATTRS = new Set(["title", "dir", "lang", "align", "valign", "style"]);

/** Per-element attributes, on top of GLOBAL_ATTRS. */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "border", "hspace", "vspace"]),
  table: new Set(["width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "summary"]),
  td: new Set(["colspan", "rowspan", "width", "height", "bgcolor", "nowrap"]),
  th: new Set(["colspan", "rowspan", "width", "height", "bgcolor", "nowrap", "scope"]),
  tr: new Set(["bgcolor", "height"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span", "width"]),
  ol: new Set(["start", "type", "reversed"]),
  ul: new Set(["type"]),
  li: new Set(["value"]),
  font: new Set(["color", "face", "size"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
  hr: new Set(["width", "size", "noshade"]),
};

/** Attributes carrying a URL — routed through `safeUrl`, never emitted raw. */
const URL_ATTRS = new Set(["href", "src", "cite"]);

/** Schemes a link may use. Everything else — `javascript:` above all — is dropped. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "cid:"]);

/** Inline images we accept as a `data:` URL. `data:text/html` is an XSS vector. */
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|x-icon);base64,[a-z0-9+/=\s]*$/i;

/**
 * CSS properties allowed in a surviving `style=`. An allowlist, because CSS is
 * an attack surface of its own: `position:fixed` is clickjacking over the app's
 * real chrome, and `url()` is a tracking pixel the img-blocking never sees.
 */
const SAFE_CSS_PROPS = new Set([
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "border-width",
  "caption-side",
  "clear",
  "color",
  "direction",
  "display",
  "empty-cells",
  "float",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "overflow-wrap",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
]);

/** Never allowed in a CSS *value*, whatever the property. */
const CSS_VALUE_DENY = /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import|\\/i;

/**
 * Markers a client uses to fence the quoted part of a reply. Matching one at
 * the TOP LEVEL of the document is how `quotedHtml` is split off, so collapsing
 * a quote never has to cut mid-element.
 */
const QUOTE_CLASS_HINTS = [
  "gmail_quote",
  "gmail_extra",
  "moz-cite-prefix",
  "yahoo_quoted",
  "outlookmessageheader",
  "protonmail_quote",
  "zmail_extra",
  "quoted",
];
const QUOTE_ID_HINTS = ["divrplyfwdmsg", "appendonsend", "reply139", "mail-editor-reference-message-container"];

// ── public API ────────────────────────────────────────────────────────────

export interface SanitizeOptions {
  /**
   * When false (the DEFAULT), every remote resource is neutralized: an `<img>`
   * keeps its geometry but loses `src`, gaining `data-blocked-src` so the UI can
   * offer a per-message "show images". This is what stops a tracking pixel from
   * reporting that the mail was opened, before the user has decided to trust the
   * sender.
   */
  allowRemoteContent?: boolean;
  /**
   * Resolve a `cid:` reference (an inline attachment) to a URL the app can
   * serve — normally a blob: URL from `JmapClient.download`. Unresolved `cid:`
   * refs are treated as blocked rather than emitted.
   */
  resolveCid?: (cid: string) => string | null;
  /** When false, the trailing quoted section is left inline. Default true. */
  splitQuote?: boolean;
}

export interface SanitizeResult {
  /** Safe HTML for the visible part of the message. */
  html: string;
  /**
   * The trailing quoted reply/forward, split at a top-level boundary. Empty
   * when none was found. Both halves are independently well-formed.
   */
  quotedHtml: string;
  /** How many remote resources were neutralized — drives "N images blocked". */
  blockedRemoteCount: number;
  /** Element names dropped with their subtree, deduped — for the "what was stripped" affordance. */
  droppedTags: string[];
}

/**
 * Sanitize sender HTML. Returns the visible body, the split-off quote, and what
 * was blocked. `sanitizeHtml` is the string-only convenience wrapper.
 */
export function sanitizeEmailHtml(dirty: string, opts: SanitizeOptions = {}): SanitizeResult {
  return new Sanitizer(dirty, opts).run();
}

/** Convenience: the visible HTML only. */
export function sanitizeHtml(dirty: string, opts: SanitizeOptions = {}): string {
  const r = sanitizeEmailHtml(dirty, opts);
  return r.html + r.quotedHtml;
}

/**
 * Render a text/plain body as safe HTML: escape, then linkify. Used when a
 * message has no HTML part — the escape is what matters, since `<` in a plain
 * body must never become a tag.
 */
export function textToSafeHtml(text: string): string {
  const escaped = escapeText(text);
  const linked = escaped.replace(/\b(https?:\/\/[^\s<>"']+)/gi, (url) => {
    const safe = safeUrl(url, { allowRemote: true, isResource: false });
    return safe ? `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>` : url;
  });
  return `<pre class="plain-body">${linked}</pre>`;
}

// ── the scanner ───────────────────────────────────────────────────────────

interface ParsedTag {
  closing: boolean;
  name: string;
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  end: number;
}

class Sanitizer {
  private readonly src: string;
  private readonly allowRemote: boolean;
  private readonly resolveCid?: (cid: string) => string | null;
  private readonly splitQuote: boolean;

  private out: string[] = [];
  /** Allowlisted elements currently open and emitted, innermost last. */
  private open: string[] = [];
  /** Dropped elements currently open; while non-empty everything is suppressed. */
  private dropped: string[] = [];
  private blocked = 0;
  private dropSet = new Set<string>();
  /** Index into `out` where the top-level quote began, or -1. */
  private quoteAt = -1;

  constructor(src: string, opts: SanitizeOptions) {
    this.src = src;
    this.allowRemote = opts.allowRemoteContent === true;
    if (opts.resolveCid) this.resolveCid = opts.resolveCid;
    this.splitQuote = opts.splitQuote !== false;
  }

  run(): SanitizeResult {
    let i = 0;
    const src = this.src;

    while (i < src.length) {
      const lt = src.indexOf("<", i);
      if (lt < 0) {
        this.text(src.slice(i));
        break;
      }
      if (lt > i) this.text(src.slice(i, lt));

      // Comments: skipped entirely. Conditional comments (`<!--[if mso]>`) hide
      // real markup from a naive stripper, so the whole node goes.
      if (src.startsWith("<!--", lt)) {
        const end = src.indexOf("-->", lt + 4);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      // Doctype / processing instruction / CDATA.
      if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
        const end = src.indexOf(">", lt);
        i = end < 0 ? src.length : end + 1;
        continue;
      }

      const tag = parseTag(src, lt);
      if (!tag) {
        // A bare "<" that starts no tag is text, not markup.
        this.text("<");
        i = lt + 1;
        continue;
      }
      i = tag.closing ? this.closeTag(tag) : this.openTag(tag, lt);
    }

    // Close whatever the sender left open — the output is balanced even when
    // the input was not.
    while (this.open.length > 0) this.out.push(`</${this.open.pop()}>`);

    const cut = this.quoteAt >= 0 ? this.quoteAt : this.out.length;
    return {
      html: this.out.slice(0, cut).join(""),
      quotedHtml: this.out.slice(cut).join(""),
      blockedRemoteCount: this.blocked,
      droppedTags: [...this.dropSet].sort(),
    };
  }

  private text(chunk: string): void {
    if (this.dropped.length > 0 || chunk === "") return;
    this.out.push(escapeText(chunk));
  }

  private openTag(tag: ParsedTag, at: number): number {
    const { name } = tag;

    // Inside a dropped subtree: track nesting so the matching close pops the
    // right frame, and emit nothing.
    if (this.dropped.length > 0) {
      if (RAW_TEXT.has(name)) return skipRawText(this.src, at, name);
      if (!VOID.has(name) && !tag.selfClosing) this.dropped.push(name);
      return tag.end;
    }

    if (RAW_TEXT.has(name)) {
      this.dropSet.add(name);
      return skipRawText(this.src, at, name);
    }

    if (DROP_SUBTREE.has(name)) {
      this.dropSet.add(name);
      if (!VOID.has(name) && !tag.selfClosing) this.dropped.push(name);
      return tag.end;
    }

    if (!ALLOWED.has(name)) {
      // Unknown element: unwrap. The tag vanishes, its children survive. The
      // matching close tag is ignored below because it is not on `open`.
      return tag.end;
    }

    // A quote boundary at the top level is where the collapse cut is made.
    if (this.splitQuote && this.quoteAt < 0 && this.open.length === 0 && isQuoteBoundary(tag)) {
      this.quoteAt = this.out.length;
    }

    this.out.push(this.serializeOpen(tag));
    if (!VOID.has(name) && !tag.selfClosing) this.open.push(name);
    return tag.end;
  }

  private closeTag(tag: ParsedTag): number {
    const { name } = tag;
    if (this.dropped.length > 0) {
      const idx = this.dropped.lastIndexOf(name);
      if (idx >= 0) this.dropped.length = idx;
      return tag.end;
    }
    const idx = this.open.lastIndexOf(name);
    if (idx < 0) return tag.end; // stray or unwrapped element's close tag
    while (this.open.length > idx) this.out.push(`</${this.open.pop()}>`);
    return tag.end;
  }

  private serializeOpen(tag: ParsedTag): string {
    const { name } = tag;
    const allowed = TAG_ATTRS[name];
    const parts: string[] = [name];
    let sawHref = false;

    for (const [rawKey, rawValue] of tag.attrs) {
      const key = rawKey.toLowerCase();
      // `on*` first and unconditionally: onerror/onload are the payload.
      if (key.startsWith("on")) continue;
      if (!GLOBAL_ATTRS.has(key) && !allowed?.has(key)) continue;

      const value = decodeEntities(rawValue);

      if (key === "style") {
        const css = safeStyle(value);
        if (css) parts.push(`style="${escapeAttr(css)}"`);
        continue;
      }

      if (URL_ATTRS.has(key)) {
        const isImage = name === "img" && key === "src";
        const url = safeUrl(value, {
          allowRemote: this.allowRemote,
          // `src` is fetched by the browser; `href`/`cite` are not.
          isResource: key === "src",
          allowDataImage: isImage,
          ...(this.resolveCid ? { resolveCid: this.resolveCid } : {}),
        });
        if (url === null) {
          // Remote content that policy neutralized keeps a handle so the UI can
          // offer "show images"; an unsafe scheme leaves nothing behind.
          if (isImage && isRemoteish(value)) {
            this.blocked++;
            parts.push(`data-blocked-src="${escapeAttr(value)}"`);
          }
          continue;
        }
        if (key === "href") sawHref = true;
        parts.push(`${key}="${escapeAttr(url)}"`);
        continue;
      }

      if (key === "target" || key === "rel") continue; // forced below
      if (!isSafeAttrValue(value)) continue;
      parts.push(`${key}="${escapeAttr(value)}"`);
    }

    // Every surviving link opens in a new tab and cannot reach back through
    // `window.opener` into the authenticated origin.
    if (name === "a" && sawHref) {
      parts.push(`target="_blank"`, `rel="noopener noreferrer nofollow"`);
    }
    // A blocked image with no alt would collapse to nothing; give the UI a hook.
    if (name === "img" && parts.some((p) => p.startsWith("data-blocked-src"))) {
      parts.push(`alt="[blocked image]"`);
    }
    return `<${parts.join(" ")}>`;
  }
}

/** Parse `<name attr=...>` or `</name>` starting at `pos`. */
function parseTag(src: string, pos: number): ParsedTag | null {
  let i = pos + 1;
  const closing = src[i] === "/";
  if (closing) i++;
  const start = i;
  while (i < src.length && /[a-zA-Z0-9:_-]/.test(src[i] as string)) i++;
  if (i === start) return null;
  const name = src.slice(start, i).toLowerCase();

  const attrs: Array<[string, string]> = [];
  let selfClosing = false;

  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (i >= src.length) break;
    if (src[i] === ">") {
      i++;
      break;
    }
    if (src[i] === "/" && src[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }
    if (src[i] === "/") {
      i++;
      continue;
    }

    const nameStart = i;
    while (i < src.length && !/[\s/>=]/.test(src[i] as string)) i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const attrName = src.slice(nameStart, i);

    while (i < src.length && /\s/.test(src[i] as string)) i++;
    let attrValue = "";
    if (src[i] === "=") {
      i++;
      while (i < src.length && /\s/.test(src[i] as string)) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = src.indexOf(quote, i);
        attrValue = end < 0 ? src.slice(i) : src.slice(i, end);
        i = end < 0 ? src.length : end + 1;
      } else {
        const vStart = i;
        while (i < src.length && !/[\s>]/.test(src[i] as string)) i++;
        attrValue = src.slice(vStart, i);
      }
    }
    attrs.push([attrName, attrValue]);
  }

  return { closing, name, attrs, selfClosing, end: i };
}

/**
 * Skip a raw-text element's content to its literal close tag. The close is
 * matched loosely (`</script foo>` counts) because that is how the real parser
 * behaves, and a stricter match here would leave the payload in the output.
 */
function skipRawText(src: string, at: number, name: string): number {
  const re = new RegExp(`</${name}[\\s/>]`, "i");
  const rest = src.slice(at + 1);
  const m = re.exec(rest);
  if (!m) return src.length;
  const closeAt = at + 1 + m.index;
  const gt = src.indexOf(">", closeAt);
  return gt < 0 ? src.length : gt + 1;
}

function isQuoteBoundary(tag: ParsedTag): boolean {
  if (tag.name === "blockquote") return true;
  for (const [key, value] of tag.attrs) {
    const k = key.toLowerCase();
    const v = value.toLowerCase();
    if (k === "class" && QUOTE_CLASS_HINTS.some((h) => v.includes(h))) return true;
    if (k === "id" && QUOTE_ID_HINTS.some((h) => v.includes(h))) return true;
  }
  return false;
}

// ── value policies ────────────────────────────────────────────────────────

interface UrlPolicy {
  /** The remote-content setting. Only consulted when `isResource` is true. */
  allowRemote: boolean;
  /**
   * True for a URL the BROWSER fetches on its own (`img src`), false for one the
   * USER has to click (`a href`). The distinction is the whole point of
   * remote-content blocking: an auto-fetched pixel reports that the mail was
   * opened, a link reports nothing until it is clicked. Gating `href` on
   * `allowRemote` would strip every link out of every message by default —
   * privacy theatre that breaks the client.
   */
  isResource: boolean;
  allowDataImage?: boolean;
  resolveCid?: (cid: string) => string | null;
}

/**
 * Validate a URL against the scheme allowlist and the remote-content policy.
 * Returns the URL to emit, or `null` to drop the attribute.
 *
 * Scheme detection runs on a *probe* with all whitespace and control characters
 * removed and entities decoded, because `java&#09;script:alert(1)` and
 * `java\nscript:alert(1)` both reach the parser as `javascript:`.
 */
export function safeUrl(raw: string, policy: UrlPolicy): string | null {
  const value = decodeEntities(raw).trim();
  // Stripping control characters IS the job here: they are how
  // `java\u0000script:` sneaks past a scheme check.
  // oxlint-disable-next-line no-control-regex
  const probe = value.replace(/[\u0000-\u0020\u007f\u00a0\u2028\u2029]/g, "").toLowerCase();
  if (probe === "") return null;

  if (probe.startsWith("data:")) {
    return policy.allowDataImage && SAFE_DATA_IMAGE.test(value.replace(/\s+/g, "")) ? value : null;
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1]}:`;
    if (!SAFE_SCHEMES.has(scheme)) return null;
    if (scheme === "cid:") {
      const resolved = policy.resolveCid?.(value.slice(value.indexOf(":") + 1));
      return resolved ?? null;
    }
    if ((scheme === "http:" || scheme === "https:") && policy.isResource && !policy.allowRemote) {
      return null;
    }
    return value;
  }

  // Protocol-relative `//host/path` is remote despite having no scheme.
  if (probe.startsWith("//")) {
    return policy.isResource && !policy.allowRemote ? null : `https:${value}`;
  }
  // In-document fragments are harmless; other relative URLs would resolve
  // against the WEBMAIL origin, which is never what a sender meant.
  if (probe.startsWith("#")) return value;
  return null;
}

/** Would this URL have fetched something off-origin if we had allowed it? */
function isRemoteish(value: string): boolean {
  const probe = decodeEntities(value).replace(/\s/g, "").toLowerCase();
  return probe.startsWith("http://") || probe.startsWith("https://") || probe.startsWith("//");
}

/** Filter a `style=` down to allowlisted properties with non-hostile values. */
export function safeStyle(css: string): string {
  const kept: string[] = [];
  for (const decl of css.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop) || value === "") continue;
    if (CSS_VALUE_DENY.test(value)) continue;
    if (/[<>{}]/.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.join("; ");
}

/** Non-URL attribute values: reject anything that looks like markup or script. */
function isSafeAttrValue(value: string): boolean {
  return !/[<>]/.test(value) && !/javascript\s*:|vbscript\s*:/i.test(value);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  tab: "\t",
  newline: "\n",
  sol: "/",
  lpar: "(",
  rpar: ")",
};

/**
 * Decode HTML entities in an ATTRIBUTE value. The browser does this before the
 * URL parser ever sees the string, so a sanitizer that skips it is checking a
 * different string than the one that will execute.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});?/gi, (match, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith("#x")) {
      const code = Number.parseInt(b.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCode(code) : match;
    }
    if (b.startsWith("#")) {
      const code = Number.parseInt(b.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCode(code) : match;
    }
    return NAMED_ENTITIES[b] ?? match;
  });
}

function safeFromCode(code: number): string {
  if (code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Escape a text node. `&` is escaped only when it does NOT already start a valid
 * entity, so `AT&T` becomes `AT&amp;T` while an existing `&amp;` is left alone
 * rather than double-escaped into visible `&amp;amp;`.
 */
export function escapeText(text: string): string {
  return text
    .replace(/&(?!(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape an attribute value. Entities were already decoded, so `&` always escapes. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
