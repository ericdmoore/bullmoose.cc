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

describe("the nine sections", () => {
  it("is exactly the nine nouns", () => {
    expect(new Set(ids())).toEqual(
      new Set(["approvals", "agents", "activity", "calendar", "mail", "contacts", "files", "search", "settings"]),
    );
    expect(SECTIONS).toHaveLength(9);
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

  it("keeps activity in the first cluster — accountability, not history-of-time", () => {
    // s23: activity is the retrospective twin of approvals. After `calendar`
    // it reads as a timeline; next to `settings` it reads as a debug log.
    // Between agents and calendar it reads as what it is: the record of what
    // was decided in your name.
    expect(ids()[2]).toBe("activity");
    expect(at("activity")).toBeLessThan(at("calendar"));
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
    const pages = pageNames();
    for (const s of SECTIONS) {
      if (!pages.has(s.id)) expect(s.status, `${s.href} is dark but not marked`).toBe("planned");
    }
  });

  it("marks any section that HAS a page as live", () => {
    // The direction that rots, and the one this file previously only claimed
    // to check: ship `/settings` and forget this map, and the nav keeps the
    // section greyed out with a stale excuse sitting over a page that works.
    //
    // The assertion above does not catch that — "no page ⇒ planned" and
    // "live ⇒ has a page" are the same implication written twice, and both
    // stay green while a built page is marked dark. s07 T2 hit exactly this:
    // `settings.astro` existed and every check here passed with `/settings`
    // still advertising "screen not built".
    const pages = pageNames();
    for (const s of SECTIONS) {
      if (pages.has(s.id)) expect(s.status, `${s.href} has a page but is marked dark`).toBe("live");
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
