import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LADDER,
  LOCAL_HOST_KEY,
  LOCAL_HOST_KEY_ENV,
  STARTER_MODEL,
  cmdLocal,
  cmdModels,
  decideSetup,
  installPlan,
  normalizeHostBase,
  probeHost,
  probeLadder,
  type HostFinding,
  type SetupDeps,
} from "./local.js";
import { getConfig, openDb } from "./db.js";

/**
 * s26 T6 — the @local onboarding ladder. Everything decisive is pure or
 * injected (probe parsing, the decision table, the install plan, SetupDeps),
 * so the whole rung-1 flow — detect → connect → offer → install-with-consent
 * — runs here against fakes, including the one property that must NEVER
 * regress: nothing is executed without an explicit yes.
 */

type FetchLike = typeof fetch;

/** A fake fetch serving /v1/models per host base. */
function fakeNet(hosts: Record<string, { status?: number; models?: string[]; fail?: boolean }>): {
  fetchImpl: FetchLike;
  seen: Array<{ url: string; auth: string | undefined }>;
} {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.Authorization });
    const base = url.replace(/\/v1\/models$/, "");
    const spec = hosts[base];
    if (!spec || spec.fail) throw new Error(`connect ECONNREFUSED ${base}`);
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: (spec.models ?? []).map((id) => ({ id })) }),
    } as Response;
  }) as FetchLike;
  return { fetchImpl, seen };
}

const up = (over: Partial<HostFinding>): HostFinding => ({
  name: "h",
  base: "http://x",
  up: true,
  authRequired: false,
  models: ["m1"],
  ...over,
});
const down = (over: Partial<HostFinding> = {}): HostFinding => ({
  name: "h",
  base: "http://x",
  up: false,
  authRequired: false,
  models: [],
  ...over,
});

const freshDb = () => openDb(join(mkdtempSync(join(tmpdir(), "bm-local-")), "test.db"));
const IO = { json: false, ids: false, dryRun: false, yes: false } as const;

