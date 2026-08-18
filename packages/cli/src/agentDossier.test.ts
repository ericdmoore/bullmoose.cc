import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  budgetView,
  cmdAgentDossier,
  doorsFor,
  effectiveFloor,
  findBinding,
  ledgerFor,
  parseCandidate,
  parseMicros,
  parseSince,
  usd,
  type Dossier,
  type DossierBinding,
  type DossierOpts,
} from "./agentDossier.js";
import { openDb, setConfig } from "./db.js";

/**
 * s26 T6b — the dossier verbs, driven end to end against fakes.
 *
 * Everything effectful is injected (`DossierDeps`: fetch, the JMAP seam, the
 * clock), so all six verbs run here with no network — including the three that
 * write. What is deliberately NOT here: the `--json` refusal paths, which end in
 * `exitFlushed` and therefore in a real `process.exit`. A process cannot observe
 * its own exit code (the whole argument of `contract.test.ts`), so those live in
 * `smoke/contract.mjs`, where a real binary is driven through a real shell.
 *
 * The properties these tests exist to pin, in order of what would hurt most:
 *
 *   1. an unreachable door NEVER reports success — it refuses, names the call
 *      that would work, and issues no request at all;
 *   2. the re-provision is a READ-MODIFY-WRITE — setting a budget cannot reset
 *      the model menu, and setting a model cannot reset the budget;
 *   3. the kill switch outranks a tuning knob — the door's `enabled = 1` side
 *      effect is refused, not absorbed;
 *   4. a server refusal is printed VERBATIM, never re-worded into a guess.
 */

const ACCOUNT = "t_home__a_you";
const ADDRESS = "you@bullmoose.cc";
const BASE = "http://server.test";
const ADMIN = "http://provision.test";

const IO: DossierOpts = { json: false, ids: false, dryRun: false };

// ---- fixtures --------------------------------------------------------------

const extractor: DossierBinding = {
  bindingId: "bind_extract1",
  name: "extractor",
  triggerOn: "mailbox-delivery",
  slaSeconds: null,
  enabled: true,
  config: { pipeline: "extract", replyMode: "draft", hasPersona: false, modelAliasCount: 1 },
  economics: {
    budgetMicros: 2_000_000,
    defaultModel: "extract",
    modelMenu: [{ alias: "extract", candidates: ["openrouter/minimax/minimax-m3", "openrouter/qwen/qwen3-30b"] }],
    exploreRate: 0.2,
  },
};

const emily: DossierBinding = {
  bindingId: "bind_emily1",
  name: "emily",
  triggerOn: "mailbox-delivery",
  slaSeconds: 3600,
  enabled: true,
  config: { pipeline: "reply", replyMode: "draft", hasPersona: true },
  economics: { budgetMicros: null, defaultModel: null, modelMenu: [], exploreRate: null },
};

function dossierFixture(over: Partial<Dossier> = {}): Dossier {
  return {
    accountId: ACCOUNT,
    principalId: "p_you",
    principal: ADDRESS,
    tokenScopes: ["mail", "vault"],
    bindings: [extractor, emily],
    invocations: [
      {
        invocationId: "inv_1",
        bindingId: extractor.bindingId,
        bindingName: "extractor",
        status: "done",
        emailId: "em_1",
        note: null,
        createdAt: 1_760_000_000_000,
        doneAt: 1_760_000_001_000,
        costMicros: 2100,
        model: "openrouter/minimax/minimax-m3",
      },
      {
        invocationId: "inv_2",
        bindingId: extractor.bindingId,
        bindingName: "extractor",
        status: "done",
        emailId: "em_2",
        note: null,
        createdAt: 1_759_000_000_000,
        doneAt: 1_759_000_001_000,
        // NULL is not zero: "cost undetermined", and it must never render $0.00.
        costMicros: null,
        model: null,
      },
      {
        invocationId: "inv_9",
        bindingId: emily.bindingId,
        bindingName: "emily",
        status: "pending",
        emailId: "em_9",
        note: null,
        createdAt: 1_760_500_000_000,
        doneAt: null,
        costMicros: null,
        model: null,
      },
    ],
    ledgers: [
      {
        bindingId: extractor.bindingId,
        pending: 3,
        running: 0,
        done: 128,
        failed: 1,
        oldestPendingAt: 1_760_100_000_000,
        monthSpendMicros: 410_000,
        monthOverageMicros: 100_000,
      },
    ],
    ledgerMonthStart: 1_754_006_400_000,
    ...over,
  };
}

