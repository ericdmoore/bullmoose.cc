import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs, no types; exported precisely so it can be tested.
import { wireText } from "./bootstrap.mjs";

// s02 T3. `wireText` was exported "so it can be unit-tested without touching
// real files" and then never was, which is how the bug these tests pin got in:
// the KV rewrite anchored only on "kv_namespaces" and replaced the FIRST "id"
// after it. That was correct while exactly one namespace existed anywhere in
// the tree, and silently wrong the moment the OAuth AS added a second — the
// authorization server would have been wired to the route table's namespace,
// mixing minted credentials into cached routing data. Nothing else in the repo
// would have failed.

const AGENT_CFG = `{
  "name": "bullmoose-agent",
  "d1_databases": [{ "binding": "DB", "database_id": "OLD_D1" }],
  "kv_namespaces": [{ "binding": "ROUTES", "id": "OLD_ROUTES" }]
}`;

const OAUTH_CFG = `{
  "name": "bullmoose-oauth",
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "PLACEHOLDER_OAUTH_KV_ID" }],
  "d1_databases": [{ "binding": "DB", "database_id": "OLD_D1" }]
}`;

describe("wireText — resource ids by binding, not by position", () => {
  it("1. writes the D1 id", () => {
    const { text, changed } = wireText(AGENT_CFG, "NEW_D1", "NEW_ROUTES");
    expect(changed).toBe(true);
    expect(text).toContain('"database_id": "NEW_D1"');
  });

  it("2. writes the ROUTES id into a ROUTES binding", () => {
    const { text } = wireText(AGENT_CFG, "NEW_D1", "NEW_ROUTES");
    expect(text).toContain('"binding": "ROUTES", "id": "NEW_ROUTES"');
  });

  it("3. does NOT write the ROUTES id into an OAUTH_KV binding", () => {
    // The bug. Positionally, OAUTH_KV's id is the first one after
    // "kv_namespaces" in that file, so the old regex hit it every time.
    const { text } = wireText(OAUTH_CFG, "NEW_D1", "NEW_ROUTES");
    expect(text).not.toContain("NEW_ROUTES");
    expect(text).toContain("PLACEHOLDER_OAUTH_KV_ID");
  });

  it("4. writes the OAUTH_KV id when it is supplied", () => {
    const { text, changed } = wireText(OAUTH_CFG, "NEW_D1", "NEW_ROUTES", { OAUTH_KV: "NEW_OAUTH" });
    expect(changed).toBe(true);
    expect(text).toContain('"binding": "OAUTH_KV", "id": "NEW_OAUTH"');
    expect(text).toContain('"database_id": "NEW_D1"');
  });

  it("5. keeps the two namespaces apart in a file holding both", () => {
    const both = `{
      "kv_namespaces": [
        { "binding": "ROUTES", "id": "OLD_R" },
        { "binding": "OAUTH_KV", "id": "OLD_O" }
      ]
    }`;
    const { text } = wireText(both, null, "NEW_R", { OAUTH_KV: "NEW_O" });
    expect(text).toContain('"binding": "ROUTES", "id": "NEW_R"');
    expect(text).toContain('"binding": "OAUTH_KV", "id": "NEW_O"');
  });

  it("6. reports changed:false when everything is already wired", () => {
    const { changed } = wireText(AGENT_CFG, "OLD_D1", "OLD_ROUTES");
    expect(changed).toBe(false);
  });

  it("7. leaves a config lacking the block untouched", () => {
    const noKv = `{ "name": "bullmoose-bureau", "d1_databases": [{ "binding": "DB", "database_id": "OLD_D1" }] }`;
    const { text } = wireText(noKv, "OLD_D1", "NEW_ROUTES");
    expect(text).toBe(noKv);
  });

  it("8. skips a binding whose id could not be resolved rather than blanking it", () => {
    // resolveIds returns undefined for a namespace that does not exist yet;
    // writing that through would erase a working id.
    const { text } = wireText(OAUTH_CFG, "NEW_D1", "NEW_ROUTES", { OAUTH_KV: undefined });
    expect(text).toContain("PLACEHOLDER_OAUTH_KV_ID");
  });

  it("9. tolerates whitespace and newlines between binding and id", () => {
    const pretty = `{
      "kv_namespaces": [
        {
          "binding": "OAUTH_KV",
          "id": "OLD"
        }
      ]
    }`;
    const { text } = wireText(pretty, null, null, { OAUTH_KV: "NEW_O" });
    expect(text).toContain('"id": "NEW_O"');
  });
});
