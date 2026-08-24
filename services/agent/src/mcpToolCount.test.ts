import { describe, expect, it } from "vitest";
import { TOOLS } from "./mcp.js";

// #227's records-drift residue, moved in-repo where it can bite.
//
// sVOL's `_verify.sh` asserted "MCP tools/list returns 29 tools", kept exact
// "because the count IS the grid fact". It was stale on the day it was
// written (revoke_app had landed three days earlier), and it has never run:
// the script lives in an archived plan folder, has no CI job, and needs a
// live BM_TOKEN against a deployed account. A grid fact nothing checks is
// not a fact.
//
// So the count lives here now. This test is deliberately DUMB — it fails on
// every tool added or removed, and the fix is to read the list, confirm the
// change was intended, and update the number in the same commit that
// changed the surface. That is the whole point: the MCP tool list is the
// agent-facing API, and it must never grow or shrink by accident.

describe("the MCP tool grid", () => {
  it("has exactly the tools we ship — update this WITH the surface, never after", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "access_log",
        "calendar_create_event",
        "calendar_delete_event",
        "calendar_list",
        "calendar_query_events",
        "calendar_update_event",
        "contacts_create_card",
        "contacts_delete_card",
        "contacts_list_books",
        "contacts_search",
        "contacts_update_card",
        "devices",
        "email_create_draft",
        "email_destroy",
        "email_get",
        "email_get_body",
        "email_move",
        "email_query",
        "email_set_keywords",
        "explain_skip",
        "invocation_history",
        "mailbox_list",
        "message_volume",
        "my_access",
        "my_agents",
        "revoke_app",
        "spend_by_month",
        "spend_by_vendor",
        "top_senders",
        "who_can_access",
        "whoami",
      ].sort(),
    );
  });

  it("every tool name is unique — a duplicate silently shadows in a client's map", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