/** The config_json the operator plane serves for `extractor`. */
const EXTRACTOR_CONFIG = {
  pipeline: "extract",
  modelAliases: {
    extract: [
      { provider: "openrouter", model: "minimax/minimax-m3" },
      { provider: "openrouter", model: "qwen/qwen3-30b" },
    ],
  },
  defaultModel: "extract",
  frontier: { exploreRate: 0.2 },
  budgets: { spendPerMonth: 2_000_000 },
  maxTokens: 900,
  createdAt: 1_750_000_000_000,
};

interface NetOptions {
  dossier?: Dossier;
  dossierStatus?: number;
  config?: Record<string, unknown>;
  /** Status + body for POST /extractor. */
  extractor?: { status: number; body?: Record<string, unknown> };
  backfill?: { status: number; body?: Record<string, unknown> };
  floorRequest?: { status: number; body?: Record<string, unknown> };
}

interface Seen {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function fakeNet(opts: NetOptions = {}) {
  const seen: Seen[] = [];
  const reply = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }) as Response;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
    seen.push({ method, url, body });

    if (url.startsWith(`${BASE}/console/agents/`)) {
      const status = opts.dossierStatus ?? 200;
      return reply(status, status === 200 ? (opts.dossier ?? dossierFixture()) : { error: "not found" });
    }
    if (url.startsWith(`${ADMIN}/agent-bindings?email=`)) {
      return reply(200, {
        bindings: [
          {
            id: extractor.bindingId,
            account_id: ACCOUNT,
            name: "extractor",
            enabled: 1,
            config_json: JSON.stringify(opts.config ?? EXTRACTOR_CONFIG),
          },
        ],
      });
    }
    if (url === `${ADMIN}/extractor`) {
      const e = opts.extractor ?? { status: 200 };
      return reply(e.status, e.body ?? { ok: true, updated: true, bindingId: extractor.bindingId });
    }
    if (url.endsWith("/backfill")) {
      const b = opts.backfill ?? { status: 200 };
      return reply(
        b.status,
        b.body ?? {
          ok: true,
          minted: 12,
          skipped: 3,
          floorClamped: false,
          windowStartMs: 1_757_000_000_000,
          windowEndMs: 1_760_000_000_000,
          floorMs: 1_750_000_000_000,
          floorSource: "createdAt",
          capped: false,
          budgetMicros: null,
          note: "minted rows are NULL-due (sit-free)",
        },
      );
    }
    if (url.endsWith("/floor-request")) {
      const f = opts.floorRequest ?? { status: 200 };
      return reply(f.status, f.body ?? { ok: true, proposalId: "inv_floor1", minted: true, tier: 1 });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, seen, writes: () => seen.filter((s) => s.method !== "GET") };
}

/** A JMAP seam recording every call; `AgentBinding/set` answers per `outcome`. */
function fakeJmap(outcome: "updated" | "notUpdated" | "forbidden" = "updated") {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    jmap: {
      async one(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        calls.push({ name, args });
        const id = Object.keys((args.update ?? {}) as Record<string, unknown>)[0]!;
        const patch = ((args.update ?? {}) as Record<string, { enabled: boolean }>)[id]!;
        if (outcome === "forbidden") {
          const err = new Error("AgentBinding/set → forbidden: the binding kill switch is a human control") as Error & {
            jmapType: string;
          };
          err.jmapType = "forbidden";
          throw err;
        }
        if (outcome === "notUpdated") {
          return {
            accountId: ACCOUNT,
            updated: {},
            notUpdated: {
              [id]: {
                type: "stateMismatch",
                description: "the binding's enabled state moved under this call — re-read and decide again",
              },
            },
          };
        }
        return { accountId: ACCOUNT, updated: { [id]: { enabled: patch.enabled } }, notUpdated: {} };
      },
    },
  };
}

