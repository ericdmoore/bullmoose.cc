import { describe, expect, it } from "vitest";
import {
  alertClasses,
  avatarClasses,
  avatarInitial,
  badgeClasses,
  buttonClasses,
  createLabelClasses,
  cx,
  FAB_CLEARANCE_PX,
  fabClasses,
  iconButtonClasses,
  inputClasses,
  listRowClasses,
  realmSelectClasses,
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

describe("the collapsing search", () => {
  const tokens = (open: boolean) => searchFieldClasses(open).split(" ");

  it("is a magnifier at rest and a field when opened — at EVERY width", () => {
    // s25 T5 gated this to below `lg`; the desktop header kept a permanently
    // expanded input whose placeholder taught query syntax. Chrome recedes
    // until asked, on desktop too — so no breakpoint variant may appear.
    expect(searchFieldClasses(false)).not.toContain("max-lg");
    expect(searchFieldClasses(true)).not.toContain("max-lg");
    expect(tokens(false)).toContain("max-w-0");
    expect(tokens(true)).toContain("max-w-4xl");
  });

  it("collapses by WIDTH, never by display — `display:none` cannot animate", () => {
    // And a hidden field would still hold its value, but width keeps the
    // element laid out, which is what lets it sweep open instead of appear.
    // Checked as TOKENS: `overflow-hidden` contains the substring "hidden"
    // and a substring assertion here would pass for the wrong reason.
    expect(tokens(false)).not.toContain("hidden");
    expect(tokens(true)).not.toContain("hidden");
    expect(tokens(false)).toContain("flex");
    expect(tokens(true)).toContain("flex");
  });

  it("emits exactly one display utility in both states", () => {
    const DISPLAY = ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "hidden", "contents"];
    for (const open of [true, false]) {
      expect(tokens(open).filter((t) => DISPLAY.includes(t))).toEqual(["flex"]);
    }
  });

  it("animates, and does not for a reader who asked it not to", () => {
    expect(searchFieldClasses(true)).toContain("transition-[max-width,opacity]");
    expect(searchFieldClasses(true)).toContain("motion-reduce:transition-none");
  });

  it("the header yields the whole bar while expanded, and only then", () => {
    expect(searchYieldClasses(true)).toBe("hidden");
    expect(searchYieldClasses(false)).toBe("");
  });
});

// ── s34: the [New] label, and the realm chrome picker ──────────────────────

describe("a button label never wraps (s34)", () => {
  it("every variant/size carries whitespace-nowrap and min-w-0", () => {
    // "+ New / contact" across two lines in the w-56 collection column is the
    // bug this pins (Eric's /contacts screenshot). `min-w-0` is what lets the
    // button shrink so the label's truncate can ellipsis instead of overflow.
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      for (const size of ["sm", "md"] as const) {
        expect(buttonClasses(variant, size)).toContain("whitespace-nowrap");
        expect(buttonClasses(variant, size)).toContain("min-w-0");
      }
    }
  });

  it("createLabelClasses truncates rather than wrapping", () => {
    expect(createLabelClasses()).toContain("truncate");
    expect(createLabelClasses()).toContain("min-w-0");
  });

  it("does NOT change the FAB, whose label is the whole point of it", () => {
    // s25 T5 / #205: the extended FAB is shrink-to-fit and fixed-position, so
    // it has nothing to truncate against and keeps its own nowrap.
    expect(fabClasses()).toContain("lg:hidden");
    expect(fabClasses()).not.toContain("truncate");
    expect(FAB_CLEARANCE_PX).toBe(72);
  });
});

describe("realmSelectClasses (s34)", () => {
  it("clamps its width so a long account name cannot push the identity chip off the bar", () => {
    expect(realmSelectClasses()).toContain("max-w-40");
    expect(realmSelectClasses()).toContain("truncate");
  });

  it("carries a dark-mode surface, like every other header control", () => {
    expect(realmSelectClasses()).toContain("dark:");
  });
});