describe("the ladder itself", () => {
  it("probes LiteLLM :4000 → Ollama :11434 → vLLM :8000 → llama.cpp :8080, in that order", () => {
    expect(LADDER.map((h) => h.base)).toEqual([
      "http://localhost:4000",
      "http://localhost:11434",
      "http://localhost:8000",
      "http://localhost:8080",
    ]);
  });
  it("normalizeHostBase strips trailing slashes and a pasted /v1", () => {
    expect(normalizeHostBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(normalizeHostBase("http://localhost:11434/")).toBe("http://localhost:11434");
    expect(normalizeHostBase("https://alpaca.local:4000")).toBe("https://alpaca.local:4000");
  });
});

describe("probeHost — a dead host is a finding, not an exception", () => {
  it("classifies up / keyed / not-compat / down", async () => {
    const { fetchImpl } = fakeNet({
      "http://a": { models: ["m1", "m2"] },
      "http://b": { status: 401 },
      "http://c": { status: 404 },
    });
    expect(await probeHost({ name: "a", base: "http://a" }, { fetchImpl })).toMatchObject({
      up: true,
      authRequired: false,
      models: ["m1", "m2"],
    });
    expect(await probeHost({ name: "b", base: "http://b" }, { fetchImpl })).toMatchObject({
      up: true,
      authRequired: true,
    });
    expect(await probeHost({ name: "c", base: "http://c" }, { fetchImpl })).toMatchObject({
      up: false,
      detail: expect.stringContaining("HTTP 404"),
    });
    expect(await probeHost({ name: "d", base: "http://dead" }, { fetchImpl })).toMatchObject({
      up: false,
      detail: expect.stringContaining("ECONNREFUSED"),
    });
  });
  it("sends the bearer only when a key is given", async () => {
    const { fetchImpl, seen } = fakeNet({ "http://a": { models: [] } });
    await probeHost({ name: "a", base: "http://a" }, { fetchImpl, apiKey: "sk-1" });
    await probeHost({ name: "a", base: "http://a" }, { fetchImpl });
    expect(seen[0]!.auth).toBe("Bearer sk-1");
    expect(seen[1]!.auth).toBeUndefined();
  });
  it("probeLadder preserves the ladder's order in its findings", async () => {
    const { fetchImpl } = fakeNet({ "http://localhost:11434": { models: ["llama"] } });
    const findings = await probeLadder(LADDER, { fetchImpl });
    expect(findings.map((f) => f.name)).toEqual(LADDER.map((h) => h.name));
    expect(findings.filter((f) => f.up).map((f) => f.name)).toEqual(["ollama"]);
  });
});

describe("decideSetup — the decision table", () => {
  it("the FIRST open host wins (probe order is preference order)", () => {
    const d = decideSetup([down(), up({ name: "ollama" }), up({ name: "vllm" })]);
    expect(d).toMatchObject({ kind: "connect", finding: { name: "ollama" } });
  });
  it("an open host beats an earlier keyed one for CONNECT, but a keyed host still blocks the install", () => {
    const keyedFirst = decideSetup([up({ name: "litellm", authRequired: true, models: [] }), up({ name: "ollama" })]);
    expect(keyedFirst).toMatchObject({ kind: "connect", finding: { name: "ollama" } });
    const keyedOnly = decideSetup([up({ name: "litellm", authRequired: true, models: [] }), down()]);
    expect(keyedOnly).toMatchObject({ kind: "needs-key", finding: { name: "litellm" } });
  });
  it("only a silent sweep reaches the offer", () => {
    expect(decideSetup([down(), down(), down(), down()])).toEqual({ kind: "offer-install" });
    expect(decideSetup([])).toEqual({ kind: "offer-install" });
  });
});

describe("installPlan — per platform, Ollama only, starter pinned", () => {
  it("darwin uses brew (install + background service)", () => {
    const p = installPlan("darwin");
    expect(p.steps.map((s) => s.argv[0])).toEqual(["brew", "brew"]);
    expect(p.starter).toBe(STARTER_MODEL);
    expect(p.base).toBe("http://localhost:11434");
  });
  it("win32 uses winget; linux the official installer", () => {
    expect(installPlan("win32").steps[0]!.argv).toContain("winget");
    expect(installPlan("linux").steps[0]!.argv.join(" ")).toContain("ollama.com/install.sh");
  });
});

// ---- the rung-1 flow, end to end against fakes -----------------------------

function fakeDeps(over: Partial<SetupDeps> & { answers?: boolean }) {
  const execs: string[][] = [];
  let asked = 0;
  const deps: SetupDeps = {
    exec: async (argv) => {
      execs.push(argv);
      return 0;
    },
    confirm: async () => {
      asked++;
      return over.answers ?? false;
    },
    sleep: async () => undefined,
    waitMs: 0,
    ...over,
  };
  return { deps, execs, askedCount: () => asked };
}

describe("local setup — detect → connect → offer → install-with-consent", () => {
  it("a host answering means CONNECT and STOP: nothing executed, nothing asked", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({ "http://localhost:4000": { models: ["gpt-x", "llama"] } });
    const { deps, execs, askedCount } = fakeDeps({ fetchImpl });
    await cmdLocal(db, ["setup"], { ...IO }, deps);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBe("http://localhost:4000");
    expect(execs).toEqual([]);
    expect(askedCount()).toBe(0);
  });

  it("a keyed host blocks the install with exit 4 and a connect hint — never a second runtime", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({ "http://localhost:4000": { status: 401 } });
    const { deps, execs } = fakeDeps({ fetchImpl });
    await expect(cmdLocal(db, ["setup"], { ...IO }, deps)).rejects.toThrow(/wants a key/);
    expect(execs).toEqual([]);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBeUndefined();
  });

  it("NO consent, NO install: a declined offer executes nothing and exits clean", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({});
    const { deps, execs, askedCount } = fakeDeps({ fetchImpl, answers: false });
    await cmdLocal(db, ["setup"], { ...IO }, deps); // resolves — declining is not an error
    expect(askedCount()).toBe(1);
    expect(execs).toEqual([]);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBeUndefined();
  });

  it("with consent: runs exactly the printed plan, waits for the host, pulls the starter, connects", async () => {
    const db = freshDb();
    const net: Record<string, { models?: string[]; fail?: boolean }> = { "http://localhost:11434": { fail: true } };
    const { fetchImpl } = fakeNet(net);
    const { deps, execs } = fakeDeps({
      fetchImpl,
      platform: "darwin",
      answers: true,
      exec: async (argv) => {
        execs.push(argv);
        // The service-start step brings the host up, as brew would.
        if (argv.join(" ") === "brew services start ollama") {
          net["http://localhost:11434"] = { models: [STARTER_MODEL] };
        }
        return 0;
      },
    });
    await cmdLocal(db, ["setup"], { ...IO }, deps);
    expect(execs).toEqual([
      ["brew", "install", "ollama"],
      ["brew", "services", "start", "ollama"],
      ["ollama", "pull", STARTER_MODEL],
    ]);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBe("http://localhost:11434");
  });

  it("a failing install step aborts before the pull and connects nothing", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({});
    const ran: string[][] = [];
    const { deps } = fakeDeps({
      fetchImpl,
      platform: "darwin",
      answers: true,
      exec: async (argv) => {
        ran.push(argv);
        return 1; // brew install fails
      },
    });
    await expect(cmdLocal(db, ["setup"], { ...IO }, deps)).rejects.toThrow(/exited 1/);
    expect(ran).toEqual([["brew", "install", "ollama"]]);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBeUndefined();
  });
});

