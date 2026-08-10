import { describe, expect, it } from "vitest";
import { quoteLines, splitQuotedText } from "./quote";

describe("splitQuotedText", () => {
  it("splits on an `On ... wrote:` attribution", () => {
    const { body, quoted } = splitQuotedText(
      "Monday works.\n\nOn Tue, 1 Jul 2026, Grace <g@x.test> wrote:\n> Kicking off Monday.",
    );
    expect(body).toBe("Monday works.");
    expect(quoted).toContain("Kicking off Monday.");
  });

  it("handles an attribution wrapped across lines", () => {
    const { body, quoted } = splitQuotedText(
      "Sure.\n\nOn Tue, 1 Jul 2026 at 10:00, Grace Hopper\n<grace@example.test> wrote:\n> hello",
    );
    expect(body).toBe("Sure.");
    expect(quoted).toContain("hello");
  });

  it("splits on an Original Message banner", () => {
    const { body, quoted } = splitQuotedText("Reply.\n\n-----Original Message-----\nFrom: someone");
    expect(body).toBe("Reply.");
    expect(quoted).toContain("Original Message");
  });

  it("splits on an Outlook underscore rule", () => {
    const { body, quoted } = splitQuotedText(`Reply.\n\n${"_".repeat(32)}\nFrom: someone`);
    expect(body).toBe("Reply.");
    expect(quoted).toContain("From: someone");
  });

  it("splits on a bare Outlook header block with no > prefixes", () => {
    const { body, quoted } = splitQuotedText(
      "Reply.\n\nFrom: Grace <g@x.test>\nSent: Tuesday\nSubject: Kickoff\n\nOriginal text.",
    );
    expect(body).toBe("Reply.");
    expect(quoted).toContain("Subject: Kickoff");
  });

  it("splits on a `>` run that reaches the end", () => {
    const { body, quoted } = splitQuotedText("Reply.\n\n> old line one\n> old line two");
    expect(body).toBe("Reply.");
    expect(quoted).toBe("> old line one\n> old line two");
  });

  it("does NOT collapse an inline quote the sender is replying around", () => {
    // Hiding text the sender wrote is worse than showing a quote already read.
    const { body, quoted } = splitQuotedText(
      "> you asked this\n\nAnd here is my answer, written after it.",
    );
    expect(quoted).toBe("");
    expect(body).toContain("here is my answer");
  });

  it("splits a `-- ` signature off separately", () => {
    const { body, signature } = splitQuotedText("Thanks.\n\n-- \nEric\nbullmoose.cc");
    expect(body).toBe("Thanks.");
    expect(signature).toBe("-- \nEric\nbullmoose.cc");
  });

  it("keeps the signature out of the quoted section", () => {
    const { body, quoted, signature } = splitQuotedText(
      "Reply.\n\nOn Tue, Grace wrote:\n> old\n\n-- \nEric",
    );
    expect(body).toBe("Reply.");
    expect(quoted).toContain("> old");
    expect(quoted).not.toContain("Eric");
    expect(signature).toContain("Eric");
  });

  it("returns the whole body when there is no quote at all", () => {
    const { body, quoted, signature } = splitQuotedText("Just a note.");
    expect(body).toBe("Just a note.");
    expect(quoted).toBe("");
    expect(signature).toBe("");
  });

  it("does not treat a sentence beginning with `On` as an attribution", () => {
    const { quoted } = splitQuotedText("On Monday I will send the report. Let me know.");
    expect(quoted).toBe("");
  });

  it("survives an empty body", () => {
    expect(splitQuotedText("")).toEqual({ body: "", quoted: "", signature: "" });
  });
});

describe("quoteLines", () => {
  it("prefixes each line", () => {
    expect(quoteLines("a\nb")).toBe("> a\n> b");
  });

  it("deepens an existing quote instead of spacing it out", () => {
    expect(quoteLines("> a")).toBe(">> a");
  });

  it("quotes a blank line without trailing whitespace noise", () => {
    expect(quoteLines("a\n\nb")).toBe("> a\n> \n> b");
  });
});
