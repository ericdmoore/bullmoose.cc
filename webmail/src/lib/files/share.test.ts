import { describe, expect, it, vi } from "vitest";
import { copyText, mintFileLink } from "./share";
import type { JmapClient } from "../jmap/JmapClient";

// #339 — the Files browser had no way to reach a capability the API has had
// since s03.B. What these hold is the honesty of the outcomes: a folder has
// nothing to link to, an unconfigured server cannot be retried into working,
// and a clipboard refusal must never render as "copied".

const client = (res: Response | Error): JmapClient =>
  ({
    mintShare: async () => {
      if (res instanceof Error) throw res;
      return res;
    },
  }) as unknown as JmapClient;

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const file = { name: "invoice.pdf", type: "application/pdf", blobId: "b_1" };

describe("mintFileLink", () => {
  it("returns the server's link and ITS expiry — the UI never invents a TTL", async () => {
    const expiresAt = Date.now() + 86_400_000;
    const out = await mintFileLink(client(ok({ url: "https://x/s/1", shareId: "sh1", expiresAt })), "a1", file);
    expect(out).toEqual({ link: { url: "https://x/s/1", shareId: "sh1", expiresAt } });
  });

  it("a folder or empty file refuses BEFORE any request — a link to nothing looks like it worked", async () => {
    const calls = vi.fn();
    const spy = { mintShare: calls } as unknown as JmapClient;
    const out = await mintFileLink(spy, "a1", { name: "Docs", type: null, blobId: null });
    expect("refusal" in out && out.refusal.message).toContain("nothing to link to");
    expect(calls).not.toHaveBeenCalled();
  });

  it("501 says sharing is not configured — not 'try again', which would be a lie", async () => {
    const out = await mintFileLink(client(new Response("{}", { status: 501 })), "a1", file);
    expect("refusal" in out && out.refusal.message).toContain("not configured");
  });

  it("a network failure and a malformed success both refuse rather than half-succeed", async () => {
    const thrown = await mintFileLink(client(new Error("offline")), "a1", file);
    expect("refusal" in thrown).toBe(true);
    const empty = await mintFileLink(client(ok({ url: "https://x/s/1" })), "a1", file);
    expect("refusal" in empty && empty.refusal.message).toContain("did not return it");
  });
});

describe("copyText", () => {
  it("reports FALSE when the clipboard refuses — no secure context, no gesture", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: () => Promise.reject(new Error("NotAllowedError")),
      },
    });
    expect(await copyText("https://x")).toBe(false);
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() } });
    expect(await copyText("https://x")).toBe(true);
  });
});
