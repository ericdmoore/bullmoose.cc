// HTML sanitization — SECURITY SURFACE, scaffolded here, WIRED IN T2.
//
// Untrusted sender HTML rendered in an authenticated origin is the classic
// webmail XSS vector (arch.md §4, invariant §6.3). The real T2 implementation
// must:
//   • run a strict allowlist sanitizer (e.g. DOMPurify or an equivalent that
//     runs in the Worker/edge, not just the browser);
//   • block remote content by default (tracking pixels, remote CSS/fonts) with
//     an explicit "show images" opt-in per sender;
//   • pair with a strict Content-Security-Policy on the webmail origin;
//   • collapse quoted text.
//
// ⚠️ NOTHING renders sender HTML yet — T2 owns the thread view. This stub exists
// so the seam is named and so the default is SAFE (strip, don't pass through):
// if some early code reaches for it before T2 lands, it must fail closed.
//
// The stub deliberately strips ALL tags rather than allow-listing a few, so it
// can never be mistaken for a finished sanitizer.

export interface SanitizeOptions {
  /** T2: when false (default), rewrite remote src/href to neutralize pixels. */
  allowRemoteContent?: boolean;
}

/**
 * TEMPORARY, FAIL-CLOSED sanitizer. Strips every tag and returns text content
 * only. NOT a substitute for the T2 allowlist sanitizer — do not render its
 * output as trusted rich HTML.
 */
export function sanitizeHtml(dirty: string, _opts: SanitizeOptions = {}): string {
  // Remove script/style bodies entirely, then drop all remaining tags. This is
  // intentionally lossy: the goal is "provably safe placeholder", not fidelity.
  const withoutBlocks = dirty
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "");
  const withoutTags = withoutBlocks.replace(/<\/?[^>]+>/g, "");
  return withoutTags;
}

/** T2 will replace this with a real check; for now nothing is allowed. */
export const SANITIZER_IS_STUB = true as const;