function freshDb(withAdmin = false) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "bm-dossier-")), "mail.db"));
  setConfig(db, "base", BASE);
  setConfig(db, "token", "bm_session");
  setConfig(db, "accountId", ACCOUNT);
  setConfig(db, "accounts", JSON.stringify([{ accountId: ACCOUNT, address: ADDRESS, name: "You" }]));
  if (withAdmin) {
    setConfig(db, "adminUrl", ADMIN);
    setConfig(db, "adminToken", "admin_secret");
  }
  return db;
}

// ---- stream capture --------------------------------------------------------

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const outText = () => stdout.join("");
const errText = () => stderr.join("");
const onlyJson = () => JSON.parse(outText().trim()) as Record<string, unknown>;

// ---- pure helpers ----------------------------------------------------------

describe("the money is never flattered", () => {
  it("renders sub-cent costs at six places and null as an em dash, never $0.00", () => {
    expect(usd(2100)).toBe("$0.002100");
    expect(usd(2_000_000)).toBe("$2.00");
    expect(usd(0)).toBe("$0.00");
    expect(usd(null)).toBe("—");
  });

  it("remaining = cap + approved overage − spent, and stays NULL when there is no cap", () => {
    const d = dossierFixture();
    const view = budgetView(extractor, ledgerFor(d, extractor.bindingId), d.ledgerMonthStart);
    expect(view.remainingMicros).toBe(2_000_000 + 100_000 - 410_000);
    const noCap = budgetView(emily, ledgerFor(d, emily.bindingId), d.ledgerMonthStart);
    // "unbounded" and "nothing left" must never render the same.
    expect(noCap.remainingMicros).toBeNull();
    expect(noCap.spentMicros).toBe(0);
  });

  it("a binding with no ledger row reads all-zero, not unknown", () => {
    const led = ledgerFor(dossierFixture(), emily.bindingId);
    expect([led.pending, led.done, led.monthSpendMicros]).toEqual([0, 0, 0]);
  });
});

describe("the history floor mirrors provision's rule", () => {
  it("an approved historyFloor outranks createdAt; neither is UNKNOWN, not unbounded", () => {
    expect(effectiveFloor({ historyFloor: 10, createdAt: 20 })).toEqual({ floorMs: 10, source: "historyFloor" });
    expect(effectiveFloor({ createdAt: 20 })).toEqual({ floorMs: 20, source: "createdAt" });
    expect(effectiveFloor({})).toEqual({ floorMs: null, source: null });
  });
});

describe("argument parsing refuses guesses", () => {
  it("--since takes a date, an ISO instant or Nd — and never defaults", () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    expect(parseSince("30d", now).startMs).toBe(now - 30 * 86_400_000);
    expect(parseSince("2026-06-01", now).startMs).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(() => parseSince("last summer", now)).toThrow(/YYYY-MM-DD/);
    expect(() => parseSince("2027-01-01", now)).toThrow(/not in the past/);
  });

  it("--set/--budget take micro-USD only: '2' is never silently two dollars", () => {
    expect(parseMicros("2000000", "--set")).toBe(2_000_000);
    expect(() => parseMicros("2.00", "--set")).toThrow(/micro-USD/);
    expect(() => parseMicros("$2", "--set")).toThrow(/micro-USD/);
  });

  it("a candidate splits at the FIRST slash, so vendor-qualified model ids survive", () => {
    expect(parseCandidate("openrouter/minimax/minimax-m3", "--set")).toEqual({
      provider: "openrouter",
      model: "minimax/minimax-m3",
    });
    expect(() => parseCandidate("minimax-m3", "--set")).toThrow(/<host>\/<model>/);
  });
});

