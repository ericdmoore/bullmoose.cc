// The interim front door: what counts as a token, and what to say when the
// pasted string is not one.
//
// ⚠️ This is INTERIM BY DESIGN and is scheduled for deletion. The real door is
// the OAuth AS from s02 T3 (`auth.bullmoose.cc`), which s07 T7 points the
// webmail at as a public PKCE client — the same front door claude.ai gets,
// rather than a second bespoke login. Until then, pasting a `bm_` token minted
// by `bullmoose token create` is honest for a single operator: it is a
// credential the operator already has, and it never leaves the browser.
//
// Everything here is pure. The island (`components/LoginForm.tsx`) does the two
// impure things — `storeSession` (client.ts) then `location.assign` — and
// neither of them can put the token in a URL.

/**
 * MIRROR of `parseToken`'s pattern in `packages/auth-core/src/index.ts:45`
 * (`bm_<12 hex id>_<48 hex secret>`, the shape `mintToken` emits at :36).
 *
 * A mirror rather than an import, for the reason `lib/console/scopes.ts:13`
 * records: `auth-core` is Worker code that typechecks against
 * `@cloudflare/workers-types` and does not belong in a DOM-typed program.
 * `login.test.ts` drives the REAL `parseToken` against this regex so drift is
 * a failing test rather than a mysterious 401 — the same split
 * `scopes.test.ts` uses (tsc checks the shape, vitest checks the behaviour).
 */
export const TOKEN_SHAPE = /^bm_[0-9a-f]{12}_[0-9a-f]{48}$/;

export type TokenCheck = { ok: true; token: string } | { ok: false; error: string };

export function isTokenShape(raw: string): boolean {
  return TOKEN_SHAPE.test(raw.trim());
}

/**
 * Check a pasted token and say what is wrong with it in the browser, while the
 * user is still looking at the field.
 *
 * The alternative — store anything, let the server answer 401 — moves the
 * error three requests away into a screen whose only vocabulary for it is
 * "something went wrong", and the most common mistake by far (pasting the
 * `tk_` row id, which is what every listing shows) looks exactly like a
 * revoked credential.
 */
export function checkToken(raw: string): TokenCheck {
  const token = raw.trim();
  if (!token) return { ok: false, error: "Paste the token you were shown at mint." };

  if (TOKEN_SHAPE.test(token)) return { ok: true, token };

  if (token.startsWith("tk_")) {
    return {
      ok: false,
      error:
        "That is a token id, not the token. The id (tk_…) is what listings show; " +
        "the token itself starts with bm_ and is only ever shown once, at mint.",
    };
  }
  if (!token.startsWith("bm_")) {
    return { ok: false, error: "A bullmoose token starts with bm_." };
  }

  // Same prefix, wrong body: say which half, since a truncated paste and a
  // mangled one need different fixes (paste again vs. mint again).
  const parts = token.split("_");
  if (parts.length !== 3) {
    return { ok: false, error: "A token has exactly two underscores: bm_<id>_<secret>." };
  }
  const [, id, secret] = parts as [string, string, string];
  if (!/^[0-9a-f]*$/.test(id + secret)) {
    return { ok: false, error: "A token is lowercase hex after bm_ — this has other characters." };
  }
  return {
    ok: false,
    error:
      `Wrong length: expected 12 hex characters then 48, got ${id.length} then ` +
      `${secret.length}. A partial paste looks exactly like this.`,
  };
}

export type BaseCheck = { ok: true; base: string } | { ok: false; error: string };

/**
 * Check the optional API base.
 *
 * Deliberately NOT `normalizeOrigin` (`lib/console/origins.ts`): that reduces a
 * base to its bare origin, which is right for the vault — where a path would be
 * a misconfiguration worth refusing — and wrong here, because `FetchJmapClient`
 * appends to whatever it is given (`JmapClient.ts:135`) and a path-prefixed
 * deployment is legitimate. Same refusals, different normalization.
 */
export function checkApiBase(raw: string): BaseCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter an API base, or leave it blank for this origin." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "That is not an absolute URL — include https://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The API base must be an http(s) URL." };
  }
  return { ok: true, base: url.toString().replace(/\/$/, "") };
}
