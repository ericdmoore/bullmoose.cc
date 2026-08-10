import { describe, expect, it } from "vitest";
import { KEY_HELP, resolveKey } from "./keymap";

describe("resolveKey — list", () => {
  it("moves with j/k and arrows", () => {
    expect(resolveKey({ key: "j" }, "list").action).toBe("next");
    expect(resolveKey({ key: "k" }, "list").action).toBe("prev");
    expect(resolveKey({ key: "ArrowDown" }, "list").action).toBe("next");
  });

  it("triages without the mouse", () => {
    expect(resolveKey({ key: "e" }, "list").action).toBe("archive");
    expect(resolveKey({ key: "#" }, "list").action).toBe("trash");
    expect(resolveKey({ key: "s" }, "list").action).toBe("toggleFlag");
    expect(resolveKey({ key: "u" }, "list").action).toBe("toggleRead");
    expect(resolveKey({ key: "v" }, "list").action).toBe("move");
  });

  it("opens, selects and composes", () => {
    expect(resolveKey({ key: "Enter" }, "list").action).toBe("openSelected");
    expect(resolveKey({ key: "x" }, "list").action).toBe("toggleSelect");
    expect(resolveKey({ key: "A" }, "list").action).toBe("selectAll");
    expect(resolveKey({ key: "c" }, "list").action).toBe("compose");
  });

  it("ignores a key it has no binding for", () => {
    expect(resolveKey({ key: "z" }, "list")).toEqual({ handled: false });
  });
});

describe("resolveKey — thread", () => {
  it("replies, forwards and goes back", () => {
    expect(resolveKey({ key: "r" }, "thread").action).toBe("reply");
    expect(resolveKey({ key: "a" }, "thread").action).toBe("replyAll");
    expect(resolveKey({ key: "f" }, "thread").action).toBe("forward");
    expect(resolveKey({ key: "u" }, "thread").action).toBe("back");
    expect(resolveKey({ key: "Escape" }, "thread").action).toBe("back");
  });

  it("toggles quoted text and blocked images from the keyboard", () => {
    expect(resolveKey({ key: "q" }, "thread").action).toBe("toggleQuote");
    expect(resolveKey({ key: "i" }, "thread").action).toBe("showImages");
  });
});

describe("resolveKey — chords", () => {
  it("arms `g` and then jumps", () => {
    const armed = resolveKey({ key: "g" }, "list");
    expect(armed.pending).toBe("g");
    expect(armed.action).toBeUndefined();
    expect(resolveKey({ key: "i" }, "list", "g").action).toBe("goInbox");
    expect(resolveKey({ key: "t" }, "list", "g").action).toBe("goTrash");
  });

  it("swallows an unknown second key rather than firing the wrong action", () => {
    const result = resolveKey({ key: "z" }, "list", "g");
    expect(result.action).toBeUndefined();
    expect(result.handled).toBe(true);
  });

  it("does not let the chord's second key act on its own meaning", () => {
    // `i` alone in a thread shows images; after `g` it must mean Inbox.
    expect(resolveKey({ key: "i" }, "thread", "g").action).toBe("goInbox");
  });
});

describe("resolveKey — typing wins", () => {
  const inField = { tagName: "INPUT" };

  it("does not archive while the user is typing `e` into a field", () => {
    expect(resolveKey({ key: "e", target: inField }, "list").handled).toBe(false);
  });

  it("does not trap a contenteditable body", () => {
    expect(
      resolveKey({ key: "e", target: { isContentEditable: true } }, "compose").handled,
    ).toBe(false);
  });

  it("still lets Escape out of a field", () => {
    expect(resolveKey({ key: "Escape", target: inField }, "list").action).toBe("clearSelection");
  });

  it("sends with Cmd/Ctrl+Enter from inside the composer", () => {
    expect(resolveKey({ key: "Enter", metaKey: true, target: inField }, "compose").action).toBe("send");
    expect(resolveKey({ key: "Enter", ctrlKey: true, target: inField }, "compose").action).toBe("send");
  });

  it("discards the composer on Escape", () => {
    expect(resolveKey({ key: "Escape", target: inField }, "compose").action).toBe("discard");
  });
});

describe("resolveKey — browser shortcuts win", () => {
  it("leaves Cmd-R, Ctrl-F and friends to the browser", () => {
    expect(resolveKey({ key: "r", metaKey: true }, "thread").handled).toBe(false);
    expect(resolveKey({ key: "f", ctrlKey: true }, "thread").handled).toBe(false);
    expect(resolveKey({ key: "e", altKey: true }, "list").handled).toBe(false);
  });
});

describe("KEY_HELP", () => {
  it("documents every binding the list and thread actually use", () => {
    const documented = KEY_HELP.map((row) => row.keys).join(" ");
    for (const key of ["j / k", "e", "#", "s", "v", "c", "/", "?"]) {
      expect(documented).toContain(key);
    }
  });
});
