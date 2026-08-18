import { describe, expect, it } from "vitest";
import {
  avatarClasses,
  avatarInitial,
  badgeClasses,
  buttonClasses,
  cx,
  iconButtonClasses,
  listRowClasses,
} from "./classes";

// s24 T0 — the pure class-logic behind the primitives. These are the tested
// functions; the components are markup over them (render tests live beside the
// components). What matters here is the CONTRACT: variants differ, defaults
// hold, and the strings carry the classes the design leans on.

describe("cx", () => {
  it("joins fragments and drops the falsy", () => {
    expect(cx("a", false, "b", undefined, null, "c")).toBe("a b c");
    expect(cx()).toBe("");
  });
});

describe("buttonClasses", () => {
  it("defaults to secondary/md", () => {
    expect(buttonClasses()).toBe(buttonClasses("secondary", "md"));
  });
  it("primary is the brand [New] treatment; variants are distinct", () => {
    const primary = buttonClasses("primary");
    expect(primary).toContain("bg-brand-600");
    const all = ["primary", "secondary", "ghost", "danger"].map((v) => buttonClasses(v as never));
    expect(new Set(all).size).toBe(4);
  });
  it("every variant keeps the shared base (focus ring, disabled state)", () => {
    for (const v of ["primary", "secondary", "ghost", "danger"] as const) {
      expect(buttonClasses(v)).toContain("focus-visible:outline-2");
      expect(buttonClasses(v)).toContain("disabled:opacity-50");
    }
  });
  it("sizes differ", () => {
    expect(buttonClasses("primary", "sm")).not.toBe(buttonClasses("primary", "md"));
  });
});

describe("iconButtonClasses", () => {
  it("is square-padded, not text-padded", () => {
    expect(iconButtonClasses("md")).toContain("p-1.5");
    expect(iconButtonClasses("sm")).toContain("p-1");
  });
});

describe("badgeClasses", () => {
  it("tones are distinct and default is neutral", () => {
    const tones = ["neutral", "accent", "warn", "error", "success"] as const;
    expect(new Set(tones.map((t) => badgeClasses(t))).size).toBe(tones.length);
    expect(badgeClasses()).toBe(badgeClasses("neutral"));
  });
});

describe("avatar", () => {
  it("sizes differ; default md", () => {
    expect(avatarClasses("sm")).not.toBe(avatarClasses("lg"));
    expect(avatarClasses()).toBe(avatarClasses("md"));
  });
  it("initial: first letter uppercased; '?' for empty/unknown (the ShellNav convention)", () => {
    expect(avatarInitial("eric@bullmoose.cc")).toBe("E");
    expect(avatarInitial("  grace ")).toBe("G");
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial(undefined)).toBe("?");
    expect(avatarInitial(null)).toBe("?");
  });
});

describe("listRowClasses", () => {
  it("active is the approvals selection treatment; inactive hovers", () => {
    expect(listRowClasses({ active: true })).toContain("bg-brand-50");
    expect(listRowClasses()).toContain("hover:bg-gray-50");
  });
  it("muted drops the strong foreground", () => {
    expect(listRowClasses({ muted: true })).toContain("text-gray-500");
    expect(listRowClasses()).toContain("text-gray-900");
  });
});
