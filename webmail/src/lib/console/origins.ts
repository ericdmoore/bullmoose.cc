// Where a console request is allowed to go — the T2 security boundary.
//
// `devPlan.md` T2: *"a form that POSTs **directly** to the agent worker's
// `/vault/credentials` with the operator's bearer — never through the site
// backend"*, and *"a raw key never appears in a request to the site origin.
// Assert the second with a test, not a convention."*
//
// This module is that assertion's teeth. Every request the console makes goes
// through `resolveTarget`, and any request classified as SECRET-BEARING is
// refused unless its origin is the vault's and demonstrably not the site's.
// The refusal is a thrown error, not a warning: the failure mode being designed
// against is a misconfiguration that silently routes a credential through
// `mail.bullmoose.cc`, and a console that "degrades gracefully" there has
// already leaked.
//
// Why this can be a *client-side* control at all: the browser picks the URL. The
// site backend cannot see a request that was never addressed to it, and the
// static-site deployment (Cloudflare Pages, `astro.config.mjs`) has no server
// route to intercept one anyway. The control is therefore "address it
// elsewhere, and prove you did" — which is exactly what a test can check.

/** A console request's sensitivity. Drives the origin rule, not the other way. */
export type Sensitivity =
  /** Carries credential material in the body. Vault origin only, ever. */
  | "secret"
  /** Reads or metadata writes. Vault origin, but the site origin is not fatal. */
  | "metadata";

export interface ConsoleOrigins {
  /** The agent worker, e.g. `https://agent.bullmoose.cc`. */
  vault: string;
  /** The page's own origin — the site backend the secret must never touch. */
  site: string;
}

export class OriginRefusal extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "OriginRefusal";
  }
}

const originOf = (raw: string): string => new URL(raw).origin;

/**
 * Normalize a configured base into an origin, or `null` if it is not one.
 * A blank/garbage vault base must read as "not configured" rather than
 * collapsing to the current page's origin, which is the dangerous default.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Build a URL for a console call and check it against the sensitivity rule.
 *
 * Three refusals, all fail-closed:
 *   1. no vault origin configured  → a secret has nowhere safe to go
 *   2. vault origin IS the site origin → the "direct POST" would be a POST to
 *      the site backend wearing a different name
 *   3. the computed URL's origin is not the vault's → a relative path, a
 *      redirect target, or a typo pointing back at the site
 */
export function resolveTarget(
  origins: Pick<ConsoleOrigins, "vault" | "site">,
  path: string,
  sensitivity: Sensitivity,
): string {
  const vault = normalizeOrigin(origins.vault);
  const site = normalizeOrigin(origins.site);

  if (sensitivity === "secret") {
    if (!vault) {
      throw new OriginRefusal(
        "Refusing to send credential material: no vault origin is configured. Set the agent " +
          "worker's origin, or use the CLI (`bullmoose creds set`), which posts there directly.",
        path,
      );
    }
    if (site !== null && vault === site) {
      throw new OriginRefusal(
        `Refusing to send credential material to ${vault}: that is this site's own origin. ` +
          "bureau.md invariant 1 and s03.E devPlan T2 require the secret to reach the vault " +
          "without transiting the site backend.",
        path,
      );
    }
  }

  const base = vault ?? site;
  if (!base) throw new OriginRefusal("No origin configured for the console.", path);
  const url = new URL(path, base + "/").toString();

  if (sensitivity === "secret" && originOf(url) !== vault) {
    throw new OriginRefusal(
      `Refusing to send credential material to ${originOf(url)}; only ${vault} is permitted.`,
      url,
    );
  }
  return url;
}

/**
 * Is this request body carrying credential material? Used by the test sweep,
 * and by `credentials.ts` to pick the sensitivity — one place decides, so a new
 * route cannot forget.
 *
 * Field names, not value sniffing: bureau.md §7a's rule applied to our own code
 * — *"declaration at mint time beats sniffing at runtime"*. A body is secret if
 * it declares a secret field, full stop.
 */
export const SECRET_FIELDS = ["secret", "client_secret", "code_verifier", "refresh_token"] as const;

export function carriesSecret(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  return SECRET_FIELDS.some((f) => f in (body as Record<string, unknown>));
}
