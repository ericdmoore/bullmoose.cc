import { describe, expect, it } from "vitest";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import { createDemoBackend } from "../jmap/demo";
import { armWatch, askAgent, askCompose } from "./api";
import { addBusinessDays } from "./contract";
import type { Email } from "../mail/types";

// s20 T2 — the verbs' two doors. What each sends on the wire, and — the part
// that matters more — what each SAYS when the server says no. A verb that
// fails must fail the way the margin does: in place, in a sentence, with the
// mail still readable behind it.

// Since #206 both verb doors ask `AgentBinding/get` which binding to run on,
// so every fake server here serves a roster. One enabled binding is the
// ordinary case; the refusal paths get their own fakes below.
const ROSTER_BINDING = { id: "bind_1", name: "extractor", enabled: true };
const roster = (bindings: { id: string; name: string; enabled: boolean }[] = [ROSTER_BINDING]) => ({
  "AgentBinding/get": () => ({ accountId: "acct_a", list: bindings, notFound: [] }),
});

const email = {
  id: "e_1",
  threadId: "t_1",
  from: [{ name: "Sergio", email: "sergio@example.com" }],
  to: [{ name: "Eric", email: "eric@bullmoose.cc" }],
} as Pick<Email, "id" | "threadId" | "from" | "to">;

describe("armWatch — through Watch/set, the CRUD T1 already shipped", () => {
  it("arms the default contract and reports it in words", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "Watch/set": (args) => {
          seen.push(args);
          return {
            accountId: args.accountId as string,
            created: { w: { id: "w_1", status: "armed" } },
            notCreated: {},
          };
        },
      },
    });
    const now = Date.UTC(2026, 7, 13, 12);
    const outcome = await armWatch(client, "acct_a", email, now);

    expect(outcome.ok).toBe(true);
    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).w!;
    expect(spec.conditionType).toBe("no-reply-from");
    expect(spec.actionType).toBe("draft-followup");
    expect(spec.deadlineAt).toBe(addBusinessDays(now, 4));
    expect(spec.sourceRef).toBe("e_1");
    expect(outcome.message).toContain("sergio@example.com");
  });

  it("no counterparty: refused client-side, with no round trip", async () => {
    let called = false;
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "Watch/set": () => {
          called = true;
          return {};
        },
      },
    });
    const outcome = await armWatch(client, "acct_a", { ...email, from: [], to: [] }, Date.now());
    expect(called).toBe(false);
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining("nothing to watch"), forbidden: false });
  });

  it("the annotate wall greys the verbs rather than inviting it again", async () => {
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "Watch/set": () => ["error", { type: "forbidden", description: "token lacks scope: annotate" }],
      },
    });
    const outcome = await armWatch(client, "acct_a", email, Date.now());
    expect(outcome).toMatchObject({ ok: false, forbidden: true });
    expect(outcome.ok === false && outcome.message).toContain("annotate");
  });

  it("a row-level refusal surfaces the server's own sentence", async () => {
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "Watch/set": (args) => ({
          accountId: args.accountId as string,
          created: {},
          notCreated: { w: { type: "invalidProperties", description: "no-reply-from needs condition.sender" } },
        }),
      },
    });
    const outcome = await armWatch(client, "acct_a", email, Date.now());
    expect(outcome).toEqual({ ok: false, message: "no-reply-from needs condition.sender", forbidden: false });
  });
});

