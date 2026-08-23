import { describe, expect, it } from "vitest";
import { compileSieve } from "./sieveCompile";
import { parseSieve } from "./sieveParse";
import type { SieveRule } from "./sieve";

// The parser is the compiler's INVERSE, and the round-trip is the contract:
// parse(compile(rules)) must reproduce every rule the compiler compiles,
// ids included. Beyond the round-trip, the parser reads a standards
// client's hand-composed script — and REFUSES, with a line and a sentence,
// everything the engine cannot run. A clause that silently vanished on save
// would be a filter the owner believes in and does not have.

const ok = (text: string) => {
  const r = parseSieve(text);
  if (!r.ok) throw new Error(`expected ok, got: ${r.refusals.join("; ")}`);
  return r.rules;
};
const refusal = (text: string) => {
  const r = parseSieve(text);
  if (r.ok) throw new Error("expected a refusal");
  return r.refusals.join("; ");
};

describe("round-trip — parse(compile(rules)) === rules", () => {
  it("1. every match kind, both actions, ids recovered from the comments", () => {
    const rules: SieveRule[] = [
      { id: "inv_a", all: [{ kind: "contains", field: "from", value: "noisy@example.com" }], action: "reject" },
      { id: "inv_b", all: [{ kind: "glob", field: "fromDomain", value: "*.spam.example" }], action: "reject" },
      { id: "hand_c", all: [{ kind: "contains", field: "subject", value: "sale" }], action: "pass" },
      {
        id: "inv_d",
        all: [
          { kind: "headerPresent", name: "List-Unsubscribe" },
          { kind: "headerContains", name: "X-Mailer", value: "bulk" },
          { kind: "headerGlob", name: "List-Id", value: "*.deals.*" },
        ],
        action: "reject",
      },
    ];
    expect(ok(compileSieve(rules))).toEqual(rules);
  });

  it("2. an empty conjunction never-fires and is NOT resurrected by the parser", () => {
    // The compiler omits it with a comment; the parser must not invent a
    // rule from prose. The drop is visible to the caller as a missing id —
    // the provenance diff's job, not the parser's.
    const rules: SieveRule[] = [{ id: "inv_e", all: [], action: "reject" }];
    expect(ok(compileSieve(rules))).toEqual([]);
  });
});

describe("hand-composed scripts — what Boogie writes", () => {
  it("10. a bare rule with no id comment parses id-less, for the caller to mint", () => {
    const rules = ok(`require "fileinto";\nif address :contains "From" "x@y.z" { fileinto "Quarantined"; }`);
    expect(rules).toEqual([{ all: [{ kind: "contains", field: "from", value: "x@y.z" }], action: "reject" }]);
  });

  it("11. RFC 5228's default match type is :is — mapped to an exact glob", () => {
    const rules = ok(`if header "Subject" "won a prize" { fileinto "Quarantined"; stop; }`);
    expect(rules[0]!.all).toEqual([{ kind: "glob", field: "subject", value: "won a prize" }]);
  });

  it("12. an elsif chain IS first-match-wins — each branch becomes a rule, in order", () => {
    const rules = ok(
      `if address :all :contains "From" "a@b.c" { keep; }
       elsif header :contains "Subject" "sale" { fileinto "Quarantined"; }`,
    );
    expect(rules.map((r) => r.action)).toEqual(["pass", "reject"]);
  });

  it("13. exists with a list is a conjunction — expanded, not refused", () => {
    const rules = ok(`if allof (exists ["List-Id", "List-Unsubscribe"]) { fileinto "Quarantined"; }`);
    expect(rules[0]!.all).toEqual([
      { kind: "headerPresent", name: "List-Id" },
      { kind: "headerPresent", name: "List-Unsubscribe" },
    ]);
  });

  it("14. nested allof flattens — conjunction of conjunction is conjunction", () => {
    const rules = ok(
      `if allof (address :contains "From" "x@y.z", allof (exists "List-Id")) { fileinto "Quarantined"; }`,
    );
    expect(rules[0]!.all).toHaveLength(2);
  });

  it("15. a trailing bare keep; is the implicit default said out loud — ignored", () => {
    expect(ok(`if exists "X-Spam" { fileinto "Quarantined"; }\nkeep;`)).toHaveLength(1);
  });
});

describe("refusals — a sentence with a line, never a silent drop", () => {
  it("20. anyof names the fix", () => {
    expect(refusal(`if anyof (exists "A", exists "B") { keep; }`)).toContain("split it into separate rules");
  });
  it("21. discard names the held folder", () => {
    expect(refusal(`if exists "X" { discard; }`)).toContain("never discards");
  });
  it("22. fileinto anywhere but the held folder", () => {
    expect(refusal(`if exists "X" { fileinto "Personal"; }`)).toContain('"Quarantined" only');
  });
  it("23. an unsupported extension at require", () => {
    expect(refusal(`require ["fileinto", "vacation"];`)).toContain('"vacation" is not supported');
  });
  it("24. :is with wildcards has no honest mapping", () => {
    expect(refusal(`if header :is "Subject" "win *" { keep; }`)).toContain("no honest mapping");
  });
  it("25. address on any header but From", () => {
    expect(refusal(`if address :contains "To" "me@x.y" { keep; }`)).toContain("From only");
  });
  it("26. a value list is an OR", () => {
    expect(refusal(`if header :contains "Subject" ["a", "b"] { keep; }`)).toContain("split into separate rules");
  });
  it("27. else, not, redirect — each refused by name", () => {
    expect(refusal(`if exists "X" { keep; } else { fileinto "Quarantined"; }`)).toContain("else");
    expect(refusal(`if not exists "X" { keep; }`)).toContain("not is outside");
    expect(refusal(`if exists "X" { redirect "a@b.c"; }`)).toContain('"redirect" is outside');
  });
  it("28. two meaningful actions in one block", () => {
    expect(refusal(`if exists "X" { fileinto "Quarantined"; keep; }`)).toContain("one action per rule");
  });
  it("29. garbage is a refusal, never a throw", () => {
    const r = parseSieve("@@@ not sieve at all");
    expect(r.ok).toBe(false);
  });
});