describe("binding resolution is the cli/009 rule in another noun", () => {
  it("resolves by id, then by name, case-insensitively", () => {
    const d = dossierFixture();
    expect(findBinding(d, "bind_emily1").name).toBe("emily");
    expect(findBinding(d, "extractor").bindingId).toBe(extractor.bindingId);
    expect(findBinding(d, "EXTRACTOR").bindingId).toBe(extractor.bindingId);
  });

  it("an unknown binding is exit 3 and lists what the account DOES carry", () => {
    let caught: unknown;
    try {
      findBinding(dossierFixture(), "allen");
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(3);
    expect((caught as Error).message).toContain("extractor");
    expect((caught as Error).message).toContain("--account");
  });

  it("a duplicated name is an error, never a pick by enumeration order", () => {
    const twin = { ...emily, bindingId: "bind_emily2" };
    const d = dossierFixture({ bindings: [emily, twin] });
    expect(() => findBinding(d, "emily")).toThrow(/matches 2 bindings/);
  });
});

describe("the doors table tells the truth about which plane a verb is on", () => {
  it("reads and the kill switch are session; budget/model/backfill are operator", () => {
    const doors = doorsFor(extractor, true);
    expect(doors.show!.plane).toBe("session");
    expect(doors.disable!.plane).toBe("session");
    expect(doors.disable!.requires).toContain("send");
    expect(doors.budget!.plane).toBe("operator");
    expect(doors.backfill!.plane).toBe("operator");
    expect(doors.budget!.unavailable).toBeUndefined();
  });

  it("a non-extractor binding has NO config door at all, and the message names why", () => {
    const doors = doorsFor(emily, true);
    expect(doors.budget!.unavailable).toContain("AgentBinding/set v1 writes only");
    expect(doors.model!.unavailable).toContain("PATCH /agent-bindings refuses config_json");
    // The kill switch still works on it — that is the whole point of #198.
    expect(doors.disable!.unavailable).toBeUndefined();
  });

  it("without provision credentials the operator doors read unconfigured", () => {
    expect(doorsFor(extractor, false).budget!.configured).toBe(false);
    expect(doorsFor(extractor, false).show!.configured).toBe(true);
  });
});

// ---- agent show ------------------------------------------------------------

describe("agent show", () => {
  it("--json is ONE object carrying the whole dossier, with _self and _links", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    await cmdAgentDossier(db, ["show", "extractor"], { ...IO, json: true }, { fetchImpl });
    const view = onlyJson();
    expect(outText().trim().split("\n")).toHaveLength(1); // §1.3: one value, not a stream
    expect(view._self).toBe(`${BASE}/console/agents/${ACCOUNT}`);
    const links = view._links as Record<string, { href: string }>;
    expect(links.account!.href).toBe(view._self);
    expect(links.agents!.href).toBe(`${BASE}/console/agents`);
    // Derived from ids the payload carries, never invented: no operator plane
    // is configured, so there is no lifecycle href to follow.
    expect(links.lifecycle).toBeUndefined();

    expect((view.binding as Record<string, unknown>).pipeline).toBe("extract");
    expect((view.models as Record<string, unknown>).exploreRate).toBe(0.2);
    expect((view.budget as Record<string, unknown>).remainingMicros).toBe(1_690_000);
    expect((view.ledger as Record<string, unknown>).pending).toBe(3);
    // Invocations are this binding's only — emily's pending row is not ours.
    expect((view.invocations as Array<{ invocationId: string }>).map((i) => i.invocationId)).toEqual([
      "inv_1",
      "inv_2",
    ]);
  });

  it("names the floor as unreachable-and-why when no operator credential is held", async () => {
    const db = freshDb();
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["show", "extractor"], { ...IO, json: true }, { fetchImpl });
    const backfill = onlyJson().backfill as { floorMs: number | null; note: string };
    expect(backfill.floorMs).toBeNull();
    expect(backfill.note).toContain("admin init");
    expect(seen).toHaveLength(1); // the console read, and nothing else
  });

  it("reads the floor from the operator plane when one IS configured, and links the chain", async () => {
    const db = freshDb(true);
    const { fetchImpl } = fakeNet();
    await cmdAgentDossier(db, ["show", "extractor"], { ...IO, json: true }, { fetchImpl });
    const view = onlyJson();
    expect((view.backfill as { floorMs: number }).floorMs).toBe(1_750_000_000_000);
    expect((view.backfill as { floorSource: string }).floorSource).toBe("createdAt");
    expect((view._links as Record<string, { href: string }>).lifecycle!.href).toBe(
      `${ADMIN}/agent-bindings/${extractor.bindingId}/lifecycle`,
    );
  });

  it("text mode puts the dossier on stdout and the caveat on stderr (§1.1)", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    await cmdAgentDossier(db, ["show", "extractor"], { ...IO }, { fetchImpl });
    expect(outText()).toContain("extractor");
    expect(outText()).toContain("$2.00/month");
    expect(outText()).toContain("not recorded"); // the NULL-cost invocation
    expect(outText()).not.toContain("$0.00\n"); // and never a flattering zero for it
    expect(errText()).toContain("does not separate them");
  });

  it("--ids is the bare binding id and nothing else (§1.8)", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    await cmdAgentDossier(db, ["show", "extractor"], { ...IO, ids: true }, { fetchImpl });
    expect(outText()).toBe(`${extractor.bindingId}\n`);
  });

  it("a console refusal keeps its own sentence and its own exit code", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({ dossierStatus: 403 });
    await expect(cmdAgentDossier(db, ["show", "extractor"], { ...IO }, { fetchImpl })).rejects.toThrow(/HTTP 403/);
  });
});