describe("askAgent — through the on-demand AgentInvocation trigger", () => {
  it("carries the verb in params, on the named binding, against the message", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": (args) => {
          seen.push(args);
          return { accountId: args.accountId as string, created: { v: { id: "inv_1", status: "pending" } } };
        },
      },
    });
    const outcome = await askAgent(client, "acct_a", email, { verb: "answer" });
    expect(outcome.ok).toBe(true);

    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).v!;
    expect(spec.bindingId).toBe(ROSTER_BINDING.id);
    expect(spec.emailId).toBe("e_1");
    expect(spec.threadId).toBe("t_1");
    expect(spec.params).toEqual({ verb: "answer" });
    // The ask is NOT the answer, and the sentence says so.
    expect(outcome.message).toContain("will appear in your approvals");
  });

  it("bring-in carries the person and any steer", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": (args) => {
          seen.push(args);
          return { accountId: args.accountId as string, created: { v: { id: "inv_2" } } };
        },
      },
    });
    await askAgent(client, "acct_a", email, { verb: "bring-in", person: " kim@x.test ", note: "she owns pricing" });
    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).v!;
    expect(spec.params).toEqual({ verb: "bring-in", person: "kim@x.test", note: "she owns pricing" });
  });

  it("schedule carries the wall clock — and only schedule does", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": (args) => {
          seen.push(args);
          return { accountId: args.accountId as string, created: { v: { id: "inv_s" } } };
        },
      },
    });

    const outcome = await askAgent(client, "acct_a", email, { verb: "schedule", timeZone: "America/New_York" });
    expect(outcome.ok).toBe(true);
    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).v!;
    // "Thursday at 3" is meaningless without a wall clock to read it in, so
    // the ask carries one. The server never guesses one for you.
    expect(spec.params).toEqual({ verb: "schedule", timeZone: "America/New_York" });
    // A hold, not a meeting — and the one fact a calendar verb must never
    // leave a person guessing about.
    expect(outcome.message).toContain("nobody is invited");
    expect(outcome.message).toContain("your own calendar");

    // No zone injected: the browser's own is sent, so the server still gets a
    // wall clock rather than falling back to UTC.
    await askAgent(client, "acct_a", email, { verb: "schedule" });
    const auto = (seen[1]!.create as Record<string, Record<string, unknown>>).v!;
    expect(typeof (auto.params as Record<string, unknown>).timeZone).toBe("string");

    // A key nobody reads is how payloads grow fields nobody can explain.
    await askAgent(client, "acct_a", email, { verb: "answer", timeZone: "America/New_York" });
    expect((seen[2]!.create as Record<string, Record<string, unknown>>).v!.params).toEqual({ verb: "answer" });
  });

  it("refuses to guess which Sergio you meant — client-side, no round trip", async () => {
    let called = false;
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": () => {
          called = true;
          return {};
        },
      },
    });
    const outcome = await askAgent(client, "acct_a", email, { verb: "bring-in", person: "Sergio" });
    expect(called).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("rather ask than guess");
  });

  it("no agent on the mailbox: refused from the ROSTER, before any invocation is attempted", async () => {
    // #206 moved this refusal earlier and made it true rather than inferred:
    // v1 guessed a name, got `notFound`, and translated it. Now the roster
    // read answers empty and nothing is created at all.
    let attempted = false;
    const client = new FakeJmapClient({
      handlers: {
        ...roster([]),
        "AgentInvocation/set": () => {
          attempted = true;
          return {};
        },
      },
    });
    const outcome = await askAgent(client, "acct_a", email, { verb: "answer" });
    expect(attempted).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain("No agent is set up on this mailbox yet");
  });

  it("every agent switched off reads differently from having none — one is undoable", async () => {
    const client = new FakeJmapClient({
      handlers: { ...roster([{ id: "bind_1", name: "extractor", enabled: false }]) },
    });
    const outcome = await askAgent(client, "acct_a", email, { verb: "answer" });
    expect(outcome.ok === false && outcome.message).toContain("switched off");
  });

  it("the kill switch's refusal is passed through VERBATIM — it names its own cure", async () => {
    const server = 'binding "extractor" is disabled (008 kill switch) — re-enable it before invoking: …';
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": (args) => ({
          accountId: args.accountId as string,
          created: {},
          notCreated: { v: { type: "forbidden", description: server } },
        }),
      },
    });
    const outcome = await askAgent(client, "acct_a", email, { verb: "answer" });
    expect(outcome.ok === false && outcome.message).toBe(server);
  });

  it("a server that has never heard of the method says so plainly", async () => {
    // FakeJmapClient answers `unknownMethod` for an unhandled name — exactly
    // what an older deployment returns.
    const client = new FakeJmapClient({ handlers: { ...roster() } });
    const outcome = await askAgent(client, "acct_a", email, { verb: "answer" });
    expect(outcome.ok === false && outcome.message).toBe("This mailbox's server does not offer agent verbs yet.");
    const watch = await armWatch(client, "acct_a", email, Date.now());
    expect(watch.ok === false && watch.message).toBe("This mailbox's server does not offer agent verbs yet.");
  });
});

describe("against the demo backend, both doors write real rows", () => {
  it("Watch arms; Answer queues an invocation carrying the verb", async () => {
    const demo = createDemoBackend();
    const accountId = "acct-fake";
    const target = demo.emails.find((e) => e.threadId === "t-elk")!;

    expect((await armWatch(demo.client, accountId, target, Date.now())).ok).toBe(true);
    expect(Object.values(demo.watches)).toHaveLength(1);
    expect(Object.values(demo.watches)[0]!.actionType).toBe("draft-followup");

    expect((await askAgent(demo.client, accountId, target, { verb: "answer" })).ok).toBe(true);
    expect(demo.invocations).toHaveLength(1);
    expect(demo.invocations[0]!.params).toEqual({ verb: "answer" });
  });

  it("a read-only session meets the same walls the server puts up", async () => {
    const demo = createDemoBackend({ scopes: ["read"] });
    const target = demo.emails[0]!;
    const watch = await armWatch(demo.client, "acct-fake", target, Date.now());
    const ask = await askAgent(demo.client, "acct-fake", target, { verb: "answer" });
    expect(watch).toMatchObject({ ok: false, forbidden: true });
    expect(ask).toMatchObject({ ok: false, forbidden: true });
    expect(Object.keys(demo.watches)).toEqual([]);
    expect(demo.invocations).toEqual([]);
  });
});

