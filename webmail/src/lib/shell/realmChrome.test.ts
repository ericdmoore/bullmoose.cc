import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALM_CHROME_EVENT,
  REALM_PICK_EVENT,
  currentRealmChrome,
  isRenderableControl,
  pickRealmChrome,
  publishRealmChrome,
  readRealmPick,
  type RealmChromeControl,
} from "./realmChrome";

// s34 — the realm-chrome contract, driven with the same recorded event sink
// publish.test.ts uses. What these tests hold is the whole data diet of the
// picker ShellNav renders beside the identity chip: the surface publishes, the
// chrome renders exactly what is renderable, and the pick comes back as an
// event with no navigation in it.

let events: CustomEvent[];

beforeEach(() => {
  events = [];
  vi.stubGlobal("dispatchEvent", (ev: Event) => {
    events.push(ev as CustomEvent);
    return true;
  });
  publishRealmChrome(undefined);
  events = [];
});
afterEach(() => {
  publishRealmChrome(undefined);
  vi.unstubAllGlobals();
});

const CONTROL: RealmChromeControl = {
  realm: "contacts",
  label: "Account",
  options: [
    { id: "acct-mine", label: "eric@bullmoose.cc" },
    { id: "acct-shared", label: "family@bullmoose.cc (shared)" },
  ],
  selectedId: "acct-mine",
};

describe("publishRealmChrome / currentRealmChrome", () => {
  it("latches the control so a LATER-mounting chrome still sees it", () => {
    // The whole reason the latch exists: two client:only islands hydrate in
    // an order nobody controls, so the event alone would be missed half the
    // time (see the module header).
    publishRealmChrome(CONTROL);
    expect(currentRealmChrome()).toEqual(CONTROL);
  });

  it("dispatches bm:realm-chrome naming the realm, so a MOUNTED chrome repaints", () => {
    publishRealmChrome(CONTROL);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(REALM_CHROME_EVENT);
    expect(events[0]!.detail).toEqual({ realm: "contacts" });
  });

  it("copies the options, so a later mutation of the caller's array cannot leak in", () => {
    const options = [...CONTROL.options];
    publishRealmChrome({ ...CONTROL, options });
    options.push({ id: "acct-surprise", label: "not published" });
    expect(currentRealmChrome()?.options).toHaveLength(2);
  });

  it("withdraws with undefined — a surface leaving takes its control with it", () => {
    publishRealmChrome(CONTROL);
    publishRealmChrome(undefined);
    expect(currentRealmChrome()).toBeUndefined();
    expect(events.at(-1)!.detail).toEqual({ realm: undefined });
  });

  it("never persists — this is not publish.ts", () => {
    // A collection record survives the page because the tray reads it from
    // ANY page. A realm control is meaningful only where its island is, so
    // storing it would put a Contacts picker in Mail's header.
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem: () => {} });
    publishRealmChrome(CONTROL);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("survives an environment with no CustomEvent at all", () => {
    vi.stubGlobal("dispatchEvent", undefined);
    expect(() => publishRealmChrome(CONTROL)).not.toThrow();
    expect(currentRealmChrome()).toEqual(CONTROL);
  });
});

describe("isRenderableControl — what the chrome is allowed to draw", () => {
  it("renders the active realm's control", () => {
    expect(isRenderableControl(CONTROL, "contacts")).toBe(true);
  });

  it("refuses a control belonging to a realm you are not standing in", () => {
    expect(isRenderableControl(CONTROL, "mail")).toBe(false);
  });

  it("refuses a picker with nothing to pick between", () => {
    // A one-option dropdown is a label pretending to be a choice — and it is
    // the single-account session, which is most of them.
    expect(isRenderableControl({ ...CONTROL, options: [CONTROL.options[0]!] }, "contacts")).toBe(false);
    expect(isRenderableControl({ ...CONTROL, options: [] }, "contacts")).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(isRenderableControl(undefined, "contacts")).toBe(false);
  });

  it("a chrome with no section renders whatever realm published", () => {
    expect(isRenderableControl(CONTROL, undefined)).toBe(true);
  });
});

describe("pickRealmChrome / readRealmPick — the way back", () => {
  it("dispatches the pick as a plain event: no navigation, no history, no form", () => {
    pickRealmChrome("contacts", "acct-shared");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(REALM_PICK_EVENT);
    expect(events[0]!.detail).toEqual({ realm: "contacts", id: "acct-shared" });
  });

  it("round-trips through the surface's reader", () => {
    pickRealmChrome("contacts", "acct-shared");
    expect(readRealmPick(events[0]!, "contacts")).toBe("acct-shared");
  });

  it("a pick for ANOTHER realm reads as nothing — a surface must not act on it", () => {
    pickRealmChrome("agents", "binding-1");
    expect(readRealmPick(events[0]!, "contacts")).toBeUndefined();
  });

  it("a malformed or empty detail reads as nothing rather than as an id", () => {
    expect(readRealmPick(new CustomEvent(REALM_PICK_EVENT), "contacts")).toBeUndefined();
    expect(
      readRealmPick(new CustomEvent(REALM_PICK_EVENT, { detail: { realm: "contacts" } }), "contacts"),
    ).toBeUndefined();
    expect(
      readRealmPick(new CustomEvent(REALM_PICK_EVENT, { detail: { realm: "contacts", id: "" } }), "contacts"),
    ).toBeUndefined();
    expect(
      readRealmPick(new CustomEvent(REALM_PICK_EVENT, { detail: { realm: "contacts", id: 7 } }), "contacts"),
    ).toBeUndefined();
  });

  it("survives an environment with no dispatchEvent", () => {
    vi.stubGlobal("dispatchEvent", undefined);
    expect(() => pickRealmChrome("contacts", "acct-mine")).not.toThrow();
  });
});
