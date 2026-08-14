// The console's read port.
//
// Same discipline as `lib/jmap/JmapClient.ts`: one module owns all protocol
// contact, it is injected rather than imported by components, and a fake
// implements the identical interface so every surface above it is testable in
// plain Node.
//
// ── Why this is not JMAP ────────────────────────────────────────────────────
//
// The console reads AUTHORIZATION STATE, and JMAP has no noun for it. The one
// agent-shaped method family the server exposes is `AgentInvocation/*`
// (`services/jmap/src/methods/agent.ts`) — recent actions, and nothing else.
// Grants, Bureau grants, bindings, `grant_audit` and the `last_writer_*` trio
// live in D1 behind two surfaces, neither reachable from a browser today:
//
//   • sVOL `015`'s MCP tools — `my_agents`, `who_can_access`, `access_log`,
//     `invocation_history` — answer these EXACT questions, but the endpoint that
//     carries them (`/mcp/analytics`) is gated on `x-internal-token`
//     (`services/agent/src/index.ts:32`), a worker-to-worker shared secret. A
//     browser cannot hold it and must not be handed it.
//   • `services/provision`'s `GET /grants` / `GET /agent-bindings` are gated on
//     one shared `ADMIN_TOKEN` and filter only on a caller-supplied `?email=`,
//     so anyone holding it reads every grant in the deployment. `015` refused to
//     proxy them for that reason and so does this.
//
// So the read interface below is what the console **requested**. That is the line
// `readme.md` draws — *"s03.E renders and requests; s04 decides and enforces"* —
// and the shapes are `015`'s own render output (see `types.ts`), so serving it is
// a projection of queries that already exist, not a new data model.
//
// It is now SERVED, by `services/jmap/src/console.ts` — same-origin with the app,
// because the worker that owns `/vault/credentials` has no public route and no
// CORS headers, so a browser cannot read anything there. `readBase` in
// `origins.ts` is what keeps the two apart: `/vault/*` to the vault, everything
// else to the site backend. The shapes below are unchanged; the client was the
// contract and the server was written to it.
//
// Where a route is absent or refused, `HttpConsoleClient` still fails with
// `ConsoleUnavailable` and the UI says which endpoint is missing. It does not
// fall back to sample data wearing a live label: a governance screen that invents
// its contents is worse than one that is honest about being empty.
//
// The credential surface is the exception — `GET /vault/credentials` is LIVE
// today (`services/agent/src/vault.ts:282`) and this client calls it for real.

import { readBase, resolveTarget, type ConsoleOrigins } from "./origins";
import type {
  AgentDossier,
  ConsoleCredential,
  ConsoleResource,
  ResourceDossier,
} from "./types";

/** One row in the agent picker. */
export interface AgentSummary {
  accountId: string;
  principalId: string;
  principal: string;
  displayName: string | null;
  bindingCount: number;
  enabledBindingCount: number;
}

export interface ResourceWindow {
  /** Point in time to reconstruct the authorization set AT (epoch ms). */
  at: number;
  /** How far back the who-did trail is read (epoch ms). */
  since: number;
}

export interface AgentConsoleClient {
  /** Agents (bindings + their principals) on accounts the operator owns. */
  listAgents(): Promise<AgentSummary[]>;
  /** Everything the per-agent view renders, in one payload. */
  agentDossier(accountId: string): Promise<AgentDossier>;
  /** Resources the forensic view can be pointed at. */
  listResources(accountId: string): Promise<ConsoleResource[]>;
  /** who-could + who-did for one resource, reconstructed at `window.at`. */
  resourceDossier(resource: ConsoleResource, window: ResourceWindow): Promise<ResourceDossier>;
  /** Credential REFERENCES — names, kinds, contract. Never a value. */
  listCredentials(): Promise<ConsoleCredential[]>;
}

/**
 * The read interface is not deployed (or refused). Carries the endpoint so the
 * UI can name it instead of showing a blank panel.
 */
export class ConsoleUnavailable extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    detail?: string,
  ) {
    super(
      `The console read interface is not available: ${endpoint} returned ${status}` +
        (detail ? ` — ${detail}` : ""),
    );
    this.name = "ConsoleUnavailable";
  }
}

