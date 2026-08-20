import { describe, expect, it } from "vitest";
import { MethodRegistry, dispatch, type CallMeta } from "./dispatch";
import type { Invocation } from "./types";

// The dispatcher's creation-id map (RFC 8620 §3.3) — the thing that lets a
// batched `[Foo/set create "a", Bar/set {ref: "#a"}]` work in one round trip.
// The full JMAP-methods round trip lives in
// services/jmap/src/methods/submission.test.ts; these pin the map mechanics
// themselves: seeding, growth, overwrite, and the echo contract.

type Args = Record<string, unknown>;

function registryRecording(seen: Array<ReadonlyMap<string, string>>) {
  const registry = new MethodRegistry<null>();
  registry.register("Test/set", async (args: Args, _ctx, meta?: CallMeta) => {
    seen.push(new Map(meta!.createdIds));
    // Echo back whatever `create` asked for, assigning `id: real-<cid>`.
    const created: Record<string, unknown> = {};
    for (const cid of Object.keys((args.create as Args) ?? {})) {
      created[cid] = { id: `real-${cid}` };
    }
    return { created };
  });
  return registry;
}

const call = (args: Args, id: string): Invocation => ["Test/set", args, id];

describe("dispatch — the RFC 8620 §3.3 creation-id map", () => {
  it("grows across method calls, so later handlers see earlier creations", async () => {
    const seen: Array<ReadonlyMap<string, string>> = [];
    const res = await dispatch(
      { using: [], methodCalls: [call({ create: { a: {} } }, "0"), call({}, "1")] },
      registryRecording(seen),
      null,
      "0",
    );

    expect(seen[0]!.size).toBe(0); // nothing created yet when call 0 runs
    expect(seen[1]!.get("a")).toBe("real-a"); // call 1 sees call 0's creation
    // No `createdIds` in the request → none in the response.
    expect(res.createdIds).toBeUndefined();
  });

  it("seeds from request.createdIds and echoes the merged map back", async () => {
    const seen: Array<ReadonlyMap<string, string>> = [];
    const res = await dispatch(
      { using: [], methodCalls: [call({ create: { b: {} } }, "0")], createdIds: { a: "real-a" } },
      registryRecording(seen),
      null,
      "0",
    );

    expect(seen[0]!.get("a")).toBe("real-a"); // prior request's binding visible
    expect(res.createdIds).toEqual({ a: "real-a", b: "real-b" });
  });

  it("a reused creation id overwrites the earlier binding, per spec", async () => {
    const seen: Array<ReadonlyMap<string, string>> = [];
    await dispatch(
      {
        using: [],
        methodCalls: [call({ create: { a: {} } }, "0"), call({ create: { a: {} } }, "1"), call({}, "2")],
        createdIds: { a: "stale" },
      },
      registryRecording(seen),
      null,
      "0",
    );

    expect(seen[0]!.get("a")).toBe("stale");
    expect(seen[2]!.get("a")).toBe("real-a");
  });

  it("harvests only well-shaped created maps — a failing call adds nothing", async () => {
    const registry = new MethodRegistry<null>();
    const seen: Array<ReadonlyMap<string, string>> = [];
    registry.register("Bad/set", async () => {
      throw new Error("boom");
    });
    registry.register("Odd/set", async () => ({ created: "not-a-map" }));
    registry.register("Peek/get", async (_args, _ctx, meta?: CallMeta) => {
      seen.push(new Map(meta!.createdIds));
      return {};
    });

    const res = await dispatch(
      {
        using: [],
        methodCalls: [
          ["Bad/set", {}, "0"],
          ["Odd/set", {}, "1"],
          ["Peek/get", {}, "2"],
        ],
      },
      registry,
      null,
      "0",
    );

    expect(res.methodResponses[0]![0]).toBe("error");
    expect(seen[0]!.size).toBe(0);
  });
});
