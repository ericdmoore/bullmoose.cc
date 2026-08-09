import { describe, expect, it } from "vitest";
import { formatSize, renderBlobs, renderShares } from "./blobs.js";
import type { BlobEntry, ShareEntry } from "./jmap.js";

/**
 * The CLI half of sVOL `010` — what makes the unit human-verifiable rather
 * than test-verifiable. The wire behaviour is covered end-to-end in
 * `services/jmap/src/shares.test.ts`; these hold the two pure pieces a human
 * actually reads, on the same argument as `mailbox.test.ts`.
 *
 * The ordering assertions are the substantive ones. Someone running
 * `share list` after a leak is scanning for what is STILL EXPOSED, and
 * someone running `blobs list` is asking what R2 is billing for — so live
 * links and large objects have to be at the top, not wherever the server
 * happened to enumerate them.
 */

const share = (over: Partial<ShareEntry> & { shareId: string }): ShareEntry => ({
  blobId: "b_1",
  name: "report.pdf",
  expiresAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  live: true,
  ...over,
});

const blob = (blobId: string, size: number): BlobEntry => ({
  blobId,
  size,
  uploaded: "2026-08-01T12:00:00.000Z",
});

describe("renderShares", () => {
  it("puts live links first — the leak question, not the id question", () => {
    const lines = renderShares([
      share({ shareId: "sh_revoked", live: false, revokedAt: "2026-08-02T00:00:00.000Z" }),
      share({ shareId: "sh_live" }),
    ]).split("\n");
    expect(lines[0]).toContain("sh_live");
    expect(lines[0]).toContain("live");
    expect(lines[1]).toContain("sh_revoked");
  });

  it("distinguishes revoked from expired — they are not the same event", () => {
    const out = renderShares([
      share({ shareId: "sh_r", live: false, revokedAt: "2026-08-02T00:00:00.000Z" }),
      share({ shareId: "sh_e", live: false }),
    ]);
    expect(out).toContain("revoked  sh_r");
    expect(out).toContain("expired  sh_e");
  });

  it("shows the expiry date, so a link's remaining life is visible", () => {
    expect(renderShares([share({ shareId: "sh_1" })])).toContain("expires 2026-09-01");
  });

  it("says so plainly when there is nothing", () => {
    expect(renderShares([])).toBe("  (no share links)");
  });

  it("does not mutate the caller's array", () => {
    const list = [share({ shareId: "sh_a", live: false }), share({ shareId: "sh_b" })];
    renderShares(list);
    expect(list.map((s) => s.shareId)).toEqual(["sh_a", "sh_b"]);
  });
});

describe("renderBlobs", () => {
  it("sorts largest first — the storage-bill question", () => {
    const lines = renderBlobs([blob("b_small", 10), blob("b_big", 5_000_000)]).split("\n");
    expect(lines[0]).toContain("b_big");
    expect(lines[1]).toContain("b_small");
  });

  it("says so plainly when there is nothing", () => {
    expect(renderBlobs([])).toBe("  (no blobs)");
  });
});

describe("formatSize", () => {
  it("reads as a size a human recognises", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(4 * 1024 * 1024)).toBe("4.0 MB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("caps at TB rather than inventing a unit", () => {
    expect(formatSize(5 * 1024 ** 5)).toContain("TB");
  });
});
