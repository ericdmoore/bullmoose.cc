import { type BureauVerb } from "@bullmoose/auth-core/principal";

/**
 * The pure half of the Bureau runtime: **which verb may run** (bureau.md §4.1)
 * and **where a credential may go** (§6). No I/O, no secrets, no environment —
 * everything here is a decision over a URL and a stored contract, which is why
 * it can be tested exhaustively and cheaply, and why the adversarial cases below
 * are unit tests rather than integration ones.
 *
 * These two gates run BEFORE anything is unsealed. That order is the design: the
 * Bureau decides whether a request is legal while it still holds nothing, so a
 * refusal costs a decryption that never happened.
 */

/**
 * §4.1 — verbs are typed to the credential's kind.
 *
 * The reason this table exists is narrower and sharper than "least privilege":
 * a caller who can compute `HMAC(kSecret, anything)` can derive
 * `kDate → kRegion → kService → kSigning` and **forge any SigV4 signature for
 * that account**. So `hmac_sha256` must never be pointable at an `aws-sigv4`
 * credential, and the only thing that can stop it is the credential's `kind`.
 * Without this table `kind` would be decoration.
 *
 * An unknown kind permits NOTHING (see `verbPermittedForKind`) — a row minted by
 * some future version of the mint path is not a row this version understands,
 * and "understand it later" is the safe direction.
 */
export const VERBS_BY_KIND: Readonly<Record<string, readonly BureauVerb[]>> = {
  "api-key": ["fetch"],
  "oauth-refresh": ["oauth_token", "fetch"],
  "aws-sigv4": ["sign_sigv4", "fetch"],
  "hmac-key": ["hmac_sha256"],
};

/** Fail closed on an unrecognised kind: no entry ⇒ no verb. */
export function verbPermittedForKind(kind: string, verb: string): boolean {
  const permitted = VERBS_BY_KIND[kind];
  if (!permitted) return false;
  return (permitted as readonly string[]).includes(verb);
}

/**
 * One parsed allowlist entry, decomposed into exactly the three things §6 says
 * to compare: **scheme, host, port**. Nothing else about a URL is part of the
 * decision — not the path, not the query, not the userinfo.
 *
 * `port` is the WHATWG-normalized form, i.e. `""` for the scheme's default. Both
 * sides of the comparison go through `new URL`, so `https://h` and
 * `https://h:443` are the same port and `https://h:8443` is not.
 */
export interface AllowEntry {
  /** WHATWG protocol, colon included: `"https:"` / `"http:"`. */
  protocol: string;
  /** For an exact entry, the hostname. For a wildcard, the suffix after `*.`. */
  host: string;
  /** `""` means the scheme default. */
  port: string;
  /** True for `*.host` — a deliberate widening (§6.4), never a substring match. */
  wildcard: boolean;
}

/**
 * Parse one stored allowlist entry, or null if it is not one.
 *
 * This deliberately re-parses rather than trusting the canonical form that
 * `services/agent`'s mint path wrote. The Bureau is the enforcement point and a
 * row can outlive the validation that produced it — written by an older mint
 * path, edited by an operator, restored from a backup. Re-deriving the decision
 * from the raw string means the guarantee holds regardless of how the row got
 * there, and anything unparseable fails closed instead of matching loosely.
 */
