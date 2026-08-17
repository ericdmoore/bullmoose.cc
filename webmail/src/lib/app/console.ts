// Choosing which console clients the screen runs against.
//
// Same shape as `client.ts` (invariant §6.1): no component imports a client, the
// shell resolves them here and injects them downward. This is the only place in
// the app that decides between the real agent worker and the in-memory demo.
//
// The vault origin is deliberately a SEPARATE setting from the JMAP API base.
// They are usually different workers, and conflating them is precisely the
// misconfiguration `origins.ts` refuses over: if the vault base silently
// defaulted to the page's own origin, "POST directly to the vault" would become
// "POST to the site backend" without anything changing colour.

import { HttpConsoleClient, type AgentConsoleClient } from "../console/ConsoleClient";
import { CredentialVault } from "../console/credentials";
import { createDemoConsole } from "../console/demoConsole";
import { normalizeOrigin, type ConsoleOrigins } from "../console/origins";

export type ConsoleMode = "live" | "demo";

export interface ResolvedConsole {
  reads: AgentConsoleClient;
  /** Absent in demo mode — there is nothing to mutate and nothing to protect. */
  vault?: CredentialVault;
  mode: ConsoleMode;
  origins: ConsoleOrigins;
  reason?: string;
}

const TOKEN_KEY = "bullmoose.token";
const VAULT_KEY = "bullmoose.vaultOrigin";

export function resolveConsole(search = globalThis.location?.search ?? ""): ResolvedConsole {
  const params = new URLSearchParams(search);
  const site = globalThis.location?.origin ?? "";

  const vaultOrigin = normalizeOrigin(params.get("vault")) ?? normalizeOrigin(readStorage(VAULT_KEY)) ?? "";
  const origins: ConsoleOrigins = { vault: vaultOrigin, site };

  if (params.get("demo") === "1") {
    return { reads: createDemoConsole(), mode: "demo", origins, reason: "?demo=1" };
  }

  const token = params.get("token") ?? readStorage(TOKEN_KEY);
  if (!token) {
    return {
      reads: createDemoConsole(),
      mode: "demo",
      origins,
      reason: "no session token — showing a sample deployment",
    };
  }
  if (vaultOrigin) writeStorage(VAULT_KEY, vaultOrigin);

  return {
    reads: new HttpConsoleClient({ origins, token }),
    vault: new CredentialVault({ origins, token }),
    mode: "live",
    origins,
  };
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
