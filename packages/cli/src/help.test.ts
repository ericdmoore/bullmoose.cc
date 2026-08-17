import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESIGNED, IMPLEMENTED, unknownAdminCommand } from "./admin.js";
import { COMMANDS, EXIT_CODES, GLOBAL_OPTIONS, helpJson, renderMan, renderMarkdown, renderOverview } from "./help.js";

/**
 * `help.ts` is the single source of truth for `docs/cli.md` and
 * `man/bullmoose.1`, so the generated docs are always consistent WITH THE SPEC
 * — and silently wrong wherever the spec is. `.feedback/fromClaude/cli/010`
 * found three drifts of exactly that shape. These are the structural checks its
 * fix note asks for: they compare the spec against the runtime rather than
 * against itself.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));
const read = (f: string) => readFileSync(`${SRC}${f}`, "utf8");

/** The `case "x":` labels of main.ts's top-level dispatch. */
function switchCases(source: string): string[] {
  const body = source.slice(source.indexOf("switch (command)"));
  return [...body.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1]!);
}

describe("the command registry matches the runtime", () => {
  it("every dispatched command has a spec entry, and vice versa", () => {
    const dispatched = new Set(switchCases(read("main.ts")));
    // `help` is handled before the switch (it must work with no database), so
    // it is added here rather than being absent from one side.
    dispatched.add("help");
    expect([...dispatched].sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });

  it("`help` is in the spec — an agent reading `help --json` must see it", () => {
    const spec = JSON.parse(helpJson()) as { commands: Array<{ name: string }> };
    expect(spec.commands.map((c) => c.name)).toContain("help");
  });

  it("carries the exit-code table, so a script knows what the numbers mean", () => {
    const spec = JSON.parse(helpJson()) as { exitCodes: Array<{ code: number }> };
    expect(spec.exitCodes.map((e) => e.code)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("documents every flag the contract adds", () => {
    const flags = GLOBAL_OPTIONS.map((f) => f.flag).join(" ");
    for (const f of ["--json", "--ids", "--dry-run", "--if-state", "--as", "--man"]) {
      expect(flags).toContain(f);
    }
  });

  it("teaches composition by example, not only by description", () => {
    const examples = COMMANDS.flatMap((c) => c.examples ?? []).map((e) => e.cmd);
    expect(examples.some((e) => e.includes("| head"))).toBe(true);
    expect(examples.some((e) => e.includes("| xargs"))).toBe(true);
    expect(examples.some((e) => e.includes("| jq"))).toBe(true);
    expect(examples.some((e) => e.includes("--if-state"))).toBe(true);
  });
});

describe("admin's usage text is derived, not hand-written", () => {
  it("lists every implemented subcommand and no unbuilt one", () => {
    const cases = [...read("admin.ts").matchAll(/^\s{4}case "([a-z]+ [a-z]+)":/gm)].map((m) => m[1]!);
    // `init` and `password` are handled outside the switch (init before the
    // admin API is configured; password as a noun with no verb).
    expect([...cases, "init", "password"].sort()).toEqual([...IMPLEMENTED].sort());
  });

  it("never calls something both built and designed", () => {
    const built = new Set(IMPLEMENTED.map((c) => c.split(" ")[0]));
    for (const noun of DESIGNED) expect(built.has(noun)).toBe(false);
  });

  it("names grants as implemented — the drift that started cli/010", () => {
    const text = unknownAdminCommand("grnat", "create");
    expect(text).toContain("grant create");
    expect(text.split("designed (not yet built):")[1]).not.toContain("agent");
  });
});

describe("the generated renderers", () => {
  it("escapes `|` inside Markdown table cells", () => {
    // `--expandMD html|no` used to render as four cells in a two-column table.
    const md = renderMarkdown();
    const rows = md.split("\n").filter((l) => l.startsWith("| `--") || l.startsWith("| ["));
    for (const row of rows) {
      const cells = row.split(/(?<!\\)\|/).filter((c) => c.trim() !== "");
      expect(cells.length, `row has ${cells.length} cells: ${row}`).toBeLessThanOrEqual(3);
    }
    expect(md).toContain("html\\|no");
  });

  it("renders man and overview without throwing, and mentions the contract", () => {
    expect(renderMan()).toContain(".SH EXIT STATUS");
    const overview = renderOverview();
    expect(overview).toContain("Exit codes:");
    for (const e of EXIT_CODES) expect(overview).toContain(e.meaning);
  });

  it("keeps docs/cli.md and man/bullmoose.1 in sync with the spec", () => {
    // The generator is byte-stable, so any difference is a real one: someone
    // hand-edited a generated file, or changed help.ts without regenerating.
    // Fix with: npm run -w @bullmoose/cli gen:docs
    // (`help --markdown` goes through out(), which terminates the line;
    // `--man` goes through outRaw(), and renderMan already ends in a newline.)
    expect(readFileSync(`${SRC}../../../docs/cli.md`, "utf8")).toBe(`${renderMarkdown()}\n`);
    expect(readFileSync(`${SRC}../man/bullmoose.1`, "utf8")).toBe(renderMan());
  });
});
