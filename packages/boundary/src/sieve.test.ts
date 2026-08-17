import { describe, expect, it } from "vitest";
import type { BoundaryMessage } from "./message.js";
import { globMatch, sieveVerdict, type SieveRule } from "./sieve.js";

/** A plain message; rows override what they test. */
const msg = (over: Partial<BoundaryMessage> = {}): BoundaryMessage => ({
  from: "alice@example.com",
  fromDomain: "example.com",
  subject: "Quarterly report attached",
  textBody: "Hi — the Q3 numbers are attached. Best, Alice",
  headers: { "List-Id": "<staff.example.com>", "Reply-To": "alice@example.com" },
  sizeBytes: 2048,
  hasAttachments: true,
  // `over` was accepted and then DROPPED — the doc above promised an override
  // this helper never applied. No caller passed one, so nothing was silently
  // wrong yet; the next one would have been.
  ...over,
});

const reject = (id: string, all: SieveRule["all"]): SieveRule => ({ id, all, action: "reject" });
const pass = (id: string, all: SieveRule["all"]): SieveRule => ({ id, all, action: "pass" });

describe("sieveVerdict — ordering, first match wins", () => {
  const m = msg();
  const rejectFromExample = reject("r-example", [
    { kind: "contains", field: "fromDomain", value: "example.com" },
  ]);
  const passAlice = pass("p-alice", [{ kind: "contains", field: "from", value: "alice@" }]);

  it("reject listed first → FAIL names the reject rule", () => {
    expect(sieveVerdict([rejectFromExample, passAlice], m)).toEqual({
      verdict: "FAIL",
      ruleId: "r-example",
    });
  });

  it("pass listed first → PASS names the pass rule (allow short-circuits later rejects)", () => {
    expect(sieveVerdict([passAlice, rejectFromExample], m)).toEqual({
      verdict: "PASS",
      ruleId: "p-alice",
    });
  });

  it("first MATCHING rule wins — a non-matching earlier rule is skipped", () => {
    const miss = reject("r-miss", [{ kind: "contains", field: "subject", value: "viagra" }]);
    expect(sieveVerdict([miss, rejectFromExample], m).ruleId).toBe("r-example");
  });

  it("no rule matches → PASS with NO ruleId", () => {
    const out = sieveVerdict([reject("r", [{ kind: "contains", field: "subject", value: "zzz" }])], m);
    expect(out).toEqual({ verdict: "PASS" });
    expect("ruleId" in out).toBe(false);
  });

  it("empty ruleset → PASS", () => {
    expect(sieveVerdict([], m)).toEqual({ verdict: "PASS" });
  });

  it("empty `all` conjunction NEVER fires (a malformed rule is not match-everything)", () => {
    expect(sieveVerdict([reject("r-empty", [])], m)).toEqual({ verdict: "PASS" });
  });
});

describe("sieveVerdict — every matcher kind", () => {
  type Row = [name: string, rule: SieveRule, m: BoundaryMessage, want: "PASS" | "FAIL"];
  const rows: Row[] = [
    ["contains/from hits", reject("r", [{ kind: "contains", field: "from", value: "ALICE" }]), msg(), "FAIL"],
    ["contains/from misses", reject("r", [{ kind: "contains", field: "from", value: "bob" }]), msg(), "PASS"],
    ["contains/fromDomain hits", reject("r", [{ kind: "contains", field: "fromDomain", value: "example" }]), msg(), "FAIL"],
    ["contains/subject hits case-insensitively", reject("r", [{ kind: "contains", field: "subject", value: "quarterly REPORT" }]), msg(), "FAIL"],
    ["glob/from anchored hit", reject("r", [{ kind: "glob", field: "from", value: "*@example.com" }]), msg(), "FAIL"],
    ["glob/fromDomain ? hit", reject("r", [{ kind: "glob", field: "fromDomain", value: "example.co?" }]), msg(), "FAIL"],
    ["glob/subject hit", reject("r", [{ kind: "glob", field: "subject", value: "quarterly*" }]), msg(), "FAIL"],
    ["headerPresent hits (name case-insensitive)", reject("r", [{ kind: "headerPresent", name: "list-id" }]), msg(), "FAIL"],
    ["headerPresent misses", reject("r", [{ kind: "headerPresent", name: "x-mailer" }]), msg(), "PASS"],
    ["headerContains hits", reject("r", [{ kind: "headerContains", name: "LIST-ID", value: "staff" }]), msg(), "FAIL"],
    ["headerContains on an absent header misses", reject("r", [{ kind: "headerContains", name: "x-mailer", value: "bulk" }]), msg(), "PASS"],
    ["headerGlob hits", reject("r", [{ kind: "headerGlob", name: "list-id", value: "<staff.*>" }]), msg(), "FAIL"],
    ["headerGlob on an absent header misses", reject("r", [{ kind: "headerGlob", name: "x-mailer", value: "*" }]), msg(), "PASS"],
    [
      "conjunction: ALL matchers must hit",
      reject("r", [
        { kind: "contains", field: "fromDomain", value: "example.com" },
        { kind: "contains", field: "subject", value: "viagra" },
      ]),
      msg(),
      "PASS",
    ],
    [
      "conjunction: both hit → fires",
      reject("r", [
        { kind: "contains", field: "fromDomain", value: "example.com" },
        { kind: "headerPresent", name: "reply-to" },
      ]),
      msg(),
      "FAIL",
    ],
  ];

  it.each(rows)("%s", (_name, rule, m, want) => {
    expect(sieveVerdict([rule], m).verdict).toBe(want);
  });
});

describe("globMatch — anchoring semantics", () => {
  type Row = [pattern: string, text: string, want: boolean];
  const rows: Row[] = [
    // No wildcard → whole-string equality, not substring.
    ["spam", "spam", true],
    ["spam", "spamhouse", false],
    ["spam", "aspam", false],
    // Prefix / suffix / substring by explicit stars.
    ["spam*", "spamhouse", true],
    ["spam*", "aspam", false],
    ["*spam", "aspam", true],
    ["*spam*", "the spam house", true],
    ["*@example.com", "alice@example.com", true],
    ["*@example.com", "alice@example.com.evil.biz", false],
    // ? is exactly one char.
    ["r?port", "report", true],
    ["r?port", "rport", false],
    ["r?port", "reeport", false],
    // Star runs, empty matches.
    ["*", "", true],
    ["**", "anything", true],
    ["", "", true],
    ["", "x", false],
    ["a*b*c", "a-x-b-y-c", true],
    ["a*b*c", "a-x-c-y-b", false],
  ];

  it.each(rows)("%j vs %j → %s", (pattern, text, want) => {
    expect(globMatch(pattern, text)).toBe(want);
  });

  it("a would-be-ReDoS pattern completes fast (O(n·m) by construction, no RegExp)", () => {
    // Against a backtracking regex engine, (a*)*b-style patterns on a long
    // non-matching input are exponential. The iterative matcher is bounded
    // by pattern-length × text-length steps whatever the input.
    const pattern = "a*a*a*a*a*a*a*a*a*a*b";
    const text = "a".repeat(10_000); // no 'b' → must fail, the worst case
    const t0 = performance.now();
    const out = globMatch(pattern, text);
    const elapsed = performance.now() - t0;
    expect(out).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
  });
});
