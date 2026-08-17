import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeTarget, resolveClient } from "./client";

// THE invariant of s07 T1: a token never enters a URL.
//
// A credential in a query string lands in browser history, in the `Referer` of
// every outbound link the user clicks next — and in a mail client every link is
// attacker-chosen — and in every access log along the path. It is also the one
// leak that cannot be walked back: you can revoke the token, but you cannot
// un-log it. The obvious login shape (a form that redirects to
// `/mail?token=…`) would introduce it, and today's `?token=` dev affordance
// leaves one behind unless something removes it.
//
// So this file holds the whole invariant from both ends: the behaviour of the
// resolver, and a scan of every file on the app surface for the shapes that
// would reintroduce it. The scan reads the directories rather than a list, so
// a NEW page or island is covered the moment it lands.
//
// ⚠️ Deliberately NOT covered: `lib/jmap/JmapClient.ts:367` puts the token in
// the WebSocket URL as `access_token`, because a browser WebSocket cannot send
// an `Authorization` header. That URL is never navigated to, never entered in
// history and never sent as a `Referer` — it is a protocol constraint, not this
// mistake, and "fixing" it would break push.

const SRC = new URL("../../", import.meta.url);

function filesIn(dir: string, ext: string): string[] {
  const abs = fileURLToPath(new URL(dir, SRC));
  return readdirSync(abs)
    .filter((f) => f.endsWith(ext) && !f.endsWith(`.test${ext}`))
    .map((f) => `${abs}${f}`);
}

/** Every file that can navigate the browser or render a form. */
const SURFACE = [
  ...filesIn("lib/app/", ".ts"),
  ...filesIn("components/", ".tsx"),
  ...filesIn("pages/", ".astro"),
  ...filesIn("layouts/", ".astro"),
];

/**
 * Strip comments, so the scan tests CODE and not prose — half these files
 * discuss `?token=` at length precisely because it is dangerous.
 *
 * The `[^:]` guard keeps `https://` from eating the rest of its line. Crude,
 * and it only has to be good enough not to hide a real occurrence.
 */
function code(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const named = (f: string) => f.slice(f.lastIndexOf("/") + 1);

describe("no code path puts a token in a URL", () => {
  it("scans a surface that is actually populated", () => {
    // Guard against the whole file passing vacuously because a rename emptied
    // the globs.
    expect(SURFACE.length).toBeGreaterThanOrEqual(10);
    expect(SURFACE.map(named)).toContain("LoginForm.tsx");
    expect(SURFACE.map(named)).toContain("login.astro");
  });

  for (const file of SURFACE) {
    const src = code(readFileSync(file, "utf8"));
    const where = named(file);

    it(`${where} never builds a token query string`, () => {
      expect(src, "a literal ?token= / &token=").not.toMatch(/[?&]token=/);
      expect(src, "URLSearchParams.set/append('token')").not.toMatch(
        /\.(set|append)\(\s*["'`]token/,
      );
      expect(src, "access_token in a navigable URL").not.toMatch(/[?&]access_token=/);
    });

    it(`${where} never pushes a history entry`, () => {
      // `pushState` would create exactly the record the strip exists to
      // remove. `replaceState` is the only history call this app makes, and
      // only client.ts makes it.
      expect(src).not.toMatch(/pushState/);
      if (where !== "client.ts") expect(src).not.toMatch(/replaceState/);
    });

    it(`${where} has no form that can navigate`, () => {
      // A <form> with no `action` still submits to the current URL as GET,
      // serializing every named field into the query string. The door has
      // neither an action nor a named field, and the generated CSP's
      // `form-action 'none'` refuses the navigation regardless.
      expect(src).not.toMatch(/<form[^>]*\b(action|method)\s*=/);
    });

    it(`${where} navigates only to literal paths`, () => {
      // The tightest form of the invariant: if every navigation target is a
      // literal starting with "/", none of them can carry a secret. Two
      // computed targets are allowed by name, and only two:
      //
      //   homeTarget(resolveClient())  — asserted credential-free below.
      //   start.authorizeUrl           — the OAuth provider's authorize
      //     endpoint (`lib/console/credentials.ts:270-278`). It is the one
      //     navigation that MUST leave this origin, and it carries only public
      //     OAuth parameters: client_id, redirect_uri, scope, state and the
      //     PKCE *challenge* — never the verifier, and never a bm_ token.
      //
      // `location\??\.` on purpose: `globalThis.location?.assign(x)` is the
      // same navigation and must not slip past the pattern.
      for (const [, , arg] of src.matchAll(/location\??\.(assign|replace)\((.*?)\);/g)) {
        expect(arg.trim(), `${where}: navigation target`).toMatch(
          /^("\/[a-z/-]*"|homeTarget\(resolveClient\(\)\)|start\.authorizeUrl)$/,
        );
      }
      // `location.href = …` navigates too, and would slip past the pattern
      // above. Nothing here needs it.
      expect(src, "assignment to location.href").not.toMatch(/location\.href\s*=[^=]/);
    });
  }

  it("the door's field is unnamed, and its submit is prevented", () => {
    const door = readFileSync(fileURLToPath(new URL("components/LoginForm.tsx", SRC)), "utf8");
    expect(door).toMatch(/preventDefault/);
    // No `name` means the browser has nothing to serialize even if the submit
    // were ever allowed to happen — the third of three overlapping guards.
    expect(code(door)).not.toMatch(/\bname\s*=/);
  });
});

// ── the same invariant, driven ──────────────────────────────────────────────

const TOKEN = "bm_0123456789ab_" + "a".repeat(48);
const ORIGIN = "https://app.bullmoose.cc";

let seen: string[];
let loc: { search: string; origin: string; href: string };

beforeEach(() => {
  seen = [];
  const map = new Map<string, string>();
  loc = { search: "", origin: ORIGIN, href: `${ORIGIN}/mail` };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      seen.push(url);
      loc.href = url;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("driven: the token is gone before anything else runs", () => {
  it("leaves no token in the URL, and none in what was written to history", () => {
    loc.href = `${ORIGIN}/mail?token=${TOKEN}`;
    loc.search = `?token=${TOKEN}`;
    resolveClient(loc.search);

    expect(seen).toHaveLength(1);
    for (const url of seen) expect(url).not.toContain(TOKEN);
    expect(loc.href).not.toContain(TOKEN);
    expect(loc.href).not.toContain("token");
  });

  it("still signs in — stripping is not the same as discarding", () => {
    loc.href = `${ORIGIN}/mail?token=${TOKEN}`;
    expect(resolveClient(`?token=${TOKEN}`).mode).toBe("live");
  });

  it("routes home to a path with no credential in it, in every mode", () => {
    for (const search of ["", "?demo=1", `?token=${TOKEN}`]) {
      loc.href = `${ORIGIN}/${search}`;
      const target = homeTarget(resolveClient(search));
      expect(target).not.toContain(TOKEN);
      expect(target).not.toMatch(/token/);
    }
  });
});
