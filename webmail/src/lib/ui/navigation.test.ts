import { describe, expect, it, vi } from "vitest";
import { isUnmodifiedPrimaryClick, syncDetailUrl } from "./navigation";

// The rule that ends the href-XOR-onSelect split. Mail had this hand-rolled in
// ThreadListView and nobody else could reach it, so Contacts and Approvals
// full-page-reloaded on every click while Files, Notes, Calendar, Goals,
// Agents and Activity had no shareable URL at all.

describe("isUnmodifiedPrimaryClick", () => {
  it("1. a plain left-click stays in the page", () => {
    expect(isUnmodifiedPrimaryClick({ button: 0 })).toBe(true);
    expect(isUnmodifiedPrimaryClick({})).toBe(true); // button omitted === 0
  });

  it("2. every modifier belongs to the browser, not to us", () => {
    // Each of these is a deliberate request for native behaviour — new tab,
    // new window, download. preventDefault on any of them silently breaks a
    // gesture the reader meant, and leaves no trace that it did.
    expect(isUnmodifiedPrimaryClick({ metaKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ ctrlKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ shiftKey: true })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ altKey: true })).toBe(false);
  });

  it("3. middle- and right-click are not ours either", () => {
    expect(isUnmodifiedPrimaryClick({ button: 1 })).toBe(false);
    expect(isUnmodifiedPrimaryClick({ button: 2 })).toBe(false);
  });
});

describe("syncDetailUrl", () => {
  function withHistory(href: string) {
    const calls: string[] = [];
    vi.stubGlobal("location", { href, origin: new URL(href).origin });
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => calls.push(url),
    });
    return calls;
  }

  it("10. points the address bar at what is on screen", () => {
    const calls = withHistory("https://app.bullmoose.cc/mail/");
    expect(syncDetailUrl("/mail?thread=T1")).toBe(true);
    expect(calls).toEqual(["/mail?thread=T1"]);
  });

  it("11. replaces — never pushes — so Back still leaves the realm", () => {
    // Pushing would make the browser's Back button walk backwards through
    // every row the reader glanced at. The in-app Back is the modelled exit,
    // and it is always visible by design.
    const calls = withHistory("https://app.bullmoose.cc/contacts/");
    syncDetailUrl("/contacts?card=c1");
    expect(calls).toHaveLength(1);
    expect(globalThis.history).not.toHaveProperty("pushState");
  });

  it("12. refuses to send the address bar to another origin", () => {
    const calls = withHistory("https://app.bullmoose.cc/mail/");
    expect(syncDetailUrl("https://evil.example/mail?thread=T1")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("13. a browser that refuses replaceState does not take the app down", () => {
    vi.stubGlobal("location", { href: "https://app.bullmoose.cc/mail/", origin: "https://app.bullmoose.cc" });
    vi.stubGlobal("history", {
      state: null,
      replaceState: () => {
        throw new Error("SecurityError: sandboxed frame");
      },
    });
    expect(syncDetailUrl("/mail?thread=T1")).toBe(false);
  });
});
