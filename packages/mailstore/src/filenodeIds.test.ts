import { describe, expect, it } from "vitest";
import { fakeEnv } from "@bullmoose/test-fakes";
import { Mailstore } from "./index";

// `ids: []` must mean NONE, not ALL. An empty folder's JMAP back-reference
// resolves to an empty id list, so reading it as "no filter" renders the whole
// drive as that folder's contents (found building s03.C T3). getEmailRows has
// always drawn this line; getFileNodes did not.
describe("getFileNodes distinguishes 'no ids' from 'every id'", () => {
  const ACCOUNT = "t_x__a_ids";

  const seed = () => {
    const w = fakeEnv();
    w.db.seed("file_nodes", [
      { id: "fn_a", account_id: ACCOUNT, node_type: "directory", name: "A", created: 1, modified: 1, accessed: 1, changed: 1 },
      { id: "fn_b", account_id: ACCOUNT, node_type: "directory", name: "B", created: 1, modified: 1, accessed: 1, changed: 1 },
    ]);
    return new Mailstore(w.env.DB, w.env.BLOBS);
  };

  it("returns NOTHING for an explicitly empty id list", async () => {
    expect(await seed().getFileNodes(ACCOUNT, [])).toEqual([]);
  });

  it("still returns everything when ids is omitted", async () => {
    expect((await seed().getFileNodes(ACCOUNT)).length).toBe(2);
  });

  it("returns just the named node for a populated list", async () => {
    const rows = await seed().getFileNodes(ACCOUNT, ["fn_b"]);
    expect(rows.map((r) => r.id)).toEqual(["fn_b"]);
  });
});
