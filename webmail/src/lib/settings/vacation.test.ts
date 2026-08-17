import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import { FakeJmapClient } from "../jmap/FakeJmapClient";
import {
  VACATION_NO_OPTIMISTIC_GUARD,
  VACATION_PLAIN_TEXT_ONLY,
  fromLocalInput,
  loadVacation,
  saveVacation,
  toLocalInput,
  vacationPatch,
  vacationStatus,
  vacationToForm,
  type VacationForm,
  type VacationResponse,
} from "./vacation";

const ACCOUNT = "acct-fake";
const NOW = new Date("2026-08-10T12:00:00Z");

/** `htmlBody` is deliberately not overridable — the server hardcodes it null
 *  (`vacation.ts:25`), so a fixture that could set it would let a test assert
 *  behaviour no real response can produce. */
function responder(over: Omit<Partial<VacationResponse>, "htmlBody"> = {}): VacationResponse {
  return {
    id: "singleton",
    isEnabled: false,
    fromDate: null,
    toDate: null,
    subject: null,
    textBody: null,
    ...over,
    htmlBody: null,
  };
}

/** A form that is otherwise valid, so each test varies exactly one thing. */
function goodForm(over: Partial<VacationForm> = {}): VacationForm {
  return {
    isEnabled: true,
    subject: "Away until Monday",
    textBody: "I am away and will reply on Monday.",
    fromDate: "",
    toDate: "",
    ...over,
  };
}

describe("the html body does not exist and the UI must not pretend it does", () => {
  it("never puts htmlBody in a patch, whatever the form holds", () => {
    // VacationResponse/set builds `next` from isEnabled, subject, textBody,
    // fromDate, toDate ONLY (vacation.ts:42-48) and the upsert writes exactly
    // those five columns (:50-60). A key here would be accepted and dropped:
    // the write reports success and the content is gone.
    const { patch } = vacationPatch(responder(), goodForm(), NOW);
    expect(patch).not.toHaveProperty("htmlBody");
    expect(Object.keys(patch).sort()).toEqual(["isEnabled", "subject", "textBody"]);
  });

  it("keeps htmlBody null on the way in, even if a server ever sent one", () => {
    const loaded = responder({ textBody: "text" });
    expect(loaded.htmlBody).toBeNull();
    expect(vacationToForm(loaded).textBody).toBe("text");
  });

  it("states the reason in a string the screen can render", () => {
    expect(VACATION_PLAIN_TEXT_ONLY).toMatch(/plain text/i);
    expect(VACATION_PLAIN_TEXT_ONLY).toMatch(/discarded/i);
  });
});

describe("dates, which the server swallows rather than rejects", () => {
  it("rejects an unparseable date instead of letting the server drop it", () => {
    // dateMs falls back to the EXISTING value on anything unparseable
    // (vacation.ts:97-104) — success is reported and the old date survives.
    const { problems, patch } = vacationPatch(responder(), goodForm({ toDate: "next tuesday" }), NOW);
    expect(problems.some((p) => /End date/.test(p))).toBe(true);
    expect(patch).not.toHaveProperty("toDate");
  });

  it("treats an emptied field as an explicit clear, not an omission", () => {
    // `if (v === null) return null` (vacation.ts:98). Omitting the key would
    // keep the old bound and the window would silently outlive the edit.
    const current = responder({ isEnabled: true, toDate: "2026-08-01T00:00:00.000Z" });
    const { patch } = vacationPatch(current, goodForm({ toDate: "", subject: current.subject ?? "" }), NOW);
    expect(patch.toDate).toBeNull();
  });

  it("round-trips a local input value through ISO and back", () => {
    const parsed = fromLocalInput("2026-08-15T09:30");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(toLocalInput(parsed.iso)).toBe("2026-08-15T09:30");
  });

  it("treats an empty field as unbounded rather than as an error", () => {
    expect(fromLocalInput("   ")).toEqual({ ok: true, iso: null });
    expect(toLocalInput(null)).toBe("");
  });

  it("does not re-send a date that only changed spelling", () => {
    const current = responder({
      isEnabled: true,
      subject: "s",
      textBody: "b",
      toDate: "2026-08-15T09:30:00.000Z",
    });
    const form = vacationToForm(current);
    expect(vacationPatch(current, form, NOW).patch).toEqual({});
  });

  it("blocks a start after the end, which could never fire", () => {
    // Delivery skips a responder whose window excludes `now`
    // (services/ingest/src/index.ts:360-361), so this stores cleanly, reports
    // success, and sends nothing ever.
    const { problems } = vacationPatch(
      responder(),
      goodForm({ fromDate: "2026-09-01T09:00", toDate: "2026-08-01T09:00" }),
      NOW,
    );
    expect(problems.some((p) => /could never fire/.test(p))).toBe(true);
  });
});

