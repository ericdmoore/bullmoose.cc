import { HELD_FOLDER, SIEVE_EXTENSIONS } from "./sieveCompile";
import type { SieveMatch } from "./sieve";

/**
 * The compiler's INVERSE (s31 rung 1). RFC 9661 delivers a whole script as
 * RFC 5228 text; the engine runs the dialect — so a hand-written save must
 * be parsed back into `SieveRule`s, and everything the engine cannot run is
 * REFUSED with a sentence naming the supported subset, never silently
 * dropped: a clause that vanishes on save is a filter the owner believes in
 * and does not have.
 *
 * Two sources feed this parser and both must work:
 *   - our own compiled output (round-trip: parse(compile(rules)) === rules
 *     for every rule the compiler compiles — pinned by test), with rule ids
 *     recovered from the `# rule <id>` comment lines;
 *   - a standards client's hand-composed script (Boogie's editor), which
 *     carries no id comments — those rules are NEW, and the caller mints
 *     hand ids for them.
 *
 * ## What is refused, and why the sentence matters
 *
 * `anyof` (first match wins — split into separate rules), `not`, `else`,
 * `discard` (the boundary never discards; mail is HELD, reviewable),
 * `redirect`/`vacation`/every unadvertised extension, `:is` on a value
 * carrying wildcards (no honest mapping), address tests on any header but
 * From, and multi-valued key lists (a list is an OR, and the dialect has
 * no OR). Each refusal names its line.
 */

export interface ParsedSieveRule {
  /** Recovered from a `# rule <id>` comment; absent for hand-new rules. */
  id?: string;
  all: SieveMatch[];
  action: "reject" | "pass";
}

export type SieveParseResult = { ok: true; rules: ParsedSieveRule[] } | { ok: false; refusals: string[] };

type Tok =
  | { t: "atom"; v: string; line: number }
  | { t: "tag"; v: string; line: number }
  | { t: "str"; v: string; line: number }
  | { t: "punc"; v: string; line: number };

class Refuse extends Error {}

function lex(text: string): { toks: Tok[]; ruleComments: Map<number, string> } {
  const toks: Tok[] = [];
  /** line → rule id, from `# rule <id>` comments. */
  const ruleComments = new Map<number, string>();
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const body = (end === -1 ? text.slice(i) : text.slice(i, end)).slice(1).trim();
      const m = body.match(/^rule (\S+?)(:.*)?$/);
      if (m) ruleComments.set(line, m[1]!);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Refuse(`line ${line}: unterminated comment`);
      line += text.slice(i, end).split("\n").length - 1;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      let v = "";
      let j = i + 1;
      for (; j < n; j++) {
        const d = text[j]!;
        if (d === "\\") {
          v += text[j + 1] ?? "";
          j++;
        } else if (d === '"') break;
        else v += d;
      }
      if (j >= n) throw new Refuse(`line ${line}: unterminated string`);
      toks.push({ t: "str", v, line });
      i = j + 1;
      continue;
    }
    if (c === ":") {
      const m = text.slice(i).match(/^:[a-z0-9_]+/i);
      if (!m) throw new Refuse(`line ${line}: stray ':'`);
      toks.push({ t: "tag", v: m[0].toLowerCase(), line });
      i += m[0].length;
      continue;
    }
    if ("({),;}]".includes(c) || c === "[") {
      toks.push({ t: "punc", v: c, line });
      i++;
      continue;
    }
    const m = text.slice(i).match(/^[a-z0-9_]+/i);
    if (!m) throw new Refuse(`line ${line}: unexpected character "${c}"`);
    toks.push({ t: "atom", v: m[0].toLowerCase(), line });
    i += m[0].length;
    continue;
  }
  return { toks, ruleComments };
}

/** One string, or a bracketed string-list. A LIST here is an OR, and the
 *  dialect has no OR — so lists are legal only where the caller says so. */
function strings(toks: Tok[], at: { i: number }): { values: string[]; line: number } {
  const t = toks[at.i];
  if (!t) throw new Refuse("unexpected end of script");
  if (t.t === "str") {
    at.i++;
    return { values: [t.v], line: t.line };
  }
  if (t.t === "punc" && t.v === "[") {
    at.i++;
    const values: string[] = [];
    for (;;) {
      const s = toks[at.i];
      if (!s || s.t !== "str") throw new Refuse(`line ${t.line}: expected a string in list`);
      values.push(s.v);
      at.i++;
      const p = toks[at.i];
      if (p?.t === "punc" && p.v === ",") {
        at.i++;
        continue;
      }
      if (p?.t === "punc" && p.v === "]") {
        at.i++;
        return { values, line: t.line };
      }
      throw new Refuse(`line ${t.line}: expected , or ] in list`);
    }
  }
  throw new Refuse(`line ${t.line}: expected a string`);
}

