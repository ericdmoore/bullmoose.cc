import { describe, expect, it } from "vitest";
import { AGENT_CAP } from "./capabilities";
import { FakeJmapClient } from "./FakeJmapClient";

describe("FakeJmapClient", () => {
  it("serves a full-capability session by default", async () => {
    const fake = new FakeJmapClient();
    expect(await fake.hasAgentCapability()).toBe(true);
    expect(await fake.primaryAccountId()).toBe("acct-fake");
  });

  it("resolves back-references locally so queryThenGet behaves like the server", async () => {
    const fake = new FakeJmapClient({
      handlers: {
        "Email/query": () => ({ ids: ["a", "b"] }),
        "Email/get": (args) => ({
          list: (args.ids as string[]).map((id) => ({ id })),
          notFound: [],
        }),
      },
    });
    const { get } = await fake.queryThenGet("acct-fake", "Email/query", {}, "Email/get");
    expect((get.list as Array<{ id: string }>).map((m) => m.id)).toEqual(["a", "b"]);
    // The batch really was one request of two calls.
    expect(fake.sentBatches).toHaveLength(1);
    expect(fake.sentBatches[0]).toHaveLength(2);
  });

  it("advances the changes cursor through a handler", async () => {
    const fake = new FakeJmapClient({
      handlers: {
        "Email/changes": (args) => ({
          accountId: "acct-fake",
          oldState: args.sinceState,
          newState: String(Number(args.sinceState) + 1),
          hasMoreChanges: false,
          created: [`e${args.sinceState}`],
          updated: [],
          destroyed: [],
        }),
      },
    });
    fake.seedCursor("Email", "1");
    const first = await fake.sync("Email");
    expect(first.created).toEqual(["e1"]);
    expect(fake.cursor("Email")).toBe("2");
    await fake.sync("Email");
    expect(fake.cursor("Email")).toBe("3");
  });

  it("round-trips a blob through upload/download", async () => {
    const fake = new FakeJmapClient();
    const bytes = new TextEncoder().encode("payload");
    const { blobId } = await fake.upload("acct-fake", bytes, "text/plain");
    expect(new TextDecoder().decode(await fake.download("acct-fake", blobId))).toBe("payload");
  });

  it("emits a StateChange to a watcher", async () => {
    const fake = new FakeJmapClient();
    const seen: Array<Record<string, Record<string, string>>> = [];
    const stop = await fake.watch((changed) => seen.push(changed));
    fake.emitStateChange({ "acct-fake": { Email: "4" } });
    expect(seen).toEqual([{ "acct-fake": { Email: "4" } }]);
    stop();
    fake.emitStateChange({ "acct-fake": { Email: "5" } });
    expect(seen).toHaveLength(1); // stopped
  });

  it("models a capability-less session with the agent cap dropped", async () => {
    const fake = new FakeJmapClient({
      session: { capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} } },
    });
    expect(await fake.hasCapability(AGENT_CAP)).toBe(false);
    expect(await fake.hasAgentCapability()).toBe(false);
    // A plain method still works — nothing errors.
    fake.setHandler("Mailbox/get", () => ({ list: [] }));
    expect(await fake.requestOne("Mailbox/get", {})).toEqual({ list: [] });
  });

  it("reports unknownMethod for an unregistered method", async () => {
    const fake = new FakeJmapClient();
    const [resp] = await fake.request([["Nope/get", {}, "c0"]]);
    expect(resp?.[0]).toBe("error");
    expect((resp![1] as { type: string }).type).toBe("unknownMethod");
  });
});
