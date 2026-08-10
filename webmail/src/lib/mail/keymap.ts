// Keyboard-first triage (devPlan T2: "archive/label/next without the mouse").
//
// Resolution is a pure function of (key, context, pending chord) so the whole
// binding table is unit-testable in Node without a DOM — the component only
// forwards events and performs the returned action.

export type MailAction =
  | "next"
  | "prev"
  | "openSelected"
  | "back"
  | "archive"
  | "trash"
  | "toggleFlag"
  | "toggleRead"
  | "move"
  | "compose"
  | "reply"
  | "replyAll"
  | "forward"
  | "search"
  | "refresh"
  | "toggleSelect"
  | "selectAll"
  | "clearSelection"
  | "toggleQuote"
  | "showImages"
  | "send"
  | "discard"
  | "help"
  | "goInbox"
  | "goArchive"
  | "goSent"
  | "goDrafts"
  | "goTrash";

export type KeyContext = "list" | "thread" | "compose";

/** The bit of a KeyboardEvent this module needs — so tests need no DOM. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export interface KeyResolution {
  action?: MailAction;
  /** The chord prefix now armed (`g`), or undefined once it resolves. */
  pending?: string;
  /** True when the app should call preventDefault. */
  handled: boolean;
}

const NONE: KeyResolution = { handled: false };

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Chord table: `g` then a letter jumps to a mailbox. */
const GO_CHORDS: Record<string, MailAction> = {
  i: "goInbox",
  a: "goArchive",
  s: "goSent",
  d: "goDrafts",
  t: "goTrash",
};

const LIST_KEYS: Record<string, MailAction> = {
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  Enter: "openSelected",
  o: "openSelected",
  e: "archive",
  "#": "trash",
  s: "toggleFlag",
  u: "toggleRead",
  v: "move",
  c: "compose",
  "/": "search",
  x: "toggleSelect",
  ".": "refresh",
  "?": "help",
};

const THREAD_KEYS: Record<string, MailAction> = {
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  u: "back",
  Escape: "back",
  e: "archive",
  "#": "trash",
  s: "toggleFlag",
  v: "move",
  r: "reply",
  a: "replyAll",
  f: "forward",
  c: "compose",
  "/": "search",
  q: "toggleQuote",
  i: "showImages",
  "?": "help",
};

/**
 * Resolve a keystroke.
 *
 * Two rules that keep this from fighting the user:
 * - **Typing wins.** While focus is in a field, only Escape and the send chord
 *   are intercepted; otherwise `e` in a subject line would archive the mail.
 * - **Browser shortcuts win.** Anything with Ctrl/Cmd (except the explicit send
 *   chord) is left alone, so Cmd-L, Cmd-R and Cmd-F keep working.
 */
export function resolveKey(ev: KeyLike, context: KeyContext, pending?: string): KeyResolution {
  const typing = isTyping(ev);
  const modified = ev.ctrlKey === true || ev.metaKey === true;

  // Send: the one chord that fires from inside the composer.
  if (context === "compose" && modified && ev.key === "Enter") {
    return { action: "send", handled: true };
  }
  if (context === "compose" && ev.key === "Escape") {
    return { action: "discard", handled: true };
  }
  if (typing) {
    if (ev.key === "Escape") return { action: "clearSelection", handled: true };
    return NONE;
  }
  if (modified || ev.altKey === true) return NONE;

  if (pending === "g") {
    const action = GO_CHORDS[ev.key];
    return action ? { action, handled: true } : { handled: true };
  }
  if (ev.key === "g" && context !== "compose") {
    return { pending: "g", handled: true };
  }

  if (context === "list") {
    if (ev.key === "a" && ev.shiftKey !== true) return NONE; // reserved for select-all chord
    if (ev.key === "A") return { action: "selectAll", handled: true };
    if (ev.key === "Escape") return { action: "clearSelection", handled: true };
    const action = LIST_KEYS[ev.key];
    return action ? { action, handled: true } : NONE;
  }

  if (context === "thread") {
    const action = THREAD_KEYS[ev.key];
    return action ? { action, handled: true } : NONE;
  }

  return NONE;
}

function isTyping(ev: KeyLike): boolean {
  const target = ev.target;
  if (!target) return false;
  if (target.isContentEditable === true) return true;
  return EDITABLE.has((target.tagName ?? "").toUpperCase());
}

/** The shortcut list the `?` overlay renders. */
export const KEY_HELP: Array<{ keys: string; description: string; context: KeyContext[] }> = [
  { keys: "j / k", description: "Next / previous message", context: ["list", "thread"] },
  { keys: "Enter / o", description: "Open the selected thread", context: ["list"] },
  { keys: "u / Esc", description: "Back to the list", context: ["thread"] },
  { keys: "e", description: "Archive", context: ["list", "thread"] },
  { keys: "#", description: "Move to Trash", context: ["list", "thread"] },
  { keys: "s", description: "Flag / unflag", context: ["list", "thread"] },
  { keys: "u", description: "Toggle read / unread", context: ["list"] },
  { keys: "v", description: "Move to a folder", context: ["list", "thread"] },
  { keys: "x", description: "Select / deselect", context: ["list"] },
  { keys: "Shift+A", description: "Select all loaded", context: ["list"] },
  { keys: "c", description: "Compose", context: ["list", "thread"] },
  { keys: "r / a / f", description: "Reply / reply all / forward", context: ["thread"] },
  { keys: "q", description: "Show or hide quoted text", context: ["thread"] },
  { keys: "i", description: "Load blocked images", context: ["thread"] },
  { keys: "/", description: "Search", context: ["list", "thread"] },
  { keys: ".", description: "Refresh", context: ["list"] },
  { keys: "g then i/a/s/d/t", description: "Go to Inbox/Archive/Sent/Drafts/Trash", context: ["list", "thread"] },
  { keys: "Cmd/Ctrl+Enter", description: "Send", context: ["compose"] },
  { keys: "?", description: "This help", context: ["list", "thread"] },
];
