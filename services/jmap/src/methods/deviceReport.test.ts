import { describe, expect, it } from "vitest";
import { MethodRegistry } from "@bullmoose/jmap-core";
import { fakeEnv } from "@bullmoose/test-fakes";
import { registerDeviceReportMethods } from "./deviceReport";
import type { RequestContext } from "./common";

// s37 T1a — the device self-description. The load-bearing rules under test:
// a report binds to the AUTHENTICATED token and nothing in the arguments can
// point it elsewhere; reads are the owner's whole device list (reported or
// not); grant-reached callers and agent tokens are refused; and the report
// is a bounded LABEL, not a payload.

const ACCOUNT = "a_eric";
const TENANT = "t_bm";
const OWNER = "eric@bullmoose.cc";

function harness(opts: { scopes?: string[]; tokenId?: string | null; granted?: boolean } = {}) {
  const w = fakeEnv();
  w.db.seedAccount({
    accountId: ACCOUNT,
    tenantId: TENANT,
    principalId: "p_eric",
    loginEmail: OWNER,
    displayName: "Eric",
  });
  // Two devices: the laptop (will report) and the runtime (never reports) —
  // the LEFT JOIN's reason to exist.
  w.db.seed("tokens", [
    {
      id: "tk_laptop",
      principal_id: "p_eric",
      secret_hash: "x",
      name: "eric-laptop",
      scopes: '["mail"]',
      created_at: 500,
      last_used_at: 2_000,
    },
    {
      id: "tk_runtime",
      principal_id: "p_eric",
      secret_hash: "x",
      name: "hermes-runtime",
      scopes: '["mail"]',
      created_at: 500,
      last_used_at: 1_000,
    },
  ]);
  const registry = new MethodRegistry<RequestContext>();
  registerDeviceReportMethods(registry);
  const ctx: RequestContext = {
    env: w.env,
    principal: {
      username: OWNER,
      scopes: opts.scopes ?? ["mail"],
      accounts: [
        {
          accountId: ACCOUNT,
          tenantId: TENANT,
          name: "Eric",
          ...(opts.granted
            ? { granted: [{ grantId: "g_1", scopes: ["read"], collection: null, collectionId: null }] }
            : {}),
        },
      ],
      ...(opts.tokenId === null ? {} : { tokenId: opts.tokenId ?? "tk_laptop" }),
    },
  };
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    registry.get(method)!({ accountId: ACCOUNT, ...args }, ctx) as Promise<T>;
  return { w, call };
}

const REPORT = {
  host: "http://localhost:11434",
  models: ["llama3:8b", "qwen3:4b"],
  capabilities: { vision: false, contextTokens: 32000 },
  source: "local",
};

describe("DeviceReport/set", () => {
  it("binds the report to the AUTHENTICATED token", async () => {
    const { w, call } = harness({ tokenId: "tk_laptop" });
    const res = await call("DeviceReport/set", { update: { self: REPORT } });
    expect(res.updated).toEqual({ self: null });

    const rows = w.db.sqlite.prepare(`SELECT token_id, report_json FROM device_reports`).all() as Array<{
      token_id: string;
      report_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_id).toBe("tk_laptop");
    expect(JSON.parse(rows[0]!.report_json).host).toBe("http://localhost:11434");
  });

  it("offers NO argument that names another device", async () => {
    // The singleton is the whole write-authorization story: a key that is
    // not `self` — say, another token's id — is refused outright.
    const { w, call } = harness({ tokenId: "tk_laptop" });
    await expect(call("DeviceReport/set", { update: { tk_runtime: REPORT } })).rejects.toMatchObject({
      type: "invalidArguments",
    });
    expect(w.db.count("device_reports")).toBe(0);
  });

  it("replaces on re-report — the row is a snapshot, not a log", async () => {
    const { w, call } = harness();
    await call("DeviceReport/set", { update: { self: REPORT } });
    await call("DeviceReport/set", { update: { self: { ...REPORT, models: ["llama3:8b"] } } });
    const rows = w.db.sqlite.prepare(`SELECT report_json FROM device_reports`).all() as Array<{ report_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.report_json).models).toEqual(["llama3:8b"]);
  });

  it("refuses a credential with no minted token", async () => {
    // OAuth and dev-bootstrap principals carry no tokenId; a report from
    // "nobody in particular" is exactly the row this table must not hold.
    const { call } = harness({ tokenId: null });
    await expect(call("DeviceReport/set", { update: { self: REPORT } })).rejects.toMatchObject({
      type: "forbidden",
    });
  });

  it("bounds the label", async () => {
    const { call } = harness();
    await expect(
      call("DeviceReport/set", { update: { self: { models: Array(300).fill("m") } } }),
    ).rejects.toMatchObject({ type: "invalidArguments" });
    await expect(call("DeviceReport/set", { update: { self: { models: "llama3" } } })).rejects.toMatchObject({
      type: "invalidArguments",
    });
    await expect(
      call("DeviceReport/set", {
        update: { self: { capabilities: { pad: "x".repeat(40_000) } } },
      }),
    ).rejects.toMatchObject({ type: "invalidArguments" });
  });

  it("keeps capability keys it has never heard of", async () => {
    // A newer CLI may say more than this server knows; the label survives
    // verbatim so T2 renders tomorrow's vocabulary without a deploy.
    const { w, call } = harness();
    await call("DeviceReport/set", {
      update: { self: { capabilities: { zebra: true, contextTokens: 8000 } } },
    });
    const rows = w.db.sqlite.prepare(`SELECT report_json FROM device_reports`).all() as Array<{ report_json: string }>;
    expect(JSON.parse(rows[0]!.report_json).capabilities.zebra).toBe(true);
  });
});

describe("DeviceReport/get", () => {
  it("lists EVERY device of the owner, reported or not", async () => {
    const { call } = harness({ tokenId: "tk_laptop" });
    await call("DeviceReport/set", { update: { self: REPORT } });

    const res = await call<{ list: Array<Record<string, unknown>> }>("DeviceReport/get", {});
    expect(res.list).toHaveLength(2);
    // Most recently seen first.
    const [laptop, runtime] = res.list as [Record<string, unknown>, Record<string, unknown>];
    expect(laptop.id).toBe("tk_laptop");
    expect(laptop.models).toEqual(["llama3:8b", "qwen3:4b"]);
    expect(laptop.reportedAt).toBeTypeOf("number");
    // The never-reported device is still a DEVICE — bare "last seen", no
    // model claims. That is the honest rendering, not an omission.
    expect(runtime.id).toBe("tk_runtime");
    expect(runtime.name).toBe("hermes-runtime");
    expect(runtime.models).toBeNull();
    expect(runtime.reportedAt).toBeNull();
  });

  it("is refused through a grant — devices are not part of what a grant shares", async () => {
    const { call } = harness({ granted: true });
    await expect(call("DeviceReport/get", {})).rejects.toMatchObject({ type: "forbidden" });
  });

  it("is refused to agent-marked tokens", async () => {
    const { call } = harness({ scopes: ["mail", "agent"] });
    await expect(call("DeviceReport/get", {})).rejects.toMatchObject({ type: "forbidden" });
  });
});