const OPS = new Set([":contains", ":matches", ":is"]);
const hasWildcard = (v: string) => v.includes("*") || v.includes("?");

/** Map (op, value) to the dialect's kind, with `:is` as a wildcard-free glob
 *  (a glob is anchored whole-field, so without wildcards it IS exact match). */
function opKind(op: string, value: string, line: number): "contains" | "glob" {
  if (op === ":contains") return "contains";
  if (op === ":matches") return "glob";
  if (hasWildcard(value)) {
    throw new Refuse(`line ${line}: :is with a value containing * or ? has no honest mapping — use :matches`);
  }
  return "glob";
}

function parseTest(toks: Tok[], at: { i: number }, out: SieveMatch[]): void {
  const t = toks[at.i];
  if (!t) throw new Refuse("unexpected end of script inside a test");
  if (t.t !== "atom") throw new Refuse(`line ${t.line}: expected a test`);

  if (t.v === "allof") {
    at.i++;
    expectPunc(toks, at, "(");
    for (;;) {
      parseTest(toks, at, out);
      const p = toks[at.i];
      if (p?.t === "punc" && p.v === ",") {
        at.i++;
        continue;
      }
      expectPunc(toks, at, ")");
      return;
    }
  }
  if (t.v === "anyof") {
    throw new Refuse(`line ${t.line}: anyof is an OR, and rules are first-match-wins — split it into separate rules`);
  }
  if (t.v === "not") throw new Refuse(`line ${t.line}: not is outside the dialect — say what the rule DOES match`);
  if (t.v === "true" || t.v === "false") throw new Refuse(`line ${t.line}: a constant test is outside the dialect`);

  if (t.v === "exists") {
    at.i++;
    const { values } = strings(toks, at);
    for (const name of values) out.push({ kind: "headerPresent", name });
    return;
  }

  if (t.v === "address" || t.v === "header") {
    at.i++;
    let part: ":all" | ":domain" | ":localpart" | null = null;
    let op = ":is"; // RFC 5228 default match type
    for (;;) {
      const tag = toks[at.i];
      if (tag?.t !== "tag") break;
      if (tag.v === ":all" || tag.v === ":domain" || tag.v === ":localpart") part = tag.v;
      else if (OPS.has(tag.v)) op = tag.v;
      else if (tag.v === ":comparator") {
        at.i++;
        const cmp = strings(toks, at);
        if (cmp.values[0] !== "i;ascii-casemap") {
          throw new Refuse(`line ${tag.line}: only the default comparator (i;ascii-casemap) is supported`);
        }
        continue;
      } else throw new Refuse(`line ${tag.line}: ${tag.v} is outside the dialect`);
      at.i++;
    }
    const headers = strings(toks, at);
    const keys = strings(toks, at);
    if (headers.values.length !== 1) {
      throw new Refuse(`line ${headers.line}: one header name per condition — a list is an OR the dialect cannot say`);
    }
    if (keys.values.length !== 1) {
      throw new Refuse(`line ${keys.line}: one value per condition — a list is an OR; split into separate rules`);
    }
    const header = headers.values[0]!;
    const value = keys.values[0]!;
    const kind = opKind(op, value, headers.line);

    if (t.v === "address") {
      if (header.toLowerCase() !== "from") {
        throw new Refuse(`line ${headers.line}: address tests are supported on From only`);
      }
      if (part === ":localpart") throw new Refuse(`line ${headers.line}: :localpart is outside the dialect`);
      out.push({ kind, field: part === ":domain" ? "fromDomain" : "from", value });
      return;
    }
    // header test
    if (header.toLowerCase() === "subject") {
      out.push({ kind, field: "subject", value });
      return;
    }
    out.push(
      kind === "contains"
        ? { kind: "headerContains", name: header, value }
        : { kind: "headerGlob", name: header, value },
    );
    return;
  }

  throw new Refuse(`line ${t.line}: the test "${t.v}" is outside the dialect`);
}

