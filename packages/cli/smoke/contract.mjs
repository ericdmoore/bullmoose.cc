/**
 * The composition smoke script — sVOL `016`'s acceptance signal.
 *
 * `.plans/s05-cli-crud/devPlan.md` calls this "the real acceptance signal …
 * the contract in arch.md §1 is about behaviour under pipes, which unit tests
 * alone can't observe". So this drives the BUILT binary through a real `sh`,
 * with real pipes, a reader that really closes early, and real `xargs`.
 *
 *   npm run -w @bullmoose/cli smoke      # standalone; prints ok/not ok
 *
 * It is also run by `src/contract.test.ts`, so `npm test` fails if the contract
 * breaks. Every case names the clause it holds.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "..", "bin", "bullmoose.mjs");
const ESC = String.fromCharCode(27);

let passed = 0;
const failures = [];

/**
 * Run a real shell pipeline. This is the whole point: `sh -c` gives genuine
 * pipes, a genuine `head` that closes its read end, and a genuine `xargs`.
 * `$BM` is the CLI invocation, so each script below reads as a user would type
 * it.
 */
function sh(script, env) {
  const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function check(clause, name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`ok   ${clause}  ${name}\n`);
  } catch (e) {
    failures.push(`${clause} ${name}: ${e.message}`);
    process.stdout.write(`FAIL ${clause}  ${name}\n     ${e.message.replace(/\n/g, "\n     ")}\n`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (actual, expected, what) =>
  assert(
    actual === expected,
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

async function main() {
  // Build once — the smoke test drives dist/, not src/.
  execFileSync("npm", ["run", "--silent", "build"], { cwd: join(HERE, ".."), stdio: "pipe" });

  const dir = mkdtempSync(join(tmpdir(), "bullmoose-smoke-"));
  const server = spawn(process.execPath, [join(HERE, "server.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  let port, account, token;
  try {
    ({ port, account, token } = await ready(server));

    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      BULLMOOSE_DB: join(dir, "mail.db"),
      // `bm` is the whole CLI invocation, so every pipeline below reads the way
      // a user would type it.
      BM: `${process.execPath} ${CLI}`,
      NO_COLOR: "",
    };
    const bm = (args) => sh(`$BM ${args}`, env);

    // ---- setup -----------------------------------------------------------
    const init = bm(`init --base ${base} --token ${token} --account ${account}`);
    eq(init.code, 0, `init failed: ${init.stderr}`);
    const synced = bm("sync");
    eq(synced.code, 0, `sync failed: ${synced.stderr}`);

    // ---- §1.2  EPIPE is not an error ------------------------------------
    check("§1.2", "`log | head -3` exits 0, prints 3 lines, no stack trace", () => {
      const r = sh("$BM log -n 100 | head -3", env);
      eq(r.code, 0, "exit code");
      eq(r.stdout.trimEnd().split("\n").length, 3, "lines through head");
      assert(!/EPIPE|at Socket|node:internal/.test(r.stderr), `stack trace leaked:\n${r.stderr}`);
    });

    check("§1.2", "`log --json | head -1` truncates cleanly mid-stream", () => {
      const r = sh("$BM log -n 100 --json | head -1", env);
      eq(r.code, 0, "exit code");
      JSON.parse(r.stdout.trim()); // a whole value, not half a line
      assert(!/EPIPE/.test(r.stderr), "EPIPE surfaced");
    });

    check("§1.2", "a reader that closes IMMEDIATELY still exits 0", () => {
      // `head -c1` closes after one byte — the harshest version of `| less`,
      // quit at the first page.
      const r = sh("$BM log -n 100 | head -c1", env);
      eq(r.code, 0, "exit code");
      assert(!/EPIPE|Error:/.test(r.stderr), `noise on stderr:\n${r.stderr}`);
    });

    check("§1.2", "`help --man | head -2` does not trip on the raw write path", () => {
      const r = sh("$BM help --man | head -2", env);
      eq(r.code, 0, "exit code");
      assert(!/EPIPE/.test(r.stderr), "EPIPE surfaced");
    });

    // ---- §1.1  stdout is data, stderr is everything else -----------------
    check("§1.1", "`sync > /dev/null` shows progress but no records", () => {
      const r = sh("$BM sync > /dev/null", env);
      eq(r.code, 0, "exit code");
      assert(r.stderr.includes("clean") || /state/.test(r.stderr), `no progress on stderr:\n${r.stderr}`);
      eq(r.stdout, "", "stdout must be empty when redirected away");
    });

    check("§1.1", "`sync 2>/dev/null` is silent — progress is not a record", () => {
      const r = sh("$BM sync 2>/dev/null", env);
      eq(r.stdout, "", "progress must not reach stdout");
    });

    check("§1.1", "an empty result set writes nothing to stdout", () => {
      // `| wc -l` on an empty log must say 0, not 1 for "(no messages)".
      const r = sh(`$BM search zzzzz-no-such-term 2>/dev/null | wc -l`, env);
      eq(Number(r.stdout.trim()), 0, "lines on stdout");
    });

    check("§1.1", "`mailboxes 2>/dev/null` yields only parseable rows", () => {
      const r = sh("$BM mailboxes 2>/dev/null", env);
      const lines = r.stdout.trimEnd().split("\n");
      assert(lines.length >= 4, `expected the fixture's mailboxes, got ${lines.length}`);
      for (const l of lines) assert(/\(mb_[a-z0-9_]+\)$/.test(l), `not a record row: ${l}`);
    });

    check("§1.1", "`token create` puts the secret alone on stdout", () => {
      const r = sh("$BM token create --name ci --scopes read 2>/dev/null", env);
      eq(r.stdout.trim(), "bm_minted_secret", "captured token");
      const withChrome = bm("token create --name ci --scopes read");
      assert(withChrome.stderr.includes("shown once"), "the warning must still be shown");
    });

    // ---- §1.3  --json is NDJSON ------------------------------------------
    check("§1.3", "`log --json` is one complete JSON value per line", () => {
      const r = bm("log -n 5 --json");
      eq(r.code, 0, "exit code");
      const lines = r.stdout.trimEnd().split("\n");
      eq(lines.length, 5, "one line per record");
      for (const l of lines) {
        const o = JSON.parse(l);
        assert(typeof o.id === "string", "each line is a record object");
        assert(!l.startsWith("["), "no wrapping array");
      }
    });

    check("§1.3", "`log --json | wc -l` counts records", () => {
      const r = sh("$BM log -n 7 --json 2>/dev/null | wc -l", env);
      eq(Number(r.stdout.trim()), 7, "record count");
    });

    check("§1.3", "`show --json` is exactly ONE object, on one line", () => {
      const id = sh("$BM log -n 1 --ids 2>/dev/null", env).stdout.trim();
      const r = bm(`show ${id} --json`);
      eq(r.code, 0, `show failed: ${r.stderr}`);
      eq(r.stdout.trimEnd().split("\n").length, 1, "line count");
      eq(JSON.parse(r.stdout).id, id, "the object is the record asked for");
    });

    check("§1.3", "`mailboxes --json` and `blobs list --json` stream too", () => {
      for (const cmd of ["mailboxes --json", "blobs list --json"]) {
        const r = sh(`$BM ${cmd} 2>/dev/null`, env);
        const lines = r.stdout.trimEnd().split("\n").filter(Boolean);
        assert(lines.length > 1, `${cmd} produced ${lines.length} line(s)`);
        for (const l of lines) JSON.parse(l);
      }
    });

    // ---- §1.8  composition affordances -----------------------------------
    check("§1.8", "`log --ids | xargs -n1 show` really composes", () => {
      const r = sh("$BM log -n 2 --ids 2>/dev/null | xargs -n1 $BM show 2>/dev/null", env);
      eq(r.code, 0, "pipeline exit code");
      const subjects = r.stdout.split("\n").filter((l) => l.startsWith("Subject:"));
      eq(subjects.length, 2, "one message rendered per id");
    });

    check("§1.8", "`--ids` prints bare identifiers and nothing else", () => {
      const r = sh("$BM log -n 4 --ids 2>/dev/null", env);
      const lines = r.stdout.trimEnd().split("\n");
      eq(lines.length, 4, "line count");
      for (const l of lines) assert(/^em_\d{3}$/.test(l), `not a bare id: ${JSON.stringify(l)}`);
    });

    check("§1.8", "`mailboxes --ids | xargs` feeds the mailbox verbs", () => {
      const r = sh("$BM mailboxes --ids 2>/dev/null | head -1", env);
      assert(/^mb_[a-z0-9_]+$/.test(r.stdout.trim()), `not a bare id: ${r.stdout}`);
    });

    // ---- §1.5  exit codes ------------------------------------------------
    check("§1.5", "0 — a command that worked", () => eq(bm("mailboxes").code, 0, "exit code"));

    check("§1.5", "2 — unknown command", () => {
      const r = bm("nosuchcommand");
      eq(r.code, 2, "exit code");
      eq(r.stdout, "", "the overview is chrome when it follows an error");
    });

    check("§1.5", "2 — unknown flag, with a message and no Node stack", () => {
      const r = bm("log --no-such-flag");
      eq(r.code, 2, "exit code");
      assert(!/ERR_PARSE_ARGS|at parseArgs|node:internal/.test(r.stderr), `raw trace:\n${r.stderr}`);
      assert(/no-such-flag/.test(r.stderr), "the offending flag should be named");
    });

    check("§1.5", "2 — a missing required argument", () => {
      eq(bm("show").code, 2, "exit code");
    });

    check("§1.5", "3 — not found", () => {
      eq(bm("show em_does_not_exist").code, 3, "unknown id");
      eq(bm("mailbox rename NoSuchBox Other").code, 3, "unknown mailbox");
    });

    check("§1.5", "4 — auth", () => {
      const bad = { ...env, BULLMOOSE_DB: join(dir, "bad.db") };
      sh(`$BM init --base ${base} --token wrong-token --account ${account} --offline`, bad);
      // A command that actually reaches the server — `mailboxes` reads the
      // local mirror and would never notice a bad token.
      eq(sh("$BM blobs list", bad).code, 4, "exit code for a rejected token");
      eq(sh("$BM mailbox create X", bad).code, 4, "a rejected token on a write path too");
    });

    check("§1.5", "5 — conflict from a SetError (mailboxHasEmail)", () => {
      const r = bm("mailbox rm Full");
      eq(r.code, 5, "exit code");
      assert(/mailboxHasEmail/.test(r.stderr), `message should name the reason:\n${r.stderr}`);
    });

    check("§1.5", "5 — conflict from an HTTP 409 whose reason is not in the table", () => {
      // `blobInUse` is not a JMAP error type; the status must still decide.
      const r = bm("blobs rm b_0");
      eq(r.code, 5, "exit code");
      assert(/blob in use/.test(r.stderr), `the server's reason must survive:\n${r.stderr}`);
    });

    check("§1.5", "1 — a server fault the caller cannot fix", () => {
      eq(bm("blobs rm b_boom").code, 1, "a 500 is nobody's usage error");
    });

    check("§1.5", "2 — asking for a method this server does not implement", () => {
      // unknownMethod is a usage error at the CLI/server-version boundary:
      // the request is wrong for THIS server, and no retry fixes it.
      const r = bm("calendar agenda");
      eq(r.code, 2, "exit code");
      assert(/unknownMethod/.test(r.stderr), `should name the reason:\n${r.stderr}`);
    });

    // ---- §1.7  --if-state and --dry-run ----------------------------------
    check("§1.7", "a write reports its new state, and chaining on it is accepted", () => {
      // The read-modify-write loop the clause exists for: each write hands the
      // next one the state it must still be in.
      const first = JSON.parse(bm("mailbox create Chain --json").stdout.trim());
      assert(first.state, "a write must report the state it landed on");
      const second = bm(`mailbox rename Chain Chained --if-state "${first.state}" --json`);
      eq(second.code, 0, `chaining on a fresh state failed: ${second.stderr}`);
      const after = JSON.parse(second.stdout.trim());
      assert(after.state !== first.state, "the state must advance after a write");
    });

    check("§1.7", "a stale --if-state exits 5 and changes nothing", () => {
      const before = bm("mailboxes --ids 2>/dev/null").stdout;
      const r = bm('mailbox create Unwanted --if-state "mbstate-stale"');
      eq(r.code, 5, "exit code");
      assert(/stateMismatch/.test(r.stderr), `message should name stateMismatch:\n${r.stderr}`);
      const after = bm("mailboxes --ids 2>/dev/null").stdout;
      eq(after, before, "invariant 6: the refused write must change nothing");
      assert(!bm("mailboxes 2>/dev/null").stdout.includes("Unwanted"), "the folder must not exist");
    });

    check("§1.7", "`--dry-run` resolves the target and writes nothing", () => {
      const before = bm("mailboxes --ids 2>/dev/null").stdout;
      const r = bm("mailbox rm Empty --dry-run");
      eq(r.code, 0, "exit code");
      assert(/dry run/.test(r.stderr), `the report belongs on stderr:\n${r.stderr}`);
      eq(bm("mailboxes --ids 2>/dev/null").stdout, before, "invariant 4: zero mutations");
    });

    check("§1.7", "`--dry-run` still fails on an unresolvable target", () => {
      // A dry run that did not resolve would be evidence of nothing.
      eq(bm("mailbox rm NoSuchFolder --dry-run").code, 3, "exit code");
    });

    // ---- §1.4  stdin, `-`, and --as --------------------------------------
    check("§1.4", "a bare invocation reads piped stdin", () => {
      writeFileSync(join(dir, "one.vcf"), "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:A\r\nUID:u1\r\nEND:VCARD\r\n");
      const r = sh(`cat ${join(dir, "one.vcf")} | $BM contacts import --dry-run`, env);
      // The stub has no contacts capability, so this exits non-zero — but it
      // must be the SERVER's refusal, not "no input".
      assert(!/no vCard/.test(r.stderr), `stdin was not read:\n${r.stderr}`);
    });

    check("§1.4", "`-` is explicit stdin", () => {
      const r = sh(`cat ${join(dir, "one.vcf")} | $BM contacts import - --dry-run`, env);
      assert(!/no vCard/.test(r.stderr), `\`-\` was not honoured:\n${r.stderr}`);
    });

    check("§1.4", "wrong content type is a usage error naming --as", () => {
      const r = sh(`echo 'not a vcard' | $BM contacts import -`, env);
      eq(r.code, 2, "exit code");
      assert(/--as/.test(r.stderr), `should point at --as:\n${r.stderr}`);
    });

    check("§1.4", "an explicit flag beats implicit stdin", () => {
      const r = sh(`echo piped | $BM send --to a@b.com --subject s --body explicit --json`, env);
      // The stub cannot submit, but the body must have come from --body: a
      // failure mentioning the piped text would mean stdin won.
      assert(!/piped/.test(r.stderr), `stdin overrode --body:\n${r.stderr}`);
    });

    // ---- §1.6  no TTY assumptions ----------------------------------------
    check("§1.6", "no ANSI escapes when stdout is a pipe", () => {
      const r = sh("$BM log -n 3", env);
      assert(!r.stdout.includes(ESC), "escape sequence on stdout");
    });

    check("§1.6", "NO_COLOR is honoured on stderr too", () => {
      const r = sh("$BM mailbox rm Empty --dry-run", { ...env, NO_COLOR: "1" });
      assert(!r.stderr.includes(ESC), "escape sequence on stderr under NO_COLOR");
    });

    check("§1.6", "columns stay stable, so `awk` works", () => {
      const r = sh("$BM log -n 3 2>/dev/null | awk '{print $NF}'", env);
      const ids = r.stdout.trimEnd().split("\n");
      eq(ids.length, 3, "row count");
      for (const id of ids) assert(/^em_\d{3}$/.test(id), `last column is not the id: ${id}`);
    });

    // ---- the headline example from devPlan.md ----------------------------
    check("§1", "the devPlan's own pipeline runs end to end", () => {
      const r = sh(
        "$BM log --json 2>/dev/null | head -2 | sed 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/' | xargs -n1 $BM show 2>/dev/null",
        env,
      );
      eq(r.code, 0, "pipeline exit code");
      assert(r.stdout.includes("Subject:"), "messages should be rendered");
    });

    // ---- contacts CRUD projection (sVOL 017) -----------------------------
    check("017", "`contacts export --json` is one complete card per line", () => {
      const r = bm("contacts export --json");
      eq(r.code, 0, `export failed: ${r.stderr}`);
      const lines = r.stdout.trimEnd().split("\n");
      eq(lines.length, 3, "one line per card");
      for (const l of lines) {
        const c = JSON.parse(l);
        assert(typeof c.uid === "string", "each line is a card object");
        assert(!l.startsWith("["), "no wrapping array");
      }
    });

    check("017", "`contacts export --json | jq | wc -l` streams and counts", () => {
      const r = sh("$BM contacts export --json 2>/dev/null | wc -l", env);
      eq(Number(r.stdout.trim()), 3, "record count through the pipe");
    });

    check("017", "default `contacts export` is vCard on stdout — the inverse of import", () => {
      const r = sh("$BM contacts export 2>/dev/null", env);
      eq(r.code, 0, "exit code");
      eq((r.stdout.match(/BEGIN:VCARD/g) ?? []).length, 3, "one vCard block per card");
      assert(/VERSION:3\.0/.test(r.stdout), "vCard 3.0");
      assert(/FN:Ada Lovelace/.test(r.stdout), "the JSContact name round-trips to FN");
    });

    check("017", "`contacts export --ids | xargs show` really composes", () => {
      const r = sh(
        "$BM contacts export --ids 2>/dev/null | xargs -n1 $BM contacts show 2>/dev/null",
        env,
      );
      eq(r.code, 0, "pipeline exit code");
      eq((r.stdout.match(/"uid"/g) ?? []).length, 3, "one card rendered per id");
    });

    check("017", "`--book` filters the export, and `books list --ids` yields ids", () => {
      const only = sh("$BM contacts export --book Work --ids 2>/dev/null", env);
      eq(only.stdout.trim(), "cc_alan", "only the Work book's card");
      const books = sh("$BM contacts books list --ids 2>/dev/null", env);
      assert(books.stdout.includes("ab_personal"), `books list --ids should print book ids:\n${books.stdout}`);
    // ═══ sVOL 019 — email triage verbs over the CLI ═══════════════════════
    //
    // These MUTATE the fixture, so they run last, and each reserves distinct
    // ids so the sub-tests do not collide. The mirror helpers read `log --json`
    // (the local SQLite mirror) — the same source `search`/`log` read — so an
    // assertion that the mirror moved is an assertion that reconciliation ran.
    const jlog = () =>
      sh("$BM log -n 100 --json 2>/dev/null", env)
        .stdout.trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const mailboxesOf = (id) => jlog().find((r) => r.id === id)?.mailboxes ?? null;
    const seenOf = (id) => jlog().find((r) => r.id === id)?.seen ?? null;
    // The live JMAP email state, read back after a sync — the axis `--dry-run`
    // and `--if-state` turn on. A real write advances it; a dry-run must not.
    const state = () => {
      bm("sync");
      return JSON.parse(bm("accounts --json").stdout.trim().split("\n")[0]).state;
    };

    check("§019", "seen marks a message read and the mirror reflects it", () => {
      eq(seenOf("em_001"), 0, "em_001 (odd) starts unread");
      const r = bm("seen em_001");
      eq(r.code, 0, `seen failed: ${r.stderr}`);
      eq(r.stdout.trim(), "em_001", "stdout is the id it acted on, so verbs chain");
      eq(seenOf("em_001"), 1, "reconciled: the mirror now shows it read");
    });

    check("§019", "flag writes a keyword, and --if-state chains on the reported state", () => {
      const rec = JSON.parse(bm("seen em_000 --json").stdout.trim().split("\n")[0]);
      assert(rec.state, "a write must report the state it landed on");
      // Chain the next write on that exact state — the read-modify-write loop.
      const r = bm(`flag em_000 --add '$flagged' --if-state ${rec.state}`);
      eq(r.code, 0, `chaining on a fresh state failed: ${r.stderr}`);
    });

    check("§019", "`search --ids | xargs archive` fans ids and archives them", () => {
      // The headline pipeline: search feeds ids into a triage verb via xargs.
      const r = sh("$BM search invoice --ids 2>/dev/null | xargs $BM archive 2>/dev/null", env);
      eq(r.code, 0, "pipeline exit code");
      // done-when #3: the mirror reflects the move with no explicit sync.
      assert(mailboxesOf("em_003") === "archive", "the searched message is now in Archive");
    });

    check("§019", "choreography: a SECOND client sees the archive after its own sync", () => {
      // done-when #2 — the check that catches a local-only write. A fresh db
      // syncs from the server; if `archive` had only touched the first mirror,
      // the server would never have changed and this client would see inbox.
      const env2 = { ...env, BULLMOOSE_DB: join(dir, "mail2.db") };
      eq(sh(`$BM init --base ${base} --token ${token} --account ${account}`, env2).code, 0, "init2");
      eq(sh("$BM sync", env2).code, 0, "sync2");
      const rows = sh("$BM log -n 100 --json 2>/dev/null", env2)
        .stdout.trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const e3 = rows.find((r) => r.id === "em_003");
      assert(e3 && e3.mailboxes === "archive", "the move reached the server, not just a mirror");
    });

    check("§019", "--dry-run performs ZERO mutations; a real write advances the state", () => {
      const before = state();
      const dry = bm("trash em_005 --dry-run");
      eq(dry.code, 0, "dry-run exit 0");
      assert(/dry run/.test(dry.stderr), "the rehearsal belongs on stderr");
      eq(state(), before, "invariant 4: a dry-run must not advance the JMAP state");
      assert(mailboxesOf("em_005") === "inbox", "dry-run moved nothing");
      const real = bm("trash em_005");
      eq(real.code, 0, `real trash failed: ${real.stderr}`);
      assert(state() !== before, "a real write DOES advance the state");
      assert(mailboxesOf("em_005") === "trash", "em_005 is now in Trash");
    });

    check("§019", "a destructive sweep rehearses via `xargs … --dry-run`, then runs", () => {
      const dry = sh("printf 'em_006\\nem_007\\n' | xargs $BM trash --dry-run 2>&1", env);
      assert(/dry run/.test(dry.stdout), `the rehearsal reported:\n${dry.stdout}`);
      assert(mailboxesOf("em_006") === "inbox", "the rehearsal moved nothing");
      const run = sh("printf 'em_006\\nem_007\\n' | xargs $BM trash 2>/dev/null", env);
      eq(run.code, 0, "sweep exit code");
      assert(
        mailboxesOf("em_006") === "trash" && mailboxesOf("em_007") === "trash",
        "both messages swept to Trash",
      );
    });

    check("§019", "`delete` is an alias for `rm`, and --dry-run destroys nothing", () => {
      const r = sh("printf 'em_006\\n' | xargs $BM delete --dry-run 2>&1", env);
      assert(/dry run/.test(r.stdout), `reported the rehearsal:\n${r.stdout}`);
      assert(mailboxesOf("em_006") !== null, "a dry-run delete destroyed nothing");
    });

    check("§019", "rm REFUSES a hard delete without --force", () => {
      const r = bm("rm em_009");
      eq(r.code, 2, "must refuse — hard delete is not the default");
      assert(/--force/.test(r.stderr) && /trash/i.test(r.stderr), "point at the safe path");
      assert(mailboxesOf("em_009") !== null, "nothing was destroyed");
    });

    check("§019", "rm --force destroys permanently and reconciles the mirror", () => {
      const r = bm("rm em_009 --force");
      eq(r.code, 0, `rm --force failed: ${r.stderr}`);
      eq(r.stdout.trim(), "em_009", "stdout is the destroyed id");
      assert(mailboxesOf("em_009") === null, "gone from the local mirror too");
    });

    check("§019", "`help rm` says it is permanent, not Trash, not recoverable", () => {
      const h = bm("help rm").stdout;
      assert(/permanent|hard delete/i.test(h), "must say it is permanent");
      assert(/recoverable/i.test(h), "must say nothing is recoverable");
      assert(/trash/i.test(h), "must contrast with Trash");
    });

    check("§019", "partial failure is honest — successes kept, failure reported, non-zero", () => {
      const r = bm("archive em_002 em_004 em_nope");
      eq(r.code, 3, "notFound-mapped, and non-zero because one id failed");
      const ids = r.stdout.trimEnd().split("\n").filter(Boolean);
      assert(ids.includes("em_002") && ids.includes("em_004"), "the two that worked are on stdout");
      assert(!ids.includes("em_nope"), "the failure is NOT on stdout");
      assert(/em_nope/.test(r.stderr), "the failure is reported on stderr");
      assert(
        mailboxesOf("em_002") === "archive" && mailboxesOf("em_004") === "archive",
        "the successes were really applied — not swallowed by the failure",
      );
    });

    check("§019", "`label --remove` on the only mailbox refuses client-side, naming `move`", () => {
      // done-when #8 — em_010 is in inbox only, so removing inbox would leave it
      // in no mailbox. The CLI must catch that BEFORE the server does.
      const r = bm("label em_010 --remove inbox");
      eq(r.code, 2, "a usage-class refusal, not a server invalidProperties");
      assert(/move/.test(r.stderr), "the message must name `move`");
      assert(mailboxesOf("em_010") === "inbox", "the message is unchanged");
    });

    check("§019", "a stale --if-state exits 5 and changes nothing", () => {
      const r = bm("archive em_011 --if-state emstate-bogus");
      eq(r.code, 5, "conflict");
      assert(/stateMismatch/.test(r.stderr), "message should name stateMismatch");
      assert(mailboxesOf("em_011") === "inbox", "invariant 6: the refused write changed nothing");
    });

    check("§019", "`search --ids | head` exits 0 with no stack trace (EPIPE)", () => {
      const r = sh("$BM search message --ids 2>/dev/null | head -1", env);
      eq(r.code, 0, "exit code");
      assert(/^em_\d{3}$/.test(r.stdout.trim()), "a bare id came through");
      assert(!/EPIPE|node:internal/.test(r.stderr), `stack trace leaked:\n${r.stderr}`);
    });

    check("§019", "a triage verb's stdout is exactly the ids it acted on", () => {
      const r = sh("$BM archive em_008 2>/dev/null", env);
      eq(r.stdout.trim(), "em_008", "stdout carries only the acted-on id");
    });
  } finally {
    server.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exit(1);
}

function ready(server) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("stub server did not start")), 15_000);
    server.stdout.on("data", (c) => {
      buf += c;
      const m = buf.match(/READY (\d+) (\S+) (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), account: m[2], token: m[3] });
      }
    });
    server.on("error", reject);
  });
}

await main();
