import { describe, expect, it } from "vitest";
import { cardsFromInput, serializeVcard } from "./contacts.js";
import { parseVcf, type Card } from "./vcard.js";
import type { Input } from "./io.js";

/**
 * sVOL 017 — the CLI's contacts write surface. Two pure pieces carry the
 * correctness weight and can be tested without a server:
 *
 *   - `serializeVcard`  — the JSContact → vCard direction `export` needs and
 *                         that `import` (parseVcf) did not have. The cheapest
 *                         correctness test s05/devPlan.md names is the round
 *                         trip: parse → serialize → parse must not drift.
 *   - `cardsFromInput`  — the stdin dispatch for `create`/`edit`: vCard, one
 *                         JSON object, or an array of them; anything else is a
 *                         usage error that names `--as`.
 *
 * The command handlers themselves go over JMAP and are covered by the
 * composition smoke script (`smoke/contract.mjs`) against a real pipe.
 */

const input = (text: string, type: Input["type"]): Input => ({ text, type, from: "(test)" });

const SAMPLE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Ada Lovelace",
  "N:Lovelace;Ada;;;",
  "NICKNAME:Countess",
  "ORG:Analytical Engines;R&D",
  "TITLE:Mathematician",
  "EMAIL;TYPE=WORK:ada@example.com",
  "TEL;TYPE=CELL:+15550100",
  "CATEGORIES:pioneers,math",
  "UID:urn:uuid:ada-1",
  "END:VCARD",
  "",
].join("\r\n");

describe("serializeVcard", () => {
  it("emits a well-formed vCard 3.0 with the mandatory lines", () => {
    const card: Card = { "@type": "Card", uid: "u-1", name: { full: "Grace Hopper" } };
    const vcf = serializeVcard(card);
    expect(vcf.startsWith("BEGIN:VCARD\r\n")).toBe(true);
    expect(vcf.includes("VERSION:3.0")).toBe(true);
    expect(vcf.includes("FN:Grace Hopper")).toBe(true);
    expect(vcf.includes("UID:u-1")).toBe(true);
    expect(vcf.trimEnd().endsWith("END:VCARD")).toBe(true);
  });

  it("synthesises FN from the organization when there is no name", () => {
    const card: Card = { uid: "u-2", organizations: { o1: { name: "Bell Labs" } } };
    expect(serializeVcard(card)).toContain("FN:Bell Labs");
  });

  it("escapes the structured and text separators", () => {
    const card: Card = { uid: "u-3", name: { full: "Doe; John, Jr." } };
    expect(serializeVcard(card)).toContain("FN:Doe\\; John\\, Jr.");
  });
});

describe("import → export → import round-trips without drift", () => {
  it("preserves uid, name, org, email, phone and keywords", () => {
    const first = parseVcf(SAMPLE).cards[0]!;
    const second = parseVcf(serializeVcard(first)).cards[0]!;

    // The identifying content survives the trip both ways.
    expect(second.uid).toBe("urn:uuid:ada-1");
    expect((second.name as { full?: string }).full).toBe("Ada Lovelace");
    const email = Object.values(second.emails as Record<string, { address?: string }>)[0];
    expect(email?.address).toBe("ada@example.com");
    const phone = Object.values(second.phones as Record<string, { number?: string }>)[0];
    expect(phone?.number).toBe("+15550100");
    const org = Object.values(second.organizations as Record<string, { name?: string }>)[0];
    expect(org?.name).toBe("Analytical Engines");
    expect(Object.keys(second.keywords as Record<string, boolean>).sort()).toEqual(["math", "pioneers"]);
  });

  it("is stable — a second export equals the first", () => {
    const card = parseVcf(SAMPLE).cards[0]!;
    const once = serializeVcard(card);
    const twice = serializeVcard(parseVcf(once).cards[0]!);
    expect(twice).toBe(once);
  });
});

describe("cardsFromInput", () => {
  it("parses a vCard body into cards", () => {
    const cards = cardsFromInput(input(SAMPLE, "vcard"));
    expect(cards).toHaveLength(1);
    expect((cards[0]!.name as { full?: string }).full).toBe("Ada Lovelace");
  });

  it("accepts a single JSON object", () => {
    const cards = cardsFromInput(input('{"name":{"full":"Ada"}}', "json"));
    expect(cards).toHaveLength(1);
    expect((cards[0]!.name as { full?: string }).full).toBe("Ada");
  });

  it("accepts a JSON array of cards", () => {
    const cards = cardsFromInput(input('[{"uid":"a"},{"uid":"b"}]', "json"));
    expect(cards.map((c) => c.uid)).toEqual(["a", "b"]);
  });

  it("rejects a non-contact content type, naming --as", () => {
    expect(() => cardsFromInput(input("just some words", "text"))).toThrow(/--as/);
  });

  it("rejects malformed JSON as a usage error", () => {
    expect(() => cardsFromInput(input("{ not json", "json"))).toThrow(/not valid JSON/);
  });

  it("rejects a JSON array element that is not an object", () => {
    expect(() => cardsFromInput(input('[{"uid":"a"}, 3]', "json"))).toThrow(/must be a JSON object/);
  });
});
