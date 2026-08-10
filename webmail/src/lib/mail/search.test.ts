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
  // The server's `text` condition is a LIKE over subject / preview / from / to
  // (packages/mailstore buildFilter, "LIKE fallback until the FTS index is
  // populated at ingest"). Message bodies are NOT searchable. The UI must say
  // so — a search box that quietly misses paragraph four teaches people the
  // mail is not there.
  it("the note names the covered fields and the gap", () => {
    expect(SEARCH_SCOPE_NOTE).toMatch(/subject/i);
    expect(SEARCH_SCOPE_NOTE).toMatch(/sender/i);
    expect(SEARCH_SCOPE_NOTE).toMatch(/not searched/i);
  });

  it("describeSearchScope spells out the body gap for a free-text search", () => {
    const description = describeSearchScope({ text: "punch cards" });
    expect(description).toContain("punch cards");
    expect(description).toMatch(/not in full message bodies/i);
  });

  it("does NOT claim a body gap for a search that has no free-text clause", () => {
    const description = describeSearchScope({ from: "ada" });
    expect(description).not.toMatch(/message bodies/i);
    expect(mayMissBodyMatches({ from: "ada" })).toBe(false);
    expect(mayMissBodyMatches({ text: "ada" })).toBe(true);
  });

  it("really does miss a word that appears only in the body — the claim is not theoretical", async () => {
    const { client } = createDemoBackend();
    const store = new ThreadListStore(client, ACCOUNT, { pageSize: 50 });

    // "relevant" appears ONLY inside the newsletter's HTML body — not in its
    // subject, preview, sender or recipients. The server cannot see it.
    await store.setQuery({ filter: buildEmailFilter({ text: "relevant" }) });
    expect(store.getRows()).toHaveLength(0);

    // The same message IS found by a word in its subject — so the miss above is
    // the body gap, not a broken query.
    await store.setQuery({ filter: buildEmailFilter({ text: "Analytical Engine" }) });
    expect(store.getRows()).toHaveLength(1);

    // …and by a word in the preview, which is only the first 256 characters.
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
