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
// These are structural. The behavioural cross-domain test (a calendar-scoped
// token refused a contacts tool) arrives with sVOL 013, which is the first
// unit to add a tool that is not ("read", "mail").

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

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    "%s uses a scope from the real vocabulary",
    (_name, tool) => {
      // Catches a typo like "calender" or "readonly", which `authorizeAccount`
      // would simply deny — a tool nobody can call, failing closed but silently.
      expect(VALID_SCOPES.has(tool.scope)).toBe(true);
      expect(VALID_DOMAINS.has(tool.domain)).toBe(true);
    },
  );

  it("declares no tool more permissive than the mail bundle", () => {
    // Nothing on this surface should require "mail" wholesale, and nothing
    // should require "admin" — the control plane is not reachable over MCP.
    for (const tool of TOOLS) {
      expect(tool.scope).not.toBe("admin");
      expect(tool.scope).not.toBe("mail");
    }
  });

  it("the current surface is read-only, matching the module's own docstring", () => {
    // mcp.ts's header calls this "a READ-ONLY tool surface". If a write tool
    // lands, this fails — and the docstring, the tools/list description, and
    // the s01 arch notes all need revisiting together.
    for (const tool of TOOLS) expect(tool.scope).toBe("read");
  });
});

describe("the declared scopes are meaningful post-common/001", () => {
  it("a token holding only a realm scope cannot reach a mail tool", () => {
    // Before common/001, ["contacts"] would NOT have satisfied "read" either —
    // but ["mail"] satisfied literally everything. This asserts the gate is
    // now a real partition.
    const mailTool = TOOLS.find((t) => t.domain === "mail");
    expect(mailTool).toBeDefined();
    expect(hasScope(["contacts"], mailTool!.scope)).toBe(false);
    expect(hasScope(["mail"], mailTool!.scope)).toBe(true);
  });
});
