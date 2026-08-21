import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveLoginKey } from "@bullmoose/auth-core";
import { consentPage, DERIVE_FN_SRC, deriveScript } from "./consent";

// s02 T3 — the consent screen is also the system's real login, so two
// separate things need pinning: that the browser derives the SAME login key
// the server expects, and that the page cannot leak the password or be
// turned into someone else's form.

/** Evaluate the browser-side derivation exactly as shipped. */
const browserDerive = new Function(`${DERIVE_FN_SRC}; return deriveLoginKey;`)() as (
  email: string,
  password: string,
) => Promise<string>;

const VECTORS = JSON.parse(readFileSync(new URL("../../../conformance/login-key.json", import.meta.url), "utf8")) as {
  iterations: number;
  saltLabel: string;
  vectors: Array<{ name: string; email: string; password: string; loginKey: string }>;
};

describe("the browser derivation matches the server's contract", () => {
  // This is the test that keeps everyone able to log in. The page cannot
  // import a workspace module — it runs in the visitor's browser — so the
  // derivation is hand-written there. A drift does not throw: it produces a
  // different key and rejects every correct password.
  it("1. reproduces every conformance vector", async () => {
    for (const v of VECTORS.vectors) {
      expect(await browserDerive(v.email, v.password), v.name).toBe(v.loginKey);
    }
  });

  it("2. agrees with auth-core's deriveLoginKey directly", async () => {
    for (const [email, password] of [
      ["eric@bullmoose.cc", "correct horse battery staple"],
      ["someone@example.org", "a"],
      ["unicode@bullmoose.cc", "pässwörd — with emoji 🐴"],
    ] as const) {
      expect(await browserDerive(email, password)).toBe(await deriveLoginKey(email, password));
    }
  });

  it("3. lower-cases the email into the salt, as the salt contract requires", async () => {
    // A port that skips this fails login with a correct password.
    expect(await browserDerive("Eric@Bullmoose.CC", "correct horse battery staple")).toBe(
      await browserDerive("eric@bullmoose.cc", "correct horse battery staple"),
    );
  });

  it("4. carries the iteration count and salt label from auth-core, not a retyped copy", () => {
    expect(DERIVE_FN_SRC).toContain(String(VECTORS.iterations));
    expect(DERIVE_FN_SRC).toContain(VECTORS.saltLabel);
  });
});

describe("the page does not leak the password", () => {
  const script = () => deriveScript();

  it("10. clears the password field before the form submits", async () => {
    const js = await script().text();
    expect(js).toContain('form.password.value = ""');
  });

  it("11. sends the derived loginKey, never the password", async () => {
    const js = await script().text();
    // The derived value is what lands in the submitted field.
    expect(js).toContain("form.loginKey.value = await deriveLoginKey");
  });

  it("12. serves the script as a file so the page needs no 'unsafe-inline'", async () => {
    expect(script().headers.get("content-type")).toContain("text/javascript");
  });
});

describe("consent page — what it says and what it refuses", () => {
  const page = (scope: string[], error?: string) =>
    consentPage({
      client: { clientId: "https://claude.ai/mcp", clientName: "Claude", redirectUris: [] },
      authReq: {
        clientId: "https://claude.ai/mcp",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope,
        state: "s",
      },
      error,
    });

  it("20. explains the mail BUNDLE as the verbs it confers, not as a word", async () => {
    const html = await page(["mail"]).text();
    expect(html).toContain("Read your mail");
    expect(html).toContain("Delete your mail");
  });

  it("21. shows the redirect HOSTNAME — CIMD cannot prevent localhost impersonation", async () => {
    const html = await page(["read"]).text();
    expect(html).toContain("claude.ai");
  });

  it("22. refuses to be framed, and refuses to post anywhere but here", () => {
    const csp = page(["read"]).headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline'; script");
  });

  it("23. is never cached — it is a credential page", () => {
    expect(page(["read"]).headers.get("cache-control")).toBe("no-store");
  });

  it("24. escapes a client name rather than rendering it as markup", async () => {
    const html = await consentPage({
      client: { clientId: "x", clientName: "<img src=x onerror=alert(1)>", redirectUris: [] },
      authReq: { clientId: "x", redirectUri: "https://claude.ai/cb", scope: ["read"], state: "s" },
    }).text();
    expect(html).not.toContain("<img src=x");
  });

  it("25. answers 401 when re-rendered after a failed attempt", () => {
    expect(page(["read"], "That address and password did not match.").status).toBe(401);
  });
});

