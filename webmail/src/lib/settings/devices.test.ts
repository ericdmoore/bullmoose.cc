import { describe, expect, it } from "vitest";
import { JmapRequestError, type JmapClient } from "../jmap/JmapClient";
import type { ConsoleBinding } from "../console/types";
import { latestReportAt, loadDevices, normalizeModels, reconcileLocalModels } from "./devices";

// s37 T2 — the reconcile's rules of evidence, which are the section's whole
// design: only @local candidates reconcile, only enabled bindings claim
// anything, and with ZERO reports filed the reconcile stays silent — a gap
// asserted from no evidence is the confidently-wrong rendering decision 2
// bans.

function device(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}
function base() {
  return {
    id: "tk_1",
    name: "eric-laptop",
    createdAt: 1,
    expiresAt: null,
    lastUsedAt: 2_000,
    host: "http://localhost:11434",
    models: ["llama3:8b", "nomic-embed-text"] as string[] | null,
    kinds: {} as Record<string, string>,
    source: "local",
    reportedAt: 3_000 as number | null,
  };
}

function binding(name: string, candidates: string[], enabled = true): ConsoleBinding {
  return {
    name,
    enabled,
    economics: {
      budgetMicros: null,
      defaultModel: null,
      exploreRate: null,
      modelMenu: [{ alias: "menu", candidates }],
    },
  } as unknown as ConsoleBinding;
}

describe("reconcileLocalModels", () => {
  it("finds the gap the section exists for", () => {
    const gaps = reconcileLocalModels([binding("extractor", ["@local/llama3:70b"])], [device()]);
    expect(gaps).toEqual([{ bindingName: "extractor", model: "llama3:70b" }]);
  });

  it("a served model is no gap — embedding models count too", () => {
    const gaps = reconcileLocalModels(
      [binding("extractor", ["@local/llama3:8b"]), binding("embedder", ["@local/nomic-embed-text"])],
      [device()],
    );
    expect(gaps).toEqual([]);
  });

  it("cloud candidates are the provider's business, not a box's", () => {
    const gaps = reconcileLocalModels([binding("x", ["openrouter/minimax/minimax-m3"])], [device()]);
    expect(gaps).toEqual([]);
  });

  it("a disabled binding references nothing that runs", () => {
    const gaps = reconcileLocalModels([binding("off", ["@local/ghost"], false)], [device()]);
    expect(gaps).toEqual([]);
  });

  it("ZERO reports filed means NO claims — absence of evidence", () => {
    const unreported = device({ models: null, reportedAt: null });
    const gaps = reconcileLocalModels([binding("extractor", ["@local/ghost"])], [unreported]);
    expect(gaps).toEqual([]);
  });

  it("any one device serving the model satisfies every binding", () => {
    const other = device({ id: "tk_2", name: "studio", models: ["llama3:70b"] });
    const gaps = reconcileLocalModels([binding("extractor", ["@local/llama3:70b"])], [device(), other]);
    expect(gaps).toEqual([]);
  });
});

describe("normalizeModels", () => {
  it("reads both wire spellings and keeps declared kinds", () => {
    const { ids, kinds } = normalizeModels(["llama3:8b", { id: "nomic-embed-text", kind: "embedding" }]);
    expect(ids).toEqual(["llama3:8b", "nomic-embed-text"]);
    expect(kinds).toEqual({ "nomic-embed-text": "embedding" });
  });

  it("skips shapes it does not know rather than throwing", () => {
    const { ids } = normalizeModels([42, null, { notId: "x" }, "ok"]);
    expect(ids).toEqual(["ok"]);
  });
});

describe("loadDevices", () => {
  const stub = (fn: () => Promise<Record<string, unknown>>) => ({ requestOne: fn }) as unknown as JmapClient;

  it("unknownMethod is feature detection, not an error", async () => {
    const client = stub(() => {
      throw new JmapRequestError("DeviceReport/get → unknownMethod", "unknownMethod");
    });
    expect(await loadDevices(client, "a_1")).toBeNull();
  });

  it("anything else throws — a network failure must not render as no devices", async () => {
    const client = stub(() => {
      throw new JmapRequestError("boom", undefined, 500);
    });
    await expect(loadDevices(client, "a_1")).rejects.toThrow("boom");
  });

  it("normalizes the wire rows", async () => {
    const client = stub(async () => ({
      list: [
        {
          id: "tk_1",
          name: "eric-laptop",
          createdAt: 1,
          expiresAt: null,
          lastUsedAt: 9,
          host: "http://localhost:11434",
          models: ["llama3:8b", { id: "paddle-ocr", kind: "ocr" }],
          capabilities: null,
          source: "local",
          reportedAt: 10,
        },
      ],
    }));
    const rows = await loadDevices(client, "a_1");
    expect(rows).toHaveLength(1);
    expect(rows![0]!.models).toEqual(["llama3:8b", "paddle-ocr"]);
    expect(rows![0]!.kinds).toEqual({ "paddle-ocr": "ocr" });
  });
});

describe("latestReportAt", () => {
  it("the newest as-of, or null with no reports anywhere", () => {
    expect(latestReportAt([device({ reportedAt: 5 }), device({ reportedAt: 9 })])).toBe(9);
    expect(latestReportAt([device({ reportedAt: null })])).toBeNull();
  });
});