describe("turning it on", () => {
  it("blocks an enabled responder with no message", () => {
    const { problems } = vacationPatch(responder(), goodForm({ textBody: "   " }), NOW);
    expect(problems.some((p) => /empty auto-reply/.test(p))).toBe(true);
  });

  it("allows an empty message while it is OFF — that is just an unfinished draft", () => {
    const { problems } = vacationPatch(responder(), goodForm({ isEnabled: false, textBody: "", subject: "" }), NOW);
    expect(problems).toEqual([]);
  });

  it("warns rather than blocks on a missing subject", () => {
    const { problems, warnings } = vacationPatch(responder(), goodForm({ subject: "" }), NOW);
    expect(problems).toEqual([]);
    expect(warnings.some((w) => /empty subject/.test(w))).toBe(true);
  });

  it("warns when the window has already closed", () => {
    const { problems, warnings } = vacationPatch(responder(), goodForm({ toDate: "2026-07-01T09:00" }), NOW);
    // Legitimate — someone may be recording a past absence — but not silent.
    expect(problems).toEqual([]);
    expect(warnings.some((w) => /already passed/.test(w))).toBe(true);
  });

  it("clears a subject with null rather than an empty string", () => {
    const current = responder({ isEnabled: false, subject: "Away", textBody: "b" });
    const { patch } = vacationPatch(current, goodForm({ isEnabled: false, subject: "", textBody: "b" }), NOW);
    expect(patch.subject).toBeNull();
  });
});

describe("vacationStatus answers what delivery will actually do", () => {
  it("is off when disabled, whatever the dates say", () => {
    const status = vacationStatus(responder({ toDate: "2099-01-01T00:00:00.000Z" }), NOW);
    expect(status.activity).toBe("off");
  });

  it("is ended when the window closed, even though the checkbox says on", () => {
    // The case a naive screen gets wrong: `isEnabled` is true and no reply will
    // ever be sent (ingest/src/index.ts:361).
    const status = vacationStatus(responder({ isEnabled: true, toDate: "2026-07-01T00:00:00.000Z" }), NOW);
    expect(status.activity).toBe("ended");
  });

  it("is scheduled when the window has not opened", () => {
    const status = vacationStatus(responder({ isEnabled: true, fromDate: "2026-09-01T00:00:00.000Z" }), NOW);
    expect(status.activity).toBe("scheduled");
  });

  it("is active inside the window", () => {
    const status = vacationStatus(
      responder({
        isEnabled: true,
        fromDate: "2026-08-01T00:00:00.000Z",
        toDate: "2026-08-20T00:00:00.000Z",
      }),
      NOW,
    );
    expect(status.activity).toBe("active");
  });

  it("is active with no bounds at all", () => {
    expect(vacationStatus(responder({ isEnabled: true }), NOW).activity).toBe("active");
  });
});

// ── server round trip ─────────────────────────────────────────────────────

describe("loadVacation", () => {
  it("normalises the singleton the server always returns", async () => {
    const client = new FakeJmapClient({
      handlers: {
        "VacationResponse/get": () => ({
          accountId: ACCOUNT,
          state: "s1",
          list: [
            {
              id: "singleton",
              isEnabled: true,
              fromDate: null,
              toDate: null,
              subject: "Away",
              textBody: "Back Monday.",
              htmlBody: null,
            },
          ],
          notFound: [],
        }),
      },
    });
    const v = await loadVacation(client, ACCOUNT);
    expect(v).toEqual({
      id: "singleton",
      isEnabled: true,
      fromDate: null,
      toDate: null,
      subject: "Away",
      textBody: "Back Monday.",
      htmlBody: null,
    });
  });
});

