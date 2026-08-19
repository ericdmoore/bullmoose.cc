import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { applyBindingEnabled, setBindingEnabled } from "./api";
import type { AgentDossier } from "../console/types";

// s26 T2 — the ONE write door's client half. `setBindingEnabled` mirrors
// approvals' `decide`: outcome objects, the server's sentence verbatim on a
// refusal, and the /set response's `updated[id].enabled` — not the ask — as
// the reconciled truth. `applyBindingEnabled` is the optimistic half, pure.

const dossier = (enabled: boolean): AgentDossier =>
  ({
    accountId: "acct_a",
    principalId: "p_a",
    principal: "allen@bullmoose.cc",
    tokenScopes: ["mail"],
    bindings: [
      {
        bindingId: "ab_1",
        name: "allen",
        triggerOn: "mailbox-delivery",
        slaSeconds: null,
        enabled,
        config: { pipeline: "extract", replyMode: null },
      },
      {
        bindingId: "ab_2",
        name: "allen-digest",
        triggerOn: "schedule",
        slaSeconds: null,
        enabled: true,
        config: { pipeline: "ledger", replyMode: null },
      },
    ],
    credentials: [],
    bureauGrants: [],
    grantsHeld: [],
    grantsGiven: [],
    invocations: [],
    spend: null,
  }) as unknown as AgentDossier;

describe("setBindingEnabled", () => {
  it("sends AgentBinding/set and returns the SERVER's enabled, not the ask", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        "AgentBinding/set": (args) => {
          seen.push(args);
          return { accountId: args.accountId as string, updated: { ab_1: { enabled: false } }, notUpdated: {} };
        },
      },
    });
    const outcome = await setBindingEnabled(client, "acct_a", "ab_1", false);
    expect(outcome).toEqual({ ok: true, enabled: false });
    expect(seen[0]).toEqual({ accountId: "acct_a", update: { ab_1: { enabled: false } } });
  });

  it("a row-level refusal surfaces the server's sentence verbatim", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "AgentBinding/set": () => ({
          accountId: "acct_a",
          updated: {},
          notUpdated: { ab_1: { type: "notFound", description: "no such binding on this account" } },
        }),
      },
    });
    const outcome = await setBindingEnabled(client, "acct_a", "ab_1", false);
    expect(outcome).toEqual({ ok: false, message: "no such binding on this account" });
  });

  it("a method-level refusal (the capability wall) comes back as ok:false, message intact", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "AgentBinding/set": () => [
          "error",
          { type: "forbidden", description: "flipping a binding's kill switch requires the send capability" },
        ],
      },
    });
    const outcome = await setBindingEnabled(client, "acct_a", "ab_1", true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("send capability");
  });

  it("an empty response (neither updated nor notUpdated) is a refusal, not a silent success", async () => {
    const client = new FakeJmapClient({
      handlers: { "AgentBinding/set": () => ({ accountId: "acct_a", updated: {}, notUpdated: {} }) },
    });
    const outcome = await setBindingEnabled(client, "acct_a", "ab_1", true);
    expect(outcome.ok).toBe(false);
  });
});

describe("applyBindingEnabled — the optimistic half, pure", () => {
  it("flips exactly one binding and leaves its siblings alone", async () => {
    const before = { acct_a: dossier(true) };
    const after = applyBindingEnabled(before, "acct_a", "ab_1", false);
    expect(after.acct_a!.bindings.find((b) => b.bindingId === "ab_1")!.enabled).toBe(false);
    expect(after.acct_a!.bindings.find((b) => b.bindingId === "ab_2")!.enabled).toBe(true);
    // The input is untouched — this is a new record, not a mutation.
    expect(before.acct_a.bindings.find((b) => b.bindingId === "ab_1")!.enabled).toBe(true);
  });

  it("an unknown account or binding is a no-op — revert composes as a second application", () => {
    const before = { acct_a: dossier(false) };
    expect(applyBindingEnabled(before, "acct_missing", "ab_1", true).acct_a).toBe(before.acct_a);
    expect(applyBindingEnabled(before, "acct_a", "ab_missing", true).acct_a).toBe(before.acct_a);
    // flip then revert lands exactly where it started
    const flipped = applyBindingEnabled(before, "acct_a", "ab_1", true);
    const reverted = applyBindingEnabled(flipped, "acct_a", "ab_1", false);
    expect(reverted.acct_a!.bindings.find((b) => b.bindingId === "ab_1")!.enabled).toBe(false);
  });
});
