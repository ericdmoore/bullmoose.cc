import { describe, expect, it } from "vitest";
import { applyEdit, diffLines, editorFor, payloadDiff } from "./edit";

const replyPayload = {
  to: "grace@example.test",
  self: "eric@bullmoose.test",
  subject: "Re: Project Elk kickoff",
  text: "Monday works.\nSee you then.\n— Eric",
  blobId: "blob-1",
  inReplyTo: "m1@x",
  messageId: "m2@x",
  mode: "send",
};

describe("editorFor — what Edit opens", () => {
  it("gives reply-shaped kinds a subject/text form seeded from the payload", () => {
    const form = editorFor({ kind: "reply-draft", payload: replyPayload });
    expect(form).toEqual({
      shape: "reply",
      subject: "Re: Project Elk kickoff",
      text: replyPayload.text,
    });
    expect(editorFor({ kind: "start-thread", payload: replyPayload })?.shape).toBe("reply");
  });

  it("gives other kinds the payload as JSON", () => {
    const form = editorFor({ kind: "create-event", payload: { title: "Standup" } });
    expect(form?.shape).toBe("json");
    expect(JSON.parse((form as { json: string }).json)).toEqual({ title: "Standup" });
  });

  it("refuses to edit a grant-request — approve or deny as asked", () => {
    expect(editorFor({ kind: "grant-request", payload: { scope: "read" } })).toBeNull();
  });
});

describe("applyEdit — the retained-diff contract", () => {
  it("merges the human's subject/text over the payload, leaving the send fields intact", () => {
    const { editedPayload, problem } = applyEdit(replyPayload, {
      shape: "reply",
      subject: "Re: Project Elk kickoff",
      text: "Monday works.\nLet's keep 30 min for scope.\n— Eric",
    });
    expect(problem).toBeUndefined();
    expect(editedPayload).toMatchObject({
      text: "Monday works.\nLet's keep 30 min for scope.\n— Eric",
      // Untouched fields survive: the server validates to/self/blobId on the
      // effective payload (actionProposal.ts:429-436), so losing them here
      // would turn every edited approval into a refusal.
      to: "grace@example.test",
      blobId: "blob-1",
      mode: "send",
    });
  });

  it("a NO-OP edit sends nothing — approved clean must stay approved clean", () => {
    // The three-outcome table (s07 §T4): "approved after edit" is its own
    // signal, and opening the editor without changing anything must not fake it.
    const untouched = applyEdit(replyPayload, {
      shape: "reply",
      subject: replyPayload.subject,
      text: replyPayload.text,
    });
    expect(untouched.editedPayload).toBeUndefined();
    expect(untouched.problem).toBeUndefined();
  });

  it("a JSON no-op (reordered keys) is still a no-op", () => {
    const { editedPayload } = applyEdit(
      { a: 1, b: { c: 2, d: 3 } },
      { shape: "json", json: JSON.stringify({ b: { d: 3, c: 2 }, a: 1 }) },
    );
    expect(editedPayload).toBeUndefined();
  });

  it("refuses bad JSON and non-object JSON without sending anything", () => {
    expect(applyEdit({}, { shape: "json", json: "{nope" }).problem).toContain("not valid JSON");
    // Mirrors the server's own guard: `editedPayload must be an object`.
    expect(applyEdit({}, { shape: "json", json: "[1,2]" }).problem).toContain(
      "must be a JSON object",
    );
    expect(applyEdit({}, { shape: "json", json: "null" }).problem).toContain(
      "must be a JSON object",
    );
  });
});

describe("payloadDiff — the agent's version vs the human's, both retained", () => {
  it("reports changed, removed and added keys; identical keys are silent", () => {
    const original = { to: "a@x", text: "old", mode: "send", extra: 1 };
    const edited = { to: "a@x", text: "new", mode: "send", added: true };
    expect(payloadDiff(original, edited)).toEqual([
      { key: "text", before: "old", after: "new" },
      { key: "extra", before: 1 },
      { key: "added", after: true },
    ]);
  });

  it("never mutates either side — the original is the retained artifact", () => {
    const original = { text: "old" };
    const edited = { text: "new" };
    payloadDiff(original, edited);
    expect(original).toEqual({ text: "old" });
    expect(edited).toEqual({ text: "new" });
  });
});

describe("diffLines", () => {
  it("marks a rewritten line as del+add and keeps the common lines", () => {
    expect(diffLines("one\ntwo\nthree", "one\n2\nthree")).toEqual([
      { op: "same", text: "one" },
      { op: "del", text: "two" },
      { op: "add", text: "2" },
      { op: "same", text: "three" },
    ]);
  });

  it("handles pure insertion and pure deletion at the ends", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "same", text: "b" },
      { op: "add", text: "c" },
    ]);
    expect(diffLines("a\nb", "b")).toEqual([
      { op: "del", text: "a" },
      { op: "same", text: "b" },
    ]);
  });

  it("identical inputs diff to all-same", () => {
    expect(diffLines("x\ny", "x\ny").every((l) => l.op === "same")).toBe(true);
  });
});
