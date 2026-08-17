import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import worker from "./index";
import { MCP_DOCS } from "./docs";
import { protectedResourceMetadata } from "./wellKnown";

// The documentation the discovery chain promises. The bug these exist to stop
// already happened once: `resource_documentation` advertised
// https://bullmoose.cc/docs/mcp, which returned 200 and served the marketing
// homepage, because the Astro site answers unknown paths with a catch-all.
// That is worse than a 404 — the reader lands on a plausible page, gets no
// answer, and nothing signals the mistake.

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const get = (path: string) => new Request(`https://mcp.bullmoose.cc${path}`, { method: "GET" });

describe("the docs the PRM points at actually exist", () => {
  it("1. resource_documentation resolves on THIS worker", async () => {
    // The coupling: follow the pointer the discovery document publishes and
    // require that something real is there.
    const meta = protectedResourceMetadata(new URL("https://mcp.bullmoose.cc/mcp"), fakeEnv().env);
    const url = new URL(meta.resource_documentation as string);
    expect(url.origin).toBe("https://mcp.bullmoose.cc");
    const res = await worker.fetch!(get(url.pathname), fakeEnv().env, ctx);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(500);
  });

  it("2. is served as markdown, so both a human and a model can read it", async () => {
    const res = await worker.fetch!(get("/docs"), fakeEnv().env, ctx);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });

  it("3. the ROOT serves the docs too — the first thing anyone opens", async () => {
    const res = await worker.fetch!(get("/"), fakeEnv().env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bullmoose MCP");
  });

  it("4. /health keeps the bare identifier for anything watching it", async () => {
    const res = await worker.fetch!(get("/health"), fakeEnv().env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bullmoose-agent");
  });

  it("5. an unknown path is still a 404", async () => {
    expect((await worker.fetch!(get("/nope"), fakeEnv().env, ctx)).status).toBe(404);
  });
});

describe("the docs tell the truth about the surface", () => {
  // Documentation drifts silently. These pin the claims that would actively
  // mislead someone building against this server.
  it("10. names the real endpoint and the real authorization server", () => {
    expect(MCP_DOCS).toContain("https://mcp.bullmoose.cc/mcp");
    expect(MCP_DOCS).toContain("https://auth.bullmoose.cc");
  });

  it("11. states the no-send invariant, which is the one a client must not assume away", () => {
    expect(MCP_DOCS).toMatch(/no send tool/i);
  });

  it("12. documents the accountId default and the argless whoami", () => {
    expect(MCP_DOCS).toMatch(/omit .?accountId/i);
    expect(MCP_DOCS).toMatch(/whoami/);
  });

  it("13. documents the error codes it actually returns", () => {
    for (const code of ["-32001", "-32004", "-32020", "-32021", "-32022"]) {
      expect(MCP_DOCS, code).toContain(code);
    }
  });

  it("14. warns that truncated output is not parseable", () => {
    expect(MCP_DOCS).toMatch(/not.{0,20}valid JSON/i);
  });

  it("15. does not promise HTTP+SSE, which is never coming", () => {
    expect(MCP_DOCS).toMatch(/405/);
  });
});
