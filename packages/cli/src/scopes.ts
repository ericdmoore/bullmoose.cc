/**
 * `--scopes` parsing for every CLI command that mints a token.
 *
 * MIRROR of the scope vocabulary in `@bullmoose/auth-core` — kept here, not
 * imported, for the same reason `mime.ts` is: the CLI compiles to plain
 * Node under `dist/` and cannot import workspace TypeScript at runtime.
 * `scopes.test.ts` imports both and fails if the two lists drift.
 *
 * The server validates all of this again (it must — the CLI is not the only
 * client). Doing it here too is for the error message: a typo'd scope should
 * cost a local exit 2 naming the vocabulary, not an HTTP 400 after a round
 * trip, and — for `token create` — the mistake it most needs to catch is
 * saying nothing at all.
 */

/** Mail verbs. `mail` is the bundle of exactly these. */
export const MAIL_SCOPES = ["read", "annotate", "draft", "move", "send", "delete"] as const;

/** Realm scopes — independent of the mail verbs, NOT covered by `mail`.
 * `files` is the FileNode realm (sVOL 011); mirrors auth-core. */
export const REALM_SCOPES = ["contacts", "calendar", "vault", "files"] as const;

/** What `bullmoose login` / `bullmoose token create` may ask for (no `admin`). */
export const SELF_SERVICE_SCOPES: readonly string[] = [...MAIL_SCOPES, ...REALM_SCOPES, "mail"];

/** What `bullmoose admin token create` may ask for — the operator plane. */
export const TOKEN_SCOPES: readonly string[] = [...SELF_SERVICE_SCOPES, "admin"];

/**
 * Suggested sets, printed when `--scopes` is missing. `token create` exists
 * to make a narrow credential for one device; a user who has to be told the
 * flag is required should get a usable answer in the same breath, or they
 * will reach for the widest thing that works.
 */
export const SCOPE_SUGGESTIONS: ReadonlyArray<{ scopes: string; use: string }> = [
  { scopes: "read", use: "backup / search / read-only sync" },
  { scopes: "read,move", use: "POP3 or IMAP-style fetch (popcorn)" },
  { scopes: "read,draft,send", use: "a desktop or phone mail client" },
  { scopes: "mail", use: "all six mail verbs; no contacts/calendar/vault" },
  { scopes: "mail,contacts,calendar", use: "a full device (JMAP + CardDAV + CalDAV)" },
];

export type ParsedScopes =
  | { ok: true; scopes: string[] | undefined }
  | { ok: false; error: string };

/**
 * Parse a `--scopes a,b,c` flag.
 *
 * `required: true` rejects an omitted flag — that is the fix for tokens
 * being minted at the widest scope by default. `required: false` (login
 * only) returns `scopes: undefined`, meaning "let the server default",
 * which is what keeps a user with no token able to get one.
 *
 * An explicitly EMPTY value is always an error, whether required or not:
 * `--scopes ""` is a typo, and both "the server default" and "a token that
 * can do nothing" are worse guesses than saying so.
 */
export function parseScopeFlag(
  raw: string | undefined,
  allowed: readonly string[],
  required: boolean,
): ParsedScopes {
  if (raw === undefined) {
    if (!required) return { ok: true, scopes: undefined };
    return { ok: false, error: `--scopes is required.\n${scopeHelp(allowed)}` };
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: `--scopes was given but empty.\n${scopeHelp(allowed)}` };
  }
  const bad: string[] = [];
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const s of parts) {
    if (!allowed.includes(s)) {
      if (!bad.includes(s)) bad.push(s);
      continue;
    }
    if (seen.has(s)) continue; // `read,read` is not two scopes
    seen.add(s);
    scopes.push(s);
  }
  if (bad.length > 0) {
    return { ok: false, error: `unknown scope(s): ${bad.join(", ")}\n${scopeHelp(allowed)}` };
  }
  return { ok: true, scopes };
}

/** The vocabulary + suggestions block shared by every `--scopes` error. */
export function scopeHelp(allowed: readonly string[]): string {
  const lines = [`valid scopes: ${allowed.join(", ")}`, "common choices:"];
  for (const s of SCOPE_SUGGESTIONS) {
    if (s.scopes.split(",").every((x) => allowed.includes(x))) {
      lines.push(`  --scopes ${s.scopes.padEnd(24)} ${s.use}`);
    }
  }
  return lines.join("\n");
}
