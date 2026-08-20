import { describe, expect, it } from "vitest";
import {
  alertClasses,
  avatarClasses,
  avatarInitial,
  badgeClasses,
  buttonClasses,
  cx,
  FAB_CLEARANCE_PX,
  fabClasses,
  iconButtonClasses,
  inputClasses,
  listRowClasses,
  searchFieldClasses,
  searchYieldClasses,
  stackedListClasses,
  stackedRowClasses,
  statusDotClasses,
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
  it("active is the collection selection wash, not the ghost hover", () => {
    expect(iconButtonClasses("sm", { active: true })).toContain("bg-brand-50");
    expect(iconButtonClasses("sm")).toContain("hover:bg-gray-100");
    expect(iconButtonClasses("sm")).not.toContain("bg-brand-50");
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

describe("alert / stacked list / input (Tailwind UI ports)", () => {
  it("alert tones are distinct", () => {
    const tones = ["info", "warn", "error", "success"] as const;
    expect(new Set(tones.map((t) => alertClasses(t))).size).toBe(tones.length);
    expect(alertClasses("warn")).toContain("bg-yellow-50");
    expect(alertClasses("info")).toContain("bg-brand-50");
  });
  it("stacked list is divided; active row uses the brand wash", () => {
    expect(stackedListClasses()).toContain("divide-y");
    expect(stackedRowClasses({ active: true })).toContain("bg-brand-50");
    expect(stackedRowClasses()).toContain("hover:bg-gray-50");
  });
  it("status dots are distinct", () => {
    expect(statusDotClasses("success")).toContain("text-green-500");
    expect(statusDotClasses("error")).toContain("text-rose-500");
  });
  it("inputs outline in brand, never indigo", () => {
    expect(inputClasses()).toContain("focus:outline-brand-600");
    expect(inputClasses()).not.toContain("indigo");
  });
});

// ── s25 T5 ────────────────────────────────────────────────────────────────

describe("fabClasses", () => {
  it("is the SAME primary surface as the column's [New] — one verb, two places", () => {
    // Not "looks similar": the colour string is literally shared, so a change
    // to the standardized create button reaches the FAB without a second edit.
    expect(fabClasses()).toContain("bg-brand-600");
    expect(fabClasses()).toContain("hover:bg-brand-500");
    expect(buttonClasses("primary")).toContain("bg-brand-600");
  });

  it("is phone-only — the desktop keeps exactly one create affordance", () => {
    expect(fabClasses()).toContain("lg:hidden");
  });

  it("floats in the thumb zone, above the safe-area inset", () => {
    expect(fabClasses()).toContain("fixed");
    expect(fabClasses()).toContain("right-4");
    expect(fabClasses()).toContain("bottom-4");
    expect(fabClasses()).toContain("mb-[env(safe-area-inset-bottom)]");
  });

  it("keeps the shared focus ring and the disabled treatment", () => {
    expect(fabClasses()).toContain("focus-visible:outline-2");
    expect(fabClasses()).toContain("disabled:opacity-50");
  });

  it("carries no inline style (CSP: style-src has no 'unsafe-inline')", () => {
    expect(fabClasses()).not.toMatch(/style\s*=|;\s*$/);
  });

  it("reserves real clearance, so the button never covers the last row", () => {
    expect(FAB_CLEARANCE_PX).toBeGreaterThan(56);
  });
});

describe("the collapsing search (s25 T5)", () => {
  it("hides the field below lg ONLY while collapsed; desktop always shows it", () => {
    expect(searchFieldClasses(false)).toContain("max-lg:hidden");
    expect(searchFieldClasses(true)).not.toContain("hidden");
    expect(searchFieldClasses(true)).toContain("flex");
  });

  it("hides with a VARIANT, never a bare `hidden` fighting a bare `flex`", () => {
    // Two unvariant display utilities resolve by Tailwind's source order, not
    // by the order they were typed. `max-lg:` always beats the base, so the
    // breakpoint decides.
    expect(searchFieldClasses(false).split(" ")).not.toContain("hidden");
  });

  it("the header yields only on narrow screens, and only while expanded", () => {
    expect(searchYieldClasses(true)).toBe("max-lg:hidden");
    expect(searchYieldClasses(false)).toBe("");
  });
});