export interface HttpConsoleClientOptions {
  origins: ConsoleOrigins;
  /** The operator's bearer. Same token the mail client holds. */
  token: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The read endpoints, in one table so the status doc and the error messages
 * cannot drift from the code. All five are live: the four `/console/*` on the
 * site backend (`services/jmap/src/console.ts`), `/vault/credentials` on the
 * agent worker.
 */
export const CONSOLE_ENDPOINTS = {
  agents: "/console/agents",
  dossier: "/console/agents/{accountId}",
  resources: "/console/accounts/{accountId}/resources",
  resourceDossier: "/console/resources/{collection}/{collectionId}",
  credentials: "/vault/credentials",
} as const;

export class HttpConsoleClient implements AgentConsoleClient {
  private readonly origins: ConsoleOrigins;
  private readonly token: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: HttpConsoleClientOptions) {
    this.origins = opts.origins;
    this.token = opts.token;
    this.doFetch = (opts.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /** Every read is `metadata` sensitivity — no read path carries a secret, and
   *  none can return one (bureau.md invariant 1). `readBase` picks WHICH origin
   *  answers: `/vault/*` is the agent worker's, `/console/*` the site backend's
   *  (which serves it same-origin — see `origins.ts`). */
  private async get<T>(path: string): Promise<T> {
    const url = resolveTarget(readBase(this.origins, path), path, "metadata");
    const res = await this.doFetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = ((await res.json()) as { error?: string }).error;
      } catch {
        /* non-JSON body — the status is the whole message */
      }
      throw new ConsoleUnavailable(path, res.status, detail);
    }
    return (await res.json()) as T;
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.get<{ agents: AgentSummary[] }>(CONSOLE_ENDPOINTS.agents).then((r) => r.agents);
  }

  agentDossier(accountId: string): Promise<AgentDossier> {
    return this.get<AgentDossier>(
      CONSOLE_ENDPOINTS.dossier.replace("{accountId}", encodeURIComponent(accountId)),
    );
  }

  listResources(accountId: string): Promise<ConsoleResource[]> {
    return this.get<{ resources: ConsoleResource[] }>(
      CONSOLE_ENDPOINTS.resources.replace("{accountId}", encodeURIComponent(accountId)),
    ).then((r) => r.resources);
  }

  resourceDossier(resource: ConsoleResource, window: ResourceWindow): Promise<ResourceDossier> {
    const path =
      CONSOLE_ENDPOINTS.resourceDossier
        .replace("{collection}", encodeURIComponent(resource.collection))
        .replace("{collectionId}", encodeURIComponent(resource.collectionId)) +
      `?at=${window.at}&since=${window.since}&accountId=${encodeURIComponent(resource.accountId)}`;
    return this.get<ResourceDossier>(path);
  }

  /** LIVE today. `credentialView` already returns exactly this shape. */
  async listCredentials(): Promise<ConsoleCredential[]> {
    const body = await this.get<{ credentials: ConsoleCredential[] }>(
      CONSOLE_ENDPOINTS.credentials,
    );
    return body.credentials;
  }
}

// ── the fake ────────────────────────────────────────────────────────────────

export interface FakeConsoleData {
  agents: AgentSummary[];
  dossiers: Record<string, AgentDossier>;
  resources: Record<string, ConsoleResource[]>;
  resourceDossiers: Record<string, ResourceDossier>;
  credentials: ConsoleCredential[];
}

/** Key a resource dossier the same way the fake and the tests both do. */
export const resourceKey = (r: Pick<ConsoleResource, "collection" | "collectionId">): string =>
  `${r.collection}:${r.collectionId}`;

/**
 * In-memory implementation of the same interface — tests, and the demo mode the
 * shell already has for mail. It applies the point-in-time window itself rather
 * than returning pre-filtered rows, so the reconstruction in `perResource.ts` is
 * exercised against real data movement (a grant revoked between two `at` values
 * must appear for one and not the other).
 */
export class FakeConsoleClient implements AgentConsoleClient {
  readonly calls: string[] = [];

  constructor(private readonly data: FakeConsoleData) {}

  async listAgents(): Promise<AgentSummary[]> {
    this.calls.push("listAgents");
    return this.data.agents;
  }

  async agentDossier(accountId: string): Promise<AgentDossier> {
    this.calls.push(`agentDossier:${accountId}`);
    const d = this.data.dossiers[accountId];
    if (!d) throw new ConsoleUnavailable(`/console/agents/${accountId}`, 404, "no such agent");
    return d;
  }

  async listResources(accountId: string): Promise<ConsoleResource[]> {
    this.calls.push(`listResources:${accountId}`);
    return this.data.resources[accountId] ?? [];
  }

  async resourceDossier(
    resource: ConsoleResource,
    window: ResourceWindow,
  ): Promise<ResourceDossier> {
    this.calls.push(`resourceDossier:${resourceKey(resource)}@${window.at}`);
    const d = this.data.resourceDossiers[resourceKey(resource)];
    if (!d) {
      throw new ConsoleUnavailable(
        `/console/resources/${resource.collection}/${resource.collectionId}`,
        404,
        "no such resource",
      );
    }
    // Only the audit trail is windowed on the wire; the grant set is returned
    // whole (tombstones included) because reconstructing it AT a time is the
    // console's job and must be testable.
    return { ...d, audit: d.audit.filter((a) => a.at >= window.since && a.at <= window.at) };
  }

  async listCredentials(): Promise<ConsoleCredential[]> {
    this.calls.push("listCredentials");
    return this.data.credentials;
  }
}
