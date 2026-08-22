import { describe, expect, it } from "vitest";
import { FakeConsoleClient, type FakeConsoleData } from "../console/ConsoleClient";
import type { AgentDossier } from "../console/types";
import { FakeJmapClient, type MethodHandler } from "../jmap/FakeJmapClient";
import type { JmapClient } from "../jmap/JmapClient";
import { ANNOTATION_STATUSES, loadProduced, loadReceipt } from "./api";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const ERIC = "acct-eric";
const EMILY = "acct-emily";

function dossier(accountId: string, principal: string): AgentDossier {
  return {
    accountId,
    principalId: `p-${accountId}`,
    principal,
    tokenScopes: ["read"],
    bindings: [
      {
        bindingId: "ab_extract",
        name: "extractor",
        triggerOn: "delivered",
        slaSeconds: null,
        enabled: true,
        config: { pipeline: "extract", replyMode: null },
        economics: { budgetMicros: 1_000_000, defaultModel: null, modelMenu: [], exploreRate: null },
      },
    ],
    credentials: [],
    bureauGrants: [],
    grantsHeld: [],
    grantsGiven: [],
    invocations: [],
    spend: null,
    ledgers: [],
    ledgerMonthStart: NOW,
  };
}

function consoleData(over: Partial<FakeConsoleData> = {}): FakeConsoleData {
  return {
    agents: [
      {
        accountId: ERIC,
        principalId: "p-eric",
        principal: "eric@bullmoose.test",
        displayName: null,
        bindingCount: 1,
        enabledBindingCount: 1,
      },
    ],
    dossiers: { [ERIC]: dossier(ERIC, "eric@bullmoose.test") },
    resources: {},
    resourceDossiers: {},
    credentials: [],
    ...over,
  };
}

