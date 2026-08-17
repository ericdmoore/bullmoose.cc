// What the server will accept as a name, checked before the round trip — and
// what to do when the name is already taken.
//
// ── The rules are READ OFF the server, not invented ────────────────────────
//
// `buildNewNode` (filenode.ts:520-523) and `validatePatch`'s `name` case
// (:597-602) apply the SAME test in both places:
//
//     typeof name !== "string" || length === 0 || length > 255 || includes("/")
//
// so `MAX_NAME` here is 255 because it is 255 there, and `/` is refused because
// it is the one character a path separator can never be. Everything in
// `nameProblem` below either mirrors that test or is documented as deliberately
// stricter — and there are exactly two of the latter:
//
//   • **whitespace-only.** The server accepts `"   "`; it produces a folder
//     that looks unnamed and cannot be told from its neighbours. We trim first
//     and refuse the empty remainder, which is also what `AddressBook/set`
//     callers do with `name.trim()` (../contacts/write.ts:249).
//   • **`.` and `..`.** The server accepts them. The inbound sidestep does not
//     (`fileNameFor`, sidestep.ts:260-263) — it treats both as unnamed — and a
//     Files browser rendering a row called `..` that is NOT "go up" is a trap
//     built out of muscle memory.
//
// Being stricter than the server is a choice with a cost: a name another client
// created is still rendered fine, it just cannot be TYPED here. That asymmetry
// is deliberate; silently rewriting what someone typed would be worse.
//
// ── Collisions ────────────────────────────────────────────────────────────
//
// `UNIQUE(account_id, parent_id, name)` is real in the schema
// (`data-plane.sql:738`) and `FileNode/set` refuses a duplicate with
// `alreadyExists` before it touches the DB (filenode.ts:232-234). Two different
// answers, on purpose:
//
//   • an UPLOAD auto-renames — `report.pdf` → `report (2).pdf` — because the
//     user named a file on their disk months ago and is not asking a question
//     about this folder. `uniqueName` is a copy of the sidestep's own
//     (sidestep.ts:272-286) so a browser upload and a delivered attachment land
//     on the same string.
//   • a NEW FOLDER does not. The name is what the person just typed, and
//     quietly turning it into `Invoices (2)` builds a second folder they will
//     not find. It refuses, and says the name is taken.

import type { FileNode } from "./types";

/** `MAX_NAME` in filenode.ts:69. */
export const MAX_NAME = 255;

/** Why a name is not usable, phrased for a person. `null` = it is fine. */
export function nameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "A name is required.";
  if (name.includes("/")) return "A name cannot contain “/”.";
  if (name === "." || name === "..") {
    return "“.” and “..” mean “here” and “up” — pick a name that means this folder.";
  }
  if (name.length > MAX_NAME) return `A name can be at most ${MAX_NAME} characters.`;
  return null;
}

export function isValidName(raw: string): boolean {
  return nameProblem(raw) === null;
}

/**
 * The name that will actually be sent. Trimming is part of validation, so the
 * check and the write must agree on it — hence one function both call.
 */
export function normalizeName(raw: string): string {
  return raw.trim();
}

/**
 * Is `name` already used by a sibling?
 *
 * Case-SENSITIVE, matching the server's default: `nameTaken` lowercases only
 * when the call passes `compareCaseInsensitively: true` (filenode.ts:212-219),
 * and nothing in this section passes it. A client that predicted
 * case-insensitively would refuse names the server would have accepted.
 */
export function nameTaken(siblings: readonly FileNode[], name: string, excludeId?: string): boolean {
  const target = normalizeName(name);
  return siblings.some((n) => n.id !== excludeId && n.name === target);
}

/**
 * `name`, or the first `name (2)`, `name (3)`… not already taken.
 *
 * A byte-for-byte mirror of `uniqueName` in `services/ingest/src/sidestep.ts`,
 * including the suffix-before-extension rule (so an OS still sees `.pdf`), the
 * 11-character extension ceiling, the dotfile exception, and the 998-collision
 * fallback. Kept identical so the same file arriving by mail and by upload gets
 * the same name — if that module changes, this one changes with it.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && name.length - dot <= 11;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`.slice(0, MAX_NAME);
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${randomSuffix()})${ext}`.slice(0, MAX_NAME);
}

/** The set `uniqueName` tests against, built from a directory's children. */
export function takenNames(siblings: readonly FileNode[]): Set<string> {
  return new Set(siblings.map((n) => n.name));
}

/**
 * A safe upload name for a browser `File`.
 *
 * A `File.name` cannot contain a path in any modern browser, but a drag from a
 * directory-aware source can carry one in `webkitRelativePath`-shaped names, so
 * this applies the sidestep's own cleaning (`fileNameFor`, sidestep.ts:253-264)
 * rather than trusting it: control characters and separators out, trimmed,
 * clamped to 255, and a stable fallback for the unnamed case.
 */
export function safeUploadName(rawName: string, fallbackSeed = ""): string {
  const cleaned = rawName
    .replace(/[\p{Cc}/\\]+/gu, "_")
    .trim()
    .slice(0, MAX_NAME);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    const seed = fallbackSeed.replace(/[^\w.-]+/g, "").slice(0, 8);
    return `upload-${seed || randomSuffix()}`;
  }
  return cleaned;
}

function randomSuffix(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
