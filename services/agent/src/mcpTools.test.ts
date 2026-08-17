import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasScope, MAIL_SCOPES, REALM_SCOPES } from "@bullmoose/auth-core";
import { TOOLS } from "./mcp";

// Guard for .plans/sVOL-CapSurNoun/001 — per-tool scope + domain on ToolDef.
//
// `handleToolCall` hardcoded authorizeAccount(principal, accountId, "read",
// "mail") for EVERY tool. Harmless while the surface was four read-only
// analytics tools, but not a gate: a write tool added under it would have been
// authorized as a READ on MAIL.
//
// These are structural. The behavioural cases — a create refused to a
// read-only token, a contacts tool refused to a calendar-scoped one — landed
// with sVOL 013 and live in mcpNouns.test.ts, which drives them through
// handleMcp rather than reading a declaration.

const VALID_SCOPES = new Set<string>([...MAIL_SCOPES, ...REALM_SCOPES, "mail", "admin"]);
const VALID_DOMAINS = new Set(["mail", "contacts", "calendar"]);

describe("every MCP tool declares its own gate", () => {
  it("has tools to check", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))("%s declares scope and domain", (_name, tool) => {
    expect(typeof tool.scope).toBe("string");
    expect(tool.scope.length).toBeGreaterThan(0);
    expect(typeof tool.domain).toBe("string");
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))("%s uses a scope from the real vocabulary", (_name, tool) => {
    // Catches a typo like "calender" or "readonly", which `authorizeAccount`
    // would simply deny — a tool nobody can call, failing closed but silently.
    expect(VALID_SCOPES.has(tool.scope)).toBe(true);
    expect(VALID_DOMAINS.has(tool.domain)).toBe(true);
  });

  it("declares no tool more permissive than the mail bundle", () => {
    // Nothing on this surface should require "mail" wholesale, and nothing
    // should require "admin" — the control plane is not reachable over MCP.
    for (const tool of TOOLS) {
      expect(tool.scope).not.toBe("admin");
      expect(tool.scope).not.toBe("mail");
    }
  });

  // ---- the read-only tripwire, after sVOL 013 fired it -------------------
  //
  // This used to read: "the current surface is read-only, matching the
  // module's own docstring", asserting `tool.scope === "read"` for every tool.
  // It was deliberately built to fail the moment a write tool landed, so that
  // the declaration, mcp.ts's docstring and the server/discover text would be
  // revisited together instead of drifting apart. `013` landed ten calendar
  // and contacts tools, four of them writes, and fired it exactly as intended.
  //
  // Deleting it would have thrown away the coupling, so what replaces it keeps
  // the same property in both directions: the write surface is an explicit
  // frozen inventory (you cannot add a write tool without editing this file),
  // and the prose that describes the surface is asserted against the surface
  // itself rather than trusted.

  const writeTools = TOOLS.filter((t) => t.scope !== "read");

  it("the write surface is exactly the nouns 013 and 014 shipped", () => {
    // Extended by sVOL 014 with the four Email triage writes. The tripwire
    // works as designed: adding a write tool fails this list until someone
    // states it here, which is the point — the inventory is the review.
    expect(writeTools.map((t) => t.name).sort()).toEqual([
      "calendar_create_event",
      "calendar_delete_event",
      "calendar_update_event",
      "contacts_create_card",
      "contacts_delete_card",
      "contacts_update_card",
      "email_create_draft",
      "email_destroy",
      "email_move",
      "email_set_keywords",
    ]);
  });

  it("no longer calls itself a read-only surface", () => {
    // The other half of the old assertion's job. Reading the module's own
    // source is the cheapest way to keep a docstring honest about a fact the
    // test can check — and this is the exact sentence that was wrong the
    // moment the first write tool shipped.
    const src = readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
    expect(writeTools.length).toBeGreaterThan(0);
    expect(src).not.toContain("READ-ONLY tool surface");
  });

  it("realm writes take the domain-named scope, never a mail lattice verb", () => {
    // `_context.md` §4: calendar and contacts do NOT use
    // `read < annotate < draft < move < send < delete`. One scope named after
    // the domain covers create, update AND delete. A write tool declaring
    // `draft` or `delete` would be inventing a mapping the methods do not
    // honour — it would gate on a scope no calendar method ever checks.
    for (const tool of writeTools) {
      if (tool.domain === "mail") continue;
      expect(tool.scope).toBe(tool.domain);
    }
  });

  it("mail writes take a lattice verb, and the SPECIFIC one for the operation", () => {
    // The other half of the same rule, and the inverse mistake: mail is the
    // one domain that DOES use the lattice, so a mail write must name the
    // verb for what it does rather than the domain. `Email/set` derives the
    // same scope per operation (`requiredScopesForEmailSet`), so a tool that
    // blanket-declared `draft` would be BOTH wider than the operation and out
    // of step with the method it calls.
    const mailWrites = writeTools.filter((t) => t.domain === "mail");
    expect(Object.fromEntries(mailWrites.map((t) => [t.name, t.scope]))).toEqual({
      email_set_keywords: "annotate",
      email_move: "move",
      email_create_draft: "draft",
      email_destroy: "delete",
    });
  });

  it("no tool anywhere declares `send` — sVOL 014's chosen invariant", () => {
    // sending stays a human click; asserted over the table rather than left
    // as a convention. See emailTools.ts for the three reasons.
    expect(TOOLS.filter((t) => t.scope === "send")).toEqual([]);
  });

  it("reads take `read` in their own domain, on every domain", () => {
    for (const tool of TOOLS) {
      if (writeTools.includes(tool)) continue;
      expect(tool.scope).toBe("read");
    }
    // And the read/write split covers every noun domain, not just one.
    expect(new Set(writeTools.map((t) => t.domain))).toEqual(new Set(["calendar", "contacts", "mail"]));
  });
});

describe("the declared scopes are meaningful post-common/001 + 027", () => {
  it("a realm scope reaches mail READS but is still refused mail WRITES", () => {
    // common/001 killed the ["mail"] wildcard. common/027 then opened ONE edge:
    // any write/realm capability implies `read`. So a realm token now DOES
    // satisfy a mail READ tool — but a mail WRITE tool gates on a mail verb the
    // realm never confers, so the partition still bites where it matters.
    const mailRead = TOOLS.find((t) => t.domain === "mail" && t.scope === "read");
    const mailWrite = TOOLS.find((t) => t.domain === "mail" && t.scope !== "read");
    expect(mailRead).toBeDefined();
    expect(mailWrite).toBeDefined();
    expect(hasScope(["contacts"], mailRead!.scope)).toBe(true); // 027: read is implied
    expect(hasScope(["contacts"], mailWrite!.scope)).toBe(false); // but not the write verb
    expect(hasScope(["mail"], mailWrite!.scope)).toBe(true);
  });
});
