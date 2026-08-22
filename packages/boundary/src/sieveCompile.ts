// Compile the boundary's JSON ruleset into RFC 5228 Sieve text.
//
// The read half of s31: RFC 9661 represents a script as a BLOB of Sieve, and
// our store is `rules_json` -- a structured dialect. This module is the
// bridge, and its one obligation is HONESTY: the text it emits must mean
// exactly what `sieveVerdict` does, in the subset the capability advertises.
//
// The mapping is closer than it looks, which is why the extension list is
// short:
//
//   field `from`        -> `address :all "From"`     msg.from is the BARE
//                          address; `header` would also match the display
//                          name, which the engine does not.
//   field `fromDomain`  -> `address :domain "From"`  pre-split domain;
//                          :domain is core (RFC 5228 s2.7.4).
//   field `subject`     -> `header "Subject"`        the engine reads the
//                          header value.
//   glob (* run, ? one) -> `:matches`                identical wildcard
//                          semantics (s2.7.1).
//   contains            -> `:contains`               substring.
//   lowercased compare  -> default i;ascii-casemap   Sieve's default
//                          comparator is already case-insensitive.
//   headerPresent       -> `exists`                  core.
//   `all` conjunction   -> `allof (...)`             core.
//   first match wins    -> `stop;` after each action said explicitly.
//   action: reject      -> `fileinto "Quarantined"`  REJECT_STORE
//                          QUARANTINES -- it never discards, and `discard;`
//                          would lie about what the engine does.
//   action: pass        -> `keep;`                   the allow-through.
//
// So `require` names exactly ONE extension: "fileinto". More would be the
// #230/#238 mistake (advertising what is not real); fewer would make the
// emitted script invalid.

import type { SieveMatch, SieveRule } from "./sieve";

/** The extensions the compiled script uses -- the session capability's
 *  `sieveExtensions` MUST be exactly this list. */
export const SIEVE_EXTENSIONS: readonly string[] = ["fileinto"];

/** Where a firing reject actually puts mail: the held mailbox's REAL display
 *  name ("Quarantined" — a condition, not a room; role `junk` underneath, per
 *  quarantineRole.test.ts). The script tells the truth twice over: the
 *  boundary never discards, and the folder it names is the folder that
 *  exists. */
export const HELD_FOLDER = "Quarantined";

/** Sieve string literal (RFC 5228 s2.4.2): quote, escaping backslash and
 *  double-quote. Control characters are replaced with a space -- they have
 *  no business in a rule, and our validator never stores them anyway. */
export function sieveString(s: string): string {
  // Code-point filter rather than a control-char regex: the same strip, and
  // nothing for no-control-regex to flag.
  const cleaned = [...s].map((c) => (c.charCodeAt(0) < 0x20 ? " " : c)).join("");
  return `"${cleaned.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function matchTest(m: SieveMatch): string {
  switch (m.kind) {
    case "contains":
    case "glob": {
      const op = m.kind === "glob" ? ":matches" : ":contains";
      switch (m.field) {
        case "from":
          return `address :all ${op} "From" ${sieveString(m.value)}`;
        case "fromDomain":
          return `address :domain ${op} "From" ${sieveString(m.value)}`;
        case "subject":
          return `header ${op} "Subject" ${sieveString(m.value)}`;
      }
      break;
    }
    case "headerPresent":
      return `exists ${sieveString(m.name)}`;
    case "headerContains":
      return `header :contains ${sieveString(m.name)} ${sieveString(m.value)}`;
    case "headerGlob":
      return `header :matches ${sieveString(m.name)} ${sieveString(m.value)}`;
  }
  // Exhaustive above; a runtime fall-through must not silently emit nothing.
  throw new Error("unreachable: unknown match kind");
}

/**
 * The whole script. DETERMINISTIC -- same rules, same bytes -- because the
 * blob id is the content's hash, and a /get that re-compiles must land on
 * the same blob rather than mint a new one per read.
 */
export function compileSieve(rules: readonly SieveRule[]): string {
  const lines: string[] = [
    "# bullmoose boundary rules -- compiled from the account's ruleset.",
    "# Read-only for now: edits arrive through the rules ladder (s31),",
    "# where a change is a proposal you approve, not a file you overwrite.",
    `require ${sieveString(SIEVE_EXTENSIONS[0]!)};`,
    "",
  ];
  for (const rule of rules) {
    // The engine SKIPS an empty conjunction -- it never fires. `allof ()`
    // is invalid Sieve and `true` would fire where the engine does not;
    // omit it and say so, so script and engine cannot disagree.
    if (rule.all.length === 0) {
      lines.push(`# rule ${rule.id}: empty conjunction -- never fires, not compiled`);
      lines.push("");
      continue;
    }
    const tests = rule.all.map(matchTest);
    const test = tests.length === 1 ? tests[0]! : `allof (${tests.join(", ")})`;
    const action = rule.action === "reject" ? `fileinto ${sieveString(HELD_FOLDER)};` : "keep;";
    lines.push(`# rule ${rule.id}`);
    lines.push(`if ${test} {`);
    lines.push(`    ${action}`);
    // First match wins in the engine; `stop` makes the script SAY it
    // rather than rely on the reader knowing our evaluation order.
    lines.push("    stop;");
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}
