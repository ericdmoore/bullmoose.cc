import { describe, expect, it } from "vitest";
import { compileSieve, sieveString, SIEVE_EXTENSIONS } from "./sieveCompile";
import { sieveVerdict, type SieveRule } from "./sieve";

// The compiler's one obligation is HONESTY: the emitted Sieve must mean what
// sieveVerdict does. Several tests assert the compiled TEXT and the engine's
// VERDICT against the same rule, because the text drifting from the engine is
// the failure that matters and no syntax check can catch it.

const rule = (over: Partial<SieveRule> = {}): SieveRule => ({
  id: "r1",
  all: [{ kind: "contains", field: "from", value: "noisy@example.com" }],
  action: "reject",
  ...over,
});

describe("sieveString", () => {
  it("1. escapes quotes and backslashes per RFC 5228 2.4.2", () => {
    expect(sieveString('a"b')).toBe('"a\\"b"');
    expect(sieveString("a\\b")).toBe('"a\\\\b"');
  });

  it("2. control characters are replaced, never emitted", () => {
    // A NUL inside a quoted string makes the script binary to some parsers --
    // and sourceIsGreppable taught us what a stray NUL costs.
    expect(sieveString("a\u0000b\u0001c")).toBe('"a b c"');
  });
});

describe("compileSieve -- the mapping is faithful", () => {
  it("10. a from rule compiles to address :all, because msg.from is the BARE address", () => {
    // `header :contains "From"` would also match the display name, which the
    // engine does not -- a rule on "smith" would fire for a display name in
    // Sieve but not in the boundary. address :all means what the engine means.
    const text = compileSieve([rule()]);
    expect(text).toContain('address :all :contains "From" "noisy@example.com"');
    expect(text).not.toContain('header :contains "From"');
  });

  it("11. fromDomain uses the core :domain address part", () => {
    const text = compileSieve([rule({ all: [{ kind: "glob", field: "fromDomain", value: "*.spam.example" }] })]);
    expect(text).toContain('address :domain :matches "From" "*.spam.example"');
  });

  it("12. reject compiles to fileinto the held mailbox's REAL name -- never discard", () => {
    // REJECT_STORE holds, it does not discard -- and the folder the script
    // names must be the folder that exists: "Quarantined", the junk-role
    // mailbox's display name (quarantineRole.test.ts). "Quarantine" was the
    // invented spelling this repo already retired once.
    const text = compileSieve([rule()]);
    expect(text).toContain('fileinto "Quarantined";');
    expect(text).not.toContain("discard");
  });

  it("13. pass compiles to keep -- and both actions stop, saying first-match-wins out loud", () => {
    const text = compileSieve([
      rule({ id: "allow", action: "pass" }),
      rule({ id: "deny", all: [{ kind: "contains", field: "subject", value: "sale" }] }),
    ]);
    expect(text).toContain("keep;");
    expect(text.match(/stop;/g)).toHaveLength(2);
    // Order preserved: the engine evaluates in order, so must the script.
    expect(text.indexOf("# rule allow")).toBeLessThan(text.indexOf("# rule deny"));
  });

  it("14. a conjunction compiles to allof", () => {
    const text = compileSieve([
      rule({
        all: [
          { kind: "contains", field: "from", value: "x@y.z" },
          { kind: "headerPresent", name: "List-Unsubscribe" },
        ],
      }),
    ]);
    expect(text).toContain('allof (address :all :contains "From" "x@y.z", exists "List-Unsubscribe")');
  });

  it("15. an empty conjunction is omitted with a comment -- engine and script agree it never fires", () => {
    const r = rule({ all: [] });
    const text = compileSieve([r]);
    expect(text).toContain("never fires, not compiled");
    expect(text).not.toContain("if ");
    const msg = { from: "a@b.c", fromDomain: "b.c", subject: "x", textBody: "", headers: {} } as Parameters<
      typeof sieveVerdict
    >[1];
    expect(sieveVerdict([r], msg).ruleId).toBeUndefined();
  });

  it("16. require names exactly the advertised extensions", () => {
    // The capability's sieveExtensions and the script's require are the same
    // list BY CONSTRUCTION; this pins that neither drifts alone.
    const text = compileSieve([rule()]);
    for (const ext of SIEVE_EXTENSIONS) expect(text).toContain(`require "${ext}";`);
    expect(SIEVE_EXTENSIONS).toEqual(["fileinto"]);
  });

  it("17. deterministic -- same rules, same bytes, because the blob id is the hash", () => {
    const rules = [rule(), rule({ id: "r2", action: "pass" })];
    expect(compileSieve(rules)).toBe(compileSieve(rules));
  });
});
