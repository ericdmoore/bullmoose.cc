import { describe, expect, it } from "vitest";
import { callProvider, PROVIDERS } from "./connectors.js";
import { notionSearch, upcomingEvents } from "./connectorReads.js";
import type { Env } from "./models.js";

// #4's first two connectors. What these hold is the boundary, not the
// vendors: an agent names a credential and a PATH, and everything about
// where that credential may go, which verb spends it, and whether it may be
// spent at all stays with the Bureau.

const CTX = { accountId: "a1", bindingId: "b1", credRef: "notion-main" };

function bureau(reply: unknown, status = 200) {
  const calls: Array<Record<string, unknown>> = [];
  const env = {
    INTERNAL_TOKEN: "itk",
    BUREAU: {
      fetch: async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
      },
    },
  } as unknown as Env;
  return { env, calls };
}

const ok = (body: unknown, status = 200) => ({ ok: true, status, bodyEncoding: "text", body: JSON.stringify(body) });

describe("callProvider — the boundary, not the vendor", () => {
  it("joins the path to the PROVIDER's origin, never a caller-supplied host", async () => {
    const { env, calls } = bureau(ok({ results: [] }));
    await callProvider(env, "notion", { ...CTX, path: "/v1/search", method: "POST", body: { query: "x" } });
    const req = calls[0]!.request as { url: string; headers: Record<string, string> };
    expect(req.url).toBe("https://api.notion.com/v1/search");
    // Notion refuses an unversioned request rather than defaulting one.
    expect(req.headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("an absolute URL in the path field is an attempt, and is refused", async () => {
    const { env, calls } = bureau(ok({}));
    const res = await callProvider(env, "notion", { ...CTX, path: "https://evil.test/steal" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0); // refused before the Bureau was even asked
  });

  it("goes through binding-use — so the grant, not the caller, picks the verb", async () => {
    const { env, calls } = bureau(ok({ items: [] }));
    await callProvider(env, "google-calendar", { ...CTX, path: "/calendar/v3/x" });
    // The body carries account/binding/credRef and NO verb: the Bureau reads
    // the verb off the grant, which is what stops an agent choosing one.
    expect(Object.keys(calls[0]!).sort()).toEqual(["accountId", "bindingId", "credRef", "request"]);
  });

  it("a Bureau refusal comes back in the Bureau's own words", async () => {
    const { env } = bureau({ ok: false, error: "no live grant for credRef notion-main" }, 403);
    const res = await callProvider(env, "notion", { ...CTX, path: "/v1/search" });
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toContain("no live grant");
  });

  it("an unknown provider and a missing Bureau binding both refuse honestly", async () => {
    const { env } = bureau(ok({}));
    expect((await callProvider(env, "dropbox", { ...CTX, path: "/x" })).status).toBe(400);
    const noBureau = { INTERNAL_TOKEN: "itk" } as unknown as Env;
    expect((await callProvider(noBureau, "notion", { ...CTX, path: "/x" })).status).toBe(501);
  });
});

describe("the reads normalize what the vendor actually returns", () => {
  it("Google: all-day events keep their date — reading only dateTime loses most of a calendar", async () => {
    const { env, calls } = bureau(
      ok({
        items: [
          {
            id: "1",
            summary: "Standup",
            start: { dateTime: "2026-08-25T09:00:00Z" },
            end: { dateTime: "2026-08-25T09:15:00Z" },
            status: "confirmed",
            attendees: [{}, {}],
          },
          { id: "2", summary: "Holiday", start: { date: "2026-08-26" }, end: { date: "2026-08-27" } },
        ],
      }),
    );
    const out = await upcomingEvents(env, CTX, { max: 5 });
    expect("events" in out && out.events).toEqual([
      {
        id: "1",
        title: "Standup",
        start: "2026-08-25T09:00:00Z",
        end: "2026-08-25T09:15:00Z",
        status: "confirmed",
        attendees: 2,
      },
      { id: "2", title: "Holiday", start: "2026-08-26", end: "2026-08-27", status: "confirmed", attendees: 0 },
    ]);
    // singleEvents expands recurrences; without it a weekly standup is one
    // master event with a rule, which cannot answer "what is on today".
    expect((calls[0]!.request as { url: string }).url).toContain("singleEvents=true");
  });

  it("Notion: the title is excavated from wherever Notion put it", async () => {
    const { env } = bureau(
      ok({
        results: [
          {
            id: "p1",
            url: "https://notion.so/p1",
            last_edited_time: "2026-08-01T00:00:00Z",
            properties: { Name: { type: "title", title: [{ plain_text: "Q3 " }, { plain_text: "plan" }] } },
          },
          { id: "d1", url: "https://notion.so/d1", title: [{ plain_text: "A database" }] },
          { id: "x1", url: "https://notion.so/x1", properties: {} },
        ],
      }),
    );
    const out = await notionSearch(env, CTX, { query: "plan" });
    expect("hits" in out && out.hits.map((h) => h.title)).toEqual(["Q3 plan", "A database", "(untitled)"]);
  });

  it("a provider's own error message beats ours", async () => {
    const { env } = bureau(ok({ message: "API token is invalid." }, 401));
    const out = await notionSearch(env, CTX, { query: "x" });
    expect("error" in out && out.error).toBe("API token is invalid.");
  });
});

describe("the provider table", () => {
  it("every provider names an https origin and the verb its credential needs", () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.origin.startsWith("https://"), p.id).toBe(true);
      expect(["fetch", "oauth_token"]).toContain(p.verb);
      // An oauth provider without a token endpoint cannot be exchanged, and
      // the failure would land at spend time rather than at mint time.
      if (p.verb === "oauth_token") expect(p.tokenUrl, p.id).toBeTruthy();
    }
  });
});