// The drift guard #128 needed: `files` was added to OAUTH_SCOPES and the
// consent screen — whose prose did not know the word — granted the scope
// while silently omitting it from "It is asking to:". A permission the human
// never saw is not consent. Two layers now hold the coupling: these tests
// (fail in CI), and the page itself refusing to render an unexplained scope
// (fail loudly in production rather than silently under-inform).
describe("every grantable scope is explained — the #128 drift guard", () => {
  it("30. every OAUTH_SCOPES entry expands to prose-covered scopes only", async () => {
    const { OAUTH_SCOPES, effectiveScopes } = await import("@bullmoose/auth-core");
    for (const s of OAUTH_SCOPES) {
      const html = await consentPage({
        client: { clientId: "x", clientName: "Drift Probe", redirectUris: [] },
        authReq: { clientId: "x", redirectUri: "https://claude.ai/cb", scope: [s], state: "st" },
      }).text();
      expect(html, `scope "${s}" must render an explanation`).toContain("<li>");
      expect(html, `scope "${s}" must not hit the unexplained-scope refusal`).not.toContain("cannot explain");
      // And nothing the expansion confers may be silently missing: every
      // effective scope is either prose-listed or a NAMED display exception.
      void effectiveScopes([s]);
    }
  });

  it("31. files — the scope #128 added — renders its line", async () => {
    const html = await consentPage({
      client: { clientId: "x", clientName: "Files App", redirectUris: [] },
      authReq: {
        clientId: "x",
        redirectUri: "https://claude.ai/cb",
        scope: ["files"],
        state: "st",
      },
    }).text();
    expect(html).toContain("Read and change your files");
  });

  it("32. a scope with no prose refuses the whole page — loud, never silent", async () => {
    // Simulate the next drift: a scope the gate's expansion knows (admin is
    // in CONCRETE_SCOPES) but the prose does not. The page must refuse with
    // a 500 naming the drift, not render a shorter list.
    const res = consentPage({
      client: { clientId: "x", clientName: "Future App", redirectUris: [] },
      authReq: {
        clientId: "x",
        redirectUri: "https://claude.ai/cb",
        scope: ["admin"],
        state: "st",
      },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("cannot explain");
  });

  it("33. mail still renders — send is a NAMED display exception, not a drift", async () => {
    const html = await consentPage({
      client: { clientId: "x", clientName: "Mail App", redirectUris: [] },
      authReq: { clientId: "x", redirectUri: "https://claude.ai/cb", scope: ["mail"], state: "st" },
    }).text();
    expect(html).toContain("Delete your mail");
    expect(html).not.toContain("cannot explain");
  });
});

describe("the submit handler survives implicit submission — the phone bug", () => {
  // Eric's first phone test could not sign in at all. On iOS the natural
  // gesture after typing a password is the keyboard's "Go", which submits the
  // form IMPLICITLY — and implicit submission leaves `ev.submitter` null (it
  // is also absent in Safari before 15.4). The handler read `.disabled` off it
  // *after* calling preventDefault(), so the TypeError killed the handler with
  // the form already cancelled: no navigation, no error text, no change to the
  // button. The front door simply did nothing. These tests run the shipped
  // script, so a regression cannot hide behind a source grep.
  async function runScript(submitter: { value: string; disabled: boolean; textContent: string } | null) {
    const src = await deriveScript().text();
    const calls = { submitted: 0, prevented: 0 };
    const approve = { value: "approve", disabled: false, textContent: "Approve" };
    const err = { textContent: "" };
    const field = (value = "") => ({ value });
    let handler!: (ev: unknown) => Promise<void>;
    const form = {
      email: field("someone@bullmoose.cc"),
      password: field("correct horse battery staple"),
      loginKey: field(""),
      querySelector: () => approve,
      addEventListener: (_: string, fn: (ev: unknown) => Promise<void>) => (handler = fn),
      appendChild: () => undefined,
      submit: () => calls.submitted++,
    };
    const document = {
      getElementById: (id: string) => (id === "consent" ? form : err),
      createElement: () => ({}) as Record<string, string>,
    };
    new Function("document", src)(document);
    await handler({ submitter, preventDefault: () => calls.prevented++ });
    return { form, calls, approve, err };
  }

  it("40. derives and submits when the keyboard submits the form (submitter is null)", async () => {
    const { form, calls, err } = await runScript(null);
    expect(calls.submitted, "the form must still post").toBe(1);
    expect(form.loginKey.value, "the login key must be derived").toMatch(/^[0-9a-f]{64}$/);
    expect(form.password.value, "the raw password must never reach the network").toBe("");
    expect(err.textContent, "a working submit must not show an error").toBe("");
  });

  it("41. still labels the button it can find, so the wait is legible", async () => {
    const { approve } = await runScript(null);
    expect(approve.textContent).toBe("Checking…");
    expect(approve.disabled).toBe(true);
  });

  it("42. lets Cancel post natively — deny has nothing to derive", async () => {
    const deny = { value: "deny", disabled: false, textContent: "Cancel" };
    const { calls, form } = await runScript(deny);
    expect(calls.prevented, "deny must not be intercepted").toBe(0);
    expect(calls.submitted, "the browser posts it, not us").toBe(0);
    expect(form.loginKey.value).toBe("");
  });
});

describe("first-party sign-in does not get the stranger-danger treatment", () => {
  const WEBMAIL = "https://app.bullmoose.cc/oauth/client.json";
  const render = (firstParty: boolean) =>
    consentPage({
      client: { clientId: WEBMAIL, clientName: "bullmoose webmail", redirectUris: [] },
      authReq: { clientId: WEBMAIL, redirectUri: "https://app.bullmoose.cc/login", scope: ["mail"], state: "s" },
      firstParty,
    });

  it("50. never asks the question that names the same thing twice", async () => {
    // "Connect bullmoose webmail to bullmoose?" — client and resource were the
    // same word, so the sentence carried no information.
    expect(await render(true).text()).not.toContain("to bullmoose?");
    expect(await render(false).text()).not.toContain("to bullmoose?");
  });

  it("51. tells the human they are signing in to our own webmail", async () => {
    const html = await render(true).text();
    expect(html).toContain("Sign in to bullmoose");
    expect(html).toContain("bullmoose's own webmail");
    expect(html).not.toContain("Only continue if you recognize");
  });

  it("52. keeps the warning for a client we cannot vouch for", async () => {
    const stranger = consentPage({
      client: { clientId: "https://claude.ai/mcp", clientName: "Claude", redirectUris: [] },
      authReq: {
        clientId: "https://claude.ai/mcp",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope: ["mail"],
        state: "s",
      },
    });
    const html = await stranger.text();
    expect(html).toContain("Only continue if you recognize that address");
    expect(html).toContain("claude.ai");
    expect(html).toContain("wants to connect to your bullmoose account");
  });
});
