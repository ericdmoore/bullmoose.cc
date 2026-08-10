// Choosing which `JmapClient` the app runs against.
//
// Invariant §6.1: no component imports a client — the shell resolves ONE here
// and injects it downward. This module is the only place in the app that
// decides between the real server and the in-memory demo.

import { FetchJmapClient, type JmapClient } from "../jmap/JmapClient";
import { createDemoBackend, type DemoBackend } from "../jmap/demo";

export type ClientMode = "live" | "demo";

export interface ResolvedClient {
  client: JmapClient;
  mode: ClientMode;
  /** Present in demo mode — lets the UI say so, and tests inspect the store. */
  demo?: DemoBackend;
  /** Human-readable reason the demo was chosen. */
  reason?: string;
}

const TOKEN_KEY = "bullmoose.token";
const BASE_KEY = "bullmoose.apiBase";

/**
 * Resolve a client from the environment.
 *
 * Live requires a bearer token. There is deliberately no anonymous live mode:
 * a mail client that renders a login-shaped shell against no session is how you
 * end up shipping a UI nobody has ever driven with real data.
 */
export function resolveClient(search = globalThis.location?.search ?? ""): ResolvedClient {
  const params = new URLSearchParams(search);

  if (params.get("demo") === "1") {
    const demo = createDemoBackend();
    return { client: demo.client, mode: "demo", demo, reason: "?demo=1" };
  }

  const token = params.get("token") ?? readStorage(TOKEN_KEY);
  const baseUrl = params.get("api") ?? readStorage(BASE_KEY) ?? defaultBase();

  if (!token) {
    const demo = createDemoBackend();
    return {
      client: demo.client,
      mode: "demo",
      demo,
      reason: "no session token — showing sample data",
    };
  }

  // Persist so a reload does not need the query string again.
  writeStorage(TOKEN_KEY, token);
  writeStorage(BASE_KEY, baseUrl);
  return { client: new FetchJmapClient({ baseUrl, token }), mode: "live" };
}

export function signOut(): void {
  writeStorage(TOKEN_KEY, null);
  writeStorage(BASE_KEY, null);
}

function defaultBase(): string {
  const origin = globalThis.location?.origin;
  return origin && !origin.startsWith("file:") ? origin : "https://api.bullmoose.cc";
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage can throw in a locked-down browser context; the demo path is a
    // fine fallback, and crashing the shell over it is not.
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
