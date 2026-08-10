// Choosing which `JmapClient` the app runs against.
//
// Invariant §6.1: no component imports a client — the shell resolves ONE here
// and injects it downward. This module is the only place in the app that
// decides between the real server, the in-memory demo, and no session at all.
//
// It is also the only place that reads or writes the stored credential, which
// is why `storeSession` lives here rather than in the login island: one owner
// of `bullmoose.token` means the door writes exactly what the shell reads.

import { FetchJmapClient, type JmapClient } from "../jmap/JmapClient";
import { createDemoBackend, type DemoBackend } from "../jmap/demo";
import { isTokenShape } from "./login";

export type ClientMode = "live" | "demo" | "unauthenticated";

/** Live: a real token against a real server. */
export interface LiveClient {
  mode: "live";
  client: JmapClient;
  reason?: string;
}

/** Demo: the in-memory fake. Only ever reached by asking for it (`?demo=1`). */
export interface DemoClient {
  mode: "demo";
  client: JmapClient;
  /** Lets the UI say so, and tests inspect the store. */
  demo: DemoBackend;
  /** Human-readable reason the demo was chosen. */
  reason: string;
}

/**
 * No usable session. There is deliberately NO client on this branch: the type
 * makes "render something anyway" unrepresentable, which is the whole point.
 * Callers route to `/login`.
 */
export interface UnauthenticatedClient {
  mode: "unauthenticated";
  reason: string;
}

export type ResolvedClient = LiveClient | DemoClient | UnauthenticatedClient;

const TOKEN_KEY = "bullmoose.token";
const BASE_KEY = "bullmoose.apiBase";
const TOKEN_PARAM = "token";

/**
 * Resolve a client from the environment.
 *
 * Live requires a bearer token. There is deliberately no anonymous live mode:
 * a mail client that renders a login-shaped shell against no session is how you
 * end up shipping a UI nobody has ever driven with real data.
 *
 * ⚠️ No token used to mean DEMO. On a single-operator laptop that was a
 * convenience; on a public origin it means a stranger at `app.bullmoose.cc`
 * sees a convincing mailbox full of fake mail and has no idea it is fake
 * (s07 devPlan T1). Demo is now opt-in only, and the bare no-token case
 * resolves to `unauthenticated` so the caller can show the door.
 */
export function resolveClient(search = globalThis.location?.search ?? ""): ResolvedClient {
  const params = new URLSearchParams(search);

  // `?agentcap=0` drops `urn:bullmoose:params:jmap:agent` from the demo
  // session, so the plain-client floor (arch.md §8.6) can be DRIVEN in a
  // browser rather than only asserted in unit tests — s03.C T2's lesson was
  // that `astro build` and a green suite both reported success while the page
  // rendered empty. Demo-only: it configures the fake, never the real client.
  const demoOpts = params.get("agentcap") === "0" ? { agentCapability: false } : {};

  if (params.get("demo") === "1") {
    const demo = createDemoBackend(demoOpts);
    return { client: demo.client, mode: "demo", demo, reason: "?demo=1" };
  }

  // `?token=` survives as a dev affordance, but it does NOT survive the read.
  // A credential in a query string lands in browser history, in the `Referer`
  // of every outbound link, and in every access log on the path (s07 devPlan,
  // refinement 1). We take the value and immediately rewrite the address bar
  // without it — the only navigation in this app that ever sees a token.
  const fromUrl = params.get(TOKEN_PARAM);
  const token = fromUrl ?? readStorage(TOKEN_KEY);
  const baseUrl = params.get("api") ?? readStorage(BASE_KEY) ?? defaultBase();

  if (!token) {
    return { mode: "unauthenticated", reason: "no session token" };
  }

  // A stored value of the wrong shape can only produce a 401 three requests
  // later, in a screen that has no vocabulary for it. Send it back to the door,
  // which does have one (`login.ts` explains what is wrong with the string).
  if (!isTokenShape(token)) {
    if (fromUrl) forgetTokenInUrl();
    return { mode: "unauthenticated", reason: "stored token is not a bm_… token" };
  }

  // Persist so a reload does not need the query string again.
  storeSession(token, baseUrl);
  if (fromUrl) forgetTokenInUrl();
  return { client: new FetchJmapClient({ baseUrl, token }), mode: "live" };
}

/**
 * Where `/` should send a browser. Derived from the resolved mode rather than
 * re-deciding, so there is still exactly one place that answers "is there a
 * session" (§6.1). Every return value here is a literal path with no
 * credential in it — asserted in `tokenInUrl.test.ts`.
 */
export function homeTarget(resolved: ResolvedClient): string {
  switch (resolved.mode) {
    case "live":
      return "/mail";
    // Demo was asked for explicitly; carry the ask across the redirect or the
    // destination would resolve to `unauthenticated` and bounce to the door.
    case "demo":
      return "/mail?demo=1";
    case "unauthenticated":
      return "/login";
  }
}

/**
 * Write the session. The door's only side effect (`LoginForm.tsx`), and the
 * reason the token never needs to travel through a URL to get here.
 */
export function storeSession(token: string, baseUrl?: string): void {
  writeStorage(TOKEN_KEY, token);
  if (baseUrl !== undefined) writeStorage(BASE_KEY, baseUrl);
}

export function signOut(): void {
  writeStorage(TOKEN_KEY, null);
  writeStorage(BASE_KEY, null);
}

/** The stored API base, so the door can show what is currently configured. */
export function readApiBase(): string | null {
  return readStorage(BASE_KEY);
}

export function defaultBase(): string {
  const origin = globalThis.location?.origin;
  return origin && !origin.startsWith("file:") ? origin : "https://api.bullmoose.cc";
}

/**
 * Drop `?token=` from the address bar without adding a history entry.
 *
 * `replaceState`, never `pushState`: pushing would create the very history
 * record we are deleting. Exported for the test, which drives the string
 * rewrite rather than trusting the call site.
 */
export function urlWithoutToken(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has(TOKEN_PARAM)) return null;
  url.searchParams.delete(TOKEN_PARAM);
  return url.toString();
}

function forgetTokenInUrl(): void {
  try {
    const href = globalThis.location?.href;
    const clean = href ? urlWithoutToken(href) : null;
    if (clean) globalThis.history?.replaceState(globalThis.history.state ?? null, "", clean);
  } catch {
    // A browser that refuses `replaceState` (sandboxed frame, opaque origin)
    // must not take the app down — but it also must not silently keep a
    // credential in the bar, so this is the one case where the URL survives.
  }
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage can throw in a locked-down browser context; resolving to
    // `unauthenticated` is a fine fallback, and crashing the shell over it is
    // not.
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
