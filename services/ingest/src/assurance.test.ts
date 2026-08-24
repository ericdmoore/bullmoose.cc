import { describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { domainsAligned, parseAssurance } from "./assurance";
import worker from "./index";

// s33 slice 1 — the rules of evidence for tier 1. The parser's whole risk is
// asserting MORE than the header says: `aligned` must never be upgraded by
// guesswork (unknown is a legal answer), a forged header below the topmost
// must never be consulted (the stage-2 trust model, shared deliberately),
// and anything short of an explicit dmarc=pass stores NOTHING — absent means
// "not known", never "not authentic".

const AT = 1_787_200_000_000;
const hdr = (value: string) => [{ key: "authentication-results", value }];

describe("parseAssurance", () => {
  it("dkim-aligned pass records the stronger fact and the signing domain", () => {
    const a = parseAssurance(
      hdr(
        "mx.cloudflare.net; dkim=pass header.d=company.com; spf=pass smtp.mailfrom=bounce@company.com; dmarc=pass header.from=company.com",
      ),
      "company.com",
      AT,
    );
    expect(a).toEqual({ dmarc: "pass", aligned: "dkim", d: "company.com", at: AT });
  });

  it("spf-only alignment is recorded as the materially weaker fact it is", () => {
    const a = parseAssurance(
      hdr("mx.cloudflare.net; spf=pass smtp.mailfrom=alice@company.com; dkim=fail header.d=company.com; dmarc=pass"),
      "company.com",
      AT,
    );
    expect(a?.aligned).toBe("spf");
    expect(a?.d).toBe("company.com");
  });

  it("a pass with no attributable mechanism says `unknown`, never guesses", () => {
    const a = parseAssurance(hdr("mx.cloudflare.net; spf=pass; dmarc=pass"), "company.com", AT);
    expect(a).toEqual({ dmarc: "pass", aligned: "unknown", d: "company.com", at: AT });
  });

  it("a dkim pass for an UNALIGNED domain does not claim dkim alignment", () => {
    // A mailing-list resigner's d= is a real signature over the message and
    // still not the From: domain's — attributing dkim here would assert
    // exactly the thing DMARC alignment exists to check.
    const a = parseAssurance(
      hdr("mx.cloudflare.net; dkim=pass header.d=lists.example.org; dmarc=pass header.from=company.com"),
      "company.com",
      AT,
    );
    expect(a?.aligned).toBe("unknown");
  });

  it("dmarc=fail, dmarc=none and a missing header all store NOTHING", () => {
    expect(parseAssurance(hdr("mx; dmarc=fail"), "x.com", AT)).toBeNull();
    expect(parseAssurance(hdr("mx; dmarc=none"), "x.com", AT)).toBeNull();
    expect(parseAssurance(hdr("mx; spf=pass"), "x.com", AT)).toBeNull();
    expect(parseAssurance([], "x.com", AT)).toBeNull();
  });

  it("only the TOPMOST header is consulted — a forged one below cannot upgrade", () => {
    const a = parseAssurance(
      [
        { key: "authentication-results", value: "mx.cloudflare.net; dmarc=pass; spf=pass" },
        { key: "authentication-results", value: "evil; dkim=pass header.d=company.com; dmarc=pass" },
      ],
      "company.com",
      AT,
    );
    expect(a?.aligned).toBe("unknown"); // the forged dkim below was never read
  });

  it("subdomain alignment is relaxed in both directions, unrelated is not", () => {
    expect(domainsAligned("mail.company.com", "company.com")).toBe(true);
    expect(domainsAligned("company.com", "mail.company.com")).toBe(true);
    expect(domainsAligned("notcompany.com", "company.com")).toBe(false);
    expect(domainsAligned("company.com.evil.net", "company.com")).toBe(false);
  });
});

// The integration half: the fact lands on the ROW (and only when earned).
// Same /dev/inject harness as boundary.test.ts — the real deliver().

const TENANT = "t_bm";
const ACCOUNT = "t_bm__a_assure";
const TOKEN = "internal-test-token";

async function scaffold(): Promise<FakeWorker> {
  const w = fakeEnv();
  await w.env.ROUTES.put(
    "route:example.test:ada",
    JSON.stringify({ kind: "mailbox", accountId: ACCOUNT, tenantId: TENANT }),
  );
  return w;
}

const mime = (topHeaders: string[]) =>
  [
    ...topHeaders,
    "From: Sender <sender@elsewhere.test>",
    "To: Ada <ada@example.test>",
    "Subject: assurance",
    `Message-ID: <${Math.random().toString(36).slice(2)}@elsewhere.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ].join("\r\n");

async function inject(w: FakeWorker, raw: string) {
  const res = await worker.fetch(
    new Request("https://ingest.test/dev/inject?from=sender%40elsewhere.test&to=ada@example.test", {
      method: "POST",
      headers: { "x-internal-token": TOKEN },
      body: raw,
    }),
    { ...w.env, DEV_INJECT: "1", INTERNAL_TOKEN: TOKEN } as never,
    { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never,
  );
  return res.json() as Promise<{ emailId?: string; rejected?: string }>;
}

const rowOf = (w: FakeWorker) =>
  w.db.query<{ assurance_json: string | null }>("SELECT assurance_json FROM emails WHERE account_id = ?", ACCOUNT)[0]!;

describe("delivery stores the assurance", () => {
  it("a dkim-aligned pass lands as the structured fact on the row", async () => {
    const w = await scaffold();
    const r = await inject(
      w,
      mime([
        "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=elsewhere.test; dmarc=pass header.from=elsewhere.test",
      ]),
    );
    expect(r.emailId).toBeTruthy();
    const stored = JSON.parse(rowOf(w).assurance_json!);
    expect(stored.dmarc).toBe("pass");
    expect(stored.aligned).toBe("dkim");
    expect(stored.d).toBe("elsewhere.test");
    expect(typeof stored.at).toBe("number");
  });

  it("no Authentication-Results → NULL, which means NOT KNOWN", async () => {
    const w = await scaffold();
    const r = await inject(w, mime([]));
    expect(r.emailId).toBeTruthy();
    expect(rowOf(w).assurance_json).toBeNull();
  });
});