export function parseAllowEntry(raw: unknown): AllowEntry | null {
  if (typeof raw !== "string") return null;
  const val = raw.trim().toLowerCase();
  if (!val) return null;

  // Wildcard — the ONLY non-exact form, and only as an explicit leading `*.`
  // over at least two labels. `*.com` is refused; so is a bare `*`. Note the
  // absence of a port: a wildcard entry binds the scheme's default port, and a
  // non-default port must be named on an exact origin.
  const wild = /^(?:(https?):\/\/)?\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(val);
  if (wild) return { protocol: `${wild[1] ?? "https"}:`, host: wild[2]!, port: "", wildcard: true };

  try {
    const u = new URL(val.includes("://") ? val : `https://${val}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.hostname.includes("*")) return null;
    // An entry carrying userinfo is a malformed policy, not a permissive one:
    // `https://api.stripe.com@evil.com` parses to host `evil.com`, and a human
    // reading the console would see the opposite. Refuse rather than surprise.
    if (u.username || u.password) return null;
    return { protocol: u.protocol, host: u.hostname, port: u.port, wildcard: false };
  } catch {
    return null;
  }
}

export type Allowlist = { ok: true; entries: AllowEntry[] } | { ok: false; reason: string };

/**
 * Read the destination binding off the credential's §5 contract.
 *
 * **Invariant 5, fail closed.** No `allow` ⇒ the credential is unusable. This is
 * §6.5 taken literally: "if the default is *allow all*, the dangerous case is
 * what you get by forgetting." Forgetting must produce a refusal.
 *
 * A malformed entry poisons the WHOLE list rather than being skipped. Skipping
 * would silently narrow a policy nobody re-read — an operator who typo'd one of
 * two origins would get a credential that still worked, for one host, and never
 * learn. Refusing makes the typo a visible failure at first use.
 */
export function readAllowlist(meta: Record<string, unknown>): Allowlist {
  const raw = meta.allow;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  if (list.length === 0) return { ok: false, reason: "no destination allowlist (fail closed)" };

  const entries: AllowEntry[] = [];
  for (const item of list) {
    const entry = parseAllowEntry(item);
    if (!entry) return { ok: false, reason: `unparseable allowlist entry: ${String(item)}` };
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * §6.2 — **match scheme + host + port exactly; never substring.**
 *
 * The two classic bugs this is written against:
 *
 *   startsWith("https://api.stripe.com") → https://api.stripe.com.evil.com  ✗
 *   substring "api.stripe.com"           → https://evil.com/?x=api.stripe.com ✗
 *
 * Neither can happen here because nothing is ever compared as a string prefix.
 * The URL is parsed and its three structural fields are compared field by field;
 * the wildcard case is the one exception and it is a **suffix over a label
 * boundary**, which is why `api.stripe.com.evil.io` fails `*.stripe.com`: it
 * ends with `.evil.io`, and `.stripe.com` appears only in the middle, where no
 * comparison here ever looks.
 */
export function destinationAllowed(url: URL, entries: readonly AllowEntry[]): boolean {
  return entries.some((entry) => matchesEntry(url, entry));
}

function matchesEntry(url: URL, entry: AllowEntry): boolean {
  if (url.protocol !== entry.protocol) return false;
  if (url.port !== entry.port) return false;
  if (!entry.wildcard) return url.hostname === entry.host;
  // `*.amazonaws.com` matches `ce.us-east-1.amazonaws.com` and NOT the apex
  // `amazonaws.com` (mint the apex explicitly if you mean it) and NOT
  // `evil-amazonaws.com`, because the dot must be a real label boundary. The
  // length test also rejects the degenerate `.amazonaws.com`, which has an
  // empty first label.
  const suffix = `.${entry.host}`;
  return url.hostname.length > suffix.length && url.hostname.endsWith(suffix);
}

/**
 * The caller-supplied request URL, parsed and structurally vetted before it is
 * matched against anything.
 *
 * `username`/`password` are refused outright: `https://api.stripe.com@evil.com/`
 * is the origin-confusion trick that makes a destination look allowlisted to a
 * human while parsing to something else, and no legitimate agent request needs
 * userinfo in a URL.
 */
export function parseDestination(raw: unknown): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "url is required" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `unsupported scheme: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "url must not carry userinfo" };
  }
  return { ok: true, url };
}

/** A parsed `--header` recipe: the field name, and the value template holding
 *  the `{}` slot the credential lands in. */
export interface HeaderRecipe {
  name: string;
  template: string;
}

/** RFC 9110 field-name token characters. */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/**
 * Parse `"Header-Name: …{}…"` (bureau.md §5).
 *
 * **Invariant 8 is structural here, not a rule.** This shape can only produce a
 * header: there is no branch that writes a query parameter, so a credential
 * cannot land in a URL — and therefore not in an access log, a `Referer`, or
 * browser history — even by misconfiguration. The recipe is config, read off the
 * credential; the caller never names it and never names the secret.
 */
export function parseHeaderRecipe(raw: unknown): HeaderRecipe | null {
  if (typeof raw !== "string") return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const name = raw.slice(0, at).trim();
  const template = raw.slice(at + 1).trim();
  if (!FIELD_NAME.test(name)) return null;
  if (!template.includes("{}")) return null;
  return { name, template };
}

/**
 * Render the recipe with the credential in the slot.
 *
 * `split`/`join` rather than `String.replace`: `replace` would both stop at the
 * first `{}` and interpret `$&`, `$'` and friends inside the SECRET as
 * replacement patterns — a secret containing `$&` would silently mangle itself
 * into a value that does not authenticate, and the failure would look like a
 * wrong key rather than a bug here.
 */
export function renderHeaderValue(recipe: HeaderRecipe, secret: string): string | null {
  const value = recipe.template.split("{}").join(secret);
  // A CR or LF anywhere in the rendered value is header injection. It can only
  // come from a secret that was sealed with one, but refusing beats letting the
  // platform throw an opaque error mid-request.
  if (/[\r\n]/.test(value)) return null;
  return value;
}