// ---- agent budget ----------------------------------------------------------

describe("agent budget", () => {
  it("reads the envelope with no operator credential at all", async () => {
    const db = freshDb();
    const { fetchImpl, writes } = fakeNet();
    await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, json: true }, { fetchImpl });
    const view = onlyJson();
    expect(view.capMicros).toBe(2_000_000);
    expect(view.spentMicros).toBe(410_000);
    expect(view.remainingMicros).toBe(1_690_000);
    expect(writes()).toEqual([]);
  });

  it("--set without provision credentials refuses with exit 4, names the fix, and writes NOTHING", async () => {
    const db = freshDb();
    const { fetchImpl, writes } = fakeNet();
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, set: "5000000" }, { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(4);
    expect((caught as Error).message).toContain("bullmoose admin init");
    expect((caught as Error).message).toContain("Nothing was written");
    expect(writes()).toEqual([]);
  });

  it("--set on a binding with no config door refuses by NAME, before any request", async () => {
    const db = freshDb(true);
    const { fetchImpl, writes } = fakeNet();
    await expect(cmdAgentDossier(db, ["budget", "emily"], { ...IO, set: "5000000" }, { fetchImpl })).rejects.toThrow(
      /POST \/extractor provisions the "extractor" binding only/,
    );
    expect(writes()).toEqual([]);
  });

  it("--set is a READ-MODIFY-WRITE: the model menu, arms, rate and maxTokens all survive", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, set: "5000000" }, { fetchImpl });
    const post = seen.find((s) => s.url === `${ADMIN}/extractor`)!;
    expect(post.body).toEqual({
      email: ADDRESS,
      provider: "openrouter",
      model: "minimax/minimax-m3",
      budgetMicros: 5_000_000,
      exploreModels: [{ provider: "openrouter", model: "qwen/qwen3-30b" }],
      exploreRate: 0.2,
      maxTokens: 900,
    });
    expect(outText()).toContain("$5.00/month");
  });

  it("--dry-run prints the exact request and issues no POST", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, set: "5000000", dryRun: true }, { fetchImpl });
    expect(seen.some((s) => s.method === "POST")).toBe(false);
    expect(errText()).toContain("nothing was written");
    expect(outText()).toContain('"budgetMicros":5000000');
  });
});

// ---- agent model -----------------------------------------------------------

