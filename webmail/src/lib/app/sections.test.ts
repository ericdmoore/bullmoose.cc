import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECTIONS, sectionById, type SectionId } from "./sections";

const PAGES = fileURLToPath(new URL("../../pages/", import.meta.url));
const pageNames = () =>
  new Set(
    readdirSync(PAGES)
      .filter((f) => f.endsWith(".astro"))
      .map((f) => f.replace(/\.astro$/, "")),
  );

const ids = () => SECTIONS.map((s) => s.id);
const at = (id: SectionId) => ids().indexOf(id);

describe("the eight sections", () => {
  it("is exactly the eight nouns", () => {
    expect(new Set(ids())).toEqual(
      new Set([
        "approvals",
        "agents",
        "calendar",
        "mail",
        "contacts",
        "files",
        "search",
        "settings",
      ]),
    );
    expect(SECTIONS).toHaveLength(8);
  });

  it("does not contain a section for `/` — home is a view, not a noun", () => {
    // s07 T0: `/` is Looking Ahead + Waiting Approvals. A "Home" nav item is
    // the first step back towards a dashboard of counts.
    expect(ids()).not.toContain("home");
    for (const s of SECTIONS) expect(s.href).not.toBe("/");
  });

  it("gives every section a distinct href under its own id", () => {
    for (const s of SECTIONS) expect(s.href).toBe(`/${s.id}`);
    expect(new Set(SECTIONS.map((s) => s.href)).size).toBe(SECTIONS.length);
  });

  it("finds a section by id", () => {
    expect(sectionById("mail")?.label).toBe("Mail");
    expect(sectionById("nope")).toBeUndefined();
  });
});

describe("the ORDER is the claim", () => {
  // The s07 devPlan's "What this is NOT": this is a decision-centric
  // collaboration space, so what needs a decision comes first and storage
  // comes late. These assertions are the claim in executable form — reorder
  // the nav and you have to come here and argue with them.

  it("leads with the queue: what needs me, and who is asking", () => {
    expect(ids()[0]).toBe("approvals");
    expect(ids()[1]).toBe("agents");
  });

  it("does NOT lead with mail — that would be a mail client with extras", () => {
    expect(ids()[0]).not.toBe("mail");
    expect(at("calendar")).toBeLessThan(at("mail"));
  });

  it("puts files behind mail and contacts — this is not Drive with agents", () => {
    expect(at("files")).toBeGreaterThan(at("mail"));
    expect(at("files")).toBeGreaterThan(at("contacts"));
  });

  it("ends with the tools, which are verbs over the nouns rather than nouns", () => {
    expect(ids().slice(-2)).toEqual(["search", "settings"]);
  });
});

describe("nothing is a dead link and nothing 404s", () => {
  it("has a page behind every live section", () => {
    const pages = pageNames();
    for (const s of SECTIONS) {
      if (s.status === "live") expect(pages.has(s.id), `${s.href} has no page`).toBe(true);
    }
  });

  it("marks any section that has NO page as planned", () => {
    // The other direction, and the one that rots: ship `/settings` and forget
    // this map, and the nav keeps it greyed out with a stale excuse under a
    // page that works.
    const pages = pageNames();
    for (const s of SECTIONS) {
      if (!pages.has(s.id)) expect(s.status, `${s.href} is dark but not marked`).toBe("planned");
    }
  });

  it("gives every disabled section a visible reason and a full explanation", () => {
    for (const s of SECTIONS) {
      if (s.status !== "planned") continue;
      expect(s.reason.length, `${s.id} reason`).toBeGreaterThan(0);
      // Short enough to sit under the label in the bar. A reason that has to
      // be truncated is a tooltip, and a tooltip does not exist on a phone.
      expect(s.reason.length, `${s.id} reason is too long for the nav`).toBeLessThanOrEqual(40);
      expect(s.detail.length, `${s.id} detail`).toBeGreaterThan(40);
      expect(s.reason).not.toMatch(/coming soon/i);
    }
  });
});