function expectPunc(toks: Tok[], at: { i: number }, v: string): void {
  const t = toks[at.i];
  if (!t || t.t !== "punc" || t.v !== v) {
    throw new Refuse(`line ${t?.line ?? "?"}: expected "${v}"`);
  }
  at.i++;
}

function parseBlock(toks: Tok[], at: { i: number }): "reject" | "pass" {
  expectPunc(toks, at, "{");
  let action: "reject" | "pass" | null = null;
  for (;;) {
    const t = toks[at.i];
    if (!t) throw new Refuse("unexpected end of script inside a block");
    if (t.t === "punc" && t.v === "}") {
      at.i++;
      break;
    }
    if (t.t !== "atom") throw new Refuse(`line ${t.line}: expected an action`);
    if (t.v === "stop") {
      at.i++;
      expectPunc(toks, at, ";");
      continue;
    }
    if (t.v === "keep") {
      at.i++;
      expectPunc(toks, at, ";");
      if (action && action !== "pass") throw new Refuse(`line ${t.line}: one action per rule`);
      action = "pass";
      continue;
    }
    if (t.v === "fileinto") {
      at.i++;
      const { values, line } = strings(toks, at);
      expectPunc(toks, at, ";");
      if (values.length !== 1 || values[0] !== HELD_FOLDER) {
        throw new Refuse(
          `line ${line}: fileinto is supported into "${HELD_FOLDER}" only — the boundary's one held folder`,
        );
      }
      if (action && action !== "reject") throw new Refuse(`line ${line}: one action per rule`);
      action = "reject";
      continue;
    }
    if (t.v === "discard") {
      throw new Refuse(
        `line ${t.line}: the boundary never discards — mail is held in "${HELD_FOLDER}", reviewable; use fileinto`,
      );
    }
    throw new Refuse(`line ${t.line}: the action "${t.v}" is outside the dialect (keep, fileinto, stop)`);
  }
  if (!action) throw new Refuse("a rule block must carry keep or fileinto");
  return action;
}

export function parseSieve(text: string): SieveParseResult {
  try {
    const { toks, ruleComments } = lex(text);
    const rules: ParsedSieveRule[] = [];
    const at = { i: 0 };
    while (at.i < toks.length) {
      const t = toks[at.i]!;
      if (t.t === "atom" && t.v === "require") {
        at.i++;
        const { values, line } = strings(toks, at);
        expectPunc(toks, at, ";");
        for (const ext of values) {
          if (!(SIEVE_EXTENSIONS as readonly string[]).includes(ext)) {
            throw new Refuse(
              `line ${line}: the extension "${ext}" is not supported (only: ${SIEVE_EXTENSIONS.join(", ")})`,
            );
          }
        }
        continue;
      }
      if (t.t === "atom" && (t.v === "if" || t.v === "elsif")) {
        // `elsif` chains ARE first-match-wins, which is the engine's own
        // semantics — each branch becomes a rule in order.
        const ifLine = t.line;
        at.i++;
        const all: SieveMatch[] = [];
        parseTest(toks, at, all);
        const action = parseBlock(toks, at);
        // The nearest preceding `# rule <id>` comment names the rule
        // (comments lex in line order, so the last one at-or-above the `if`
        // wins); a hand-authored block has none. Consumed once found, so one
        // comment can never name two rules.
        let id: string | undefined;
        let idLine = -1;
        for (const [cline, cid] of ruleComments) {
          if (cline > ifLine) break;
          id = cid;
          idLine = cline;
        }
        if (id !== undefined) ruleComments.delete(idLine);
        rules.push({ ...(id !== undefined ? { id } : {}), all, action });
        continue;
      }
      if (t.t === "atom" && t.v === "else") {
        throw new Refuse(`line ${t.line}: else has no honest mapping — the engine's default is already "keep"`);
      }
      // A bare trailing keep;/stop; is the implicit default said out loud.
      if (t.t === "atom" && (t.v === "keep" || t.v === "stop")) {
        at.i++;
        expectPunc(toks, at, ";");
        continue;
      }
      throw new Refuse(`line ${t.line}: unexpected "${t.t === "str" ? `"${t.v}"` : t.v}" at top level`);
    }
    return { ok: true, rules };
  } catch (err) {
    if (err instanceof Refuse) return { ok: false, refusals: [err.message] };
    return { ok: false, refusals: [String(err).slice(0, 200)] };
  }
}