describe("local connect — rung 2, any OpenAI-compat endpoint", () => {
  it("verifies /v1/models, saves host + key REFERENCE (never the key), reports models", async () => {
    const db = freshDb();
    process.env.LOCAL_TEST_KEY = "sk-local";
    try {
      const { fetchImpl, seen } = fakeNet({ "http://alpaca.local:4000": { models: ["a", "b"] } });
      await cmdLocal(
        db,
        ["connect"],
        { ...IO, host: "http://alpaca.local:4000/v1/", keyEnv: "LOCAL_TEST_KEY" },
        { fetchImpl, exec: async () => 0, confirm: async () => false },
      );
      expect(getConfig(db, LOCAL_HOST_KEY)).toBe("http://alpaca.local:4000");
      expect(getConfig(db, LOCAL_HOST_KEY_ENV)).toBe("LOCAL_TEST_KEY"); // the reference
      expect(seen[0]!.auth).toBe("Bearer sk-local");
    } finally {
      delete process.env.LOCAL_TEST_KEY;
    }
  });

  it("a dead host is an error (exit 1) and saves nothing; keyed-without-key exits 4", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({ "http://keyed": { status: 403 } });
    await expect(
      cmdLocal(
        db,
        ["connect"],
        { ...IO, host: "http://dead" },
        { fetchImpl, exec: async () => 0, confirm: async () => false },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
    await expect(
      cmdLocal(
        db,
        ["connect"],
        { ...IO, host: "http://keyed" },
        { fetchImpl, exec: async () => 0, confirm: async () => false },
      ),
    ).rejects.toThrow(/requires a key/);
    expect(getConfig(db, LOCAL_HOST_KEY)).toBeUndefined();
  });
});

describe("models — the sweep and the single host", () => {
  it("--host asks that endpoint; the saved host rides first in the sweep", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({
      "http://mine:9999": { models: ["custom-model"] },
      "http://localhost:11434": { models: ["llama"] },
    });
    // connect a custom host, then sweep: saved first, ladder after, deduped
    await cmdLocal(
      db,
      ["connect"],
      { ...IO, host: "http://mine:9999" },
      { fetchImpl, exec: async () => 0, confirm: async () => false },
    );
    await cmdModels(db, { ...IO }, fetchImpl); // must not throw; down defaults are quiet skips
    await cmdModels(db, { ...IO, host: "http://localhost:11434" }, fetchImpl);
  });

  it("--host on a dead endpoint is an error (unlike the sweep)", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeNet({});
    await expect(cmdModels(db, { ...IO, host: "http://dead" }, fetchImpl)).rejects.toThrow(/ECONNREFUSED/);
  });
});
