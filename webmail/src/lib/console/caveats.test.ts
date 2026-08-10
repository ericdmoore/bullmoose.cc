import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_LOG_CAVEATS,
  ACCESS_LOG_CAVEAT_LABELS,
  NOT_CAPTURED,
  POINT_IN_TIME_NOTE,
  PROVENANCE_CAVEATS,
  SKIP_CAVEATS,
  emptyMeans,
} from "./caveats";

/**
 * The anti-drift proof for the mirror.
 *
 * `caveats.ts` restates sentences that `services/agent/src/introspectTools.ts`
 * returns with every `access_log` and `explain_skip` answer. Importing that
 * module is not possible here — it is Worker code (D1, service bindings) and a
 * browser bundle must not pull it in — so instead this reads the file off disk
 * and asserts the sentences are present in it VERBATIM.
 *
 * Cheap, and it bites: reword a caveat on either side and this fails, rather
 * than the conversational surface and the console quietly telling users
 * different things about the same table. (Same shape as `services/agent`'s own
 * `vault.test.ts`, which greps its source to prove the master key's name appears
 * nowhere in the worker.)
 */
const INTROSPECT = fileURLToPath(
  new URL("../../../../services/agent/src/introspectTools.ts", import.meta.url),
);

/**
 * Source-normalize: TypeScript string concatenation across lines
 * (`"…foo " +\n    "bar…"`) has to be joined before a substring test, and
 * leading indentation collapsed.
 */
function normalizedSource(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/"\s*\+\s*\n\s*"/g, "")
    .replace(/\s+/g, " ");
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("the caveats are the ones 015 actually returns", () => {
  const source = normalizedSource(INTROSPECT);

  it("finds the introspection source (guards against a silently-passing test)", () => {
    expect(source).toContain("ACCESS_LOG_LIMITATIONS");
    expect(source).toContain("SKIP_LIMITATIONS");
    expect(source.length).toBeGreaterThan(10_000);
  });

  it.each(ACCESS_LOG_CAVEATS.map((c, i) => [i, c] as const))(
    "grant_audit caveat %i is mirrored verbatim",
    (_i, caveat) => {
      expect(source).toContain(norm(caveat));
    },
  );

  it.each(SKIP_CAVEATS.map((c, i) => [i, c] as const))(
    "skip caveat %i is mirrored verbatim",
    (_i, caveat) => {
      expect(source).toContain(norm(caveat));
    },
  );
});

describe("all four grant_audit caveats are present and distinct", () => {
  // The four `015` found, each of which would mislead a reader of this screen:
  it("says delegated-only, so empty ≠ nothing happened", () => {
    expect(ACCESS_LOG_CAVEATS[0]).toContain("Only DELEGATED access is recorded");
    expect(ACCESS_LOG_CAVEATS[0]).toContain("not 'nothing happened'");
  });
  it("says attempts, not outcomes", () => {
    expect(ACCESS_LOG_CAVEATS[1]).toContain("ATTEMPTS, not outcomes");
    expect(ACCESS_LOG_CAVEATS[1]).toContain("no status column");
  });
  it("says no row records WHAT was read", () => {
    expect(ACCESS_LOG_CAVEATS[2]).toContain("No row says WHAT was read");
  });
  it("says a revoked grant's scopes are unrecoverable", () => {
    expect(ACCESS_LOG_CAVEATS[3]).toContain("scopes are not copied onto the row");
  });
  it("has one short label per caveat, for the row badges", () => {
    expect(ACCESS_LOG_CAVEAT_LABELS).toHaveLength(ACCESS_LOG_CAVEATS.length);
    expect(new Set(ACCESS_LOG_CAVEAT_LABELS).size).toBe(ACCESS_LOG_CAVEAT_LABELS.length);
  });
});

describe("the provenance gap (common/033)", () => {
  it("says a blank writer is NOT CAPTURED rather than nobody", () => {
    expect(NOT_CAPTURED).toContain("not captured");
    expect(PROVENANCE_CAVEATS[0]).toContain("NOT CAPTURED, not 'nobody'");
  });

  it("names both bypassing write paths", () => {
    const all = PROVENANCE_CAVEATS.join(" ");
    expect(all).toContain("CardDAV/CalDAV");
    expect(all).toContain("common/033 §1");
    expect(all).toContain("common/033 §2");
    // The agent-MCP half: principal recorded, binding/invocation not.
    expect(all).toContain("binding or invocation");
  });
});

describe("the empty case", () => {
  it("explains an empty table rather than presenting an absence", () => {
    expect(emptyMeans).toContain("not the same as");
    expect(emptyMeans).toContain("'nothing happened'");
    expect(emptyMeans).toContain("owner's own reads and writes are never written");
  });
});

describe("the point-in-time note", () => {
  it("credits the tombstone and admits what predates it", () => {
    expect(POINT_IN_TIME_NOTE).toContain("tombstones (s03.A)");
    expect(POINT_IN_TIME_NOTE).toContain("hard-deleted before tombstones existed are unrecoverable");
  });
});