/** A server that answers every read this module makes, per account. */
function server(opts: { refuse?: Set<string> } = {}): FakeJmapClient {
  const refuse = opts.refuse ?? new Set<string>();
  const proposalRow = (accountId: string) => ({
    id: `ap-${accountId}`,
    accountId,
    agent: "extractor",
    kind: "verb-schedule",
    tier: 1,
    subject: { realm: "Email", objectId: "e1" },
    payload: {},
    rationale: "why",
    evidence: [],
    status: "pending",
    createdAt: new Date(NOW).toISOString(),
    invocationStatus: "done",
  });
  const annotationRow = (accountId: string, status: string) => ({
    id: `an-${accountId}-${status}`,
    accountId,
    authorKind: "agent",
    author: "extractor",
    anchor: { realm: "Email", objectId: "e1" },
    class: "event",
    body: "tournament Saturday",
    confidence: 0.9,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const handlers: Record<string, MethodHandler> = {
    "ActionProposal/query": (args) => {
      const accountId = String(args.accountId);
      if (refuse.has(`p:${accountId}`)) return ["error", { type: "forbidden", description: "no read here" }];
      return { accountId, queryState: "1", ids: [`ap-${accountId}`] };
    },
    "ActionProposal/get": (args) => ({
      accountId: args.accountId,
      state: "1",
      list: (args.ids as string[]).map(() => proposalRow(String(args.accountId))),
      notFound: [],
    }),
    "Annotation/query": (args) => {
      const accountId = String(args.accountId);
      const status = String((args.filter as { status?: unknown } | undefined)?.status ?? "open");
      if (refuse.has(`a:${accountId}:${status}`)) {
        return ["error", { type: "forbidden", description: `no ${status} annotations` }];
      }
      return { accountId, queryState: "1", ids: [`an-${accountId}-${status}`] };
    },
    "Annotation/get": (args) => {
      const accountId = String(args.accountId);
      const ids = args.ids as string[];
      return {
        accountId,
        state: "1",
        list: ids.map((id) => annotationRow(accountId, id.slice(id.lastIndexOf("-") + 1))),
        notFound: [],
      };
    },
  };
  return new FakeJmapClient({ handlers });
}

describe("loadProduced — one POST, every account, every annotation status", () => {
  it("asks for EVERY annotation status by name — the default view would hide the dismissals", () => {
    // `Annotation/query` defaults to `open`. The dismissals are the labelled
    // negatives ("Not a real one"), i.e. the evidence about extraction quality,
    // so a receipt that took the default would be measuring only its successes.
    expect([...ANNOTATION_STATUSES]).toEqual(["open", "resolved", "dismissed"]);
  });

  it("batches 2 proposal calls + 2 per annotation status, per account, in ONE request", async () => {
    const client = server();
    await loadProduced(client, [ERIC, EMILY]);
    expect(client.sentBatches).toHaveLength(1);
    expect(client.sentBatches[0]).toHaveLength(2 * (2 + 2 * ANNOTATION_STATUSES.length));
  });

  it("returns the parsed rows for every account", async () => {
    const res = await loadProduced(server(), [ERIC, EMILY]);
    expect(res.proposals.map((p) => p.accountId).sort()).toEqual([EMILY, ERIC]);
    expect(res.annotations).toHaveLength(2 * ANNOTATION_STATUSES.length);
    expect(res.producedFailures).toEqual({});
  });

  it("keeps a refused account's failure VISIBLE and still serves the others", async () => {
    const res = await loadProduced(server({ refuse: new Set([`p:${EMILY}`]) }), [ERIC, EMILY]);
    expect(res.proposals.map((p) => p.accountId)).toEqual([ERIC]);
    expect(res.producedFailures[EMILY]).toContain("proposals: no read here");
    expect(res.producedFailures[ERIC]).toBeUndefined();
  });

  it("names WHICH annotation status was refused, and keeps the statuses that worked", async () => {
    const res = await loadProduced(server({ refuse: new Set([`a:${ERIC}:dismissed`]) }), [ERIC]);
    expect(res.producedFailures[ERIC]).toContain("dismissed annotations");
    expect(res.annotations.map((a) => a.status).sort()).toEqual(["open", "resolved"]);
  });

  it("prefers the QUERY's refusal over the GET's back-reference error", async () => {
    // `unsupportedFilter` upstream of an `invalidResultReference` is the shape
    // that misleads: the second error is real but says nothing useful.
    const res = await loadProduced(server({ refuse: new Set([`p:${ERIC}`]) }), [ERIC]);
    expect(res.producedFailures[ERIC]).toContain("no read here");
    expect(res.producedFailures[ERIC]).not.toContain("invalidResultReference");
  });

  it("marks EVERY account failed when the batch itself does not land", async () => {
    // Not an empty result: N bindings rendering "produced nothing" would be a
    // fabricated measurement, which is the one thing this page may not do.
    const dead = {
      request: () => Promise.reject(new Error("network down")),
    } as unknown as JmapClient;
    const res = await loadProduced(dead, [ERIC, EMILY]);
    expect(res.proposals).toEqual([]);
    expect(res.producedFailures[ERIC]).toContain("network down");
    expect(res.producedFailures[EMILY]).toContain("network down");
  });

  it("reads nothing at all for an empty roster", async () => {
    const client = server();
    const res = await loadProduced(client, []);
    expect(client.sentBatches).toHaveLength(0);
    expect(res).toEqual({ proposals: [], annotations: [], producedFailures: {} });
  });
});

describe("loadReceipt — both doors", () => {
  it("reads one dossier per agent account and the produced work for the ones that loaded", async () => {
    const res = await loadReceipt(server(), new FakeConsoleClient(consoleData()));
    expect(res.dossiers.map((d) => d.accountId)).toEqual([ERIC]);
    expect(res.dossierFailures).toEqual({});
    expect(res.proposals).toHaveLength(1);
  });

  it("keeps a refused dossier visible and serves the rest", async () => {
    const data = consoleData({
      agents: [
        ...consoleData().agents,
        {
          accountId: EMILY,
          principalId: "p-emily",
          principal: "emily@bullmoose.test",
          displayName: null,
          bindingCount: 1,
          enabledBindingCount: 1,
        },
      ],
    });
    const res = await loadReceipt(server(), new FakeConsoleClient(data));
    expect(res.dossiers.map((d) => d.accountId)).toEqual([ERIC]);
    expect(res.dossierFailures[EMILY]).toContain("no such agent");
    // The JMAP half is asked ONLY about accounts whose dossier loaded — there
    // are no bindings to attribute the rest to.
    expect(res.proposals.map((p) => p.accountId)).toEqual([ERIC]);
  });

  it("throws when NO dossier could be read — there is nothing honest to render", async () => {
    const data = consoleData({ dossiers: {} });
    await expect(loadReceipt(server(), new FakeConsoleClient(data))).rejects.toThrow(/no such agent/);
  });

  it("returns empty — not an error — when the operator owns no agents at all", async () => {
    const client = server();
    const res = await loadReceipt(client, new FakeConsoleClient(consoleData({ agents: [], dossiers: {} })));
    expect(res.dossiers).toEqual([]);
    expect(res.annotations).toEqual([]);
    // And it does not go on to POST an empty batch.
    expect(client.sentBatches).toHaveLength(0);
  });
});
