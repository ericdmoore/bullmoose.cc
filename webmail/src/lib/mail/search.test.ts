import { describe, expect, it } from "vitest";
import { createDemoBackend } from "../jmap/demo";
import { ThreadListStore } from "./threadList";
import {
  SEARCH_SCOPE_NOTE,
  buildEmailFilter,
  describeSearchScope,
  isEmptySpec,
  mayMissBodyMatches,
  parseSearchInput,
} from "./search";

const ACCOUNT = "acct-fake";

describe("parseSearchInput", () => {
  it("keeps unkeyed words as free text", () => {
    expect(parseSearchInput("quarterly report")).toEqual({ text: "quarterly report" });
  });

  it("pulls out from:, to: and subject:", () => {
    expect(parseSearchInput("from:ada to:bob subject:kickoff rest")).toEqual({
      from: "ada",
      to: "bob",
      subject: "kickoff",
      text: "rest",
    });
  });

  it("supports quoted operator values", () => {
    expect(parseSearchInput('subject:"project elk"')).toEqual({ subject: "project elk" });
  });

  it("understands is:unread, is:flagged and has:attachment", () => {
    expect(parseSearchInput("is:unread has:attachment")).toEqual({
      unreadOnly: true,
      hasAttachment: true,
    });
    expect(parseSearchInput("is:starred").flaggedOnly).toBe(true);
  });

  it("resolves in: against the mailbox names it was given", () => {
    const byName = new Map([["archive", "mb-archive"]]);
    expect(parseSearchInput("in:archive", byName).inMailbox).toBe("mb-archive");
  });

  it("leaves an operator it does not implement as free text, rather than dropping it", () => {
    // There is no body: search on this server. Swallowing `body:foo` silently
    // would look like a search that matched nothing.
    expect(parseSearchInput("body:foo").text).toBe("body:foo");
  });

  it("normalizes before:/after: to ISO", () => {
    expect(parseSearchInput("after:2026-07-01").after).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("buildEmailFilter", () => {
  it("returns null for an empty spec — 'everything', not an empty condition", () => {
    expect(buildEmailFilter({})).toBeNull();
    expect(isEmptySpec({})).toBe(true);
    expect(isEmptySpec({ text: "x" })).toBe(false);
  });

  it("emits a bare condition for a single clause", () => {
    expect(buildEmailFilter({ inMailbox: "mb-inbox" })).toEqual({ inMailbox: "mb-inbox" });
  });

  it("ANDs several clauses together", () => {
    expect(buildEmailFilter({ inMailbox: "mb-inbox", text: "elk", unreadOnly: true })).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "mb-inbox" }, { text: "elk" }, { notKeyword: "$seen" }],
    });
  });

  it("maps unread and flagged onto the keyword conditions the server implements", () => {
    expect(buildEmailFilter({ unreadOnly: true })).toEqual({ notKeyword: "$seen" });
    expect(buildEmailFilter({ flaggedOnly: true })).toEqual({ hasKeyword: "$flagged" });
  });

  it("ignores whitespace-only text rather than filtering on nothing", () => {
    expect(buildEmailFilter({ text: "   " })).toBeNull();
  });
});

describe("honesty about what search covers", () => {
  // ⚠️ These assertions FLIPPED with common/004. The server's `text` condition
  // is no longer a LIKE over subject / preview / from / to — it is an FTS5
  // MATCH over an index that `Mailstore.insertEmail` writes at ingest, and it
  // covers full message BODIES (proved server-side in
  // packages/mailstore/src/search.test.ts and services/ingest/src/fts.test.ts).
  //
  // A note that keeps apologising for a closed gap is as dishonest as one that
  // hides an open one, so what these tests pin is the NEW limitation: FTS
  // matches whole words, where the old LIKE matched substrings.
  it("the note names the covered fields, bodies included", () => {
    expect(SEARCH_SCOPE_NOTE).toMatch(/subject/i);
    expect(SEARCH_SCOPE_NOTE).toMatch(/sender/i);
    expect(SEARCH_SCOPE_NOTE).toMatch(/bodies/i);
    // The gap it must NOT claim any more.
    expect(SEARCH_SCOPE_NOTE).not.toMatch(/not searched/i);
    expect(SEARCH_SCOPE_NOTE).not.toMatch(/256/);
  });

  it("the note names the limitation that IS real — whole words, not fragments", () => {
    expect(SEARCH_SCOPE_NOTE).toMatch(/whole words/i);
  });

  it("describeSearchScope describes a free-text search without the stale body caveat", () => {
    const description = describeSearchScope({ text: "punch cards" });
    expect(description).toContain("punch cards");
    expect(description).toMatch(/whole words/i);
    expect(description).toMatch(/bodies/i);
    expect(description).not.toMatch(/not in full message bodies/i);
  });

  it("does NOT put the whole-word caveat on a search with no free-text clause", () => {
    // `from:`/`subject:` are still substring LIKEs on their own column — a
    // different contract from `text`, and the reason this distinction survives.
    const description = describeSearchScope({ from: "ada" });
    expect(description).not.toMatch(/whole words/i);
    expect(mayMissBodyMatches({ from: "ada" })).toBe(false);
    expect(mayMissBodyMatches({ text: "ada" })).toBe(true);
  });

  it("the DEMO backend still misses body-only words — it is a fake with no index", async () => {
    // This is now a statement about `webmail/src/lib/jmap/demo.ts`, NOT about
    // the server. The demo client re-implements the filter in TypeScript over
    // subject / preview / from / to; it has no FTS5 and no body text to match.
    // Kept because it is the one thing that would otherwise silently drift:
    // when the demo backend learns to match `bodyValues`, this test fails and
    // says so.
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 50 });

    // "relevant" appears ONLY inside the newsletter's HTML body. A real server
    // finds this since common/004; the demo fake does not.
    await store.setQuery({ filter: buildEmailFilter({ text: "relevant" }) });
    expect(store.getRows()).toHaveLength(0);

    // The same message IS found by a word in its subject — so the miss above is
    // the fake's body gap, not a broken query.
    await store.setQuery({ filter: buildEmailFilter({ text: "Analytical Engine" }) });
    expect(store.getRows()).toHaveLength(1);

    await store.setQuery({ filter: buildEmailFilter({ text: "punch cards" }) });
    expect(store.getRows()).toHaveLength(1);
  });

  it("finds mail by sender and by preview text", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 50 });

    await store.setQuery({ filter: buildEmailFilter({ text: "grace@example.test" }) });
    expect(store.getRows().length).toBeGreaterThan(0);

    await store.setQuery({ filter: buildEmailFilter({ text: "Kicking this off" }) });
    expect(store.getRows()).toHaveLength(1);
  });

  it("scopes a search to one mailbox when asked", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 50 });
    await store.setQuery({ filter: buildEmailFilter({ inMailbox: "mb-project" }) });
    expect(store.getRows()).toHaveLength(1);
    expect(store.getRows()[0]?.latest.id).toBe("e-thread-2");
  });
});