describe("agent model", () => {
  it("reads the menu, marking the default alias and the explore arms", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    await cmdAgentDossier(db, ["model", "extractor"], { ...IO, json: true }, { fetchImpl });
    const view = onlyJson();
    expect(view.defaultModel).toBe("extract");
    expect((view.menu as Array<{ candidates: string[] }>)[0]!.candidates[0]).toBe("openrouter/minimax/minimax-m3");
  });

  it("--set swaps the primary and preserves the BUDGET — the clobber this door invites", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["model", "extractor"], { ...IO, set: "workers-ai/@cf/llama-3.1-8b" }, { fetchImpl });
    const post = seen.find((s) => s.url === `${ADMIN}/extractor`)!;
    expect(post.body!.provider).toBe("workers-ai");
    expect(post.body!.model).toBe("@cf/llama-3.1-8b");
    // Not the server's $2.00 default: the value the binding already had.
    expect(post.body!.budgetMicros).toBe(2_000_000);
    expect(post.body!.exploreModels).toEqual([{ provider: "openrouter", model: "qwen/qwen3-30b" }]);
  });

  it("--explore REPLACES the arms rather than appending — what it prints is what it wrote", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(
      db,
      ["model", "extractor"],
      { ...IO, explore: ["openrouter/deepseek/deepseek-v3"] },
      { fetchImpl },
    );
    const post = seen.find((s) => s.url === `${ADMIN}/extractor`)!;
    expect(post.body!.exploreModels).toEqual([{ provider: "openrouter", model: "deepseek/deepseek-v3" }]);
    expect(post.body!.model).toBe("minimax/minimax-m3"); // primary untouched
  });

  it("refuses rather than letting the server pick a paid default for a menu-less binding", async () => {
    const db = freshDb(true);
    const { fetchImpl, writes } = fakeNet({ config: { pipeline: "extract", budgets: { spendPerMonth: 1 } } });
    await expect(
      cmdAgentDossier(db, ["model", "extractor"], { ...IO, explore: ["openrouter/x/y"] }, { fetchImpl }),
    ).rejects.toThrow(/spend decision this command will not make for you/);
    expect(writes()).toEqual([]);
  });

  it("refuses rather than stamping the server's $2.00 default on a budget-less binding", async () => {
    const db = freshDb(true);
    const { fetchImpl, writes } = fakeNet({
      config: {
        pipeline: "extract",
        defaultModel: "extract",
        modelAliases: { extract: [{ provider: "a", model: "b" }] },
      },
    });
    await expect(cmdAgentDossier(db, ["model", "extractor"], { ...IO, set: "a/b2" }, { fetchImpl })).rejects.toThrow(
      /agent budget extractor --set/,
    );
    expect(writes()).toEqual([]);
  });
});

// ---- the kill-switch interaction -------------------------------------------

describe("a re-provision may not quietly un-pull the kill switch", () => {
  const disabled = { ...extractor, enabled: false };

  it("refuses with exit 5 on a DISABLED binding and writes nothing", async () => {
    const db = freshDb(true);
    const { fetchImpl, writes } = fakeNet({ dossier: dossierFixture({ bindings: [disabled, emily] }) });
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, set: "1" }, { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(5);
    expect((caught as Error).message).toContain("re-enables a binding");
    expect(writes()).toEqual([]);
  });

  it("--yes accepts the re-enable, proceeds, and SAYS it happened", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet({ dossier: dossierFixture({ bindings: [disabled, emily] }) });
    await cmdAgentDossier(db, ["budget", "extractor"], { ...IO, set: "1000000", yes: true }, { fetchImpl });
    expect(seen.some((s) => s.url === `${ADMIN}/extractor`)).toBe(true);
    expect(errText()).toContain("is now ENABLED again");
  });
});

// ---- agent backfill --------------------------------------------------------