describe("saveVacation", () => {
  function client(): FakeJmapClient {
    return new FakeJmapClient({
      handlers: {
        "VacationResponse/set": () => ({
          accountId: ACCOUNT,
          oldState: "s1",
          newState: "s1",
          created: {},
          notCreated: {},
          updated: { singleton: null },
          notUpdated: {},
          destroyed: [],
          notDestroyed: {},
        }),
      },
    });
  }

  it("keys the update on the literal `singleton`, which the server requires", async () => {
    // `if (!patch) throw invalidArguments` where `patch = update.singleton`
    // (vacation.ts:36-39). Any other key is ignored, not rejected — so getting
    // this wrong is a silent no-op.
    const c = client();
    await saveVacation(c, ACCOUNT, { isEnabled: true });
    const args = c.sentBatches.at(-1)?.[0]?.[1] as { update?: Record<string, unknown> };
    expect(Object.keys(args.update ?? {})).toEqual(["singleton"]);
  });

  it("does NOT send ifInState, because this method does not read it", async () => {
    // The one place sVOL 024:96-99 is wrong about the server.
    // VacationResponse/set (vacation.ts:32-73) never mentions args.ifInState;
    // sending it would claim a guard that is not there. The CLI does send it
    // (packages/cli/src/main.ts:799) and it is ignored.
    const c = client();
    await saveVacation(c, ACCOUNT, { isEnabled: true });
    const args = c.sentBatches.at(-1)?.[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("ifInState");
    expect(VACATION_NO_OPTIMISTIC_GUARD).toMatch(/without warning/);
  });

  it("sends nothing at all for an empty patch", async () => {
    const c = client();
    expect(await saveVacation(c, ACCOUNT, {})).toEqual({ ok: true, noop: true });
    expect(c.sentBatches).toHaveLength(0);
  });

  it("names the scope this write charges", async () => {
    const c = new FakeJmapClient({
      handlers: {
        "VacationResponse/set": () => ["error", { type: "forbidden" }] as never,
      },
    });
    const result = await saveVacation(c, ACCOUNT, { isEnabled: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // requireAccount(ctx, args, "draft") — vacation.ts:33.
    expect(result.message).toMatch(/draft/);
  });
});

describe("the demo backend is not kinder than the server", () => {
  // demo.ts's own contract: "a fake that is kinder than the real thing hides
  // exactly the bugs it should catch" (demo.ts:11-12). For this datatype the
  // two warts that matter are the ones a settings screen would otherwise
  // develop a false belief about.

  it("accepts a stale ifInState, because VacationResponse/set does not read it", async () => {
    const demo = createDemoBackend();
    const before = demo.state();
    const res = await demo.client.requestOne("VacationResponse/set", {
      accountId: ACCOUNT,
      ifInState: "wildly-stale",
      update: { singleton: { isEnabled: true, textBody: "Back Monday." } },
    });
    // Not a stateMismatch, and the account state does not move either — the
    // real method commits no ChangeEntry (vacation.ts:34,65).
    expect(res.updated).toEqual({ singleton: null });
    expect(res.newState).toBe(before);
  });

  it("drops an htmlBody instead of storing it", async () => {
    const demo = createDemoBackend();
    await demo.client.requestOne("VacationResponse/set", {
      accountId: ACCOUNT,
      update: { singleton: { isEnabled: true, textBody: "text", htmlBody: "<b>rich</b>" } },
    });
    const v = await loadVacation(demo.client, ACCOUNT);
    expect(v.htmlBody).toBeNull();
    expect(v.textBody).toBe("text");
  });

  it("swallows an unparseable date rather than refusing it", async () => {
    // dateMs (vacation.ts:97-104). This is why fromLocalInput rejects
    // client-side: nothing downstream ever will.
    const demo = createDemoBackend();
    await demo.client.requestOne("VacationResponse/set", {
      accountId: ACCOUNT,
      update: { singleton: { toDate: "2026-08-20T00:00:00.000Z" } },
    });
    const res = await demo.client.requestOne("VacationResponse/set", {
      accountId: ACCOUNT,
      update: { singleton: { toDate: "next tuesday" } },
    });
    expect(res.updated).toEqual({ singleton: null });
    expect((await loadVacation(demo.client, ACCOUNT)).toDate).toBe("2026-08-20T00:00:00.000Z");
  });

  it("round-trips a real save, which is what /settings?demo=1 drives", async () => {
    const demo = createDemoBackend();
    const { patch } = vacationPatch(
      await loadVacation(demo.client, ACCOUNT),
      goodForm({ toDate: "2026-08-20T09:00" }),
      NOW,
    );
    expect(await saveVacation(demo.client, ACCOUNT, patch)).toEqual({ ok: true, noop: false });
    const after = await loadVacation(demo.client, ACCOUNT);
    expect(after.isEnabled).toBe(true);
    expect(after.subject).toBe("Away until Monday");
    expect(vacationStatus(after, NOW).activity).toBe("active");
  });
});
