import { describe, expect, it } from "vitest";
import { describeCount, formatSize, formatType, formatWhen } from "./format";

describe("formatSize", () => {
  it("renders bytes below a kilobyte as bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
  });

  it("is DECIMAL, not binary — the convention Finder and download pages use", () => {
    // The choice is stated in format.ts. 5 MiB is 5.2 MB here, deliberately.
    expect(formatSize(1000)).toBe("1 kB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.2 MB");
    expect(formatSize(41_000_000)).toBe("41 MB");
  });

  it("keeps one decimal below ten and drops it above", () => {
    expect(formatSize(9_400_000)).toBe("9.4 MB");
    expect(formatSize(94_000_000)).toBe("94 MB");
    // No trailing ".0" — 5.0 MB is noise.
    expect(formatSize(5_000_000)).toBe("5 MB");
  });

  it("climbs units and stops at petabytes", () => {
    expect(formatSize(2_500_000_000)).toBe("2.5 GB");
    expect(formatSize(3_000_000_000_000)).toBe("3 TB");
    expect(formatSize(4_000_000_000_000_000)).toBe("4 PB");
  });

  it("renders a directory's absent size as a dash, never as 0 B", () => {
    // A folder reading "0 B" claims something about its contents.
    expect(formatSize(null)).toBe("—");
    expect(formatSize(undefined)).toBe("—");
    expect(formatSize(Number.NaN)).toBe("—");
    expect(formatSize(-1)).toBe("—");
  });
});

describe("formatType", () => {
  it("calls a directory a folder regardless of its type property", () => {
    expect(formatType(null, "directory")).toBe("Folder");
  });

  it("names the families a person recognises", () => {
    expect(formatType("application/pdf")).toBe("PDF");
    expect(formatType("application/zip")).toBe("ZIP archive");
    expect(formatType("text/csv")).toBe("CSV");
    expect(formatType("application/octet-stream")).toBe("Binary file");
  });

  it("falls back to the subtype rather than inventing a name", () => {
    expect(formatType("image/png")).toBe("PNG image");
    expect(formatType("video/quicktime")).toBe("QUICKTIME video");
    expect(formatType("application/vnd.oasis.opendocument.text")).toBe("VND.OASIS.OPENDOCUMENT.TEXT");
  });

  it("ignores parameters and case", () => {
    expect(formatType("TEXT/PLAIN; charset=utf-8")).toBe("Text");
  });

  it("says the type is unknown instead of guessing from a name", () => {
    expect(formatType(null)).toBe("Unknown type");
    expect(formatType("")).toBe("Unknown type");
  });
});

describe("formatWhen", () => {
  it("formats an ISO timestamp", () => {
    expect(formatWhen("2026-03-04T05:06:07.000Z")).toMatch(/2026/);
  });

  it("shows a dash for an absent time and the RAW value for a broken one", () => {
    // A malformed timestamp is a bug worth seeing, not one worth hiding.
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });
});

describe("describeCount", () => {
  it("says Empty, not “0 items”", () => {
    expect(describeCount(0)).toBe("Empty");
    expect(describeCount(1)).toBe("1 item");
    expect(describeCount(4)).toBe("4 items");
  });
});