describe("askCompose — the composer's intent mode (s20 T3)", () => {
  function recorder() {
    const seen: Record<string, unknown>[] = [];
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": (args) => {
          seen.push(args);
          return { accountId: args.accountId as string, created: { v: { id: "inv_1" } }, notCreated: {} };
        },
      },
    });
    return { seen, client };
  }

  const ASK = {
    to: "sergio@boards.example",
    intent: "ask Sergio whether he's comfortable with me selling assembled boards — supportive tone, no big commitment",
    tone: "supportive",
    constraints: ["no big commitment"],
    recipientVia: "address-book+history" as const,
  };

  it("creates an ordinary invocation carrying the whole plan — and NO emailId when there is no background", async () => {
    const { seen, client } = recorder();
    const outcome = await askCompose(client, "acct_a", ASK);

    expect(outcome.ok).toBe(true);
    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).v!;
    expect(spec.bindingId).toBe(ROSTER_BINDING.id);
    expect(spec).not.toHaveProperty("emailId");
    expect(spec.params).toEqual({
      verb: "compose",
      person: "sergio@boards.example",
      intent: ASK.intent,
      tone: "supportive",
      constraints: ["no big commitment"],
      recipientVia: "address-book+history",
    });
  });

  it("says where the draft lands and that nothing was sent", async () => {
    const { client } = recorder();
    const outcome = await askCompose(client, "acct_a", ASK);
    expect(outcome.ok && outcome.message).toContain("sergio@boards.example");
    expect(outcome.ok && outcome.message).toContain("approvals");
    expect(outcome.ok && outcome.message).toContain("nothing is sent until you send it");
  });

  it("passes the background message along when the lookup found one", async () => {
    const { seen, client } = recorder();
    await askCompose(client, "acct_a", { ...ASK, anchorEmailId: "e_last" });
    const spec = (seen[0]!.create as Record<string, Record<string, unknown>>).v!;
    expect(spec.emailId).toBe("e_last");
  });

  // The same rule `bring-in` states, at the door T3 owns: a name is never sent.
  // The composer will not offer the button in this state; this is the belt.
  it("refuses a recipient that is not an address, with no round trip", async () => {
    let called = false;
    const client = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": () => {
          called = true;
          return {};
        },
      },
    });
    const outcome = await askCompose(client, "acct_a", { ...ASK, to: "Sergio" });
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ ok: false, forbidden: false });
    expect(outcome.ok === false && outcome.message).toContain("I would rather ask than guess");
  });

  it("refuses an empty intent, with no round trip", async () => {
    const { seen, client } = recorder();
    const outcome = await askCompose(client, "acct_a", { ...ASK, intent: "   " });
    expect(seen).toHaveLength(0);
    expect(outcome.ok === false && outcome.message).toContain("Tell me what you want to happen");
  });

  it("translates the missing binding, and greys itself on a scope wall", async () => {
    // Same move as the answer door: an empty roster refuses before creating.
    const missing = new FakeJmapClient({ handlers: { ...roster([]) } });
    expect((await askCompose(missing, "acct_a", ASK)).ok === false).toBe(true);
    expect((await askCompose(missing, "acct_a", ASK)) as { message: string }).toMatchObject({
      message: expect.stringContaining("No agent is set up on this mailbox yet"),
    });

    const walled = new FakeJmapClient({
      handlers: {
        ...roster(),
        "AgentInvocation/set": () => ["error", { type: "forbidden", description: "token lacks scope: draft" }],
      },
    });
    expect(await askCompose(walled, "acct_a", ASK)).toMatchObject({ ok: false, forbidden: true });
  });

  it("an older server says so plainly rather than throwing", async () => {
    const outcome = await askCompose(new FakeJmapClient({ handlers: { ...roster() } }), "acct_a", ASK);
    expect(outcome.ok === false && outcome.message).toBe("This mailbox's server does not offer agent verbs yet.");
  });

  it("writes a real row against the demo backend, with no emailId", async () => {
    const demo = createDemoBackend();
    expect((await askCompose(demo.client, "acct-fake", ASK)).ok).toBe(true);
    expect(demo.invocations).toHaveLength(1);
    expect(demo.invocations[0]!.emailId).toBeNull();
    expect((demo.invocations[0]!.params as { verb: string }).verb).toBe("compose");
  });
});