describe("agent backfill", () => {
  const NOW = Date.parse("2026-08-18T00:00:00Z");
  const now = () => NOW;

  it("refuses without --since: the window is not a default this CLI will pick", async () => {
    const db = freshDb(true);
    const { fetchImpl, writes } = fakeNet();
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO }, { fetchImpl, now });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(2);
    expect((caught as Error).message).toContain("--since is required");
    expect(writes()).toEqual([]);
  });

  it("mints over the window and reports the floor, the clamp and the envelope", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO, since: "30d", budget: "500000" }, { fetchImpl, now });
    const post = seen.find((s) => s.url.endsWith("/backfill"))!;
    expect(post.body!.sinceDays).toBe(30);
    expect(post.body!.budgetMicros).toBe(500_000);
    expect(outText()).toContain("minted 12 invocation(s)");
    expect(outText()).toContain("createdAt");
  });

  it("without --budget it says out loud that the rows draw on the MONTHLY budget", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO, since: "7d" }, { fetchImpl, now });
    expect(seen.find((s) => s.url.endsWith("/backfill"))!.body!.budgetMicros).toBeUndefined();
    expect(errText()).toContain("MONTHLY budget");
  });

  it("a window behind the floor exits 5 with the server's OWN sentence, and nothing is queued", async () => {
    const db = freshDb(true);
    const { fetchImpl } = fakeNet({
      backfill: {
        status: 409,
        body: {
          error:
            "sinceDays=1000 reaches back to 2023-11-22T00:00:00.000Z, behind this binding's history floor " +
            "(2025-06-15T14:13:20.000Z, from createdAt). Moving the floor back is an approval, not a parameter",
          floorMs: 1_750_000_000_000,
          floorSource: "createdAt",
          requestedStartMs: 1_700_000_000_000,
        },
      },
    });
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO, since: "1000d" }, { fetchImpl, now });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(5);
    // Verbatim, not re-worded into "forbidden".
    expect((caught as Error).message).toContain("Moving the floor back is an approval, not a parameter");
    expect((caught as Error).message).toContain("Nothing was queued");
    expect((caught as Error).message).toContain("--request-floor");
  });

  it("--request-floor mints the APPROVAL and queues no work", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(
      db,
      ["backfill", "extractor"],
      { ...IO, since: "2023-01-01", requestFloor: true },
      { fetchImpl, now },
    );
    expect(seen.some((s) => s.url.endsWith("/backfill"))).toBe(false);
    const ask = seen.find((s) => s.url.endsWith("/floor-request"))!;
    expect(ask.body!.toEpochMs).toBe(Date.parse("2023-01-01T00:00:00Z"));
    expect(outText()).toContain("floor-request inv_floor1");
    expect(errText()).toContain("no backfill ran");
  });

  it("--dry-run queues nothing and shows the request that would go out", async () => {
    const db = freshDb(true);
    const { fetchImpl, seen } = fakeNet();
    await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO, since: "30d", dryRun: true }, { fetchImpl, now });
    expect(seen.some((s) => s.method === "POST")).toBe(false);
    expect(errText()).toContain("nothing was queued");
  });

  it("with no provision credential it refuses at exit 4 without touching the network", async () => {
    const db = freshDb();
    const { fetchImpl, writes } = fakeNet();
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["backfill", "extractor"], { ...IO, since: "30d" }, { fetchImpl, now });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(4);
    expect((caught as Error).message).toContain("Nothing was queued");
    expect(writes()).toEqual([]);
  });
});

// ---- agent enable / disable ------------------------------------------------

describe("agent enable|disable — the one mutation a session token can make", () => {
  it("drives AgentBinding/set with the resolved id on the resolved account", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap, calls } = fakeJmap();
    await cmdAgentDossier(db, ["disable", "extractor"], { ...IO, json: true }, { fetchImpl, jmap });
    expect(calls).toEqual([
      {
        name: "AgentBinding/set",
        args: { accountId: ACCOUNT, update: { [extractor.bindingId]: { enabled: false } } },
      },
    ]);
    const view = onlyJson();
    expect(view.enabled).toBe(false);
    expect(view.wasEnabled).toBe(true);
  });

  it("says HELD, not cancelled — the sentence a human needs after pulling a switch", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap } = fakeJmap();
    await cmdAgentDossier(db, ["disable", "extractor"], { ...IO }, { fetchImpl, jmap });
    expect(outText()).toContain("is now DISABLED");
    expect(errText()).toContain("HELD, not cancelled");
  });

  it("a no-op succeeds and says no audit row was written", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap } = fakeJmap();
    await cmdAgentDossier(db, ["enable", "extractor"], { ...IO }, { fetchImpl, jmap });
    expect(errText()).toContain("no audit row");
  });

  it("a SetError refusal is verbatim and maps to its own exit code", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap } = fakeJmap("notUpdated");
    let caught: unknown;
    try {
      await cmdAgentDossier(db, ["disable", "extractor"], { ...IO }, { fetchImpl, jmap });
    } catch (err) {
      caught = err;
    }
    expect((caught as { exitCode: number }).exitCode).toBe(5); // stateMismatch
    expect((caught as Error).message).toContain("moved under this call");
  });

  it("a method-level forbidden (no `send` scope) keeps the server's words", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap } = fakeJmap("forbidden");
    await expect(cmdAgentDossier(db, ["disable", "extractor"], { ...IO }, { fetchImpl, jmap })).rejects.toThrow(
      /the binding kill switch is a human control/,
    );
  });

  it("--dry-run reports the current state and calls nothing", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet();
    const { jmap, calls } = fakeJmap();
    await cmdAgentDossier(db, ["disable", "extractor"], { ...IO, dryRun: true }, { fetchImpl, jmap });
    expect(calls).toEqual([]);
    expect(errText()).toContain("Nothing was written");
  });
});
